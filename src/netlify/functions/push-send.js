// netlify/functions/push-send.js
// Sends a Web Push notification to a user's subscriptions.
// Called server-side — never exposes VAPID private key to the browser.

const https = require('https');
const crypto = require('crypto');
const url = require('url');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@fitl00p.app';

// ── Minimal Web Push implementation (no npm deps) ────────────
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

  // Import private key
  const privKeyDer = base64urlDecode(privateKey);
  // Rebuild as PKCS8 DER (prepend EC PKCS8 header for P-256)
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

function sendWebPush(subscription, payload) {
  return new Promise(async (resolve, reject) => {
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

// ── Handler ───────────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'POST only' }) };

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'VAPID keys not configured in Netlify environment variables.' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const { subscription, notification } = body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing subscription fields' }) };
  }

  const payload = {
    title: notification?.title || 'fitl00p',
    body:  notification?.body  || 'New notification from fitl00p',
    url:   notification?.url   || '/',
    tag:   notification?.tag   || 'fitl00p',
  };

  try {
    const result = await sendWebPush(subscription, payload);
    return { statusCode: 200, headers, body: JSON.stringify({ sent: true, pushStatus: result.status }) };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
