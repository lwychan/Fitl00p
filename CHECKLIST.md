# FitLoop iOS (Capacitor) — manual steps

Everything Claude Code can do from a Windows machine without Xcode/macOS is
done (see "What's already set up" below). Everything below requires either
macOS/Xcode, the Apple Developer Portal web UI, a paid account, or a decision
only you can make — none of it was attempted.

## 1. Apple Developer Program

- [x] Already enrolled — team "Lewis Chandler", team ID `EH5PN32N9S` (an
      existing team, previously used for the unrelated Trio/nightscout app).

## 2. Apple Developer Portal (developer.apple.com)

- [x] Registered the App ID with bundle identifier **`com.lwychan.fitl00p`**
      (identifier `ZJZDD4NM9M`)
- [x] Enabled capabilities on that App ID: **HealthKit** and **Push
      Notifications** — confirmed persisted after a fresh page reload.
      (The local project already has the matching entitlements in
      `ios/App/App/App.entitlements`.)
- [ ] Signing certificate + provisioning profile — the Xcode project is set to
      `CODE_SIGN_STYLE = Automatic`, so once the App ID above exists, Xcode
      (or your chosen cloud build service, using an App Store Connect API key)
      can generate/manage these itself. Nothing to do here manually beyond
      step 2's App ID setup, unless automatic signing fails.
- [ ] (Later, only when you actually want native push to work) Generate an
      APNs Authentication Key (.p8) under Keys. Not required to get a
      TestFlight build running — only to make `@capacitor/push-notifications`
      actually deliver anything. This is separate from, and doesn't touch,
      your existing VAPID/Web Push setup.

## 3. App Store Connect (appstoreconnect.apple.com)

- [x] Created the app record: bundle ID `com.lwychan.fitl00p`, name "FitLoop",
      Apple ID `6811922097` (already filled into `codemagic.yaml`)
- [x] **Decision: TestFlight External Testing, invite-only by email — not a
      public App Store release, and not a public TestFlight link either.**
      `codemagic.yaml` already has `submit_to_app_store: false` /
      `submit_to_testflight: true`, matching this. External testing needs a
      one-time, lightweight Beta App Review from Apple (far shorter than full
      App Store review) before your first family tester can install a build.
- [x] Filled in App Privacy ("nutrition label"): 7 data types declared
      (Name, Email, Health, Fitness, Photos or Videos, User ID, Device ID),
      each marked "Used for App Functionality" + "Linked to the user's
      identity", none used for tracking.
- [ ] **Privacy Policy URL** — drafted at `src/privacy.html`, not live yet
      (needs including in your next manual Netlify deploy). Once live at
      `https://fitl00p.netlify.app/privacy.html`, tell me and I'll enter the
      URL in App Store Connect and click **Publish** on the App Privacy
      label (I've filled in the 7 data types but deliberately have not
      clicked Publish yet, pending this URL).
- [x] Answered the export-compliance question for Build 1: **"None of the
      algorithms mentioned above"** (the app only uses standard HTTPS via
      iOS's built-in networking, no custom/proprietary crypto).
- [x] Filled in Test Information (Beta App Description, Feedback Email,
      Beta App Review contact info). **Sign-In Information**: "Sign-in
      required" is checked with username `lwychndlr@gmail.com` (Lewy's
      real FitLoop login) — you entered the password directly. You also
      entered your own contact phone number directly.
- [x] **Switched from External to Internal Testing** — no Apple Beta App
      Review needed, since you and your wife just want a controlled group
      rather than public/reviewed beta testers. The External "Family"
      group and its pending Beta App Review submission were deleted.
- [x] Invited `gemmaking960@gmail.com` (Gem Chandler) as an App Store
      Connect user (Users and Access → role: **Developer** — the most
      limited role that still grants TestFlight access; scoped only to
      the FitLoop app, not your other Trio-lwychan app). **Pending: she
      needs to accept the invite email** before she can be added as an
      internal tester.
- [x] Created an Internal Testing group named **"Family"** (automatic
      distribution enabled, so future Xcode builds reach it automatically)
      and added Build 1 to it.
- [x] Added Lewis as an internal tester in the "Family" group — build is
      available to install immediately, no review wait.
- [ ] **Once Gemma accepts her App Store Connect invite**, add her to the
      "Family" internal testing group too (TestFlight → iOS → Family →
      Testers → + → select her).
- [x] **Fixed a runtime bug found on first install**: the app showed
      "fitl00p couldn't start — Configuration missing" because `app.js`
      loads Supabase config (and everything else) via relative
      `/.netlify/functions/*` calls, which only resolve when the page is
      actually served from `fitl00p.netlify.app` — the locally bundled
      Capacitor build has no server behind those paths. Fixed by adding
      `server.url: 'https://fitl00p.netlify.app'` to `capacitor.config.ts`,
      so the app loads its pages from the live site instead of the local
      bundle. No app.js changes needed.
- [x] **Fixed the build-number bug that caused build #9's TestFlight
      upload to fail** ("bundle version must be higher than previously
      uploaded version"): `codemagic.yaml`'s `get-latest-app-store-build-number`
      only checks production App Store submissions (none exist, TestFlight
      only), so it always returned 0 and every build reused build number 1.
      Now takes the higher of the App Store and TestFlight build numbers.
- [x] **Build #10 (1.0 build 2) succeeded**, cleared Apple's processing,
      and auto-distributed to the "Family" internal group. Confirmed
      installed on Lewis's iPhone 15 Plus (Sep 14, 2026). Each new build
      still needs the export-compliance question answered once in App
      Store Connect (iOS Builds → build → Manage → "None of the
      algorithms mentioned above") — added `ITSAppUsesNonExemptEncryption`
      = false to `ios/App/App/Info.plist` so future builds skip that
      question automatically.

## 4. App icon — done, but revisit before a public release

- [x] Replaced Capacitor's default placeholder icon. Cropped tight to just
      the circular fitloop mark from `src/icon-512.png` (excluding the
      baked-in wordmark/card/shadow that image has for its PWA use), then
      upscaled to the required 1024×1024, no alpha channel.
- [x] Also replaced the default splash screen (`Splash.imageset`, all 3
      scale variants) with the same mark centered on white, at 2732×2732.
- [ ] **Revisit before a public App Store release.** This was a crude
      crop-and-upscale from a 512×512 source with no image-editing tool
      available (done via Windows' built-in .NET `System.Drawing` through
      PowerShell) — it's soft/slightly blurry up close. Fine for TestFlight
      testing; a true 1024×1024+ master (or a fresh icon-only export from
      whatever made the original logo) would look sharper for real users.

## 5. Cloud build service (no Mac needed)

Chose **Codemagic** — genuine free tier (500 build min/month, not just a
trial), most mature Capacitor → TestFlight support. `codemagic.yaml` is
already written at the repo root, targeting this project's actual setup
(SPM, not CocoaPods — builds `ios/App/App.xcodeproj` directly, no
`.xcworkspace`/`pod install`).

- [x] Signed up for Codemagic (via GitHub OAuth) and installed the Codemagic
      GitHub App, scoped to just the `lwychan/Fitl00p` repo
- [x] Connected the repo in Codemagic — `codemagic.yaml` is detected on
      `main`
- [x] Generated an App Store Connect API key named **`codemagic`**
      (Key ID `AAYXF4YJBL`), **App Manager role** — turned out
      insufficient (see below), kept around for reference/future use.
- [x] **Generated a second key, `codemagic-admin`** (Key ID `FRXUX2G58F`),
      **Admin role** — required because creating certificates/provisioning
      profiles via the API (not just using existing ones) needs Admin
      access on Apple's side. `codemagic.yaml`'s `integrations:` now
      points at this one. Both `.p8` files were deleted from Downloads
      right after uploading to Codemagic.
- [x] Deleted the certificate Codemagic's UI had generated earlier
      (`fitloop-distribution`) from both Codemagic's vault and revoked it
      on Apple's side — its private key was locked in a codepath the
      CLI-based signing flow (`fetch-signing-files`) can't reach, which
      was the proximate cause of build #4's failure.
- [x] Added `VERSIONING_SYSTEM = apple-generic` to the Xcode project —
      the "Increment build number" step's `agvtool` command needs this to
      run at all.
- [x] `codemagic.yaml`'s `APP_STORE_APPLE_ID` is filled in: `6811922097`
      (the FitLoop app record's Apple ID)
- [x] **First successful build confirmed — build #8.** Builds #1-7 failed in
      sequence (missing profile → Node version → TS config loading → wrong
      API key role/stale cert → missing CERTIFICATE_PRIVATE_KEY → an
      AppDelegate.swift Swift compile error from a nonexistent Capacitor
      notification name). Build #8 cleared every step and uploaded to
      TestFlight — confirmed live in App Store Connect → TestFlight → iOS
      Builds as Version 1.0, Build 1. (Codemagic's UI labelled the run
      "post-processing failed", which just reflects Apple's export-
      compliance question below — not an actual build/upload failure.)
- [ ] No `triggering:` block is set — builds only start when you trigger
      them manually from the Codemagic dashboard, so nothing consumes free
      build minutes automatically on every push. Add one later if you want
      that (e.g. on git tags).

## 6. Connect the build service to GitHub — done

- [x] Repo remote already existed: `git@github.com:lwychan/Fitl00p` (private,
      via SSH). No new remote needed.
- [x] All local commits pushed to `origin/main` — confirmed this does NOT
      trigger a Netlify deploy (that project is zip-upload-only, not
      git-connected).
- [x] Codemagic's GitHub App installed and connected to the repo.

## 7. Secrets the build service needs — done

- [x] App Store Connect API key generated and connected (see section 5).
      Unrelated to and doesn't touch your existing Supabase, Anthropic, or
      VAPID keys, which stay exactly where they are in Netlify's environment.

## 8. Testing note

- [ ] HealthKit data (`@capgo/capacitor-health`) can't be tested in the iOS
      Simulator — it needs a real device with real Health app data. Doesn't
      require a Mac: you build via the cloud service, then install the
      TestFlight build straight onto your own iPhone.

---

## What's already set up (this session)

- `.gitignore` (node_modules, iOS/Xcode build artifacts)
- `package.json` + `@capacitor/core`, `@capacitor/cli`, `@capacitor/ios`,
  `@capacitor/camera`, `@capacitor/filesystem`, `@capacitor/push-notifications`,
  `@capgo/capacitor-health`, `typescript` (needed to load the `.ts` config)
- `capacitor.config.ts` — `appId: com.lwychan.fitl00p`, `appName: FitLoop`,
  `webDir: src` (points straight at the existing PWA files, nothing moved)
- `ios/` platform folder scaffolded via `cap add ios` — pure template
  copying, no CocoaPods (this project uses Swift Package Manager instead —
  no `pod install` step ever needed), no Xcode required to generate it
- All 4 plugins synced into the iOS project (`Package.swift`)
- `Info.plist` usage-description strings added for Camera, Photo Library,
  and HealthKit share/update
- `ios/App/App/App.entitlements` created and wired into the Xcode project
  (`CODE_SIGN_ENTITLEMENTS`), declaring HealthKit and Push Notifications
  (`aps-environment: development` — Xcode/the build service flips this to
  `production` automatically on a distribution-signed archive)
- `AppDelegate.swift` — added the three delegate methods
  `@capacitor/push-notifications` requires to forward APNs device
  tokens/errors/remote notifications to the plugin

**Untouched, as instructed:** every existing Supabase call, the
`diabetes_meals` dual-insert pattern, and the existing VAPID/Web Push setup.
