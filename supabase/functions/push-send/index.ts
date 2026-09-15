// Sends a Web Push notification to a single subscription, given directly
// in the request body. Called server-side — never exposes the VAPID
// private key to the browser.
//
// Ported from src/netlify/functions/push-send.js — mechanical translation
// of the Netlify handler shape to Deno.serve; logic unchanged.

import { sendWebPush } from '../_shared/webpush.ts';

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  // Same-origin browser requests never trigger a CORS preflight, so this
  // was invisible until the native app started calling this cross-origin
  // (its own bundle, not fitl00p.netlify.app) — without these two, the
  // browser rejects the OPTIONS preflight for any POST carrying a
  // Content-Type header, and the real request never sends.
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: CORS_HEADERS });
  }

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return new Response(
      JSON.stringify({ error: 'VAPID keys not configured in the environment.' }),
      { status: 500, headers: CORS_HEADERS }
    );
  }

  let body: any;
  try { body = JSON.parse(await req.text()); }
  catch { return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: CORS_HEADERS }); }

  const { subscription, notification } = body;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return new Response(JSON.stringify({ error: 'Missing subscription fields' }), { status: 400, headers: CORS_HEADERS });
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
    return new Response(
      JSON.stringify({ sent: ok, pushStatus: result.status, pushBody: ok ? undefined : result.body }),
      { status: ok ? 200 : 502, headers: CORS_HEADERS }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 502, headers: CORS_HEADERS });
  }
});
