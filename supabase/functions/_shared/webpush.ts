// Shared Web Push sender — VAPID JWT signing, RFC 8291 payload
// encryption, and the POST to the push service.
//
// Ported from the Netlify version (src/netlify/functions/_lib/webpush.js),
// which used Node's crypto.createECDH/createHmac/createCipheriv — none of
// which exist in Deno. Rewritten here on the standard Web Crypto API
// (crypto.subtle) instead of Deno's node:crypto compat shim, since Web
// Crypto is a full native implementation (not a compatibility layer) and
// this is exactly the kind of code where a subtle gap would fail with no
// visible error anywhere (see encryptPayload below) rather than a thrown
// exception. Verified byte-for-byte identical output against the original
// Node implementation for a fixed salt/key — see the parity test run
// during migration, not shipped in this file.

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@fitl00p.app';

// Explicit Uint8Array<ArrayBuffer> return types throughout this file (as
// opposed to plain Uint8Array, which TS 5.7+'s DOM lib treats as
// Uint8Array<ArrayBufferLike> and no longer accepts as BufferSource for
// SubtleCrypto calls) — a type-checker-only concern, not a runtime one;
// the actual crypto output was verified byte-for-byte against the
// original Node implementation during migration.
function base64urlToBytes(str: string): Uint8Array<ArrayBuffer> {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concatBytes(...parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const arrays = parts.map(p => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

async function generateVapidHeaders(
  audience: string, subject: string, publicKey: string, privateKey: string
): Promise<{ Authorization: string }> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 12 * 3600; // 12 hours

  const enc = new TextEncoder();
  const header  = bytesToBase64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToBase64url(enc.encode(JSON.stringify({ aud: audience, exp, sub: subject })));
  const sigInput = `${header}.${payload}`;

  const privKeyDer = base64urlToBytes(privateKey);
  // Fixed PKCS8 header prefix that turns a raw 32-byte P-256 private key
  // into a PKCS8 DER blob Web Crypto can import — same fixed byte prefix
  // the original Node version hardcoded as a hex string, reproduced here
  // byte-for-byte as a Uint8Array literal.
  const pkcs8HeaderBytes = new Uint8Array([
    0x30, 0x81, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86,
    0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
    0x03, 0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01, 0x01, 0x04, 0x20,
  ]);
  const pkcs8 = concatBytes(pkcs8HeaderBytes, privKeyDer);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  );

  const sigBuf = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    enc.encode(sigInput)
  );

  const jwt = `${sigInput}.${bytesToBase64url(new Uint8Array(sigBuf))}`;
  return {
    Authorization: `vapid t=${jwt},k=${publicKey}`,
  };
}

async function hmac(key: Uint8Array<ArrayBuffer>, input: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, input);
  return new Uint8Array(sig);
}

// Single-step HKDF as used by RFC 8291 (extract with the given salt, then
// expand to `length` bytes using `info` with a single-record counter).
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concatBytes(info, [1]));
  return okm.subarray(0, length);
}

// Encrypts the payload per RFC 8291 (Message Encryption for Web Push)
// using the aes128gcm content-coding (RFC 8188) — required by every push
// service (Apple, Chrome/FCM, Firefox) for any push carrying a body.
// Sending the payload as plaintext, as this used to, gets silently
// rejected by the push service with a 400 — no error surfaces anywhere
// in this app's own logs since that rejection happens entirely on the
// push service's side, past the point sendWebPush() considers "sent".
async function encryptPayload(payloadBytes: Uint8Array<ArrayBuffer>, p256dhB64: string, authB64: string): Promise<Uint8Array<ArrayBuffer>> {
  const userPublicKey = base64urlToBytes(p256dhB64); // 65-byte uncompressed EC point
  const userAuth = base64urlToBytes(authB64);         // 16-byte auth secret

  const localKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']
  ) as CryptoKeyPair;
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', localKeyPair.publicKey));

  const userPublicCryptoKey = await crypto.subtle.importKey(
    'raw', userPublicKey, { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: userPublicCryptoKey } as EcdhKeyDeriveParams,
    localKeyPair.privateKey, 256
  ));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  const enc = new TextEncoder();
  const keyInfo = concatBytes(enc.encode('WebPush: info\0'), userPublicKey, localPublicKey);
  const ikm = await hkdf(userAuth, sharedSecret, keyInfo, 32);

  const cek   = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  // Single-record message: payload + 0x02 delimiter byte, no further padding.
  const paddedPayload = concatBytes(payloadBytes, [2]);
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  // Web Crypto's AES-GCM output already has the 16-byte auth tag appended,
  // same layout Node's cipher.update()+final()+getAuthTag() concatenation
  // produced — no separate tag handling needed here.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, cekKey, paddedPayload
  ));

  // aes128gcm header: salt(16) | record size(4, BE uint32) | keyid length(1) | keyid(65)
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, ciphertext.length, false);
  const header = concatBytes(salt, recordSize, [localPublicKey.length], localPublicKey);

  return concatBytes(header, ciphertext);
}

// subscription: { endpoint, keys: { p256dh, auth } }
async function sendWebPush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: unknown
): Promise<{ status: number; body: string }> {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    throw new Error('VAPID keys not configured');
  }
  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const body = await encryptPayload(
    new TextEncoder().encode(JSON.stringify(payload)),
    subscription.keys.p256dh,
    subscription.keys.auth
  );

  const vapidHeaders = await generateVapidHeaders(audience, VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      ...vapidHeaders,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'TTL': '86400',
    },
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// Current wall-clock time in Europe/London, DST-aware — used by scheduled
// functions to self-gate against a UTC cron that fires at both possible
// London-local hours (the winter and summer UTC equivalents), since a
// plain UTC cron has no timezone support and DST would otherwise silently
// shift the notification by an hour twice a year.
function londonParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => parts.find(p => p.type === t)!.value;
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
function londonDateStrOf(isoOrDate: string | Date) {
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
function kgToLb(kg: number) { return kg / LB_TO_KG; }

export { sendWebPush, londonNow, londonDateStrOf, GEMMA_USER_ID, kgToLb };
