// Shared Web Push sender — VAPID JWT signing, RFC 8291 payload
// encryption, and the POST to the push service.

const https = require('https');
const crypto = require('crypto');
const url = require('url');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fitl00p.app';

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function base64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generateVapidHeaders(audience, subject, publicKey, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600; // 12 hours

  const header  = base64urlEncode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = base64urlEncode(JSON.stringify({ aud: audience, exp, sub: subject }));
  const sigInput = `${header}.${payload}`;

  const privKeyDer = base64urlDecode(privateKey);
  const pkcs8Header = Buffer.from('308141020100301306072a8648ce3d020106082a8648ce3d030107042730250201010420', 'hex');
  const pkcs8 = Buffer.concat([pkcs8Header, privKeyDer]);

  const cryptoKey = await crypto.webcrypto.subtle.importKey(
    'pkcs8', pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sigBuf = await crypto.webcrypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    Buffer.from(sigInput)
  );

  const jwt = `${sigInput}.${base64urlEncode(sigBuf)}`;
  return {
    Authorization: `vapid t=${jwt},k=${publicKey}`,
  };
}

function hmac(key, input) {
  return crypto.createHmac('sha256', key).update(input).digest();
}

// Single-step HKDF as used by RFC 8291 (extract with the given salt, then
// expand to `length` bytes using `info` with a single-record counter).
function hkdf(salt, ikm, info, length) {
  const prk = hmac(salt, ikm);
  const okm = hmac(prk, Buffer.concat([info, Buffer.from([1])]));
  return okm.subarray(0, length);
}

// Encrypts the payload per RFC 8291 (Message Encryption for Web Push)
// using the aes128gcm content-coding (RFC 8188) — required by every push
// service (Apple, Chrome/FCM, Firefox) for any push carrying a body.
// Sending the payload as plaintext, as this used to, gets silently
// rejected by the push service with a 400 — no error surfaces anywhere
// in this app's own logs since that rejection happens entirely on the
// push service's side, past the point sendWebPush() considers "sent".
function encryptPayload(payloadBuffer, p256dhB64, authB64) {
  const userPublicKey = base64urlDecode(p256dhB64); // 65-byte uncompressed EC point
  const userAuth = base64urlDecode(authB64);         // 16-byte auth secret

  const localEcdh = crypto.createECDH('prime256v1');
  localEcdh.generateKeys();
  const localPublicKey = localEcdh.getPublicKey(); // 65-byte uncompressed point
  const sharedSecret = localEcdh.computeSecret(userPublicKey);

  const salt = crypto.randomBytes(16);

  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    userPublicKey,
    localPublicKey,
  ]);
  const ikm = hkdf(userAuth, sharedSecret, keyInfo, 32);

  const cek   = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  // Single-record message: payload + 0x02 delimiter byte, no further padding.
  const paddedPayload = Buffer.concat([payloadBuffer, Buffer.from([2])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(paddedPayload), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | record size(4, BE uint32) | keyid length(1) | keyid(65)
  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(ciphertext.length, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([localPublicKey.length]), localPublicKey]);

  return Buffer.concat([header, ciphertext]);
}

// subscription: { endpoint, keys: { p256dh, auth } }
function sendWebPush(subscription, payload) {
  return new Promise(async (resolve, reject) => {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      reject(new Error('VAPID keys not configured'));
      return;
    }
    const endpoint = new url.URL(subscription.endpoint);
    const audience = `${endpoint.protocol}//${endpoint.host}`;
    const body = encryptPayload(
      Buffer.from(JSON.stringify(payload)),
      subscription.keys.p256dh,
      subscription.keys.auth
    );

    const headers = await generateVapidHeaders(audience, VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    headers['Content-Type'] = 'application/octet-stream';
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Length'] = body.length;
    headers['TTL'] = '86400';

    const options = {
      hostname: endpoint.hostname,
      path:     endpoint.pathname + endpoint.search,
      method:   'POST',
      headers,
    };

    const req = https.request(options, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Current wall-clock time in Europe/London, DST-aware — used by scheduled
// functions to self-gate against a UTC cron that fires at both possible
// London-local hours (the winter and summer UTC equivalents), since
// Netlify cron has no timezone support and DST would otherwise silently
// shift the notification by an hour twice a year.
function londonParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hour:    parseInt(get('hour'), 10),
    minute:  parseInt(get('minute'), 10),
    weekday: get('weekday'), // 'Mon', 'Tue', ...
  };
}

function londonNow() {
  return londonParts(new Date());
}

// London calendar date (YYYY-MM-DD) of an arbitrary instant — used to
// check "was this logged today" against a UTC timestamp column without
// hand-rolling DST-aware day boundaries.
function londonDateStrOf(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  return londonParts(d).dateStr;
}

// Hardcoded rather than a per-user preferences table — there are two
// users on this app, and the notification set differs enough between
// them (Gemma doesn't use Tirzepatide/diabetes tracking, wants a daily
// rather than weekly weigh-in nudge, and a different steps-check tone)
// that a couple of `if (userId === GEMMA_USER_ID)` branches is simpler
// than building settings UI + a schema for two people.
const GEMMA_USER_ID = '2c8bf000-b870-4ea1-8a67-ec00ee7d4041';

// Same conversion factor as weightToKg/weightFromKg in app.js — kept in
// sync so a kg value converted here and one converted client-side never
// drift apart by a rounding-constant mismatch.
const LB_TO_KG = 0.45359237;
function kgToLb(kg) { return kg / LB_TO_KG; }

module.exports = { sendWebPush, londonNow, londonDateStrOf, GEMMA_USER_ID, kgToLb };
