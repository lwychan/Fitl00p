import type { CapacitorConfig } from '@capacitor/cli';

// webDir points straight at the existing static PWA in src/ — nothing
// there is moved or rewritten. `cap sync` copies these files as-is into
// the native iOS project's bundled web assets, and the app runs entirely
// from that local bundle (no server.url) — it launches and renders
// independently of fitl00p.netlify.app's static hosting, so a bad
// deploy or a Netlify outage can't stop the app from opening.
//
// Backend calls go to Supabase (data + Edge Functions via app.js's
// absolute FUNCTIONS_ORIGIN) and still need network access; only the
// app's own HTML/CSS/JS shell is independent of the website.
const config: CapacitorConfig = {
  appId: 'com.lwychan.fitl00p',
  appName: 'FitLoop',
  webDir: 'src',
};

export default config;
