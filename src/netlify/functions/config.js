// netlify/functions/config.js
// Serves the Supabase public config (URL + anon key) to the client app.
// The anon key is intentionally client-visible — it is not a secret.
// Keeping values here rather than hardcoded in app.js avoids Netlify secret scanner flags.

exports.handler = async function () {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;

  if (!url || !key) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'SUPABASE_URL and SUPABASE_ANON_KEY env vars are not set' }),
    };
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({ url, key }),
  };
};
