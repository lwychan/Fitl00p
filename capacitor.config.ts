import type { CapacitorConfig } from '@capacitor/cli';

// webDir points straight at the existing static PWA in src/ — nothing
// there is moved or rewritten. `cap sync` copies these files as-is into
// the native iOS project's bundled web assets.
const config: CapacitorConfig = {
  appId: 'com.lwychan.fitl00p',
  appName: 'FitLoop',
  webDir: 'src',
};

export default config;
