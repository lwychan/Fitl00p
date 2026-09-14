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
- [ ] **Decision: TestFlight External Testing, invite-only by email — not a
      public App Store release, and not a public TestFlight link either.**
      `codemagic.yaml` already has `submit_to_app_store: false` /
      `submit_to_testflight: true`, matching this. External testing needs a
      one-time, lightweight Beta App Review from Apple (far shorter than full
      App Store review) before your first family tester can install a build.
- [ ] Fill in App Privacy ("nutrition label") — this app reads HealthKit data
      (steps, sleep, HR, weight, workouts) and handles diabetes/glucose data
      and meal photos, so answer these carefully. Required before external
      TestFlight testing.
- [ ] Answer the export-compliance question on each build upload (a
      standard HTTPS-only app like this typically qualifies for the usual
      exemption, but you still have to answer it each time).
- [ ] Once you have a build in TestFlight, add family members as external
      testers by email (App Store Connect → TestFlight tab) — never generate/
      share the public TestFlight link.

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

- [ ] Sign up for Codemagic yourself (Claude Code won't do this or spend
      any money) and connect the `lwychan/Fitl00p` GitHub repo to it
- [ ] In Codemagic's Team settings → Integrations → Apple Developer Portal,
      add an App Store Connect API key. Name it **`codemagic`** exactly, or
      edit the `integrations: app_store_connect:` line in `codemagic.yaml`
      to match whatever name you actually give it.
- [x] `codemagic.yaml`'s `APP_STORE_APPLE_ID` is filled in: `6811922097`
      (the FitLoop app record's Apple ID)
- [ ] No `triggering:` block is set — builds only start when you trigger
      them manually from the Codemagic dashboard, so nothing consumes free
      build minutes automatically on every push. Add one later if you want
      that (e.g. on git tags).

## 6. Connect the build service to GitHub

- [ ] The repo already has a remote: `git@github.com:lwychan/Fitl00p` (private,
      via SSH). No new remote needs creating.
- [ ] Nothing from this session has been pushed yet — two local commits sit
      ahead of `origin/main` (the auth/sync work, and this Capacitor scaffold).
      Whichever build service you choose will need to read from this GitHub
      repo, so it'll need pushing eventually. Per your own `CLAUDE.md`,
      pushing to `main` also triggers a Netlify deploy — so that push needs
      your explicit go-ahead regardless of the iOS work.
- [ ] Once chosen, connect the build service to the GitHub repo (its own
      web UI — a "connect repository" / GitHub App install flow)

## 7. Secrets the build service will need

- [ ] An **App Store Connect API key** (App Store Connect → Users and Access →
      Integrations → Keys) — used for automatic code signing and uploading
      the build to TestFlight. This is new; it's unrelated to and doesn't
      touch your existing Supabase, Anthropic, or VAPID keys, which stay
      exactly where they are in Netlify's environment.

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
