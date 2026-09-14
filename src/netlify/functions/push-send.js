// netlify/functions/push-send.js
// Sends a Web Push notification to a single subscription, given directly
// in the request body. Called server-side — never exposes the VAPID
// private key to the browser.

const { sendWebPush } = require('./_lib/webpush');

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;

// ── Handler ───────────────────────────────────────────────────
exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    // Same-origin browser requests never trigger a CORS preflight, so
    // this was invisible until the native app started calling this
    // cross-origin (its own bundle, not fitl00p.netlify.app) — without
    // these two, the browser rejects the OPTIONS preflight for any POST
    // carrying a Content-Type header, and the real request never sends.
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    const ok = result.status >= 200 && result.status < 300;
    return {
      statusCode: ok ? 200 : 502,
      headers,
      body: JSON.stringify({ sent: ok, pushStatus: result.status, pushBody: ok ? undefined : result.body }),
    };
  } catch (err) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: err.message }) };
  }
};
