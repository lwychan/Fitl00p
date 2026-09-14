import type { CapacitorConfig } from '@capacitor/cli';

// webDir points straight at the existing static PWA in src/ — nothing
// there is moved or rewritten. `cap sync` copies these files as-is into
// the native iOS project's bundled web assets, and the app runs entirely
// from that local bundle (no server.url) — it launches and renders
// independently of fitl00p.netlify.app's static hosting, so a bad
// deploy or a Netlify outage can't stop the app from opening.
//
// app.js's calls to `/.netlify/functions/*` endpoints (config,
// health-sync, food-photo-estimate, notify-*, etc.) use an absolute
// NETLIFY_ORIGIN prefix (see app.js) instead of a relative path for
// exactly this reason — a bundled local build has no server behind a
// relative path. Those specific calls (and Supabase itself) still need
// real network access, same as the web version always has; only the
// app's own HTML/CSS/JS shell is independent of the website now.
const config: CapacitorConfig = {
  appId: 'com.lwychan.fitl00p',
  appName: 'FitLoop',
  webDir: 'src',
};

export default config;
