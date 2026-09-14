import type { CapacitorConfig } from '@capacitor/cli';

// webDir points straight at the existing static PWA in src/ — nothing
// there is moved or rewritten. `cap sync` copies these files as-is into
// the native iOS project's bundled web assets (used as an offline
// fallback and for `cap sync` tooling; the app doesn't load them at
// runtime — see server.url below).
//
// server.url makes the app load its pages from the live Netlify site
// instead of the locally bundled files. app.js calls many
// `/.netlify/functions/*` endpoints (config, health-sync, food-photo-estimate,
// notify-*, etc.) with relative paths that only resolve against a real
// origin serving those functions — a bundled local build has no server
// behind it, so those calls (and Supabase config loading) would 404.
// Capacitor plugins (Camera, Filesystem, Push, HealthKit) work the same
// way whether content is local or remote, so this doesn't affect them.
const config: CapacitorConfig = {
  appId: 'com.lwychan.fitl00p',
  appName: 'FitLoop',
  webDir: 'src',
  server: {
    url: 'https://fitl00p.netlify.app',
  },
};

export default config;
