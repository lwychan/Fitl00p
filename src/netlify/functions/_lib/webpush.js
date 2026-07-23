// Shared Web Push sender — VAPID JWT signing + POST to the push service.
// Extracted from push-send.js so scheduled notification functions don't
// each carry their own copy of the crypto.

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
    'Content-Type': 'application/octet-stream',
  };
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
    const body = Buffer.from(JSON.stringify(payload));

    const headers = await generateVapidHeaders(audience, VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
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
function londonNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return {
    dateStr: `${get('year')}-${get('month')}-${get('day')}`,
    hour:    parseInt(get('hour'), 10),
    minute:  parseInt(get('minute'), 10),
    weekday: get('weekday'), // 'Mon', 'Tue', ...
  };
}

module.exports = { sendWebPush, londonNow };
