/* ═══════════════════════════════════════════════════════════
   fitl00p — app.js — build 2026-07-07-v11
   Supabase-backed SPA. All data per-user, enforced by RLS.
   ═══════════════════════════════════════════════════════════ */

/* ── On-screen crash reporter ──────────────────────────────
   Runs before anything else. Catches uncaught throws and
   unhandled promise rejections — including ones that happen
   before getElementById lookups complete — and prints the
   real error message directly on the page. No dev tools
   needed; this is what shows on screen if the app fails to
   load instead of a silent black/blank screen. */
(function installCrashReporter() {
  function showCrash(label, err) {
    try {
      const msg = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
      let box = document.getElementById('__crashReporter');
      if (!box) {
        box = document.createElement('div');
        box.id = '__crashReporter';
        box.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#1a0000;color:#ffb4b4;' +
          'font:12px/1.5 -apple-system,monospace;padding:16px;overflow:auto;white-space:pre-wrap;' +
          'word-break:break-word;';
        const heading = document.createElement('div');
        heading.style.cssText = 'font-size:15px;font-weight:700;color:#ff6b6b;margin-bottom:10px;';
        heading.textContent = '⚠️ fitl00p crashed — copy this and send it over:';
        box.appendChild(heading);
        document.documentElement.appendChild(box);
      }
      const entry = document.createElement('div');
      entry.style.cssText = 'margin-bottom:14px;padding-bottom:14px;border-bottom:1px solid #442222;';
      entry.textContent = '[' + label + '] ' + msg;
      box.appendChild(entry);
    } catch (reporterErr) {
      // If even the reporter fails, fall back to a plain alert so something is visible
      try { alert(label + ': ' + (err && err.message ? err.message : err)); } catch {}
    }
  }
  window.addEventListener('error', e => showCrash('error', e.error || e.message));
  window.addEventListener('unhandledrejection', e => showCrash('unhandledrejection', e.reason));
})();

/* ── Remote error logging ──────────────────────────────────
   The crash reporter above only catches uncaught throws and
   unhandled promise rejections. Many things in this app fail
   "quietly" via console.error/console.warn without ever
   throwing — e.g. a Supabase query returning an error object,
   a profile load failing, a theme write failing. Those never
   trigger the red crash screen and are normally only visible
   in a real browser dev console.
   This used to mirror every console.error/console.warn call
   into an on-screen "Log (N)" tab — useful while building the
   app, but not something family testers should see. It now
   mirrors the same calls into a Supabase table (error_logs)
   instead, so problems on someone else's phone are visible
   from anywhere without needing physical access to the device.
   Best-effort only: never throws, never blocks the real
   console.error/warn, and silently drops everything until both
   the Supabase client and a signed-in user exist — matches
   error_logs' own RLS (insert requires auth.uid() = user_id),
   and a pre-auth failure is already covered by the crash
   reporter above. A per-session cap and de-dupe stop a
   repeating error from writing hundreds of rows. */
(function installErrorLogging() {
  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  const MAX_REMOTE_LOGS_PER_SESSION = 25;
  const alreadySent = new Set();
  let sentCount = 0;

  function fmt(args) {
    return args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
  }

  function logRemote(level, text) {
    try {
      if (!db || !currentUser) return; // nothing to attach the row to yet
      if (sentCount >= MAX_REMOTE_LOGS_PER_SESSION) return;
      if (alreadySent.has(text)) return; // same message already logged this session
      alreadySent.add(text);
      sentCount++;
      db.from('error_logs').insert({
        user_id: currentUser.id,
        level,
        message: text.slice(0, 4000),
        url: location.href,
      }).then(({ error }) => {
        // origError, not console.error — must never re-enter logRemote
        if (error) origError('Remote error log insert failed:', error.message);
      }).catch(() => {});
    } catch {
      // Logging must never itself throw
    }
  }

  console.error = (...args) => {
    origError(...args);
    logRemote('error', fmt(args));
  };
  console.warn = (...args) => {
    origWarn(...args);
    logRemote('warn', fmt(args));
  };
})();

/* Auth trace — small localStorage ring buffer of auth-related events
   (sign-in errors, Face ID failures, sign-outs) that happen while no
   user is signed in, when error_logs can't be written. Flushed to
   error_logs (via console.warn) after the next successful login. Never
   records passwords or tokens. */
const AUTH_TRACE_KEY = 'fitl00p:authTrace';
function authTrace(msg) {
  try {
    const arr = JSON.parse(localStorage.getItem(AUTH_TRACE_KEY) || '[]');
    arr.push(`${new Date().toISOString()} ${String(msg).slice(0, 300)}`);
    localStorage.setItem(AUTH_TRACE_KEY, JSON.stringify(arr.slice(-20)));
  } catch {}
}
function flushAuthTrace() {
  try {
    const arr = JSON.parse(localStorage.getItem(AUTH_TRACE_KEY) || '[]');
    if (!arr.length) return;
    localStorage.removeItem(AUTH_TRACE_KEY);
    console.warn('Auth trace before this login:', arr.join(' | '));
  } catch {}
}

// Regenerated 2026-07-24 — the previous key here didn't match Netlify's
// VAPID_PRIVATE, so every push got silently rejected by the push service
// with VapidPkHashMismatch regardless of encryption being correct.
// IMPORTANT: this MUST exactly match the VAPID_PUBLIC Netlify env var —
// they're two views of the same keypair, not independent settings.
const VAPID_PUBLIC = 'BOUj3c5wS_5htviclNYyinBVVxCkz0HfJOZVcVrEoxIwBFqPqxljCg7l5mQ1hGjQKWz_NvhGlvoEeRSMuDI7m98';

// Supabase project — public by design. The anon key is meant to be
// embedded in client code (same as it was previously served to the
// client at boot by Netlify's config.js); Row Level Security, not
// secrecy of this key, is what actually protects data. Hardcoded
// directly now instead of fetched over the network at boot, since the
// native app doesn't need a bootstrap round-trip just to learn its own
// backend's address — see the client-init block below.
const SUPABASE_URL = 'https://nxawnkpzjixishcerxcv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im54YXdua3B6aml4aXNoY2VyeGN2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI0MzE5MDYsImV4cCI6MjA5ODAwNzkwNn0.JpZQw0NaCAmur7lX0axzVro9yhfhj8eQjcVppUrNgsk';

// Supabase Edge Functions live at the project's own domain — an absolute
// URL works identically whether this page is served from the web or
// bundled straight into the native ipa, so (unlike the old NETLIFY_ORIGIN
// this replaces) there's no native-vs-web branch needed here.
const FUNCTIONS_ORIGIN = `${SUPABASE_URL}/functions/v1`;

// Every Edge Function requires a valid JWT in Authorization (verify_jwt
// is on for all of them). Calls that already carry the signed-in user's
// own session token satisfy that for free; the handful of proxy-style
// calls below that don't represent a particular user send the anon key
// instead — it's a valid signed JWT, so it clears the gateway check even
// though the function itself never treats it as a real user identity.
const FUNCTIONS_ANON_HEADERS = { Authorization: `Bearer ${SUPABASE_ANON_KEY}` };

const { createClient } = window.supabase;
let db = null; // initialised just below — no network round-trip needed first

// supabase-js guards auth calls (signInWithPassword, refreshSession, etc.)
// with a cross-tab mutex built on navigator.locks. If a lock is ever
// orphaned — an aborted request, a reload mid-acquisition, a backgrounded
// tab — every future auth call queues behind it and hangs forever with no
// error, which is why this used to be replaced with a true no-op (skip the
// lock entirely). But going fully lock-free traded that hang for a
// different real bug, confirmed from Supabase's own auth audit log: two
// refresh attempts firing close together with nothing serializing them can
// both submit the same refresh_token — Supabase rotates+revokes it on
// first use, so the loser's request gets rejected and the whole session is
// treated as dead, forcing a fresh password login even though the session
// was fine seconds earlier (seen twice in one day, once just 5 minutes
// after a refresh had just succeeded).
//
// This is the middle ground: a real mutex that still serializes auth calls
// (so the race above can't happen) but is plain JS state scoped to this
// tab's own execution context — not the browser-level navigator.locks API
// — so it's wiped clean by any reload and can never carry an orphaned lock
// across one. A bounded wait is kept as a second line of defense: if a
// held call somehow never finishes, waiters give up and proceed rather
// than queue forever, so this still can't reintroduce the original hang.
let authLockChain = Promise.resolve();
async function tabLocalAuthLock(name, acquireTimeout, fn) {
  const waitMs = acquireTimeout > 0 ? acquireTimeout : 10000;
  const previousHolder = authLockChain;
  let releaseThisHold;
  authLockChain = new Promise(resolve => { releaseThisHold = resolve; });
  try {
    await Promise.race([previousHolder, new Promise(resolve => setTimeout(resolve, waitMs))]);
    return await fn();
  } finally {
    releaseThisHold();
  }
}

/* ── DOM shortcuts ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  // screens
  screenBoot: $('screenBoot'),
  btnBootHardReset: $('btnBootHardReset'),
  screenAuth: $('screenAuth'),
  screenApp:  $('screenApp'),
  // auth
  formSignin:    $('formSignin'),
  siEmail:       $('siEmail'),
  siPassword:    $('siPassword'),
  btnSignin:     $('btnSignin'),
  btnBiometricLogin: $('btnBiometricLogin'),
  btnForgot:     $('btnForgot'),
  msgSignin:     $('msgSignin'),
  btnAuthToggle:   $('btnAuthToggle'),
  authToggleText:  $('authToggleText'),
  // appbar
  appbarUser:    $('appbarUser'),
  appNav:        $('appNav'),
  tabBar:        $('tabBar'),
  btnSignout:    $('btnSignout'),
  btnSignoutHeader: $('btnSignoutHeader'),
  btnOpenSettingsHeader: $('btnOpenSettingsHeader'),
  btnReloadHeader: $('btnReloadHeader'),
  sessionBrokenBanner:     $('sessionBrokenBanner'),
  btnReloadSession:        $('btnReloadSession'),
  btnFixSession:           $('btnFixSession'),
  btnDismissSessionBanner: $('btnDismissSessionBanner'),
  // views
  viewDashboard:    $('viewDashboard'),
  viewWorkout:      $('viewWorkout'),
  viewHistory:      $('viewHistory'),
  viewSettings:     $('viewSettings'),
  viewWorkoutAdmin: $('viewWorkoutAdmin'),
  viewLogFood:      $('viewLogFood'),
  btnOpenLogFood:   $('btnOpenLogFood'),
  btnLogFoodBack:   $('btnLogFoodBack'),
  mtCals:           $('mtCals'),
  mtProtein:        $('mtProtein'),
  mtCarbs:          $('mtCarbs'),
  mtFat:            $('mtFat'),
  lfRemainingCard:  $('lfRemainingCard'),
  rtCals:           $('rtCals'),
  rtProtein:        $('rtProtein'),
  rtCarbs:          $('rtCarbs'),
  rtFat:            $('rtFat'),
  rtAdjustedNote:   $('rtAdjustedNote'),
  lfMealSlot:       $('lfMealSlot'),
  lfModePills:      $('lfModePills'),
  btnLfCopyYesterday: $('btnLfCopyYesterday'),
  lfScanPanel:      $('lfScanPanel'),
  lfScanVideo:      $('lfScanVideo'),
  lfScanStatus:     $('lfScanStatus'),
  lfScanUnsupported: $('lfScanUnsupported'),
  btnLfScanStop:    $('btnLfScanStop'),
  lfSearchPanel:    $('lfSearchPanel'),
  lfSearchInput:    $('lfSearchInput'),
  lfSearchResults:  $('lfSearchResults'),
  lfPhotoPanel:     $('lfPhotoPanel'),
  lfPhotoButtons:      $('lfPhotoButtons'),
  lfPhotoInputCamera:  $('lfPhotoInputCamera'),
  lfPhotoInputLibrary: $('lfPhotoInputLibrary'),
  lfPhotoThumbs:    $('lfPhotoThumbs'),
  lfPhotoTimeNote:  $('lfPhotoTimeNote'),
  lfLoggedAt:       $('lfLoggedAt'),
  lfPhotoAfterInputCamera:  $('lfPhotoAfterInputCamera'),
  lfPhotoAfterInputLibrary: $('lfPhotoAfterInputLibrary'),
  lfPhotoAfterPreview:      $('lfPhotoAfterPreview'),
  lfPhotoAfterPreviewWrap:  $('lfPhotoAfterPreviewWrap'),
  btnLfPhotoAfterClear:     $('btnLfPhotoAfterClear'),
  lfPhotoDesc:      $('lfPhotoDesc'),
  btnLfEstimate:    $('btnLfEstimate'),
  lfEstimateStatus: $('lfEstimateStatus'),
  lfTextPanel:      $('lfTextPanel'),
  lfTextInput:      $('lfTextInput'),
  lfTextLoggedAt:   $('lfTextLoggedAt'),
  btnLfTextEstimate: $('btnLfTextEstimate'),
  lfTextEstimateStatus: $('lfTextEstimateStatus'),
  lfTextResults:    $('lfTextResults'),
  lfTextNote:       $('lfTextNote'),
  lfTextItems:      $('lfTextItems'),
  lfTextTotal:      $('lfTextTotal'),
  lfTextShareWrap:  $('lfTextShareWrap'),
  lfTextShare:      $('lfTextShare'),
  lfTextShareName:  $('lfTextShareName'),
  btnLfTextSave:    $('btnLfTextSave'),
  btnLfTextCancel:  $('btnLfTextCancel'),
  lfTextSaveStatus: $('lfTextSaveStatus'),
  lfReviewForm:     $('lfReviewForm'),
  lfFoodName:       $('lfFoodName'),
  lfBrand:          $('lfBrand'),
  lfQuantity:       $('lfQuantity'),
  lfServingDesc:    $('lfServingDesc'),
  lfCals:           $('lfCals'),
  lfProtein:        $('lfProtein'),
  lfCarbs:          $('lfCarbs'),
  lfFat:            $('lfFat'),
  lfEstimateNote:   $('lfEstimateNote'),
  lfHypoTreatment:     $('lfHypoTreatment'),
  lfHypoTreatmentWrap: $('lfHypoTreatmentWrap'),
  lfSaveAsCustom:   $('lfSaveAsCustom'),
  lfSaveAsCustomWrap: $('lfSaveAsCustomWrap'),
  lfShare:          $('lfShare'),
  lfShareWrap:      $('lfShareWrap'),
  lfShareName:      $('lfShareName'),
  btnLfFavToggle:   $('btnLfFavToggle'),
  lfFavoritesCard:  $('lfFavoritesCard'),
  lfFavoritesSelect: $('lfFavoritesSelect'),
  lfFavoritesAdd:   $('lfFavoritesAdd'),
  lfFavoritesDelete: $('lfFavoritesDelete'),
  btnLfSave:        $('btnLfSave'),
  btnLfCancel:      $('btnLfCancel'),
  lfSaveStatus:     $('lfSaveStatus'),
  lfTodayList:      $('lfTodayList'),
  // dashboard
  dCurrentWeight: $('dCurrentWeight'),
  dCurrentUnit:   $('dCurrentUnit'),
  dTargetWeight:  $('dTargetWeight'),
  dTargetUnit:    $('dTargetUnit'),
  dProgressFill:  $('dProgressFill'),
  dProgressLabel: $('dProgressLabel'),
  dPlanStats:     $('dPlanStats'),
  dCalTarget:     $('dCalTarget'),
  dDeficitNeeded: $('dDeficitNeeded'),
  dWeeklyPace:    $('dWeeklyPace'),
  dTodayDate:     $('dTodayDate'),
  dHeroDate:      $('dHeroDate'),
  dTodayWeight:   $('dTodayWeight'),
  dTodaySteps:    $('dTodaySteps'),
  dTodayCals:     $('dTodayCals'),
  dTodayBurn:     $('dTodayBurn'),
  dLogTodayBtn:   $('dLogTodayBtn'),
  weightReminderCard: $('weightReminderCard'),
  wrBadge:        $('wrBadge'),
  wrHint:         $('wrHint'),
  wrWeight:       $('wrWeight'),
  wrUnit:         $('wrUnit'),
  btnWrSave:      $('btnWrSave'),
  wrStatus:       $('wrStatus'),
  rSteps:         $('rSteps'),
  rStepsPct:      $('rStepsPct'),
  rCal:           $('rCal'),
  rCalPct:        $('rCalPct'),
  dashChart:      $('dashChart'),
  dashChartEmpty: $('dashChartEmpty'),
  dashChartSkeleton: $('dashChartSkeleton'),
  btnCoachBell:         $('btnCoachBell'),
  coachModal:           $('coachModal'),
  coachBellDot:         $('coachBellDot'),
  coachBriefingEmpty:   $('coachBriefingEmpty'),
  coachBriefingBody:    $('coachBriefingBody'),
  coachBriefingDate:    $('coachBriefingDate'),
  coachBriefingText:    $('coachBriefingText'),
  checklistCard:        $('checklistCard'),
  checklistTiles:       $('checklistTiles'),
  checklistStreak:      $('checklistStreak'),
  checklistStreakCount: $('checklistStreakCount'),
  peptideSection:          $('peptideSection'),
  btnPeptideSectionClose:  $('btnPeptideSectionClose'),
  peptideProtocolsContainer: $('peptideProtocolsContainer'),
  oralMedsSection:         $('oralMedsSection'),
  btnOralMedsToggle:       $('btnOralMedsToggle'),
  btnOralMedsSectionClose: $('btnOralMedsSectionClose'),
  oralMedsContainer:       $('oralMedsContainer'),
  bpcAccordionBody:        $('bpcAccordionBody'),
  bpcHistory:              $('bpcHistory'),
  scoreCarousel:      $('scoreCarousel'),
  scoreCarouselEmpty: $('scoreCarouselEmpty'),
  scoreDetail:        $('scoreDetail'),
  scoreDetailLabel:   $('scoreDetailLabel'),
  scoreDetailMeta:    $('scoreDetailMeta'),
  scoreDetailFactors: $('scoreDetailFactors'),
  scoreDetailClose:   $('scoreDetailClose'),
  // Health tiles
  healthTiles:      $('healthTiles'),
  healthTilesEmpty: $('healthTilesEmpty'),
  healthTilesDate:  $('healthTilesDate'),
  dLastWorkout:   $('dLastWorkout'),
  // log
  logDate:        $('logDate'),
  logForm:        $('logForm'),
  logWeight:      $('logWeight'),
  logWeightUnit:  $('logWeightUnit'),
  logSteps:       $('logSteps'),
  logActiveCal:   $('logActiveCal'),
  stepsBar:       $('stepsBar'),
  stepsPct:       $('stepsPct'),
  stepsGoalLabel: $('stepsGoalLabel'),
  mBreakfast:     $('mBreakfast'),
  mLunch:         $('mLunch'),
  mDinner:        $('mDinner'),
  mSnacks:        $('mSnacks'),
  calTotal:       $('calTotal'),
  calTarget:      $('calTarget'),
  calBar:         $('calBar'),
  logNotes:       $('logNotes'),
  btnSaveLog:     $('btnSaveLog'),
  logStatus:      $('logStatus'),
  // workout — managed via elW object in the workout section

  // history
  historyChart:        $('historyChart'),
  historyChartEmpty:   $('historyChartEmpty'),
  historyTableBody:    $('historyTableBody'),
  btnExportCsv:        $('btnExportCsv'),
  btnTzToggle:         $('btnTzToggle'),
  btnTzClose:          $('btnTzClose'),
  tzCard:              $('tzCard'),
  tzChart:             $('tzChart'),
  tzChartEmpty:        $('tzChartEmpty'),
  tzCurrentLevel:      $('tzCurrentLevel'),
  tzInspectPanel:      $('tzInspectPanel'),
  tzLogForm:           $('tzLogForm'),
  tzLogButtonWrap:     $('tzLogButtonWrap'),
  btnTzLog:            $('btnTzLog'),
  btnTzSave:           $('btnTzSave'),
  btnTzCancel:         $('btnTzCancel'),
  tzDoseMg:            $('tzDoseMg'),
  tzInjectedAt:        $('tzInjectedAt'),
  tzSite:              $('tzSite'),
  tzFormStatus:        $('tzFormStatus'),
  tzDoseList:          $('tzDoseList'),
  tzPenStatus:         $('tzPenStatus'),
  tzPenWarning:        $('tzPenWarning'),
  tzPenForm:           $('tzPenForm'),
  tzPenReceivedAt:     $('tzPenReceivedAt'),
  tzPenVolumeMg:       $('tzPenVolumeMg'),
  tzPenViableDays:     $('tzPenViableDays'),
  btnTzPenSave:        $('btnTzPenSave'),
  btnTzPenCancel:      $('btnTzPenCancel'),
  btnTzPenAdd:         $('btnTzPenAdd'),
  tzPenAddButtonWrap:  $('tzPenAddButtonWrap'),
  tzPenFormStatus:     $('tzPenFormStatus'),
  tzPenHistory:        $('tzPenHistory'),
  // settings
  setDisplayName:    $('setDisplayName'),
  setTdee:           $('setTdee'),
  setStepsGoal:      $('setStepsGoal'),
  setEatTargetManual: $('setEatTargetManual'),
  setPlanStart:      $('setPlanStart'),
  setPlanTarget:     $('setPlanTarget'),
  setPlanStartDate:  $('setPlanStartDate'),
  setPlanTargetDate: $('setPlanTargetDate'),
  btnSaveSettings:   $('btnSaveSettings'),
  settingsStatus:    $('settingsStatus'),
  btnChangePassword: $('btnChangePassword'),
  changePasswordMsg: $('changePasswordMsg'),
  // diabetes
  viewDiabetes:      $('viewDiabetes'),
  dxNotConnected:    $('dxNotConnected'),
  dxConnected:       $('dxConnected'),
  dxNowCard:         $('dxNowCard'),
  dxReadingAge:      $('dxReadingAge'),
  dxCurrentGlucose:  $('dxCurrentGlucose'),
  dxTrendArrow:      $('dxTrendArrow'),
  dxIob:             $('dxIob'),
  dxCob:             $('dxCob'),
  dxEffective:       $('dxEffective'),
  dxStaleNote:       $('dxStaleNote'),
  dxForecastBody:    $('dxForecastBody'),
  dxCorrectionBody:  $('dxCorrectionBody'),
  dxMealPreset:      $('dxMealPreset'),
  dxMealName:        $('dxMealName'),
  dxMealCarbs:       $('dxMealCarbs'),
  dxMealFat:         $('dxMealFat'),
  dxMealProtein:     $('dxMealProtein'),
  dxMealDoseBody:    $('dxMealDoseBody'),
  dxPatternsWindow:  $('dxPatternsWindow'),
  dxPatternsBody:    $('dxPatternsBody'),
  dxHealthBody:      $('dxHealthBody'),
  dxForecastAccuracyBody: $('dxForecastAccuracyBody'),
  dxTodaysMealsCard: $('dxTodaysMealsCard'),
  dxTodaysMealsBody: $('dxTodaysMealsBody'),
  dxSensitivityBody: $('dxSensitivityBody'),
  dxRegimenBody:     $('dxRegimenBody'),
  dxWorkoutImpactCard: $('dxWorkoutImpactCard'),
  dxWorkoutImpactPills: $('dxWorkoutImpactPills'),
  dxUnplugMode:        $('dxUnplugMode'),
  dxWorkoutImpactDuration: $('dxWorkoutImpactDuration'),
  dxWorkoutImpactIntensity: $('dxWorkoutImpactIntensity'),
  btnDxWorkoutImpact:  $('btnDxWorkoutImpact'),
  dxWorkoutImpactBody: $('dxWorkoutImpactBody'),
  dxWorkoutHistoryList: $('dxWorkoutHistoryList'),
  dxGlucoseChart:      $('dxGlucoseChart'),
  dxGlucoseChartEmpty: $('dxGlucoseChartEmpty'),
  dxChartScroll:       $('dxChartScroll'),
  dxChartMarkers:      $('dxChartMarkers'),
  dxBasalFreshness:    $('dxBasalFreshness'),
  dxMarkerModal:       $('dxMarkerModal'),
  dxMarkerModalTitle:  $('dxMarkerModalTitle'),
  dxMarkerModalBody:   $('dxMarkerModalBody'),
  dxMarkerModalClose:  $('dxMarkerModalClose'),
  btnDxLogActivity:  $('btnDxLogActivity'),
  dxActivityLogForm: $('dxActivityLogForm'),
  dxActivityType:    $('dxActivityType'),
  dxActivityDate:    $('dxActivityDate'),
  dxActivityTime:    $('dxActivityTime'),
  dxActivityDuration: $('dxActivityDuration'),
  dxActivityUnplugged: $('dxActivityUnplugged'),
  btnSaveDxActivity: $('btnSaveDxActivity'),
  btnCancelDxActivity: $('btnCancelDxActivity'),
  dxActivityLogStatus: $('dxActivityLogStatus'),
  dxActivityLogList: $('dxActivityLogList'),
  dxGapBanner:       $('dxGapBanner'),
  dxGapBannerText:   $('dxGapBannerText'),
  btnDxResolveGap:   $('btnDxResolveGap'),
  btnDxLogInsulinGap: $('btnDxLogInsulinGap'),
  dxInsulinGapForm:  $('dxInsulinGapForm'),
  dxGapReason:       $('dxGapReason'),
  dxGapDate:         $('dxGapDate'),
  dxGapTime:         $('dxGapTime'),
  dxGapNote:         $('dxGapNote'),
  btnSaveDxGap:      $('btnSaveDxGap'),
  btnCancelDxGap:    $('btnCancelDxGap'),
  dxGapLogStatus:    $('dxGapLogStatus'),
  dxInsulinGapList:  $('dxInsulinGapList'),
  dxLastSync:        $('dxLastSync'),
  btnDxSimpleMode:   $('btnDxSimpleMode'),
  screenDxSimple:    $('screenDxSimple'),
  btnDxSimpleExit:   $('btnDxSimpleExit'),
  dxSimpleGlucose:   $('dxSimpleGlucose'),
  dxSimpleTrend:     $('dxSimpleTrend'),
  dxSimpleIob:       $('dxSimpleIob'),
  dxSimpleBasal:     $('dxSimpleBasal'),
  dxSimpleAction:      $('dxSimpleAction'),
  dxSimpleActionText:  $('dxSimpleActionText'),
  dxSimpleUpdated:   $('dxSimpleUpdated'),
  // detected activity
  detectedActivityModal:     $('detectedActivityModal'),
  detectedActivityClose:     $('detectedActivityClose'),
  detectedActivityDesc:      $('detectedActivityDesc'),
  detectedActivityQueueNote: $('detectedActivityQueueNote'),
  btnDetectedActivityConfirm: $('btnDetectedActivityConfirm'),
  btnDetectedActivityIgnore:  $('btnDetectedActivityIgnore'),
  // global
  toast:         $('toast'),
};

/* ── App state ──────────────────────────────────────────── */
let currentUser    = null;
let profile        = null;   // profiles row
let activePlan     = null;   // weight_plans row (is_active=true)
let todayLog       = null;   // daily_logs row for today

const KCAL_PER_KG  = 7700;

// Body-weight fields that a user can type a value into — daily_logs.weight
// and weight_plans.start_weight/target_weight — are stored as canonical KG
// always, same convention as health_daily.weight_kg (Apple Health sync).
// Converted to/from the display unit ONLY at the UI boundary: once when
// saving a typed value, once when rendering a stored value. Every internal
// comparison/arithmetic (plan progress, BMI-per-kg dosing, deficit maths)
// must use the raw kg value untouched — mixing a converted display number
// back into that math is exactly the bug this convention exists to prevent
// (a value saved while the display unit was kg being silently reinterpreted
// as lb, or vice versa, the moment the user switches units in Settings).
const LB_TO_KG = 0.45359237;
const weightToKg   = (val, unit) => unit === 'lb' ? Number(val) * LB_TO_KG : Number(val);
const weightFromKg = (kg, unit)  => unit === 'lb' ? Number(kg) / LB_TO_KG : Number(kg);

// Body weight (dashboard, History, weight plan, onboarding, manual weight
// logging) always displays/enters in lb; exercise/lifting weight (workout
// sets, personal records, strength progress) always in kg — hardcoded
// rather than a user-switchable setting, since a single shared toggle
// covering both was flipping the "wrong" one and corrupting the other's
// numbers. There is no Settings control for either of these anymore.
const BODY_WEIGHT_UNIT     = 'lb';
const EXERCISE_WEIGHT_UNIT = 'kg';

// Two-person household, same fixed id already hardcoded server-side
// (see GEMMA_USER_ID in netlify/functions/_lib/webpush.js) — gates the
// Gemma-only daily checklist card below and the diabetes tab's default
// visibility assumption for her account specifically.
const GEMMA_USER_ID = '2c8bf000-b870-4ea1-8a67-ec00ee7d4041';

// Progressive overload: equipment where a fixed external weight is
// actually being added (barbell plates, a dumbbell pair, a plate-loaded
// or pin-stack machine) supports a real "add a bit more than last time"
// suggestion. Cable/kettlebell/bodyweight are left alone — cable stacks
// and kettlebells jump in their own fixed increments that vary machine to
// machine, and bodyweight has no external load to increment at all.
const PROGRESSIVE_EQUIPMENT = new Set(['barbell', 'dumbbell', 'machine']);
const PROGRESSION_INCREMENT_KG = 2.5;

// Standard bar/plate loading (kg) — a 20kg Olympic bar plus a common
// gym plate set. There's no per-exercise bar-type field in the data
// model (EZ bar, trap bar etc. would differ), so this is a reasonable
// default rather than something precisely tracked per exercise.
const BARBELL_BAR_KG = 20;
const AVAILABLE_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25];

// Greedy per-side plate breakdown for a total barbell weight — e.g. 60kg
// total = 20kg bar + 20kg per side, so this returns [{kg:20,count:1}].
// Returns null when the weight is below the bar itself, or up to ~0.5kg
// off what's achievable with this plate set (rounding/typo territory)
// rather than silently proposing a slightly-wrong combination.
function platesForWeight(totalWeight, barWeightKg = BARBELL_BAR_KG) {
  const total = Number(totalWeight);
  if (!Number.isFinite(total) || total < barWeightKg) return null;
  let perSide = (total - barWeightKg) / 2;
  if (perSide < 0.01) return [];

  const breakdown = [];
  for (const plate of AVAILABLE_PLATES_KG) {
    let count = 0;
    while (perSide + 1e-9 >= plate) { perSide -= plate; count++; }
    if (count > 0) breakdown.push({ kg: plate, count });
  }
  return perSide > 0.5 ? null : breakdown; // leftover too big to represent with this plate set
}

// Given the last session's top set for this exercise (or null if it's
// never been logged), decide the suggested starting weight for this
// session — null if this equipment type isn't a progressive one, or
// there's no history yet to build from. hitTarget reflects whether last
// time's reps met the prescribed target (or there is no target), which
// is what decides bump-vs-repeat.
function computeSuggestedWeight(equipmentType, last, targetReps) {
  if (!last || !equipmentType || !PROGRESSIVE_EQUIPMENT.has(equipmentType)) return null;
  const hitTarget = !targetReps || last.reps >= targetReps;
  return hitTarget ? last.weight + PROGRESSION_INCREMENT_KG : last.weight;
}

function formatPlateHint(equipmentType, weight, baseWeightKg) {
  if (equipmentType !== 'barbell') return '';
  const bar = baseWeightKg != null ? Number(baseWeightKg) : BARBELL_BAR_KG;
  const breakdown = platesForWeight(weight, bar);
  if (breakdown == null) return '';
  if (!breakdown.length) return `= bar only (${bar}kg)`;
  return `= ${breakdown.map(b => `${b.count}×${b.kg}`).join(' + ')}kg per side`;
}

// One-line "why this weight is pre-filled" explanation — shown whenever
// suggestedWeight was actually computed (a progressive-equipment exercise
// with a real last-session top set to build from).
function renderProgressionHint(ex) {
  if (ex.suggestedWeight == null || !ex.lastSession) return '';
  const { weight: lastWeight, reps: lastReps } = ex.lastSession;
  const hitTarget = !ex.reps || lastReps >= ex.reps;
  const note = hitTarget
    ? `hit ${ex.reps || lastReps} reps — up ${PROGRESSION_INCREMENT_KG}kg`
    : `missed the ${ex.reps} rep target — repeating this weight`;
  return `<div class="exercise-card__progression" style="font-size:12px;color:var(--ink-2);margin:0 16px 4px">
    💪 Suggested: ${fmt1(ex.suggestedWeight)}${EXERCISE_WEIGHT_UNIT} (last time ${lastWeight}${EXERCISE_WEIGHT_UNIT} × ${lastReps}, ${note})
  </div>`;
}

// Small "⏱ Ns rest" pill shown only when this exercise has a real
// per-exercise rest_seconds_override — otherwise a countdown that's
// shorter/longer than the routine's stated rest (e.g. a deliberately
// quicker 60s for an isolation move vs. the routine's 90s default)
// looks like a random glitch instead of the intentional per-exercise
// setting it actually is.
function restBadgeHtml(ex) {
  if (ex.rest_seconds_override == null) return '';
  return `<span class="exercise-card__rest-badge" title="This exercise has its own rest time, different from the routine default">⏱ ${ex.rest_seconds_override}s rest</span>`;
}

const EXERCISE_LIST = [
  'Bench Press','Incline Bench Press','Decline Bench Press','Dumbbell Fly',
  'Overhead Press','Arnold Press','Push-Up','Dips','Cable Fly','Pec Deck',
  'Lateral Raise','Front Raise','Tricep Pushdown','Skull Crushers','Close-Grip Bench',
  'Pull-Up','Chin-Up','Barbell Row','Dumbbell Row','Seated Cable Row','Lat Pulldown',
  'Face Pull','Rear Delt Fly','Bicep Curl','Hammer Curl','Preacher Curl','Cable Curl',
  'Squat','Front Squat','Leg Press','Leg Extension','Leg Curl','Romanian Deadlift',
  'Deadlift','Sumo Deadlift','Hip Thrust','Glute Bridge','Calf Raise','Hack Squat',
  'Lunges','Bulgarian Split Squat','Step-Up','Leg Press Calf Raise',
  'Plank','Ab Wheel','Sit-Up','Crunch','Russian Twist','Cable Crunch','Hanging Leg Raise',
  'Treadmill','Rowing Machine','Cycling','Elliptical','Battle Ropes','Jump Rope',
];

/* ═══════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════ */
const todayISO = () => new Date().toISOString().slice(0, 10);

const fmtDate = iso => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const fmtAxis = iso => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

const fmt1 = n => (n == null ? '—' : Number(n).toFixed(1));
// Insulin-unit amounts specifically — Tandem t:slim X2 (and most modern
// pumps) microdose to 0.01u, so these show the real precision instead of
// fmt1's coarser 1 decimal place.
const fmtDose = n => (n == null ? '—' : Number(n).toFixed(2));
const fmtInt = n => (n == null ? '—' : Math.round(n).toLocaleString());
const fmtSigned = (n, dp) => (n >= 0 ? '+' : '') + Number(n).toFixed(dp);
const clamp01 = (v, g) => Math.min(100, Math.max(0, (v / (g || 1)) * 100));
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

// Consumed-calories precedence, shared by every place that displays
// "Eaten" for a given day. Native fitl00p food logging (cal_fitl00p, a
// per-day total summed from food_log) wins whenever anything was logged
// that way — it's the exact food actually eaten, not an estimate. Below
// that, cal_mfp (scraped straight from MFP's own diary totals row) wins
// over dietary_energy_kcal (summed from individual HealthKit samples via
// Health Auto Export — vulnerable to running high if MFP ever leaves a
// stale duplicate sample behind after an edited entry, since nothing
// dedupes those). MFP is being retired in favour of native logging, so
// these two are now just a graceful fallback for days without a
// fitl00p entry. Manual-entry fields are the last resort for anyone not
// using any sync.
function pickConsumedCalories(log, health) {
  if (log?.cal_fitl00p != null) return Number(log.cal_fitl00p);
  if (log?.cal_mfp != null) return Number(log.cal_mfp);
  if (health?.dietary_energy_kcal != null) return Number(health.dietary_energy_kcal);
  if (log?.cal_apple != null) return Number(log.cal_apple);
  if (log?.cal_total > 0) return Number(log.cal_total);
  return null;
}

// Shared BMR calculation (Mifflin-St Jeor), same formula already used
// and verified in the eat-target calculation. Used as a default proxy
// for resting_energy_kcal when someone hasn't connected Apple Health
// at all — there's no manual-entry field for resting calories (unlike
// active calories/weight/steps, which someone can genuinely observe
// and log by hand), so a formula-based estimate is the only real
// fallback available, given real height/age/sex and a real weight.
function calcBmr(weightKg, heightCm, ageYears, sex) {
  if (!weightKg || !heightCm || !ageYears) return null;
  return sex === 'female'
    ? (10 * weightKg) + (6.25 * heightCm) - (5 * ageYears) - 161
    : (10 * weightKg) + (6.25 * heightCm) - (5 * ageYears) + 5;
}

let toastTimer = null;
function showToast(msg, isError = false) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  el.toast.classList.toggle('is-error', isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 3000);
}

function flash(statusEl, msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('is-error', isError);
  statusEl.classList.add('is-visible');
  setTimeout(() => statusEl.classList.remove('is-visible'), 2500);
}

function setBtn(btn, loading, text, loadingText = 'Saving…') {
  btn.disabled = loading;
  btn.textContent = loading ? loadingText : text;
}

/* ═══════════════════════════════════════════════════════════
   OFFLINE SYNC QUEUE
   Scope (deliberately narrow, not a blanket wrapper around every write
   in the app — see the memory/commit notes for why): weight logging and
   workout sets only. Diabetes-related writes (food log, meal dosing,
   insulin) are excluded on purpose — they bridge into a real-time dose-
   suggestion flow, so a write that silently succeeds now and only
   actually lands in the DB minutes/hours later (once back online) would
   surface a suggestion against stale glucose data. Better to fail
   loudly and ask the person to retry when they have signal than to
   queue something dosing-adjacent invisibly.

   localStorage, not IndexedDB — the queue only ever holds a handful of
   small pending-write objects, never bulk data, so localStorage's
   simpler synchronous API is enough and avoids IndexedDB's async
   transaction complexity for no real benefit here. Plain
   navigator.onLine/'online' event, not @capacitor/network — Capacitor's
   WKWebView already reflects real OS connectivity through those, so
   pulling in another native plugin (another Xcode capability, another
   `cap sync`) isn't needed just for this.
═══════════════════════════════════════════════════════════ */
const OFFLINE_QUEUE_KEY = 'fitl00p_offline_queue_v1';

function loadOfflineQueue() {
  try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); }
  catch { return []; }
}
function saveOfflineQueue(queue) {
  try { localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue)); }
  catch (err) { console.error('Failed to persist offline queue:', err); }
}

// Supabase-js never throws on a failed request — a network failure comes
// back as an `error` object too, same as a real server-side rejection.
// The two need telling apart: a genuine PostgREST/Postgres error carries
// a `code` (e.g. '23505' unique violation, '42501' RLS denial) — those
// are real problems to surface, not retry blindly forever. A network
// failure has no such code, just a generic fetch-level message.
function isNetworkError(error) {
  if (!error) return false;
  if (error.code) return false;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed');
}

function updateOfflineSyncBanner() {
  const banner = $('offlineSyncBanner');
  const textEl = $('offlineSyncText');
  if (!banner) return;
  const pending = loadOfflineQueue().length;
  if (!navigator.onLine) {
    banner.hidden = false;
    if (textEl) textEl.textContent = pending
      ? `Offline — ${pending} change${pending === 1 ? '' : 's'} will sync when you're back online.`
      : "Offline — changes will sync when you're back online.";
  } else if (pending) {
    banner.hidden = false;
    if (textEl) textEl.textContent = `Syncing ${pending} pending change${pending === 1 ? '' : 's'}…`;
  } else {
    banner.hidden = true;
  }
}

// table/op/payload only (op: 'insert' | 'upsert') — deliberately not a
// closure, so the queue survives JSON round-tripping through localStorage
// across app restarts, not just the current session.
async function queuedWrite(table, op, payload, opts) {
  if (navigator.onLine) {
    const { data, error } = await db.from(table)[op](payload, opts || undefined);
    if (!error) return { data, error: null, queued: false };
    if (!isNetworkError(error)) return { data: null, error, queued: false }; // real rejection — surface normally, don't queue
  }
  const queue = loadOfflineQueue();
  queue.push({ table, op, payload, opts: opts || null, queuedAt: new Date().toISOString() });
  saveOfflineQueue(queue);
  updateOfflineSyncBanner();
  return { data: null, error: null, queued: true };
}

async function flushOfflineQueue() {
  if (!navigator.onLine || !currentUser) return;
  const queue = loadOfflineQueue();
  if (!queue.length) return;

  const remaining = [];
  let synced = 0;
  for (const item of queue) {
    try {
      const { error } = await db.from(item.table)[item.op](item.payload, item.opts || undefined);
      if (error) {
        if (isNetworkError(error)) { remaining.push(item); continue; } // still no real connection — keep for next attempt
        // A genuine rejection on retry (e.g. a stale conflict) — drop it
        // rather than retry forever, but log it so it's not silently lost.
        console.error(`Offline queue: dropped a queued ${item.table} write after reconnect —`, error.message);
        continue;
      }
      synced++;
    } catch (err) {
      remaining.push(item);
      console.error('Offline queue flush error:', err.message);
    }
  }
  saveOfflineQueue(remaining);
  updateOfflineSyncBanner();
  if (synced) showToast(`Synced ${synced} offline change${synced === 1 ? '' : 's'}.`);
}

window.addEventListener('online', flushOfflineQueue);
window.addEventListener('offline', updateOfflineSyncBanner);

/* ═══════════════════════════════════════════════════════════
   AUTH — wired in initApp() after db is ready
═══════════════════════════════════════════════════════════ */

// Sign in / sign up — real Supabase auth (signInWithPassword / signUp),
// which is what RLS's auth.uid() = user_id checks key off of. Sign-up
// lands the new account in the existing pending-approval flow (role
// defaults to 'pending' via the handle_new_user DB trigger; see
// createApprovalRequest and the role branch in onAuthStateChange below) —
// an admin approves them from the existing IAM modal (loadIamData).
let authMode = 'signin'; // 'signin' | 'signup'

function setAuthMode(mode) {
  authMode = mode;
  const isSignup = mode === 'signup';
  setBtn(el.btnSignin, false, isSignup ? 'Sign up' : 'Unlock');
  el.siPassword.autocomplete = isSignup ? 'new-password' : 'current-password';
  if (el.authToggleText) el.authToggleText.textContent = isSignup ? 'Already have an account?' : 'Need access?';
  if (el.btnAuthToggle) el.btnAuthToggle.textContent = isSignup ? 'Sign in' : 'Sign up';
  el.msgSignin.textContent = '';
  el.msgSignin.classList.remove('is-ok');
}

el.btnAuthToggle?.addEventListener('click', () => setAuthMode(authMode === 'signup' ? 'signin' : 'signup'));

function resetAuthForms() {
  el.siEmail.value = '';
  el.siPassword.value = '';
  setAuthMode('signin');
}

function showScreen(screen) {
  ['screenAuth','screenApp','screenOnboard','screenPending'].forEach(id => {
    const el2 = $(id);
    if (el2) { el2.setAttribute('hidden',''); el2.style.display = ''; }
  });
  const target = $(
    screen === 'auth'    ? 'screenAuth'    :
    screen === 'onboard' ? 'screenOnboard' :
    screen === 'pending' ? 'screenPending' :
    'screenApp'
  );
  if (target) { target.removeAttribute('hidden'); }
  if (screen === 'auth') refreshBiometricLoginUI();
}

/* ═══════════════════════════════════════════════════════════
   BIOMETRIC (FACE ID / TOUCH ID) LOGIN
   Native-only, via @capgo/capacitor-native-biometric — same
   no-bundler pattern as the HealthKit integration above: called
   through window.Capacitor.Plugins.NativeBiometric, no import.

   Credentials are stored in iOS Keychain (the plugin's own job, not
   this app's), gated behind a biometric prompt on read — this app
   never sees them except right after the user just typed them in, and
   what actually decides whether a login succeeds is still
   signInWithPassword() hitting Supabase's Auth API server-side.
   Biometric auth here is a local convenience gate on retyping a
   password, not a replacement for real server-side authentication.
═══════════════════════════════════════════════════════════ */
const BIOMETRIC_SERVER = 'fitl00p.app'; // stable namespace key for stored credentials, not a real domain

function getBiometricPlugin() {
  const Bio = window.Capacitor?.Plugins?.NativeBiometric;
  if (!Bio) throw new Error('Biometric auth is not available on this platform');
  return Bio;
}

// Shows/hides the auth screen's "Log in with Face ID" button — only
// when biometrics are actually available on this device AND credentials
// were already saved (from a previous successful manual login; see the
// save-credentials offer in the sign-in submit handler below).
async function refreshBiometricLoginUI() {
  const btn = $('btnBiometricLogin');
  const divider = $('biometricLoginDivider');
  if (!btn) return;
  const hide = () => { btn.hidden = true; if (divider) divider.hidden = true; };
  if (!window.Capacitor?.isNativePlatform?.()) return hide();
  try {
    const Bio = getBiometricPlugin();
    const avail = await Bio.isAvailable();
    if (!avail.isAvailable) return hide();
    const saved = await Bio.isCredentialsSaved({ server: BIOMETRIC_SERVER });
    btn.hidden = !saved.isSaved;
    if (divider) divider.hidden = !saved.isSaved;
  } catch (err) {
    console.error('Biometric availability check failed:', err.message || err);
    hide();
  }
}

// Dismisses the boot overlay (see index.html) — separate from showScreen()
// above on purpose: for the main app case this is called only once the
// target view's own data has actually finished loading (navigateTo awaits
// its loader), not merely once the shell is visible, so the overlay
// bridges the whole gap instead of uncovering an empty dashboard. For the
// auth/onboard/pending screens, which don't need to wait on data, it's
// called right alongside showScreen().
function hideBootScreen() {
  if (el.screenBoot) el.screenBoot.hidden = true;
  markBootResolved();
}

// Set by the boot watchdog IIFE near the end of this file — declared as
// a plain `let`/function pair up front like this so hideBootScreen()
// above (called throughout the auth-state-change handler, which runs
// long before the watchdog's own declarations further down execute) can
// still reach them: by the time any of these functions actually GET
// CALLED, the whole script has finished its top-to-bottom pass and
// every top-level binding is initialized, regardless of where in the
// file they're each declared.
function markBootResolved() {
  bootResolved = true;
  clearTimeout(bootWatchdog);
}

// Auth state — module-scoped so it survives across the auth callback lifecycle
let authHandling  = false;
let authCompleted = false;

// Resolved the moment the Supabase client's own first auth event
// (SIGNED_IN/INITIAL_SESSION/SIGNED_OUT) arrives — see the boot IIFE
// near the bottom of this file for why something needs to race against
// this rather than just waiting on it directly.
let resolveFirstAuthEvent;
const firstAuthEventPromise = new Promise(resolve => { resolveFirstAuthEvent = resolve; });

// Reads supabase-js's own persisted session straight out of localStorage
// under its default key pattern (sb-<project-ref>-auth-token), scanning
// for the key rather than building it from SUPABASE_URL so this has no
// ordering dependency on anything else at boot. Used only as a
// same-boot fallback if the real client's first auth event doesn't show
// up promptly — see the boot IIFE.
function readRawCachedSession() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (!/^sb-.+-auth-token$/.test(key)) continue;
      const parsed = JSON.parse(localStorage.getItem(key));
      if (parsed?.user?.id && parsed?.access_token && parsed?.refresh_token) return parsed;
    }
  } catch {}
  return null;
}

function initApp() {
  // Sign in
  el.formSignin.addEventListener('submit', async e => {
    e.preventDefault();
    // Auth itself typically resolves in well under a second, but the
    // profile load that follows (inside onAuthStateChange) can take up
    // to ~45s across its retries on a slow connection. If we reset the
    // button here as soon as auth resolves, it flips back to "Sign in"
    // long before the screen actually transitions — looking like nothing
    // happened — which invites repeated taps that just fire duplicate
    // password grants (seen in practice: 10 successful /token requests
    // in 15s from a single login). So the button stays locked through
    // the whole flow; onAuthStateChange resets it on failure, and success
    // navigates away from this screen entirely.
    if (authHandling) return;

    const email    = el.siEmail.value.trim();
    const password = el.siPassword.value;
    el.msgSignin.textContent = '';
    el.msgSignin.classList.remove('is-ok');

    if (authMode === 'signup') {
      setBtn(el.btnSignin, true, 'Sign up', 'Requesting…');
      const { data, error } = await db.auth.signUp({ email, password });
      if (error) {
        setBtn(el.btnSignin, false, 'Sign up');
        el.msgSignin.textContent = error.message;
        return;
      }
      if (!data.session) {
        // Email confirmation required before Supabase issues a session —
        // onAuthStateChange (and the pending-approval flow) only take over
        // once they actually sign in after confirming.
        setBtn(el.btnSignin, false, 'Sign up');
        el.msgSignin.textContent = 'Check your email to confirm your account, then sign in.';
        el.msgSignin.classList.add('is-ok');
        setAuthMode('signin');
        return;
      }
      // Session issued immediately — onAuthStateChange takes it from here
      // (new profile via the handle_new_user trigger, role defaults to
      // 'pending', landing it on the existing pending-approval screen).
      return;
    }

    setBtn(el.btnSignin, true, 'Unlock', 'Unlocking…');
    const { error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      authTrace('password sign-in failed: ' + error.message);
      setBtn(el.btnSignin, false, 'Unlock');
      el.msgSignin.textContent = error.message;
      return;
    }

    // Offer biometric login for next time — best-effort, never blocks
    // the actual sign-in. Only asks when biometrics are available AND
    // nothing's already saved (re-asking every login would be annoying;
    // a stale mismatch after a password change gets cleared and can be
    // re-saved automatically by the biometric login path itself, below).
    if (window.Capacitor?.isNativePlatform?.()) {
      try {
        const Bio = getBiometricPlugin();
        const avail = await Bio.isAvailable();
        if (avail.isAvailable) {
          const saved = await Bio.isCredentialsSaved({ server: BIOMETRIC_SERVER });
          if (!saved.isSaved && confirm("Enable Face ID / Touch ID so you don't need to retype your password next time?")) {
            await Bio.setCredentials({ username: email, password, server: BIOMETRIC_SERVER });
          }
        }
      } catch (err) {
        console.error('Biometric enrollment offer failed (non-fatal):', err.message || err);
      }
    }

    // Login succeeded. onAuthStateChange fires SIGNED_IN and handles the
    // screen transition (and button reset on failure) via its own logic.
  });

  // Log in with Face ID / Touch ID — only ever visible (see
  // refreshBiometricLoginUI) when biometrics are available and
  // credentials were already saved from a previous manual login.
  el.btnBiometricLogin?.addEventListener('click', async () => {
    const btn = el.btnBiometricLogin;
    setBtn(btn, true, '🔓 Log in with Face ID', 'Verifying…');
    try {
      const Bio = getBiometricPlugin();
      await Bio.verifyIdentity({ reason: 'Log in to fitl00p', title: 'Log in' });
      const { username, password } = await Bio.getCredentials({ server: BIOMETRIC_SERVER });
      const { error } = await db.auth.signInWithPassword({ email: username, password });
      if (error) {
        authTrace('Face ID sign-in rejected, saved credentials cleared: ' + error.message);
        // Stored credentials are stale (password changed elsewhere) —
        // clear them so this doesn't keep silently failing, and fall
        // back to the manual form with the real error visible.
        await Bio.deleteCredentials({ server: BIOMETRIC_SERVER }).catch(() => {});
        el.msgSignin.textContent = error.message;
        refreshBiometricLoginUI();
      }
      // Success: onAuthStateChange fires SIGNED_IN and handles the
      // screen transition, same as the manual-password path above.
    } catch (err) {
      // Face ID cancelled/failed, or a real device error — not a login
      // failure, just quietly fall back to the manual form below.
      authTrace('Face ID login failed: ' + (err.message || err));
      console.error('Biometric login failed:', err.message || err);
    }
    setBtn(btn, false, '🔓 Log in with Face ID');
  });

  // Forgot password
  el.btnForgot.addEventListener('click', async () => {
    const email = el.siEmail.value.trim();
    if (!email) { el.msgSignin.textContent = 'Enter your email above first.'; return; }
    const { error } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin,
    });
    el.msgSignin.textContent = error ? error.message : 'Password reset email sent.';
    el.msgSignin.classList.toggle('is-ok', !error);
  });

  // Sign out — call Supabase signOut then reload for clean state.
  // Shared by both the Settings-page button and the new header icon (and
  // the session-broken banner's "Sign in again" button — see below).
  //
  // Two defensive layers, because the whole point of this function is to
  // get someone UNSTUCK, including from exactly the broken-session state
  // that motivated the session-broken banner in the first place:
  //   1. signOut() calls the Auth API to revoke the token server-side —
  //      an ordinary network call with no built-in timeout. From inside
  //      an already-broken session this can hang indefinitely (seen in
  //      practice), and since await never resolves OR rejects on a hang,
  //      .catch() alone doesn't help — the redirect below would just
  //      never run. Bounded with a timeout so it always moves on.
  //   2. Even if that network call fails outright rather than hanging,
  //      still directly clear the local session token — what actually
  //      determines "am I signed in" on next load is this local storage
  //      key, not whether the server-side revoke succeeded.
  async function handleSignOut() {
    disableHealthBackgroundDelivery(); // stop uploads for a signed-out user
    authTrace('manual sign-out');
    try {
      await Promise.race([
        db.auth.signOut(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('signOut timed out')), 5000)),
      ]);
    } catch (err) {
      authTrace('manual sign-out call failed: ' + (err?.message || err));
      console.error('Sign out call failed or timed out — clearing session locally anyway:', err?.message || err);
    }
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith('sb-') && k.endsWith('-auth-token'))
        .forEach(k => localStorage.removeItem(k));
    } catch {}
    window.location.href = window.location.origin + window.location.pathname;
  }

  el.btnSignout.addEventListener('click', handleSignOut);
  el.btnSignoutHeader?.addEventListener('click', handleSignOut);
  $('btnForgetBiometric')?.addEventListener('click', async () => {
    if (!confirm("Forget your saved Face ID login? You'll need to type your password next time.")) return;
    try {
      await getBiometricPlugin().deleteCredentials({ server: BIOMETRIC_SERVER });
      $('btnForgetBiometric').hidden = true;
      showToast('Face ID login forgotten.');
    } catch (err) {
      showToast('Error: ' + (err.message || err), true);
    }
  });
  el.btnOpenSettingsHeader?.addEventListener('click', () => navigateTo('settings'));
  // Clears the service worker + its caches, then reloads — the session
  // token lives in localStorage, untouched by this, so it fixes the same
  // "everything's blank/stale" state handleSignOut does without forcing
  // a re-login, but also catches the case a plain reload can't: a stale
  // or stuck service worker still serving/intercepting old requests
  // underneath. Same window.__fitl00pHardReset used by the boot-time
  // connectivity-error screens (see the async IIFE below) — no reason
  // this everyday "something looks wrong, refresh" button should settle
  // for a weaker fix than the one already built for boot failures.
  el.btnReloadHeader?.addEventListener('click', () => {
    el.btnReloadHeader.classList.add('is-loading');
    window.__fitl00pHardReset();
  });
  // "Reload" is the primary action — same non-destructive cache-clear-
  // and-reload as the header's reload button, which fixes the exact
  // stale/stuck-service-worker cause this banner's own detection can't
  // tell apart from a genuinely dead session (see looksLikeBrokenSession
  // below). "Sign in again" stays available as a secondary, explicit
  // last resort — it wasn't safe to make it the ONLY option, since a
  // false-positive here used to mean every stale-load hiccup forced a
  // real password login.
  el.btnReloadSession?.addEventListener('click', () => {
    el.btnReloadSession.disabled = true;
    window.__fitl00pHardReset();
  });
  el.btnFixSession?.addEventListener('click', handleSignOut);
  el.btnDismissSessionBanner?.addEventListener('click', () => {
    if (el.sessionBrokenBanner) el.sessionBrokenBanner.hidden = true;
  });

  // Auth state — single source of truth (declared at module scope above).
  // Wrapped rather than passed directly so the boot IIFE's own fallback
  // call (see readRawCachedSession() above) can invoke the exact same
  // logic, and so anything waiting on firstAuthEventPromise finds out the
  // real client actually produced an event, whichever one it is.
  db.auth.onAuthStateChange((event, session) => {
    resolveFirstAuthEvent?.();
    resolveFirstAuthEvent = null;
    handleAuthStateChange(event, session);
  });
}

async function handleAuthStateChange(event, session) {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {

      // If we already got into the app this session — via a real event or
      // the boot-timeout fallback below — treat any further event as a
      // quiet background refresh, not a full re-render. Covers both a
      // real SIGNED_IN token refresh and a real event arriving late right
      // after the fallback already rendered the app from cache.
      if (authCompleted) {
        currentUser = session.user;
        return;
      }

      // Prevent double-fire (SIGNED_IN + INITIAL_SESSION both fire on fresh login).
      // The loadProfile step below is wrapped in try/finally specifically so a
      // thrown/rejected network call here can never leave authHandling stuck
      // true — which would otherwise silently block every future login attempt
      // on this page load, even ones Supabase itself accepts.
      //
      // try/finally alone isn't enough, though: it only protects against a
      // call that eventually rejects. A call that never settles at all (a
      // hung fetch — seen in practice, e.g. right after the automatic
      // session-resume at launch) leaves the await pending forever, so
      // finally never runs either, and authHandling stays stuck true —
      // silently swallowing every future sign-in with no error shown
      // anywhere. loadProfileWithTimeout bounds every attempt so a hang
      // becomes a normal, loggable failure instead of a permanent wedge.
      if (authHandling) return;
      authHandling = true;

      currentUser = session.user;
      flushAuthTrace();

      // Outer safety net: whatever happens below — a thrown error in
      // applyTheme, an unhandled rejection anywhere in the role-branch
      // logic — hideBootScreen() must still fire at the end, or the new
      // full-screen boot overlay would stay stuck covering the app
      // forever. Every branch below already calls it at its own precise
      // moment (right when it's actually safe to reveal what's
      // underneath); this is purely a redundant last-resort call for
      // whatever those miss. hideBootScreen() is idempotent, so calling
      // it twice is harmless.
      try {

      try {
        // Returning device: render from the last-known-good profile
        // instantly and refresh it quietly in the background — never
        // block getting into the app on a network call that's already
        // proven unreliable on this connection. Only a brand-new device
        // (nothing cached yet) has to actually wait on the network.
        const cached = readCachedProfile(session.user.id);
        if (cached) {
          profile = cached.profile;
          activePlan = cached.activePlan;
          // Best-effort refresh, not awaited — but re-apply anything that
          // depends on profile fields once it lands, since the stale cache
          // rendered first (see applyDiabetesTabVisibility).
          loadProfileWithTimeout().then(() => applyDiabetesTabVisibility()).catch(() => {});
        } else {
          if (el.msgSignin) el.msgSignin.textContent = 'Connecting…';
          // A brand-new device has nothing cached to fall back on, so this
          // one has to actually wait — but a single stalled attempt (same
          // cold-launch/service-worker conditions as the config fetch
          // above) shouldn't immediately dump the user onto a manual-retry
          // screen. One extra attempt, still entirely behind the boot
          // spinner, catches the common case where the network was simply
          // slow to wake up rather than genuinely unreachable.
          const PROFILE_LOAD_ATTEMPTS = 2; // each attempt already self-bounds to 15s
          for (let i = 0; i < PROFILE_LOAD_ATTEMPTS && !profile; i++) {
            await loadProfileWithTimeout();
            if (!profile && i < PROFILE_LOAD_ATTEMPTS - 1) {
              await new Promise(r => setTimeout(r, 1500));
            }
          }
        }
      } finally {
        authHandling = false;
      }

      const theme = profile?.theme || localStorage.getItem(THEME_KEY) || 'nebula';
      applyTheme(theme, false); // apply visually only — don't write to DB during login

      if (!profile) {
        console.error('Profile failed to load — session valid, showing retry');
        showScreen('auth');
        hideBootScreen();
        setBtn(el.btnSignin, false, 'Unlock');
        if (el.msgSignin) {
          el.msgSignin.textContent = 'Could not connect. Check your connection and tap "Unlock" to try again.';
          el.msgSignin.classList.remove('is-ok');
        }
        return;
      }

      authCompleted = true;
      if (el.appbarUser) el.appbarUser.textContent = profile.display_name || session.user.email.split('@')[0];
      const role = profile.role || 'pending';

      try {
        if (role === 'admin' || role === 'approved') {
          if (!profile.onboarding_complete) {
            showScreen('onboard');
            hideBootScreen();
            initOnboarding();
          } else {
            // Deliberately NOT hiding the boot overlay here — showScreen
            // reveals the (still data-less) shell underneath it, and the
            // overlay stays up on top until the awaited navigateTo below
            // has actually populated the target view, so nothing empty is
            // ever visible even for a moment.
            showScreen('app');
            const adminSec = $('adminSection');
            if (adminSec) adminSec.hidden = role !== 'admin';

            const uiState = loadUIState();
            const targetTab = uiState?.tab || 'dashboard';

            const hadActiveWorkout = restoreWorkoutState();
            if (hadActiveWorkout) {
              await navigateTo('workout');
              renderActiveWorkout();
              elW.picker.hidden = true;
              elW.active.hidden = false;
            } else {
              await navigateTo(targetTab);
            }
            hideBootScreen();

            requestNotificationPermission();
            checkDetectedActivities();
            if (profile?.healthkit_sync_enabled) {
              runHealthKitSync({ days: 7 }).catch(err => console.error('HealthKit sync failed:', err.message));
            }
            updateOfflineSyncBanner();
            flushOfflineQueue();
          }
        } else if (role === 'rejected') {
          showScreen('pending');
          hideBootScreen();
          $('pendingState').hidden  = true;
          $('rejectedState').hidden = false;
        } else {
          await createApprovalRequest();
          showScreen('pending');
          hideBootScreen();
          $('pendingState').hidden  = false;
          $('rejectedState').hidden = true;
        }
      } catch (appLoadErr) {
        console.error('App load error after login:', appLoadErr?.message || appLoadErr);
        try {
          showScreen('app');
          const adminSec = $('adminSection');
          if (adminSec) adminSec.hidden = (profile?.role || '') !== 'admin';
          await navigateTo('dashboard');
          hideBootScreen();
        } catch (fallbackErr) {
          console.error('Fallback also failed:', fallbackErr?.message || fallbackErr);
          // Last resort — just show the app screen
          showScreen('app');
          hideBootScreen();
        }
      }

      } finally {
        hideBootScreen();
      }

    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      authTrace(`${event} — currentUser was ${currentUser ? 'set' : 'unset'}`);
      authHandling  = false;
      authCompleted = false;
      currentUser   = null;
      profile       = null;
      activePlan    = null;
      todayLog      = null;
      clearWorkoutState(); // clear any saved workout on explicit sign out
      stopDxAutoRefresh();
      closeDxSimpleMode();
      resetAuthForms();
      showScreen('auth');
      hideBootScreen();
    }
}
const UI_STATE_KEY = 'fitl00p:ui_state';

function saveUIState(tab) {
  try {
    const state = {
      tab,
      workoutSubState: activeExercises.length > 0 ? 'active' : null,
    };
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(state));
  } catch {}
}

function loadUIState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Diabetes no longer has its own tab/view — its whole section (el.viewDiabetes)
// now lives nested inside viewDashboard's DOM (see index.html) and is shown
// or hidden as a unit by applyDiabetesTabVisibility() below, independent of
// which top-level view is active. It's deliberately NOT listed here, so the
// "hide every view" sweep at the top of navigateTo() never touches it.
const views = {
  dashboard:    el.viewDashboard,
  workout:      el.viewWorkout,
  history:      el.viewHistory,
  settings:     el.viewSettings,
  workoutAdmin: el.viewWorkoutAdmin,
  logFood:      el.viewLogFood,
};

const viewLoaders = {
  dashboard:    loadDashboard,
  workout:      loadWorkout,
  history:      loadHistory,
  settings:     loadSettings,
  workoutAdmin: loadWorkoutAdminData,
  logFood:      loadLogFood,
};

// Shows/hides the whole nested Diabetes section on the dashboard whenever
// profile.diabetes_enabled is explicitly false — off by default only ever
// means "never asked" (NOT NULL column defaulting true), so nobody currently
// using it loses access silently. Gemma's profile has this off, so her
// dashboard never renders the diabetes section (or the Workout tab's
// glucose-impact card) at all.
function applyDiabetesTabVisibility() {
  const enabled = profile?.diabetes_enabled !== false;
  if (el.viewDiabetes) el.viewDiabetes.hidden = !enabled;
  if (el.dxWorkoutImpactCard) el.dxWorkoutImpactCard.hidden = !enabled;
}

async function navigateTo(name) {
  // Diabetes is no longer its own destination — it's a section nested
  // inside the dashboard now (see applyDiabetesTabVisibility). Any old
  // caller still asking for it just lands on the dashboard instead.
  if (name === 'diabetes') name = 'dashboard';
  // Live auto-refresh and Simple view only make sense while the dashboard
  // (which the diabetes section now lives inside) is actually on screen —
  // leaving it stops the poll and force-closes the overlay so it can never
  // linger on top of whichever tab is opened next.
  if (name !== 'dashboard') {
    stopDxAutoRefresh();
    closeDxSimpleMode();
  }
  // Re-checked on every navigation, not just at login — profile can change
  // underneath an already-open session (e.g. the background refresh below
  // for a returning device with a stale cached profile, or a settings save).
  applyDiabetesTabVisibility();
  // Hide all views including the admin screen
  Object.values(views).forEach(v => { if (v) v.hidden = true; });
  // Only update tab bar for main tabs — admin screen has no tab
  const mainTabs = ['dashboard','workout','history','settings'];
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('tab-btn--active', b.dataset.view === name);
  });
  // Show tab bar only on main views, hide on admin screen
  const tabBar = $('tabBar');
  if (tabBar) tabBar.hidden = !mainTabs.includes(name);
  const v = views[name];
  if (v) v.hidden = false;
  if (viewLoaders[name]) {
    try {
      await viewLoaders[name]();
    } catch (loaderErr) {
      console.error(`Loader error for view "${name}":`, loaderErr?.message || loaderErr);
    }
  }
  // The diabetes section is nested inside the dashboard's DOM (not a
  // separate view), so it needs its own load call alongside loadDashboard()
  // above rather than going through viewLoaders. applyDiabetesTabVisibility()
  // already hid it entirely for Gemma (diabetes_enabled === false).
  if (name === 'dashboard' && profile?.diabetes_enabled !== false) {
    try {
      await loadDiabetes();
    } catch (loaderErr) {
      console.error('Loader error for diabetes section:', loaderErr?.message || loaderErr);
    }
  }
  saveUIState(name);
}

el.tabBar.addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (btn) navigateTo(btn.dataset.view);
});
// Last sync button — navigate to Apple Health settings
el.dLogTodayBtn?.addEventListener('click', () => {
  navigateTo('settings');
  setTimeout(() => {
    const healthSection = document.querySelector('[data-section="apple-health"]') ||
                          document.querySelector('.settings-section__title');
    healthSection?.scrollIntoView({ behavior: 'smooth' });
  }, 150);
});

/* ═══════════════════════════════════════════════════════════
   PROFILE
═══════════════════════════════════════════════════════════ */
// Local cache of the last-successfully-loaded profile/plan, keyed by user
// id. The whole point: this app effectively has one user, on one phone,
// signing in over and over on the same network — there's no reason a
// slow or dropped request to /rest/v1/profiles should ever be able to
// block getting back into the app. First login on a device still needs
// the network; every login after that reads instantly from here while
// a fresh copy is fetched quietly in the background.
const PROFILE_CACHE_KEY = 'fitl00p:profileCache';

function readCachedProfile(userId) {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    return cache && cache.userId === userId ? cache : null;
  } catch {
    return null;
  }
}

function writeCachedProfile(userId, profileData, planData) {
  try {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify({
      userId, profile: profileData, activePlan: planData,
    }));
  } catch {
    // localStorage full/unavailable — cache is a convenience, not required
  }
}

async function loadProfile(signal) {
  if (!currentUser) return false;
  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .abortSignal(signal)
    .single();

  if (error) {
    console.error('Profile load error:', error.message, error.code);
    return false;
  }
  profile = data;

  // Also load active weight plan
  const { data: plan } = await db
    .from('weight_plans')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .abortSignal(signal)
    .maybeSingle();

  activePlan = plan;
  writeCachedProfile(currentUser.id, profile, activePlan);
  return true;
}

// Bounds loadProfile so a slow-or-hung network call can be retried
// instead of wedging the login flow forever (see the authHandling
// comment in the auth-state-change handler for what that looks like
// without this) — but genuinely aborts the underlying request when the
// timer fires (via AbortController, not just walking away from it),
// rather than leaving it to keep consuming bandwidth in the background
// on an already-slow connection while a fresh retry piles on top of it.
//
// 15s, not 8s: seen in practice on a slow connection, a response that
// eventually succeeds can take close to 8s to come back — an 8s bound
// was killing genuinely-in-progress requests right before they would
// have completed on their own, right when a slow network needs patience
// most, not less of it.
const LOAD_PROFILE_TIMEOUT_MS = 15000;

async function loadProfileWithTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_PROFILE_TIMEOUT_MS);
  try {
    return await loadProfile(controller.signal);
  } catch (err) {
    const timedOut = err?.name === 'AbortError' || /abort/i.test(err?.message || '');
    console.error(
      timedOut
        ? `loadProfile timed out after ${LOAD_PROFILE_TIMEOUT_MS}ms — aborted`
        : `loadProfile attempt failed: ${err?.message || err}`
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════════ */
async function loadDashboard() {
  if (!currentUser) return;
  try {
    await loadDashboardWithTimeout();
  } catch (err) {
    console.error('Dashboard load error:', err);
    // Don't boot the user — just show a quiet error state
    if (el.dLastWorkout) el.dLastWorkout.innerHTML = '<p class="empty-state">Dashboard error — pull to refresh.</p>';
  }
}

// Bounds _loadDashboardInner the same way loadProfileWithTimeout bounds
// loadProfile (see there for the full rationale) — this is the dashboard
// tab's own data load, fired from inside navigateTo() right after login
// (dashboard is the default landing tab). Its ~10 parallel queries below
// had no timeout of their own: a single one stuck on a bad connection
// right after login left navigateTo()'s await pending forever, which
// left the boot spinner up with nothing to resolve it except the 90s
// absolute watchdog — a hang that looks like the app is dead, not
// loading, and repeats identically on every relaunch attempt.
const LOAD_DASHBOARD_TIMEOUT_MS = 20000;

async function loadDashboardWithTimeout() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_DASHBOARD_TIMEOUT_MS);
  try {
    await _loadDashboardInner(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function _loadDashboardInner(signal) {
  const unit = BODY_WEIGHT_UNIT;

  // Only visibly rendered under the Nebula theme (see .dash-hero__head in
  // app.css) — harmless to always set.
  if (el.dHeroDate) {
    el.dHeroDate.textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── Fetch all data in parallel ────────────────────────────
  const [logRes, healthRes, healthHistRes, logsRes, lastSessionRes, lastSyncRes, mfpCalRes, todayWorkoutsRes, foodLogRes, recentAppleWorkoutsRes, coachRes] = await Promise.all([
    db.from('daily_logs')
      .select('*, cal_apple')
      .eq('user_id', currentUser.id)
      .eq('log_date', todayISO())
      .abortSignal(signal)
      .maybeSingle(),

    // Fetch last 2 days of health data — overnight metrics (VO2, HRV, sleep)
    // come from the previous night's sync, not today's row
    db.from('health_daily')
      .select('readiness_score, sleep_total_hrs, sleep_deep_hrs, sleep_rem_hrs, sleep_start, hrv_ms, resting_hr, active_energy_kcal, resting_energy_kcal, dietary_energy_kcal, spo2_avg, spo2_min, respiratory_rate, wrist_temp_dev, hr_recovery_bpm, vo2_max, heart_rate_avg, distance_km, glucose_avg_mmol, weight_kg, steps, exercise_mins, workout_hr_avg, breathing_disturbances_elevated, log_date')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: false })
      .limit(2)
      .abortSignal(signal),

    db.from('health_daily')
      .select('log_date, spo2_avg, respiratory_rate, wrist_temp_dev, hr_recovery_bpm, vo2_max, heart_rate_avg, glucose_avg_mmol, hrv_ms, resting_hr, active_energy_kcal, resting_energy_kcal, dietary_energy_kcal, weight_kg, sleep_total_hrs, sleep_deep_hrs, sleep_rem_hrs, sleep_start, exercise_mins, workout_hr_avg, steps')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: true })
      .abortSignal(signal),

    db.from('daily_logs')
      .select('log_date, weight')
      .eq('user_id', currentUser.id)
      .not('weight', 'is', null)
      .gte('log_date', new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: true })
      .abortSignal(signal),

    db.from('workout_sessions')
      .select('id, session_date, split_type, started_at')
      .eq('user_id', currentUser.id)
      .order('session_date', { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle(),

    db.from('health_daily')
      .select('synced_at')
      .eq('user_id', currentUser.id)
      .order('synced_at', { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle(),

    // MFP diary totals for the same 30-day window as healthHistRes, merged
    // in below so the weekly deficit trend prefers them the same way
    // pickConsumedCalories does for "today".
    db.from('daily_logs')
      .select('log_date, cal_mfp')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
      .abortSignal(signal),

    // Today's real per-workout heart-rate data (Watch-synced) for the
    // TRIMP-based Strain calc below — health_daily only has a same-day
    // AVERAGE workout HR, not the per-session duration needed to compute
    // cardiovascular load properly.
    db.from('apple_health_workouts')
      .select('workout_type, started_at, ended_at, avg_heart_rate, active_energy_kcal')
      .eq('user_id', currentUser.id)
      .gte('started_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString())
      .order('started_at', { ascending: true })
      .abortSignal(signal),

    // Native fitl00p food log — top of pickConsumedCalories' precedence
    // (see there), same 30-day window as healthHistRes/mfpCalRes above so
    // the 7-day deficit trend (and est. fat change) below can actually
    // find a native-logged day's calories instead of falling through to
    // cal_mfp (empty, once MFP syncing stops) and reading as no data at
    // all — same bug already fixed for the History tab's Consumed column
    // (see loadHistory), just a separate query here that had the same
    // today-only leftover from when native logging had just started.
    db.from('food_log')
      .select('log_date, calories_kcal')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
      .abortSignal(signal),

    // Recent Watch-synced workouts (any day, not just today — unlike
    // todayWorkoutsRes above) so the "Last workout" card can pair
    // fitl00p's own logged strength session with the calories/heart-rate
    // Apple Health actually recorded for it. See matchAppleWorkout below.
    db.from('apple_health_workouts')
      .select('workout_type, started_at, ended_at, avg_heart_rate, max_heart_rate, active_energy_kcal, total_energy_kcal, distance_km')
      .eq('user_id', currentUser.id)
      .order('started_at', { ascending: false })
      .limit(15)
      .abortSignal(signal),

    // Latest AI coach briefing (see notify-ai-coach.js) — independent of
    // everything else fetched here, just batched into the same round trip.
    db.from('ai_coach_briefings')
      .select('briefing_date, content')
      .eq('user_id', currentUser.id)
      .order('briefing_date', { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle(),
  ]);

  renderCoachBriefing(coachRes.data);

  // Daily checklist — Gemma's account only. Not batched into the
  // Promise.all above since it needs currentUser.id to decide whether
  // to fetch anything at all, and only ever applies to one account.
  if (el.checklistCard) {
    if (currentUser.id === GEMMA_USER_ID) {
      await fetchChecklistRows();
      renderChecklist();
    } else {
      el.checklistCard.hidden = true;
    }
  }


  const log           = { ...(logRes.data || {}) };
  const rawHealthRows = healthRes.data || [];
  const todayHealth   = rawHealthRows.find(r => r.log_date === todayISO()) || {};
  const yestHealth    = rawHealthRows.find(r => r.log_date !== todayISO()) || {};

  // Merge: prefer today's value, fall back to yesterday for overnight metrics
  // that only update once per day from the previous night's sleep/HRV scan
  const health = {
    ...yestHealth,
    ...Object.fromEntries(
      Object.entries(todayHealth).filter(([, v]) => v != null && v !== 0)
    ),
    // Cumulative daily metrics come from TODAY ONLY. No yesterday fallback —
    // otherwise at 9am with nothing logged, yesterday's full totals show as today's.
    active_energy_kcal:   todayHealth.active_energy_kcal   ?? null,
    resting_energy_kcal:  todayHealth.resting_energy_kcal  ?? null,
    dietary_energy_kcal:  todayHealth.dietary_energy_kcal  ?? null,
    steps:                todayHealth.steps                ?? null,
    distance_km:          todayHealth.distance_km          ?? null,
    weight_kg:            todayHealth.weight_kg            ?? null,
    log_date:             todayHealth.log_date             || yestHealth.log_date,
  };

  // Total burn = active energy + resting energy (true full-day expenditure)
  // If resting not available yet, fall back to active only. Number()
  // first — active_energy_kcal/resting_energy_kcal are Postgres numeric
  // columns, which can arrive as strings rather than JS numbers; plain
  // `a + r` on two such strings concatenates instead of adding (see the
  // same fix in loadHistory's Burned column).
  const totalBurn = (health, log, bmrFallback) => {
    const aRaw = health?.active_energy_kcal ?? log?.active_energy_kcal;
    const rRaw = health?.resting_energy_kcal ?? bmrFallback;
    const a = aRaw != null ? Number(aRaw) : null;
    const r = rRaw != null ? Number(rRaw) : null;
    if (a != null && r != null) return Math.round(a + r);
    if (a != null) return Math.round(a);
    if (r != null) return Math.round(r);
    return null;
  };

  const mfpCalByDate = Object.fromEntries(
    (mfpCalRes.data || []).filter(r => r.cal_mfp != null).map(r => [r.log_date, Number(r.cal_mfp)])
  );
  // food_log has one row per item logged — sum per day, and only set a
  // date's total when at least one row exists that day (an empty/zero
  // day should fall through to cal_mfp/dietary_energy_kcal, not read as
  // "0 eaten"). Query above already restricts to today onward.
  const foodCalByDate = {};
  (foodLogRes.data || []).forEach(r => {
    foodCalByDate[r.log_date] = (foodCalByDate[r.log_date] || 0) + (Number(r.calories_kcal) || 0);
  });
  const healthHistory = (healthHistRes.data || []).map(h => ({
    ...h,
    cal_mfp:     mfpCalByDate[h.log_date]  ?? null,
    cal_fitl00p: foodCalByDate[h.log_date] ?? null,
  }));
  log.cal_fitl00p = foodCalByDate[todayISO()] ?? null;
  const logs          = logsRes.data || [];
  const lastSession   = lastSessionRes.data;
  const lastSync      = lastSyncRes.data;
  const todayWorkouts = todayWorkoutsRes.data || [];
  const recentAppleWorkouts = recentAppleWorkoutsRes.data || [];
  const lastSessionAppleWorkout = matchAppleWorkout(lastSession, recentAppleWorkouts);
  // Already sorted started_at desc from the query — first strength-type
  // hit is the most recent one.
  const latestStrengthAppleWorkout = recentAppleWorkouts.find(w => isStrengthWorkoutType(w.workout_type)) || null;

  // Broken-session detection: a stale/invalid local Supabase session can
  // return HTTP 200 with silently-empty results — Postgres RLS just
  // filters every row out when auth.uid() doesn't match, it doesn't
  // error — which looks identical to "brand new user, no data yet" from
  // here. The tell is a cached profile from a previous good session: if
  // it shows an active weight plan (proof this user has used the app
  // before) but the live 120-day logs AND 30-day health history both
  // come back completely empty, that's not a new user, it's a broken
  // session. Checked fresh on every load (not just once) so the banner
  // clears itself as soon as a real reload brings real data back.
  //
  // Both queries must have actually SUCCEEDED for "empty" to mean
  // anything here — logsRes.data/healthHistRes.data were being read as
  // `.data || []` with no error check, so a plain network error on
  // either one (not a real RLS-denial "confirmed empty", just a fetch
  // that failed) looked identical to a broken session and triggered the
  // same alarming banner. That's a transient hiccup, not proof of
  // anything — don't flag it.
  const cachedForSessionCheck = readCachedProfile(currentUser.id);
  const looksLikeBrokenSession = !!cachedForSessionCheck?.activePlan
    && !logsRes.error && !healthHistRes.error
    && logs.length === 0 && healthHistory.length === 0;
  if (el.sessionBrokenBanner) el.sessionBrokenBanner.hidden = !looksLikeBrokenSession;

  todayLog = log;

  // ── Today metrics ─────────────────────────────────────────
  // Weight: today's log → health_daily today → most recent reading from
  // EITHER source (health_daily's 30-day history or daily_logs' 90-day
  // manual-entry history, whichever is more recent by date). Checking
  // only health_daily here used to leave a manual-weight-logging account
  // (no Apple Health weight sync at all, so health_daily.weight_kg is
  // always null for them) with no fallback beyond today's own entry —
  // this tile would show "—" any day they hadn't logged yet, or worse,
  // silently miss a real recent entry that only exists in daily_logs.
  // renderPlanCard's current-weight figure already falls back through
  // `logs` (daily_logs) correctly; this mirrors that so the two numbers
  // on the same dashboard can't disagree.
  const latestHistWeight = healthHistory
    .filter(h => h.weight_kg != null)
    .sort((a, b) => (a.log_date < b.log_date ? 1 : -1))[0] || null;
  const latestLogsWeight = logs.length ? logs[logs.length - 1] : null; // already non-null-weight-only, ascending
  let fallbackWeightKg = null;
  if (latestHistWeight && latestLogsWeight) {
    fallbackWeightKg = latestHistWeight.log_date >= latestLogsWeight.log_date
      ? latestHistWeight.weight_kg : Number(latestLogsWeight.weight);
  } else if (latestHistWeight) {
    fallbackWeightKg = latestHistWeight.weight_kg;
  } else if (latestLogsWeight) {
    fallbackWeightKg = Number(latestLogsWeight.weight);
  }
  const todayWeight = log?.weight ?? health?.weight_kg ?? fallbackWeightKg; // kg
  el.dTodayWeight.textContent = todayWeight ? fmt1(weightFromKg(todayWeight, unit)) : '—';
  const weightUnitEl = $('dTodayWeightUnit');
  if (weightUnitEl) weightUnitEl.textContent = unit;
  el.dTodaySteps.textContent = (log?.steps || health?.steps) ? fmtInt(log?.steps || health?.steps) : '—';

  // Resting-calorie default when not connected to Apple Health at all —
  // unlike active calories/weight/steps, there's no manual-entry field
  // for resting calories (a person can't directly observe their own
  // basal metabolic burn), so a Mifflin-St Jeor BMR estimate from real
  // profile data is the genuine, honest fallback rather than leaving
  // this permanently blank for anyone without a watch.
  const weightForBmr = todayWeight ? Number(todayWeight) : Number(activePlan?.start_weight) || null;
  const estimatedBmr = calcBmr(weightForBmr, profile?.height_cm, profile?.age_years, profile?.sex);

  // Consumed — see pickConsumedCalories for the full precedence order
  const displayCals = pickConsumedCalories(log, health);
  el.dTodayCals.textContent = displayCals != null ? fmtInt(displayCals) : '—';

  // Burned — total energy expenditure (active + resting)
  if (el.dTodayBurn) {
    const burn = totalBurn(health, log, estimatedBmr);
    el.dTodayBurn.textContent = burn != null ? fmtInt(burn) : '—';
  }

  // Last sync label
  const lastSyncEl = $('dLastSync');
  if (lastSyncEl && lastSync?.synced_at) {
    const diffMins = Math.round((Date.now() - new Date(lastSync.synced_at)) / 60000);
    lastSyncEl.textContent = diffMins < 60   ? `${diffMins}m ago`
                           : diffMins < 1440 ? `${Math.round(diffMins/60)}h ago`
                           :                   `${Math.round(diffMins/1440)}d ago`;
  } else if (lastSyncEl) {
    lastSyncEl.textContent = 'not synced yet';
  }

  // ── Goal rings ────────────────────────────────────────────
  const CIRCUMFERENCE = 144.51;
  function setRing(circleEl, labelEl, value, goal) {
    const pct = Math.min(1, (value || 0) / (goal || 1));
    circleEl.style.strokeDashoffset = CIRCUMFERENCE * (1 - pct);
    labelEl.textContent = Math.round(pct * 100) + '%';
  }
  // Same log-then-health precedence el.dTodaySteps already displays —
  // the ring was only reading log?.steps, so it stayed stuck at 0% for
  // anyone whose steps come from HealthKit sync rather than manual entry.
  setRing(el.rSteps, el.rStepsPct, log?.steps ?? health?.steps, profile?.steps_goal || 10000);
  setRing(el.rCal,   el.rCalPct,   displayCals, activePlan ? parseInt(el.dCalTarget?.textContent?.replace(/[^\d]/g,'')) || 2000 : 2000);

  // ── Smart eat target — computed from real Apple Health data ──
  const smartTarget = await computeSmartEatTarget();

  // ── Weight plan card + mini chart ────────────────────────
  renderPlanCard(logs, smartTarget);
  const hasWeightData = logs.length > 0;
  el.dashChartSkeleton.hidden = true;
  el.dashChart.hidden         = !hasWeightData;
  el.dashChartEmpty.hidden    = hasWeightData;
  if (hasWeightData) {
    // logs[].weight and activePlan.*_weight are canonical kg — converted
    // together here so the chart's numbers (axis labels, "target X" text)
    // match the unit the rest of the dashboard is showing.
    drawChart(
      el.dashChart, el.dashChartEmpty,
      logs.map(r => ({ ...r, weight: weightFromKg(r.weight, unit) })),
      activePlan ? { ...activePlan, start_weight: weightFromKg(activePlan.start_weight, unit), target_weight: weightFromKg(activePlan.target_weight, unit) } : null
    );
  }

  // ── Health widgets ────────────────────────────────────────
  // Sleep need (see computeSleepNeed) folds in yesterday's strain, so
  // that has to be computed first — same local-midnight boundary
  // todayWorkoutsRes above already uses, just shifted back one day, so
  // "yesterday" here means the same calendar day recentAppleWorkouts'
  // started_at would show in the Workout tab, not a UTC slice of it.
  const todayDateStr = health?.log_date || todayISO();
  const yesterdayStart = new Date(); yesterdayStart.setHours(0, 0, 0, 0); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const yesterdayEnd   = new Date(); yesterdayEnd.setHours(0, 0, 0, 0);
  const yesterdayDateStr = new Date(new Date(todayDateStr + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const yesterdayHealth = healthHistory.find(h => h.log_date === yesterdayDateStr) || null;
  const yesterdayWorkouts = recentAppleWorkouts.filter(w => {
    const t = new Date(w.started_at).getTime();
    return t >= yesterdayStart.getTime() && t < yesterdayEnd.getTime();
  });
  const yesterdayStrainScore = computeStrainScore(yesterdayHealth, healthHistory, {}, yesterdayWorkouts).score;
  const sleepNeedResult = computeSleepNeed(healthHistory, todayDateStr, yesterdayStrainScore);
  const recoveryResult  = computeRecoveryScore(health, healthHistory, sleepNeedResult);
  const todayStrainResult = computeStrainScore(health, healthHistory, log, todayWorkouts, recoveryResult.score);

  // Tonight's sleep target — same computeSleepNeed formula sleepNeedResult
  // above already uses to grade LAST night's sleep against what yesterday's
  // exertion called for, just pointed forward: today's own strain (so far)
  // drives how much sleep tonight should aim for, rather than yesterday's.
  // The debt component doesn't need its own forward/back distinction — it
  // already only looks at nights strictly before todayDate, which is
  // exactly "what's owed heading into tonight" either way. Surfaced inside
  // the Sleep gauge's tap-to-expand detail (see computeSleepScore) rather
  // than as always-visible chrome on the gauge itself, plus the 20:00
  // push notification (notify-sleep-target.js) for whoever wants it
  // without opening the app at all.
  const tonightSleepNeed = computeSleepNeed(healthHistory, todayDateStr, todayStrainResult.score);

  const sleepResult = computeSleepScore(health, healthHistory, sleepNeedResult, tonightSleepNeed);
  const nutritionResult = computeNutritionScore(health, log, smartTarget);
  renderScoreGauges({
    recovery:  recoveryResult,
    sleep:     sleepResult,
    strain:    todayStrainResult,
    nutrition: nutritionResult,
  });
  renderHealthTiles(health, healthHistory);
  const netCaloriesResult = renderNetCalories(health, healthHistory, log, estimatedBmr);
  // Same log-then-health precedence el.dTodaySteps already displays.
  const todayStepsForWidgets = log?.steps || health?.steps || null;
  pushScoresToWidgets({
    recovery: recoveryResult, sleep: sleepResult, strain: todayStrainResult, netCalories: netCaloriesResult,
    steps: todayStepsForWidgets, stepsGoal: profile?.steps_goal || 10000,
    sleepHours: health?.sleep_total_hrs ?? null, sleepNeedHours: sleepNeedResult?.needHours ?? null,
    nutritionScore: nutritionResult?.score ?? null,
  });

  // ── Last workout ────────────────────────────────────────────
  // "Last workout" should reflect whichever actually happened more
  // recently — a fitl00p-logged session (enriched with its matched Watch
  // stats, if any) or a Watch-tracked lifting session with no fitl00p
  // routine logged against it at all. Only takes the Apple-only path when
  // that workout isn't already the one matched above, and is genuinely
  // more recent than the last logged session.
  if (
    latestStrengthAppleWorkout &&
    lastSessionAppleWorkout?.started_at !== latestStrengthAppleWorkout.started_at &&
    new Date(latestStrengthAppleWorkout.started_at).getTime() > (
      lastSession
        ? new Date(lastSession.started_at || `${lastSession.session_date}T12:00:00`).getTime()
        : -Infinity
    )
  ) {
    renderLastWorkoutFromApple(latestStrengthAppleWorkout);
  } else {
    renderLastWorkout(lastSession, lastSessionAppleWorkout);
  }

  renderWeightReminder(log, unit);
}

// Only shown for an account with manual weight logging turned on
// (Settings > Weight logging) — that flag also makes health-sync.js skip
// writing Apple-Health-synced weight entirely, so this dashboard card is
// the only nudge to actually get a value in for today.
function renderWeightReminder(log, unit) {
  if (!el.weightReminderCard) return;
  el.weightReminderCard.hidden = !profile?.manual_weight_logging;
  if (!profile?.manual_weight_logging) return;

  if (el.wrUnit) el.wrUnit.textContent = unit;

  const loggedToday = log?.weight != null;
  const displayWeight = loggedToday ? weightFromKg(log.weight, unit) : null; // log.weight is kg
  el.weightReminderCard.classList.toggle('card--weight-reminder--done', loggedToday);
  if (el.wrBadge)  el.wrBadge.textContent = loggedToday ? 'Logged' : 'Not logged';
  if (el.wrHint)   el.wrHint.textContent  = loggedToday
    ? `Today's weight: ${fmt1(displayWeight)} ${unit}. You can update it below.`
    : "No weight logged today yet — a quick entry keeps your trend accurate.";
  // Pre-fill with today's value if there is one, so re-saving is an edit
  // rather than starting from blank; leave user-typed input alone otherwise.
  if (el.wrWeight && document.activeElement !== el.wrWeight) {
    el.wrWeight.value = loggedToday ? fmt1(displayWeight) : '';
  }
}

el.btnWrSave?.addEventListener('click', async () => {
  if (!currentUser) return;
  const unit = BODY_WEIGHT_UNIT;
  const inputWeight = parseFloat(el.wrWeight?.value);
  if (!Number.isFinite(inputWeight) || inputWeight <= 0) {
    flash(el.wrStatus, 'Enter a weight.', true);
    return;
  }
  const weightKg = weightToKg(inputWeight, unit);
  setBtn(el.btnWrSave, true, 'Log', 'Saving…');
  const { error } = await db
    .from('daily_logs')
    .upsert({ user_id: currentUser.id, log_date: todayISO(), weight: weightKg }, { onConflict: 'user_id,log_date' });
  setBtn(el.btnWrSave, false, 'Log');
  if (error) {
    flash(el.wrStatus, 'Error: ' + error.message, true);
    return;
  }
  flash(el.wrStatus, 'Saved.');
  todayLog = { ...(todayLog || {}), weight: weightKg };
  renderWeightReminder(todayLog, unit);
  if (el.dTodayWeight) el.dTodayWeight.textContent = fmt1(inputWeight);
});

function renderPlanCard(logs, smartTarget) {
  const unit = BODY_WEIGHT_UNIT;
  el.dCurrentUnit.textContent = unit;
  el.dTargetUnit.textContent  = unit;

  if (!activePlan) {
    el.dCurrentWeight.textContent = logs.length ? fmt1(weightFromKg(logs[logs.length - 1].weight, unit)) : '—';
    el.dTargetWeight.textContent  = '—';
    el.dProgressLabel.textContent = 'Set a plan in Settings';
    el.dProgressFill.style.width  = '0%';
    el.dPlanStats.hidden = true;
    return;
  }

  // All weight math below stays in kg (logs[].weight, activePlan.*_weight
  // are canonical kg) — only converted to the display unit at the very
  // end, when building the text the user actually sees.
  const latestW = logs.length ? Number(logs[logs.length - 1].weight) : Number(activePlan.start_weight);
  el.dCurrentWeight.textContent = fmt1(weightFromKg(latestW, unit));
  el.dTargetWeight.textContent  = fmt1(weightFromKg(activePlan.target_weight, unit));

  const today    = new Date(todayISO() + 'T00:00:00');
  const end      = new Date(activePlan.target_date + 'T00:00:00');
  const daysLeft = Math.max(1, Math.round((end - today) / 86400000));

  const totalChg = activePlan.start_weight - activePlan.target_weight;
  let pct = totalChg !== 0
    ? ((Number(activePlan.start_weight) - latestW) / totalChg) * 100
    : 0;
  pct = Math.max(0, Math.min(100, pct));

  el.dProgressFill.style.width  = pct.toFixed(1) + '%';
  el.dProgressLabel.textContent = `${pct.toFixed(0)}% to goal · ${daysLeft} day${daysLeft === 1 ? '' : 's'} left`;

  // Use smart target if available, otherwise fall back to simple calculation
  if (smartTarget) {
    el.dCalTarget.textContent = `${smartTarget.eatTarget.toLocaleString()} kcal`;
    const methodNote = smartTarget.method === 'manual'
      ? '(your override — plan pace would need this much)'
      : smartTarget.method === 'observed'
      ? '(based on your current intake)'
      : '(based on plan target)';
    if (el.dDeficitNeeded) {
      el.dDeficitNeeded.textContent = `${smartTarget.dailyDeficit.toLocaleString()} kcal/day ${methodNote}`;
    }
    const weeklyKg = (smartTarget.kgLeft / smartTarget.daysLeft * 7);
    el.dWeeklyPace.textContent = `${fmtSigned(-weightFromKg(weeklyKg, unit), 2)} ${unit}/wk`;
  } else {
    const remainingKg = activePlan.target_weight - latestW;
    const dailyChgKg  = remainingKg / daysLeft;
    const deficit     = -(dailyChgKg * KCAL_PER_KG);
    const calTarget   = Math.max(1200, Math.round((profile?.tdee || 2200) - deficit));
    el.dCalTarget.textContent = `${calTarget.toLocaleString()} kcal`;
    if (el.dDeficitNeeded) el.dDeficitNeeded.textContent = `${Math.round(deficit).toLocaleString()} kcal/day`;
    el.dWeeklyPace.textContent = `${fmtSigned(weightFromKg(dailyChgKg * 7, unit), 2)} ${unit}/wk`;
  }

  el.dPlanStats.hidden = false;
}

// Shared kcal/avg-HR/duration summary row — used by the dashboard's Last
// Workout card and every card in the Workout tab's combined activity
// history, so all three stay visually and numerically consistent rather
// than each hand-rolling the same three fields.
function workoutStatParts(w) {
  if (!w) return [];
  const kcal = w.active_energy_kcal ?? w.total_energy_kcal;
  const parts = [];
  if (kcal != null) parts.push(`<span class="last-workout-stat">🔥 ${Math.round(kcal)} kcal</span>`);
  if (w.avg_heart_rate != null) parts.push(`<span class="last-workout-stat">❤️ ${Math.round(w.avg_heart_rate)} bpm avg</span>`);
  const durMin = Math.round((new Date(w.ended_at) - new Date(w.started_at)) / 60000);
  const hasDuration = Number.isFinite(durMin) && durMin > 0;
  if (hasDuration) parts.push(`<span class="last-workout-stat">⏱ ${durMin} min</span>`);
  if (w.max_heart_rate != null) parts.push(`<span class="last-workout-stat">📈 ${Math.round(w.max_heart_rate)} bpm max</span>`);
  if (w.distance_km != null && w.distance_km > 0) {
    parts.push(`<span class="last-workout-stat">📍 ${w.distance_km.toFixed(2)} km</span>`);
    // Pace only means something alongside a real duration — skip it rather
    // than divide by a missing/zero minute count.
    if (hasDuration) {
      const paceMinPerKm = durMin / w.distance_km;
      const paceWhole = Math.floor(paceMinPerKm);
      const paceSec = Math.round((paceMinPerKm - paceWhole) * 60);
      parts.push(`<span class="last-workout-stat">🚶 ${paceWhole}:${String(paceSec).padStart(2, '0')}/km</span>`);
    }
  }
  return parts;
}
function workoutStatsRowHtml(w) {
  const parts = workoutStatParts(w);
  return parts.length ? `<div class="last-workout-stats">${parts.join('')}</div>` : '';
}

// Pairs fitl00p's own logged strength session with whichever Watch-synced
// Apple Health workout actually happened alongside it, so "Last workout"
// can show real calories/heart-rate data fitl00p's own routine tracker
// has no way to measure itself. Matched purely on time proximity (not
// workout_type — Apple Health's own label for a fitl00p-logged strength
// session varies by watch/OS version, e.g. "Traditional Strength
// Training" vs "Functional Strength Training", too unreliable to filter
// on) against workout_sessions.started_at (recorded when the workout
// screen was opened, not when it was saved) — falls back to noon on
// session_date for an older session logged before started_at existed.
// A 12h window is generous enough to absorb clock skew between the two
// sources while still refusing to pair, say, today's push day with a run
// from three days ago just because nothing closer exists.
const APPLE_WORKOUT_MATCH_WINDOW_MS = 12 * 3600000;
function matchAppleWorkout(session, appleWorkouts) {
  if (!session) return null;
  const anchorMs = session.started_at
    ? new Date(session.started_at).getTime()
    : new Date(`${session.session_date}T12:00:00`).getTime();
  if (!Number.isFinite(anchorMs)) return null;

  let best = null, bestDiff = Infinity;
  for (const w of appleWorkouts || []) {
    const wMs = new Date(w.started_at).getTime();
    if (!Number.isFinite(wMs)) continue;
    const diff = Math.abs(wMs - anchorMs);
    if (diff < bestDiff) { bestDiff = diff; best = w; }
  }
  return best && bestDiff <= APPLE_WORKOUT_MATCH_WINDOW_MS ? best : null;
}

// Apple Health's own HKWorkoutActivityType label for a lifting session
// varies by watch/OS version ("Traditional Strength Training",
// "Functional Strength Training") and isn't the Push/Pull/Legs/Full Body
// vocabulary fitl00p's own routine tracker uses — this is only ever used
// as a display label for a workout with no matching fitl00p session
// (see below), not for anything that feeds the matching logic itself.
function appleWorkoutTypeLabel(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('strength')) return 'Strength Training';
  if (t.includes('core')) return 'Core Training';
  if (t.includes('cross training')) return 'Cross Training';
  if (t.includes('hiit') || t.includes('high intensity')) return 'HIIT';
  return type || 'Workout';
}
function isStrengthWorkoutType(type) {
  return /strength|functional|cross training|core training|hiit|high intensity/i.test(String(type || ''));
}

// A Watch-tracked lifting session with no fitl00p routine logged against
// it yet (e.g. it just happened, or the user only ever tracks lifts on
// the Watch) — shown with whatever Apple Health itself calls it rather
// than a Push/Pull/Legs split tag, since fitl00p has no exercise/set
// detail for it to show either. Nudges toward logging it properly so a
// later session gets the fuller card renderLastWorkout below produces.
function renderLastWorkoutFromApple(workout) {
  const label = appleWorkoutTypeLabel(workout.workout_type);

  el.dLastWorkout.innerHTML = `
    <div style="margin-bottom:10px">
      <span class="split-tag split-tag--Other">${escapeHtml(label)}</span>
      <span style="font-size:12px;color:var(--ink-soft);font-family:var(--mono);margin-left:8px">${fmtDate(String(workout.started_at).slice(0, 10))}</span>
    </div>
    ${workoutStatsRowHtml(workout)}
    <p class="field-hint" style="margin-top:2px">From Apple Watch — log it under Workout for exercise &amp; set detail too.</p>
  `;
}

function renderLastWorkout(session, appleWorkout) {
  if (!session) {
    el.dLastWorkout.innerHTML = '<p class="empty-state">No workouts logged yet.</p>';
    return;
  }
  const tag = splitTag(session.split_type);
  const statsHtml = appleWorkout ? workoutStatsRowHtml(appleWorkout) : '';

  el.dLastWorkout.innerHTML = `
    <div style="margin-bottom:10px">${tag} <span style="font-size:12px;color:var(--ink-soft);font-family:var(--mono);margin-left:8px">${fmtDate(session.session_date)}</span></div>
    ${statsHtml}
  `;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Personal rolling baseline for a field — the whole point of comparing
// "today vs your own history" rather than a fixed population threshold
// (a HRV of 40ms is great for one person, low for another). Needs at
// least 5 data points to be meaningful; callers fall back to fixed
// thresholds below that, which also keeps this safe for a brand new
// account with little history yet.
function baselineMean(history, field, excludeDate) {
  const vals = (history || [])
    .filter(h => h.log_date !== excludeDate && h[field] != null)
    .map(h => Number(h[field]));
  if (vals.length < 5) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Scores a value against its own baseline: 50 = exactly at baseline,
// moving toward 100/0 as it diverges. `sensitivity` controls how much
// %-deviation from baseline maps to a full swing away from 50.
function scoreVsBaseline(value, baseline, sensitivity, higherIsBetter) {
  if (value == null || !baseline) return null;
  const pctDev = (value - baseline) / baseline;
  const signed = higherIsBetter ? pctDev : -pctDev;
  return clamp(50 + signed * sensitivity, 0, 100);
}

function tieredSleepDurationScore(hrs) {
  if (hrs >= 8) return 100;
  if (hrs >= 7) return 88;
  if (hrs >= 6) return 70;
  if (hrs >= 5) return 50;
  if (hrs >= 4) return 30;
  return 15;
}

// ── Sleep need ───────────────────────────────────────────────
// Published methodology (WHOOP's own): how much sleep last night's
// exertion plus accumulated debt actually call for, rather than a flat
// tier everyone's held to regardless of how hard yesterday was. Recovery
// and Sleep below both substitute "did you meet YOUR need" for the old
// flat duration tier wherever they score last night's length, since
// hitting a personalised target is a better readiness signal than
// clearing a population-average bar.
const SLEEP_NEED_BASELINE_HRS = 8;   // adult midpoint — not personalised further yet
const SLEEP_DEBT_CAP_HRS      = 1.5; // a week of debt can't be repaid in one night
const SLEEP_NAP_THRESHOLD_HRS = 4;   // nights under this are naps — excluded from debt/baseline math, kept in raw history

// f(strain): near-zero addition on a rest day, rising to ~1h17m after an
// all-out (21) day — the harder yesterday was, the more sleep tonight
// calls for. debt: shortfall vs baseline summed over the last 3 REAL
// (non-nap) nights before today, capped so it can't compound forever.
function computeSleepNeed(healthHistory, todayDate, yesterdayStrainScore) {
  const strainHours = yesterdayStrainScore != null
    ? 1.7 / (1 + Math.exp((17 - yesterdayStrainScore) / 3.5))
    : 0;

  const priorNights = (healthHistory || [])
    .filter(h => h.log_date < todayDate && h.sleep_total_hrs != null && h.sleep_total_hrs >= SLEEP_NAP_THRESHOLD_HRS)
    .sort((a, b) => b.log_date.localeCompare(a.log_date))
    .slice(0, 3);
  const shortfallSum = priorNights.reduce((sum, h) => sum + Math.max(0, SLEEP_NEED_BASELINE_HRS - h.sleep_total_hrs), 0);
  const debtHours = Math.min(SLEEP_DEBT_CAP_HRS, 0.35 * shortfallSum);

  const needHours = SLEEP_NEED_BASELINE_HRS + strainHours + debtHours;
  return {
    needHours, baselineHours: SLEEP_NEED_BASELINE_HRS, strainHours, debtHours,
    yesterdayStrainScore, priorNightsUsed: priorNights.length,
  };
}

// ── Recovery ─────────────────────────────────────────────────
// Physiological readiness — same four inputs WHOOP publicly states
// theirs uses (HRV, resting HR, respiratory rate, sleep), each scored
// against this person's own 30-day baseline (falling back to fixed
// population thresholds when there isn't yet enough history to build
// one). HRV is weighted well above the others — independent analyses
// of WHOOP's real-world scores consistently find it dominates, with
// RHR secondary and sleep/respiratory rate smaller supporting inputs,
// not co-equal factors. Calorie balance deliberately isn't a factor
// here — that's what the separate Nutrition score is for; folding it
// into Recovery too would double-count the same signal.
function computeRecoveryScore(health, healthHistory, sleepNeed) {
  let totalScore = 0, totalWeight = 0;
  const factors = [];
  const todayDate = health?.log_date;

  const hrv = health?.hrv_ms;
  if (hrv != null) {
    const baseline = baselineMean(healthHistory, 'hrv_ms', todayDate);
    const hrvScore = baseline != null
      ? scoreVsBaseline(hrv, baseline, 200, true)
      : (hrv >= 100 ? 100 : hrv >= 80 ? 90 : hrv >= 60 ? 78 : hrv >= 40 ? 62 : hrv >= 25 ? 45 : hrv >= 15 ? 28 : 15);
    totalScore += hrvScore * 0.40; totalWeight += 0.40;
    factors.push({ label: 'HRV', val: `${Math.round(hrv)}ms`, pct: Math.round(hrvScore), cls: 'hrv' });
  }

  const rhr = health?.resting_hr;
  if (rhr != null) {
    const baseline = baselineMean(healthHistory, 'resting_hr', todayDate);
    const rhrScore = baseline != null
      ? scoreVsBaseline(rhr, baseline, 300, false)
      : (rhr < 50 ? 100 : rhr < 55 ? 92 : rhr < 60 ? 82 : rhr < 65 ? 70 : rhr < 70 ? 58 : rhr < 80 ? 42 : 25);
    totalScore += rhrScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'Resting HR', val: `${Math.round(rhr)}bpm`, pct: Math.round(rhrScore), cls: 'hr' });
  }

  // A resting respiratory rate that's crept up above this person's own
  // norm is a recognized early illness/overreach signal in the wearable
  // literature (Oura, WHOOP, and others all surface it for that reason)
  // — small weight since it's a supporting signal, not a primary one.
  const rr = health?.respiratory_rate;
  if (rr != null) {
    const baseline = baselineMean(healthHistory, 'respiratory_rate', todayDate);
    const rrScore = baseline != null ? scoreVsBaseline(rr, baseline, 40, false) : null;
    if (rrScore != null) {
      totalScore += rrScore * 0.10; totalWeight += 0.10;
      factors.push({ label: 'Respiratory rate', val: `${fmt1(rr)}/min`, pct: Math.round(rrScore), cls: 'hr' });
    }
  }

  // Apple's own wrist-temperature metric is ALREADY a deviation from this
  // person's personal baseline (computed on-device, not a raw reading),
  // so — unlike HRV/RHR/respiratory rate above — this is scored directly
  // against fixed tiers rather than re-baselined against our own history.
  // Elevated wrist temp overnight is the same kind of early illness/
  // overreach signal Oura popularized; small supporting weight, same as
  // respiratory rate.
  const wristTemp = health?.wrist_temp_dev;
  if (wristTemp != null) {
    const tempScore = wristTemp <= 0.3 ? 100 : wristTemp <= 0.6 ? 80 : wristTemp <= 1.0 ? 55 : wristTemp <= 1.5 ? 30 : 10;
    totalScore += tempScore * 0.10; totalWeight += 0.10;
    factors.push({ label: 'Wrist temp', val: `${fmtSigned(wristTemp, 1)}°C`, pct: tempScore, cls: 'hr' });
  }

  const sleep = health?.sleep_total_hrs;
  if (sleep != null) {
    // Prefer sleep_performance (slept ÷ personalised need) over the old
    // flat duration tier when a need figure is available — see
    // computeSleepNeed. Falls back to the tiered scorer on a fresh
    // account with no prior-night history to compute debt/need from yet.
    let sleepScore;
    if (sleepNeed?.needHours) {
      sleepScore = clamp((sleep / sleepNeed.needHours) * 100, 0, 100);
      factors.push({ label: 'Sleep', val: `${fmt1(sleep)}h / ${fmt1(sleepNeed.needHours)}h needed`, pct: Math.round(sleepScore), cls: 'sleep' });
    } else {
      const deep = health?.sleep_deep_hrs || 0;
      const rem  = health?.sleep_rem_hrs  || 0;
      sleepScore = Math.min(100, tieredSleepDurationScore(sleep) + Math.min(10, (deep + rem) * 5));
      factors.push({ label: 'Sleep', val: `${fmt1(sleep)}h`, pct: Math.round(sleepScore), cls: 'sleep' });
    }
    totalScore += sleepScore * 0.25; totalWeight += 0.25;
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };
  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'Well recovered — great day to push hard.' :
                score >= 60 ? 'Good recovery — normal training is fine.' :
                score >= 40 ? 'Below your usual — consider a lighter session.' :
                score >= 20 ? 'Low — prioritise recovery today.' :
                              'Poorly recovered — rest day recommended.';
  return { score, label, factors };
}

// ── Sleep ────────────────────────────────────────────────────
// Last night specifically, not overall readiness: duration, how much
// of it was deep/REM (vs the healthy ~13-23% / ~20-25% ranges), and
// bedtime consistency against the last two weeks.
function computeSleepScore(health, healthHistory, sleepNeed, tonightSleepNeed) {
  const sleep = health?.sleep_total_hrs;
  if (sleep == null) return { score: null, label: '', factors: [] };

  let totalScore = 0, totalWeight = 0;
  const factors = [];

  // Performance against personalised need (see computeSleepNeed) replaces
  // the flat duration tier when there's enough history to compute one —
  // broken out line by line (baseline/strain/debt) so where the target
  // number came from is visible, not just the final hours figure.
  if (sleepNeed?.needHours) {
    const perfScore = clamp((sleep / sleepNeed.needHours) * 100, 0, 100);
    totalScore += perfScore * 0.40; totalWeight += 0.40;
    factors.push({ label: 'Performance', val: `${Math.round(perfScore)}% of ${fmt1(sleepNeed.needHours)}h needed`, pct: Math.round(perfScore), cls: 'sleep' });
    factors.push({ label: 'Baseline', val: `${fmt1(sleepNeed.baselineHours)}h`, pct: 100, cls: 'sleep' });
    if (sleepNeed.strainHours > 0.02) {
      factors.push({ label: "Yesterday's strain", val: `+${fmt1(sleepNeed.strainHours)}h${sleepNeed.yesterdayStrainScore != null ? ` (${fmt1(sleepNeed.yesterdayStrainScore)} strain)` : ''}`, pct: Math.round(clamp((sleepNeed.strainHours / 1.3) * 100, 0, 100)), cls: 'intensity' });
    }
    if (sleepNeed.debtHours > 0.02) {
      factors.push({ label: 'Sleep debt', val: `+${fmt1(sleepNeed.debtHours)}h (last ${sleepNeed.priorNightsUsed}n)`, pct: Math.round(clamp((sleepNeed.debtHours / SLEEP_DEBT_CAP_HRS) * 100, 0, 100)), cls: 'active' });
    }
  } else {
    const durScore = tieredSleepDurationScore(sleep);
    totalScore += durScore * 0.40; totalWeight += 0.40;
    factors.push({ label: 'Duration', val: `${fmt1(sleep)}h`, pct: Math.round(durScore), cls: 'sleep' });
  }

  const scoreStagePct = (pct, idealLo, idealHi) => {
    if (pct >= idealLo && pct <= idealHi) return 100;
    if (pct < idealLo) return clamp(100 - (idealLo - pct) * 8, 15, 95);
    return clamp(100 - (pct - idealHi) * 6, 15, 95);
  };

  const deep = health?.sleep_deep_hrs;
  if (deep != null && sleep > 0) {
    const deepPct = (deep / sleep) * 100;
    const deepScore = scoreStagePct(deepPct, 13, 23);
    totalScore += deepScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'Deep sleep', val: `${Math.round(deepPct)}%`, pct: Math.round(deepScore), cls: 'deep' });
  }

  const rem = health?.sleep_rem_hrs;
  if (rem != null && sleep > 0) {
    const remPct = (rem / sleep) * 100;
    const remScore = scoreStagePct(remPct, 20, 25);
    totalScore += remScore * 0.25; totalWeight += 0.25;
    factors.push({ label: 'REM sleep', val: `${Math.round(remPct)}%`, pct: Math.round(remScore), cls: 'rem' });
  }

  const sleepStart = health?.sleep_start;
  if (sleepStart) {
    const timeOfDayMin = iso => { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); };
    const recentStarts = (healthHistory || [])
      .filter(h => h.log_date !== health.log_date && h.sleep_start)
      .slice(-14)
      .map(h => timeOfDayMin(h.sleep_start));
    if (recentStarts.length >= 5) {
      const todayMin = timeOfDayMin(sleepStart);
      const avgMin = recentStarts.reduce((a, b) => a + b, 0) / recentStarts.length;
      const rawDiff = Math.abs(todayMin - avgMin);
      const diff = Math.min(rawDiff, 1440 - rawDiff); // circular distance across midnight
      const consistencyScore = clamp(100 - diff, 20, 100);
      totalScore += consistencyScore * 0.10; totalWeight += 0.10;
      factors.push({ label: 'Consistency', val: `±${Math.round(diff)}m`, pct: Math.round(consistencyScore), cls: 'consistency' });
    }
  }

  // Apple Watch's native Sleep Apnea Notifications (Series 9/10/SE3/Ultra 2,
  // watchOS 11+) — an elevated flag some nights, never a rate (Apple doesn't
  // expose the underlying events/hr to third-party apps via HealthKit, only
  // this boolean). null means no sync that night (true for all history
  // before this was enabled) rather than "not elevated" — excluded from the
  // score entirely rather than treated as either good or bad, same as every
  // other factor above when its own field is missing.
  const breathingElevated = health?.breathing_disturbances_elevated;
  if (breathingElevated != null) {
    const breathingScore = breathingElevated ? 30 : 100;
    totalScore += breathingScore * 0.15; totalWeight += 0.15;
    factors.push({
      label: 'Breathing', val: breathingElevated ? 'Elevated' : 'Not elevated',
      pct: breathingScore, cls: 'breathing',
    });
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };
  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'Great night — solid duration and architecture.' :
                score >= 60 ? 'Good sleep, some room to improve.' :
                score >= 40 ? 'Below par — try to catch up tonight.' :
                              'Poor sleep — expect it to affect today.';
  const tonightNote = tonightSleepNeed?.needHours != null ? ` Aim for ${fmt1(tonightSleepNeed.needHours)}h tonight.` : '';
  return { score, label: label + tonightNote, factors };
}

// ── Strain ───────────────────────────────────────────────────
// A genuine cardiovascular-load "Day Strain" on a 0-21 scale, modeled
// after the Borg Scale of Perceived Exertion the same way WHOOP
// publicly describes theirs — not a reverse-engineering of their exact
// (undisclosed) constants, but the same well-published methodology:
//
// 1. Per-workout TRIMP (Banister's exponential Training Impulse,
//    Banister 1991) from each of today's real Watch-synced workouts:
//    TRIMP = duration_min x HRr x a x e^(b x HRr), HRr = heart rate
//    reserve fraction = (avgHR - restingHR) / (HRmax - restingHR).
//    HRmax uses the Tanaka formula (208 - 0.7 x age) — better-validated
//    across ages than the older 220-age rule — falling back to 35 when
//    age isn't set in Settings. a/b are Banister's own published
//    constants (0.64/1.92 male, 0.86/1.67 female).
// 2. Non-workout daily activity (today's active-energy total minus
//    whatever's already attributed to a logged workout, so the two
//    pathways below can't double-count the same calories) contributes
//    a smaller secondary load — captures ordinary walking-around
//    movement the way a continuously-worn strap would, which a
//    workout-only TRIMP sum alone would miss entirely.
// 3. Both loads combine inside one shared exponential-saturation
//    curve — Strain = 21 x (1 - e^-(k1*TRIMP + k2*kcal)) — the same
//    "more effort needed for the same marginal increase as the day
//    gets harder" shape WHOOP describes, asymptotic to 21 rather than
//    hard-capped. k1/k2 are calibrated (see comments below) so a solid
//    ~60min moderate-vigorous session alone lands around 13-14 and a
//    quiet day with just typical daily movement lands low single
//    digits — openly a calibration choice, not WHOOP's own constant.
const STRAIN_MAX = 21;
// Solved so a 60min session at HRr=0.731 (~150bpm avg, RHR 55, HRmax 185)
// -> TRIMP~=114 -> Strain~=13, a plausible "solid hour" WHOOP-style number.
const STRAIN_K_TRIMP = 0.0085;
// Solved so ~500kcal of non-workout active energy alone -> Strain~=7,
// a plausible "active day, no logged workout" number.
const STRAIN_K_KCAL  = 0.00081;

function tanakaHrMax(ageYears) { return 208 - 0.7 * (ageYears || 35); }

// Closes the loop between the two scores instead of leaving them as two
// independent charts: how hard today "should" be, given how recovered
// this morning's reading says the body actually is.
function targetStrainRange(recoveryScore) {
  if (recoveryScore == null) return null;
  if (recoveryScore >= 67) return { lo: 14.0, hi: 18.0, band: 'green' };
  if (recoveryScore >= 34) return { lo: 9.0,  hi: 13.5, band: 'yellow' };
  return { lo: 0, hi: 8.0, band: 'red' };
}

function computeStrainScore(health, healthHistory, log, workoutsToday, recoveryScore) {
  const dailyActiveKcal = health?.active_energy_kcal ?? log?.active_energy_kcal;
  const workouts = (workoutsToday || []).filter(w => Number.isFinite(Number(w.avg_heart_rate)));
  if (dailyActiveKcal == null && !workouts.length) return { score: null, label: '', factors: [] };

  const restingHr = health?.resting_hr;
  const hrMax = tanakaHrMax(profile?.age_years);
  const isFemale = profile?.sex === 'female';

  let cumulativeTrimp = 0;
  let workoutKcal = 0;
  for (const w of workouts) {
    const avgHr = Number(w.avg_heart_rate);
    const durMin = (new Date(w.ended_at) - new Date(w.started_at)) / 60000;
    workoutKcal += Number(w.active_energy_kcal) || 0;
    if (restingHr == null || !Number.isFinite(durMin) || durMin <= 0 || hrMax <= restingHr) continue;
    const hrr = clamp((avgHr - restingHr) / (hrMax - restingHr), 0, 1);
    cumulativeTrimp += isFemale
      ? durMin * hrr * 0.86 * Math.exp(1.67 * hrr)
      : durMin * hrr * 0.64 * Math.exp(1.92 * hrr);
  }

  const residualKcal = Math.max(0, (dailyActiveKcal || 0) - workoutKcal);
  const strainFraction = 1 - Math.exp(-(STRAIN_K_TRIMP * cumulativeTrimp + STRAIN_K_KCAL * residualKcal));
  const score = Math.round(STRAIN_MAX * strainFraction * 10) / 10;

  const factors = [];
  if (cumulativeTrimp > 0) {
    factors.push({ label: 'Workout load', val: `${Math.round(cumulativeTrimp)} TRIMP`, pct: clamp(Math.round((cumulativeTrimp / 300) * 100), 0, 100), cls: 'intensity' });
  } else if (workouts.length) {
    factors.push({ label: 'Workout load', val: restingHr == null ? 'no resting HR yet' : '—', pct: 0, cls: 'intensity' });
  }
  factors.push({ label: 'Daily activity', val: `${Math.round(residualKcal)} kcal`, pct: clamp(Math.round((residualKcal / 700) * 100), 0, 100), cls: 'active' });

  const target = targetStrainRange(recoveryScore);
  if (target) {
    factors.push({ label: 'Target (from recovery)', val: `${fmt1(target.lo)}–${fmt1(target.hi)}`, pct: clamp(Math.round((score / target.hi) * 100), 0, 100), cls: target.band === 'green' ? 'intensity' : target.band === 'yellow' ? 'active' : 'breathing' });
  }

  let label = score >= 15 ? 'All-out day — plan for real recovery.' :
              score >= 10 ? 'High strain today.' :
              score >= 6  ? 'Moderate strain today.' :
              score >= 2  ? 'Light day so far.' :
                            'Very low strain so far today.';
  if (target) {
    const inRange = score >= target.lo && score <= target.hi;
    label += inRange
      ? ` Right in today's ${fmt1(target.lo)}–${fmt1(target.hi)} target for how recovered you are.`
      : score > target.hi
        ? ` Already past today's ${fmt1(target.lo)}–${fmt1(target.hi)} target — recovery says today wasn't built for this much.`
        : ` Room left in today's ${fmt1(target.lo)}–${fmt1(target.hi)} target if you want it.`;
  }
  return { score, label, factors };
}

// ── Nutrition ────────────────────────────────────────────────
// How close today's actual intake is to the smart eat target — the
// most honest signal available broadly (macro-gram tracking only
// exists for diabetes-tab meals, not general daily logging, so this
// deliberately doesn't pretend to score macro balance it can't see).
function computeNutritionScore(health, log, smartTarget) {
  const consumed = pickConsumedCalories(log, health);
  const target = smartTarget?.eatTarget ?? profile?.eat_target_kcal ?? (profile?.tdee ? profile.tdee - 500 : null);
  if (consumed == null || !target) return { score: null, label: '', factors: [] };

  const pctOfTarget = (consumed / target) * 100;
  const deviation = Math.abs(pctOfTarget - 100);
  const score = Math.round(clamp(100 - deviation * 1.5, 0, 100));

  const factors = [
    { label: 'Eaten', val: `${Math.round(consumed)} kcal`, pct: score, cls: 'cals' },
    { label: 'Target', val: `${Math.round(target)} kcal`, pct: 100, cls: 'target' },
  ];
  const label = score >= 80 ? 'Right on target.' :
                score >= 60 ? 'Close to target.' :
                score >= 40 ? 'Noticeably off target today.' :
                              'Well off target today.';
  return { score, label, factors };
}

// max: the score's own natural ceiling for ring-fill purposes — Strain
// is a real 0-21 WHOOP-style scale (shown as-is, one decimal, the same
// way WHOOP's own UI shows a bare "14.2" rather than a percentage),
// the rest stay the existing 0-100 scoring.
const SCORE_META = {
  recovery:  { label: 'Recovery',  icon: '⚡', max: 100 },
  sleep:     { label: 'Sleep',     icon: '🌙', max: 100 },
  strain:    { label: 'Strain',    icon: '🔥', max: STRAIN_MAX },
  nutrition: { label: 'Nutrition', icon: '🍽️', max: 100 },
};
const SCORE_RING_CIRCUMFERENCE = 188.5; // 2*π*30, r=30 per the SVG markup
let dashScoresData = null; // last-rendered scores, for tap-to-expand

function formatScoreVal(key, score) {
  return SCORE_META[key]?.max === STRAIN_MAX ? fmt1(score) : Math.round(score);
}

function setScoreGauge(key, score) {
  const ring   = $(`scoreRing_${key}`);
  const val    = $(`scoreVal_${key}`);
  const liquid = $(`scoreLiquid_${key}`); // Nebula theme only — inert (display:none) elsewhere
  if (!ring || !val) return;
  if (score == null) {
    ring.style.strokeDashoffset = SCORE_RING_CIRCUMFERENCE;
    val.textContent = '—';
    liquid?.style.setProperty('--fill-pct', '0%');
    return;
  }
  const max = SCORE_META[key]?.max || 100;
  const pct = clamp(score, 0, max) / max;
  ring.style.strokeDashoffset = SCORE_RING_CIRCUMFERENCE * (1 - pct);
  val.textContent = formatScoreVal(key, score);
  liquid?.style.setProperty('--fill-pct', `${pct * 100}%`);
}

// The bell's unread dot stays lit until today's briefing has actually
// been opened, keyed by date rather than a fixed "read: true" flag so
// tomorrow's fresh briefing isn't silently suppressed by today's read.
const COACH_READ_KEY = 'fitl00p:coach_read_date';
let latestCoachBriefing = null;

// Stores the once-daily briefing from notify-ai-coach.js and lights the
// bell icon's dot if it hasn't been opened yet today. Rendered into the
// modal (openCoachModal) on demand rather than immediately — plain
// textContent there (not innerHTML), since the content is server-
// generated free text, not markup.
function renderCoachBriefing(row) {
  latestCoachBriefing = row?.content ? row : null;
  if (!el.coachBellDot) return;
  let readDate = null;
  try { readDate = localStorage.getItem(COACH_READ_KEY); } catch {}
  el.coachBellDot.hidden = !latestCoachBriefing || latestCoachBriefing.briefing_date === readDate;
}

function openCoachModal() {
  if (!el.coachModal) return;
  if (latestCoachBriefing) {
    el.coachBriefingEmpty.hidden = true;
    el.coachBriefingBody.hidden = false;
    const d = new Date(latestCoachBriefing.briefing_date + 'T00:00:00');
    el.coachBriefingDate.textContent = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    el.coachBriefingText.textContent = latestCoachBriefing.content;
    try { localStorage.setItem(COACH_READ_KEY, latestCoachBriefing.briefing_date); } catch {}
    el.coachBellDot.hidden = true;
  } else {
    el.coachBriefingEmpty.hidden = false;
    el.coachBriefingBody.hidden = true;
  }
  el.coachModal.hidden = false;
}

el.btnCoachBell?.addEventListener('click', openCoachModal);
document.addEventListener('click', e => {
  if (e.target.closest('#coachModalClose')) el.coachModal.hidden = true;
});

/* ═══ DAILY CHECKLIST (Gemma's account only) ═══════════════
   Four manually-ticked daily targets — steps, water, food logged,
   weight logged — rendered as a 4-tile dashboard card. Completing all
   four in a day extends the overall streak, and each item also keeps
   its own independent streak (e.g. water ticked 6 days running even if
   steps has gaps) — both stored per-day in habit_checklist_log, set
   only on the day they extend, so neither ever needs recomputing from
   scratch. Completing all four fires an immediate "well done" push via
   push-send.js the moment the last tile is ticked, not on the next
   scheduled function run. */
const CHECKLIST_KEYS = ['steps', 'water', 'food', 'weight'];
let checklistToday = null;     // habit_checklist_log row for today, or a fresh default
let checklistYesterday = null; // habit_checklist_log row for yesterday, or null

function checklistIsComplete(row) {
  return !!row && CHECKLIST_KEYS.every(k => row[`${k}_done`]);
}

// Displayed value for a streak column: today's own count once today
// (still) carries it, otherwise yesterday's (protects the flame
// through the day boundary until it's actually broken), else 0.
function checklistDisplayStreak(field) {
  return checklistToday?.[field] ?? checklistYesterday?.[field] ?? 0;
}

async function fetchChecklistRows() {
  if (!currentUser) return;
  const today = todayISO();
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { data } = await db.from('habit_checklist_log')
    .select('log_date, steps_done, water_done, food_done, weight_done, streak_count, steps_streak, water_streak, food_streak, weight_streak')
    .eq('user_id', currentUser.id)
    .in('log_date', [today, yesterday]);

  checklistToday = (data || []).find(r => r.log_date === today) || {
    log_date: today, streak_count: null,
    steps_done: false, water_done: false, food_done: false, weight_done: false,
    steps_streak: null, water_streak: null, food_streak: null, weight_streak: null,
  };
  checklistYesterday = (data || []).find(r => r.log_date === yesterday) || null;
}

function renderChecklist() {
  if (!el.checklistCard || !checklistToday) return;
  el.checklistCard.hidden = false;

  CHECKLIST_KEYS.forEach(k => {
    const tile = el.checklistTiles?.querySelector(`[data-key="${k}"]`);
    if (!tile) return;
    tile.classList.toggle('is-done', !!checklistToday[`${k}_done`]);
    const itemStreak = checklistDisplayStreak(`${k}_streak`);
    const streakEl = tile.querySelector('.checklist-tile__streak');
    if (streakEl) {
      streakEl.hidden = itemStreak === 0;
      streakEl.textContent = `🔥${itemStreak}`;
    }
  });

  const streak = checklistDisplayStreak('streak_count');
  if (el.checklistStreak) {
    el.checklistStreak.hidden = streak === 0;
    if (el.checklistStreakCount) el.checklistStreakCount.textContent = streak;
  }
}

async function sendChecklistCompleteNotification(streak) {
  const { data: subs } = await db.from('push_subscriptions')
    .select('endpoint, p256dh, auth_key')
    .eq('user_id', currentUser.id);
  if (!subs?.length) return;

  const jokes = [
    `You're smashing it, that's ${streak} day${streak === 1 ? '' : 's'} in a row, keep it up 💪`,
    `${streak} for ${streak}! Full house again today — keep it up 💪`,
    `That's ${streak} day${streak === 1 ? '' : 's'} straight, you machine — keep it up 💪`,
  ];
  const body = jokes[Math.floor(Math.random() * jokes.length)];

  for (const s of subs) {
    try {
      await fetch(`${FUNCTIONS_ORIGIN}/push-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...FUNCTIONS_ANON_HEADERS },
        body: JSON.stringify({
          subscription: { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
          notification: { title: '🔥 Streak alert!', body, url: '/', tag: 'habit-checklist-streak' },
        }),
      }).catch(() => {});
    } catch {}
  }
}

async function toggleChecklistItem(key) {
  if (!currentUser || !checklistToday) return;
  const wasComplete = checklistIsComplete(checklistToday);
  const streakField = `${key}_streak`;
  const wasDone = !!checklistToday[`${key}_done`];

  checklistToday = { ...checklistToday, [`${key}_done`]: !wasDone };
  const nowComplete = checklistIsComplete(checklistToday);

  const payload = {
    user_id: currentUser.id,
    log_date: checklistToday.log_date,
    steps_done: checklistToday.steps_done,
    water_done: checklistToday.water_done,
    food_done: checklistToday.food_done,
    weight_done: checklistToday.weight_done,
  };

  // This item's own streak, independent of whether the other three are
  // also done today — extends yesterday's same-item streak on tick,
  // clears on untick, same pattern as the combined streak below.
  if (!wasDone) {
    const itemStreak = (checklistYesterday?.[streakField] ?? 0) + 1;
    checklistToday[streakField] = itemStreak;
    payload[streakField] = itemStreak;
  } else {
    checklistToday[streakField] = null;
    payload[streakField] = null;
  }

  if (nowComplete && !wasComplete) {
    // Just completed the day — lock in today's streak length, extending
    // yesterday's if that was also a complete day.
    const streak = (checklistYesterday?.streak_count ?? 0) + 1;
    checklistToday.streak_count = streak;
    payload.streak_count = streak;
    renderChecklist();
    await db.from('habit_checklist_log').upsert(payload, { onConflict: 'user_id,log_date' });
    await sendChecklistCompleteNotification(streak);
  } else if (!nowComplete && wasComplete) {
    // Un-ticked something after completing — clear today's streak
    // credit rather than leave a stale value from a day that's no
    // longer actually complete.
    checklistToday.streak_count = null;
    payload.streak_count = null;
    renderChecklist();
    await db.from('habit_checklist_log').upsert(payload, { onConflict: 'user_id,log_date' });
  } else {
    renderChecklist();
    await db.from('habit_checklist_log').upsert(payload, { onConflict: 'user_id,log_date' });
  }
}

el.checklistTiles?.addEventListener('click', (e) => {
  const tile = e.target.closest('.checklist-tile');
  if (tile) toggleChecklistItem(tile.dataset.key);
});

/* ═══ PEPTIDE PROTOCOLS (generic, multi-instance) ═══════════
   Deliberately generic rather than hardcoded to one peptide (the old
   BPC-157/Tirzepatide trackers each needed a rebuild whenever the
   protocol changed) — reads every peptide_protocols row for this user
   (name, start date, phase schedule) and renders ONE accordion per row,
   so adding/finishing a peptide is a data change, not new code. A
   completed course (its own day past its own last defined phase day)
   starts collapsed, same as BPC-157's history-only accordion always
   has, but stays fully expandable — nothing is ever hidden outright,
   only closed by default. */
const PEPTIDE_SITE_LABELS = {
  left_thigh: 'left thigh', right_thigh: 'right thigh',
  left_stomach: 'left stomach', right_stomach: 'right stomach',
  centre_stomach: 'centre stomach',
};
const PEPTIDE_SITE_ORDER = ['left_thigh', 'right_thigh', 'left_stomach', 'right_stomach', 'centre_stomach'];
function peptideSiteLabel(site) { return PEPTIDE_SITE_LABELS[site] || site || ''; }
function peptideNextSite(lastSite) {
  const idx = PEPTIDE_SITE_ORDER.indexOf(lastSite);
  return PEPTIDE_SITE_ORDER[(idx + 1) % PEPTIDE_SITE_ORDER.length];
}

// Day 1 = the protocol's own start_date (inclusive) — matches the
// server-side reminder's dayNumber() in notify-peptide.js exactly, so
// the in-app phase/day display never disagrees with what the push
// notification says.
function peptideDayNumber(protocol) {
  const start = new Date(protocol.start_date + 'T00:00:00');
  const today = new Date(todayISO() + 'T00:00:00');
  return Math.round((today - start) / 86400000) + 1;
}
function peptideCurrentPhase(protocol, day) {
  return protocol.phases.find(p => day >= p.day_start && day <= p.day_end) || null;
}
function peptideLastPhaseDay(protocol) {
  return protocol.phases?.length ? Math.max(...protocol.phases.map(p => p.day_end)) : null;
}
function peptideProtocolIsComplete(protocol) {
  const lastPhaseDay = peptideLastPhaseDay(protocol);
  return lastPhaseDay != null && peptideDayNumber(protocol) > lastPhaseDay;
}

// Projects whether what's left in the cartridge actually covers the rest
// of the defined titration/dosage plan — walks forward day by day from
// tomorrow through the last defined phase day, summing what each day's
// scheduled dose would cost. Generic over any protocol's phases array,
// so this works for whatever peptide/pen gets set up next, not just
// today's. Returns null when there's nothing to project against (no
// cartridge size on file, or no phase schedule at all).
function peptidePlanCoverage(protocol, remainingMg, day) {
  if (protocol.cartridge_mg == null || !protocol.phases?.length) return null;
  const lastPhaseDay = peptideLastPhaseDay(protocol);
  // Nothing left to project once the defined schedule has already run
  // its course — "covers the rest of your plan through day 10" reads as
  // stale/confusing once day 10 was 5 days ago and dosing is continuing
  // past it on whatever's left in the vial.
  if (day > lastPhaseDay) return null;
  let mgNeeded = 0;
  let runsOutOnDay = null;
  let cursor = remainingMg;
  for (let d = day + 1; d <= lastPhaseDay; d++) {
    const phase = peptideCurrentPhase(protocol, d);
    if (!phase) continue; // a gap in the schedule — nothing owed that day
    mgNeeded += phase.dose_mg;
    if (runsOutOnDay == null) {
      cursor -= phase.dose_mg;
      if (cursor < 0) runsOutOnDay = d;
    }
  }
  const shortfallMg = Math.max(0, mgNeeded - remainingMg);
  return { mgNeeded, shortfallMg, runsOutOnDay, lastPhaseDay, coversRestOfPlan: shortfallMg <= 0 };
}

let peptideProtocolsData = []; // [{id, name, start_date, phases, cartridge_mg, is_active, doses:[...]}]
const peptideChartState = {}; // protocol id -> { geom, inspectMs } — per-instance, since several charts coexist

async function fetchPeptideProtocols() {
  if (!currentUser) { peptideProtocolsData = []; return; }
  // Deliberately NOT filtered to is_active, and NOT limited to one row —
  // is_active only exists to stop notify-peptide.js's push reminders
  // once a titration schedule runs out, it was never meant to control
  // what the tracker shows (see the fix history on this). Every protocol
  // row this user has ever had gets its own accordion; "protocol
  // complete" is communicated per-instance via peptideProtocolIsComplete.
  const { data: protocols } = await db.from('peptide_protocols')
    .select('id, name, start_date, phases, cartridge_mg, is_active')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false });
  if (!protocols?.length) { peptideProtocolsData = []; return; }

  const ids = protocols.map(p => p.id);
  const { data: doses } = await db.from('peptide_doses')
    .select('id, protocol_id, dose_mg, units, site, injected_at')
    .in('protocol_id', ids)
    .order('injected_at', { ascending: false });
  const dosesByProtocol = {};
  (doses || []).forEach(d => { (dosesByProtocol[d.protocol_id] = dosesByProtocol[d.protocol_id] || []).push(d); });

  peptideProtocolsData = protocols.map(p => ({ ...p, doses: dosesByProtocol[p.id] || [] }));
}

/* ═══ Estimated-level chart engine (shared by every protocol) ═══
   Mirrors the Tirzepatide levels chart's model (a two-compartment
   absorption/elimination curve, doses superposing linearly), but with
   short-acting-peptide rate constants instead of Tirzepatide's 5-day
   half-life — most research peptides dosed this way (SS-31/elamipretide,
   MOTS-C) publish a terminal half-life on the order of hours with a
   peak within an hour or two, so levels clear close to zero between
   doses rather than building toward a slow steady state the way
   Tirzepatide does. Approximate, generic-literature rate constants, not
   a measured or clinical value — same "not medical advice" caveat as
   the rest of this engine.

   The future projection also differs from Tirzepatide's: Tirzepatide
   has no defined schedule, so it just repeats the last real dose
   weekly. Every protocol tracked here already has a real day-by-day
   dosing plan on file (protocol.phases), so the projection uses the
   ACTUAL scheduled dose for each remaining day instead of assuming the
   dose (or cadence) never changes. */
const PEPTIDE_KE_PER_HOUR = Math.log(2) / 6; // 6h terminal half-life
// Solved numerically so Tmax = ln(ka/ke)/(ka-ke) = 1h exactly, given
// PEPTIDE_KE_PER_HOUR above — same bisection approach as TZ_KA_PER_HOUR.
const PEPTIDE_KA_PER_HOUR = 3.53710571918688;
const PEPTIDE_PEAK_HOURS = 1;
function peptideDoseShape(hoursSince) {
  if (hoursSince < 0) return 0;
  return Math.exp(-PEPTIDE_KE_PER_HOUR * hoursSince) - Math.exp(-PEPTIDE_KA_PER_HOUR * hoursSince);
}
const PEPTIDE_SHAPE_AT_PEAK = peptideDoseShape(PEPTIDE_PEAK_HOURS);
function peptideLevelAt(doses, atMs) {
  let total = 0;
  for (const d of doses) {
    const hoursSince = (atMs - d.injectedMs) / 3600000;
    if (hoursSince < 0) continue;
    total += d.doseMg * (peptideDoseShape(hoursSince) / PEPTIDE_SHAPE_AT_PEAK);
  }
  return total;
}

function msFromLocalMidnight(ms) {
  const d = new Date(ms);
  return ms - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// "If the plan continues" — one projected dose per remaining scheduled
// day, at whatever that day's phase actually calls for (so a twice-a-
// week cadence with rest days in between projects correctly, not just a
// daily schedule), timed to the same time-of-day as the most recent
// real dose (or midday, if there's no dose history yet at all) so the
// projected spikes land where doses actually tend to happen rather than
// always at midnight.
function peptideRoutineDoses(protocol, sortedRealDoses, windowEnd) {
  if (!protocol?.phases?.length) return [];
  const day = peptideDayNumber(protocol);
  const lastPhaseDay = peptideLastPhaseDay(protocol);
  const start = new Date(protocol.start_date + 'T00:00:00');
  const lastReal = sortedRealDoses[sortedRealDoses.length - 1];
  const timeOfDayMs = lastReal ? msFromLocalMidnight(lastReal.injectedMs) : 12 * 3600000;
  const routine = [];
  for (let d = day + 1; d <= lastPhaseDay; d++) {
    const phase = peptideCurrentPhase(protocol, d);
    if (!phase) continue;
    const injectedMs = start.getTime() + (d - 1) * 86400000 + timeOfDayMs;
    if (injectedMs > windowEnd) break;
    routine.push({ doseMg: phase.dose_mg, injectedMs });
  }
  return routine;
}

// `state` is the caller's own {geom, inspectMs} slot (see
// peptideChartState) — passed in explicitly rather than read off a
// module global, since several of these charts render at once.
function drawPeptideChart(canvas, emptyEl, doses, protocol, state) {
  if (!canvas) return;
  if (!doses.length) {
    if (emptyEl) emptyEl.hidden = false;
    canvas.hidden = true;
    state.geom = null;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  canvas.hidden = false;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const MAX_W = 800, MAX_H = 260, MIN_W = 100;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rawW = canvas.parentElement?.clientWidth || 320;
  const rawH = parseInt(canvas.getAttribute('height')) || 200;
  const W = Math.min(MAX_W, Math.max(MIN_W, rawW));
  const H = Math.min(MAX_H, Math.max(120, rawH));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const now = Date.now();
  const sorted = [...doses].sort((a, b) => a.injectedMs - b.injectedMs);
  const windowStart = sorted[0].injectedMs;
  const dayMs = 24 * 3600000;
  const routineDoses = protocol ? peptideRoutineDoses(protocol, sorted, now + 60 * dayMs) : [];
  // At least a couple of days of runway past "now" so the decay after
  // the most recent dose is visible even once the plan itself is done.
  const lastProjected = routineDoses.length ? routineDoses[routineDoses.length - 1].injectedMs : now;
  const windowEnd = Math.max(now + 2 * dayMs, lastProjected + dayMs);
  const projectionDoses = [...sorted, ...routineDoses];

  const STEP_MS = 30 * 60 * 1000; // 30min resolution — a short half-life needs finer steps than Tirzepatide's 3h
  const pastPts = [];
  for (let t = windowStart; t <= now; t += STEP_MS) pastPts.push({ ms: t, v: peptideLevelAt(sorted, t) });
  pastPts.push({ ms: now, v: peptideLevelAt(sorted, now) });
  const futurePts = [];
  for (let t = now; t <= windowEnd; t += STEP_MS) futurePts.push({ ms: t, v: peptideLevelAt(projectionDoses, t) });
  futurePts.push({ ms: windowEnd, v: peptideLevelAt(projectionDoses, windowEnd) });

  const allVals = [...pastPts, ...futurePts].map(p => p.v);
  const vMax = Math.max(1, ...allVals) * 1.15;

  const padL = 30, padR = 8, padTop = 8, padBottom = 18;
  const plotW = W - padL - padR, plotH = H - padTop - padBottom;
  const xAt = ms => padL + ((ms - windowStart) / (windowEnd - windowStart)) * plotW;
  const yAt = v => padTop + plotH - (v / vMax) * plotH;

  state.geom = { windowStart, windowEnd, padL, padR, plotW, padTop, plotH };

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  const step = vMax > 6 ? 2 : vMax > 2 ? 1 : 0.5;
  for (let v = 0; v <= vMax; v += step) {
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(fmt1(v), padL - 4, y + 3);
  }

  ctx.textAlign = 'center';
  const totalDays = (windowEnd - windowStart) / dayMs;
  const tickEvery = totalDays > 14 ? 3 : 1;
  for (let t = windowStart; t <= windowEnd; t += tickEvery * dayMs) {
    ctx.fillText(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }), xAt(t), H - 4);
  }

  const xNow = xAt(now);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(xNow, padTop); ctx.lineTo(xNow, padTop + plotH); ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = '#3B9EFF';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pastPts.forEach((p, i) => { const x = xAt(p.ms), y = yAt(p.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  ctx.strokeStyle = 'rgba(59, 158, 255, 0.65)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  futurePts.forEach((p, i) => { const x = xAt(p.ms), y = yAt(p.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#3B9EFF';
  sorted.forEach(d => {
    const x = xAt(d.injectedMs), y = yAt(peptideLevelAt(sorted, d.injectedMs));
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  });

  ctx.strokeStyle = 'rgba(59, 158, 255, 0.65)';
  ctx.lineWidth = 1.5;
  routineDoses.forEach(d => {
    const x = xAt(d.injectedMs), y = yAt(peptideLevelAt(projectionDoses, d.injectedMs));
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke();
  });

  if (state.inspectMs != null) {
    const ix = xAt(state.inspectMs);
    ctx.strokeStyle = 'rgba(245, 166, 35, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ix, padTop); ctx.lineTo(ix, padTop + plotH); ctx.stroke();
    ctx.setLineDash([]);

    const iy = yAt(peptideLevelAt(projectionDoses, state.inspectMs));
    ctx.fillStyle = '#F5A623';
    ctx.beginPath(); ctx.arc(ix, iy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a1d24'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function peptideChartXToMs(geom, x) {
  if (!geom) return null;
  const { windowStart, windowEnd, padL, plotW } = geom;
  const frac = (x - padL) / plotW;
  return windowStart + frac * (windowEnd - windowStart);
}

function updatePeptideInspectPanel(protocol, sortedDoses) {
  const panel = $(`peptideInspect-${protocol.id}`);
  if (!panel) return;
  const state = peptideChartState[protocol.id];
  if (state?.inspectMs == null || !sortedDoses?.length || !state?.geom) {
    panel.hidden = true;
    return;
  }
  const routineDoses = peptideRoutineDoses(protocol, sortedDoses, state.geom.windowEnd);
  const level = peptideLevelAt([...sortedDoses, ...routineDoses], state.inspectMs);
  const dateLabel = new Date(state.inspectMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const tense = state.inspectMs > Date.now() ? 'projected' : 'estimated';
  panel.hidden = false;
  panel.innerHTML = `<span class="tz-inspect-panel__value">${fmt1(level)} mg</span><span class="tz-inspect-panel__label">${tense} level — ${dateLabel}</span>`;
}

function peptideProtocolAccordionHtml(protocol) {
  const complete = peptideProtocolIsComplete(protocol);
  const startsOpen = !complete;
  const badgeClass = complete ? 'peptide-status-badge--completed' : 'peptide-status-badge--active';
  const badgeLabel = complete ? 'Completed' : 'Active';
  const bodyId = `peptideBody-${protocol.id}`;
  return `
    <div class="peptide-accordion">
      <button type="button" class="peptide-accordion__header" data-protocol-header="${protocol.id}">
        <span class="peptide-accordion__name">${escapeHtml(protocol.name)}</span>
        <span class="peptide-status-badge ${badgeClass}">${badgeLabel}</span>
        <span class="peptide-accordion__chevron">${startsOpen ? '▾' : '▸'}</span>
      </button>
      <div class="peptide-accordion__body" id="${bodyId}"${startsOpen ? '' : ' hidden'}>
        <div class="chart-wrap">
          <canvas id="peptideChart-${protocol.id}" height="200"></canvas>
          <p class="chart-empty" id="peptideChartEmpty-${protocol.id}" hidden>Log a dose to see estimated levels.</p>
        </div>
        <div class="history-legend">
          <span class="legend-item legend-item--actual">— Logged level</span>
          <span class="legend-item legend-item--proj">- - If the plan continues</span>
          <span class="legend-item legend-item--tz-preview">● Tap the chart to inspect a day</span>
        </div>
        <div id="peptideCurrentLevel-${protocol.id}" class="tz-current-level" hidden></div>
        <div id="peptideInspect-${protocol.id}" class="tz-inspect-panel" hidden></div>
        <div class="peptide-today">
          <div class="peptide-today__phase" id="peptidePhase-${protocol.id}">—</div>
          <div class="peptide-today__dose-row">
            <span class="peptide-today__dose" id="peptideDoseToday-${protocol.id}">—</span>
            <button type="button" class="btn btn--primary btn--small" id="peptideBtnLog-${protocol.id}" data-protocol-log="${protocol.id}">Log today's dose</button>
          </div>
          <span class="peptide-logged-badge" id="peptideLoggedBadge-${protocol.id}" hidden>✓ Logged today</span>
        </div>
        <div class="peptide-remaining" id="peptideRemaining-${protocol.id}" hidden>
          <div class="peptide-remaining__row"><span id="peptideRemainingText-${protocol.id}">—</span></div>
          <div class="peptide-remaining__bar"><div class="peptide-remaining__bar-fill" id="peptideRemainingBarFill-${protocol.id}"></div></div>
        </div>
        <p class="peptide-plan-coverage" id="peptidePlanCoverage-${protocol.id}" hidden></p>
        <div class="peptide-titration" id="peptideTitration-${protocol.id}"></div>
        <div class="peptide-history" id="peptideHistory-${protocol.id}"></div>
      </div>
    </div>`;
}

function renderPeptideProtocols() {
  const container = el.peptideProtocolsContainer;
  if (!container) return;
  if (!peptideProtocolsData.length) { container.innerHTML = ''; return; }

  container.innerHTML = peptideProtocolsData.map(peptideProtocolAccordionHtml).join('');

  container.querySelectorAll('[data-protocol-header]').forEach(header => {
    header.addEventListener('click', () => {
      const body = $(`peptideBody-${header.dataset.protocolHeader}`);
      if (!body) return;
      body.hidden = !body.hidden;
      const chevron = header.querySelector('.peptide-accordion__chevron');
      if (chevron) chevron.textContent = body.hidden ? '▸' : '▾';
    });
  });
  container.querySelectorAll('[data-protocol-log]').forEach(btn => {
    btn.addEventListener('click', () => logPeptideDose(btn.dataset.protocolLog));
  });

  peptideProtocolsData.forEach(renderPeptideProtocolInstance);
}

function renderPeptideProtocolInstance(protocol) {
  const day = peptideDayNumber(protocol);
  const phase = peptideCurrentPhase(protocol, day);
  const todayStr = todayISO();
  const doses = protocol.doses || [];
  const loggedToday = doses.some(d => d.injected_at.slice(0, 10) === todayStr);

  const phaseEl = $(`peptidePhase-${protocol.id}`);
  const doseTodayEl = $(`peptideDoseToday-${protocol.id}`);
  const logBtn = $(`peptideBtnLog-${protocol.id}`);
  const loggedBadge = $(`peptideLoggedBadge-${protocol.id}`);
  if (!phase) {
    if (phaseEl) phaseEl.textContent = `Day ${day} — no dose scheduled`;
    if (doseTodayEl) doseTodayEl.textContent = '—';
    if (logBtn) logBtn.hidden = true;
  } else {
    if (phaseEl) phaseEl.textContent = `Day ${day} — ${phase.label}`;
    if (doseTodayEl) doseTodayEl.textContent = `${fmt1(phase.dose_mg)}mg (${phase.units} units)`;
    if (logBtn) logBtn.hidden = loggedToday;
  }
  if (loggedBadge) loggedBadge.hidden = !loggedToday;

  let remainingMg = null;
  const remainingEl = $(`peptideRemaining-${protocol.id}`);
  if (remainingEl) {
    if (protocol.cartridge_mg != null) {
      const total = Number(protocol.cartridge_mg);
      const totalUsed = doses.reduce((sum, d) => sum + (Number(d.dose_mg) || 0), 0);
      remainingMg = Math.max(0, total - totalUsed);
      const pctUsed = total > 0 ? Math.min(100, (totalUsed / total) * 100) : 0;
      remainingEl.hidden = false;
      const textEl = $(`peptideRemainingText-${protocol.id}`);
      if (textEl) textEl.textContent = `${fmt1(remainingMg)}mg remaining of ${fmt1(total)}mg cartridge`;
      const barFill = $(`peptideRemainingBarFill-${protocol.id}`);
      if (barFill) barFill.style.width = `${pctUsed}%`;
      remainingEl.classList.toggle('peptide-remaining--empty', remainingMg <= 0);
    } else {
      remainingEl.hidden = true;
    }
  }

  const coverageEl = $(`peptidePlanCoverage-${protocol.id}`);
  if (coverageEl) {
    const coverage = remainingMg != null ? peptidePlanCoverage(protocol, remainingMg, day) : null;
    if (coverage) {
      coverageEl.hidden = false;
      if (coverage.coversRestOfPlan) {
        coverageEl.textContent = `✓ Covers the rest of your plan through day ${coverage.lastPhaseDay} (~${fmt1(coverage.mgNeeded)}mg needed).`;
        coverageEl.classList.remove('peptide-plan-coverage--short');
      } else {
        coverageEl.textContent = `⚠️ Won't cover the rest of your plan — runs out around day ${coverage.runsOutOnDay} of ${coverage.lastPhaseDay}, short by ~${fmt1(coverage.shortfallMg)}mg. Order a new cartridge.`;
        coverageEl.classList.add('peptide-plan-coverage--short');
      }
    } else {
      coverageEl.hidden = true;
    }
  }

  const titrationEl = $(`peptideTitration-${protocol.id}`);
  if (titrationEl) {
    titrationEl.innerHTML = (protocol.phases || []).map(p => {
      const isCurrent = phase && p === phase;
      const isPast = day > p.day_end;
      const dayRange = p.day_start === p.day_end ? `Day ${p.day_start}` : `Days ${p.day_start}–${p.day_end}`;
      return `
        <div class="peptide-titration__row${isCurrent ? ' peptide-titration__row--current' : ''}${isPast ? ' peptide-titration__row--past' : ''}">
          <span class="peptide-titration__label">${escapeHtml(p.label)}</span>
          <span class="peptide-titration__days">${dayRange}</span>
          <span class="peptide-titration__dose">${fmt1(p.dose_mg)}mg · ${p.units}u</span>
        </div>`;
    }).join('');
  }

  const historyEl = $(`peptideHistory-${protocol.id}`);
  if (historyEl) {
    historyEl.innerHTML = doses.length
      ? doses.slice(0, 15).map(d => `
          <div class="peptide-history__row">
            <span class="peptide-history__date">${new Date(d.injected_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <span class="peptide-history__detail">${fmt1(Number(d.dose_mg))}mg${d.site ? ' · ' + peptideSiteLabel(d.site) : ''}</span>
          </div>`).join('')
      : '<p class="empty-state">No doses logged yet.</p>';
  }

  if (!peptideChartState[protocol.id]) peptideChartState[protocol.id] = { geom: null, inspectMs: null };
  const state = peptideChartState[protocol.id];
  const canvas = $(`peptideChart-${protocol.id}`);
  const emptyEl = $(`peptideChartEmpty-${protocol.id}`);
  const sortedForChart = doses
    .map(d => ({ doseMg: Number(d.dose_mg), injectedMs: new Date(d.injected_at).getTime() }))
    .sort((a, b) => a.injectedMs - b.injectedMs);
  drawPeptideChart(canvas, emptyEl, sortedForChart, protocol, state);

  const currentLevelEl = $(`peptideCurrentLevel-${protocol.id}`);
  if (currentLevelEl) {
    if (sortedForChart.length) {
      const currentLevel = peptideLevelAt(sortedForChart, Date.now());
      currentLevelEl.hidden = false;
      currentLevelEl.innerHTML = `<span class="tz-current-level__value">${fmt1(currentLevel)} mg</span><span class="tz-current-level__label">estimated level now</span>`;
    } else {
      currentLevelEl.hidden = true;
    }
  }
  updatePeptideInspectPanel(protocol, sortedForChart);

  if (canvas && !canvas.dataset.wired) {
    canvas.dataset.wired = '1';
    canvas.addEventListener('click', (e) => {
      const st = peptideChartState[protocol.id];
      if (!st?.geom) return;
      const rect = canvas.getBoundingClientRect();
      const ms = peptideChartXToMs(st.geom, e.clientX - rect.left);
      if (ms == null) return;
      st.inspectMs = Math.min(st.geom.windowEnd, Math.max(st.geom.windowStart, ms));
      renderPeptideProtocolInstance(protocol);
    });
  }
}

async function logPeptideDose(protocolId) {
  if (!currentUser) return;
  const protocol = peptideProtocolsData.find(p => p.id === protocolId);
  if (!protocol) return;
  const day = peptideDayNumber(protocol);
  const phase = peptideCurrentPhase(protocol, day);
  if (!phase) return;

  const doses = protocol.doses || []; // already sorted newest-first from fetchPeptideProtocols
  const site = peptideNextSite(doses[0]?.site);
  const btn = $(`peptideBtnLog-${protocol.id}`);
  setBtn(btn, true, "Log today's dose");
  const { error } = await db.from('peptide_doses').insert({
    user_id: currentUser.id,
    protocol_id: protocol.id,
    dose_mg: phase.dose_mg,
    units: phase.units,
    site,
  });
  setBtn(btn, false, "Log today's dose");

  if (error) { showToast('Could not log dose: ' + error.message, true); return; }
  showToast(`Logged ${fmt1(phase.dose_mg)}mg (${peptideSiteLabel(site)}).`);
  await fetchPeptideProtocols();
  renderPeptideProtocols();
}

/* ═══ DAILY ORAL MEDS (finasteride, minoxidil, etc.) ═══════════
   Deliberately much simpler than the peptide accordion above — a plain
   daily pill has no injection site, no cartridge to track remaining
   volume against, no titration phases. Just "did I take it today" plus
   a short recent-history list. */
let oralMedsData = [];

async function fetchOralMeds() {
  if (!currentUser) { oralMedsData = []; return; }
  const { data: meds } = await db.from('oral_meds')
    .select('id, name, dose_mg, is_active')
    .eq('user_id', currentUser.id)
    .eq('is_active', true)
    .order('created_at', { ascending: true });
  if (!meds?.length) { oralMedsData = []; return; }

  const ids = meds.map(m => m.id);
  const { data: doses } = await db.from('oral_med_doses')
    .select('id, med_id, taken_at')
    .in('med_id', ids)
    .order('taken_at', { ascending: false })
    .limit(200);
  const dosesByMed = {};
  (doses || []).forEach(d => { (dosesByMed[d.med_id] = dosesByMed[d.med_id] || []).push(d); });

  oralMedsData = meds.map(m => ({ ...m, doses: dosesByMed[m.id] || [] }));
}

function oralMedAccordionHtml(med) {
  const bodyId = `oralMedBody-${med.id}`;
  return `
    <div class="peptide-accordion">
      <button type="button" class="peptide-accordion__header" data-oral-med-header="${med.id}">
        <span class="peptide-accordion__name">${escapeHtml(med.name)}</span>
        <span class="peptide-status-badge peptide-status-badge--active">${fmt1(med.dose_mg)}mg</span>
        <span class="peptide-accordion__chevron">▾</span>
      </button>
      <div class="peptide-accordion__body" id="${bodyId}">
        <div class="peptide-today__dose-row">
          <span class="peptide-today__dose">${fmt1(med.dose_mg)}mg</span>
          <button type="button" class="btn btn--primary btn--small" id="oralMedBtnLog-${med.id}" data-oral-med-log="${med.id}">Log today's dose</button>
        </div>
        <span class="peptide-logged-badge" id="oralMedLoggedBadge-${med.id}" hidden>✓ Logged today</span>
        <div class="peptide-history" id="oralMedHistory-${med.id}"></div>
      </div>
    </div>`;
}

function renderOralMeds() {
  const container = el.oralMedsContainer;
  if (!container) return;
  if (!oralMedsData.length) { container.innerHTML = ''; return; }

  container.innerHTML = oralMedsData.map(oralMedAccordionHtml).join('');

  container.querySelectorAll('[data-oral-med-header]').forEach(header => {
    header.addEventListener('click', () => {
      const body = $(`oralMedBody-${header.dataset.oralMedHeader}`);
      if (!body) return;
      body.hidden = !body.hidden;
      const chevron = header.querySelector('.peptide-accordion__chevron');
      if (chevron) chevron.textContent = body.hidden ? '▸' : '▾';
    });
  });
  container.querySelectorAll('[data-oral-med-log]').forEach(btn => {
    btn.addEventListener('click', () => logOralMedDose(btn.dataset.oralMedLog));
  });

  oralMedsData.forEach(renderOralMedInstance);
}

function renderOralMedInstance(med) {
  const todayStr = todayISO();
  const doses = med.doses || [];
  const loggedToday = doses.some(d => d.taken_at.slice(0, 10) === todayStr);

  const logBtn = $(`oralMedBtnLog-${med.id}`);
  const loggedBadge = $(`oralMedLoggedBadge-${med.id}`);
  if (logBtn) logBtn.hidden = loggedToday;
  if (loggedBadge) loggedBadge.hidden = !loggedToday;

  const historyEl = $(`oralMedHistory-${med.id}`);
  if (historyEl) {
    historyEl.innerHTML = doses.slice(0, 14).map(d => `
      <div class="peptide-history__row">
        <span class="peptide-history__date">${new Date(d.taken_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
        <span>${fmt1(med.dose_mg)}mg</span>
      </div>`).join('') || '<p class="empty-state">No doses logged yet.</p>';
  }
}

async function logOralMedDose(medId) {
  if (!currentUser) return;
  const med = oralMedsData.find(m => m.id === medId);
  if (!med) return;

  const btn = $(`oralMedBtnLog-${med.id}`);
  setBtn(btn, true, "Log today's dose");
  const { error } = await db.from('oral_med_doses').insert({
    user_id: currentUser.id,
    med_id: med.id,
  });
  setBtn(btn, false, "Log today's dose");

  if (error) { showToast('Could not log dose: ' + error.message, true); return; }
  showToast(`Logged ${med.name} ${fmt1(med.dose_mg)}mg.`);
  await fetchOralMeds();
  renderOralMeds();
}

function renderScoreGauges(scores) {
  if (!el.scoreCarousel) return;
  dashScoresData = scores;

  const hasAny = Object.values(scores).some(s => s?.score != null);
  el.scoreCarousel.hidden = !hasAny;
  if (el.scoreCarouselEmpty) el.scoreCarouselEmpty.hidden = hasAny;
  if (!hasAny) {
    if (el.scoreDetail) el.scoreDetail.hidden = true;
    return;
  }

  Object.keys(SCORE_META).forEach(key => setScoreGauge(key, scores[key]?.score));

  // Keep the detail panel in sync if it's open on a gauge that just refreshed
  const openKey = el.scoreDetail && !el.scoreDetail.hidden ? el.scoreDetail.dataset.key : null;
  if (openKey) showScoreDetail(openKey);
}

function showScoreDetail(key) {
  const s = dashScoresData?.[key];
  const meta = SCORE_META[key];
  if (!s || s.score == null || !el.scoreDetail) return;
  el.scoreDetail.hidden = false;
  el.scoreDetail.dataset.key = key;
  el.scoreDetailLabel.textContent = `${meta.icon} ${meta.label} — ${formatScoreVal(key, s.score)}`;
  el.scoreDetailMeta.textContent = s.label;
  el.scoreDetailFactors.innerHTML = s.factors.map(f => `
    <div class="battery-factor">
      <span class="battery-factor__label">${f.label}</span>
      <div class="battery-factor__bar">
        <div class="battery-factor__fill battery-factor__fill--${f.cls}" style="width:${f.pct}%"></div>
      </div>
      <span class="battery-factor__val">${f.val}</span>
    </div>`).join('');
}

el.scoreCarousel?.addEventListener('click', (e) => {
  const btn = e.target.closest('.score-gauge');
  if (btn) showScoreDetail(btn.dataset.key);
});
el.scoreDetailClose?.addEventListener('click', () => { el.scoreDetail.hidden = true; });

/* ═══════════════════════════════════════════════════════════
   HEALTH TILES
═══════════════════════════════════════════════════════════ */
function drawSparkline(canvasId, data, opts = {}) {
  const canvas = $(canvasId);
  if (!canvas || !data?.length) return;

  // Hard size limits — can never expand uncontrolled
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const W   = Math.min(300, Math.max(40, canvas.offsetWidth  || 80));
  const H   = Math.min(80,  Math.max(16, canvas.offsetHeight || 28));

  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Filter out non-finite values
  const vals = data.map(d => Number(d)).filter(v => isFinite(v));
  if (vals.length < 2) return;

  const min   = opts.min ?? Math.min(...vals);
  const max   = opts.max ?? Math.max(...vals);
  const range = (max - min) || 1;
  const pad   = 2;

  const x = i => pad + (i / (vals.length - 1)) * (W - pad * 2);
  const y = v => H - pad - ((v - min) / range) * (H - pad * 2);

  // Fill
  ctx.beginPath();
  ctx.moveTo(x(0), H);
  vals.forEach((v, i) => ctx.lineTo(x(i), y(v)));
  ctx.lineTo(x(vals.length - 1), H);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, opts.fillTop    || 'rgba(59,127,245,.2)');
  grad.addColorStop(1, opts.fillBottom || 'rgba(59,127,245,0)');
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  vals.forEach((v, i) => i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)));
  ctx.strokeStyle = opts.stroke || 'var(--blue)';
  ctx.lineWidth   = 1.5;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Last dot
  const lx = x(vals.length - 1), ly = y(vals[vals.length - 1]);
  ctx.beginPath();
  ctx.arc(lx, ly, 2.5, 0, Math.PI * 2);
  ctx.fillStyle = opts.stroke || '#3B7FF5';
  ctx.fill();
}

function setTileState(tileId, state) {
  const tile = $(tileId);
  if (!tile) return;
  tile.classList.remove('health-tile--good', 'health-tile--warn', 'health-tile--alert');
  if (state) tile.classList.add(`health-tile--${state}`);
}

function renderHealthTiles(today, history) {
  const hasAny = today && Object.values(today).some(v => v != null && v !== today.log_date);

  if (!hasAny) {
    el.healthTiles.style.display    = 'none';
    el.healthTilesEmpty.style.display = 'block';
    return;
  }

  el.healthTiles.style.display    = 'grid';
  el.healthTilesEmpty.style.display = 'none';
  if (today?.log_date) el.healthTilesDate.textContent = fmtDate(today.log_date);

  // Helper — extract field from history array
  const hist = (field) => history.map(h => h[field]).filter(v => v != null);

  // Helper — show/hide a tile based on whether any data exists
  function showTile(tileId, hasData) {
    const t = $(tileId);
    if (t) t.hidden = !hasData;
  }

  // Each tile: show only if data exists in today or history

  // ── SpO2 ─────────────────────────────────────────────────
  const spo2 = today?.spo2_avg;
  const spo2Hist = hist('spo2_avg');
  showTile('tileSpo2', spo2 != null || spo2Hist.length > 0);
  $('tileSpo2Val').textContent = spo2 != null ? fmt1(spo2) : '—';
  setTileState('tileSpo2',
    spo2 == null ? null : spo2 >= 95 ? 'good' : spo2 >= 90 ? 'warn' : 'alert'
  );
  if (spo2Hist.length) drawSparkline('sparkSpo2', spo2Hist, {
    min: 90, max: 100,
    stroke: spo2 >= 95 ? '#16A34A' : spo2 >= 90 ? '#EA580C' : '#DC2626',
    fillTop: spo2 >= 95 ? 'rgba(22,163,74,.2)' : 'rgba(234,88,12,.2)',
    fillBottom: 'rgba(22,163,74,0)',
  });

  // ── Respiratory Rate ─────────────────────────────────────
  const resp = today?.respiratory_rate;
  const respHist = hist('respiratory_rate');
  showTile('tileResp', resp != null || respHist.length > 0);
  $('tileRespVal').textContent = resp != null ? fmt1(resp) : '—';
  setTileState('tileResp',
    resp == null ? null :
    resp >= 12 && resp <= 20 ? 'good' :
    resp >= 10 && resp <= 22 ? 'warn' : 'alert'
  );
  if (respHist.length) drawSparkline('sparkResp', respHist, {
    min: 10, max: 25, stroke: '#3B7FF5',
    fillTop: 'rgba(59,127,245,.2)', fillBottom: 'rgba(59,127,245,0)',
  });


  // ── VO2 Max ──────────────────────────────────────────────
  // Apple Watch doesn't measure VO2 Max every day — fall back to the most
  // recent recorded value (last element, since hist() returns oldest-first)
  // rather than showing blank on days without a fresh measurement.
  const vo2Hist = hist('vo2_max');
  const vo2 = today?.vo2_max ?? (vo2Hist.length ? vo2Hist[vo2Hist.length - 1] : null);
  showTile('tileVo2', vo2 != null || vo2Hist.length > 0);
  $('tileVo2Val').textContent = vo2 != null ? fmt1(vo2) : '—';
  setTileState('tileVo2',
    vo2 == null ? null : vo2 >= 42 ? 'good' : vo2 >= 35 ? 'warn' : 'alert'
  );
  if (vo2Hist.length) drawSparkline('sparkVo2', vo2Hist, {
    stroke: '#7C3AED',
    fillTop: 'rgba(124,58,237,.2)', fillBottom: 'rgba(124,58,237,0)',
  });

  // ── Heart Rate Recovery ────────────────────────────────────
  // Only exists on days with a tracked workout (watchOS 11+/Ultra 2+) —
  // same last-known-value fallback as VO2 Max above rather than blanking
  // out on rest days. Threshold is the actual published clinical cutoff
  // (Cole et al., NEJM 1999): <12bpm drop at 1min is associated with
  // meaningfully higher cardiovascular risk, not an arbitrary tier.
  const hrrHist = hist('hr_recovery_bpm');
  const hrr = today?.hr_recovery_bpm ?? (hrrHist.length ? hrrHist[hrrHist.length - 1] : null);
  showTile('tileHrr', hrr != null || hrrHist.length > 0);
  $('tileHrrVal').textContent = hrr != null ? Math.round(hrr) : '—';
  setTileState('tileHrr',
    hrr == null ? null : hrr >= 18 ? 'good' : hrr >= 12 ? 'warn' : 'alert'
  );
  if (hrrHist.length) drawSparkline('sparkHrr', hrrHist, {
    stroke: '#F97316',
    fillTop: 'rgba(249,115,22,.2)', fillBottom: 'rgba(249,115,22,0)',
  });

  // ── Average Heart Rate ─────────────────────────────────────
  // No good/warn/alert thresholds applied here — unlike resting HR or VO2
  // Max, a whole-day average blends rest and activity together and has no
  // single established reference range, so a colored state would imply
  // false precision. The sparkline shows the trend instead.
  const hrAvg = today?.heart_rate_avg;
  const hrHist = hist('heart_rate_avg');
  showTile('tileHr', hrAvg != null || hrHist.length > 0);
  $('tileHrVal').textContent = hrAvg != null ? Math.round(hrAvg) : '—';
  if (hrHist.length) drawSparkline('sparkHr', hrHist, {
    stroke: '#DC2626',
    fillTop: 'rgba(220,38,38,.2)', fillBottom: 'rgba(220,38,38,0)',
  });

  // ── Blood Glucose — only show if health data exists AND diabetes
  // tracking is actually turned on (an incidental glucose reading from
  // some other source shouldn't surface a diabetes-specific tile for
  // someone who's said they don't want that feature at all).
  const glucose     = today?.glucose_avg_mmol;
  const glucoseHist = hist('glucose_avg_mmol');
  const diabetesOn  = profile?.diabetes_enabled !== false;
  showTile('tileGlucose', diabetesOn && (glucose != null || glucoseHist.length > 0));
  $('tileGlucoseVal').textContent = glucose != null ? fmt1(glucose) : '—';
  setTileState('tileGlucose',
    glucose == null ? null :
    glucose >= 4.0 && glucose <= 7.8 ? 'good' :
    glucose >= 3.5 && glucose <= 10  ? 'warn' : 'alert'
  );
  if (glucoseHist.length) drawSparkline('sparkGlucose', glucoseHist, {
    stroke: '#DC2626',
    fillTop: 'rgba(220,38,38,.2)', fillBottom: 'rgba(220,38,38,0)',
  });

  // ── Estimated HbA1c — from the last 7 days of observed blood glucose
  // (glucose_avg_mmol, synced from Apple Health's "Blood Glucose" —
  // Dexcom's own source on this account), via the ADAG study's
  // mean-glucose formula (mean mg/dL = 28.7×A1c − 46.7, rearranged to
  // solve for A1c). An estimate, not a lab result — needs a handful of
  // days of readings before it's worth showing at all. Colour-coded
  // against the ADA's non-diabetic cutoff (<5.7%) — inside that range is
  // "good", at or above it is flagged, independent of the tile's own
  // good/warn/alert state above (which tracks the live reading, not
  // this rolling estimate).
  const A1C_NON_DIABETIC_MAX = 5.7;
  const a1cTile = $('tileGlucoseA1c');
  if (a1cTile) {
    const sevenDaysAgoISO = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const glucose7d = history
      .filter(h => h.log_date >= sevenDaysAgoISO && h.glucose_avg_mmol != null)
      .map(h => Number(h.glucose_avg_mmol));
    if (diabetesOn && glucose7d.length >= 3) {
      const avgMmol = glucose7d.reduce((a, b) => a + b, 0) / glucose7d.length;
      const estA1c  = (avgMmol * 18.0182 + 46.7) / 28.7;
      const inRange = estA1c < A1C_NON_DIABETIC_MAX;
      a1cTile.textContent = `Est. A1c ${estA1c.toFixed(1)}% (${glucose7d.length}d)`;
      a1cTile.classList.toggle('health-tile__sub--good', inRange);
      a1cTile.classList.toggle('health-tile__sub--alert', !inRange);
      a1cTile.hidden = false;
    } else {
      a1cTile.hidden = true;
      a1cTile.classList.remove('health-tile__sub--good', 'health-tile__sub--alert');
    }
  }

  // ── Fitness Age — derived from VO2 Max ────────────────────
  // Uses the same resolved vo2 value (today's reading, or the last known
  // one) so this tile doesn't go blank on days VO2 itself doesn't.
  const fitnessAge   = vo2ToFitnessAge(vo2);
  const fitnessAgeHist = hist('vo2_max').map(v => vo2ToFitnessAge(v)).filter(v => v != null);

  showTile('tileFitnessAge', fitnessAge != null || fitnessAgeHist.length > 0);
  $('tileFitnessAgeVal').textContent = fitnessAge ?? '—';
  // Lower fitness age = better (green), higher = needs work (amber/red)
  setTileState('tileFitnessAge',
    fitnessAge == null ? null :
    fitnessAge <= 35   ? 'good' :
    fitnessAge <= 45   ? 'warn' : 'alert'
  );
  if (fitnessAgeHist.length) drawSparkline('sparkFitnessAge', fitnessAgeHist, {
    // Inverted — lower is better, so use green when trending down
    stroke: '#7C3AED',
    fillTop: 'rgba(124,58,237,.2)', fillBottom: 'rgba(124,58,237,0)',
  });

  // If ALL tiles hidden → show empty prompt
  const anyVisible = ['tileSpo2','tileResp','tileVo2','tileHr','tileGlucose','tileFitnessAge']
    .some(id => !$(id)?.hidden);
  if (!anyVisible) {
    el.healthTiles.style.display      = 'none';
    el.healthTilesEmpty.style.display = 'block';
  }
}

/* ═══════════════════════════════════════════════════════════
   NET CALORIES + WEEKLY DEFICIT
═══════════════════════════════════════════════════════════ */
function renderNetCalories(today, history, log, bmrFallback) {
  // Number() first — active_energy_kcal/resting_energy_kcal are Postgres
  // numeric columns, which can arrive as strings rather than JS numbers;
  // `(active || 0) + (resting || 0)` on two such strings concatenates
  // instead of adding ("600" + "1900" -> "6001900"), which then feeds
  // Math.round or a later `-` and produces a wildly wrong number rather
  // than an obviously-broken one (see the same fix in totalBurn/loadHistory).
  const activeRaw  = today?.active_energy_kcal ?? log?.active_energy_kcal;
  const restingRaw = today?.resting_energy_kcal ?? bmrFallback;
  const active  = activeRaw  != null ? Number(activeRaw)  : null;
  const resting = restingRaw != null ? Number(restingRaw) : null;
  const burned  = (active == null && resting == null) ? null
                : Math.round((active || 0) + (resting || 0));
  // If burn data is flowing but nothing eaten is logged yet, eaten = 0 (not yesterday's total)
  const consumed = pickConsumedCalories(log, today) ?? (burned != null ? 0 : null);

  // ── Burn breakdown ───────────────────────────────────────
  const burnActiveEl   = $('dBurnActive');
  const burnRestingEl  = $('dBurnResting');
  const burnTotalEl    = $('dBurnTotal');
  if (burnActiveEl)  burnActiveEl.textContent  = active  != null ? fmtInt(Math.round(active))  + ' kcal' : '—';
  if (burnRestingEl) burnRestingEl.textContent = resting != null ? fmtInt(Math.round(resting)) + ' kcal' : '—';
  if (burnTotalEl)   burnTotalEl.textContent   = burned  != null ? fmtInt(burned)               + ' kcal' : '—';

  // ── Today net ────────────────────────────────────────────
  const netEl    = $('dNetCals');
  const barFill  = $('dNetCalsBarFill');
  const breakdown = $('dNetCalsBreakdown');

  if (consumed != null && burned != null) {
    const net    = Math.round(consumed - burned);
    const isDeficit = net < 0;
    const mag = fmtInt(Math.abs(net));
    if (netEl) {
      netEl.textContent = mag;
      netEl.className = `net-cal-stat__val ${isDeficit ? 'net-cal-stat__val--deficit' : 'net-cal-stat__val--surplus'}`;
      const unitEl = netEl.parentElement?.querySelector('.net-cal-stat__unit');
      if (unitEl) unitEl.textContent = isDeficit ? 'kcal deficit' : 'kcal surplus';
    }
    const explainer = $('dBalanceExplainer');
    if (explainer) explainer.textContent = isDeficit
      ? `You've burned ${mag} kcal more than you've eaten today. That gap is a deficit — staying in one is what drives weight loss.`
      : `You've eaten ${mag} kcal more than you've burned today. That's a surplus — over time a surplus adds weight.`;
    if (breakdown) breakdown.textContent = `Eaten ${fmtInt(consumed)} · Burned ${fmtInt(burned)}`;

    // Bar: consumed / burned ratio. Bar width = consumed as % of burned.
    if (barFill) {
      const pct = Math.min(100, Math.max(0, (consumed / burned) * 100));
      barFill.style.width = pct + '%';
      barFill.className   = `net-cals-bar__fill ${isDeficit ? 'net-cals-bar__fill--deficit' : 'net-cals-bar__fill--surplus'}`;
    }
    // Zero marker at 100% = consumed equals burned
    const zeroMarker = $('dNetCalsBar')?.querySelector('.net-cals-bar__zero');
    if (zeroMarker) {
      const zeroPos = Math.min(98, Math.max(2, (consumed / burned) * 100));
      zeroMarker.style.left = zeroPos + '%';
    }
  } else {
    if (netEl)    netEl.textContent = '—';
    if (breakdown) breakdown.textContent = 'No calorie data yet today';
    const explainerEmpty = $('dBalanceExplainer');
    if (explainerEmpty) explainerEmpty.textContent = '';
  }

  // ── 7-day deficit ─────────────────────────────────────────
  const last7 = history.slice(-7);
  let weeklyNet = 0, weekDays = 0;
  last7.forEach(h => {
    const hActive   = h.active_energy_kcal  != null ? Number(h.active_energy_kcal)  : null;
    const hResting  = h.resting_energy_kcal != null ? Number(h.resting_energy_kcal) : null;
    const hBurned   = (hActive != null && hResting != null) ? hActive + hResting
                    : (hActive != null)                     ? hActive
                    : null;
    const hConsumedRaw = h.cal_fitl00p ?? h.cal_mfp ?? h.dietary_energy_kcal;
    const hConsumed = hConsumedRaw != null ? Number(hConsumedRaw) : null;
    if (hConsumed != null && hBurned != null) {
      weeklyNet += (hConsumed - hBurned);
      weekDays++;
    }
  });

  const weeklyEl  = $('dWeeklyDeficit');
  const fatLostEl = $('dFatLost');

  if (weekDays > 0) {
    const isWeekDeficit = weeklyNet < 0;
    if (weeklyEl) {
      weeklyEl.textContent = fmtInt(Math.round(Math.abs(weeklyNet)));
      weeklyEl.className   = `net-cal-stat__val ${isWeekDeficit ? 'net-cal-stat__val--deficit' : 'net-cal-stat__val--surplus'}`;
      const wUnit = weeklyEl.parentElement?.querySelector('.net-cal-stat__unit');
      if (wUnit) wUnit.textContent = isWeekDeficit ? 'kcal deficit' : 'kcal surplus';
    }
    // Fat equivalent: 7,700 kcal ≈ 1 kg body fat
    if (fatLostEl) {
      const fatKg = Math.abs(weeklyNet) / 7700;
      fatLostEl.textContent = fmt1(fatKg);
      fatLostEl.className   = `net-cal-stat__val ${isWeekDeficit ? 'net-cal-stat__val--deficit' : 'net-cal-stat__val--surplus'}`;
      const fUnit = fatLostEl.parentElement?.querySelector('.net-cal-stat__unit');
      if (fUnit) fUnit.textContent = isWeekDeficit ? 'kg lost' : 'kg gained';
    }
  } else {
    if (weeklyEl)  weeklyEl.textContent  = '—';
    if (fatLostEl) fatLostEl.textContent = '—';
  }

  return { consumed, burned };
}

// Pushes today's already-computed dashboard scores into the native
// ScoreWidgetBridge plugin (see ios/App/App/ScoreWidgetBridgePlugin.swift),
// which writes them into the shared App Group container for the Home/Lock
// Screen widgets and Watch complications to read — no separate scoring
// logic on the native side, just a mirror of whatever the dashboard just
// showed. A no-op on web/no native bridge, and inert until the widget
// extension target exists.
function pushScoresToWidgets({ recovery, sleep, strain, netCalories, steps, stepsGoal, sleepHours, sleepNeedHours, nutritionScore }) {
  const Bridge = window.Capacitor?.Plugins?.ScoreWidgetBridge;
  if (!Bridge) return;
  Bridge.writeScores({
    recovery: recovery?.score ?? null,
    sleep: sleep?.score ?? null,
    strain: strain?.score ?? null,
    netCaloriesKcal: (netCalories?.consumed != null && netCalories?.burned != null)
      ? Math.round(netCalories.consumed - netCalories.burned) : null,
    netCaloriesIsDeficit: (netCalories?.consumed != null && netCalories?.burned != null)
      ? (netCalories.consumed - netCalories.burned) < 0 : null,
    steps: steps ?? null,
    stepsGoal: stepsGoal ?? null,
    sleepHours: sleepHours ?? null,
    sleepNeedHours: sleepNeedHours ?? null,
    nutritionScore: nutritionScore ?? null,
    updatedAt: new Date().toISOString(),
  }).catch(err => console.warn('pushScoresToWidgets failed:', err));
}
async function loadLog() {
  const unit = BODY_WEIGHT_UNIT;
  el.logWeightUnit.textContent = unit;
  el.logDate.value = el.logDate.value || todayISO();

  await fetchAndRenderLog(el.logDate.value);
}

async function fetchAndRenderLog(date) {
  if (!currentUser) return;
  const { data } = await db
    .from('daily_logs')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('log_date', date)
    .maybeSingle();

  todayLog = data;
  const unit = BODY_WEIGHT_UNIT;
  const stepsGoal = profile?.steps_goal || 10000;

  el.logWeight.value  = data?.weight != null ? fmt1(weightFromKg(data.weight, unit)) : '';
  el.logSteps.value   = data?.steps       ?? '';
  el.logActiveCal.value = data?.active_energy_kcal ?? '';
  el.mBreakfast.value = data?.cal_breakfast ?? '';
  el.mLunch.value     = data?.cal_lunch     ?? '';
  el.mDinner.value    = data?.cal_dinner    ?? '';
  el.mSnacks.value    = data?.cal_snacks    ?? '';
  el.logNotes.value   = data?.notes         ?? '';

  el.stepsGoalLabel.textContent = stepsGoal.toLocaleString();

  updateCalTarget();
  updateLogBars();
}

el.logDate.addEventListener('change', () => fetchAndRenderLog(el.logDate.value));

function calcMealTotal() {
  return [el.mBreakfast, el.mLunch, el.mDinner, el.mSnacks]
    .map(i => parseFloat(i.value) || 0)
    .reduce((a, b) => a + b, 0);
}

function updateCalTarget() {
  if (!activePlan) { el.calTarget.textContent = '— kcal'; return; }
  const today   = new Date(); today.setHours(0,0,0,0);
  const end     = new Date(activePlan.target_date + 'T00:00:00');
  const daysLeft = Math.max(1, Math.round((end - today) / 86400000));

  // Use the most recent logged weight — todayLog.weight and
  // activePlan.*_weight are canonical kg, so this deficit math stays in
  // kg throughout (KCAL_PER_KG only — no display-unit branch needed).
  const latestW = todayLog?.weight ?? activePlan.start_weight;
  const remaining = activePlan.target_weight - latestW;
  const deficit   = -((remaining / daysLeft) * KCAL_PER_KG);
  const target    = Math.max(1200, Math.round((profile?.tdee || 2200) - deficit));
  el.calTarget.textContent = `${target.toLocaleString()} kcal`;
  return target;
}

function updateLogBars() {
  const steps     = parseFloat(el.logSteps.value) || 0;
  const stepsGoal = profile?.steps_goal || 10000;
  const stepsPct  = clamp01(steps, stepsGoal);
  el.stepsBar.style.width = stepsPct + '%';
  el.stepsPct.textContent = Math.round(stepsPct);

  const total  = calcMealTotal();
  const calGoalText = el.calTarget.textContent.replace(/[^\d]/g, '');
  const calGoal = parseInt(calGoalText) || 1;
  el.calTotal.textContent = `${Math.round(total).toLocaleString()} kcal`;
  el.calBar.style.width   = clamp01(total, calGoal) + '%';
}

[el.logSteps, el.mBreakfast, el.mLunch, el.mDinner, el.mSnacks].forEach(inp => {
  inp.addEventListener('input', updateLogBars);
});

el.logForm.addEventListener('submit', async e => {
  e.preventDefault();
  setBtn(el.btnSaveLog, true, 'Save entry');
  el.logStatus.classList.remove('is-visible', 'is-error');

  const calTotal = calcMealTotal() || null;
  const unit = BODY_WEIGHT_UNIT;
  const typedWeight = parseFloat(el.logWeight.value);
  const row = {
    user_id:       currentUser.id,
    log_date:      el.logDate.value,
    weight:        Number.isFinite(typedWeight) ? weightToKg(typedWeight, unit) : null,
    steps:         parseInt(el.logSteps.value)     || null,
    active_energy_kcal: parseFloat(el.logActiveCal.value) || null,
    cal_breakfast: parseInt(el.mBreakfast.value)   || null,
    cal_lunch:     parseInt(el.mLunch.value)        || null,
    cal_dinner:    parseInt(el.mDinner.value)       || null,
    cal_snacks:    parseInt(el.mSnacks.value)       || null,
    notes:         el.logNotes.value.trim() || null,
  };

  const { error, queued } = await queuedWrite('daily_logs', 'upsert', row, { onConflict: 'user_id,log_date' });

  setBtn(el.btnSaveLog, false, 'Save entry');

  if (error) {
    flash(el.logStatus, 'Error saving — ' + error.message, true);
  } else {
    flash(el.logStatus, queued ? "Saved offline — will sync when you're back online." : 'Saved.');
    if (el.logDate.value === todayISO()) {
      todayLog = row;
    }
    if (row.weight != null) writeWeightToHealthKit(row.weight, row.log_date); // local HealthKit write — works offline too
  }
});



/* ═══════════════════════════════════════════════════════════
   WORKOUT
═══════════════════════════════════════════════════════════ */

// Workout state
let activeRoutine   = null;
let activeExercises = [];
let supersetModeOn  = false;
let mediaCache      = {};
// Real wall-clock time the session began (set once, in selectRoutine) —
// used as workout_sessions.started_at so the diabetes engine's post-
// exercise window logic (sensitivityMap, preWorkoutAdvisor, etc.) has an
// actual start time to work with instead of just the save-time instant.
let workoutStartedAtMs = null;

// Manual superset pairing — tap-to-link mode lets the person pick any two
// exercises from today's list (not just adjacent ones) and pair them.
let linkModeOn      = false;
let linkPendingIndex = null; // index of the exercise tapped first, awaiting its partner

const WORKOUT_STORAGE_KEY = 'fitl00p_active_workout';

function saveWorkoutState() {
  if (!activeRoutine || !activeExercises.length) return;
  try {
    localStorage.setItem(WORKOUT_STORAGE_KEY, JSON.stringify({
      routine:   activeRoutine,
      exercises: activeExercises,
      startedAtMs: workoutStartedAtMs,
      savedAt:   Date.now(),
    }));
  } catch {}
}

function clearWorkoutState() {
  localStorage.removeItem(WORKOUT_STORAGE_KEY);
}

function restoreWorkoutState() {
  try {
    const raw = localStorage.getItem(WORKOUT_STORAGE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    // Discard if older than 12 hours — stale workout
    if (!state.routine || !state.exercises || Date.now() - state.savedAt > 12 * 3600 * 1000) {
      clearWorkoutState();
      return false;
    }
    activeRoutine   = state.routine;
    activeExercises = state.exercises;
    workoutStartedAtMs = state.startedAtMs || null;
    // Re-derive pairing mode — a workout that had superset pairs (predefined
    // or manually linked) before the reload needs them to keep applying.
    supersetModeOn  = activeExercises.some(e => e.superset_group);
    return true;
  } catch {
    return false;
  }
}

// DOM refs for new workout UI
const elW = {
  picker:            $('workoutPicker'),
  active:            $('workoutActive'),
  historyPanel:      $('workoutHistoryPanel'),
  routineFilterSplit:$('routineFilterSplit'),
  routineFilters:$('routineFilters'),
  routineList:       $('routineList'),
  readinessBanner:   $('readinessBanner'),
  activeWorkoutBanner:      $('activeWorkoutBanner'),
  activeWorkoutBannerTitle: $('activeWorkoutBannerTitle'),
  activeWorkoutBannerDesc:  $('activeWorkoutBannerDesc'),
  btnContinueWorkout:       $('btnContinueWorkout'),
  btnAbandonWorkout:        $('btnAbandonWorkout'),
  workoutDate:       $('workoutDate'),
  activeHeader:      $('activeWorkoutHeader'),
  activeExList:      $('activeExerciseList'),
  backToPicker:      $('btnBackToPicker'),
  btnSaveWorkout:    $('btnSaveWorkout'),
  workoutStatus:     $('workoutStatus'),
  btnWorkoutHistory: $('btnWorkoutHistory'),
  historyFilterSplit:$('historyFilterSplit'),
  btnCloseHistory:   $('btnCloseHistory'),
  workoutHistoryList:$('workoutHistoryList'),
  strengthProgress:  $('strengthProgress'),
  // rest timer
  restOverlay:  $('restTimerOverlay'),
  restFill:     $('restTimerFill'),
  restCount:    $('restTimerCount'),
  restNext:     $('restTimerNext'),
  restSkip:     $('restTimerSkip'),
};

const TIMER_CIRCUMFERENCE = 515.22; // 2π × 82
let restTimerInterval = null;
let restTimerResolve  = null;

// ── Web Audio sounds ──────────────────────────────────────
function playTick() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(880, ctx.currentTime);
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    o.start(); o.stop(ctx.currentTime + 0.08);
  } catch {}
}

function playTock() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.setValueAtTime(660, ctx.currentTime);
    g.gain.setValueAtTime(0.3, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    o.start(); o.stop(ctx.currentTime + 0.08);
  } catch {}
}

function playBuzzer() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.15, 0.3].forEach(delay => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = 'square';
      o.frequency.setValueAtTime(440, ctx.currentTime + delay);
      g.gain.setValueAtTime(0.25, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.12);
      o.start(ctx.currentTime + delay);
      o.stop(ctx.currentTime + delay + 0.12);
    });
  } catch {}
}

// ── Rest timer ────────────────────────────────────────────
function startRestTimer(seconds, nextLabel) {
  return new Promise(resolve => {
    restTimerResolve = resolve;
    let remaining = seconds;
    elW.restCount.textContent = remaining;
    elW.restNext.textContent  = nextLabel ? `Next: ${nextLabel}` : '';
    elW.restFill.style.strokeDashoffset = '0';
    elW.restOverlay.hidden = false;

    restTimerInterval = setInterval(() => {
      remaining--;
      elW.restCount.textContent = remaining;
      const offset = TIMER_CIRCUMFERENCE * (1 - remaining / seconds);
      elW.restFill.style.strokeDashoffset = offset;

      if (remaining <= 3 && remaining > 0) {
        remaining % 2 === 0 ? playTick() : playTock();
      }
      if (remaining <= 0) {
        clearInterval(restTimerInterval);
        playBuzzer();
        setTimeout(() => {
          elW.restOverlay.hidden = true;
          resolve();
        }, 400);
      }
    }, 1000);
  });
}

elW.restSkip.addEventListener('click', () => {
  clearInterval(restTimerInterval);
  elW.restOverlay.hidden = true;
  if (restTimerResolve) { restTimerResolve(); restTimerResolve = null; }
});

// ── Routine picker ────────────────────────────────────────
let sessionDurationOverride = null;
let readinessBannerDismissed = false;

async function loadWorkout() {
  if (!currentUser) return;
  elW.workoutDate.value = elW.workoutDate.value || todayISO();
  elW.picker.hidden  = false;
  elW.active.hidden  = true;
  elW.historyPanel.hidden = true;
  renderActiveWorkoutBanner();
  renderWorkoutReadinessBanner();
  populateDxWorkoutImpactTypes();
  await loadRoutines();
}

// Surfaces a "Continue workout" / "Abandon workout" banner on the picker
// screen whenever a workout has been started but not saved yet — the
// backstop against an in-progress session silently looking lost after
// navigating to another tab and back, or an accidental "← Routines" tap
// (see backToPicker, which used to wipe activeExercises outright on every
// tap; it no longer does — see its own comment).
//
// activeRoutine/activeExercises being empty here doesn't necessarily mean
// there's nothing to resume — a hard page reload resets those globals, but
// restoreWorkoutState() (already the source of truth localStorage mirrors
// on every change via saveWorkoutState) can still hydrate them from what
// was saved before the reload, as long as it's not stale (>12h old).
function renderActiveWorkoutBanner() {
  if (!activeRoutine || !activeExercises.length) restoreWorkoutState();
  if (!elW.activeWorkoutBanner) return;
  if (!activeRoutine || !activeExercises.length) {
    elW.activeWorkoutBanner.hidden = true;
    return;
  }
  const doneSets = activeExercises.reduce((n, ex) => n + ex.sets.filter(s => s.done).length, 0);
  const totalSets = activeExercises.reduce((n, ex) => n + ex.sets.length, 0);
  elW.activeWorkoutBanner.hidden = false;
  elW.activeWorkoutBannerTitle.textContent = `Workout in progress — ${activeRoutine.name}`;
  elW.activeWorkoutBannerDesc.textContent = `${activeExercises.length} exercise${activeExercises.length === 1 ? '' : 's'} · ${doneSets}/${totalSets} sets done`;
}

elW.btnContinueWorkout?.addEventListener('click', () => {
  if (!activeRoutine || !activeExercises.length) return;
  renderActiveWorkout();
  elW.picker.hidden = true;
  elW.active.hidden = false;
});

elW.btnAbandonWorkout?.addEventListener('click', () => {
  if (!confirm(`Abandon "${activeRoutine?.name || 'this workout'}"? Nothing logged so far will be saved.`)) return;
  activeRoutine = null; activeExercises = []; workoutStartedAtMs = null;
  clearWorkoutState();
  renderActiveWorkoutBanner();
});

// Reads today's Recovery score (same formula as the dashboard) and, if
// recovery is running low, surfaces a banner offering to filter the routine
// list down to the shortest available sessions for today only.
async function renderWorkoutReadinessBanner() {
  if (!elW.readinessBanner || !currentUser) return;
  if (readinessBannerDismissed) { elW.readinessBanner.hidden = true; return; }

  const todayStr = todayISO();
  const [healthRes, logRes] = await Promise.all([
    db.from('health_daily')
      .select('sleep_total_hrs, sleep_deep_hrs, sleep_rem_hrs, hrv_ms, resting_hr, active_energy_kcal, resting_energy_kcal, dietary_energy_kcal, log_date')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: false })
      .limit(2),
    db.from('daily_logs')
      .select('cal_total, cal_apple, active_energy_kcal')
      .eq('user_id', currentUser.id)
      .eq('log_date', todayStr)
      .maybeSingle(),
  ]);

  const rawHealthRows = healthRes.data || [];
  const todayHealth = rawHealthRows.find(r => r.log_date === todayStr) || {};
  const yestHealth  = rawHealthRows.find(r => r.log_date !== todayStr) || {};

  // Same overnight-metric fallback as the dashboard — sleep/HRV/RHR come from
  // last night's sync and can still be under yesterday's date early in the day.
  const health = {
    ...yestHealth,
    ...Object.fromEntries(Object.entries(todayHealth).filter(([, v]) => v != null && v !== 0)),
  };

  const { score, label } = computeRecoveryScore(health, []);

  // Only interrupt the flow when recovery is genuinely moderate-or-below —
  // matches the same 50-point line "Moderate — consider a lighter session" uses.
  if (score == null || score >= 50) {
    elW.readinessBanner.hidden = true;
    return;
  }

  elW.readinessBanner.hidden = false;
  elW.readinessBanner.innerHTML = `
    <button type="button" class="readiness-banner__dismiss" id="btnDismissReadiness" aria-label="Dismiss">×</button>
    <div class="readiness-banner__icon">🔋</div>
    <div class="readiness-banner__body">
      <div class="readiness-banner__eyebrow">BASED ON YOUR RECOVERY</div>
      <div class="readiness-banner__title">Feeling tired? Try a shorter session</div>
      <div class="readiness-banner__desc">Recovery is at ${score} today — ${label}</div>
      <button type="button" class="readiness-banner__action" id="btnShowShorter">Show shortest sessions</button>
    </div>`;

  $('btnDismissReadiness')?.addEventListener('click', () => {
    readinessBannerDismissed = true;
    elW.readinessBanner.hidden = true;
  });
  $('btnShowShorter')?.addEventListener('click', () => {
    sessionDurationOverride = 30;
    loadRoutines();
    showToast('Showing your shortest sessions for today');
  });
}

async function loadRoutines() {
  if (!currentUser) return;
  elW.routineList.innerHTML = '<p class="empty-state">Loading…</p>';

  // Pinned to a hand-picked set (profiles.workout_routine_override, set
  // directly in the DB — see Settings) — bypasses the whole equipment/
  // goal/split/duration recommendation algorithm below and just shows
  // exactly these routines, in this exact order, every time. The split
  // filter dropdown has no effect on a fixed set, so it's hidden rather
  // than left sitting there doing nothing.
  const override = profile?.workout_routine_override;
  if (Array.isArray(override) && override.length) {
    if (elW.routineFilters) elW.routineFilters.hidden = true;
    const { data, error } = await db.from('routine_templates')
      .select('id, name, split_type, equipment_id, goal, rest_seconds, min_duration, max_duration, description, full_body_day')
      .in('id', override);
    if (error || !data?.length) {
      elW.routineList.innerHTML = '<p class="empty-state">Custom routine set not found — check Settings.</p>';
      return;
    }
    const byId = new Map(data.map(r => [r.id, r]));
    const routines = override.map(id => byId.get(id)).filter(Boolean);
    await renderRoutineCards(routines);
    return;
  }
  if (elW.routineFilters) elW.routineFilters.hidden = false;

  // Build query filtered to user's equipment and goal
  const userEquipment = profile?.equipment || [];
  const userGoal      = profile?.goal || 'tone';
  const splitFilter   = elW.routineFilterSplit.value;

  let q = db.from('routine_templates')
    .select('id, name, split_type, equipment_id, goal, rest_seconds, min_duration, max_duration, description, full_body_day')
    .order('sort', { ascending: true });

  if (userEquipment.length) q = q.in('equipment_id', userEquipment);
  q = q.eq('goal', userGoal);
  if (splitFilter) q = q.eq('split_type', splitFilter);

  // Filter by session duration (readiness banner can temporarily override this
  // for the current visit, without touching the user's saved profile setting)
  const dur = sessionDurationOverride ?? (profile?.session_duration || 45);
  q = q.lte('min_duration', dur).gte('max_duration', dur);

  const { data, error } = await q;

  if (error || !data?.length) {
    elW.routineList.innerHTML = '<p class="empty-state">No routines found for your equipment and goal. Update them in Settings.</p>';
    return;
  }

  // full_body_day isn't a "is this a full-body routine" flag — it's only
  // set on the subset of Full Body templates that belong to a numbered
  // 4-day rotation (e.g. "Gym Full Body — Day 2"); standalone ones like
  // "Full Body A" have it null, same as every Push/Pull/Legs template.
  // Filtering on it (as this used to) meant most real Full Body routines
  // got excluded even with prefer_full_body on, the empty-result fallback
  // below then showed the *unfiltered* full list — Push/Pull/Legs and
  // all — which is exactly the "full body selected but shows PPL" bug.
  // split_type is unambiguous and always correctly set; filter on that.
  const preferFB = profile?.prefer_full_body;
  const filtered = preferFB
    ? data.filter(r => r.split_type === 'Full Body')
    : data.filter(r => r.split_type !== 'Full Body');

  const routines = filtered.length ? filtered : data;
  await renderRoutineCards(routines);
}

// Shared by both the normal recommendation path and the fixed-set
// override above — everything from here on just renders whatever
// routines array it's handed.
async function renderRoutineCards(routines) {
  // One extra round-trip to get a per-routine exercise count (Coachly shows
  // "5 exercises" on every card) — grouped client-side to avoid N+1 queries.
  const routineIds = routines.map(r => r.id);
  let countByRoutine = {};
  if (routineIds.length) {
    const { data: exRows } = await db.from('routine_exercises')
      .select('routine_id').in('routine_id', routineIds);
    (exRows || []).forEach(row => {
      countByRoutine[row.routine_id] = (countByRoutine[row.routine_id] || 0) + 1;
    });
  }

  const splitIcons = { Push:'🔺', Pull:'🔻', Legs:'🦵', 'Full Body':'⚡', Cardio:'🏃', Other:'💪' };
  const goalLabels = { strength: ['💪','Strength'], tone: ['✨','Tone'], weight_loss: ['🔥','Cut'] };

  elW.routineList.innerHTML = routines.map(r => {
    const cls = r.split_type.replace(/\s+/g,'-');
    const exCount = countByRoutine[r.id];
    const [goalIcon, goalLabel] = goalLabels[r.goal] || [];
    const goalBadge = goalLabel
      ? `<span class="goal-badge goal-badge--${r.goal}">${goalIcon} ${goalLabel}</span>` : '';

    return `<div class="routine-card routine-card--${cls}" data-id="${r.id}" data-split="${r.split_type}">
      <div class="routine-card__icon">${splitIcons[r.split_type]||'💪'}</div>
      <div class="routine-card__body">
        <div class="routine-card__top">
          <span class="routine-card__name">${r.name}</span>
          ${goalBadge}
        </div>
        <div class="routine-card__meta">
          <span class="split-tag split-tag--${cls}">${r.split_type}</span>
          <span>⏱ ${r.min_duration}–${r.max_duration} min</span>
          ${exCount ? `<span>${exCount} exercises</span>` : ''}
        </div>
        ${r.description ? `<div class="routine-card__desc">${r.description}</div>` : ''}
      </div>
      <span class="routine-card__arrow">›</span>
    </div>`;
  }).join('');

  elW.routineList.querySelectorAll('.routine-card').forEach(card => {
    card.addEventListener('click', () => selectRoutine(card.dataset.id));
  });
}

elW.routineFilterSplit.addEventListener('change', loadRoutines);

// Loads the user's own editable copy of a routine's exercise list,
// seeding it from the base routine_exercises template on first use.
// After seeding, this table is the source of truth for that user —
// the base template is never touched again for them, satisfying
// "retain their version for next time" starting from their very
// first open of the workout, not just after they've made an edit.
async function loadUserRoutineExercises(routineId) {
  const { data: existing } = await db.from('user_routine_customizations')
    .select('*').eq('routine_id', routineId).order('sort_order');

  if (existing && existing.length > 0) {
    return existing;
  }

  // No customization yet — seed one, row for row, from the base template.
  const { data: baseExercises } = await db.from('routine_exercises')
    .select('*').eq('routine_id', routineId).order('sort_order');

  if (!baseExercises || baseExercises.length === 0) return [];

  const seedRows = baseExercises.map(ex => ({
    user_id: currentUser.id,
    routine_id: routineId,
    name: ex.name,
    sets: ex.sets,
    reps: ex.reps,
    sort_order: ex.sort_order,
    notes: ex.notes,
    rest_seconds_override: ex.rest_seconds_override,
    superset_group: ex.superset_group,
    source: 'base',
  }));

  const { data: inserted, error } = await db.from('user_routine_customizations')
    .insert(seedRows)
    .select('*')
    .order('sort_order');

  if (error) {
    console.error('Failed to seed user_routine_customizations:', error.message);
    // Fall back to the base exercises directly so the workout can still
    // proceed even if seeding failed — the user just won't get a
    // persistent customized copy this session.
    return baseExercises;
  }

  return inserted || [];
}

// Suggests exercises to add as a replacement for a given exercise,
// constrained to genuinely similar options rather than a free browse
// of the whole exercise library.
//
// Two-tier approach, reflecting real data coverage checked directly:
// exercise_substitutions only covers ~37% of the exercise library
// (157 of 248 exercises have zero entries there at all — it was built
// for injury accommodation specifically, tied to injury_id, not as a
// general similar-exercise index). Muscle-group matching via
// exercise_media has complete coverage (248/248), so it's the
// fallback that makes this work for every exercise, not just the
// minority with curated substitution data.
// Given an exercise and a desired equipment type, finds alternatives
// that share the same primary muscle group AND use the requested
// equipment specifically — e.g. "change Hammer Curl to a cable
// exercise" surfaces Cable Hammer Curl, filtered by the newly added
// equipment_type column rather than just muscle overlap alone.
async function changeEquipment(exerciseName, desiredEquipmentType) {
  const { data: original } = await db.from('exercise_media')
    .select('muscles_primary, equipment_type').eq('exercise_name', exerciseName).single();

  if (!original || !original.muscles_primary?.length) return [];

  const { data: candidates } = await db.from('exercise_media')
    .select('exercise_name, gif_url, muscles_primary, equipment_type')
    .overlaps('muscles_primary', original.muscles_primary)
    .eq('equipment_type', desiredEquipmentType)
    .neq('exercise_name', exerciseName)
    .limit(12);

  return (candidates || []).map(c => ({
    name: c.exercise_name,
    gif_url: c.gif_url,
    equipment_type: c.equipment_type,
    reason: `${desiredEquipmentType} alternative — also targets ${c.muscles_primary.filter(m => original.muscles_primary.includes(m)).join(', ')}`,
  }));
}

const EQUIPMENT_TYPE_LABELS = {
  barbell: 'Barbell', dumbbell: 'Dumbbell', cable: 'Cable',
  machine: 'Machine', bodyweight: 'Bodyweight', kettlebell: 'Kettlebell',
};

// Two-step equipment-change picker: choose a target equipment type,
// then choose a specific exercise from real, muscle-matched results.
// Applying a choice updates ONLY that exercise's row in
// user_routine_customizations — the shared base routine_exercises
// template is never touched, consistent with every other
// customization built this session.
function openEquipmentPicker(ei) {
  const ex = activeExercises[ei];
  if (!ex) return;

  let overlay = $('equipPickerOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'equipPickerOverlay';
    overlay.className = 'equip-picker-overlay';
    document.body.appendChild(overlay);
  }

  const typeButtonsHtml = Object.entries(EQUIPMENT_TYPE_LABELS)
    .map(([type, label]) => `<button type="button" class="equip-picker__type-btn" data-type="${type}">${label}</button>`)
    .join('');

  overlay.innerHTML = `
    <div class="equip-picker__panel">
      <div class="equip-picker__head">
        <span>Change equipment for ${ex.name}</span>
        <button type="button" class="equip-picker__close" id="equipPickerClose">✕</button>
      </div>
      <div class="equip-picker__body" id="equipPickerBody">
        <p class="equip-picker__prompt">Choose the equipment you have or want to use:</p>
        <div class="equip-picker__types">${typeButtonsHtml}</div>
      </div>
    </div>`;

  overlay.classList.add('is-open');

  $('equipPickerClose').addEventListener('click', () => overlay.classList.remove('is-open'));

  overlay.querySelectorAll('.equip-picker__type-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const desiredType = btn.dataset.type;
      const body = $('equipPickerBody');
      body.innerHTML = `<p class="equip-picker__loading">Finding ${EQUIPMENT_TYPE_LABELS[desiredType].toLowerCase()} alternatives…</p>`;

      const options = await changeEquipment(ex.name, desiredType);

      if (!options.length) {
        body.innerHTML = `<p class="equip-picker__empty">No ${EQUIPMENT_TYPE_LABELS[desiredType].toLowerCase()} alternative found for this exercise.</p>
          <button type="button" class="equip-picker__back-btn" id="equipPickerBack">← Choose different equipment</button>`;
        $('equipPickerBack').addEventListener('click', () => openEquipmentPicker(ei));
        return;
      }

      body.innerHTML = options.map(opt => `
        <button type="button" class="equip-picker__option" data-name="${opt.name}">
          <span class="equip-picker__option-name">${opt.name}</span>
          <span class="equip-picker__option-reason">${opt.reason}</span>
        </button>
      `).join('') + `<button type="button" class="equip-picker__back-btn" id="equipPickerBack">← Choose different equipment</button>`;

      $('equipPickerBack').addEventListener('click', () => openEquipmentPicker(ei));

      body.querySelectorAll('.equip-picker__option').forEach(optBtn => {
        optBtn.addEventListener('click', async () => {
          await applyEquipmentSwap(ei, optBtn.dataset.name);
          overlay.classList.remove('is-open');
        });
      });
    });
  });
}

async function applyEquipmentSwap(ei, newExerciseName) {
  const ex = activeExercises[ei];
  if (!ex) return;

  const { error } = await db.from('user_routine_customizations')
    .update({ name: newExerciseName, source: 'added_substitution', original_exercise_name: ex.name, updated_at: new Date().toISOString() })
    .eq('id', ex.id);

  if (error) {
    console.error('Failed to swap exercise:', error.message);
    alert('Could not change equipment for this exercise — please try again.');
    return;
  }

  // Refetch this exercise's media and PR data under its new name,
  // rather than just overwrite the display name and leave stale
  // media/PR data attached to the old exercise's identity.
  const { data: newMedia } = await db.from('exercise_media')
    .select('*').eq('exercise_name', newExerciseName).single();
  const { data: newPr } = await db.from('exercise_personal_records')
    .select('*').eq('exercise_name', newExerciseName).single();

  activeExercises[ei] = {
    ...ex,
    name: newExerciseName,
    media: newMedia || null,
    pr: newPr || null,
    wasSubstituted: true,
  };

  renderActiveWorkout();
}

// Two-step add-exercise picker: choose which existing exercise to base
// the addition on, then choose from real, muscle-matched suggestions —
// reusing getSuggestedReplacements so additions genuinely "match the
// workout at hand" rather than a free browse of the whole library,
// matching the original design spec exactly.
function openAddExercisePicker() {
  let overlay = $('addExOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'addExOverlay';
    overlay.className = 'equip-picker-overlay';
    document.body.appendChild(overlay);
  }

  const baseButtonsHtml = activeExercises
    .map((ex, i) => `<button type="button" class="equip-picker__type-btn" data-ei="${i}">${ex.name}</button>`)
    .join('');

  overlay.innerHTML = `
    <div class="equip-picker__panel">
      <div class="equip-picker__head">
        <span>Add an exercise</span>
        <button type="button" class="equip-picker__close" id="addExClose">✕</button>
      </div>
      <div class="equip-picker__body" id="addExBody">
        <p class="equip-picker__prompt">Which exercise should this complement?</p>
        <div class="equip-picker__types">${baseButtonsHtml}</div>
      </div>
    </div>`;

  overlay.classList.add('is-open');
  $('addExClose').addEventListener('click', () => overlay.classList.remove('is-open'));

  overlay.querySelectorAll('.equip-picker__type-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const baseEx = activeExercises[+btn.dataset.ei];
      const body = $('addExBody');
      body.innerHTML = `<p class="equip-picker__loading">Finding exercises that match…</p>`;

      const options = await getSuggestedReplacements(baseEx.name);

      if (!options.length) {
        body.innerHTML = `<p class="equip-picker__empty">No matching suggestions found for this exercise.</p>
          <button type="button" class="equip-picker__back-btn" id="addExBack">← Choose a different exercise</button>`;
        $('addExBack').addEventListener('click', () => openAddExercisePicker());
        return;
      }

      body.innerHTML = options.map(opt => `
        <button type="button" class="equip-picker__option" data-name="${opt.name}">
          <span class="equip-picker__option-name">${opt.name}</span>
          <span class="equip-picker__option-reason">${opt.reason}</span>
        </button>
      `).join('') + `<button type="button" class="equip-picker__back-btn" id="addExBack">← Choose a different exercise</button>`;

      $('addExBack').addEventListener('click', () => openAddExercisePicker());

      body.querySelectorAll('.equip-picker__option').forEach(optBtn => {
        optBtn.addEventListener('click', async () => {
          await applyAddExercise(optBtn.dataset.name);
          overlay.classList.remove('is-open');
        });
      });
    });
  });
}

async function applyAddExercise(newExerciseName) {
  const maxSort = activeExercises.reduce((max, ex) => Math.max(max, ex.sort_order ?? 0), 0);

  const { data: inserted, error } = await db.from('user_routine_customizations')
    .insert({
      user_id: currentUser.id,
      routine_id: activeRoutine.id,
      name: newExerciseName,
      sets: 3,
      reps: 10,
      sort_order: maxSort + 1,
      source: 'added_substitution',
    })
    .select('*')
    .single();

  if (error) {
    console.error('Failed to add exercise:', error.message);
    alert('Could not add this exercise — please try again.');
    return;
  }

  const [{ data: newMedia }, { data: newPr }] = await Promise.all([
    db.from('exercise_media').select('*').eq('exercise_name', newExerciseName).single(),
    db.from('exercise_personal_records').select('*').eq('exercise_name', newExerciseName).single(),
  ]);

  activeExercises.push({
    ...inserted,
    media: newMedia || null,
    pr: newPr || null,
    sets: Array.from({ length: inserted.sets }, (_, i) => ({ setNum: i + 1, reps: String(inserted.reps || ''), done: false })),
    wasSubstituted: true,
  });

  renderActiveWorkout();
}

async function getSuggestedReplacements(exerciseName) {
  // Tier 1: curated substitutions, when they exist — deliberate expert
  // guidance, deduplicated since the same substitute name often
  // repeats across multiple injury-context rows for one exercise.
  const { data: curated } = await db.from('exercise_substitutions')
    .select('substitute_name, substitute_notes')
    .eq('original_name', exerciseName);

  const curatedNames = [...new Set((curated || []).map(c => c.substitute_name))];

  if (curatedNames.length > 0) {
    const { data: media } = await db.from('exercise_media')
      .select('exercise_name, gif_url, muscles_primary')
      .in('exercise_name', curatedNames);
    return (media || []).map(m => ({ name: m.exercise_name, gif_url: m.gif_url, reason: 'Suggested alternative' }));
  }

  // Tier 2: fall back to shared primary muscle group.
  const { data: original } = await db.from('exercise_media')
    .select('muscles_primary').eq('exercise_name', exerciseName).single();

  if (!original || !original.muscles_primary?.length) return [];

  const { data: candidates } = await db.from('exercise_media')
    .select('exercise_name, gif_url, muscles_primary')
    .overlaps('muscles_primary', original.muscles_primary)
    .neq('exercise_name', exerciseName)
    .limit(12);

  return (candidates || []).map(c => ({
    name: c.exercise_name,
    gif_url: c.gif_url,
    reason: `Also targets ${c.muscles_primary.filter(m => original.muscles_primary.includes(m)).join(', ')}`,
  }));
}

async function selectRoutine(routineId) {
  // Tapping the routine that's already in progress should just resume it
  // in place — re-fetching from user_routine_customizations below would
  // reload the exercise list fresh from the DB and silently wipe out
  // whatever reps/weights/completed sets have been entered this session
  // but not saved yet.
  if (activeRoutine && activeExercises.length && activeRoutine.id === routineId) {
    renderActiveWorkout();
    elW.picker.hidden = true;
    elW.active.hidden = false;
    return;
  }
  // A DIFFERENT workout is already in progress — tapping another routine
  // card would silently overwrite it (same accidental-loss shape as the
  // old backToPicker bug). Require an explicit confirmation first.
  if (activeRoutine && activeExercises.length) {
    if (!confirm(`"${activeRoutine.name}" is still in progress. Discard it and start a new workout instead?`)) {
      return;
    }
    clearWorkoutState();
  }

  elW.routineList.innerHTML = '<p class="empty-state">Loading exercises…</p>';

  // 1. Fetch the routine template
  const { data: routine } = await db.from('routine_templates')
    .select('*').eq('id', routineId).single();

  // 2. Fetch the user's own customized copy of this routine's exercises
  // (seeded from the base template on first use, then persistent) —
  // rather than always reading the shared base directly.
  const exRows = await loadUserRoutineExercises(routineId);

  let exercises = exRows || [];

  // 4. Fetch media data from Supabase for all exercises
  const exNames = [...new Set(exercises.map(e => e.name))];
  const { data: mediaRows } = await db.from('exercise_media')
    .select('exercise_name, search_name, gif_url, muscles_primary, muscles_secondary, key_cues, common_mistakes, equipment_type, base_weight_kg')
    .in('exercise_name', exNames);

  const mediaByName = {};
  (mediaRows || []).forEach(m => { mediaByName[m.exercise_name] = m; });

  // Fetch personal records for all exercises, so each card can show
  // "last time: X kg x Y reps" as a starting point for this session.
  const { data: prRows } = await db.from('exercise_personal_records')
    .select('exercise_name, best_weight, best_weight_unit, best_weight_reps, best_reps')
    .in('exercise_name', exNames);

  const prByName = {};
  (prRows || []).forEach(p => { prByName[p.exercise_name] = p; });

  // Fetch recent session history once for the whole routine (same
  // session_date + workout_exercises + workout_sets shape
  // fetchExerciseHistory uses for the "🕘 Previous sets" drawer, just
  // unfiltered by name so one query covers every exercise in this
  // routine) to find each exercise's most recent top set — the real
  // basis for "add a bit more than last time", which the all-time PR
  // above isn't: a PR can be from months ago or a one-off max attempt,
  // not what was actually lifted last time this exercise came up.
  const { data: recentSessions } = await db.from('workout_sessions')
    .select(`session_date, workout_exercises (name, workout_sets (reps, weight, unit))`)
    .eq('user_id', currentUser.id)
    .order('session_date', { ascending: false })
    .limit(60);

  const lastByName = {};
  (recentSessions || []).forEach(s => {
    (s.workout_exercises || []).forEach(wex => {
      if (lastByName[wex.name]) return; // sessions already ordered newest-first — first hit wins
      const sets = (wex.workout_sets || []).filter(st => st.weight != null);
      if (!sets.length) return;
      const topSet = sets.reduce((best, st) => (st.weight > best.weight || (st.weight === best.weight && (st.reps || 0) > (best.reps || 0))) ? st : best);
      lastByName[wex.name] = { date: s.session_date, weight: Number(topSet.weight), reps: Number(topSet.reps) || 0 };
    });
  });

  // 5. Build active exercise state with per-set tracking
  const userUnit = EXERCISE_WEIGHT_UNIT;
  // Determine rest seconds (user override takes priority over routine default)
  const goalKey = { weight_loss: 'rest_weight_loss', tone: 'rest_tone', strength: 'rest_strength' }[profile?.goal || 'tone'];
  const restSecs = profile?.[goalKey] ?? routine.rest_seconds;

  activeRoutine = routine;
  workoutStartedAtMs = Date.now();
  activeExercises = exercises.map(ex => {
    const equipmentType = mediaByName[ex.name]?.equipment_type || null;
    // Per-exercise override for the plate calculator's bar/sled weight —
    // most barbell-classified exercises really are a standard 20kg
    // Olympic bar, but some ("Hip Thrust" on this gym's plate-loaded
    // machine, for one) have their own base weight, so the generic
    // BARBELL_BAR_KG default is wrong for them specifically.
    const rawBaseWeight = mediaByName[ex.name]?.base_weight_kg;
    const baseWeightKg = rawBaseWeight != null ? Number(rawBaseWeight) : null;
    const last = lastByName[ex.name] || null;
    const suggestedWeight = computeSuggestedWeight(equipmentType, last, ex.reps);
    // Pre-fill priority: all-time heaviest completed (the actual ask —
    // "how heavy have I gone", visible the instant the card opens rather
    // than a number requiring the PR line to be read first) beats the
    // progressive-overload suggestion, which only kicks in as a fallback
    // for an exercise with no PR logged yet.
    const pr = prByName[ex.name] || null;
    const prWeight = pr?.best_weight != null ? Number(pr.best_weight) : null;
    const prefillWeight = prWeight != null ? prWeight : suggestedWeight;

    return {
      ...ex,
      media: mediaByName[ex.name] || null,
      pr,
      equipmentType,
      baseWeightKg,
      lastSession: last,
      suggestedWeight,
      prefillWeight,
      // Per-exercise override (set e.g. for a superset/circuit authored with
      // its own specific rest period) takes priority over the profile/routine
      // default, matching the comment above — this field was already being
      // fetched onto every exercise row but never actually consulted here.
      // rest_seconds_override itself is already carried through by the
      // ...ex spread above — kept there (rather than folded away) so the
      // UI can flag when an exercise's rest differs from the routine's
      // stated default, otherwise a shorter/longer countdown shows up
      // with no visible reason.
      restSeconds: ex.rest_seconds_override ?? restSecs,
      sets: Array.from({ length: ex.sets }, (_, i) => ({
        setNum: i + 1,
        reps:   ex.reps ? String(ex.reps) : '',
        // Pre-filled with the heaviest weight ever completed for this
        // exercise (falling back to the progressive-overload suggestion
        // when there's no PR yet) as a starting point — freely editable,
        // not locked in.
        weight: prefillWeight != null ? String(prefillWeight) : '',
        done:   false,
      })),
    };
  });

  // Default Superset Mode on if this routine was authored with predefined
  // pairs; off otherwise (the toggle can still turn it on for any routine —
  // it just falls back to pairing consecutive exercises by position).
  supersetModeOn = activeExercises.some(e => e.superset_group);

  saveWorkoutState(); // persist immediately on start
  renderActiveWorkout();
}

// Manually pair two exercises as a superset — breaks either one out of
// whatever pair it was already in, tags both with a shared group id, and
// moves the second one to sit directly after the first so the existing
// adjacency-based rendering/rest-timer logic in getBlockExercises() just works.
function pairExercises(idxA, idxB) {
  [idxA, idxB].forEach(idx => {
    const g = activeExercises[idx].superset_group;
    if (g) activeExercises.forEach(e => { if (e.superset_group === g) e.superset_group = null; });
    activeExercises[idx].supersetExcluded = false; // re-eligible after being deliberately re-paired
  });

  const groupId = `manual-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  activeExercises[idxA].superset_group = groupId;
  activeExercises[idxB].superset_group = groupId;

  const [moved] = activeExercises.splice(idxB, 1);
  const newIdxA = idxB < idxA ? idxA - 1 : idxA;
  activeExercises.splice(newIdxA + 1, 0, moved);

  supersetModeOn = true;
  saveWorkoutState();
}

function unlinkPair(ei) {
  const g = activeExercises[ei]?.superset_group;
  if (g) {
    activeExercises.forEach(e => { if (e.superset_group === g) e.superset_group = null; });
    // getBlockExercises() falls back to pairing consecutive exercises purely by
    // array position whenever Superset Mode is on and nothing has a real
    // superset_group left — that fallback exists for routines that never had
    // explicit pairs authored at all. Leaving Superset Mode on here would
    // immediately re-trigger it once the group we just cleared was the last
    // one left, silently re-pairing whatever now happens to sit next to each
    // other — the opposite of "unlink this pair back to individual exercises".
    if (!activeExercises.some(e => e.superset_group)) supersetModeOn = false;
  } else {
    // This block has no real superset_group at all — it only exists because
    // Superset Mode's position-based fallback (see getBlockExercises) paired
    // two adjacent standalone exercises. There's nothing to clear, but the
    // "Unpair" button still needs to DO something, so flag every member of
    // the block as excluded from that fallback — otherwise it just gets
    // silently re-paired by position on the very next render, which used to
    // make Unpair a no-op here (previously this branch didn't exist at all;
    // the function just returned early with nothing to do).
    const block = getBlockExercises(ei);
    if (!block || block.length < 2) return;
    block.forEach(idx => { activeExercises[idx].supersetExcluded = true; });
  }
  saveWorkoutState();
}

// Returns the array of activeExercises indices belonging to the block that
// starts at ei — every consecutive exercise sharing ei's superset_group
// (a superset/circuit can be 2, 3, or more exercises performed back-to-
// back before one shared rest, always kept adjacent by construction, see
// pairExercises), a single standalone exercise, or null if ei sits in the
// MIDDLE of a group that started earlier (already covered by that group's
// own start index, so the caller should skip rendering it again here).
function getBlockExercises(ei) {
  if (!activeExercises[ei]) return null;
  if (!supersetModeOn) return [ei];

  const ex = activeExercises[ei];
  const anyGrouped = activeExercises.some(e => e.superset_group);

  if (anyGrouped) {
    if (!ex.superset_group) return [ei];
    const prev = activeExercises[ei - 1];
    if (prev && prev.superset_group === ex.superset_group) return null; // mid-group
    const group = [ei];
    for (let j = ei + 1; activeExercises[j] && activeExercises[j].superset_group === ex.superset_group; j++) {
      group.push(j);
    }
    return group;
  }

  // No predefined pairs anywhere in this routine — the toggle still does
  // something useful by pairing consecutive exercises by position, 2 at a
  // time, skipping anything flagged supersetExcluded (unpaired via the
  // "Unpair" button — see unlinkPair) so it renders standalone instead of
  // being silently re-paired with whatever now sits next to it. Pairing is
  // computed over the eligible (non-excluded) exercises' own order rather
  // than raw index parity — an excluded exercise sitting at an odd index
  // would otherwise desync ei%2 for everything after it and drop an
  // exercise from rendering entirely.
  if (ex.supersetExcluded) return [ei];
  const eligible = [];
  for (let j = 0; j < activeExercises.length; j++) {
    if (!activeExercises[j].supersetExcluded) eligible.push(j);
  }
  const pos = eligible.indexOf(ei);
  if (pos % 2 !== 0) return null; // second-of-pair among eligible — covered by its partner's start
  const partnerIndex = eligible[pos + 1];
  return partnerIndex != null ? [ei, partnerIndex] : [ei];
}

// Moves the whole block starting at fromEi to sit immediately before (or,
// with insertAfter, immediately after) the block starting at toEi. Works
// by object identity rather than raw indices so splicing the dragged block
// out first can never desync the target lookup afterward — a superset's
// two exercises always move together, preserving their required adjacency.
//
// insertAfter matters: removing the dragged block first shifts every later
// index down by its length, so "always insert before the target" would
// silently put a downward drag back where it started the moment the
// target ends up sitting exactly one slot above where the drag began.
// Splitting on which half of the target block the pointer was over when
// it was released is what makes dragging downward actually move anything.
function reorderBlock(fromEi, toEi, insertAfter) {
  const fromBlock = getBlockExercises(fromEi);
  const toBlock = getBlockExercises(toEi);
  if (fromBlock.some(ei => toBlock.includes(ei))) return; // dropped on itself/own partner

  const draggedExercises = fromBlock.map(ei => activeExercises[ei]);
  const anchorEi = insertAfter ? toBlock[toBlock.length - 1] : toBlock[0];
  const targetAnchor = activeExercises[anchorEi];

  draggedExercises.forEach(obj => {
    activeExercises.splice(activeExercises.indexOf(obj), 1);
  });
  const insertIndex = activeExercises.indexOf(targetAnchor) + (insertAfter ? 1 : 0);
  activeExercises.splice(insertIndex, 0, ...draggedExercises);

  saveWorkoutState();
  renderActiveWorkout();
}

// Shared by both standalone and superset cards — identical markup to what
// was previously always inline, just parameterized so it can be dropped
// into either exercise-card__head layout.
function renderInfoDrawer(ei, ex) {
  return `
      <div class="exercise-info-drawer" id="drawer-${ei}">
        <div class="exercise-info-drawer__inner">
          <div class="exercise-info-drawer__gif ${ex.media?.gif_url ? '' : 'exercise-info-drawer__gif--loading'}" id="gif-${ei}">
            ${ex.media?.gif_url
              ? `<img src="${ex.media.gif_url}" alt="${ex.name} demonstration" loading="lazy">
                 ${ex.media?.matched_name && ex.media.matched_name.toLowerCase() !== ex.name.toLowerCase()
                   ? `<div class="gif-match-label">Showing: ${ex.media.matched_name} <button class="gif-refresh-btn" data-ei="${ei}" title="Try a different match">↻</button></div>`
                   : ''
                 }`
              : `<span>⏳</span>`}
          </div>
          <div class="exercise-info-drawer__details">
            ${ex.media?.muscles_primary?.length ? `
            <div class="exercise-info-drawer__section">
              <div class="exercise-info-drawer__heading">Primary</div>
              <div class="muscle-chips">
                ${ex.media.muscles_primary.map(m=>`<span class="muscle-chip">${m}</span>`).join('')}
              </div>
            </div>` : ''}
            ${ex.media?.muscles_secondary?.length ? `
            <div class="exercise-info-drawer__section">
              <div class="exercise-info-drawer__heading">Secondary</div>
              <div class="muscle-chips">
                ${ex.media.muscles_secondary.map(m=>`<span class="muscle-chip muscle-chip--secondary">${m}</span>`).join('')}
              </div>
            </div>` : ''}
            ${ex.media?.key_cues?.length ? `
            <div class="exercise-info-drawer__section">
              <div class="exercise-info-drawer__heading">Key cues</div>
              <div class="cue-list">
                ${ex.media.key_cues.map(c=>`<div class="cue-item">${c}</div>`).join('')}
              </div>
            </div>` : ''}
            ${ex.media?.common_mistakes?.length ? `
            <div class="exercise-info-drawer__section">
              <div class="exercise-info-drawer__heading">Avoid</div>
              <div class="cue-list">
                ${ex.media.common_mistakes.map(c=>`<div class="cue-item mistake-item">${c}</div>`).join('')}
              </div>
            </div>` : ''}
          </div>
        </div>
      </div>`;
}

// Collapsed by default, lazily filled in by openExerciseHistory() on first
// tap of the "🕘 Previous sets" button — reuses the exact same drawer
// shell/animation as renderInfoDrawer (just a distinct id prefix so the
// two toggle independently) rather than introducing new drawer CSS.
function renderExerciseHistoryDrawer(ei) {
  return `
      <div class="exercise-info-drawer" id="history-drawer-${ei}">
        <div class="exercise-info-drawer__inner exercise-history-list" id="history-drawer-inner-${ei}"></div>
      </div>`;
}

// Previous reps/weights for one exercise, by name, across past logged
// sessions — mid-workout reference for "what did I lift last time" so it
// doesn't require leaving the exercise card and digging through the
// history list. Same top-down fetch (sessions -> exercises -> sets, then
// filtered client-side by name) as loadWorkoutHistory/computeExerciseTrends
// use, rather than a reverse query filtered server-side on a nested
// column — keeps this on the one join pattern already proven to work here.
// Cached per exercise name for the rest of this page load — past sessions
// don't change mid-workout, so there's no reason to re-fetch on every
// drawer open.
const exerciseHistoryCache = {};
async function fetchExerciseHistory(exerciseName) {
  if (exerciseHistoryCache[exerciseName]) return exerciseHistoryCache[exerciseName];
  if (!currentUser) return [];
  const { data, error } = await db.from('workout_sessions')
    .select(`session_date, workout_exercises (name, workout_sets (set_number, reps, weight, unit))`)
    .eq('user_id', currentUser.id)
    .order('session_date', { ascending: false })
    .limit(60);
  if (error) { console.error('fetchExerciseHistory error:', error.message); return []; }

  const rows = [];
  (data || []).forEach(s => {
    (s.workout_exercises || []).forEach(ex => {
      if (ex.name !== exerciseName) return;
      const sets = (ex.workout_sets || []).slice().sort((a, b) => a.set_number - b.set_number);
      if (sets.length) rows.push({ date: s.session_date, sets });
    });
  });

  const result = rows.slice(0, 8); // most recent 8 sessions that featured this exercise
  exerciseHistoryCache[exerciseName] = result;
  return result;
}

// Fills in a history drawer opened via the "🕘 Previous sets" button —
// reuses the .wh-exercise/.set-chips/.set-chip classes the (now-summary-
// only) workout history cards used to render this exact shape with.
async function openExerciseHistory(ei) {
  const ex = activeExercises[ei];
  const inner = $(`history-drawer-inner-${ei}`);
  if (!ex || !inner) return;
  inner.innerHTML = `<span class="exercise-info-drawer__gif--loading">⏳</span>`;
  const rows = await fetchExerciseHistory(ex.name);
  if (!rows.length) {
    inner.innerHTML = `<p class="empty-state" style="margin:0">No previous sessions logged for this exercise yet.</p>`;
    return;
  }
  inner.innerHTML = rows.map(r => `
    <div class="wh-exercise">
      <div class="wh-exercise__name">${fmtDate(r.date)}</div>
      <div class="set-chips">${r.sets.map(st => `<span class="set-chip">${st.reps ?? '—'} × ${st.weight ?? '—'} ${st.unit || EXERCISE_WEIGHT_UNIT}</span>`).join('')}</div>
    </div>`).join('');
}

function renderStandaloneCard(ei) {
  const unit = EXERCISE_WEIGHT_UNIT;
  const ex = activeExercises[ei];
  const hasMedia = !!ex.media;
  // NOTE: injury-substitution system removed. wasSubstituted is never set
  // by anything currently, so this badge is inert. Reuse this pattern once
  // the variant-swap / skip-and-replace system sets an equivalent flag.
  const subBadge = ex.wasSubstituted
    ? `<span style="font-size:10px;background:var(--orange-light);color:var(--orange);border-radius:4px;padding:2px 6px;font-weight:600">Adapted</span>`
    : '';

  const setsHtml = ex.sets.map((s, si) => `
      <tr class="set-row ${s.done ? 'is-done' : ''}" data-ei="${ei}" data-si="${si}">
        <td class="set-num-cell">${s.setNum}</td>
        <td><input type="number" class="set-input ${s.done?'is-done':''}" step="1" min="0"
          placeholder="${ex.reps||'0'}" value="${s.reps}"
          data-ei="${ei}" data-si="${si}" data-field="reps" inputmode="numeric"
          ${s.done?'readonly':''}></td>
        <td><input type="number" class="set-input ${s.done?'is-done':''}" step="0.5" min="0"
          placeholder="0" value="${s.weight}"
          data-ei="${ei}" data-si="${si}" data-field="weight" inputmode="decimal"
          ${s.done?'readonly':''}>
          ${ex.equipmentType === 'barbell' ? `<div class="plate-hint" id="plateHint-${ei}-${si}">${formatPlateHint(ex.equipmentType, s.weight, ex.baseWeightKg)}</div>` : ''}</td>
        <td style="font-size:11px;color:var(--ink-3)">${unit}</td>
        <td>
          ${s.done
            ? `<button type="button" class="set-action-btn is-complete" data-ei="${ei}" data-si="${si}" title="Tap to edit this set">✓</button>`
            : `<button type="button" class="set-action-btn is-done-btn" data-ei="${ei}" data-si="${si}">Done</button>`
          }
        </td>
      </tr>`).join('');

  return `<div class="exercise-card" data-block-start="${ei}">
      <div class="exercise-card__head">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="exercise-card__name">
          ${ei === 0 ? '<span class="exercise-card__focus-tag">FOCUS</span>' : ''}
          <div class="exercise-card__name-text">${ex.name} ${subBadge} ${restBadgeHtml(ex)}</div>
        </div>
        <div class="exercise-card__actions">
          ${linkModeOn ? `<button type="button" class="exercise-card__link-btn ${linkPendingIndex === ei ? 'is-pending' : ''}" data-ei="${ei}" title="Tap to pair with another exercise">🔗</button>` : ''}
          <button type="button" class="exercise-card__history-btn" data-ei="${ei}" title="Previous sets">🕘</button>
          ${hasMedia ? `<button type="button" class="exercise-card__info-btn" data-ei="${ei}" title="Exercise guide">ⓘ</button>` : ''}
          <button type="button" class="exercise-card__equip-btn" data-ei="${ei}" title="Change equipment">🔁</button>
          <button type="button" class="exercise-card__remove-btn" data-ei="${ei}" title="Remove exercise">✕</button>
        </div>
      </div>
      ${ex.pr && ex.pr.best_weight != null ? `<div class="exercise-card__pr" style="font-size:12px;color:var(--ink-2);margin:0 16px 4px">
        🏆 Prefilled with your heaviest: ${ex.pr.best_weight}${ex.pr.best_weight_unit || 'kg'} × ${ex.pr.best_weight_reps || '?'} reps — beat it!
      </div>` : renderProgressionHint(ex)}
      ${ex.notes ? `<div class="exercise-card__notes">${ex.notes}</div>` : ''}
      ${hasMedia ? renderInfoDrawer(ei, ex) : ''}
      ${renderExerciseHistoryDrawer(ei)}
      <table class="active-sets-table">
        <thead>
          <tr>
            <th>Set</th><th>Reps</th><th>Weight</th><th>${unit}</th><th></th>
          </tr>
        </thead>
        <tbody>${setsHtml}</tbody>
      </table>
    </div>`;
}

// A superset/circuit renders as one card organised by round (Set 1, Set
// 2, …) instead of separate independent exercise cards each with their
// own set table — every member exercise's reps/weight for a round sit
// together, with one tick that completes the round for all of them at
// once and starts the shared rest timer, matching how a superset is
// actually performed (straight from one exercise into the next, then
// rest). group is 2 or more activeExercises indices, in order.
function renderSupersetCard(group) {
  const unit = EXERCISE_WEIGHT_UNIT;
  const members = group.map(ei => ({ ei, ex: activeExercises[ei] }));
  const roundCount = Math.max(...members.map(({ ex }) => ex.sets.length));

  const exHeaderRow = (ei, ex) => `
      <div class="superset-card__exrow">
        <span class="superset-card__exname">${ex.name} ${restBadgeHtml(ex)}</span>
        <div class="superset-card__exactions">
          <button type="button" class="exercise-card__history-btn" data-ei="${ei}" title="Previous sets">🕘</button>
          ${ex.media ? `<button type="button" class="exercise-card__info-btn" data-ei="${ei}" title="Exercise guide">ⓘ</button>` : ''}
          <button type="button" class="exercise-card__equip-btn" data-ei="${ei}" title="Change equipment">🔁</button>
          <button type="button" class="exercise-card__remove-btn" data-ei="${ei}" title="Remove exercise">✕</button>
        </div>
      </div>
      ${ex.media ? renderInfoDrawer(ei, ex) : ''}
      ${renderExerciseHistoryDrawer(ei)}`;

  let activeAssigned = false;
  const roundsHtml = [];
  for (let ri = 0; ri < roundCount; ri++) {
    const present = members.map(({ ei, ex }) => [ei, ex, ex.sets[ri]]).filter(([, , s]) => s);
    if (!present.length) continue;
    const allDone = present.every(([, , s]) => s.done);
    let state;
    if (allDone) state = 'done';
    else if (!activeAssigned) { state = 'active'; activeAssigned = true; }
    else state = 'upcoming';

    const exRowsHtml = present.map(([ei, ex, s]) => `
          <div class="round-ex">
            <span class="round-ex__name">${ex.name}</span>
            <div class="round-ex__inputs">
              <input type="number" class="set-input round-ex__input ${s.done?'is-done':''}" step="1" min="0"
                placeholder="${ex.reps||'0'}" value="${s.reps}"
                data-ei="${ei}" data-si="${ri}" data-field="reps" inputmode="numeric" ${s.done?'readonly':''}>
              <span class="round-ex__unit">reps</span>
              <input type="number" class="set-input round-ex__input ${s.done?'is-done':''}" step="0.5" min="0"
                placeholder="0" value="${s.weight}"
                data-ei="${ei}" data-si="${ri}" data-field="weight" inputmode="decimal" ${s.done?'readonly':''}>
              <span class="round-ex__unit">${unit}</span>
              ${ex.equipmentType === 'barbell' ? `<div class="plate-hint" id="plateHint-${ei}-${ri}">${formatPlateHint(ex.equipmentType, s.weight, ex.baseWeightKg)}</div>` : ''}
            </div>
          </div>`).join('');

    const setNum = present[0][2].setNum;
    const presentEis = present.map(([ei]) => ei).join(',');
    roundsHtml.push(`
      <div class="round round--${state}">
        <div class="round__label-row">
          <span class="round__label">Set ${setNum}</span>
          ${state === 'done' ? `<span class="round__status">✓ Done</span>` : ''}
        </div>
        <div class="round__exercises">${exRowsHtml}</div>
        <div class="round__tick-row">
          <button type="button" class="round__tick" data-round-eis="${presentEis}" data-round-si="${ri}" ${state === 'done' ? 'data-round-done="1"' : ''}>
            ${state === 'done' ? '✓ All done' : '○ Tap when all done'}
          </button>
        </div>
      </div>`);
  }

  return `<div class="superset-card" data-block-start="${group[0]}">
      <div class="superset-card__head">
        <span class="drag-handle" title="Drag to reorder">⠿</span>
        <div class="superset-card__titles">
          <div class="superset-card__eyebrow">⚡ Superset</div>
          ${members.map(({ ei, ex }) => exHeaderRow(ei, ex)).join('')}
        </div>
        <button type="button" class="superset-card__unlink" data-ei="${group[0]}">Unpair</button>
      </div>
      ${roundsHtml.join('')}
    </div>`;
}

function renderActiveWorkout() {
  const split = activeRoutine.split_type;
  const cls   = split.replace(/\s+/g,'-');

  elW.activeHeader.innerHTML = `
    <div>
      <div class="routine-name">${activeRoutine.name}</div>
      <div class="routine-meta">${activeRoutine.rest_seconds}s rest · ${activeRoutine.min_duration}–${activeRoutine.max_duration} min</div>
      ${linkModeOn ? `<div class="link-mode-hint">${linkPendingIndex === null ? 'Tap an exercise, then its partner, to pair them' : 'Now tap the exercise to pair it with'}</div>` : ''}
    </div>
    <div class="active-header__right">
      <button type="button" id="btnLinkMode" class="superset-toggle ${linkModeOn ? 'is-on' : ''}" title="Tap two exercises to pair them as a superset">
        🔗 Link ${linkModeOn ? 'On' : 'Off'}
      </button>
      <button type="button" id="btnSupersetToggle" class="superset-toggle ${supersetModeOn ? 'is-on' : ''}" title="Pair exercises as supersets — rest only after each pair">
        ⚡ Supersets ${supersetModeOn ? 'On' : 'Off'}
      </button>
      <span class="split-tag split-tag--${cls}">${split}</span>
    </div>`;

  $('btnSupersetToggle')?.addEventListener('click', () => {
    supersetModeOn = !supersetModeOn;
    renderActiveWorkout();
  });

  $('btnLinkMode')?.addEventListener('click', () => {
    linkModeOn = !linkModeOn;
    linkPendingIndex = null;
    renderActiveWorkout();
  });

  const blocksHtml = [];
  for (let ei = 0; ei < activeExercises.length; ei++) {
    const group = getBlockExercises(ei);
    if (!group) continue; // mid-group — already rendered as part of its group's start index
    blocksHtml.push(group.length > 1 ? renderSupersetCard(group) : renderStandaloneCard(ei));
  }
  elW.activeExList.innerHTML = blocksHtml.join('') + `<button type="button" class="add-exercise-btn" id="btnAddExercise">+ Add exercise</button>`;

  const addBtn = document.getElementById('btnAddExercise');
  if (addBtn) addBtn.addEventListener('click', () => openAddExercisePicker());

  // Only one drawer (info OR history, on any exercise) open at a time —
  // both button classes and both drawer flavors share this helper so
  // opening one always cleanly closes whatever else was open.
  const closeAllExerciseDrawers = () => {
    elW.activeExList.querySelectorAll('.exercise-info-drawer').forEach(d => d.classList.remove('is-open'));
    elW.activeExList.querySelectorAll('.exercise-card__info-btn, .exercise-card__history-btn').forEach(b => b.classList.remove('is-open'));
  };

  // Wire info buttons
  elW.activeExList.querySelectorAll('.exercise-card__info-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei;
      const drawer = $(`drawer-${ei}`);
      const isOpen = drawer.classList.contains('is-open');
      closeAllExerciseDrawers();
      if (!isOpen) {
        drawer.classList.add('is-open');
        btn.classList.add('is-open');
        // Lazy-load GIF if not yet fetched
        const ex = activeExercises[ei];
        if (!ex.media?.gif_url && ex.media?.search_name) {
          await fetchExerciseGif(ei);
        }
      }
    });
  });

  // Wire "🕘 Previous sets" buttons
  elW.activeExList.querySelectorAll('.exercise-card__history-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei;
      const drawer = $(`history-drawer-${ei}`);
      if (!drawer) return;
      const isOpen = drawer.classList.contains('is-open');
      closeAllExerciseDrawers();
      if (!isOpen) {
        drawer.classList.add('is-open');
        btn.classList.add('is-open');
        await openExerciseHistory(ei);
      }
    });
  });

  // Any refresh button already present at initial render (a mismatch carried
  // over from earlier this session) needs wiring too — fetchExerciseGif()
  // re-wires its own on every subsequent render, but the very first paint
  // is built from the template string above, not from that function.
  activeExercises.forEach((ex, ei) => {
    if (ex.media?.matched_name) wireGifRefreshButton(ei);
  });

  elW.activeExList.querySelectorAll('.exercise-card__remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei;
      const ex = activeExercises[ei];
      if (!confirm(`Remove ${ex.name} from this workout?`)) return;

      const { error } = await db.from('user_routine_customizations')
        .delete().eq('id', ex.id);

      if (error) {
        console.error('Failed to remove exercise:', error.message);
        alert('Could not remove this exercise — please try again.');
        return;
      }

      activeExercises.splice(ei, 1);
      renderActiveWorkout();
    });
  });

  elW.activeExList.querySelectorAll('.exercise-card__equip-btn').forEach(btn => {
    btn.addEventListener('click', () => openEquipmentPicker(+btn.dataset.ei));
  });

  elW.activeExList.querySelectorAll('.exercise-card__link-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ei = +btn.dataset.ei;
      if (linkPendingIndex === null) {
        linkPendingIndex = ei; // first tap — awaiting a partner
      } else if (linkPendingIndex === ei) {
        linkPendingIndex = null; // tapped the same one again — cancel
      } else {
        pairExercises(linkPendingIndex, ei);
        linkPendingIndex = null;
      }
      renderActiveWorkout();
    });
  });

  elW.activeExList.querySelectorAll('.superset-card__unlink').forEach(btn => {
    btn.addEventListener('click', () => {
      unlinkPair(+btn.dataset.ei);
      renderActiveWorkout();
    });
  });

  // Wire set inputs — shared by the standalone table and superset round
  // rows alike, since both key their inputs by the same data-ei/data-si/
  // data-field attributes regardless of which layout they sit inside.
  elW.activeExList.querySelectorAll('.set-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const ei = +inp.dataset.ei, si = +inp.dataset.si;
      activeExercises[ei].sets[si][inp.dataset.field] = inp.value;
      // Typing a weight by hand is a deliberate value (planning ahead, a
      // drop set, whatever) — clears the auto-filled flag so a later
      // completed set's cascade (below) won't steamroll it.
      if (inp.dataset.field === 'weight') activeExercises[ei].sets[si].weightAutoFilled = false;
      saveWorkoutState(); // persist every keystroke

      // Live plate breakdown as the weight is typed — the hint div (only
      // present for barbell exercises) sits right next to this same
      // input, keyed by the same ei/si so it doesn't need a full re-render.
      if (inp.dataset.field === 'weight') {
        const hint = $(`plateHint-${ei}-${si}`);
        if (hint) hint.textContent = formatPlateHint(activeExercises[ei].equipmentType, inp.value, activeExercises[ei].baseWeightKg);
      }
    });
  });

  // Wire done buttons — complete set + start rest timer (standalone exercises)
  elW.activeExList.querySelectorAll('.set-action-btn.is-done-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei, si = +btn.dataset.si;
      const ex = activeExercises[ei];
      ex.sets[si].done = true;

      // Carry this set's weight into any remaining not-yet-done sets for
      // the same exercise — the LATEST completed set is the reference
      // going forward, not just set 1. A set the person already typed a
      // weight into by hand (planning ahead, a deliberate different load)
      // is left alone; one still holding an earlier set's auto-filled
      // value gets updated to track the most recent completion instead.
      ex.sets[si].weightAutoFilled = false; // this set's own weight is now a confirmed, real value
      const completedWeight = ex.sets[si].weight;
      if (completedWeight) {
        for (let laterSi = si + 1; laterSi < ex.sets.length; laterSi++) {
          if (!ex.sets[laterSi].done && (!ex.sets[laterSi].weight || ex.sets[laterSi].weightAutoFilled)) {
            ex.sets[laterSi].weight = completedWeight;
            ex.sets[laterSi].weightAutoFilled = true;
          }
        }
      }

      renderActiveWorkout();

      // Find next set label
      const nextSet = ex.sets[si + 1];
      const nextEx  = !nextSet ? activeExercises[ei + 1] : null;
      const nextLabel = nextSet
        ? `Set ${nextSet.setNum} of ${ex.name}`
        : nextEx ? `${nextEx.name}` : null;

      if (nextLabel) {
        await startRestTimer(ex.restSeconds, nextLabel);
      }
    });
  });

  // Tapping a completed set's checkmark reopens just that set for
  // editing — un-marking it as done removes readonly from its own
  // inputs on the next render, without touching any other set's lock
  // state, since s.done is checked per-set, not exercise-wide.
  elW.activeExList.querySelectorAll('.set-action-btn.is-complete').forEach(btn => {
    btn.addEventListener('click', () => {
      const ei = +btn.dataset.ei, si = +btn.dataset.si;
      activeExercises[ei].sets[si].done = false;
      renderActiveWorkout();
    });
  });

  // Wire round ticks — one tick completes (or reopens) the current round
  // for every exercise in the superset/circuit at once, then starts the
  // shared rest timer exactly once, instead of ticking each exercise
  // separately. Works for a pair or a larger circuit alike since it just
  // operates on however many indices the round's data-round-eis lists.
  elW.activeExList.querySelectorAll('.round__tick').forEach(btn => {
    btn.addEventListener('click', async () => {
      const eis = btn.dataset.roundEis.split(',').map(Number);
      const si = +btn.dataset.roundSi;
      const exs = eis.map(ei => activeExercises[ei]);
      const sets = exs.map(ex => ex.sets[si]);

      if (btn.dataset.roundDone === '1') {
        sets.forEach(s => { if (s) s.done = false; });
        renderActiveWorkout();
        return;
      }

      sets.forEach(s => { if (s) s.done = true; });

      exs.forEach((ex, i) => {
        const s = sets[i];
        if (!s || !s.weight) return;
        s.weightAutoFilled = false; // this round's own weight is now a confirmed, real value
        for (let laterSi = si + 1; laterSi < ex.sets.length; laterSi++) {
          const later = ex.sets[laterSi];
          if (!later.done && (!later.weight || later.weightAutoFilled)) {
            later.weight = s.weight;
            later.weightAutoFilled = true;
          }
        }
      });

      renderActiveWorkout();

      const lastEi = eis[eis.length - 1];
      const nextRoundSet = exs.map(ex => ex.sets[si + 1]).find(Boolean);
      const nextEx = !nextRoundSet ? activeExercises[lastEi + 1] : null;
      const nextLabel = nextRoundSet
        ? `Set ${nextRoundSet.setNum} of ${exs.map(ex => ex.name).join(' + ')}`
        : nextEx ? nextEx.name : null;

      if (nextLabel) {
        await startRestTimer(exs[0].restSeconds, nextLabel);
      }
    });
  });

  wireBlockDragging();

  elW.picker.hidden = true;
  elW.active.hidden = false;
}

// Touch-friendly drag-to-reorder for the whole exercise list, built on
// Pointer Events rather than the HTML5 drag-and-drop API — iOS Safari
// (this app's primary target) doesn't fire native dragstart from touch on
// plain elements, only from mouse input, so the desktop-only DnD API used
// elsewhere in this file (the routine admin editor) wouldn't work here.
// The dragged block visually follows the finger via a translateY while
// held; dropping snaps it to sit before or after whichever other block the
// pointer was last over, depending on which half of it the pointer ended
// up on (see the comment on reorderBlock for why that half matters).
function wireBlockDragging() {
  const blocks = Array.from(elW.activeExList.querySelectorAll('[data-block-start]'));
  let drag = null;

  blocks.forEach(blockEl => {
    const handle = blockEl.querySelector('.drag-handle');
    if (!handle) return;

    handle.addEventListener('pointerdown', e => {
      e.preventDefault();
      drag = {
        blockEl,
        startY: e.clientY,
        target: null,
        insertAfter: false,
        rects: blocks.map(b => {
          const r = b.getBoundingClientRect();
          return { el: b, top: r.top, height: r.height };
        }),
      };
      blockEl.classList.add('is-dragging');
      try { handle.setPointerCapture(e.pointerId); } catch {}
    });

    handle.addEventListener('pointermove', e => {
      if (!drag || drag.blockEl !== blockEl) return;
      blockEl.style.transform = `translateY(${e.clientY - drag.startY}px)`;

      blocks.forEach(b => b.classList.remove('is-drop-target'));
      const hit = drag.rects.find(r => r.el !== blockEl && e.clientY >= r.top && e.clientY <= r.top + r.height);
      drag.target = hit ? hit.el : null;
      drag.insertAfter = hit ? e.clientY > hit.top + hit.height / 2 : false;
      if (drag.target) drag.target.classList.add('is-drop-target');
    });

    const finishDrag = () => {
      if (!drag || drag.blockEl !== blockEl) return;
      blockEl.classList.remove('is-dragging');
      blockEl.style.transform = '';
      blocks.forEach(b => b.classList.remove('is-drop-target'));
      const target = drag.target;
      const insertAfter = drag.insertAfter;
      drag = null;
      if (target) {
        reorderBlock(+blockEl.dataset.blockStart, +target.dataset.blockStart, insertAfter);
      }
    };
    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  });
}

// ── Lazy GIF fetching via Netlify Function proxy ──────────
async function fetchExerciseGif(ei, excludeId = null) {
  const ex = activeExercises[ei];
  if (!ex.media) return;

  const gifEl = $(`gif-${ei}`);
  if (gifEl) { gifEl.innerHTML = `<span class="exercise-info-drawer__gif--loading">⏳</span>`; }

  try {
    const url = `${FUNCTIONS_ORIGIN}/exercise-media?name=${encodeURIComponent(ex.media.search_name)}`
      + (excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : '');
    const res  = await fetch(url, { headers: FUNCTIONS_ANON_HEADERS });
    const data = await res.json();
    if (data.gifUrl) {
      ex.media.gif_url      = data.gifUrl;
      ex.media.matched_name = data.name;
      ex.media.exercisedb_id = data.exerciseId;
      // Cache in Supabase for next time — fire-and-forget is fine for UX
      // (the GIF is already rendering from data.gifUrl below regardless of
      // whether this write succeeds), but the result must be checked so a
      // write failure is visible rather than silently doing nothing.
      db.from('exercise_media').update({ gif_url: data.gifUrl, exercisedb_id: data.exerciseId })
        .eq('exercise_name', ex.name)
        .then(({ error }) => {
          if (error) console.warn(`GIF cache write failed for "${ex.name}":`, error.message);
        });
      // Show mismatch label + a working "try another match" button if what
      // ExerciseDB matched differs from what we asked for.
      const nameDiffers = data.name?.toLowerCase() !== ex.name.toLowerCase();
      if (gifEl) {
        gifEl.innerHTML = `
          <img src="${data.gifUrl}" alt="${ex.name}" loading="lazy">
          ${nameDiffers ? `<div class="gif-match-label">Showing: ${data.name} <button class="gif-refresh-btn" data-ei="${ei}" title="Try a different match">↻</button></div>` : ''}
        `;
        wireGifRefreshButton(ei);
      }
    } else {
      if (gifEl) gifEl.innerHTML = `<span style="font-size:12px;color:var(--ink-4);text-align:center;padding:8px">No animation found</span>`;
    }
  } catch {
    if (gifEl) gifEl.innerHTML = `<span style="font-size:12px;color:var(--ink-4);padding:8px">Could not load</span>`;
  }
}

// The refresh button is re-created every time fetchExerciseGif rewrites the
// drawer's innerHTML, so it needs re-wiring each time rather than once.
function wireGifRefreshButton(ei) {
  const btn = document.querySelector(`#gif-${ei} .gif-refresh-btn`);
  if (!btn) return;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const ex = activeExercises[ei];
    fetchExerciseGif(ei, ex.media?.exercisedb_id || null);
  });
}

// ── Back to picker ────────────────────────────────────────
// Purely a navigation action — switches which screen is visible, nothing
// more. This used to also wipe activeRoutine/activeExercises outright, so
// one accidental tap (easy to fat-finger — it sits top-left of the active
// workout screen) silently discarded an entire in-progress session with no
// confirmation. The workout now stays alive in memory (and localStorage,
// via saveWorkoutState) until it's explicitly saved or abandoned — see
// renderActiveWorkoutBanner's "Continue workout"/"Abandon workout" banner,
// which is what a returning user sees here instead of a blank picker.
elW.backToPicker.addEventListener('click', () => {
  elW.active.hidden  = true;
  elW.picker.hidden  = false;
  renderActiveWorkoutBanner();
  loadRoutines();
});

// ── Save workout ──────────────────────────────────────────
elW.btnSaveWorkout.addEventListener('click', async () => {
  if (!activeRoutine) return;
  const unit = EXERCISE_WEIGHT_UNIT;
  const date = elW.workoutDate.value || todayISO();

  setBtn(elW.btnSaveWorkout, true, 'Save workout');

  const { data: session, error: se } = await db.from('workout_sessions')
    .insert({
      user_id: currentUser.id, session_date: date, split_type: activeRoutine.split_type,
      started_at: workoutStartedAtMs ? new Date(workoutStartedAtMs).toISOString() : null,
    })
    .select().single();

  if (se) { showToast('Error: ' + se.message, true); setBtn(elW.btnSaveWorkout, false, 'Save workout'); return; }

  for (let ei = 0; ei < activeExercises.length; ei++) {
    const ex = activeExercises[ei];
    const doneSets = ex.sets.filter(s => s.done || s.reps || s.weight);
    if (!doneSets.length) continue;

    const { data: exRow } = await db.from('workout_exercises')
      .insert({ session_id: session.id, name: ex.name, sort_order: ei })
      .select().single();

    if (exRow) {
      const setRows = doneSets.map((s, i) => ({
        exercise_id: exRow.id, set_number: i + 1,
        reps: parseInt(s.reps) || null,
        weight: parseFloat(s.weight) || null, unit,
      }));
      await db.from('workout_sets').insert(setRows);
    }
  }

  setBtn(elW.btnSaveWorkout, false, 'Save workout');
  flash(elW.workoutStatus, `Workout saved — ${activeExercises.length} exercise${activeExercises.length===1?'':'s'}.`);
  activeRoutine = null; activeExercises = []; workoutStartedAtMs = null;
  clearWorkoutState(); // otherwise a stale copy lingers and could get restored/re-saved after a later reload
  elW.active.hidden = true;
  elW.picker.hidden = false;
  renderActiveWorkoutBanner();
  loadRoutines();
});

// ── History ───────────────────────────────────────────────
elW.btnWorkoutHistory.addEventListener('click', () => {
  elW.picker.hidden = true;
  elW.historyPanel.hidden = false;
  loadWorkoutHistory();
});
elW.btnCloseHistory.addEventListener('click', () => {
  elW.historyPanel.hidden = true;
  elW.picker.hidden = false;
});
elW.historyFilterSplit.addEventListener('change', loadWorkoutHistory);

// Summary only, not a full exercise/set-by-set dump — matches the same
// "one card, key stats" shape as renderActivityHistoryCard below rather
// than the two systems reading as visually different. The per-exercise
// set detail this used to show lives on the exercise's own "🕘 Previous"
// button during an active workout instead (see fetchExerciseHistory) —
// genuinely useful mid-set, not something worth re-scanning in a history
// list of many past sessions.
function renderStrengthHistoryCard(s, appleMatch) {
  const exercises = s.workout_exercises || [];
  let totalSets = 0, totalVolume = 0;
  exercises.forEach(ex => {
    (ex.workout_sets || []).forEach(st => {
      if (st.reps != null || st.weight != null) totalSets++;
      const w = Number(st.weight), r = Number(st.reps);
      if (Number.isFinite(w) && w > 0 && Number.isFinite(r) && r > 0) totalVolume += w * r;
    });
  });

  const ownParts = [];
  if (exercises.length) ownParts.push(`<span class="last-workout-stat">🏋️ ${exercises.length} exercise${exercises.length === 1 ? '' : 's'}</span>`);
  if (totalSets) ownParts.push(`<span class="last-workout-stat">🔢 ${totalSets} set${totalSets === 1 ? '' : 's'}</span>`);
  if (totalVolume > 0) ownParts.push(`<span class="last-workout-stat">📦 ${Math.round(totalVolume).toLocaleString()} ${EXERCISE_WEIGHT_UNIT} volume</span>`);

  // Apple-matched stats (duration/kcal/HR/distance) lead when present —
  // real measured data over fitl00p's own derived-from-logged-sets ones.
  const allParts = [...(appleMatch ? workoutStatParts(appleMatch) : []), ...ownParts];

  return `<div class="wh-card">
    <div class="wh-card__head">
      <span class="wh-card__date">${fmtDate(s.session_date)}</span>
      ${splitTag(s.split_type)}
    </div>
    <div class="wh-card__body">
      ${allParts.length ? `<div class="last-workout-stats">${allParts.join('')}</div>` : '<p class="empty-state">No stats recorded</p>'}
    </div>
  </div>`;
}

// A non-strength (or Watch-only, never logged as a fitl00p routine)
// activity — an Apple Health workout or a manual_activities row (e.g. a
// walk Apple never recorded at all). Both use the same card shape as a
// strength session so the combined history list reads as one continuous
// timeline rather than two visually different systems bolted together.
function renderActivityHistoryCard(item, isManual) {
  const typeStr = isManual ? item.activity_type : item.workout_type;
  const label = isManual ? (MANUAL_ACTIVITY_LABELS[typeStr] || typeStr) : appleWorkoutTypeLabel(typeStr);
  const icon = dxActivityIcon(typeStr) || (isManual ? '📍' : '🏃');
  const dateStr = fmtDate(String(item.started_at).slice(0, 10));
  const timeStr = new Date(item.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const parts = workoutStatParts(item);
  if (isManual && item.unplugged) parts.push('<span class="last-workout-stat">🔌 unplugged</span>');
  const statsHtml = parts.length ? `<div class="last-workout-stats">${parts.join('')}</div>` : '<p class="empty-state">No stats recorded</p>';

  return `<div class="wh-card">
    <div class="wh-card__head">
      <span class="wh-card__date">${dateStr} · ${timeStr}</span>
      <span class="split-tag split-tag--Other">${escapeHtml(icon + ' ' + label)}</span>
    </div>
    <div class="wh-card__body">${statsHtml}</div>
  </div>`;
}

// Combined chronological activity history: fitl00p-logged strength
// sessions (paired with their Watch-synced stats when a match exists —
// same matching the dashboard's Last Workout card uses), plus every
// other Apple Health workout and manually-logged activity (walks, runs,
// swims) that isn't already accounted for by one of those sessions.
// Filtering by a specific split only makes sense for strength sessions —
// showing every walk alongside a "Push only" filter would be confusing —
// so non-strength activity is skipped entirely once a split is chosen.
async function loadWorkoutHistory() {
  if (!currentUser) return;
  elW.workoutHistoryList.innerHTML = '<p class="empty-state">Loading…</p>';

  let sessionsQ = db.from('workout_sessions')
    .select(`id, session_date, split_type, started_at,
             workout_exercises (id, name, sort_order,
               workout_sets (set_number, reps, weight, unit))`)
    .eq('user_id', currentUser.id)
    .order('session_date', { ascending: false })
    .limit(40);
  const splitFilterActive = !!elW.historyFilterSplit.value;
  if (splitFilterActive) sessionsQ = sessionsQ.eq('split_type', elW.historyFilterSplit.value);

  const [sessionsRes, appleRes, manualRes] = await Promise.all([
    sessionsQ,
    splitFilterActive ? Promise.resolve({ data: [] }) : db.from('apple_health_workouts')
      .select('id, workout_type, started_at, ended_at, active_energy_kcal, total_energy_kcal, avg_heart_rate, max_heart_rate, distance_km')
      .eq('user_id', currentUser.id)
      .order('started_at', { ascending: false })
      .limit(60),
    splitFilterActive ? Promise.resolve({ data: [] }) : db.from('manual_activities')
      .select('id, activity_type, started_at, ended_at, unplugged')
      .eq('user_id', currentUser.id)
      .order('started_at', { ascending: false })
      .limit(60),
  ]);

  if (sessionsRes.error) console.error('loadWorkoutHistory (workout_sessions) error:', sessionsRes.error.message);
  const sessions = sessionsRes.data || [];
  const appleWorkouts = appleRes.data || [];
  const manualActivities = manualRes.data || [];

  if (!sessions.length && !appleWorkouts.length && !manualActivities.length) {
    elW.workoutHistoryList.innerHTML = '<p class="empty-state">No activity logged yet.</p>';
    renderStrengthProgress([]);
    return;
  }

  const consumedAppleIds = new Set();
  const items = sessions.map(s => {
    const matched = matchAppleWorkout(s, appleWorkouts);
    if (matched) consumedAppleIds.add(matched.id);
    return {
      sortTime: new Date(s.started_at || `${s.session_date}T12:00:00`).getTime(),
      html: renderStrengthHistoryCard(s, matched),
    };
  });

  appleWorkouts
    .filter(w => !consumedAppleIds.has(w.id))
    .forEach(w => items.push({ sortTime: new Date(w.started_at).getTime(), html: renderActivityHistoryCard(w, false) }));

  // A manual entry that overlaps a real Apple workout is the same
  // real-world activity recorded twice (e.g. hand-logged, then later
  // also auto-detected/confirmed) — show it once.
  const overlapsAnyAppleWorkout = m => {
    const ms = new Date(m.started_at).getTime(), me = new Date(m.ended_at).getTime();
    return appleWorkouts.some(w => {
      const ws = new Date(w.started_at).getTime(), we = new Date(w.ended_at).getTime();
      return ms < we && me > ws;
    });
  };
  manualActivities
    .filter(m => !overlapsAnyAppleWorkout(m))
    .forEach(m => items.push({ sortTime: new Date(m.started_at).getTime(), html: renderActivityHistoryCard(m, true) }));

  items.sort((a, b) => b.sortTime - a.sortTime);
  elW.workoutHistoryList.innerHTML = items.map(i => i.html).join('');

  renderStrengthProgress(sessions);
}

// Estimated 1RM per exercise (Epley formula: weight × (1 + reps/30)), using
// the same session data already fetched for the history list — no extra query.
// Reps outside 1–15 are excluded since the formula gets unreliable past that.
function computeExerciseTrends(sessions) {
  const byExercise = {};
  sessions.forEach(s => {
    (s.workout_exercises || []).forEach(ex => {
      const ests = (ex.workout_sets || [])
        .map(st => {
          const w = Number(st.weight), r = Number(st.reps);
          if (!isFinite(w) || w <= 0 || !isFinite(r) || r < 1 || r > 15) return null;
          return w * (1 + r / 30);
        })
        .filter(v => v != null);
      if (!ests.length) return;
      const best = Math.max(...ests);
      if (!byExercise[ex.name]) byExercise[ex.name] = [];
      byExercise[ex.name].push({ date: s.session_date, est1RM: best });
    });
  });
  Object.values(byExercise).forEach(arr => arr.sort((a, b) => a.date.localeCompare(b.date)));
  return byExercise;
}

function renderStrengthProgress(sessions) {
  if (!elW.strengthProgress) return;
  const trends = computeExerciseTrends(sessions);
  const names = Object.keys(trends);
  if (!names.length) { elW.strengthProgress.innerHTML = ''; return; }

  const unit = EXERCISE_WEIGHT_UNIT;

  // Most recently trained lifts first, capped at 6 to keep this scannable
  const ranked = names
    .map(name => ({ name, series: trends[name], last: trends[name][trends[name].length - 1] }))
    .sort((a, b) => b.last.date.localeCompare(a.last.date))
    .slice(0, 6);

  elW.strengthProgress.innerHTML = `
    <div class="strength-progress__label">ESTIMATED 1RM · RECENT LIFTS</div>
    <div class="strength-progress__list">
      ${ranked.map((r, idx) => {
        const curr  = r.last.est1RM;
        const delta = curr - r.series[0].est1RM;
        return `<div class="strength-row">
          <div class="strength-row__top">
            <span class="strength-row__name">${r.name}</span>
            <span class="strength-row__val">${curr.toFixed(1)}${unit}</span>
          </div>
          <canvas id="strengthSpark${idx}" class="strength-row__spark" height="28"></canvas>
          ${r.series.length > 1 ? `<span class="strength-row__delta ${delta >= 0 ? 'is-up' : 'is-down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}${unit} since first logged</span>` : ''}
        </div>`;
      }).join('')}
    </div>
    <p class="strength-progress__note">Estimated from your logged sets (Epley formula) — a guide, not a max test.</p>`;

  const trendColor = getComputedStyle(document.documentElement).getPropertyValue('--green').trim() || '#16A34A';
  ranked.forEach((r, idx) => {
    drawSparkline(`strengthSpark${idx}`, r.series.map(p => p.est1RM), {
      stroke: trendColor, fillTop: 'rgba(22,163,74,.18)', fillBottom: 'rgba(22,163,74,0)',
    });
  });
}

function splitTag(type) {
  if (!type) return '';
  const cls = type.replace(/\s+/g, '-');
  return `<span class="split-tag split-tag--${cls}">${type}</span>`;
}

/* ═══════════════════════════════════════════════════════════
   HISTORY
═══════════════════════════════════════════════════════════ */
async function loadHistory() {
  if (!currentUser) return;
  const unit = BODY_WEIGHT_UNIT;

  // Manual weight logging — button only shown for an account with the
  // Settings toggle on; card itself starts closed on every tab visit.
  const weightLogToggle = $('btnWeightLogToggle');
  if (weightLogToggle) weightLogToggle.hidden = !profile?.manual_weight_logging;
  const weightLogCard = $('weightLogCard');
  if (weightLogCard) weightLogCard.hidden = true;

  // Peptides (Tirzepatide/MOTS-C/BPC-157) — Lewy's account only. The 💉
  // entry point and the panel behind it both hide for Gemma, who doesn't
  // use any peptides, rather than relying on the panel just looking empty.
  const isGemma = currentUser.id === GEMMA_USER_ID;
  if (el.btnTzToggle) el.btnTzToggle.hidden = isGemma;
  if (el.peptideSection) el.peptideSection.hidden = true;
  if (el.btnOralMedsToggle) el.btnOralMedsToggle.hidden = isGemma;
  if (el.oralMedsSection) el.oralMedsSection.hidden = true;

  // Fetch daily logs
  const { data } = await db
    .from('daily_logs')
    .select('log_date, weight, steps, cal_total, cal_apple, cal_mfp')
    .eq('user_id', currentUser.id)
    .order('log_date', { ascending: false })
    .limit(120);

  const rows = data || [];
  if (!rows.length) {
    el.historyTableBody.innerHTML = '<tr class="table-empty"><td colspan="5">No entries yet.</td></tr>';
    drawChart(el.historyChart, el.historyChartEmpty, []);
    return;
  }

  // Fetch burned calories from health_daily for the same date range
  // Total burn = active energy + resting energy (full-day expenditure)
  const oldestDate = rows[rows.length - 1]?.log_date;
  const { data: healthRows } = await db
    .from('health_daily')
    .select('log_date, active_energy_kcal, resting_energy_kcal')
    .eq('user_id', currentUser.id)
    .gte('log_date', oldestDate)
    .order('log_date', { ascending: false });

  const burnByDate = {};
  (healthRows || []).forEach(h => {
    // Postgres numeric columns can arrive as strings rather than JS
    // numbers — plain `a + r` on two such strings concatenates instead
    // of adding ("524.8" + "1431.2" -> "524.81431.2", not 1956), which
    // Math.round then turns into NaN. Number() first avoids that.
    const a = h.active_energy_kcal  != null ? Number(h.active_energy_kcal)  : null;
    const r = h.resting_energy_kcal != null ? Number(h.resting_energy_kcal) : null;
    burnByDate[h.log_date] = (a != null && r != null) ? Math.round(a + r)
                           : (a != null)              ? Math.round(a)
                           : null;
  });

  // Native fitl00p food log for the same range as the table itself — top
  // of pickConsumedCalories' precedence (see there). Matches oldestDate
  // (same range health_daily above queries) rather than just today, so a
  // day logged natively but not today still shows Consumed once cal_mfp
  // stops being populated (e.g. after MFP syncing is dropped).
  const { data: foodRows } = await db
    .from('food_log')
    .select('log_date, calories_kcal')
    .eq('user_id', currentUser.id)
    .gte('log_date', oldestDate);
  const foodByDate = {};
  (foodRows || []).forEach(r => {
    foodByDate[r.log_date] = (foodByDate[r.log_date] || 0) + (Number(r.calories_kcal) || 0);
  });

  el.historyTableBody.innerHTML = rows.map(r => {
    const cals    = pickConsumedCalories({ ...r, cal_fitl00p: foodByDate[r.log_date] ?? null }, null);
    const burned  = burnByDate[r.log_date] ?? null;
    const displayWeight = r.weight != null ? weightFromKg(r.weight, unit) : null; // r.weight is kg
    return `
    <tr>
      <td>${fmtDate(r.log_date)}</td>
      <td class="${displayWeight != null ? '' : 'dim'}">${displayWeight != null ? fmt1(displayWeight) + ' ' + unit : '—'}</td>
      <td class="${r.steps ? '' : 'dim'}">${r.steps ? fmtInt(r.steps) : '—'}</td>
      <td class="${cals  ? '' : 'dim'}">${cals   != null ? fmtInt(cals)   + ' kcal' : '—'}</td>
      <td class="${burned ? '' : 'dim'}">${burned != null ? fmtInt(burned) + ' kcal' : '—'}</td>
    </tr>`;
  }).join('');

  const series = rows.filter(r => r.weight != null).reverse(); // weight stays canonical kg

  drawChart(
    el.historyChart,
    el.historyChartEmpty,
    series.map(r => ({ date: r.log_date, weight: weightFromKg(r.weight, unit) })),
    activePlan ? { ...activePlan, start_weight: weightFromKg(activePlan.start_weight, unit), target_weight: weightFromKg(activePlan.target_weight, unit) } : null
  );

  renderWeightVariance(series);
}

function renderWeightVariance(series) {
  const el2 = $('historyVariance');
  if (!el2) return;
  if (!activePlan || series.length < 2) { el2.hidden = true; return; }

  // Exclude synthetic today entry (has same weight as previous — added just for chart x-axis)
  const realSeries = series.filter((p, i) => {
    if (i === series.length - 1 && p.log_date === todayISO() && i > 0) {
      return series[i-1].weight !== p.weight; // exclude if weight unchanged (synthetic)
    }
    return true;
  });

  const start   = new Date(activePlan.start_date  + 'T00:00:00');
  const end     = new Date(activePlan.target_date  + 'T00:00:00');
  const today   = new Date(todayISO()              + 'T00:00:00');
  const totalMs = end - start;
  const elapsedMs = Math.max(0, today - start);
  const pctElapsed = Math.min(1, elapsedMs / totalMs);

  // Where you should be today on the straight-line projection
  const expectedNow = activePlan.start_weight +
    (activePlan.target_weight - activePlan.start_weight) * pctElapsed;

  // Latest actual weight — use realSeries not synthetic entry. Both this
  // and expectedNow (derived from activePlan.*_weight) are canonical kg —
  // the diff/tolerance below stays in kg; only the displayed number is
  // converted to the current unit.
  const latestActual = realSeries[realSeries.length - 1]?.weight;
  if (latestActual == null) { el2.hidden = true; return; }

  const unit = BODY_WEIGHT_UNIT;
  const diff = expectedNow - latestActual; // kg, positive = ahead (lost more than projected)
  const absDiff = Math.abs(weightFromKg(diff, unit)).toFixed(1);
  const isAhead = diff > 0.1;
  const isBehind = diff < -0.1;

  el2.hidden = false;
  el2.className = `history-variance ${isAhead ? 'history-variance--ahead' : isBehind ? 'history-variance--behind' : 'history-variance--on-track'}`;
  el2.innerHTML = isAhead
    ? `<span class="hv-icon">↓</span> <strong>${absDiff} ${unit} ahead</strong> of projected pace — great progress`
    : isBehind
    ? `<span class="hv-icon">↑</span> <strong>${absDiff} ${unit} behind</strong> projected pace`
    : `<span class="hv-icon">✓</span> <strong>On track</strong> — right on projected pace`;
}

/* ═══════════════════════════════════════════════════════════
   TIRZEPATIDE TRACKER — hidden section on the History tab,
   opened by the needle icon, closed by its own ✕.

   Level estimate uses a two-phase absorption + elimination curve
   (the standard Bateman-function shape for a subcutaneous dose),
   not just a decay from an instant peak: each dose rises to its own
   peak at 48h post-injection (tirzepatide's published average Tmax)
   then decays with a 5-day terminal half-life, and doses superpose
   linearly (same principle as the insulin-on-board curve elsewhere
   in this app). ka is solved once, offline, so the peak of a single
   isolated dose lands exactly at 48h — see the comment above
   TZ_KA_PER_HOUR. Still an approximation (real absorption varies by
   injection site/individual), but far closer to reality than a flat
   instant-peak model, and matches the shape of the reference chart
   this was built from.
═══════════════════════════════════════════════════════════ */
const TZ_KE_PER_HOUR = Math.log(2) / 120; // 5-day (120h) terminal half-life
// Solved numerically so that Tmax = ln(ka/ke)/(ka-ke) = 48h exactly,
// given TZ_KE_PER_HOUR above — see scratchpad for the bisection search.
const TZ_KA_PER_HOUR = 0.05125785820006391;
const TZ_PEAK_HOURS = 48;
function tzDoseShape(hoursSince) {
  if (hoursSince < 0) return 0;
  return Math.exp(-TZ_KE_PER_HOUR * hoursSince) - Math.exp(-TZ_KA_PER_HOUR * hoursSince);
}
const TZ_SHAPE_AT_PEAK = tzDoseShape(TZ_PEAK_HOURS); // normalizer: dose peaks at exactly doseMg

let tzDosesCache = null;
let tzChartGeom = null;   // last draw's coordinate mapping, for click→time conversion
let tzInspectMs = null;   // day the user last tapped on the chart, or null

function tzLevelAt(doses, atMs) {
  let total = 0;
  for (const d of doses) {
    const hoursSince = (atMs - d.injectedMs) / 3600000;
    if (hoursSince < 0) continue;
    total += d.doseMg * (tzDoseShape(hoursSince) / TZ_SHAPE_AT_PEAK);
  }
  return total;
}

// This pen's concentration puts 5mg at 40 units on the syringe — 8
// units per mg, not the 1:1 it was previously set to.
const TZ_UNITS_PER_MG = 8;
function tzUnitsForDose(doseMg) { return Math.round(doseMg * TZ_UNITS_PER_MG * 10) / 10; }

// "If the current routine is adhered to" — Tirzepatide is dosed weekly,
// so the routine is simply the most recent real dose repeated every 7
// days out to windowEnd. This replaces the old draggable "preview a
// hypothetical next dose" feature with a fixed, deterministic
// projection nobody has to configure by hand.
const TZ_WEEK_MS = 7 * 24 * 3600000;
function tzRoutineDoses(sortedRealDoses, windowEnd) {
  if (!sortedRealDoses.length) return [];
  const last = sortedRealDoses[sortedRealDoses.length - 1];
  const routine = [];
  for (let t = last.injectedMs + TZ_WEEK_MS; t <= windowEnd; t += TZ_WEEK_MS) {
    routine.push({ doseMg: last.doseMg, injectedMs: t });
  }
  return routine;
}

// datetime-local inputs want a zone-less "wall clock" string — build one
// from the local time rather than toISOString (which is always UTC and
// would silently shift the displayed time by the user's UTC offset).
function toLocalDatetimeInputValue(date) {
  const tzOffsetMs = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffsetMs).toISOString().slice(0, 16);
}

const TZ_SITE_LABELS = {
  left_thigh: 'Left thigh', right_thigh: 'Right thigh',
  left_stomach: 'Left stomach', right_stomach: 'Right stomach',
  centre_stomach: 'Centre stomach',
};
// Fixed rotation order — defaulting the log form to "whatever comes
// after the last site" nudges rotation without forcing it (still a
// plain dropdown, freely overridable before saving).
const TZ_SITE_ORDER = ['left_thigh', 'right_thigh', 'left_stomach', 'right_stomach', 'centre_stomach'];
function tzNextSite(lastSite) {
  const idx = TZ_SITE_ORDER.indexOf(lastSite);
  return TZ_SITE_ORDER[(idx + 1) % TZ_SITE_ORDER.length];
}

async function fetchTirzepatideDoses() {
  if (!currentUser) return [];
  const { data, error } = await db.from('tirzepatide_doses')
    .select('id, dose_mg, injected_at, site')
    .eq('user_id', currentUser.id)
    .order('injected_at', { ascending: true })
    .limit(200);
  if (error) { console.error('fetchTirzepatideDoses error:', error.message); return []; }
  return (data || []).map(d => ({ id: d.id, doseMg: Number(d.dose_mg), injectedMs: new Date(d.injected_at).getTime(), site: d.site || null }));
}

async function fetchTirzepatidePens() {
  if (!currentUser) return [];
  const { data, error } = await db.from('tirzepatide_pens')
    .select('id, received_at, volume_mg, viable_days')
    .eq('user_id', currentUser.id)
    .order('received_at', { ascending: true });
  if (error) { console.error('fetchTirzepatidePens error:', error.message); return []; }
  return (data || []).map(p => ({
    id: p.id,
    receivedMs: new Date(p.received_at + 'T00:00:00').getTime(),
    volumeMg: Number(p.volume_mg),
    viableDays: Number(p.viable_days),
  }));
}

// FIFO allocation: fills each pen (oldest received first) from real doses
// in chronological order, moving to the next pen once a dose no longer
// fits what's left. Mirrors how someone actually uses pens in sequence —
// finish (or discard) one before starting the next — rather than
// requiring the user to pick a pen every time they log an injection.
function tzAllocatePens(pens, doses) {
  const sortedPens  = [...pens].sort((a, b) => a.receivedMs - b.receivedMs);
  const sortedDoses = [...doses].sort((a, b) => a.injectedMs - b.injectedMs);
  let doseIdx = 0;

  return sortedPens.map((pen, penIdx) => {
    const nextPen = sortedPens[penIdx + 1];
    let remainingMg = pen.volumeMg;
    const usedDoses = [];
    while (doseIdx < sortedDoses.length) {
      const d = sortedDoses[doseIdx];
      if (d.injectedMs < pen.receivedMs) { doseIdx++; continue; } // logged before this pen existed
      if (nextPen && d.injectedMs >= nextPen.receivedMs) break;   // belongs to the next pen instead
      if (d.doseMg > remainingMg) break;                          // doesn't fit — rest goes to the next pen
      remainingMg -= d.doseMg;
      usedDoses.push(d);
      doseIdx++;
    }
    return { ...pen, remainingMg, usedDoses };
  });
}

function renderTzPenSection(pens, doses) {
  if (!el.tzPenStatus) return;

  if (!pens.length) {
    el.tzPenStatus.hidden = true;
    el.tzPenWarning.hidden = true;
    el.tzPenHistory.innerHTML = '<p class="empty-state">No pens logged yet.</p>';
    return;
  }

  const allocated = tzAllocatePens(pens, doses);
  const activePen = allocated[allocated.length - 1];
  const lastDose = [...doses].sort((a, b) => b.injectedMs - a.injectedMs)[0];
  const currentDoseMg = lastDose?.doseMg ?? null;

  const now = Date.now();
  const expiresMs = activePen.receivedMs + activePen.viableDays * 86400000;
  const expired = now > expiresMs;

  if (currentDoseMg) {
    const dosesLeft = Math.floor(activePen.remainingMg / currentDoseMg);
    const countCls = dosesLeft <= 0 ? 'empty' : dosesLeft <= 2 ? 'low' : 'ok';
    el.tzPenStatus.hidden = false;
    el.tzPenStatus.innerHTML = `
      <div>
        <div class="tz-pen-status__meta">Pen received ${new Date(activePen.receivedMs).toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${fmt1(activePen.volumeMg)}mg</div>
        <div class="tz-pen-status__date">${fmt1(activePen.remainingMg)}mg left of ${fmt1(activePen.volumeMg)}mg</div>
      </div>
      <div style="text-align:right">
        <div class="tz-pen-status__count tz-pen-status__count--${countCls}">${dosesLeft}</div>
        <div class="tz-pen-status__count-label">dose${dosesLeft === 1 ? '' : 's'} left</div>
      </div>`;
  } else {
    el.tzPenStatus.hidden = false;
    el.tzPenStatus.innerHTML = `<div class="tz-pen-status__meta">Pen received ${new Date(activePen.receivedMs).toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${fmt1(activePen.volumeMg)}mg. Log an injection to see doses remaining.</div>`;
  }

  // Warn ahead of time if the pen won't be finished before its viable
  // window closes at the current weekly cadence, and after the fact if
  // it's already past that window with peptide still left in it.
  const weeksUntilExpiry = (expiresMs - now) / (7 * 24 * 3600000);
  const dosesLeftAtExpiry = currentDoseMg ? Math.floor(activePen.remainingMg / currentDoseMg) : null;
  const expiryDateLabel = new Date(expiresMs).toLocaleDateString([], { month: 'short', day: 'numeric' });

  if (expired && activePen.remainingMg > 0) {
    el.tzPenWarning.hidden = false;
    el.tzPenWarning.innerHTML = `⚠️ This pen passed its ${activePen.viableDays}-day viable window on ${expiryDateLabel} — the peptide may have degraded. Consider replacing it rather than dosing from what's left.`;
  } else if (!expired && dosesLeftAtExpiry != null && dosesLeftAtExpiry > 0 && weeksUntilExpiry < dosesLeftAtExpiry) {
    el.tzPenWarning.hidden = false;
    el.tzPenWarning.innerHTML = `⚠️ At your current weekly dose, this pen will still have doses left when it hits its ${activePen.viableDays}-day window on ${expiryDateLabel} — worth ordering the next one now so you're not dosing from expired peptide.`;
  } else {
    el.tzPenWarning.hidden = true;
  }

  const sortedDesc = [...allocated].sort((a, b) => b.receivedMs - a.receivedMs);
  el.tzPenHistory.innerHTML = sortedDesc.map(p => `
    <div class="tz-dose-item" data-id="${p.id}">
      <div>
        <div class="tz-dose-item__meta">${fmt1(p.volumeMg)}mg pen · ${fmt1(p.remainingMg)}mg left</div>
        <div class="tz-dose-item__date">Received ${new Date(p.receivedMs).toLocaleDateString([], { dateStyle: 'medium' })} · viable ${p.viableDays}d</div>
      </div>
      <button type="button" class="btn btn--icon" data-action="tz-pen-delete" data-id="${p.id}" title="Delete">🗑</button>
    </div>
  `).join('');
}

async function loadTirzepatideSection() {
  const [doses, pens] = await Promise.all([fetchTirzepatideDoses(), fetchTirzepatidePens()]);
  tzDosesCache = doses;
  tzInspectMs = null; // clear any stale tap from before this reload
  renderTzSection(doses);
  renderTzPenSection(pens, doses);
}

// Updates the tap-to-inspect readout for whatever day is currently
// selected (tzInspectMs) — level is computed against real doses plus
// the routine projection, so it works whether the tapped day is in the
// past (real only) or future (real + repeating routine).
function updateTzInspectPanel() {
  if (!el.tzInspectPanel) return;
  if (tzInspectMs == null || !tzDosesCache?.length || !tzChartGeom) {
    el.tzInspectPanel.hidden = true;
    return;
  }
  const sorted = [...tzDosesCache].sort((a, b) => a.injectedMs - b.injectedMs);
  const routineDoses = tzRoutineDoses(sorted, tzChartGeom.windowEnd);
  const level = tzLevelAt([...sorted, ...routineDoses], tzInspectMs);
  const dateLabel = new Date(tzInspectMs).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  const tense = tzInspectMs > Date.now() ? 'projected' : 'estimated';
  el.tzInspectPanel.hidden = false;
  el.tzInspectPanel.innerHTML = `<span class="tz-inspect-panel__value">${fmt1(level)} mg</span><span class="tz-inspect-panel__label">${tense} level — ${dateLabel}</span>`;
}

function renderTzSection(doses) {
  if (!el.tzCard) return;

  if (!doses.length) {
    if (el.tzCurrentLevel) el.tzCurrentLevel.hidden = true;
    if (el.tzInspectPanel) el.tzInspectPanel.hidden = true;
    if (el.tzDoseList) el.tzDoseList.innerHTML = '<p class="empty-state">No injections logged yet.</p>';
    drawTzChart(el.tzChart, el.tzChartEmpty, []);
    return;
  }

  const now = Date.now();
  const currentLevel = tzLevelAt(doses, now);
  if (el.tzCurrentLevel) {
    el.tzCurrentLevel.hidden = false;
    el.tzCurrentLevel.innerHTML = `<span class="tz-current-level__value">${fmt1(currentLevel)} mg</span><span class="tz-current-level__label">estimated level now</span>`;
  }

  const sortedDesc = [...doses].sort((a, b) => b.injectedMs - a.injectedMs);
  if (el.tzDoseList) {
    el.tzDoseList.innerHTML = sortedDesc.map(d => `
      <div class="tz-dose-item" data-id="${d.id}">
        <div>
          <div class="tz-dose-item__meta">${fmt1(d.doseMg)} mg (${fmt1(tzUnitsForDose(d.doseMg))} units)${d.site ? ' · ' + TZ_SITE_LABELS[d.site] : ''}</div>
          <div class="tz-dose-item__date">${new Date(d.injectedMs).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</div>
        </div>
        <button type="button" class="btn btn--icon" data-action="tz-delete" data-id="${d.id}" title="Delete">🗑</button>
      </div>
    `).join('');
  }

  drawTzChart(el.tzChart, el.tzChartEmpty, doses);
  updateTzInspectPanel();
}

function drawTzChart(canvas, emptyEl, doses) {
  if (!canvas) return;
  if (!doses.length) {
    if (emptyEl) emptyEl.hidden = false;
    canvas.hidden = true;
    tzChartGeom = null;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  canvas.hidden = false;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const MAX_W = 800, MAX_H = 260, MIN_W = 100;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rawW = canvas.parentElement?.clientWidth || 320;
  const rawH = parseInt(canvas.getAttribute('height')) || 200;
  const W = Math.min(MAX_W, Math.max(MIN_W, rawW));
  const H = Math.min(MAX_H, Math.max(120, rawH));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const now = Date.now();
  const sorted = [...doses].sort((a, b) => a.injectedMs - b.injectedMs);
  const windowStart = sorted[0].injectedMs;
  // ~13 weeks out — enough runway to see several routine doses land and
  // the level settle toward steady state, without the chart getting
  // pointlessly wide.
  const FUTURE_MS = 90 * 24 * 3600 * 1000;
  const windowEnd = now + FUTURE_MS;

  const routineDoses = tzRoutineDoses(sorted, windowEnd);
  const projectionDoses = [...sorted, ...routineDoses];

  const STEP_MS = 3 * 3600 * 1000; // 3h resolution
  const pastPts = [];
  for (let t = windowStart; t <= now; t += STEP_MS) pastPts.push({ ms: t, v: tzLevelAt(sorted, t) });
  pastPts.push({ ms: now, v: tzLevelAt(sorted, now) });
  const futurePts = [];
  for (let t = now; t <= windowEnd; t += STEP_MS) futurePts.push({ ms: t, v: tzLevelAt(projectionDoses, t) });
  futurePts.push({ ms: windowEnd, v: tzLevelAt(projectionDoses, windowEnd) });

  const allVals = [...pastPts, ...futurePts].map(p => p.v);
  const vMax = Math.max(1, ...allVals) * 1.15;

  const padL = 30, padR = 8, padTop = 8, padBottom = 18;
  const plotW = W - padL - padR, plotH = H - padTop - padBottom;
  const xAt = ms => padL + ((ms - windowStart) / (windowEnd - windowStart)) * plotW;
  const yAt = v => padTop + plotH - (v / vMax) * plotH;

  // Stash geometry so pointer handlers can convert screen x back to time.
  tzChartGeom = { windowStart, windowEnd, padL, padR, plotW, padTop, plotH };

  // Y gridlines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  const step = vMax > 15 ? 5 : vMax > 6 ? 2 : 1;
  for (let v = 0; v <= vMax; v += step) {
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(String(v), padL - 4, y + 3);
  }

  // X axis date labels
  ctx.textAlign = 'center';
  const dayMs = 24 * 3600 * 1000;
  const totalDays = (windowEnd - windowStart) / dayMs;
  const tickEvery = totalDays > 60 ? 14 : totalDays > 21 ? 7 : 2;
  for (let t = windowStart; t <= windowEnd; t += tickEvery * dayMs) {
    ctx.fillText(new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' }), xAt(t), H - 4);
  }

  // "Now" marker
  const xNow = xAt(now);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(xNow, padTop); ctx.lineTo(xNow, padTop + plotH); ctx.stroke();
  ctx.setLineDash([]);

  // Past — solid
  ctx.strokeStyle = '#3B9EFF';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pastPts.forEach((p, i) => { const x = xAt(p.ms), y = yAt(p.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();

  // Future — dashed (includes the previewed dose, if any)
  ctx.strokeStyle = 'rgba(59, 158, 255, 0.65)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  futurePts.forEach((p, i) => { const x = xAt(p.ms), y = yAt(p.v); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  ctx.stroke();
  ctx.setLineDash([]);

  // Real dose markers — filled
  ctx.fillStyle = '#3B9EFF';
  sorted.forEach(d => {
    const x = xAt(d.injectedMs), y = yAt(tzLevelAt(sorted, d.injectedMs));
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
  });

  // Routine (not-yet-real) dose markers — hollow, so "if you keep dosing
  // weekly" doses read as distinct from actually-logged injections.
  ctx.strokeStyle = 'rgba(59, 158, 255, 0.65)';
  ctx.lineWidth = 1.5;
  routineDoses.forEach(d => {
    const x = xAt(d.injectedMs), y = yAt(tzLevelAt(projectionDoses, d.injectedMs));
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.stroke();
  });

  // Tap-to-inspect marker — wherever the user last tapped the chart,
  // static (no drag), just a readout of that day's level.
  if (tzInspectMs != null) {
    const ix = xAt(tzInspectMs);
    ctx.strokeStyle = 'rgba(245, 166, 35, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ix, padTop); ctx.lineTo(ix, padTop + plotH); ctx.stroke();
    ctx.setLineDash([]);

    const iy = yAt(tzLevelAt(projectionDoses, tzInspectMs));
    ctx.fillStyle = '#F5A623';
    ctx.beginPath(); ctx.arc(ix, iy, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#1a1d24'; ctx.lineWidth = 1.5; ctx.stroke();
  }
}

function tzXToMs(x) {
  if (!tzChartGeom) return null;
  const { windowStart, windowEnd, padL, plotW } = tzChartGeom;
  const frac = (x - padL) / plotW;
  return windowStart + frac * (windowEnd - windowStart);
}

el.btnTzToggle?.addEventListener('click', async () => {
  el.peptideSection.hidden = false;
  loadTirzepatideSection();
  await fetchPeptideProtocols();
  renderPeptideProtocols();
  await loadBpcHistorySection();
});

el.btnPeptideSectionClose?.addEventListener('click', () => {
  el.peptideSection.hidden = true;
});

el.btnOralMedsToggle?.addEventListener('click', async () => {
  el.oralMedsSection.hidden = false;
  await fetchOralMeds();
  renderOralMeds();
});

el.btnOralMedsSectionClose?.addEventListener('click', () => {
  el.oralMedsSection.hidden = true;
});

// Each accordion header shows/hides its own body only — independent of
// the other two, and independent of the outer section's own open/close.
document.querySelectorAll('.peptide-accordion__header').forEach(header => {
  header.addEventListener('click', () => {
    const body = $(header.dataset.target);
    if (!body) return;
    body.hidden = !body.hidden;
    const chevron = header.querySelector('.peptide-accordion__chevron');
    if (chevron) chevron.textContent = body.hidden ? '▸' : '▾';
  });
});

// Read-only — BPC-157 is discontinued, so this only ever displays
// existing bpc157_doses history, never logs a new one.
async function loadBpcHistorySection() {
  if (!currentUser || !el.bpcHistory) return;
  const { data: doses } = await db.from('bpc157_doses')
    .select('dose_mg, site, injected_at')
    .eq('user_id', currentUser.id)
    .order('injected_at', { ascending: false })
    .limit(30);

  el.bpcHistory.innerHTML = doses?.length
    ? doses.map(d => `
        <div class="peptide-history__row">
          <span class="peptide-history__date">${new Date(d.injected_at).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <span class="peptide-history__detail">${fmt1(Number(d.dose_mg))}mg${d.site ? ' · ' + peptideSiteLabel(d.site) : ''}</span>
        </div>`).join('')
    : '<p class="empty-state">No doses logged.</p>';
}

// Tap/click anywhere on the chart to inspect that day's level — works
// for touch (a tap fires a synthetic click) and mouse alike, no drag
// state to manage.
el.tzChart?.addEventListener('click', (e) => {
  if (!tzChartGeom || !tzDosesCache?.length) return;
  const rect = el.tzChart.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const ms = tzXToMs(x);
  if (ms == null) return;
  const { windowStart, windowEnd } = tzChartGeom;
  tzInspectMs = Math.min(windowEnd, Math.max(windowStart, ms));
  drawTzChart(el.tzChart, el.tzChartEmpty, tzDosesCache);
  updateTzInspectPanel();
});

el.btnTzLog?.addEventListener('click', () => {
  el.tzLogButtonWrap.hidden = true;
  el.tzLogForm.hidden = false;
  el.tzInjectedAt.value = toLocalDatetimeInputValue(new Date());
  if (tzDosesCache?.length) {
    const last = [...tzDosesCache].sort((a, b) => b.injectedMs - a.injectedMs)[0];
    // Dose: default to the most recently used, if any — titration
    // usually continues at the same dose until a deliberate step-up.
    const opt = [...el.tzDoseMg.options].find(o => Number(o.value) === last.doseMg);
    if (opt) el.tzDoseMg.value = opt.value;
    // Site: default to the next one in rotation, not a repeat of last time.
    if (el.tzSite) el.tzSite.value = tzNextSite(last.site);
  } else if (el.tzSite) {
    el.tzSite.value = TZ_SITE_ORDER[0];
  }
});

el.btnTzCancel?.addEventListener('click', () => {
  el.tzLogForm.hidden = true;
  el.tzLogButtonWrap.hidden = false;
  el.tzFormStatus.textContent = '';
});

el.btnTzSave?.addEventListener('click', async () => {
  if (!currentUser) return;
  const doseMg = parseFloat(el.tzDoseMg.value);
  const injectedAtLocal = el.tzInjectedAt.value;
  if (!injectedAtLocal) { el.tzFormStatus.textContent = 'Pick a date and time.'; return; }
  const injectedAtIso = new Date(injectedAtLocal).toISOString();
  const site = el.tzSite?.value || null;

  setBtn(el.btnTzSave, true, 'Save injection', 'Saving…');
  const { error } = await db.from('tirzepatide_doses').insert({
    user_id: currentUser.id, dose_mg: doseMg, injected_at: injectedAtIso, site,
  });
  setBtn(el.btnTzSave, false, 'Save injection');

  if (error) { el.tzFormStatus.textContent = 'Error: ' + error.message; return; }

  el.tzLogForm.hidden = true;
  el.tzLogButtonWrap.hidden = false;
  el.tzFormStatus.textContent = '';
  await loadTirzepatideSection();
});

el.tzDoseList?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="tz-delete"]');
  if (!btn || !currentUser) return;
  if (!confirm('Delete this injection entry?')) return;
  const { error } = await db.from('tirzepatide_doses').delete().eq('id', btn.dataset.id).eq('user_id', currentUser.id);
  if (error) { showToast('Failed: ' + error.message, true); return; }
  await loadTirzepatideSection();
});

el.btnTzPenAdd?.addEventListener('click', () => {
  el.tzPenAddButtonWrap.hidden = true;
  el.tzPenForm.hidden = false;
  el.tzPenReceivedAt.value = todayISO();
  el.tzPenVolumeMg.value = 40;
  el.tzPenViableDays.value = 28;
});

el.btnTzPenCancel?.addEventListener('click', () => {
  el.tzPenForm.hidden = true;
  el.tzPenAddButtonWrap.hidden = false;
  el.tzPenFormStatus.textContent = '';
});

el.btnTzPenSave?.addEventListener('click', async () => {
  if (!currentUser) return;
  const receivedAt = el.tzPenReceivedAt.value;
  const volumeMg = parseFloat(el.tzPenVolumeMg.value);
  const viableDays = parseInt(el.tzPenViableDays.value);
  if (!receivedAt) { el.tzPenFormStatus.textContent = 'Pick a date.'; return; }
  if (!Number.isFinite(volumeMg) || volumeMg <= 0) { el.tzPenFormStatus.textContent = 'Enter a valid pen volume.'; return; }
  if (!Number.isFinite(viableDays) || viableDays <= 0) { el.tzPenFormStatus.textContent = 'Enter a valid number of days.'; return; }

  setBtn(el.btnTzPenSave, true, 'Save pen', 'Saving…');
  const { error } = await db.from('tirzepatide_pens').insert({
    user_id: currentUser.id, received_at: receivedAt, volume_mg: volumeMg, viable_days: viableDays,
  });
  setBtn(el.btnTzPenSave, false, 'Save pen');

  if (error) { el.tzPenFormStatus.textContent = 'Error: ' + error.message; return; }

  el.tzPenForm.hidden = true;
  el.tzPenAddButtonWrap.hidden = false;
  el.tzPenFormStatus.textContent = '';
  await loadTirzepatideSection();
});

el.tzPenHistory?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="tz-pen-delete"]');
  if (!btn || !currentUser) return;
  if (!confirm('Delete this pen entry?')) return;
  const { error } = await db.from('tirzepatide_pens').delete().eq('id', btn.dataset.id).eq('user_id', currentUser.id);
  if (error) { showToast('Failed: ' + error.message, true); return; }
  await loadTirzepatideSection();
});

el.btnExportCsv.addEventListener('click', async () => {
  const unit = BODY_WEIGHT_UNIT;
  const { data } = await db
    .from('daily_logs')
    .select('log_date, weight, steps, cal_breakfast, cal_lunch, cal_dinner, cal_snacks, cal_total, notes')
    .eq('user_id', currentUser.id)
    .order('log_date', { ascending: true });

  const rows = [['date', `weight_${unit}`, 'steps', 'cal_breakfast', 'cal_lunch', 'cal_dinner', 'cal_snacks', 'cal_total', 'water_L', 'notes']];
  (data || []).forEach(r => rows.push([r.log_date, r.weight != null ? fmt1(weightFromKg(r.weight, unit)) : '', r.steps??'', r.cal_breakfast??'', r.cal_lunch??'', r.cal_dinner??'', r.cal_snacks??'', r.cal_total??'', r.notes??'']));
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `fitl00p-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ═══════════════════════════════════════════════════════════
   CHART (canvas, no deps) — supports projection line overlay
═══════════════════════════════════════════════════════════ */
function drawChart(canvas, emptyEl, series, plan) {
  if (!canvas) return;
  // ── Hard size limits — canvas can NEVER expand beyond these ──
  const MAX_W = 800;
  const MAX_H = 300;
  const MIN_W = 100;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr  = Math.min(window.devicePixelRatio || 1, 3); // cap DPR at 3
  const rawW = canvas.parentElement?.clientWidth || 320;
  const rawH = parseInt(canvas.getAttribute('height')) || 160;

  // Clamp to safe limits — no unbounded expansion possible
  const W = Math.min(MAX_W, Math.max(MIN_W, rawW));
  const H = Math.min(MAX_H, Math.max(80,  rawH));

  // Set CSS size first, then pixel size
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width  = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (!series || series.length < 2) {
    emptyEl.style.display = 'flex';
    return;
  }
  emptyEl.style.display = 'none';

  // ── Validate and parse weights ────────────────────────────
  const weights = series.map(p => Number(p.weight)).filter(w => isFinite(w) && w > 0);
  if (weights.length < 2) { emptyEl.style.display = 'flex'; return; }

  // ── Parse dates — accept log_date or date field ───────────
  const dataDates = series
    .map(p => new Date((p.log_date || p.date || '') + 'T00:00:00'))
    .filter(d => d instanceof Date && !isNaN(d.getTime()));

  if (dataDates.length < 2) { emptyEl.style.display = 'flex'; return; }

  const dataStart = dataDates[0];
  const dataEnd   = dataDates[dataDates.length - 1];

  // Guard: end must be after start
  if (dataEnd <= dataStart) { emptyEl.style.display = 'flex'; return; }

  // ── Date range including plan if available ────────────────
  let planStart = null, planEnd = null;
  if (plan?.start_date && plan?.target_date) {
    const ps = new Date(plan.start_date  + 'T00:00:00');
    const pe = new Date(plan.target_date + 'T00:00:00');
    if (!isNaN(ps.getTime()) && !isNaN(pe.getTime()) && pe > ps) {
      planStart = ps;
      planEnd   = pe;
    }
  }

  const rangeStart = planStart && planStart < dataStart ? planStart : dataStart;
  const rangeEnd   = planEnd   && planEnd   > dataEnd   ? planEnd   : dataEnd;
  const rangeMs    = Math.max(1, rangeEnd - rangeStart);

  // Small cards (the dashboard's weight-plan mini chart, height=80) drop
  // the raw daily dots/fill/ahead-behind ribbon that make sense at full
  // History-chart size but just read as noise this small — see below.
  const compact = H <= 100;

  // ── 7-day trailing-average trend, and where it's actually headed ──
  // The card's own "weekly pace" text is the pace STILL NEEDED to reach
  // the target by the deadline — by definition that always lands exactly
  // on goal, so it can't show whether today's real trajectory is on
  // track. This is the OBSERVED pace instead: the trend's slope over
  // its own recent history, projected forward from today to the plan's
  // target date — i.e. "at the rate you're actually going, here's where
  // you'll really be."
  const smoothed = dataDates.map((d) => {
    const windowStart = new Date(d.getTime() - 6 * 86400000);
    const vals = series
      .filter((p, j) => dataDates[j] >= windowStart && dataDates[j] <= d)
      .map(p => Number(p.weight))
      .filter(w => isFinite(w) && w > 0);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  let projectedPoint = null; // { weight, onTrack }
  const lastSmoothedIdx = smoothed.length - 1;
  const lastSmoothed = smoothed[lastSmoothedIdx];
  if (lastSmoothed != null && planEnd) {
    // Anchor on the earliest smoothed sample within the last 14 days —
    // recent enough to reflect current behaviour, but requiring at
    // least 5 days of spread so one or two entries can't fake a slope.
    let anchorIdx = -1;
    for (let i = 0; i <= lastSmoothedIdx; i++) {
      if (smoothed[i] == null) continue;
      if ((dataDates[lastSmoothedIdx] - dataDates[i]) / 86400000 > 14) continue;
      anchorIdx = i;
      break;
    }
    if (anchorIdx !== -1) {
      const gapDays = (dataDates[lastSmoothedIdx] - dataDates[anchorIdx]) / 86400000;
      if (gapDays >= 5) {
        const dailyRate = (lastSmoothed - smoothed[anchorIdx]) / gapDays;
        const daysToEnd = Math.max(0, (planEnd - dataDates[lastSmoothedIdx]) / 86400000);
        const projectedWeight = lastSmoothed + dailyRate * daysToEnd;
        const losing = Number(plan?.target_weight) < Number(plan?.start_weight);
        const onTrack = losing ? projectedWeight <= Number(plan.target_weight)
                                : projectedWeight >= Number(plan.target_weight);
        projectedPoint = { weight: projectedWeight, onTrack };
      }
    }
  }

  // ── Y axis — clamp to sane weight range (10–500 kg) ──────
  let lo = Math.min(...weights);
  let hi = Math.max(...weights);
  if (planStart) {
    lo = Math.min(lo, plan.target_weight || lo, plan.start_weight || lo);
    hi = Math.max(hi, plan.target_weight || hi, plan.start_weight || hi);
  }
  if (projectedPoint) {
    lo = Math.min(lo, projectedPoint.weight);
    hi = Math.max(hi, projectedPoint.weight);
  }
  // Safety: prevent zero-range or absurd ranges
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) { lo = 50; hi = 150; }
  const pad = Math.max(1, (hi - lo) * 0.18);
  lo = Math.max(0, lo - pad);
  hi = hi + pad;

  const px     = 12;
  const innerW = W - px * 2;
  const innerH = H - 22;
  const top    = 6;

  const xDate = d  => px + ((d - rangeStart) / rangeMs) * innerW;
  const yAt   = w  => top + innerH - ((w - lo) / (hi - lo)) * innerH;

  // ── Projected trajectory (straight line start → target) ──
  // Full-size chart only (History page) — the compact dashboard card
  // shows the observed-pace projection instead, drawn further below.
  if (!compact && plan && plan.start_weight && plan.target_weight && planStart && planEnd) {
    const xS = xDate(planStart);
    const xE = xDate(planEnd);
    const yS = yAt(plan.start_weight);
    const yE = yAt(plan.target_weight);

    // Shade zone between actual and projection — only within plan date range
    ctx.save();
    series.forEach((p, i) => {
      const d = dataDates[i];
      // Only shade between plan start and today
      if (d < planStart || d > new Date()) return;

      const pctT  = Math.min(1, Math.max(0, (d - planStart) / (planEnd - planStart)));
      const projW = plan.start_weight + (plan.target_weight - plan.start_weight) * pctT;
      const actW  = Number(p.weight);
      const x     = xDate(d);
      const yProj = yAt(projW);
      const yAct  = yAt(actW);

      if (i > 0) {
        const prevD = dataDates[i-1];
        if (prevD < planStart) return;
        const prevPctT  = Math.min(1, Math.max(0, (prevD - planStart) / (planEnd - planStart)));
        const prevProjW = plan.start_weight + (plan.target_weight - plan.start_weight) * prevPctT;
        const prevActW  = Number(series[i-1].weight);
        const prevX     = xDate(prevD);
        const prevYProj = yAt(prevProjW);
        const prevYAct  = yAt(prevActW);
        const isAhead   = actW < projW; // weight loss: less = better

        ctx.beginPath();
        ctx.moveTo(prevX, prevYProj);
        ctx.lineTo(x,     yProj);
        ctx.lineTo(x,     yAct);
        ctx.lineTo(prevX, prevYAct);
        ctx.closePath();
        ctx.fillStyle = isAhead
          ? 'rgba(22,163,74,.15)'   // green — ahead
          : 'rgba(220,38,38,.12)';  // red — behind
        ctx.fill();
      }
    });
    ctx.restore();

    // Projection dashed line
    ctx.save();
    ctx.strokeStyle = 'rgba(100,100,120,.5)';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(xS, yS);
    ctx.lineTo(xE, yE);
    ctx.stroke();
    ctx.setLineDash([]);

    // Target label
    ctx.fillStyle = 'rgba(100,100,120,.8)';
    ctx.font = `10px -apple-system,sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign    = 'right';
    ctx.fillText(`target ${fmt1(plan.target_weight)}`, W - px - 2, yE);
    ctx.restore();
  }

  // ── Actual weight line ────────────────────────────────────
  // Full-size chart only — at compact size the raw daily dots and area
  // fill are just texture; the trend line below carries the signal.
  if (!compact) {
    // Fill under curve
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(xDate(dataDates[0]), innerH + top + pad);
    series.forEach((p, i) => ctx.lineTo(xDate(dataDates[i]), yAt(Number(p.weight))));
    ctx.lineTo(xDate(dataDates[dataDates.length-1]), innerH + top + pad);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, innerH + top);
    grad.addColorStop(0,   'rgba(59,127,245,.2)');
    grad.addColorStop(1,   'rgba(59,127,245,0)');
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.strokeStyle = '#3B7FF5';
    ctx.lineWidth   = 2;
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    series.forEach((p, i) => {
      const x = xDate(dataDates[i]);
      const y = yAt(Number(p.weight));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Dots
    ctx.fillStyle = '#3B7FF5';
    series.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(xDate(dataDates[i]), yAt(Number(p.weight)), 2.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  // ── Target line — compact mode only ────────────────────────
  // A flat reference at the goal weight, labelled on the left where it
  // can't collide with the projected-outcome dot/label on the right.
  if (compact && plan?.target_weight) {
    const yTarget = yAt(Number(plan.target_weight));
    ctx.save();
    ctx.strokeStyle = 'rgba(140,140,160,.45)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, yTarget);
    ctx.lineTo(W - px, yTarget);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle    = 'rgba(150,150,170,.9)';
    ctx.font         = `9.5px -apple-system,sans-serif`;
    ctx.textBaseline = yTarget < top + 10 ? 'top' : 'bottom';
    ctx.textAlign    = 'left';
    ctx.fillText(`target ${fmt1(plan.target_weight)}`, px, yTarget - 2);
    ctx.restore();
  }

  // ── 7-day trailing-average trend line ─────────────────────
  // Smooths daily water/glycogen noise so the underlying direction reads
  // clearly at a glance. Full-size: drawn on top of the raw daily dots
  // above. Compact: this IS the primary line, since the raw dots/fill
  // are skipped.
  let trendLastPt = null;
  if (series.length >= 3) {
    const trendColor = compact
      ? '#3B7FF5'
      : (getComputedStyle(document.documentElement).getPropertyValue('--green').trim() || '#16A34A');

    ctx.save();
    ctx.strokeStyle = trendColor;
    ctx.lineWidth   = compact ? 2 : 2.5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    let started = false;
    smoothed.forEach((w, i) => {
      if (w == null) return;
      const x = xDate(dataDates[i]);
      const y = yAt(w);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      trendLastPt = { x, y };
    });
    ctx.stroke();

    if (!compact && trendLastPt && H >= 120) {
      ctx.fillStyle    = trendColor;
      ctx.font         = `10px -apple-system,sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign    = 'left';
      ctx.fillText('trend', Math.min(trendLastPt.x + 4, W - px - 32), trendLastPt.y - 2);
    }
    ctx.restore();
  }

  // ── Projected outcome — compact mode only ──────────────────
  // Dashed continuation of the trend line from today to the plan's
  // target date, at the pace the trend is ACTUALLY moving (not the pace
  // still needed) — colour says at a glance whether that lands on goal.
  if (compact && projectedPoint && trendLastPt && planEnd) {
    const xEnd = xDate(planEnd);
    const yEnd = yAt(projectedPoint.weight);
    const color = projectedPoint.onTrack ? '#16A34A' : '#D97706';

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(trendLastPt.x, trendLastPt.y);
    ctx.lineTo(xEnd, yEnd);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xEnd, yEnd, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.font         = `10px -apple-system,sans-serif`;
    ctx.textBaseline = yEnd < top + 10 ? 'top' : 'bottom';
    ctx.textAlign    = 'right';
    ctx.fillText(fmt1(projectedPoint.weight), Math.min(xEnd, W - px), yEnd - 2);
    ctx.restore();
  }

  // ── Today marker ──────────────────────────────────────────
  const todayD = new Date(todayISO() + 'T00:00:00');
  if (todayD >= rangeStart && todayD <= rangeEnd) {
    const tx = xDate(todayD);
    ctx.save();
    ctx.strokeStyle = 'rgba(200,150,0,.4)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(tx, top); ctx.lineTo(tx, innerH + top); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Axis date labels ─────────────────────────────────────
  // Describe the actual chart range boundaries, not just the last data
  // point — rangeStart/rangeEnd already correctly account for a plan's
  // start/target dates extending the visible axis beyond the real data.
  // Uses the original ISO date strings directly (not a Date round-trip
  // through toISOString(), which converts to UTC and could shift the
  // date by a day depending on the local timezone).
  const rangeStartIso = (planStart && planStart < dataStart) ? plan.start_date  : (series[0].date || series[0].log_date);
  const rangeEndIso   = (planEnd   && planEnd   > dataEnd)   ? plan.target_date : (series[series.length - 1].date || series[series.length - 1].log_date);
  ctx.fillStyle    = 'rgba(120,120,140,.8)';
  ctx.font         = `10px -apple-system,sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign    = 'left';
  ctx.fillText(fmtAxis(rangeStartIso), px, H - 14);
  ctx.textAlign = 'right';
  ctx.fillText(fmtAxis(rangeEndIso), W - px, H - 14);
}

window.addEventListener('resize', () => {
  // reflow charts if visible
  if (!el.viewDashboard.hidden) loadDashboard();
  if (!el.viewHistory.hidden)   loadHistory();
});

/* ═══════════════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════════════ */
async function loadSettings() {
  // Show admin IAM button only for admins
  const adminSec = $('adminSection');
  if (adminSec) adminSec.hidden = profile?.role !== 'admin';

  // "Forget Face ID login" — only shown when there's actually something
  // stored to forget.
  const btnForgetBiometric = $('btnForgetBiometric');
  if (btnForgetBiometric) {
    if (window.Capacitor?.isNativePlatform?.()) {
      try {
        const saved = await getBiometricPlugin().isCredentialsSaved({ server: BIOMETRIC_SERVER });
        btnForgetBiometric.hidden = !saved.isSaved;
      } catch {
        btnForgetBiometric.hidden = true;
      }
    } else {
      btnForgetBiometric.hidden = true;
    }
  }

  // Sync theme picker
  const currentTheme = localStorage.getItem(THEME_KEY) || 'nebula';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.theme === currentTheme);
  });

  if (!profile) return;

  // Manual weight logging toggle — just the switch lives here; the
  // actual logging UI is the ⚖️ button/card on the History tab (see
  // loadHistory()), so someone using this doesn't have to leave
  // wherever they're checking their weight history to go log a new
  // one. The checkbox itself saves immediately, same as "Keep screen
  // awake" — it's a single on/off switch, not part of the bigger
  // "Save settings" form.
  const manualWeightToggle = $('setManualWeightLogging');
  if (manualWeightToggle) manualWeightToggle.checked = !!profile.manual_weight_logging;

  // Native HealthKit sync — only relevant inside the Capacitor iOS app
  // (the plugin throws on web), so the whole section stays hidden on the
  // PWA rather than showing a toggle that can never work there.
  const healthKitSection = $('healthKitSyncSection');
  if (healthKitSection && window.Capacitor?.isNativePlatform?.()) {
    healthKitSection.hidden = false;
    const hkToggle = $('setHealthKitSyncEnabled');
    if (hkToggle) hkToggle.checked = !!profile.healthkit_sync_enabled;
  }

  loadNotificationSettings();

  // Diabetes tracking (Nightscout) config — stored on the profile row,
  // same as every other per-user setting, so it survives across devices.
  // Defaults to enabled (profile.diabetes_enabled is a NOT NULL column
  // defaulting true) so nobody currently using it loses access silently.
  const diabetesToggle = $('setDiabetesEnabled');
  const diabetesControls = $('diabetesTrackingControls');
  if (diabetesToggle) {
    diabetesToggle.checked = profile.diabetes_enabled !== false;
    if (diabetesControls) diabetesControls.hidden = !diabetesToggle.checked;
    diabetesToggle.addEventListener('change', () => {
      if (diabetesControls) diabetesControls.hidden = !diabetesToggle.checked;
    });
  }
  if ($('setNsUrl'))    $('setNsUrl').value    = profile.diabetes_ns_url    || '';
  if ($('setNsToken'))  $('setNsToken').value  = profile.diabetes_ns_token  || '';
  if ($('setNsSecret')) $('setNsSecret').value = profile.diabetes_ns_secret || '';
  if ($('setTargetLow'))       $('setTargetLow').value       = profile.diabetes_target_low  ?? '';
  if ($('setTargetHigh'))      $('setTargetHigh').value      = profile.diabetes_target_high ?? '';
  if ($('setIdealTarget'))     $('setIdealTarget').value     = profile.diabetes_ideal_target ?? '';
  if ($('setCarbRatio'))       $('setCarbRatio').value       = profile.diabetes_carb_ratio   ?? '';
  if ($('setCorrectionFactor')) $('setCorrectionFactor').value = profile.diabetes_correction_factor ?? '';
  if ($('setInsulinPeak'))     $('setInsulinPeak').value     = profile.diabetes_insulin_peak_min     ?? '';
  if ($('setInsulinDuration')) $('setInsulinDuration').value = profile.diabetes_insulin_duration_min ?? '';

  el.setDisplayName.value  = profile.display_name || '';
  el.setTdee.value         = profile.tdee         || 2200;
  el.setStepsGoal.value    = profile.steps_goal   || 10000;
  el.setEatTargetManual.value = profile.eat_target_manual_kcal ?? '';

  // Body stats
  if ($('setHeight')) $('setHeight').value = profile.height_cm  || '';
  if ($('setAge'))    $('setAge').value    = profile.age_years  || '';
  if ($('setSex'))    $('setSex').value    = profile.sex        || 'male';

  // Training profile
  const setGoal     = $('setGoal');
  const setDuration = $('setDuration');
  const setPreferFB = $('setPreferFullBody');
  if (setGoal)     setGoal.value      = profile.goal             || 'tone';
  if (setDuration) setDuration.value  = profile.session_duration || 45;
  if (setPreferFB) setPreferFB.checked= !!profile.prefer_full_body;

  // Equipment checkboxes
  const equipment = profile.equipment || [];
  document.querySelectorAll('#setEquipment input[type="checkbox"]').forEach(cb => {
    cb.checked = equipment.includes(cb.value);
  });

  // Injury checkboxes
  const injuries = profile.injuries || [];
  document.querySelectorAll('#setInjuries input[type="checkbox"]').forEach(cb => {
    cb.checked = injuries.includes(cb.value);
  });

  // Rest timers
  const setRestWL = $('setRestWeightLoss');
  const setRestT  = $('setRestTone');
  const setRestS  = $('setRestStrength');
  if (setRestWL) setRestWL.value = profile.rest_weight_loss || 30;
  if (setRestT)  setRestT.value  = profile.rest_tone        || 60;
  if (setRestS)  setRestS.value  = profile.rest_strength    || 120;

  if (activePlan) {
    // activePlan.start_weight/target_weight are canonical kg — shown in
    // lb (BODY_WEIGHT_UNIT) for editing.
    el.setPlanStart.value      = fmt1(weightFromKg(activePlan.start_weight, BODY_WEIGHT_UNIT));
    el.setPlanTarget.value     = fmt1(weightFromKg(activePlan.target_weight, BODY_WEIGHT_UNIT));
    el.setPlanStartDate.value  = activePlan.start_date;
    el.setPlanTargetDate.value = activePlan.target_date;
  }
}

el.btnSaveSettings.addEventListener('click', async () => {
  setBtn(el.btnSaveSettings, true, 'Save settings');

  const equipment = [...document.querySelectorAll('#setEquipment input:checked')].map(c => c.value);
  const injuries  = [...document.querySelectorAll('#setInjuries input:checked')].map(c => c.value);

  const profileUpdates = {
    display_name:     el.setDisplayName.value.trim() || null,
    tdee:             parseInt(el.setTdee.value)      || 2200,
    steps_goal:       parseInt(el.setStepsGoal.value) || 10000,
    eat_target_manual_kcal: el.setEatTargetManual.value.trim() ? parseInt(el.setEatTargetManual.value) : null,
    goal:             $('setGoal')?.value              || 'tone',
    session_duration: parseInt($('setDuration')?.value) || 45,
    prefer_full_body: !!$('setPreferFullBody')?.checked,
    equipment:        equipment.length ? equipment : null,
    injuries:         injuries.length  ? injuries  : null,
    rest_weight_loss: parseInt($('setRestWeightLoss')?.value) || 30,
    rest_tone:        parseInt($('setRestTone')?.value)        || 60,
    rest_strength:    parseInt($('setRestStrength')?.value)    || 120,
    height_cm:        parseFloat($('setHeight')?.value)        || null,
    age_years:        parseInt($('setAge')?.value)             || null,
    sex:              $('setSex')?.value                       || 'male',
  };

  const { error: pe } = await db
    .from('profiles')
    .update(profileUpdates)
    .eq('id', currentUser.id);

  if (pe) {
    flash(el.settingsStatus, 'Error: ' + pe.message, true);
    setBtn(el.btnSaveSettings, false, 'Save settings');
    return;
  }

  Object.assign(profile, profileUpdates);

  // Weight plan — only save if all four fields are filled
  const pStart  = parseFloat(el.setPlanStart.value);
  const pTarget = parseFloat(el.setPlanTarget.value);
  const pSDate  = el.setPlanStartDate.value;
  const pTDate  = el.setPlanTargetDate.value;

  if (pStart && pTarget && pSDate && pTDate) {
    // pStart/pTarget were typed in lb (BODY_WEIGHT_UNIT) — converted to
    // canonical kg before storing, same convention as daily_logs.weight.
    await db.from('weight_plans')
      .update({ is_active: false })
      .eq('user_id', currentUser.id)
      .eq('is_active', true);

    const { data: newPlan, error: ple } = await db.from('weight_plans')
      .insert({
        user_id:       currentUser.id,
        start_weight:  weightToKg(pStart, BODY_WEIGHT_UNIT),
        target_weight: weightToKg(pTarget, BODY_WEIGHT_UNIT),
        start_date:    pSDate,
        target_date:   pTDate,
        unit:          'kg',
        is_active:     true,
      })
      .select().single();

    if (!ple) activePlan = newPlan;
  }

  setBtn(el.btnSaveSettings, false, 'Save settings');
  flash(el.settingsStatus, 'Settings saved.');
});

el.btnChangePassword.addEventListener('click', async () => {
  const { error } = await db.auth.resetPasswordForEmail(currentUser.email, { redirectTo: window.location.origin });
  el.changePasswordMsg.textContent = error ? 'Error: ' + error.message : 'Password reset email sent — check your inbox.';
});

/* ═══════════════════════════════════════════════════════════
   DIABETES — Nightscout-backed engine tab
   Connection + target settings live on the profile row, same as every
   other per-user setting — survives across devices/browsers instead of
   being tied to one localStorage bucket. The Nightscout site itself
   stays the pull-through source for glucose/bolus/basal; nothing about
   its actual data is duplicated into Supabase, only how to reach it.
═══════════════════════════════════════════════════════════ */
async function saveNsProfileFields(updates) {
  if (!currentUser) return { error: new Error('Not signed in') };
  const { error } = await db.from('profiles').update(updates).eq('id', currentUser.id);
  if (!error) Object.assign(profile, updates);
  return { error };
}

/* ═══════════════════════════════════════════════════════════
   NOTIFICATIONS SETTINGS
   Two independent tables, both per-user with RLS scoping to
   auth.uid() = user_id: `notification_prefs` (simple on/off, some
   with a configurable time-of-day/day-of-week) for the ~8 reminders
   that already existed as fixed schedules server-side, and
   `metric_alert_rules` (one row per metric+direction) for the
   generic "any tracked metric, either direction, my own target/%/
   time/wording" alert builder. The matching notify-* Edge Functions
   read these same tables; see supabase/functions/notify-metric-check
   for the generic engine and the other notify-* functions for how
   each reads notification_prefs before deciding whether/when to fire.
   ═══════════════════════════════════════════════════════════ */
const NOTIFICATION_DEFS = [
  { key: 'daily_summary',    label: 'Daily readiness summary',   hint: 'Recovery/sleep/strain, once each morning.', hasSchedule: true, defaultHour: 7 },
  { key: 'sleep_target',     label: 'Sleep target',              hint: "Tonight's sleep need + suggested bedtime, each evening.", hasSchedule: true, defaultHour: 20 },
  { key: 'weighin',          label: 'Weigh-in reminder',         hint: "Nudges you to log a weight if you haven't yet.", hasSchedule: true, defaultHour: 10, hasDays: true, defaultDays: [2] },
  { key: 'oral_meds',        label: 'Oral meds reminder',        hint: 'Any active pill not logged yet today.', hasSchedule: true, defaultHour: 21 },
  { key: 'ai_coach',         label: 'AI morning briefing',       hint: 'A short cross-domain briefing each morning.', hasSchedule: true, defaultHour: 8 },
  { key: 'tirzepatide',      label: 'Tirzepatide reminder',      hint: 'Due ~7 days after your last logged dose.', hasSchedule: false, isRelevant: () => currentUser?.id !== GEMMA_USER_ID },
  { key: 'peptide',          label: 'Peptide protocol reminder', hint: "Follows your active protocol's own schedule.", hasSchedule: false, isRelevant: () => currentUser?.id !== GEMMA_USER_ID },
  { key: 'glucose_forecast', label: 'Glucose forecast alerts',   hint: 'Predictive hypo/hyper warnings — an always-on safety check, deliberately no schedule to set.', hasSchedule: false, isRelevant: (p) => p?.diabetes_enabled !== false && currentUser?.id !== GEMMA_USER_ID },
];

// Deliberately excludes glucose/insulin (already covered by the more
// sophisticated, safety-critical glucose_forecast alerts above) and
// anything peptide/tirzepatide/weigh-in/oral-med related (those are
// "did you log this" reminders, not metric-vs-target checks).
const METRIC_DEFS = [
  { key: 'steps',              label: 'Steps',             unit: '',     defaultTarget: 12000, defaultPct: 25 },
  { key: 'calories_consumed',  label: 'Calories eaten',    unit: 'kcal', defaultTarget: null,  defaultPct: 10 },
  { key: 'active_energy_kcal', label: 'Active energy',     unit: 'kcal', defaultTarget: 500,   defaultPct: 25 },
  { key: 'exercise_mins',      label: 'Exercise minutes',  unit: 'min',  defaultTarget: 30,    defaultPct: 50 },
  { key: 'sleep_total_hrs',    label: 'Sleep',             unit: 'h',    defaultTarget: 8,     defaultPct: 15 },
  { key: 'hrv_ms',              label: 'HRV',              unit: 'ms',   defaultTarget: null,  defaultPct: 20 },
  { key: 'resting_hr',         label: 'Resting heart rate',unit: 'bpm',  defaultTarget: null,  defaultPct: 15 },
  { key: 'weight_kg',          label: 'Weight',            unit: 'kg',   defaultTarget: null,  defaultPct: 5  },
  { key: 'recovery_score',     label: 'Recovery score',    unit: '/100', defaultTarget: 60,    defaultPct: 25 },
  { key: 'sleep_score',        label: 'Sleep score',       unit: '/100', defaultTarget: 60,    defaultPct: 25 },
  { key: 'strain_score',       label: 'Strain score',      unit: '/21',  defaultTarget: 10,    defaultPct: 30 },
];
// Direct health_daily columns with a same-day "Today: X" readout in
// Settings — the three score metrics above don't get one here (they'd
// need the exact dashboard scoring call, which is out of scope for a
// preview line); check the Dashboard tab for those instead.
const METRIC_TODAY_FIELD = {
  steps: 'steps', active_energy_kcal: 'active_energy_kcal', exercise_mins: 'exercise_mins',
  sleep_total_hrs: 'sleep_total_hrs', hrv_ms: 'hrv_ms', resting_hr: 'resting_hr', weight_kg: 'weight_kg',
};

const WEEKDAY_CHIP_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sun..Sat, matches days_of_week's 0=Sun convention

function hmFromMinutes(hour, minute) {
  return `${String(hour ?? 0).padStart(2, '0')}:${String(minute ?? 0).padStart(2, '0')}`;
}
function minutesFromHm(value, fallbackHour) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value || '');
  if (!m) return { hour: fallbackHour, minute: 0 };
  return { hour: Math.max(0, Math.min(23, parseInt(m[1], 10))), minute: Math.max(0, Math.min(59, parseInt(m[2], 10))) };
}

async function saveNotificationPref(key, updates) {
  if (!currentUser) return { error: new Error('Not signed in') };
  const { error } = await db.from('notification_prefs')
    .upsert({ user_id: currentUser.id, notif_key: key, ...updates }, { onConflict: 'user_id,notif_key' });
  return { error };
}

async function loadNotificationSettings() {
  const simpleList = $('notificationsSimpleList');
  const metricList = $('metricAlertRulesList');
  if (!simpleList || !metricList || !currentUser) return;

  const [{ data: prefRows }, { data: ruleRows }, { data: todayHealthRows }, { data: foodRows }] = await Promise.all([
    db.from('notification_prefs').select('*').eq('user_id', currentUser.id),
    db.from('metric_alert_rules').select('*').eq('user_id', currentUser.id),
    db.from('health_daily').select('steps,active_energy_kcal,exercise_mins,sleep_total_hrs,hrv_ms,resting_hr,weight_kg')
      .eq('user_id', currentUser.id).eq('log_date', todayISO()).limit(1),
    db.from('food_log').select('calories_kcal').eq('user_id', currentUser.id).eq('log_date', todayISO()),
  ]);

  const prefsByKey = {};
  (prefRows || []).forEach(r => { prefsByKey[r.notif_key] = r; });
  const rulesByKey = {};
  (ruleRows || []).forEach(r => { rulesByKey[`${r.metric_key}:${r.direction}`] = r; });
  const todayHealth = (todayHealthRows || [])[0] || {};
  const todayCalories = (foodRows || []).reduce((s, r) => s + (Number(r.calories_kcal) || 0), 0);

  simpleList.innerHTML = NOTIFICATION_DEFS
    .filter(def => !def.isRelevant || def.isRelevant(profile))
    .map(def => {
      const p = prefsByKey[def.key];
      const enabled = p?.enabled !== false;
      const scheduleBit = def.hasSchedule
        ? `<input type="time" class="notif-time" data-key="${def.key}" value="${hmFromMinutes(p?.check_hour ?? def.defaultHour, p?.check_minute ?? 0)}" style="margin-left:10px;width:auto;display:inline-block">`
        : '';
      const days = p?.days_of_week ?? def.defaultDays ?? [];
      const daysBit = def.hasDays
        ? `<div class="notif-days" data-key="${def.key}" style="margin:6px 0 0 30px;display:flex;gap:4px">` +
          WEEKDAY_CHIP_LABELS.map((lbl, i) => {
            const on = days.includes(i);
            return `<button type="button" class="chip-day${on ? ' is-active' : ''}" data-day="${i}" style="width:26px;height:26px;border-radius:50%;border:1px solid var(--border);background:${on ? 'var(--blue)' : 'transparent'};color:${on ? '#111318' : 'inherit'};font-size:11px">${lbl}</button>`;
          }).join('') + `</div>`
        : '';
      return `<label class="checkbox-option checkbox-option--full" style="align-items:center">
        <input type="checkbox" class="notif-toggle" data-key="${def.key}" ${enabled ? 'checked' : ''}>
        <span>${def.label}${scheduleBit} <span class="field-hint">${def.hint}</span></span>
      </label>${daysBit}`;
    }).join('');

  simpleList.querySelectorAll('.notif-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      const { error } = await saveNotificationPref(cb.dataset.key, { enabled: cb.checked });
      if (error) { showToast("Couldn't save: " + error.message, true); cb.checked = !cb.checked; }
    });
  });
  simpleList.querySelectorAll('.notif-time').forEach(input => {
    input.addEventListener('change', async () => {
      const { hour, minute } = minutesFromHm(input.value, 8);
      const { error } = await saveNotificationPref(input.dataset.key, { check_hour: hour, check_minute: minute });
      if (error) showToast("Couldn't save: " + error.message, true);
    });
  });
  simpleList.querySelectorAll('.notif-days').forEach(wrap => {
    wrap.querySelectorAll('.chip-day').forEach(chip => {
      chip.addEventListener('click', async () => {
        chip.classList.toggle('is-active');
        const on = chip.classList.contains('is-active');
        chip.style.background = on ? 'var(--blue)' : 'transparent';
        chip.style.color = on ? '#111318' : 'inherit';
        const activeDays = Array.from(wrap.querySelectorAll('.chip-day.is-active')).map(c => parseInt(c.dataset.day, 10));
        const { error } = await saveNotificationPref(wrap.dataset.key, { days_of_week: activeDays });
        if (error) showToast("Couldn't save: " + error.message, true);
      });
    });
  });

  metricList.innerHTML = METRIC_DEFS.map(def => {
    const under = rulesByKey[`${def.key}:under`];
    const over  = rulesByKey[`${def.key}:over`];
    const todayLine = def.key === 'calories_consumed'
      ? `Today: ${todayCalories.toFixed(0)}${def.unit}`
      : (METRIC_TODAY_FIELD[def.key] && todayHealth[METRIC_TODAY_FIELD[def.key]] != null
          ? `Today: ${Number(todayHealth[METRIC_TODAY_FIELD[def.key]]).toFixed(1)}${def.unit}`
          : 'See your Dashboard tab for today’s value.');

    const row = (direction, rule) => {
      const target = rule?.target_value ?? def.defaultTarget ?? '';
      const pct = rule?.threshold_pct ?? def.defaultPct ?? '';
      const hm = hmFromMinutes(rule?.check_hour ?? 19, rule?.check_minute ?? 0);
      const msg = rule?.message_template ?? '';
      const enabled = !!rule?.enabled;
      const placeholderMsg = `Your ${def.label.toLowerCase()} was {value}${def.unit} today — {pct}% ${direction} your {target}${def.unit} target.`;
      return `<div class="field-grid" data-metric="${def.key}" data-direction="${direction}" style="margin-top:8px;padding:10px;border:1px solid var(--border);border-radius:10px">
        <label class="checkbox-option checkbox-option--full" style="grid-column:1/-1">
          <input type="checkbox" class="rule-enabled" ${enabled ? 'checked' : ''}>
          <span>${direction === 'under' ? 'Under target' : 'Over target'}</span>
        </label>
        <div class="field"><label>Target</label><input type="number" class="rule-target" value="${target}" inputmode="decimal" step="any"></div>
        <div class="field"><label>% off to notify</label><input type="number" class="rule-pct" value="${pct}" inputmode="decimal" step="1" min="1" max="90"></div>
        <div class="field"><label>Time</label><input type="time" class="rule-time" value="${hm}"></div>
        <div class="field" style="grid-column:1/-1"><label>Message <span class="field-hint">placeholders: {value} {target} {pct} {unit}</span></label>
          <textarea class="rule-message" rows="2" placeholder="${placeholderMsg}">${msg}</textarea>
        </div>
      </div>`;
    };

    return `<div class="settings-section" style="margin-top:14px;padding-top:10px">
      <div class="settings-section__title" style="font-size:13px">${def.label} <span class="field-hint" style="text-transform:none">${todayLine}</span></div>
      ${row('under', under)}
      ${row('over', over)}
    </div>`;
  }).join('');
}

$('btnSaveMetricAlerts')?.addEventListener('click', async () => {
  const btn = $('btnSaveMetricAlerts');
  if (!currentUser) return;
  setBtn(btn, true, 'Save metric alerts', 'Saving…');
  const writes = Array.from(document.querySelectorAll('#metricAlertRulesList [data-metric]')).map(card => {
    const targetRaw = card.querySelector('.rule-target').value;
    const pctRaw = card.querySelector('.rule-pct').value;
    const { hour, minute } = minutesFromHm(card.querySelector('.rule-time').value, 19);
    const message = card.querySelector('.rule-message').value.trim();
    return {
      user_id: currentUser.id, metric_key: card.dataset.metric, direction: card.dataset.direction,
      enabled: card.querySelector('.rule-enabled').checked,
      target_value: targetRaw === '' ? null : parseFloat(targetRaw),
      threshold_pct: pctRaw === '' ? null : parseFloat(pctRaw),
      check_hour: hour, check_minute: minute,
      message_template: message || null,
    };
  });
  const { error } = await db.from('metric_alert_rules').upsert(writes, { onConflict: 'user_id,metric_key,direction' });
  setBtn(btn, false, 'Save metric alerts');
  if (error) { flash($('metricAlertsStatus'), 'Error: ' + error.message, true); return; }
  flash($('metricAlertsStatus'), 'Saved.');
});

// Fat/protein per meal aren't tracked anywhere upstream (Nightscout
// treatments don't carry them), so this is its own table — diabetes_meals,
// RLS-scoped to auth.uid() same as every other per-user table — that
// suggestMacroMealDose reads back to personalize the split-dose guide once
// there's enough history. Nightscout stays the source of truth for
// glucose/bolus/basal; only the macro-tagged meal entries live here.
// Feeds diabetes-engine.js's activities.workouts — every pattern check
// and live feature that reasons about "post-exercise" (sensitivityMap,
// patternExerciseSensitivity, hypoForecast2h's workout-drop adjustment,
// preWorkoutAdvisor) needs a real endTime, and ideally a real startTime,
// per session. workout_sessions.started_at (added alongside the diabetes
// build) is the true start for anything logged since; older rows never
// captured it, so they fall back to created_at for both ends — a same-
// instant window rather than a fabricated duration.
const MANUAL_ACTIVITY_LABELS = { swim: 'Swim', walk: 'Walk', run: 'Run', strength: 'Strength', other: 'Other' };

async function fetchDxWorkouts() {
  if (!currentUser) return [];
  const [sessionsRes, appleRes, manualRes] = await Promise.all([
    db.from('workout_sessions')
      .select('id, split_type, started_at, created_at')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(200),
    // Real Apple Watch-detected workouts, synced via Health Auto Export's
    // "Workouts" export type — carries genuine start/end times rather than
    // the started_at-at-best-effort/created_at fallback above, and covers
    // anyone whose actual training happens outside fitl00p's own routine
    // logger entirely (e.g. cardio, or a watch that auto-detects sessions).
    db.from('apple_health_workouts')
      .select('workout_type, started_at, ended_at')
      .eq('user_id', currentUser.id)
      .order('started_at', { ascending: false })
      .limit(200),
    // User's own manual log — covers activity that's neither a fitl00p
    // routine session nor watch-synced (e.g. no watch worn swimming).
    db.from('manual_activities')
      .select('activity_type, started_at, ended_at, unplugged')
      .eq('user_id', currentUser.id)
      .order('started_at', { ascending: false })
      .limit(200),
  ]);
  if (sessionsRes.error) console.error('fetchDxWorkouts (workout_sessions) error:', sessionsRes.error.message);
  if (appleRes.error) console.error('fetchDxWorkouts (apple_health_workouts) error:', appleRes.error.message);
  if (manualRes.error) console.error('fetchDxWorkouts (manual_activities) error:', manualRes.error.message);

  const fromSessions = (sessionsRes.data || []).map(w => ({
    startTime: w.started_at || w.created_at,
    endTime: w.created_at,
    workoutType: w.split_type || 'Other',
  }));
  const fromApple = (appleRes.data || []).map(w => ({
    startTime: w.started_at,
    endTime: w.ended_at,
    workoutType: w.workout_type,
  }));
  const fromManual = (manualRes.data || []).map(w => ({
    startTime: w.started_at,
    endTime: w.ended_at,
    workoutType: MANUAL_ACTIVITY_LABELS[w.activity_type] || w.activity_type,
    unplugged: !!w.unplugged,
  }));
  return [...fromSessions, ...fromApple, ...fromManual];
}

async function fetchMacroMealLog() {
  if (!currentUser) return [];
  const { data, error } = await db
    .from('diabetes_meals')
    .select('eaten_at, meal_name, carbs_g, fat_g, protein_g, suggested_units, matched_bolus_units, matched_bolus_time, match_status')
    .eq('user_id', currentUser.id)
    .order('eaten_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('fetchMacroMealLog error:', error.message);
    return [];
  }
  return (data || []).map(r => ({
    time: new Date(r.eaten_at).getTime(),
    mealName: r.meal_name || null,
    carbs: Number(r.carbs_g),
    fat: Number(r.fat_g),
    protein: Number(r.protein_g),
    // Without this, mergeMealCarbsIntoBoluses can never find the bolus
    // this meal was already matched to, and pushes a duplicate carbs-only
    // entry instead of correcting the real one in place — double-counting
    // carbs in every COB-driven calc downstream for any meal that already
    // has a linked bolus.
    matched_bolus_time: r.matched_bolus_time || null,
    // The confirmed real dose once linked to a Nightscout bolus, else
    // the suggestion it was recorded with — manual entries assume the
    // suggestion was followed (recordMacroMeal), MFP 'suggested' rows
    // with no link yet stay unrated until confirmed.
    actualDose: r.matched_bolus_units != null ? Number(r.matched_bolus_units)
      : (r.match_status == null && r.suggested_units != null ? Number(r.suggested_units) : null),
  }));
}

// Today's diabetes_meals entries (any source — Log Food's bridge insert,
// the Diabetes tab's own manual calculator, or a legacy MFP import) for
// the "link a dose" review card — separate from fetchMacroMealLog above
// because this needs the match/hypo bookkeeping columns, not the
// engine-shaped {time, carbs, fat, protein} rows suggestMacroMealDose
// reads.
async function fetchTodaysDxMeals() {
  if (!currentUser) return [];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await db
    .from('diabetes_meals')
    .select('id, eaten_at, meal_name, carbs_g, fat_g, protein_g, match_status, hypo_treatment, matched_bolus_time, matched_bolus_units, suggested_units, upfront_units, delayed_units')
    .eq('user_id', currentUser.id)
    .gte('eaten_at', startOfDay.toISOString())
    .order('eaten_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('fetchTodaysDxMeals error:', error.message);
    return [];
  }
  return data || [];
}

// Today's meals for the meal-dose helper's "Today's meals" picker —
// carries each meal's current aggregate macros too, so selecting one
// repopulates Carbs/Fat/Protein instead of just filling in the name.
// Same rows suggestMacroMealDose matches on to personalize, so "what
// actually worked last time" for the macros lines up with what the dose
// suggestion is itself drawing on.
//
// Scoped to today only (not all-time history) — picking a meal from a
// different day here would tie a dose calculated NOW onto that old row
// via recordMacroMeal's existingMealId, silently rewriting its dose
// fields instead of the meal actually being calculated for right now.
//
// No per-name dedup needed (unlike before this fed from one row per
// logged item): upsertDiabetesMealSection already keeps at most one row
// per section per day, so each row here already IS a distinct meal —
// Breakfast, Lunch, etc. — not an individual ingredient.
async function fetchMealPresets() {
  if (!currentUser) return [];
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const { data, error } = await db
    .from('diabetes_meals')
    .select('id, meal_name, carbs_g, fat_g, protein_g, eaten_at')
    .eq('user_id', currentUser.id)
    .not('meal_name', 'is', null)
    .gte('eaten_at', startOfDay.toISOString())
    .order('eaten_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('fetchMealPresets error:', error.message);
    return [];
  }
  return (data || [])
    .map(r => (r.meal_name || '').trim() && {
      id: r.id,
      name: r.meal_name.trim(),
      carbs: Number(r.carbs_g) || 0,
      fat: Number(r.fat_g) || 0,
      protein: Number(r.protein_g) || 0,
    })
    .filter(Boolean);
}

// existingMealId ties the dose onto the SAME diabetes_meals row the
// "Previous meals" picker pulled it from — e.g. logging a meal by photo,
// then separately using the calculator to work out units for that exact
// meal — instead of inserting a second row with the same carbs, which
// used to double the carb count the diabetes engine sees for COB/
// forecast (a real one: 28g logged via photo, then 28g again from the
// calculator 65 minutes later, both counted). Only ever an UPDATE — the
// row's own eaten_at/carbs stay exactly as originally logged; only the
// dose fields are filled in.
async function recordMacroMeal(entry, doseResult, existingMealId) {
  if (!currentUser) return;
  const dosePayload = {
    suggested_units: doseResult?.suggestedUnits ?? null,
    upfront_units: doseResult?.upfrontUnits ?? null,
    delayed_units: doseResult?.delayedUnits ?? null,
    delay_minutes: doseResult?.guide?.delayMinutes ?? null,
    dose_source: doseResult?.source ?? null,
  };
  if (existingMealId) {
    const { error } = await db.from('diabetes_meals').update(dosePayload).eq('id', existingMealId);
    if (error) console.error('recordMacroMeal (update) error:', error.message);
    return;
  }
  const { error } = await db.from('diabetes_meals').insert({
    user_id: currentUser.id,
    eaten_at: new Date(entry.time).toISOString(),
    meal_name: entry.mealName || null,
    carbs_g: entry.carbs,
    fat_g: entry.fat,
    protein_g: entry.protein,
    ...dosePayload,
  });
  if (error) console.error('recordMacroMeal (insert) error:', error.message);
}

// Keeps diabetes_meals in sync with a Log Food section's items — at
// most one diabetes_meals row per (day, section) rather than one per
// item, so the dose calculator's "Today's meals" picker offers whole
// meals to dose for, not individual ingredients (see LF_SECTIONS).
// Called after any food_log insert/delete that touches a
// diabetes-tracked section, for the specific section that changed —
// re-sums that section's current items from scratch rather than
// incrementing, so it's correct regardless of what changed or in what
// order.
//
// Safety: if the existing row's dose was already linked to a REAL bolus
// (match_status set, or matched_bolus_units present), that link is never
// touched or deleted, even if every item in the section is later removed
// — it's a record of insulin actually given. Macros/name still update so
// the row reflects what's really been eaten. If the dose was only ever
// an unconfirmed suggestion, it's cleared on any macro change instead of
// being left showing a number that no longer matches the new total.
// Returns { error: string|null } — callers that need to tell the user
// about a failure (rather than just console.error, which is how this
// went unnoticed for the plain per-item bridge insert before) can surface
// the message; internal callers that don't care can ignore the return.
async function upsertDiabetesMealSection(logDate, mealSlot, isHypo) {
  if (!currentUser || profile?.diabetes_enabled === false) return { error: null };

  // logDate is a UTC calendar day (matches food_log.log_date/todayISO(),
  // both toISOString()-derived) — the explicit 'Z' keeps this window on
  // the same UTC day rather than local midnight, which would drift by
  // the local UTC offset and could miss/misclassify rows near midnight.
  const startOfDay = new Date(logDate + 'T00:00:00Z');
  const endOfDay = new Date(startOfDay.getTime() + 86400000);

  let itemsQuery = db.from('food_log')
    .select('food_name, calories_kcal, carbs_g, fat_g, protein_g, logged_at')
    .eq('user_id', currentUser.id)
    .eq('log_date', logDate);
  itemsQuery = isHypo
    ? itemsQuery.eq('hypo_treatment', true)
    : itemsQuery.eq('meal_slot', mealSlot).eq('hypo_treatment', false);
  const { data: items, error: itemsErr } = await itemsQuery.order('logged_at', { ascending: true });
  if (itemsErr) { console.error('upsertDiabetesMealSection items fetch error:', itemsErr.message); return { error: itemsErr.message }; }

  let existingQuery = db.from('diabetes_meals')
    .select('id, match_status, matched_bolus_units')
    .eq('user_id', currentUser.id)
    .gte('eaten_at', startOfDay.toISOString())
    .lt('eaten_at', endOfDay.toISOString());
  existingQuery = isHypo
    ? existingQuery.eq('hypo_treatment', true)
    : existingQuery.eq('meal_slot', mealSlot).eq('hypo_treatment', false);
  const { data: existingRows, error: existingErr } = await existingQuery.limit(1);
  if (existingErr) { console.error('upsertDiabetesMealSection lookup error:', existingErr.message); return { error: existingErr.message }; }
  const existing = existingRows?.[0] || null;

  const totals = (items || []).reduce((t, r) => ({
    carbs: t.carbs + (Number(r.carbs_g) || 0),
    fat: t.fat + (Number(r.fat_g) || 0),
    protein: t.protein + (Number(r.protein_g) || 0),
  }), { carbs: 0, fat: 0, protein: 0 });
  const hasMacros = totals.carbs > 0 || totals.fat > 0 || totals.protein > 0;
  const hasRealBolus = existing && (existing.matched_bolus_units != null ||
    ['manual', 'auto', 'hypo-manual', 'hypo-auto', 'below-target'].includes(existing.match_status));

  if (!hasMacros) {
    // Nothing left worth dosing for in this section (last item deleted,
    // or everything in it is macro-free) — remove its row so it stops
    // showing up as a pickable "meal", unless a real injection is
    // already linked to it (never silently delete that record).
    if (existing && !hasRealBolus) {
      const { error: delErr } = await db.from('diabetes_meals').delete().eq('id', existing.id);
      if (delErr) { console.error('upsertDiabetesMealSection cleanup delete error:', delErr.message); return { error: delErr.message }; }
    }
    return { error: null };
  }

  const sectionLabel = LF_SECTIONS.find(s => s.key === (isHypo ? 'hypo' : mealSlot))?.label || mealSlot;
  const mealName = `${sectionLabel} — ${items.map(r => r.food_name).join(', ')}`.slice(0, 300);
  // Earliest item in the section — roughly "when this meal started" and
  // stable against later additions, rather than drifting forward every
  // time one more item gets added (which would keep sliding it out of
  // range of whatever real bolus it should end up matched against).
  const eatenAt = new Date(items[0].logged_at).toISOString();

  const payload = {
    meal_name: mealName,
    eaten_at: eatenAt,
    carbs_g: Math.round(totals.carbs * 10) / 10,
    fat_g: Math.round(totals.fat * 10) / 10,
    protein_g: Math.round(totals.protein * 10) / 10,
  };

  if (existing) {
    if (!hasRealBolus) {
      payload.suggested_units = null;
      payload.upfront_units = null;
      payload.delayed_units = null;
      payload.delay_minutes = null;
      payload.dose_source = null;
    }
    const { error: updErr } = await db.from('diabetes_meals').update(payload).eq('id', existing.id);
    if (updErr) console.error('upsertDiabetesMealSection update error:', updErr.message);
    return { error: updErr?.message || null };
  }
  const { error: insErr } = await db.from('diabetes_meals').insert({
    user_id: currentUser.id,
    meal_slot: isHypo ? null : mealSlot,
    hypo_treatment: isHypo,
    match_status: isHypo ? 'hypo-manual' : null,
    source: 'manual',
    ...payload,
  });
  if (insErr) console.error('upsertDiabetesMealSection insert error:', insErr.message);
  return { error: insErr?.message || null };
}

// Snacks are dosed individually rather than aggregated like breakfast/
// lunch/dinner — a 10am snack and a 3pm snack aren't one "meal" the way
// a section's ingredients eaten together are, so each keeps its own
// diabetes_meals row. Linked via food_log_id (the same 1:1 link the
// pre-redesign per-item bridge used, still present in the schema).
//
// `item` is the food_log row's dosing-relevant fields — {food_name,
// carbs_g, fat_g, protein_g, logged_at} — passed explicitly rather than
// re-fetched by this function, because by the time some callers reach
// this point the food_log row may already reflect a DIFFERENT section
// than the one being synced (e.g. edited from Snacks to Breakfast — the
// row now says "breakfast", but this call is specifically cleaning up
// the now-stale Snacks dose for it). Pass null for `item` to force that
// cleanup — same as "the item's food_log row no longer belongs here."
// Same real-bolus protection as upsertDiabetesMealSection: a row already
// linked to a real injection is never touched or deleted.
async function upsertDiabetesMealItem(foodLogId, item) {
  if (!currentUser || profile?.diabetes_enabled === false) return { error: null };

  const { data: existingRows, error: existingErr } = await db.from('diabetes_meals')
    .select('id, match_status, matched_bolus_units')
    .eq('user_id', currentUser.id)
    .eq('food_log_id', foodLogId)
    .limit(1);
  if (existingErr) { console.error('upsertDiabetesMealItem lookup error:', existingErr.message); return { error: existingErr.message }; }
  const existing = existingRows?.[0] || null;
  const hasRealBolus = existing && (existing.matched_bolus_units != null ||
    ['manual', 'auto', 'hypo-manual', 'hypo-auto', 'below-target'].includes(existing.match_status));

  const carbs = item ? Number(item.carbs_g) || 0 : 0;
  const fat = item ? Number(item.fat_g) || 0 : 0;
  const protein = item ? Number(item.protein_g) || 0 : 0;
  const hasMacros = !!item && (carbs > 0 || fat > 0 || protein > 0);

  if (!hasMacros) {
    if (existing && !hasRealBolus) {
      const { error: delErr } = await db.from('diabetes_meals').delete().eq('id', existing.id);
      if (delErr) { console.error('upsertDiabetesMealItem cleanup delete error:', delErr.message); return { error: delErr.message }; }
    }
    return { error: null };
  }

  const payload = {
    meal_name: (item.food_name || 'Snack').slice(0, 300),
    eaten_at: new Date(item.logged_at).toISOString(),
    carbs_g: Math.round(carbs * 10) / 10,
    fat_g: Math.round(fat * 10) / 10,
    protein_g: Math.round(protein * 10) / 10,
  };

  if (existing) {
    if (!hasRealBolus) {
      payload.suggested_units = null;
      payload.upfront_units = null;
      payload.delayed_units = null;
      payload.delay_minutes = null;
      payload.dose_source = null;
    }
    const { error: updErr } = await db.from('diabetes_meals').update(payload).eq('id', existing.id);
    if (updErr) console.error('upsertDiabetesMealItem update error:', updErr.message);
    return { error: updErr?.message || null };
  }
  const { error: insErr } = await db.from('diabetes_meals').insert({
    user_id: currentUser.id,
    meal_slot: 'snack',
    hypo_treatment: false,
    match_status: null,
    source: 'manual',
    food_log_id: foodLogId,
    ...payload,
  });
  if (insErr) console.error('upsertDiabetesMealItem insert error:', insErr.message);
  return { error: insErr?.message || null };
}

// Single entry point every Log Food call site routes a food_log change
// through — which sections get aggregated (upsertDiabetesMealSection)
// vs. dosed per-item (upsertDiabetesMealItem, Snacks only) lives here
// and nowhere else, so that policy never has to be duplicated at each
// call site. See upsertDiabetesMealItem's own comment for why `item`
// (the snack row's dosing fields, or null to force cleanup) is passed
// explicitly rather than re-fetched.
//
// One automatic retry on failure — seen in practice, a request can drop
// between its CORS preflight and the real call landing (a flaky mobile
// connection, the tab backgrounded for a moment) even though the food_log
// save immediately before it succeeded. The food_log row is already
// committed by the time this runs, so a dropped write here silently
// loses just the dosing link, not the log itself — worth one retry
// before actually surfacing the error/toast to the user.
async function bridgeLfMealChange(logDate, mealSlot, isHypo, foodLogId, item) {
  const attempt = () => (!isHypo && mealSlot === 'snack')
    ? upsertDiabetesMealItem(foodLogId, item)
    : upsertDiabetesMealSection(logDate, mealSlot, isHypo);
  const first = await attempt();
  if (!first.error) return first;
  await new Promise(r => setTimeout(r, 800));
  return attempt();
}

$('btnDxGoToSettings')?.addEventListener('click', () => navigateTo('settings'));

$('btnSaveNsConfig')?.addEventListener('click', async () => {
  const btn = $('btnSaveNsConfig');
  const url = $('setNsUrl').value.trim().replace(/\/+$/, '');
  if (url && !/^https:\/\//.test(url)) {
    flash($('nsConfigStatus'), 'URL must start with https://', true);
    return;
  }
  setBtn(btn, true, 'Connect', 'Saving…');
  const { error } = await saveNsProfileFields({
    diabetes_ns_url:    url || null,
    diabetes_ns_token:  $('setNsToken').value.trim() || null,
    diabetes_ns_secret: $('setNsSecret').value.trim() || null,
  });
  setBtn(btn, false, 'Connect');
  if (error) {
    flash($('nsConfigStatus'), 'Error: ' + error.message, true);
    return;
  }
  diabetesData = null; // force a re-fetch next time the tab is opened
  flash($('nsConfigStatus'), url ? 'Connected.' : 'Cleared.');
});

$('btnSaveDiabetesSettings')?.addEventListener('click', async () => {
  const btn = $('btnSaveDiabetesSettings');
  const num = (id, fallback) => {
    const v = parseFloat($(id).value);
    return Number.isFinite(v) ? v : fallback;
  };
  setBtn(btn, true, 'Save diabetes settings', 'Saving…');
  const { error } = await saveNsProfileFields({
    diabetes_enabled:               !!$('setDiabetesEnabled')?.checked,
    diabetes_target_low:            num('setTargetLow', 4.5),
    diabetes_target_high:           num('setTargetHigh', 8.5),
    diabetes_ideal_target:          Number.isFinite(parseFloat($('setIdealTarget').value)) ? parseFloat($('setIdealTarget').value) : null,
    diabetes_carb_ratio:            Number.isFinite(parseFloat($('setCarbRatio').value)) ? parseFloat($('setCarbRatio').value) : null,
    diabetes_correction_factor:     Number.isFinite(parseFloat($('setCorrectionFactor').value)) ? parseFloat($('setCorrectionFactor').value) : null,
    diabetes_insulin_peak_min:      num('setInsulinPeak', 57),
    diabetes_insulin_duration_min:  num('setInsulinDuration', 240),
  });
  setBtn(btn, false, 'Save diabetes settings');
  if (error) {
    flash($('diabetesSettingsStatus'), 'Error: ' + error.message, true);
    return;
  }
  diabetesData = null;
  applyDiabetesTabVisibility();
  flash($('diabetesSettingsStatus'), 'Saved.');
});

/* ── Data fetch (via the diabetes-sync Netlify function) ──── */
let diabetesData = null;       // adapted {glucoseHistory, boluses, corrections, basalDoses}
let diabetesFetchedAt = null;
let dxWorkoutTypesPopulated = false; // first populate always defaults to most-recently-done type
let dxMealPresets = []; // populated by loadDiabetes(); looked up by name when the "Previous meals" dropdown changes
let dxSelectedMealPresetId = null; // set when a preset is picked — ties the next dose calculation to that same diabetes_meals row instead of inserting a duplicate; cleared the moment any of the fields it populated is edited by hand
let dxLatestWeightKg = null; // populated by loadDiabetes(); feeds dxSettings()'s dose-per-kg/BMI calc

// Latest known weight in true kg, checked across both possible sources:
// health_daily.weight_kg (Apple Health sync, always metric) and
// daily_logs.weight (manual entry — canonical kg too, see the
// weightToKg/weightFromKg comment above). Whichever source has the more
// recent log_date wins.
async function fetchLatestWeightKg() {
  if (!currentUser) return null;
  const [{ data: healthRows }, { data: logRows }] = await Promise.all([
    db.from('health_daily').select('weight_kg, log_date').eq('user_id', currentUser.id)
      .not('weight_kg', 'is', null).order('log_date', { ascending: false }).limit(1),
    db.from('daily_logs').select('weight, log_date').eq('user_id', currentUser.id)
      .not('weight', 'is', null).order('log_date', { ascending: false }).limit(1),
  ]);
  const h = healthRows?.[0];
  const l = logRows?.[0];
  if (h && (!l || h.log_date >= l.log_date)) return Number(h.weight_kg) || null;
  if (l) return Number(l.weight) || null;
  return h ? Number(h.weight_kg) || null : null;
}
const DIABETES_CACHE_MS = 4 * 60000; // avoid re-hitting Nightscout on every tab switch

async function fetchDiabetesData(force = false) {
  if (!profile?.diabetes_ns_url) return null;

  if (!force && diabetesData && diabetesFetchedAt && (Date.now() - diabetesFetchedAt) < DIABETES_CACHE_MS) {
    return diabetesData;
  }

  const qs = new URLSearchParams({ url: profile.diabetes_ns_url, days: '14' });
  if (profile.diabetes_ns_token)  qs.set('token', profile.diabetes_ns_token);
  if (profile.diabetes_ns_secret) qs.set('secret', profile.diabetes_ns_secret);

  const res = await fetch(`${FUNCTIONS_ORIGIN}/diabetes-sync?${qs.toString()}`, { headers: FUNCTIONS_ANON_HEADERS });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Sync failed (${res.status})`);

  diabetesData = body;
  diabetesFetchedAt = Date.now();
  return body;
}

// Separately-cached wider-window fetch (diabetes-sync caps at 31 days
// server-side) — used only by the workout simulator/history so it can
// actually match a month of workouts against glucose+basal data, without
// slowing down or changing the 14-day window every other diabetes-tab
// feature (patterns, health check, meal-dose suggestions) is built around.
let diabetesDataWide = null;
let diabetesDataWideFetchedAt = null;
const DIABETES_WIDE_DAYS = 31;

async function fetchDiabetesDataWide(force = false) {
  if (!profile?.diabetes_ns_url) return null;

  if (!force && diabetesDataWide && diabetesDataWideFetchedAt && (Date.now() - diabetesDataWideFetchedAt) < DIABETES_CACHE_MS) {
    return diabetesDataWide;
  }

  const qs = new URLSearchParams({ url: profile.diabetes_ns_url, days: String(DIABETES_WIDE_DAYS) });
  if (profile.diabetes_ns_token)  qs.set('token', profile.diabetes_ns_token);
  if (profile.diabetes_ns_secret) qs.set('secret', profile.diabetes_ns_secret);

  const res = await fetch(`${FUNCTIONS_ORIGIN}/diabetes-sync?${qs.toString()}`, { headers: FUNCTIONS_ANON_HEADERS });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Sync failed (${res.status})`);

  diabetesDataWide = body;
  diabetesDataWideFetchedAt = Date.now();
  return body;
}

function dxSettings() {
  return {
    targetLow:              profile?.diabetes_target_low ?? 4.5,
    targetHigh:             profile?.diabetes_target_high ?? 8.5,
    idealTarget:            profile?.diabetes_ideal_target,
    carbRatio:              profile?.diabetes_carb_ratio,
    correctionFactor:       profile?.diabetes_correction_factor,
    insulinPeakMinutes:     profile?.diabetes_insulin_peak_min ?? 57,
    insulinDurationMinutes: profile?.diabetes_insulin_duration_min ?? 240,
    // Feeds insulinHealthCheck's dose-per-kg/BMI — see fetchLatestWeightKg
    // and loadDiabetes() for how/when dxLatestWeightKg gets populated.
    weightKg: dxLatestWeightKg,
    heightCm: profile?.height_cm ? Number(profile.height_cm) : null,
  };
}

/* ── View loader ─────────────────────────────────────────── */
async function loadDiabetes() {
  if (!profile?.diabetes_ns_url) {
    el.dxNotConnected.hidden = false;
    el.dxConnected.hidden = true;
    return;
  }
  el.dxNotConnected.hidden = true;
  el.dxConnected.hidden = false;

  // Awaited (unlike the meal-presets fetch below, a separate dropdown
  // that isn't render-blocking) — dxSettings() reads dxLatestWeightKg
  // synchronously, and the Weekly Insulin Health Check card has no
  // other trigger to re-render once a fire-and-forget fetch resolved
  // after the first paint.
  dxLatestWeightKg = await fetchLatestWeightKg();

  fetchMealPresets().then(presets => {
    dxMealPresets = presets;
    if (el.dxMealPreset) {
      el.dxMealPreset.innerHTML = '<option value="">— Select a meal logged today —</option>'
        + presets.map(p => {
            const bits = [`${p.carbs}g carbs`];
            if (p.fat) bits.push(`${p.fat}g fat`);
            if (p.protein) bits.push(`${p.protein}g protein`);
            return `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} (${bits.join(', ')})</option>`;
          }).join('');
    }
  });

  try {
    const data = await fetchDiabetesData();
    await renderDiabetesTab(data);
    startDxAutoRefresh();
  } catch (err) {
    console.error('Diabetes sync error:', err);
    el.dxCorrectionBody.innerHTML = `<p class="empty-state" style="color:var(--red)">Couldn't reach Nightscout: ${escapeHtml(err.message)}</p>`;
    [el.dxForecastBody, el.dxPatternsBody, el.dxHealthBody, el.dxSensitivityBody].forEach(n => { if (n) n.innerHTML = ''; });
  }
}

$('btnDxRefresh')?.addEventListener('click', async () => {
  const btn = $('btnDxRefresh');
  setBtn(btn, true, 'Refresh', 'Syncing…');
  try {
    const data = await fetchDiabetesData(true);
    renderDiabetesTab(data);
  } catch (err) {
    showToast("Couldn't sync: " + err.message, true);
  }
  setBtn(btn, false, 'Refresh');
});

/* ── Rendering ────────────────────────────────────────────── */
const DX_TREND_ARROWS = { steepUp: '⇈', up: '↑', flat: '→', down: '↓', steepDown: '⇊' };
function trendArrow(perMin) {
  if (perMin == null) return '';
  if (perMin >= 0.15) return DX_TREND_ARROWS.steepUp;
  if (perMin >= 0.03) return DX_TREND_ARROWS.up;
  if (perMin <= -0.15) return DX_TREND_ARROWS.steepDown;
  if (perMin <= -0.03) return DX_TREND_ARROWS.down;
  return DX_TREND_ARROWS.flat;
}

function dxAgeLabel(minutes) {
  if (minutes == null) return 'no reading';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  return `${(minutes / 60).toFixed(1)}h ago`;
}

const WITHHELD_MESSAGES = {
  'stale-reading':        'No recent glucose reading — check your sensor app.',
  'missing-data':         'Set a correction target (mmol/L) in Settings to get suggestions.',
  'insufficient-history':  n => `Learning your correction factor — need at least 3 clean corrections${n != null ? ` (have ${n})` : ''}.`,
  'low-confidence-factor': 'Your correction factor looks unreliable right now — cleaner corrections (no food nearby) will sharpen it.',
};

// Icon for a workout marker on the glucose chart — checked against the
// raw workoutType string so it covers all three sources fetchDxWorkouts()
// merges (fitl00p's own Push/Pull/Legs/Full Body split names, Apple
// Health's own vocabulary like "Walking"/"Traditional Strength Training",
// and the manual log's Swim/Walk/Run/Strength/Other) without needing each
// source to agree on exact naming. Disconnected always wins over the
// activity's own icon — "was the pump off here" is the more operationally
// relevant thing to see at a glance. Unrecognized types (golf, yoga, …)
// intentionally draw nothing rather than clutter the chart with a guess.
function dxActivityIcon(workoutType, unplugged) {
  if (unplugged) return '🔌';
  const t = String(workoutType || '').toLowerCase();
  if (t.includes('walk')) return '🚶';
  if (t.includes('swim')) return '🏊';
  if (t.includes('run')) return '🏃';
  if (['push', 'pull', 'legs', 'full body', 'strength', 'weight', 'lift', 'resistance'].some(k => t.includes(k))) return '🏋️';
  return null;
}

function dxActivityLabel(workoutType, unplugged) {
  if (unplugged) return 'Pump unplugged';
  const t = String(workoutType || '').toLowerCase();
  if (t.includes('walk')) return 'Walk';
  if (t.includes('swim')) return 'Swim';
  if (t.includes('run')) return 'Run';
  if (['push', 'pull', 'legs', 'full body', 'strength', 'weight', 'lift', 'resistance'].some(k => t.includes(k))) return 'Strength';
  return workoutType || 'Activity';
}

function dxFormatMarkerTime(ms) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = d.toDateString() === new Date().toDateString() ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
  return `${dayLabel} at ${time}`;
}

/* ── Scheduled-basal gap fill ──────────────────────────────────
   Control-IQ only logs a Temp Basal treatment when it actually overrides
   the profile's scheduled rate — a stretch where it just holds the
   default (or tconnectsync misses a poll) leaves a real hole in
   Nightscout's own data, not a fitl00p sync-lag artifact. These read the
   Nightscout profile's basal schedule (fetched server-side by
   diabetes-sync, see extractBasalSchedule) to fill those holes with the
   *scheduled* rate — drawn visually distinct from a confirmed dose, since
   it's an assumption, not a recorded fact. */
function dxMinuteOfDayInTz(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(ms));
  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return (hour % 24) * 60 + minute; // Intl's 'hour12:false' can format midnight as "24"
}

function dxScheduledBasalRate(ms, schedule) {
  if (!schedule?.segments?.length) return null;
  const minute = dxMinuteOfDayInTz(ms, schedule.timezone || 'UTC');
  if (minute == null) return null;
  let rate = schedule.segments[schedule.segments.length - 1].rate; // wraps from before midnight
  for (const s of schedule.segments) {
    if (s.startMin <= minute) rate = s.rate; else break;
  }
  return rate;
}

// Samples the schedule every 5 minutes across [fromMs, toMs] and merges
// consecutive equal-rate samples into rectangles — avoids needing exact
// timezone-aware day-boundary reconstruction (DST etc.) since each sample
// independently asks Intl for the correct local time.
function dxExpandScheduleGap(schedule, fromMs, toMs) {
  if (!schedule?.segments?.length || toMs <= fromMs) return [];
  const STEP = 5 * 60000;
  const out = [];
  let cur = null;
  for (let t = fromMs; t < toMs; t += STEP) {
    const rate = dxScheduledBasalRate(t, schedule);
    if (rate == null) continue;
    const segEnd = Math.min(t + STEP, toMs);
    if (cur && cur.rate === rate && cur.end === t) {
      cur.end = segEnd;
    } else {
      cur = { start: t, end: segEnd, rate };
      out.push(cur);
    }
  }
  return out;
}

/* ── Glucose/IOB/projection chart (canvas, no deps) ──────────
   Past ~6h of real glucose, active IOB along the bottom on its own
   scale, and a dashed near-term projection from the same model
   hypoForecast2h/projectedGlucoseCurve use — openly approximate, not
   a real predictive model, capped at 2h out for exactly that reason. */
let dxChartAnchorMs = null; // preserved left-edge scroll time across auto-redraws (ms); null = not yet set
let dxChartLastScale = null; // {msForScroll} from the most recent draw, used by the scroll listener
let dxChartScrollWired = false;

function drawDxGlucoseChart(canvas, emptyEl, data, settings, now, workouts, insulinGaps) {
  if (!canvas) return;
  const MAX_H = 260, MIN_VISIBLE_W = 100;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const scrollEl = canvas.closest('.dx-chart-scroll');
  const markersEl = el.dxChartMarkers;
  // Read now, before this draw's own rAF-scheduled scrollLeft write below
  // takes effect — reflects wherever the user actually has it scrolled
  // to. Repeating labels (Y-axis values, IOB, basal) anchor a single
  // instance here rather than tiling every yLabelStep from x=0: tiling
  // has no guarantee a full instance lands inside the current viewport,
  // so a long label like "Basal u/hr (some scheduled)" could show up as
  // two different half-cut fragments at each edge instead of one whole,
  // readable line.
  const visibleLeft = scrollEl ? scrollEl.scrollLeft : 0;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const visibleW = Math.max(MIN_VISIBLE_W, (scrollEl?.clientWidth || canvas.parentElement?.clientWidth || 320) - 16);
  const rawH = parseInt(canvas.getAttribute('height')) || 180;
  const H = Math.min(MAX_H, Math.max(120, rawH));

  // Default visible view is the last 2h + 30min projected — zoomed in
  // enough to actually see what's happening right now rather than a flat
  // 6h-wide line — but the canvas is still rendered wide enough to hold
  // a full 24h + 30min so the user can scroll back to see earlier
  // history without a new data fetch (14 days of Nightscout history is
  // already loaded client-side).
  const VISIBLE_PAST_MIN = 120, FUTURE_MIN = 30, MAX_PAST_MIN = 24 * 60;
  const VISIBLE_SPAN_MIN = VISIBLE_PAST_MIN + FUTURE_MIN;
  const TOTAL_SPAN_MIN = MAX_PAST_MIN + FUTURE_MIN;
  const W = Math.round(visibleW * (TOTAL_SPAN_MIN / VISIBLE_SPAN_MIN));

  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const windowStart = now - MAX_PAST_MIN * 60000;
  const windowEnd = now + FUTURE_MIN * 60000;

  const pastReadings = (data.glucoseHistory || [])
    .map(r => ({ ms: Number(r.time), value: Number(r.value) }))
    .filter(r => Number.isFinite(r.ms) && Number.isFinite(r.value) && r.ms >= windowStart && r.ms <= now)
    .sort((a, b) => a.ms - b.ms);

  if (pastReadings.length < 2) {
    if (emptyEl) emptyEl.hidden = false;
    canvas.hidden = true;
    if (markersEl) markersEl.innerHTML = '';
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  canvas.hidden = false;

  const input = { ...data, settings, activities: { workouts: [] } };
  // 5min steps over the shorter 30min horizon — 15min steps would only
  // give 2-3 points to draw a dashed line through.
  const projected = DiabetesEngine.projectedGlucoseCurve(input, now, FUTURE_MIN, 5);

  const curveOpts = DiabetesEngine.insulinCurveOpts(settings);
  const iobSeries = [];
  for (let t = windowStart; t <= now; t += 15 * 60000) {
    iobSeries.push({ ms: t, value: DiabetesEngine.activeInsulin(data.boluses, data.corrections, t, curveOpts) });
  }

  const basalSegments = (data.basalDoses || [])
    .map(d => {
      const time = Number(d.time);
      const durationMin = Number(d.durationMin) || 0;
      const rate = Number.isFinite(Number(d.rate)) ? Number(d.rate)
        : (durationMin > 0 ? (Number(d.units) || 0) / (durationMin / 60) : null);
      return { start: time, end: time + durationMin * 60000, rate };
    })
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && Number.isFinite(s.rate) && s.end > windowStart && s.start < now)
    .map(s => ({ start: Math.max(s.start, windowStart), end: Math.min(s.end, now), rate: s.rate }))
    .sort((a, b) => a.start - b.start);

  // Fill the stretches basalSegments doesn't cover with the Nightscout
  // profile's scheduled rate (see dxExpandScheduleGap) — Control-IQ only
  // logs an override, so a gap here is a real hole in Nightscout's data,
  // not evidence basal wasn't running.
  const basalScheduleFill = [];
  if (data.basalSchedule) {
    let cursor = windowStart;
    for (const s of basalSegments) {
      if (s.start > cursor) basalScheduleFill.push(...dxExpandScheduleGap(data.basalSchedule, cursor, s.start));
      cursor = Math.max(cursor, s.end);
    }
    if (cursor < now) basalScheduleFill.push(...dxExpandScheduleGap(data.basalSchedule, cursor, now));
  }

  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const allVals = [...pastReadings.map(r => r.value), ...projected.map(p => p.value), low, high];
  const gLo = Math.max(2, Math.min(...allVals) - 1);
  const gHi = Math.min(22, Math.max(...allVals) + 1);

  // padTop leaves room above the main plot for the bolus/correction dose
  // labels ("3.2u+30g"), which sit above their dashed vertical lines rather
  // than crowding the baseline.
  const padL = 26, padR = 8, padTop = 20, xAxisH = 14, iobStripH = 26, basalStripH = 26, stripGap = 9;
  const mainH = H - padTop - iobStripH - basalStripH - xAxisH - stripGap * 2 - 4;
  const iobTop = padTop + mainH + stripGap;
  const basalTop = iobTop + iobStripH + stripGap;

  const xAt = ms => padL + ((ms - windowStart) / (windowEnd - windowStart)) * (W - padL - padR);
  const yAt = v => padTop + mainH - ((v - gLo) / (gHi - gLo)) * mainH;

  // Target range band
  ctx.fillStyle = 'rgba(74, 222, 128, 0.10)';
  ctx.fillRect(padL, yAt(high), W - padL - padR, Math.max(0, yAt(low) - yAt(high)));

  // Activity/workout bands — a tinted strip across the activity's full
  // timeframe (not just a point marker), drawn behind the glucose line so
  // the curve stays legible on top of it. Icon + label + the DOM tap
  // target get added later, once the glucose curve is drawn, so the text
  // sits above the line rather than under it.
  const activityBands = [];
  (workouts || []).forEach(w => {
    const startMs = Number(new Date(w.startTime).getTime());
    const endMsRaw = Number(new Date(w.endTime ?? w.startTime).getTime());
    if (!Number.isFinite(startMs)) return;
    const endMs = Number.isFinite(endMsRaw) ? endMsRaw : startMs;
    if (endMs < windowStart || startMs > now) return;
    const icon = dxActivityIcon(w.workoutType, w.unplugged);
    if (!icon) return;
    const x0 = xAt(Math.max(startMs, windowStart));
    const x1 = Math.max(x0 + 4, xAt(Math.min(endMs, now)));
    activityBands.push({ x0, x1, icon, label: dxActivityLabel(w.workoutType, w.unplugged), startMs, endMs });
  });
  ctx.fillStyle = 'rgba(129, 140, 248, 0.14)';
  activityBands.forEach(b => ctx.fillRect(b.x0, padTop, b.x1 - b.x0, mainH));

  // Insulin gap bands — an unplanned "no insulin since X" stretch (site
  // failure, missed dose, pump issue), open-ended until resolved. Tinted
  // red rather than the activity bands' indigo so a resulting high reads
  // as "known cause, already explained" at a glance rather than looking
  // like an unexplained spike.
  const gapBands = [];
  (insulinGaps || []).forEach(g => {
    const startMs = Number(new Date(g.started_at).getTime());
    if (!Number.isFinite(startMs)) return;
    const endMs = g.ended_at ? Number(new Date(g.ended_at).getTime()) : now;
    if (endMs < windowStart || startMs > now) return;
    const x0 = xAt(Math.max(startMs, windowStart));
    const x1 = Math.max(x0 + 4, xAt(Math.min(endMs, now)));
    const label = DX_GAP_REASON_LABELS[g.reason] || g.reason;
    gapBands.push({ x0, x1, label, startMs, endMs, ongoing: !g.ended_at });
  });
  ctx.fillStyle = 'rgba(248, 113, 113, 0.16)';
  gapBands.forEach(b => ctx.fillRect(b.x0, padTop, b.x1 - b.x0, mainH));

  // Y gridlines span the full width so they're always visible; the value
  // labels anchor to whatever's currently scrolled into view (see
  // visibleLeft above) so they stay visible wherever the chart is
  // scrolled to (the default view sits near the right edge, far from a
  // label drawn only once at x=padL).
  const yTicks = [4, 8, 12, 16, 20].filter(v => v >= gLo && v <= gHi);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  yTicks.forEach(v => {
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
  });
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  const yLabelX = Math.max(padL, visibleLeft + 4);
  yTicks.forEach(v => ctx.fillText(String(v), yLabelX, yAt(v) + 3));

  // "Now" marker
  const xNow = xAt(now);
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.setLineDash([2, 3]);
  ctx.beginPath(); ctx.moveTo(xNow, padTop); ctx.lineTo(xNow, padTop + mainH); ctx.stroke();
  ctx.setLineDash([]);

  // Past glucose — line + dots
  ctx.strokeStyle = '#3B9EFF';
  ctx.lineWidth = 2;
  ctx.beginPath();
  pastReadings.forEach((r, i) => {
    const x = xAt(r.ms), y = yAt(r.value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#3B9EFF';
  pastReadings.forEach(r => {
    ctx.beginPath();
    ctx.arc(xAt(r.ms), yAt(r.value), 1.5, 0, Math.PI * 2);
    ctx.fill();
  });

  // Projected — dashed. Needs both a recent reading and a resolved
  // correction factor (observed or pump-setting) — if either is missing,
  // projectedGlucoseCurve withholds rather than guess, so say why here
  // instead of just silently drawing nothing.
  if (projected.length) {
    ctx.strokeStyle = 'rgba(59, 158, 255, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    projected.forEach((p, i) => {
      const x = xAt(p.ms), y = yAt(p.value);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.font = '8px -apple-system, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Set correction factor in Settings for a projection', W - padR, padTop + 9);
  }

  // Bolus / correction dose markers — a dashed vertical line through the
  // full plot height with the dose (and carbs, for meal boluses) labeled
  // above it, so the dose and the curve's reaction to it read together at
  // a glance. Each one also gets a matching entry in chartHits so a DOM
  // overlay button can be positioned on top of it (canvas pixels have no
  // click events of their own — see renderDxChartMarkerOverlay below).
  const chartHits = [];
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  (data.boluses || []).forEach(b => {
    const ms = Number(b.time), units = Number(b.units);
    const carbs = Number(b.carbs) || 0;
    if (!Number.isFinite(ms) || ms < windowStart || ms > now) return;
    const x = xAt(ms);
    const mealSuffix = b.mealName ? ` (${b.mealName})` : '';
    if (units > 0) {
      // A real insulin dose — carbs (if any) come from mergeMealCarbsIntoBoluses,
      // which prefers the fitl00p-logged meal's figure over Nightscout's own
      // (Control-IQ can suppress/alter it on a low-BG bolus), so this is
      // "what was actually eaten", not just what the pump recorded.
      ctx.strokeStyle = 'rgba(250, 204, 21, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, padTop + mainH); ctx.stroke();
      ctx.setLineDash([]);
      const label = carbs > 0 ? `${units.toFixed(1)}u+${Math.round(carbs)}g` : `${units.toFixed(1)}u`;
      ctx.fillStyle = '#facc15';
      ctx.fillText(label, x, 12);
      const body = carbs > 0
        ? `${units.toFixed(1)}u + ${Math.round(carbs)}g carbs${mealSuffix} · ${dxFormatMarkerTime(ms)}`
        : `${units.toFixed(1)}u · ${dxFormatMarkerTime(ms)}`;
      chartHits.push({ x, y: 12, title: 'Bolus', body });
    } else if (carbs > 0) {
      // A meal logged in fitl00p with no bolus lined up close enough in
      // time to match against — exactly the "ate but didn't (fully) dose
      // for it" gap this chart should make visible, not hide.
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.5)';
      ctx.lineWidth = 1;
      ctx.setLineDash([1, 3]);
      ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, padTop + mainH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#f472b6';
      ctx.fillText(`🍽${Math.round(carbs)}g`, x, 12);
      chartHits.push({ x, y: 12, title: 'Meal, no bolus matched', body: `${Math.round(carbs)}g carbs${mealSuffix} · ${dxFormatMarkerTime(ms)}` });
    }
  });
  (data.corrections || []).forEach(c => {
    const ms = Number(c.time), units = Number(c.units);
    if (!Number.isFinite(ms) || !Number.isFinite(units) || units <= 0 || ms < windowStart || ms > now) return;
    const x = xAt(ms);
    ctx.strokeStyle = 'rgba(251, 146, 60, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padTop); ctx.lineTo(x, padTop + mainH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fb923c';
    ctx.fillText(`${units.toFixed(1)}u`, x, 12);
    chartHits.push({ x, y: 12, title: 'Correction', body: `${units.toFixed(1)}u · ${dxFormatMarkerTime(ms)}` });
  });

  // Activity band labels — icon + name centered in the tinted band drawn
  // earlier, sitting near the bottom of the plot so they don't collide
  // with the bolus/correction labels up top. Two activities close enough
  // in time (a warm-up walk right before a lifting session, say) can have
  // labels that would otherwise land on top of each other and become
  // illegible — alternates a second row for whichever label's measured
  // width would overlap the previous one instead.
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(199, 210, 254, 0.95)';
  const sortedBands = [...activityBands].sort((a, b) => a.x0 - b.x0);
  let prevActivityLabelRight = -Infinity;
  let activityStaggerRow = 0;
  sortedBands.forEach(band => {
    const midX = (band.x0 + band.x1) / 2;
    const label = `${band.icon} ${band.label}`;
    const textWidth = ctx.measureText(label).width;
    const labelLeft = midX - textWidth / 2;
    activityStaggerRow = labelLeft < prevActivityLabelRight + 6 ? 1 - activityStaggerRow : 0;
    const y = (padTop + mainH - 18) + activityStaggerRow * 12;
    ctx.fillText(label, midX, y);
    prevActivityLabelRight = midX + textWidth / 2;
    const body = band.endMs !== band.startMs
      ? `${dxFormatMarkerTime(band.startMs)} – ${new Date(band.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} (${Math.round((band.endMs - band.startMs) / 60000)} min)`
      : dxFormatMarkerTime(band.startMs);
    chartHits.push({ x: midX, y, title: band.label, body });
  });

  // Gap band labels — sit just below the bolus/correction row rather than
  // sharing the activity labels' stagger logic, since a gap band is wide
  // and rare enough that overlap with an activity band is unlikely.
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(252, 165, 165, 0.95)';
  gapBands.forEach(band => {
    const midX = (band.x0 + band.x1) / 2;
    const y = padTop + 22;
    ctx.fillText(`⚠️ ${band.label}`, midX, y);
    const body = `${dxFormatMarkerTime(band.startMs)}${band.ongoing ? ' – still ongoing' : ` – ${new Date(band.endMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}`;
    chartHits.push({ x: midX, y, title: `No insulin — ${band.label}`, body });
  });

  // IOB strip (own 0..max scale)
  const maxIob = Math.max(0.5, ...iobSeries.map(p => p.value));
  const iobY = v => iobTop + iobStripH - (v / maxIob) * iobStripH;
  ctx.fillStyle = 'rgba(167, 139, 250, 0.35)';
  ctx.beginPath();
  ctx.moveTo(xAt(iobSeries[0].ms), iobTop + iobStripH);
  iobSeries.forEach(p => ctx.lineTo(xAt(p.ms), iobY(p.value)));
  ctx.lineTo(xAt(now), iobTop + iobStripH);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '8px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('IOB', Math.max(padL, visibleLeft + 4), iobTop - 1);

  // Basal strip (own 0..max scale) — drawn as step rectangles since
  // Control-IQ delivers as a continuously varying rate, not a flat line.
  // Scheduled-fill segments (profile default, no override logged) draw
  // lighter/hollow with a dashed top edge so they read as an assumption,
  // not a confirmed delivered dose — real segments always draw on top.
  if (basalSegments.length || basalScheduleFill.length) {
    const maxRate = Math.max(0.1, ...basalSegments.map(s => s.rate), ...basalScheduleFill.map(s => s.rate));
    const basalY = v => basalTop + basalStripH - (v / maxRate) * basalStripH;
    ctx.fillStyle = 'rgba(45, 212, 191, 0.12)';
    ctx.strokeStyle = 'rgba(45, 212, 191, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    basalScheduleFill.forEach(s => {
      const x0 = xAt(s.start), x1 = xAt(s.end);
      const y = basalY(s.rate);
      const w = Math.max(1, x1 - x0);
      ctx.fillRect(x0, y, w, basalTop + basalStripH - y);
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + w, y); ctx.stroke();
    });
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(45, 212, 191, 0.35)';
    basalSegments.forEach(s => {
      const x0 = xAt(s.start), x1 = xAt(s.end);
      const y = basalY(s.rate);
      ctx.fillRect(x0, y, Math.max(1, x1 - x0), basalTop + basalStripH - y);
    });
  }
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.font = '8px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  const basalLabel = basalSegments.length
    ? (basalScheduleFill.length ? 'Basal u/hr (some scheduled)' : 'Basal u/hr')
    : (basalScheduleFill.length ? 'Basal u/hr (scheduled, no overrides)' : 'Basal u/hr (no data)');
  ctx.fillText(basalLabel, Math.max(padL, visibleLeft + 4), basalTop - 1);

  // X-axis — real clock times every 2h, plus an explicit "now" tick.
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  const tickStepMs = 2 * 3600000;
  const firstTick = Math.ceil(windowStart / tickStepMs) * tickStepMs;
  for (let t = firstTick; t <= windowEnd; t += tickStepMs) {
    ctx.fillText(new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), xAt(t), H - 3);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText('now', xNow, H - 3);

  // DOM overlay: reposition the clickable hit-targets to match the
  // markers just painted above (canvas pixels have no click events).
  renderDxChartMarkerOverlay(markersEl, chartHits);

  dxUpdateBasalFreshness(basalSegments, now);

  // Horizontal scroll: default to the last 2h + 30min projected, but track
  // the user's chosen left-edge time (not raw scrollLeft pixels) so an
  // auto-refresh redraw doesn't yank their scroll position around as
  // `now` — and therefore windowStart/windowEnd — keeps advancing.
  if (scrollEl) {
    const scrollForMs = (ms) => ((ms - windowStart) / (windowEnd - windowStart)) * (W - padL - padR);
    const msForScroll = (px) => windowStart + (px / (W - padL - padR)) * (windowEnd - windowStart);

    if (dxChartAnchorMs == null) dxChartAnchorMs = now - VISIBLE_PAST_MIN * 60000;
    const maxAnchor = Math.max(windowStart, windowEnd - VISIBLE_SPAN_MIN * 60000);
    dxChartAnchorMs = Math.min(Math.max(dxChartAnchorMs, windowStart), maxAnchor);
    const targetScrollLeft = Math.max(0, scrollForMs(dxChartAnchorMs));
    requestAnimationFrame(() => { scrollEl.scrollLeft = targetScrollLeft; });

    dxChartLastScale = { msForScroll };

    if (!dxChartScrollWired) {
      dxChartScrollWired = true;
      let scrollRaf = null;
      scrollEl.addEventListener('scroll', () => {
        if (scrollRaf) return;
        scrollRaf = requestAnimationFrame(() => {
          scrollRaf = null;
          if (dxChartLastScale) dxChartAnchorMs = dxChartLastScale.msForScroll(scrollEl.scrollLeft);
        });
      }, { passive: true });
    }
  }
}

// Surfaces exactly how stale the basal data actually is — Control-IQ only
// logs a Temp Basal treatment on an override, so "no bars for the last
// 40min" could mean either "held the schedule the whole time" (fine) or
// "tconnectsync hasn't uploaded anything in 40min" (worth checking) — the
// chart alone can't tell those apart, but a real elapsed-time number can
// at least tell the user which one is more likely, rather than fitl00p's
// own ~60s refresh cadence being mistaken for the actual data's age.
const DX_BASAL_STALE_MIN = 30;
function dxUpdateBasalFreshness(basalSegments, now) {
  const el2 = el.dxBasalFreshness;
  if (!el2) return;
  if (!basalSegments.length) {
    el2.textContent = 'No confirmed basal dose in the last 24h — check tconnectsync is running.';
    el2.classList.add('dx-chart-hint--warn');
    return;
  }
  const lastEnd = Math.max(...basalSegments.map(s => s.end));
  const ageMin = Math.max(0, Math.round((now - lastEnd) / 60000));
  const ageText = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m ago`;
  if (ageMin > DX_BASAL_STALE_MIN) {
    el2.textContent = `⚠️ Basal last confirmed ${ageText} — check tconnectsync is running`;
    el2.classList.add('dx-chart-hint--warn');
  } else {
    el2.textContent = `Basal last confirmed ${ageText}`;
    el2.classList.remove('dx-chart-hint--warn');
  }
}

function renderDxChartMarkerOverlay(container, hits) {
  if (!container) return;
  container.innerHTML = '';
  (hits || []).forEach(hit => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dx-chart-marker-btn';
    btn.style.left = hit.x + 'px';
    btn.style.top = hit.y + 'px';
    btn.setAttribute('aria-label', hit.title);
    btn.addEventListener('click', () => showDxMarkerDetail(hit.title, hit.body));
    container.appendChild(btn);
  });
}

function showDxMarkerDetail(title, body) {
  if (!el.dxMarkerModal) return;
  if (el.dxMarkerModalTitle) el.dxMarkerModalTitle.textContent = title;
  if (el.dxMarkerModalBody) el.dxMarkerModalBody.textContent = body;
  el.dxMarkerModal.hidden = false;
}
function closeDxMarkerDetail() {
  if (el.dxMarkerModal) el.dxMarkerModal.hidden = true;
}
el.dxMarkerModalClose?.addEventListener('click', closeDxMarkerDetail);
el.dxMarkerModal?.addEventListener('click', (e) => { if (e.target === el.dxMarkerModal) closeDxMarkerDetail(); });

async function renderDiabetesTab(data) {
  const settings = dxSettings();
  const [macroMealLog, workouts, wideData, insulinGaps] = await Promise.all([fetchMacroMealLog(), fetchDxWorkouts(), fetchDiabetesDataWide(), fetchInsulinGaps()]);
  // Tandem's Control-IQ can reduce or withhold a bolus entirely when
  // current BG is low, so Nightscout's own carbs figure for that meal
  // can be missing or wrong — the MFP-logged entry's own timestamp
  // supersedes it for every COB-driven calculation below (dosingContext,
  // forecast, correction, patterns, etc.) AND the chart, so a bolus's
  // carbs label reflects what was actually logged in fitl00p, not a
  // stale/missing Nightscout figure. The MFP-import matching UI just
  // below is the one place that still needs the true, unmodified
  // Nightscout treatment list — it keeps using data.boluses directly.
  const carbBoluses = DiabetesEngine.mergeMealCarbsIntoBoluses(data.boluses, macroMealLog);
  const input = { ...data, boluses: carbBoluses, settings, activities: { workouts }, macroMealLog };
  const now = Date.now();

  drawDxGlucoseChart(el.dxGlucoseChart, el.dxGlucoseChartEmpty, input, settings, now, workouts, insulinGaps);
  renderDxInsulinGaps(insulinGaps);

  const ctx = DiabetesEngine.dosingContext(input, now);
  renderDxNow(ctx, settings);

  const forecast = DiabetesEngine.hypoForecast2h(input, now);
  renderDxForecast(forecast, settings);

  const resolved = DiabetesEngine.resolveCorrections(data.corrections, data.glucoseHistory, carbBoluses, now);
  const factor = DiabetesEngine.personalCorrectionFactor(resolved);
  const retrospective = DiabetesEngine.retrospectiveCorrection(input, now);
  const suggestion = DiabetesEngine.suggestCorrectionDose(ctx, factor, carbBoluses, data.corrections, now, retrospective.discrepancy, input);
  renderDxCorrection(suggestion);

  const patterns = DiabetesEngine.analyzePatterns(input, now);
  renderDxPatterns(patterns);

  const health = DiabetesEngine.insulinHealthCheck(input, now);
  renderDxHealth(health);

  const accuracy = DiabetesEngine.forecastAccuracy(input, now);
  renderDxForecastAccuracy(accuracy);

  const todaysMeals = await fetchTodaysDxMeals();
  renderDxTodaysMeals(todaysMeals, data.boluses || []);

  // Two separate prescribed-profile tables at two different granularities
  // — Sensitivity map keeps its original 4x6h Night/Morning/Afternoon/
  // Evening split (it's cross-tabbed against exercise context too, which
  // the finer regimen table below doesn't have), while the regimen
  // review below wants the finer 3h blocks someone would actually edit
  // in their pump. Same underlying pump profile, just time-weighted
  // against different bucket sets.
  const prescribedSensitivity = DiabetesEngine.prescribedRegimenTable(profile?.diabetes_pump_profile, DiabetesEngine.SENSITIVITY_TOD_BUCKETS);
  const prescribed = DiabetesEngine.prescribedRegimenTable(profile?.diabetes_pump_profile);
  const hasThuProfile = !!profile?.diabetes_pump_profile?.thu;

  const sensitivity = DiabetesEngine.sensitivityMap(input, now);
  renderDxSensitivity(sensitivity, prescribedSensitivity);

  // Reviewed per actually-active pump profile (Nightscout's own switch
  // history), not pooled — the same "Thur" profile covers both deliberate
  // exercise-day switches and low-tirzepatide Thursdays, so splitting by
  // what was really active at each moment captures both without having to
  // separately detect either one.
  //
  // Uses the wide (31-day-capped) fetch, not the tab's usual 14-day
  // `input` — the regimen review needs several clean, exercise-free,
  // IOB/COB-free instances of EVERY 3h block before it'll suggest
  // anything, and requiring all of that to fall inside just 14 days
  // (worse, whatever the last 7 happened to look like, before this fix)
  // was starving it even when the person is simply active most days.
  // Falls back to the regular window if the wide fetch didn't return
  // anything (e.g. rate-limited) rather than showing nothing at all.
  const regimenSource = wideData || data;
  const wideCarbBoluses = DiabetesEngine.mergeMealCarbsIntoBoluses(regimenSource.boluses, macroMealLog);
  // pumpProfile lets the correction-factor comparison use each block's
  // REAL per-time-of-day programmed factor instead of one flat setting —
  // see correctionFactorByWindowReview's comment for why that matters.
  const regimenInput = { ...regimenSource, boluses: wideCarbBoluses, settings, activities: { workouts }, macroMealLog, pumpProfile: profile?.diabetes_pump_profile };
  const regimenByProfile = DiabetesEngine.regimenReviewByProfile(regimenInput, now);
  renderDxRegimen(regimenByProfile, profile?.diabetes_pump_profile, hasThuProfile);

  el.dxLastSync.textContent = `Last synced ${new Date(diabetesFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;

  const activities = await fetchManualActivities();
  renderDxActivityLog(activities);
}

/* ── Manual activity log ─────────────────────────────────────
   Fills the gap fetchDxWorkouts()'s other two sources (fitl00p's own
   routine sessions, Apple Health sync) can't cover — an activity done
   with no watch on, most commonly swimming. Feeds three things: the
   glucose chart's activity-icon markers (via fetchDxWorkouts merging
   it in), the workout/unplug what-if simulators' personal-history
   matching, and detectBasalSuspendEpisodes' overlap check for real
   unplug precedent. */
async function fetchManualActivities() {
  if (!currentUser) return [];
  const { data, error } = await db.from('manual_activities')
    .select('id, activity_type, started_at, ended_at, unplugged')
    .eq('user_id', currentUser.id)
    .order('started_at', { ascending: false })
    .limit(10);
  if (error) { console.error('fetchManualActivities error:', error.message); return []; }
  return data || [];
}

function renderDxActivityLog(rows) {
  if (!el.dxActivityLogList) return;
  if (!rows.length) { el.dxActivityLogList.innerHTML = ''; return; }
  el.dxActivityLogList.innerHTML = `
    <div class="dx-workout-history__title" style="margin-top:14px">Recently logged</div>
    ${rows.map(r => {
      const start = new Date(r.started_at);
      const dateStr = start.toLocaleDateString([], { day: 'numeric', month: 'short' });
      const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const durationMin = Math.round((new Date(r.ended_at) - start) / 60000);
      const label = MANUAL_ACTIVITY_LABELS[r.activity_type] || r.activity_type;
      return `
        <div class="dx-workout-history__row">
          <div class="dx-workout-history__when">
            <span>${escapeHtml(label)}${r.unplugged ? ' · 🔌 unplugged' : ''} · ${dateStr} · ${timeStr}</span>
            <span class="dx-workout-history__dur">${durationMin}min</span>
          </div>
          <button class="btn btn--ghost btn--small" data-action="activity-delete" data-id="${r.id}">Delete</button>
        </div>`;
    }).join('')}
  `;
}

async function refreshDxActivityMarkers() {
  const [data, macroMealLog, workouts, insulinGaps] = await Promise.all([fetchDiabetesData(), fetchMacroMealLog(), fetchDxWorkouts(), fetchInsulinGaps()]);
  if (!data) return;
  const carbBoluses = DiabetesEngine.mergeMealCarbsIntoBoluses(data.boluses, macroMealLog);
  drawDxGlucoseChart(el.dxGlucoseChart, el.dxGlucoseChartEmpty, { ...data, boluses: carbBoluses }, dxSettings(), Date.now(), workouts, insulinGaps);
  renderDxActivityLog(await fetchManualActivities());
  renderDxInsulinGaps(insulinGaps);
}

/* ── Insulin gap log — "my infusion site has come out" ──────────
   Distinct from the activity log's 🔌 unplugged flag (a deliberate,
   fixed-duration disconnect for a workout): this is an open-ended,
   unplanned gap in delivery — logged as "no insulin since X", closed out
   later once a new site/pump is running again. Feeds the glucose chart
   (a shaded band so a resulting high reads as explained, not alarming)
   and an active-gap banner above it so the cause stays visible the whole
   time it's ongoing, not just at the moment it was logged. ────────── */
const DX_GAP_REASON_LABELS = {
  site_failure: 'Infusion site came out',
  pump_issue: 'Pump issue',
  missed_dose: 'Missed a dose',
  other: 'Other',
};

async function fetchInsulinGaps() {
  if (!currentUser) return [];
  const { data, error } = await db.from('diabetes_insulin_gaps')
    .select('id, started_at, ended_at, reason, note')
    .eq('user_id', currentUser.id)
    .order('started_at', { ascending: false })
    .limit(10);
  if (error) { console.error('fetchInsulinGaps error:', error.message); return []; }
  return data || [];
}

function renderDxInsulinGaps(rows) {
  const active = rows.find(g => !g.ended_at);
  if (el.dxGapBanner) {
    el.dxGapBanner.hidden = !active;
    if (active && el.dxGapBannerText) {
      const label = DX_GAP_REASON_LABELS[active.reason] || active.reason;
      el.dxGapBannerText.textContent = `⚠️ No insulin since ${dxFormatMarkerTime(new Date(active.started_at).getTime())} — ${label}${active.note ? ' · ' + active.note : ''}`;
    }
    if (el.btnDxResolveGap) el.btnDxResolveGap.dataset.id = active?.id || '';
  }

  if (!el.dxInsulinGapList) return;
  if (!rows.length) { el.dxInsulinGapList.innerHTML = ''; return; }
  el.dxInsulinGapList.innerHTML = `
    <div class="dx-workout-history__title" style="margin-top:14px">Insulin gaps logged</div>
    ${rows.map(r => {
      const start = new Date(r.started_at);
      const dateStr = start.toLocaleDateString([], { day: 'numeric', month: 'short' });
      const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const label = DX_GAP_REASON_LABELS[r.reason] || r.reason;
      const status = r.ended_at
        ? `resolved ${Math.round((new Date(r.ended_at) - start) / 60000)}min later`
        : 'still ongoing';
      return `
        <div class="dx-workout-history__row">
          <div class="dx-workout-history__when">
            <span>⚠️ ${escapeHtml(label)} · ${dateStr} · ${timeStr} · ${status}</span>
            ${r.note ? `<span class="dx-workout-history__dur">${escapeHtml(r.note)}</span>` : ''}
          </div>
          <button class="btn btn--ghost btn--small" data-action="gap-delete" data-id="${r.id}">Delete</button>
        </div>`;
    }).join('')}
  `;
}

el.btnDxLogInsulinGap?.addEventListener('click', () => {
  if (!el.dxInsulinGapForm) return;
  el.dxInsulinGapForm.hidden = false;
  const now = new Date();
  if (el.dxGapDate) el.dxGapDate.value = now.toISOString().slice(0, 10);
  if (el.dxGapTime) el.dxGapTime.value = now.toTimeString().slice(0, 5);
  if (el.dxGapNote) el.dxGapNote.value = '';
  if (el.dxGapLogStatus) el.dxGapLogStatus.textContent = '';
});
el.btnCancelDxGap?.addEventListener('click', () => {
  if (el.dxInsulinGapForm) el.dxInsulinGapForm.hidden = true;
});

el.btnSaveDxGap?.addEventListener('click', async () => {
  if (!currentUser) return;
  const reason = el.dxGapReason?.value || 'other';
  const dateStr = el.dxGapDate?.value;
  const timeStr = el.dxGapTime?.value;
  const note = el.dxGapNote?.value.trim() || null;
  if (!dateStr || !timeStr) {
    if (el.dxGapLogStatus) el.dxGapLogStatus.textContent = 'Fill in the date and time insulin stopped first.';
    return;
  }
  const startedAt = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(startedAt.getTime())) {
    if (el.dxGapLogStatus) el.dxGapLogStatus.textContent = "That date/time didn't parse — check the fields.";
    return;
  }

  setBtn(el.btnSaveDxGap, true, 'Save', 'Saving…');
  try {
    const { error } = await db.from('diabetes_insulin_gaps').insert({
      user_id: currentUser.id, started_at: startedAt.toISOString(), reason, note,
    });
    if (error) {
      if (el.dxGapLogStatus) el.dxGapLogStatus.textContent = `Couldn't save: ${error.message}`;
      return;
    }
    if (el.dxInsulinGapForm) el.dxInsulinGapForm.hidden = true;
    await refreshDxActivityMarkers();
  } finally {
    setBtn(el.btnSaveDxGap, false, 'Save');
  }
});

el.btnDxResolveGap?.addEventListener('click', async () => {
  const id = el.btnDxResolveGap.dataset.id;
  if (!id) return;
  setBtn(el.btnDxResolveGap, true, 'Mark resolved', 'Saving…');
  const { error } = await db.from('diabetes_insulin_gaps').update({ ended_at: new Date().toISOString() }).eq('id', id);
  setBtn(el.btnDxResolveGap, false, 'Mark resolved');
  if (error) { showToast("Couldn't resolve: " + error.message, true); return; }
  await refreshDxActivityMarkers();
});

el.dxInsulinGapList?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="gap-delete"]');
  if (!btn) return;
  const { error } = await db.from('diabetes_insulin_gaps').delete().eq('id', btn.dataset.id);
  if (error) { showToast("Couldn't delete: " + error.message, true); return; }
  await refreshDxActivityMarkers();
});

el.btnDxLogActivity?.addEventListener('click', () => {
  if (!el.dxActivityLogForm) return;
  el.dxActivityLogForm.hidden = false;
  const now = new Date();
  if (el.dxActivityDate) el.dxActivityDate.value = now.toISOString().slice(0, 10);
  if (el.dxActivityTime) el.dxActivityTime.value = now.toTimeString().slice(0, 5);
  if (el.dxActivityLogStatus) el.dxActivityLogStatus.textContent = '';
});
el.btnCancelDxActivity?.addEventListener('click', () => {
  if (el.dxActivityLogForm) el.dxActivityLogForm.hidden = true;
});

el.btnSaveDxActivity?.addEventListener('click', async () => {
  if (!currentUser) return;
  const activityType = el.dxActivityType?.value || 'other';
  const dateStr = el.dxActivityDate?.value;
  const timeStr = el.dxActivityTime?.value;
  const durationMin = Number(el.dxActivityDuration?.value) || 0;
  const unplugged = !!el.dxActivityUnplugged?.checked;
  if (!dateStr || !timeStr || durationMin <= 0) {
    if (el.dxActivityLogStatus) el.dxActivityLogStatus.textContent = 'Fill in date, start time and a duration first.';
    return;
  }
  const startedAt = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(startedAt.getTime())) {
    if (el.dxActivityLogStatus) el.dxActivityLogStatus.textContent = "That date/time didn't parse — check the fields.";
    return;
  }
  const endedAt = new Date(startedAt.getTime() + durationMin * 60000);

  setBtn(el.btnSaveDxActivity, true, 'Save', 'Saving…');
  try {
    const { error } = await db.from('manual_activities').insert({
      user_id: currentUser.id,
      activity_type: activityType,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      unplugged,
    });
    if (error) {
      if (el.dxActivityLogStatus) el.dxActivityLogStatus.textContent = `Couldn't save: ${error.message}`;
      return;
    }
    if (el.dxActivityLogForm) el.dxActivityLogForm.hidden = true;
    if (el.dxActivityUnplugged) el.dxActivityUnplugged.checked = false;
    await refreshDxActivityMarkers();
  } finally {
    setBtn(el.btnSaveDxActivity, false, 'Save');
  }
});

el.dxActivityLogList?.addEventListener('click', async e => {
  const btn = e.target.closest('[data-action="activity-delete"]');
  if (!btn) return;
  const { error } = await db.from('manual_activities').delete().eq('id', btn.dataset.id);
  if (error) { showToast("Couldn't delete: " + error.message, true); return; }
  await refreshDxActivityMarkers();
});

// Range tag drives both the big glucose number's color and the Now
// card's background wash — the same at-a-glance read every CGM app
// gives you, rather than a flat neutral number sitting in a plain card.
function dxRangeTag(glucose, settings) {
  if (glucose == null) return '';
  if (settings?.targetLow != null && glucose < settings.targetLow) return 'low';
  if (settings?.targetHigh != null && glucose > settings.targetHigh) return 'high';
  return 'in-range';
}

function renderDxNow(ctx, settings) {
  el.dxCurrentGlucose.textContent = ctx.currentGlucose != null ? fmt1(ctx.currentGlucose) : '—';
  const tag = dxRangeTag(ctx.currentGlucose, settings);
  el.dxCurrentGlucose.className = 'dx-now-glucose__val' + (tag ? ` dx-now-glucose__val--${tag}` : '');
  if (el.dxNowCard) el.dxNowCard.className = 'card card--dx-now' + (tag ? ` card--dx-now--${tag}` : '');
  el.dxTrendArrow.textContent = trendArrow(ctx.trendPerMinute);
  el.dxIob.textContent = ctx.iob != null ? `${fmt1(ctx.iob)}u` : '—';
  el.dxCob.textContent = ctx.cob != null ? `${Math.round(ctx.cob)}g` : '—';
  el.dxEffective.textContent = ctx.effectiveGlucose != null ? fmt1(ctx.effectiveGlucose) : '—';
  el.dxReadingAge.textContent = dxAgeLabel(ctx.readingAgeMinutes);
  el.dxStaleNote.hidden = !ctx.stale;
  if (ctx.stale) el.dxStaleNote.textContent = ctx.staleMessage;
}

const DX_TIER_LABEL = {
  high:     { label: 'Elevated risk', badge: 'badge--orange' },
  moderate: { label: 'Moderate risk', badge: 'badge--orange' },
  low:      { label: 'Slight risk',   badge: 'badge--blue' },
  minimal:  { label: 'Minimal risk',  badge: 'badge--green' },
};

// Only worth mentioning once the retrospective-correction nudge is big
// enough to actually matter — a fraction of a mmol/L of noise isn't
// worth a line of UI every time the tab renders.
const DX_RC_NOTE_THRESHOLD = 0.3;
function dxRetrospectiveNote(effect) {
  if (effect == null || Math.abs(effect) < DX_RC_NOTE_THRESHOLD) return '';
  const direction = effect < 0 ? 'lower' : 'higher';
  return `<p class="dx-note">Adjusted ${fmt1(Math.abs(effect))} mmol/L — glucose has been running ${direction} than insulin+carbs alone would predict over the last 30 min.</p>`;
}

// Same noise floor as the retrospective note above — only worth a line
// once carbs still absorbing (see suggestCorrectionDose's cobRiseMmol)
// account for a meaningful chunk of the suggested dose.
const DX_COB_NOTE_THRESHOLD = 0.3;
function dxCobNote(cobGrams, cobRiseMmol, personalized, personalizedSampleSize) {
  if (!cobGrams || cobRiseMmol == null || cobRiseMmol < DX_COB_NOTE_THRESHOLD) return '';
  const source = personalized
    ? `personalized from ${personalizedSampleSize} similar past meals`
    : 'your pump\'s carb ratio';
  return `<p class="dx-note">Includes ${fmt1(cobGrams)}g of carbs still digesting (~${fmt1(cobRiseMmol)} mmol/L still to come, priced using ${source}) — this dose is sized for where that'll take you, not just the current reading.</p>`;
}

function renderDxForecast(forecast, settings) {
  if (!forecast.tier) {
    const msg = typeof WITHHELD_MESSAGES[forecast.withheldReason] === 'function'
      ? WITHHELD_MESSAGES[forecast.withheldReason](forecast.factor?.sampleSize)
      : (WITHHELD_MESSAGES[forecast.withheldReason] || 'Not enough data yet.');
    el.dxForecastBody.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
    return;
  }
  const t = DX_TIER_LABEL[forecast.tier];
  // Same preventativeCarbAdvice the Simple view's action banner already
  // uses for a trending-low reading — the advanced tab's forecast card
  // used to just name the risk tier with no "so what do I actually do
  // about it" line, which is the whole point of a forecast.
  const advice = forecast.tier !== 'minimal' && settings
    ? DiabetesEngine.preventativeCarbAdvice(forecast.forecastGlucose, 120, forecast.factor, settings)
    : null;
  el.dxForecastBody.innerHTML = `
    <div class="dx-forecast-row">
      <span class="badge ${t.badge}">${t.label}</span>
      <span class="dx-forecast-val">${fmt1(forecast.forecastGlucose)} mmol/L projected</span>
    </div>
    ${advice?.message ? `<p class="dx-note dx-note--carb">${escapeHtml(advice.message)}</p>` : ''}
    ${forecast.bumpedForTimeOfDay ? '<p class="dx-note">This time of day has run low recently, so the forecast was bumped up a tier.</p>' : ''}
    ${forecast.forecastCapped ? '<p class="dx-note">Capped at 25 mmol/L — the raw math projected higher, likely a large meal stretched across your current correction factor further than it\'s really been tested at. Treat this as "very high", not a precise number.</p>' : ''}
    ${dxRetrospectiveNote(forecast.retrospectiveEffect)}
  `;
}

function renderDxCorrection(s) {
  if (s.withheldReason === 'stacking-caution') {
    const doses = s.stackingDoses.map(d => `${fmtDose(d.units)}u, ${dxAgeLabel(d.ageMinutes)}`).join('; ');
    el.dxCorrectionBody.innerHTML = `<p class="empty-state">Recent dose still active (${escapeHtml(doses)}) — wait before correcting again.</p>`;
    return;
  }
  if (s.withheldReason) {
    const msg = typeof WITHHELD_MESSAGES[s.withheldReason] === 'function'
      ? WITHHELD_MESSAGES[s.withheldReason](s.factorSampleSize)
      : (WITHHELD_MESSAGES[s.withheldReason] || 'Not enough data yet.');
    el.dxCorrectionBody.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
    return;
  }
  el.dxCorrectionBody.innerHTML = `
    <div class="dx-suggestion">
      <span class="dx-suggestion__val">${fmtDose(s.suggestedUnits)}u</span>
      <span class="dx-suggestion__meta">factor ${fmt1(s.factor)} mmol/L/u, from ${s.factorSampleSize} corrections</span>
    </div>
    ${s.cappedAt10 ? '<p class="dx-note">Capped at 10u — the raw math suggested more.</p>' : ''}
    ${dxRetrospectiveNote(s.retrospectiveEffect)}
    ${dxCobNote(s.cob, s.cobRiseMmol, s.cobPersonalized, s.cobPersonalizedSampleSize)}
  `;
}

/* ── Live auto-refresh (Diabetes tab + Simple view) ──────────
   Dexcom feeds Nightscout roughly every 5 minutes; polling at 60s
   keeps the "Now" strip, correction suggestion, forecast and Simple
   view within a minute of that without hammering the user's own
   Nightscout instance. Deliberately lighter than a full
   renderDiabetesTab(): meal memory, patterns, sensitivity/regimen
   reviews and MFP imports don't change minute-to-minute and each
   pulls extra Supabase tables, so only the live-glucose-derived
   pieces are recomputed on every tick. Runs only while the diabetes
   tab is the active view (started at the end of loadDiabetes(),
   stopped by navigateTo() the moment another tab is opened) and
   pauses while the page itself isn't visible, resuming — with an
   immediate catch-up tick — the moment it is again. */
const DX_AUTO_REFRESH_MS = 60000;
let dxAutoRefreshTimer = null;

function startDxAutoRefresh() {
  if (dxAutoRefreshTimer) return;
  dxAutoRefreshTimer = setInterval(refreshDxLive, DX_AUTO_REFRESH_MS);
}

function stopDxAutoRefresh() {
  if (dxAutoRefreshTimer) { clearInterval(dxAutoRefreshTimer); dxAutoRefreshTimer = null; }
}

async function refreshDxLive() {
  if (!profile?.diabetes_ns_url) return;
  try {
    const [data, macroMealLog, workouts, insulinGaps] = await Promise.all([fetchDiabetesData(true), fetchMacroMealLog(), fetchDxWorkouts(), fetchInsulinGaps()]);
    const settings = dxSettings();
    const now = Date.now();
    // Same MFP-supersedes-Nightscout-carbs correction as renderDiabetesTab
    // — see mergeMealCarbsIntoBoluses. Kept here too so the Now card,
    // correction suggestion and Simple View all stay accurate between
    // full tab reloads, not just right after one.
    const carbBoluses = DiabetesEngine.mergeMealCarbsIntoBoluses(data.boluses, macroMealLog);
    const input = { ...data, boluses: carbBoluses, settings, activities: { workouts }, macroMealLog };

    const ctx = DiabetesEngine.dosingContext(input, now);
    renderDxNow(ctx, settings);
    drawDxGlucoseChart(el.dxGlucoseChart, el.dxGlucoseChartEmpty, input, settings, now, workouts, insulinGaps);
    renderDxInsulinGaps(insulinGaps);

    const resolved = DiabetesEngine.resolveCorrections(data.corrections, data.glucoseHistory, carbBoluses, now);
    const factor = DiabetesEngine.personalCorrectionFactor(resolved);
    const retrospective = DiabetesEngine.retrospectiveCorrection(input, now);
    const suggestion = DiabetesEngine.suggestCorrectionDose(ctx, factor, carbBoluses, data.corrections, now, retrospective.discrepancy, input);
    renderDxCorrection(suggestion);

    const forecast = DiabetesEngine.hypoForecast2h(input, now);
    renderDxForecast(forecast, settings);

    if (el.screenDxSimple && !el.screenDxSimple.hidden) {
      renderDxSimple(data, ctx, suggestion, forecast, settings, factor.factor);
    }

    el.dxLastSync.textContent = `Last synced ${new Date(diabetesFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    // Silent — this is a background tick, not a user-initiated action.
    // The last-good render stays on screen; dxLastSync's timestamp is
    // the visible signal of when data last actually changed, same as
    // it would be if the user just hadn't tapped Refresh yet.
    console.error('Diabetes auto-refresh failed:', err?.message || err);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    stopDxAutoRefresh();
  // el.viewDiabetes is nested inside el.viewDashboard now (not its own
  // top-level view — see the "views" comment above), so both need
  // checking: viewDiabetes' own hidden attribute only reflects whether
  // diabetes tracking is enabled at all (applyDiabetesTabVisibility),
  // not whether the dashboard (its ancestor) is the tab actually on
  // screen right now.
  } else if (el.viewDashboard && !el.viewDashboard.hidden && el.viewDiabetes && !el.viewDiabetes.hidden) {
    startDxAutoRefresh();
    refreshDxLive();
  }
});

/* ── Simple view — glanceable always-on overlay ──────────────
   One number, two stats, one action. Opened from a button on the
   diabetes tab's "Now" card, kept live by the same refreshDxLive()
   tick that feeds that card, and requests a wake lock while open so
   a phone left charging on the counter doesn't lock its screen. */
function currentBasalRate(basalDoses, now = Date.now()) {
  const sorted = (basalDoses || [])
    .map(b => ({ ...b, ms: toMs(b.time) }))
    .filter(b => Number.isFinite(b.ms))
    .sort((a, b) => a.ms - b.ms);
  if (!sorted.length) return null;

  // Prefer a segment whose own logged duration actually covers "now".
  for (let i = sorted.length - 1; i >= 0; i--) {
    const seg = sorted[i];
    const endMs = seg.ms + (Number(seg.durationMin) || 0) * 60000;
    if (seg.ms <= now && endMs >= now) return seg.rate;
  }
  // Control-IQ logs a fresh segment roughly every 5 minutes when
  // active — fall back to the most recent one as long as it's still
  // that fresh, rather than showing a rate that may be long stale.
  const latest = sorted[sorted.length - 1];
  if (latest && (now - latest.ms) <= 20 * 60000) return latest.rate;
  return null;
}
function toMs(t) {
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// How far off the ideal target still counts as "at target" for Simple
// View's coloring and for triggering a correction suggestion — set by
// the user, not the wider targetLow/targetHigh safety band used
// elsewhere (that band is "not dangerous," this is "close enough to
// target that nothing needs doing").
const DX_SIMPLE_TARGET_BAND_MMOL = 1.0;

function renderDxSimple(data, ctx, correctionSuggestion, forecast, settings, factorValue) {
  if (!el.screenDxSimple) return;

  el.dxSimpleGlucose.textContent = ctx.currentGlucose != null ? fmt1(ctx.currentGlucose) : '—';
  el.dxSimpleTrend.textContent = trendArrow(ctx.trendPerMinute);
  el.dxSimpleIob.textContent = ctx.iob != null ? `${fmt1(ctx.iob)}u` : '—';

  const basal = currentBasalRate(data?.basalDoses, ctx.now);
  el.dxSimpleBasal.textContent = basal != null ? `${fmt1(basal)}u/hr` : '—';

  const g = ctx.currentGlucose;
  // Only center coloring/corrections on the ideal target once the user
  // has actually set one in Settings — without it, fall back to the
  // wider targetLow/targetHigh safety band exactly as before.
  const target = Number.isFinite(Number(settings.idealTarget)) ? Number(settings.idealTarget) : null;

  el.screenDxSimple.classList.remove('dx-simple--low', 'dx-simple--high', 'dx-simple--inrange');
  if (g != null && !ctx.stale) {
    if (target != null) {
      if (g < target - DX_SIMPLE_TARGET_BAND_MMOL) el.screenDxSimple.classList.add('dx-simple--low');
      else if (g > target + DX_SIMPLE_TARGET_BAND_MMOL) el.screenDxSimple.classList.add('dx-simple--high');
      else el.screenDxSimple.classList.add('dx-simple--inrange');
    } else {
      if (g < settings.targetLow) el.screenDxSimple.classList.add('dx-simple--low');
      else if (g > settings.targetHigh) el.screenDxSimple.classList.add('dx-simple--high');
      else el.screenDxSimple.classList.add('dx-simple--inrange');
    }
  }

  // A personal, data-derived correction factor is more accurate, but a
  // newer account may not have >=3 resolved corrections yet to compute
  // one — the prescribed pump factor (Settings > correction factor) is
  // always available once entered, so it's a reasonable fallback for a
  // real number instead of "not enough history" on every high reading.
  const prescribedFactor = Number(profile?.diabetes_correction_factor) || null;
  const effFactor = factorValue || prescribedFactor;
  const fromPrescribed = !factorValue && !!prescribedFactor;

  el.screenDxSimple.classList.remove('dx-simple--action-ok', 'dx-simple--action-correct', 'dx-simple--action-carbs');
  let actionText, actionClass;
  if (ctx.stale) {
    actionText = 'No recent reading — check your sensor.';
    actionClass = null;
  } else if (target != null && g != null && g < target - DX_SIMPLE_TARGET_BAND_MMOL) {
    // More than the band below target. Below the hard safety floor is
    // always urgent regardless of what's forecast — COB acting slowly
    // over the next couple hours doesn't help a low that needs treating
    // in the next few minutes. But merely below the softer personal
    // target is a different case: the 2h forecast (hypoForecast2h)
    // already models IOB decay AND carbs-on-board absorption, so if it's
    // sitting at minimal/low risk, it already knows about COB that's
    // expected to bring this back up on its own — the plain
    // distance-below-target math below doesn't know that, and used to
    // recommend eating even when the main tab's own forecast card was
    // showing "minimal risk, trending up" right next to it.
    const urgent = g < settings.targetLow; // below the hard safety floor, not just off personal target
    if (!urgent && (forecast?.tier === 'minimal' || forecast?.tier === 'low') && forecast.forecastGlucose != null) {
      actionText = `${fmt1(g)} is below target (${fmt1(target)}) but trending up — projected ${fmt1(forecast.forecastGlucose)} in 2h, no action needed.`;
      actionClass = 'dx-simple--action-ok';
    } else {
      const carbRatio = Number(settings.carbRatio) || null;
      const grams = (effFactor && carbRatio) ? Math.round(((target - g) / effFactor) * carbRatio) : null;
      actionText = grams != null
        ? (urgent ? `Eat ~${grams}g carbs now — low (${fmt1(g)})` : `Eat ~${grams}g carbs${fromPrescribed ? ' (from pump settings)' : ''} — ${fmt1(g)} → target ${fmt1(target)}`)
        : (urgent ? `Low now (${fmt1(g)}) — treat with fast-acting carbs` : `${fmt1(g)} is below target (${fmt1(target)}) — consider some carbs`);
      actionClass = 'dx-simple--action-carbs';
    }
  } else if (target == null && ctx.currentGlucose != null && ctx.currentGlucose < settings.targetLow) {
    const advice = factorValue ? DiabetesEngine.preventativeCarbAdvice(ctx.currentGlucose, 0, factorValue, settings) : null;
    actionText = advice?.gramsNeeded
      ? `Eat ~${advice.gramsNeeded}g fast carbs — low now (${fmt1(ctx.currentGlucose)})`
      : `Low now (${fmt1(ctx.currentGlucose)}) — treat with fast-acting carbs`;
    actionClass = 'dx-simple--action-carbs';
  } else if (forecast?.tier === 'high' || forecast?.tier === 'moderate') {
    const advice = DiabetesEngine.preventativeCarbAdvice(forecast.forecastGlucose, 120, forecast.factor, settings);
    actionText = advice.gramsNeeded ? `Eat ~${advice.gramsNeeded}g carbs — trending low` : 'Trending low — keep an eye on it';
    actionClass = 'dx-simple--action-carbs';
  } else if (target != null && g != null && g > target + DX_SIMPLE_TARGET_BAND_MMOL) {
    // More than the band above target — prefer the engine's own
    // suggestion (already targets idealTarget and nets out IOB) when a
    // personal factor is trustworthy; otherwise estimate from the
    // prescribed pump factor so a real number still shows up.
    let units = null, usedPrescribed = false;
    if (correctionSuggestion && !correctionSuggestion.withheldReason && correctionSuggestion.suggestedUnits != null) {
      units = correctionSuggestion.suggestedUnits;
    } else if (prescribedFactor) {
      const raw = (g - target) / prescribedFactor - (ctx.iob || 0);
      units = Math.min(10, Math.max(0, DiabetesEngine.roundDose(raw)));
      usedPrescribed = true;
    }
    const urgentHigh = g > settings.targetHigh; // above the hard safety ceiling, not just off personal target
    actionText = units != null
      ? (urgentHigh ? `Correct: ${fmtDose(units)}u insulin now — high (${fmt1(g)})` : `Correct: ${fmtDose(units)}u insulin${usedPrescribed ? ' (from pump settings)' : ''} — ${fmt1(g)} → target ${fmt1(target)}`)
      : `${fmt1(g)} is above target (${fmt1(target)}) — not enough dose history yet for a suggestion`;
    actionClass = 'dx-simple--action-correct';
  } else if (correctionSuggestion && !correctionSuggestion.withheldReason && correctionSuggestion.suggestedUnits > 0) {
    actionText = `Correct: ${fmtDose(correctionSuggestion.suggestedUnits)}u insulin`;
    actionClass = 'dx-simple--action-correct';
  } else if (target == null && ctx.currentGlucose != null && ctx.currentGlucose > settings.targetHigh) {
    actionText = `High now (${fmt1(ctx.currentGlucose)}) — not enough dose history yet for a suggestion`;
    actionClass = 'dx-simple--action-correct';
  } else {
    actionText = target != null ? `At target (${fmt1(target)}) — no action needed` : 'In range — no action needed';
    actionClass = 'dx-simple--action-ok';
  }
  el.dxSimpleActionText.textContent = actionText;
  if (actionClass) el.screenDxSimple.classList.add(actionClass);

  el.dxSimpleUpdated.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function openDxSimpleMode() {
  if (!el.screenDxSimple) return;
  el.screenDxSimple.hidden = false;
  requestWakeLock();
  refreshDxLive();
}

function closeDxSimpleMode() {
  if (!el.screenDxSimple || el.screenDxSimple.hidden) return;
  el.screenDxSimple.hidden = true;
  // Respect the separate "keep screen awake" Settings preference —
  // only release the lock Simple view itself is responsible for.
  if (localStorage.getItem(KEEP_AWAKE_KEY) !== '1') releaseWakeLock();
}

el.btnDxSimpleMode?.addEventListener('click', openDxSimpleMode);
el.btnDxSimpleExit?.addEventListener('click', closeDxSimpleMode);

const DX_MEAL_WITHHELD_MESSAGES = {
  'stale-reading': 'No recent glucose reading — check your sensor app.',
  'missing-carb-ratio': 'Set a carb ratio in Settings first.',
};

el.dxMealPreset?.addEventListener('change', () => {
  const preset = dxMealPresets.find(p => p.name === el.dxMealPreset.value);
  dxSelectedMealPresetId = preset?.id ?? null;
  if (!preset) return;
  if (el.dxMealName)    el.dxMealName.value = preset.name;
  if (el.dxMealCarbs)   el.dxMealCarbs.value = preset.carbs || '';
  if (el.dxMealFat)     el.dxMealFat.value = preset.fat || '';
  if (el.dxMealProtein) el.dxMealProtein.value = preset.protein || '';
});
// Hand-editing any field after picking a preset means this is no longer
// exactly that same logged meal (different amount, a typo fix, etc.) —
// detach so the dose calculation below falls back to creating its own
// new entry instead of overwriting the original preset meal's data.
[el.dxMealName, el.dxMealCarbs, el.dxMealFat, el.dxMealProtein].forEach(input => {
  input?.addEventListener('input', () => { dxSelectedMealPresetId = null; });
});

$('btnDxMealDose')?.addEventListener('click', async () => {
  const mealName = el.dxMealName.value.trim();
  const carbsRaw = parseFloat(el.dxMealCarbs.value);
  const carbs = Number.isFinite(carbsRaw) && carbsRaw > 0 ? carbsRaw : 0;
  const fat = parseFloat(el.dxMealFat.value) || 0;
  const protein = parseFloat(el.dxMealProtein.value) || 0;
  if (carbs <= 0 && fat <= 0 && protein <= 0) {
    el.dxMealDoseBody.innerHTML = '<p class="empty-state">Enter carbs (or leave blank just to check your current correction).</p>';
    return;
  }
  try {
    const data = await fetchDiabetesData();
    if (!data) return;
    const now = Date.now();
    const [macroMealLog, workouts] = await Promise.all([fetchMacroMealLog(), fetchDxWorkouts()]);
    const input = { ...data, settings: dxSettings(), activities: { workouts }, macroMealLog };

    const r = DiabetesEngine.suggestMacroMealDose(input, { carbs, fat, protein, mealName: mealName || null }, now);
    if (r.suggestedUnits == null) {
      el.dxMealDoseBody.innerHTML = `<p class="empty-state">${DX_MEAL_WITHHELD_MESSAGES[r.withheldReason] || 'Not enough data yet.'}</p>`;
      return;
    }

    const trendGlyph = trendArrow(r.trendPerMinute);
    const projectedShown = r.effectiveGlucose != null && r.currentGlucose != null
      && Math.abs(r.effectiveGlucose - r.currentGlucose) >= 0.1;
    const glucoseLine = r.currentGlucose != null
      ? `${fmt1(r.currentGlucose)} mmol/L now ${trendGlyph}${projectedShown ? ` (~${fmt1(r.effectiveGlucose)} in 30min, used for the correction below)` : ''}${r.idealTarget != null ? ` → target ${fmt1(r.idealTarget)}` : ''}`
      : null;

    // Real split, from the actual (post-rounding, post-high-protein-bump)
    // upfront/delayed units — not the guide's nominal 50/50 or 65/35,
    // which can drift from what actually gets suggested once rounding
    // and the high-protein bump (added only to the delayed dose) are
    // applied.
    const splitPct = r.suggestedUnits > 0
      ? { upfront: Math.round((r.upfrontUnits / r.suggestedUnits) * 100), delayed: Math.round((r.delayedUnits / r.suggestedUnits) * 100) }
      : { upfront: 0, delayed: 0 };

    const doseHtml = r.guide.tier === 'single'
      ? `<div class="dx-suggestion">
          <span class="dx-suggestion__val">${fmtDose(r.suggestedUnits)}u</span>
          <span class="dx-suggestion__meta">${escapeHtml(r.guide.message)}</span>
        </div>`
      : `<div class="dx-suggestion">
          <span class="dx-suggestion__val">${fmtDose(r.suggestedUnits)}u total</span>
          <span class="dx-suggestion__meta">split ${splitPct.upfront}% / ${splitPct.delayed}%</span>
        </div>
        <div class="dx-split-dose">
          <div class="dx-split-dose__part">
            <span class="dx-split-dose__label">Now (${splitPct.upfront}%)</span>
            <span class="dx-split-dose__val">${fmtDose(r.upfrontUnits)}u</span>
          </div>
          <div class="dx-split-dose__arrow">→</div>
          <div class="dx-split-dose__part">
            <span class="dx-split-dose__label">+${r.guide.delayMinutes}min (${splitPct.delayed}%)</span>
            <span class="dx-split-dose__val">${fmtDose(r.delayedUnits)}u</span>
          </div>
        </div>
        <p class="dx-note">${escapeHtml(r.guide.message)}</p>`;

    const breakdownParts = [];
    if (carbs > 0) breakdownParts.push(`${fmtDose(r.carbUnits)}u for carbs`);
    if (r.correctionAvailable && Math.abs(r.correctionUnits) >= 0.005) {
      breakdownParts.push(`${fmtSigned(r.correctionUnits, 2)}u correction (factor ${fmt1(r.factor)}, ${r.factorSource === 'pump-setting' ? 'from pump settings' : `learned from ${r.factorSampleSize} corrections`})`);
    }
    if (r.iob >= 0.005) breakdownParts.push(`−${fmtDose(r.iob)}u active IOB`);

    const personalizedNote = carbs > 0
      ? (r.personalized
        ? `Personalized from ${r.personalizedSampleSize} ${r.personalizedBy === 'meal-name' ? `past "${escapeHtml(mealName)}" meals` : 'similar-fat past meals'}${r.nudgePct ? `, nudged ${fmtSigned(r.nudgePct, 0)}%` : ''}.`
        : 'Guide default — log a few more meals like this to personalize it.')
      : '';
    const situationalNote = carbs > 0 && r.situationalMatches > 0
      ? `Weighted toward ${r.situationalMatches} past meal${r.situationalMatches === 1 ? '' : 's'} eaten with a similar BG trend and IOB level to right now.`
      : '';

    el.dxMealDoseBody.innerHTML = `
      ${glucoseLine ? `<p class="dx-note" style="margin-bottom:8px">${escapeHtml(glucoseLine)}</p>` : ''}
      ${doseHtml}
      ${breakdownParts.length ? `<p class="dx-note">${escapeHtml(breakdownParts.join(' + '))}</p>` : ''}
      ${r.zeroedByFloor ? '<p class="dx-note" style="color:var(--orange)">The math went negative — capped at 0u since you\'re currently low.</p>' : ''}
      ${r.lowGlucoseWarning ? '<p class="dx-note" style="color:var(--orange)">You\'re below target right now — treat the low first if you need to.</p>' : ''}
      ${!r.correctionAvailable && r.idealTarget == null ? '<p class="dx-note">Set a correction target and factor in Settings to have this account for your current glucose.</p>' : ''}
      ${personalizedNote ? `<p class="dx-note">${personalizedNote}</p>` : ''}
      ${situationalNote ? `<p class="dx-note">${escapeHtml(situationalNote)}</p>` : ''}
    `;

    if (carbs > 0) await recordMacroMeal({ time: now, mealName: mealName || null, carbs, fat, protein }, r, dxSelectedMealPresetId);
  } catch (err) {
    el.dxMealDoseBody.innerHTML = `<p class="empty-state" style="color:var(--red)">${escapeHtml(err.message)}</p>`;
  }
});

const DX_CATEGORY = {
  'needs-attention': { label: 'Needs attention', badge: 'badge--orange' },
  'going-well':       { label: 'Going well',       badge: 'badge--green' },
  'worth-knowing':    { label: 'Worth knowing',    badge: 'badge--blue' },
};

function dxInsightCard(i, keyMap) {
  const cat = DX_CATEGORY[i.category] || DX_CATEGORY[keyMap[i.category]] || { label: i.category, badge: 'badge--gray' };
  return `
    <div class="dx-insight">
      <div class="dx-insight__head">
        <span class="badge ${cat.badge}">${cat.label}</span>
        <span class="dx-insight__n">n=${i.n}</span>
      </div>
      <div class="dx-insight__title">${escapeHtml(i.title)}</div>
      <div class="dx-insight__summary">${escapeHtml(i.summary)}</div>
      ${i.tryText ? `<div class="dx-insight__try"><b>Try:</b> ${escapeHtml(i.tryText)}</div>` : ''}
    </div>`;
}

// Leads with what needs attention — the whole point of checking Patterns
// is to catch issues, and those were getting buried under a wall of
// reassuring "going well" cards ahead of them. Going-well/worth-knowing
// still exist (nothing's lost) but sit collapsed behind a toggle so the
// issues are what's actually on screen without scrolling.
function renderDxPatterns(patterns) {
  if (!patterns.sufficient) {
    el.dxPatternsBody.innerHTML = `<p class="empty-state">Need at least ${patterns.minReadingsNeeded} readings in the last 7 days (have ${patterns.readingCount}).</p>`;
    return;
  }
  const keyMap = { needsAttention: 'needs-attention', goingWell: 'going-well', worthKnowing: 'worth-knowing' };
  const issues = patterns.needsAttention || [];
  const secondary = [...(patterns.goingWell || []), ...(patterns.worthKnowing || [])];
  if (!issues.length && !secondary.length) {
    el.dxPatternsBody.innerHTML = '<p class="empty-state">No notable patterns this week.</p>';
    return;
  }

  const issuesHtml = issues.length
    ? issues.map(i => dxInsightCard(i, keyMap)).join('')
    : '<p class="empty-state">🎉 No issues flagged this week.</p>';

  const secondaryHtml = secondary.length
    ? `<button type="button" class="btn btn--ghost btn--small dx-patterns-toggle" id="dxPatternsToggle" aria-expanded="false">
         Show ${secondary.length} going well / worth knowing ▾
       </button>
       <div class="dx-patterns-secondary" id="dxPatternsSecondary" hidden>
         ${secondary.map(i => dxInsightCard(i, keyMap)).join('')}
       </div>`
    : '';

  el.dxPatternsBody.innerHTML = issuesHtml + secondaryHtml;
}

el.dxPatternsBody?.addEventListener('click', e => {
  const btn = e.target.closest('#dxPatternsToggle');
  if (!btn) return;
  const panel = $('dxPatternsSecondary');
  if (!panel) return;
  const nowHidden = !panel.hidden;
  panel.hidden = nowHidden;
  btn.setAttribute('aria-expanded', String(!nowHidden));
  const count = panel.querySelectorAll('.dx-insight').length;
  btn.textContent = nowHidden ? `Show ${count} going well / worth knowing ▾` : `Hide going well / worth knowing ▴`;
});

function renderDxHealth(h) {
  if (!h.sufficient) {
    el.dxHealthBody.innerHTML = `<p class="empty-state">Need at least ${DiabetesEngine.PATTERN_MIN_READINGS} readings this week (have ${h.readingCount}).</p>`;
    return;
  }
  const tw = h.thisWeek;
  const trendRow = h.trend ? `
    <p class="dx-note">
      vs last week: TDD ${fmtSigned(h.trend.tddDelta, 1)}u,
      time-in-range ${fmtSigned(h.trend.tirDelta, 0)}pp,
      CV ${fmtSigned(h.trend.cvDelta, 0)}pp
    </p>` : '<p class="dx-note">Not enough data from last week to compare yet.</p>';

  // A proportional low/in-range/high bar reads at a glance far faster than
  // three separate percentages — position + a legend carries identity, so
  // it still works for someone who can't distinguish the colors.
  const { pctBelow, pctInRange, pctAbove } = tw.tir;
  const tirBar = `
    <div class="dx-tir-bar">
      ${pctBelow > 0.5 ? `<i class="dx-tir-bar__seg dx-tir-bar__seg--low" style="width:${pctBelow}%"></i>` : ''}
      ${pctInRange > 0.5 ? `<i class="dx-tir-bar__seg dx-tir-bar__seg--in" style="width:${pctInRange}%"></i>` : ''}
      ${pctAbove > 0.5 ? `<i class="dx-tir-bar__seg dx-tir-bar__seg--high" style="width:${pctAbove}%"></i>` : ''}
    </div>
    <div class="dx-tir-legend">
      <span><i class="dx-tir-legend__chip dx-tir-legend__chip--low"></i>Below 3.9 <b>${fmt1(pctBelow)}%</b></span>
      <span><i class="dx-tir-legend__chip dx-tir-legend__chip--in"></i>In range <b>${fmt1(pctInRange)}%</b></span>
      <span><i class="dx-tir-legend__chip dx-tir-legend__chip--high"></i>Above 10 <b>${fmt1(pctAbove)}%</b></span>
    </div>`;

  el.dxHealthBody.innerHTML = `
    ${tirBar}
    <div class="dx-health-grid">
      <div class="dx-health-stat"><span class="dx-health-stat__label">CV</span><span class="dx-health-stat__val">${tw.cv != null ? fmt1(tw.cv) + '%' : '—'}</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Total daily dose</span><span class="dx-health-stat__val">${fmt1(tw.tdd)}u</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Dose per kg</span><span class="dx-health-stat__val">${tw.tddPerKg != null ? fmt1(tw.tddPerKg) + 'u' : '—'}</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Basal / bolus split</span><span class="dx-health-stat__val">${tw.basalPct != null ? Math.round(tw.basalPct) + '/' + Math.round(tw.bolusPct) : '—'}</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">BMI</span><span class="dx-health-stat__val">${tw.bmi != null ? fmt1(tw.bmi) : '—'}</span></div>
    </div>
    ${trendRow}
  `;
}

function renderDxForecastAccuracy(a) {
  if (!el.dxForecastAccuracyBody) return;
  if (!a.sufficient) {
    el.dxForecastAccuracyBody.innerHTML = `<p class="empty-state">Need at least ${a.minNeeded} scoreable forecasts from the last 14 days (have ${a.scored}) — this needs a resolved correction factor and glucose readings 2h after each check.</p>`;
    return;
  }
  el.dxForecastAccuracyBody.innerHTML = `
    <div class="dx-health-grid">
      <div class="dx-health-stat"><span class="dx-health-stat__label">Bias</span><span class="dx-health-stat__val">${fmtSigned(a.bias, 1)} mmol/L</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Mean error</span><span class="dx-health-stat__val">${fmt1(a.mae)} mmol/L</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Within 1 mmol/L</span><span class="dx-health-stat__val">${Math.round(a.within1)}%</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Within 2 mmol/L</span><span class="dx-health-stat__val">${Math.round(a.within2)}%</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Warning precision</span><span class="dx-health-stat__val">${a.precision != null ? Math.round(a.precision) + '%' : '—'}</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Warning recall</span><span class="dx-health-stat__val">${a.recall != null ? Math.round(a.recall) + '%' : '—'}</span></div>
    </div>
    <p class="dx-note">
      Scored ${a.scored} forecasts against what actually happened 2h later — ${a.warnings} flagged a low risk, ${a.lows} actually went low.
      ${a.bias < -0.3 ? 'The forecast is running a bit low compared to reality — worth treating its warnings as slightly more cautious than the number suggests.'
        : a.bias > 0.3 ? 'The forecast is running a bit high compared to reality — a warning here may be understating the real risk.'
        : 'Bias is small — the forecast is tracking reality reasonably closely.'}
    </p>
  `;
}

// "What if I…" — Workout tab's glucose-impact simulator. Selectable pill
// presets (real synced workout types + a handful of everyday activities
// Apple Health wouldn't log as a "workout") each fill in a sensible
// Duration/Intensity default, both still freely editable before hitting
// Simulate. workoutSimulate() anchors the projection to the CURRENT
// glucose + active IOB rather than just a historical average.
const DX_SIMULATE_GENERIC_PRESETS = [
  { type: 'Golf', durationMin: 180, intensity: 'light' },
  { type: 'Driving range', durationMin: 45, intensity: 'light' },
  { type: 'Housework/garden', durationMin: 30, intensity: 'light' },
  { type: 'Play with kids', durationMin: 30, intensity: 'moderate' },
];
const DX_SIMULATE_INTENSITY_CLASS_MAP = {
  'high-intensity': 'vigorous',
  'cardio-endurance': 'moderate',
  'strength': 'moderate',
  'low-intensity': 'light',
  'unclassified': 'light',
};
let dxSimulateSelectedType = null;

function renderDxWorkoutSimulateResult(result) {
  if (!el.dxWorkoutImpactBody) return;
  if (result.withheldReason === 'stale-reading') {
    el.dxWorkoutImpactBody.innerHTML = `<p class="empty-state">${escapeHtml(result.staleMessage || 'No recent reading to simulate from.')}</p>`;
    return;
  }

  const riskClass = result.risk === 'high' ? 'dx-simulate-result--high' : result.risk === 'medium' ? 'dx-simulate-result--medium' : '';
  const riskBadge = result.risk === 'high' ? 'badge--red' : result.risk === 'medium' ? 'badge--orange' : 'badge--green';
  const sourceNote = result.source === 'personal'
    ? `Based on ${result.sampleSize} past ${escapeHtml(result.workoutType)} session${result.sampleSize === 1 ? '' : 's'}.`
    : `Based on a generic estimate for ${result.intensity} activity over ${result.durationMin} min — no personal history for ${escapeHtml(result.workoutType)} yet.`;
  const carbLine = result.carbAdvice?.gramsNeeded > 0
    ? `<div class="dx-simulate-result__line">🍬 ${escapeHtml(result.carbAdvice.message)}</div>`
    : '';
  // Both bounds can hit the display floor for a big enough drop estimate —
  // "1.5–1.5" reads oddly, "≤1.5" reads as intended (a severe-low warning).
  const rangeText = result.projectedLow === result.projectedHigh
    ? `≤${fmt1(result.projectedLow)}`
    : `${fmt1(result.projectedLow)}–${fmt1(result.projectedHigh)}`;

  el.dxWorkoutImpactBody.innerHTML = `
    <div class="dx-simulate-result ${riskClass}">
      <div class="dx-simulate-result__line"><b>Likely range after:</b> ${rangeText} mmol/L (from ${fmt1(result.currentGlucose)}, ${fmt1(result.iob)}u on board)</div>
      <div class="dx-simulate-result__line"><b>Delayed low risk:</b> <span class="badge ${riskBadge}">${result.risk}</span> · watch period: ${escapeHtml(result.watchPeriod)}</div>
      ${carbLine}
      <div class="dx-simulate-result__line">${sourceNote}</div>
    </div>
  `;
}

// Per-session drill-down under the summary stats above — every past
// session of the selected type, with its own before/after glucose and
// basal delivered during the window (see workoutHistoryDetail).
function renderDxWorkoutHistory(rows, workoutType) {
  if (!el.dxWorkoutHistoryList) return;
  if (!rows.length) {
    el.dxWorkoutHistoryList.innerHTML = `<p class="empty-state">No past ${escapeHtml(workoutType)} sessions synced yet.</p>`;
    return;
  }
  el.dxWorkoutHistoryList.innerHTML = `
    <div class="dx-workout-history__title">Previous ${escapeHtml(workoutType)} sessions</div>
    ${rows.map(r => {
      const start = new Date(r.startTime);
      const dateStr = start.toLocaleDateString([], { day: 'numeric', month: 'short' });
      const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="dx-workout-history__row">
          <div class="dx-workout-history__when">
            <span>${dateStr} · ${timeStr}</span>
            <span class="dx-workout-history__dur">${r.durationMin}min</span>
          </div>
          <div class="dx-workout-history__stats">
            <div><span class="dx-workout-history__label">Before</span><span class="dx-workout-history__val">${r.bgBefore != null ? fmt1(r.bgBefore) : '—'}</span></div>
            <div><span class="dx-workout-history__label">After</span><span class="dx-workout-history__val">${r.bgAfter != null ? fmt1(r.bgAfter) : '—'}</span></div>
            <div><span class="dx-workout-history__label">Lowest (4h)</span><span class="dx-workout-history__val">${r.lowestPost4h != null ? fmt1(r.lowestPost4h) : '—'}</span></div>
            <div><span class="dx-workout-history__label">Basal</span><span class="dx-workout-history__val">${r.basalUnits != null ? fmtDose(r.basalUnits) + 'u' : '—'}</span></div>
          </div>
        </div>`;
    }).join('')}
  `;
}

function selectDxSimulatePill(type, durationMin, intensity) {
  dxSimulateSelectedType = type;
  if (el.dxWorkoutImpactDuration) el.dxWorkoutImpactDuration.value = durationMin;
  if (el.dxWorkoutImpactIntensity) el.dxWorkoutImpactIntensity.value = intensity;
  el.dxWorkoutImpactPills?.querySelectorAll('.pill').forEach(p => {
    p.classList.toggle('active', p.dataset.type === type);
  });
}

// Builds the pill row from the actual distinct workout types found across
// both data sources fetchDxWorkouts() merges (own logged strength splits +
// real Apple Watch-detected workouts), most-recently-done first, plus a
// handful of everyday activities Apple Health wouldn't log as a workout
// at all. Falls back to just the generic presets until anything syncs.
async function populateDxWorkoutImpactTypes() {
  if (!el.dxWorkoutImpactPills || !currentUser) return;
  if (profile?.diabetes_enabled === false) return;
  const workouts = await fetchDxWorkouts();
  const lastSeenMs = new Map();
  for (const w of workouts) {
    const type = w.workoutType || 'Other';
    const ms = new Date(w.startTime).getTime();
    if (!Number.isFinite(ms)) continue;
    if (!lastSeenMs.has(type) || ms > lastSeenMs.get(type)) lastSeenMs.set(type, ms);
  }
  const syncedTypes = [...lastSeenMs.keys()].sort((a, b) => lastSeenMs.get(b) - lastSeenMs.get(a));

  const presets = [
    ...syncedTypes.map(type => ({
      type, durationMin: 30,
      intensity: DX_SIMULATE_INTENSITY_CLASS_MAP[DiabetesEngine.classifyIntensity(type)] || 'light',
    })),
    ...DX_SIMULATE_GENERIC_PRESETS,
  ];

  el.dxWorkoutImpactPills.innerHTML = presets.map(p =>
    `<button type="button" class="pill" data-type="${escapeHtml(p.type)}" data-duration="${p.durationMin}" data-intensity="${p.intensity}">${escapeHtml(p.type)}</button>`
  ).join('');

  const keepPrevious = dxWorkoutTypesPopulated && presets.some(p => p.type === dxSimulateSelectedType);
  const chosen = keepPrevious ? presets.find(p => p.type === dxSimulateSelectedType) : presets[0];
  if (chosen) selectDxSimulatePill(chosen.type, chosen.durationMin, chosen.intensity);
  dxWorkoutTypesPopulated = true;
}

el.dxWorkoutImpactPills?.addEventListener('click', e => {
  const btn = e.target.closest('.pill');
  if (!btn) return;
  selectDxSimulatePill(btn.dataset.type, Number(btn.dataset.duration), btn.dataset.intensity);
});

// "Unplug" mode — same card, same duration/intensity/activity-type
// inputs, but simulates a pump disconnect (no basal) instead of a
// normal-basal workout. See estimateUnplugImpact in diabetes-engine.js.
function renderDxUnplugResult(result) {
  if (!el.dxWorkoutImpactBody) return;
  if (result.withheldReason === 'stale-reading' || result.withheldReason === 'no-basal-data') {
    el.dxWorkoutImpactBody.innerHTML = `<p class="empty-state">${escapeHtml(result.staleMessage || 'Not enough data to simulate this yet.')}</p>`;
    if (el.dxWorkoutHistoryList) el.dxWorkoutHistoryList.innerHTML = '';
    return;
  }

  const worseRisk = (result.hyperRisk === 'high' || result.hypoRisk === 'high') ? 'high'
    : (result.hyperRisk === 'medium' || result.hypoRisk === 'medium') ? 'medium' : 'low';
  const riskClass = worseRisk === 'high' ? 'dx-simulate-result--high' : worseRisk === 'medium' ? 'dx-simulate-result--medium' : '';

  const sourceNote = result.source === 'personal'
    ? `Based on ${result.sampleSize} of your own past disconnects of a similar length while ${escapeHtml(result.workoutType)}.`
    : result.source === 'physiological-estimate'
      ? `Estimated from your recent delivered basal rate (${fmt1(result.basalRate)}u/hr) and correction factor, combined with a${result.exerciseDropSource === 'personal' ? ' personal' : ' generic'} exercise-drop estimate — log a couple of real disconnects to personalize this fully.`
      : 'Correction factor not established yet in Settings — this is the exercise-only drop, not accounting for the missed basal.';

  const carbLine = result.carbAdvice?.gramsNeeded > 0
    ? `<div class="dx-simulate-result__line">🍬 ${escapeHtml(result.carbAdvice.message)}</div>`
    : '';
  const bolusLine = result.bolusAdvice
    ? `<div class="dx-simulate-result__line">💉 ${escapeHtml(result.bolusAdvice.message)}</div>`
    : '';
  const rangeText = result.projectedLow === result.projectedHigh
    ? `≤${fmt1(result.projectedLow)}`
    : `${fmt1(result.projectedLow)}–${fmt1(result.projectedHigh)}`;

  const hypoBadge = result.hypoRisk !== 'low' ? `<span class="badge ${result.hypoRisk === 'high' ? 'badge--red' : 'badge--orange'}">low: ${result.hypoRisk}</span>` : '';
  const hyperBadge = result.hyperRisk !== 'low' ? `<span class="badge ${result.hyperRisk === 'high' ? 'badge--red' : 'badge--orange'}">high: ${result.hyperRisk}</span>` : '';
  const riskLine = `<div class="dx-simulate-result__line"><b>Risk:</b> ${hypoBadge || hyperBadge ? `${hypoBadge}${hyperBadge}` : '<span class="badge badge--green">low</span>'}</div>`;

  const missedLine = result.missedUnits > 0
    ? `<div class="dx-simulate-result__line">${fmtDose(result.missedUnits)}u basal missed over ${result.durationMin}min${result.riseFromMissedBasal != null ? ` (~${fmtSigned(result.riseFromMissedBasal, 1)} mmol/L on its own)` : ''}</div>`
    : '';

  el.dxWorkoutImpactBody.innerHTML = `
    <div class="dx-simulate-result ${riskClass}">
      <div class="dx-simulate-result__line"><b>Likely range after:</b> ${rangeText} mmol/L (from ${fmt1(result.currentGlucose)}, ${fmt1(result.iob)}u on board)</div>
      ${riskLine}
      ${missedLine}
      ${bolusLine}
      ${carbLine}
      <div class="dx-simulate-result__line">${sourceNote}</div>
    </div>
  `;

  renderDxUnplugHistory(result.pastEpisodes || []);
}

function renderDxUnplugHistory(episodes) {
  if (!el.dxWorkoutHistoryList) return;
  if (!episodes.length) {
    el.dxWorkoutHistoryList.innerHTML = '<p class="empty-state">No past disconnects detected yet — needs pump data showing basal at ~0 for 10+ min.</p>';
    return;
  }
  el.dxWorkoutHistoryList.innerHTML = `
    <div class="dx-workout-history__title">Past disconnects</div>
    ${episodes.map(e => {
      const start = new Date(e.startMs);
      const dateStr = start.toLocaleDateString([], { day: 'numeric', month: 'short' });
      const timeStr = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <div class="dx-workout-history__row">
          <div class="dx-workout-history__when">
            <span>${dateStr} · ${timeStr}${e.overlapsWorkout ? ` · ${escapeHtml(e.workoutType || 'workout')}` : ' · no workout logged'}</span>
            <span class="dx-workout-history__dur">${e.durationMin}min</span>
          </div>
          <div class="dx-workout-history__stats">
            <div><span class="dx-workout-history__label">Before</span><span class="dx-workout-history__val">${e.bgBefore != null ? fmt1(e.bgBefore) : '—'}</span></div>
            <div><span class="dx-workout-history__label">After</span><span class="dx-workout-history__val">${e.bgAfter != null ? fmt1(e.bgAfter) : '—'}</span></div>
            <div><span class="dx-workout-history__label">Change</span><span class="dx-workout-history__val">${e.bgDelta != null ? fmtSigned(e.bgDelta, 1) : '—'}</span></div>
            <div><span class="dx-workout-history__label">Lowest after</span><span class="dx-workout-history__val">${e.lowestPost != null ? fmt1(e.lowestPost) : '—'}</span></div>
          </div>
        </div>`;
    }).join('')}
  `;
}

el.btnDxWorkoutImpact?.addEventListener('click', async () => {
  if (!el.dxWorkoutImpactBody) return;
  const workoutType = dxSimulateSelectedType || 'Other';
  const durationMin = Number(el.dxWorkoutImpactDuration?.value) || 30;
  const intensity = el.dxWorkoutImpactIntensity?.value || 'light';
  const unplug = !!el.dxUnplugMode?.checked;
  setBtn(el.btnDxWorkoutImpact, true, 'Simulate', 'Simulating…');
  try {
    const data = await fetchDiabetesDataWide();
    if (!data) {
      el.dxWorkoutImpactBody.innerHTML = '<p class="empty-state">Connect Nightscout in Settings to see this.</p>';
      if (el.dxWorkoutHistoryList) el.dxWorkoutHistoryList.innerHTML = '';
      return;
    }
    const [workouts, macroMealLog] = await Promise.all([fetchDxWorkouts(), fetchMacroMealLog()]);
    // Same MFP-supersedes-Nightscout-carbs correction as renderDiabetesTab
    // — a missed/reduced Tandem bolus shouldn't make the "what if I do
    // this workout" projection start from an artificially low COB.
    const carbBoluses = DiabetesEngine.mergeMealCarbsIntoBoluses(data.boluses, macroMealLog);
    const input = { ...data, boluses: carbBoluses, settings: dxSettings(), activities: { workouts } };
    if (unplug) {
      const result = DiabetesEngine.estimateUnplugImpact(input, { workoutType, durationMin, intensity }, Date.now());
      renderDxUnplugResult(result);
    } else {
      const result = DiabetesEngine.workoutSimulate(input, { workoutType, durationMin, intensity }, Date.now());
      renderDxWorkoutSimulateResult(result);
      const history = DiabetesEngine.workoutHistoryDetail(input, workoutType, Date.now());
      renderDxWorkoutHistory(history, workoutType);
    }
  } finally {
    setBtn(el.btnDxWorkoutImpact, false, 'Simulate');
  }
});

function renderDxTodaysMeals(items, boluses) {
  if (!el.dxTodaysMealsCard) return;
  if (!items.length) {
    el.dxTodaysMealsBody.innerHTML = '<p class="empty-state">Nothing logged today yet — log food from the Dashboard and it\'ll show up here to link a dose.</p>';
    return;
  }

  el.dxTodaysMealsBody.innerHTML = items.map(it => {
    const eatenMs = new Date(it.eaten_at).getTime();
    const isMatched = it.match_status === 'auto' || it.match_status === 'manual';
    const isSuggested = it.match_status === 'suggested';
    let suggestedHtml = '';
    let actionHtml;
    if (isMatched) {
      actionHtml = `<span class="badge badge--green">✓ ${fmtDose(it.matched_bolus_units)}u${it.match_status === 'manual' ? ' (linked)' : ''}</span>`;
    } else if (it.hypo_treatment) {
      actionHtml = `<span class="badge badge--blue">Hypo treatment — no bolus needed</span>
        <button class="btn btn--ghost btn--small" data-action="unclassify" data-id="${it.id}" style="margin-left:6px">Not a hypo?</button>`;
    } else if (it.match_status === 'below-target') {
      // Distinct from hypo_treatment: glucose was below target but not
      // actually low enough to be a hypo — a deliberate no-dose call, not
      // "no correction needed because this was basically treating a low."
      // Excluded from dose-learning the same way (see fetchMacroMealLog's
      // actualDose — null whenever match_status is set and there's no
      // matched_bolus_units), so it won't skew "what this meal needs"
      // any more than a hypo-treatment row would.
      actionHtml = `<span class="badge badge--orange">Below target — no dose</span>
        <button class="btn btn--ghost btn--small" data-action="unclassify" data-id="${it.id}" style="margin-left:6px">Not right?</button>`;
    } else {
      // Both a plain 'unmatched' row (couldn't compute a suggestion) and a
      // 'suggested' row (computed one, but the real bolus hasn't shown up
      // in Nightscout to confirm yet) still need the same "link once you've
      // actually dosed" action — a suggestion isn't a substitute for that.
      if (isSuggested) {
        suggestedHtml = `<div style="margin-bottom:6px"><span class="badge badge--orange">Suggested ${fmtDose(it.suggested_units)}u</span>
          ${it.delayed_units > 0 ? `<span class="field-hint" style="margin-left:6px">${fmtDose(it.upfront_units)}u now, ${fmtDose(it.delayed_units)}u delayed</span>` : ''}</div>`;
      }
      // Same-calendar-day used to gate this list, but that silently drops
      // a real bolus given a few minutes on the other side of local
      // midnight from the meal (e.g. meal logged 00:48, dose given
      // 23:58 the "day before") — a pure time-window match, same idea
      // as the server-side auto-matcher's MATCH_WINDOW_MIN in
      // mfp-import.js, has no day-boundary to fall foul of. Kept wider
      // (4h) than that 90min auto-match window since this is a manual
      // fallback for whatever the auto-matcher missed — too narrow here
      // would just recreate the same "why isn't my dose showing" problem.
      // A bolus Nightscout itself tagged with carbs is shown even outside
      // that 4h window too — carbs on a bolus is itself strong evidence
      // it was a meal dose, and a mistimed log entry shouldn't hide it —
      // but that exception still needs SOME bound (same local calendar
      // day as the meal) rather than none at all, or every past bolus
      // that ever carried a carbs figure (nearly all of them) shows up
      // in the picker regardless of how long ago it was.
      const NEARBY_BOLUS_WINDOW_MS = 4 * 3600000;
      const mealDayStr = new Date(eatenMs).toDateString();
      const nearbyBoluses = boluses.filter(b => {
        if (Number(b.units) <= 0) return false;
        const bTimeMs = Number(b.time);
        if (Math.abs(bTimeMs - eatenMs) <= NEARBY_BOLUS_WINDOW_MS) return true;
        return Number(b.carbs) > 0 && new Date(bTimeMs).toDateString() === mealDayStr;
      });
      actionHtml = `
        <select data-role="mfp-bolus-pick" data-id="${it.id}">
          <option value="">Link the actual dose…</option>
          ${nearbyBoluses.map(b => `<option value="${b.time}|${b.units}">${new Date(Number(b.time)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${fmtDose(b.units)}u${Number(b.carbs) > 0 ? ` (${fmt1(b.carbs)}g carbs)` : ''}</option>`).join('')}
        </select>
        <button class="btn btn--ghost btn--small" data-action="link" data-id="${it.id}">Link</button>
        <button class="btn btn--ghost btn--small" data-action="hypo" data-id="${it.id}">Mark hypo</button>
        <button class="btn btn--ghost btn--small" data-action="below-target" data-id="${it.id}">Below target, no dose</button>`;
    }
    // Meal-grouped imports encode "Section — ingredient, ingredient, …"
    // in meal_name (from legacy MFP-import rows) — split that into a bold
    // section title plus an ingredient sub-line. Older per-ingredient
    // rows (imported before grouping) have no dash and just show as-is;
    // meal_name can also be null on very old rows, hence the fallback.
    const mealName = it.meal_name || 'Meal';
    const dashIdx = mealName.indexOf('—');
    const title = dashIdx >= 0 ? mealName.slice(0, dashIdx).trim() : mealName;
    const ingredients = dashIdx >= 0 ? mealName.slice(dashIdx + 1).trim() : '';
    return `
      <div class="dx-dose-item">
        <div class="dx-dose-item__head">
          <strong>${escapeHtml(title)}</strong>
          <span class="field-hint">${fmt1(it.carbs_g)}g carbs · ${new Date(eatenMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        ${ingredients ? `<div class="field-hint" style="margin-top:2px">${escapeHtml(ingredients)}</div>` : ''}
        ${suggestedHtml}
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">${actionHtml}</div>
      </div>`;
  }).join('');
}

el.dxTodaysMealsBody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !currentUser) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  let updates = null;
  if (action === 'link') {
    const select = el.dxTodaysMealsBody.querySelector(`select[data-id="${id}"]`);
    const val = select?.value;
    if (!val) { showToast('Pick a dose first', true); return; }
    const [time, units] = val.split('|');
    updates = {
      matched_bolus_time: new Date(Number(time)).toISOString(),
      matched_bolus_units: Number(units),
      match_status: 'manual',
      hypo_treatment: false,
    };
  } else if (action === 'hypo') {
    updates = { match_status: 'hypo-manual', hypo_treatment: true };
  } else if (action === 'below-target') {
    updates = { match_status: 'below-target', hypo_treatment: false };
  } else if (action === 'unclassify') {
    updates = { match_status: 'unmatched', hypo_treatment: false };
  }
  if (!updates) return;

  const { error } = await db.from('diabetes_meals').update(updates).eq('id', id).eq('user_id', currentUser.id);
  if (error) { showToast('Failed: ' + error.message, true); return; }

  const [todaysMeals, data] = await Promise.all([fetchTodaysDxMeals(), fetchDiabetesData()]);
  renderDxTodaysMeals(todaysMeals, data?.boluses || []);
});

// Meal memory (the "stayed in range"/"ran high"/"ran low" dose-rated
// grouped-by-meal-name card) was removed in favor of the Today's meals
// card above — with native food logging + same-day bolus linking, a
// running review list matters more here than a long-run per-meal-name
// history. DiabetesEngine.mealMemory() itself is left intact in
// diabetes-engine.js in case something else wants it later; it's just
// no longer called or rendered from here.

function renderDxSensitivity(cells, prescribed) {
  const withData = cells.filter(c => c.n > 0);
  if (!withData.length && !prescribed) {
    el.dxSensitivityBody.innerHTML = '<p class="empty-state">Not enough clean corrections yet to map this out.</p>';
    return;
  }
  el.dxSensitivityBody.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Time of day</th>${prescribed ? '<th>Prescribed</th>' : ''}<th>Rest</th><th>Post-exercise</th></tr></thead>
        <tbody>
          ${['Night (00-06)', 'Morning (06-12)', 'Afternoon (12-18)', 'Evening (18-24)'].map(tod => {
            const rest = cells.find(c => c.timeOfDay === tod && c.context === 'rest');
            const ex   = cells.find(c => c.timeOfDay === tod && c.context === 'post-exercise');
            const rx   = prescribed?.find(p => p.timeOfDay === tod);
            const fmtCell = c => c && c.n > 0 ? `${fmt1(c.avgDropPerUnit)} (n=${c.n})` : '—';
            const rxCell = rx?.correctionFactor != null ? `${fmt1(rx.correctionFactor)}` : '—';
            return `<tr><td>${tod}</td>${prescribed ? `<td>${rxCell}</td>` : ''}<td>${fmtCell(rest)}</td><td>${fmtCell(ex)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${prescribed ? '<p class="dx-note">Prescribed = your pump\'s programmed correction factor for that window (mmol/L per unit); Rest/Post-exercise are what\'s actually been observed.</p>' : ''}
  `;
}

// One cell = current value (prescribed pump setting if known, else
// whatever reference number the review itself observed) plus a
// suggested new value when the data actually supports one — never just
// the suggestion alone, since "current" is what anchors the % change
// and capped-at-limit context that make the number trustworthy rather
// than a bare "try 0.75u/hr" floating with no reference point.
// Current (pump-prescribed/observed) and suggested (this week's analysis)
// as two separate cells, not one merged "a → b" cell — makes it clear
// which number is what's actually programmed into the pump right now vs.
// what the analysis is proposing, rather than requiring a read of the
// column footnote to know which side of the arrow is which.
function dxRegimenCurrentCell(current, unit) {
  return current != null ? `${fmt1(current)}${unit}` : '<span class="dx-regimen-cell--empty">—</span>';
}
function dxRegimenSuggestedCell(current, suggested, unit, n, capped) {
  if (suggested == null) return '<span class="dx-regimen-cell--empty">—</span>';
  const changed = current != null && Math.abs(suggested - current) > 0.001;
  const val = changed ? `<b>${fmt1(suggested)}</b>` : fmt1(suggested);
  return `${val}${unit}<span class="dx-regimen-cell__n">n=${n}${capped ? ', capped' : ''}</span>`;
}

// Nightscout's own profile-switch documents carry whatever name the pump
// gave them ("Mo", "Thur", ...) — map that to the matching segment array
// in Supabase's diabetes_pump_profile (keyed 'default' / 'thu') and to a
// short human label. Anything unrecognized falls back to 'default'
// segments (best available comparison) under its own raw name.
function dxProfileLabel(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'default') return 'Your profile';
  if (n.startsWith('thu')) return 'Exercise / Thur profile';
  if (n.startsWith('mo')) return 'Default (Mo) profile';
  return name;
}
function dxProfileSegments(pumpProfile, name) {
  const n = String(name || '').toLowerCase();
  return (n.startsWith('thu') ? pumpProfile?.thu : pumpProfile?.default) || null;
}

function renderDxRegimen(regimenByProfile, pumpProfile, hasThuProfile) {
  const profiles = regimenByProfile?.profiles || [];
  if (!profiles.length) {
    el.dxRegimenBody.innerHTML = '<p class="empty-state">Not enough clean data yet this week to suggest a profile by time block.</p>';
    return;
  }

  // Single 'default' bucket means no profile-switch history was found at
  // all (older sync, or a Nightscout feed that's never switched) — same
  // pooled behavior as before, so the Thursdays-run-differently caveat
  // still belongs on that one table.
  const singlePooled = profiles.length === 1 && profiles[0] === 'default';

  const sections = profiles.map(name => {
    const regimen = regimenByProfile.byProfile[name];
    const segments = dxProfileSegments(pumpProfile, name);
    const prescribed = segments ? DiabetesEngine.prescribedRegimenTable({ default: segments }) : null;
    const note = singlePooled && hasThuProfile ? ', weekday default — Thursdays run a different profile' : '';
    return dxRegimenProfileSection(profiles.length > 1 ? dxProfileLabel(name) : null, regimen, prescribed, note);
  });

  el.dxRegimenBody.innerHTML = sections.join('');
}

function dxRegimenProfileSection(label, regimen, prescribed, prescribedNote) {
  const basalByWindow = regimen.basalByWindow || [];
  const cfByWindow = regimen.correctionFactorByWindow || [];
  const crByWindow = regimen.carbRatioByWindow || [];
  const wholeWeekRatio = regimen.carbRatio;

  const heading = label ? `<div class="dx-section-label">${escapeHtml(label)}</div>` : '';

  const anyBlockSignal = [...basalByWindow, ...cfByWindow, ...crByWindow].some(w => !w.withheldReason);
  if (!anyBlockSignal && !prescribed) {
    return `${heading}<p class="empty-state">Not enough clean data yet under this profile to suggest a change by time block.</p>`;
  }

  const rows = basalByWindow.map((b, i) => {
    const cf = cfByWindow[i];
    const cr = crByWindow[i];
    const rx = prescribed?.find(p => p.timeOfDay === b.timeOfDay);

    const basalCurrent = rx?.basalRate ?? b.avgBasalRate ?? null;
    const basalSuggested = b.withheldReason ? null : b.suggestedBasalRate;

    const cfCurrent = rx?.correctionFactor ?? cf?.currentFactor ?? null;
    const cfSuggested = cf?.withheldReason ? null : cf?.suggestedFactor;

    const crCurrent = rx?.carbRatio ?? cr?.currentRatio ?? null;
    const crSuggested = cr?.withheldReason ? null : cr?.suggestedRatio;

    return `<tr>
      <td>${escapeHtml(b.timeOfDay)}</td>
      <td>${dxRegimenCurrentCell(basalCurrent, 'u/hr')}</td>
      <td>${dxRegimenSuggestedCell(basalCurrent, basalSuggested, 'u/hr', b.n, b.cappedAtLimit)}</td>
      <td>${dxRegimenCurrentCell(cfCurrent, '')}</td>
      <td>${dxRegimenSuggestedCell(cfCurrent, cfSuggested, '', cf?.n, cf?.cappedAtLimit)}</td>
      <td>${dxRegimenCurrentCell(crCurrent, 'g/u')}</td>
      <td>${dxRegimenSuggestedCell(crCurrent, crSuggested, 'g/u', cr?.n, cr?.cappedAtLimit)}</td>
    </tr>`;
  }).join('');

  const table = `
    <div class="table-wrap">
      <table class="data-table dx-regimen-table">
        <thead>
          <tr>
            <th rowspan="2">Time block</th>
            <th colspan="2" class="dx-regimen-thead-group">Basal</th>
            <th colspan="2" class="dx-regimen-thead-group">Correction factor</th>
            <th colspan="2" class="dx-regimen-thead-group">Carb ratio</th>
          </tr>
          <tr>
            <th class="dx-regimen-subhead">Current</th>
            <th class="dx-regimen-subhead">Suggested</th>
            <th class="dx-regimen-subhead">Current</th>
            <th class="dx-regimen-subhead">Suggested</th>
            <th class="dx-regimen-subhead">Current</th>
            <th class="dx-regimen-subhead">Suggested</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="dx-note">Current is${prescribed ? ` your prescribed pump profile${prescribedNote}` : ' this week’s observed value'}; Suggested is Claude's analysis of this week's data, when there's a clean enough signal to propose a change — bold means a change from Current. A block showing "—" under Suggested means not enough clean data yet.</p>`;

  // Whole-week carb-ratio fallback — meals are sparse enough that most
  // individual 3h blocks won't clear the sample-size floor even on a
  // week with a real, consistent bias; the pooled weekly check can still
  // say something useful when nothing localized to a single block did.
  const wholeWeekNote = (wholeWeekRatio && !wholeWeekRatio.withheldReason && !crByWindow.some(c => !c.withheldReason)) ? `
    <div class="dx-insight">
      <div class="dx-insight__head">
        <span class="badge badge--orange">${wholeWeekRatio.direction === 'tighten' ? 'Consider tightening' : 'Consider loosening'}</span>
        <span class="dx-insight__n">n=${wholeWeekRatio.n}</span>
      </div>
      <div class="dx-insight__title">Carb ratio overall: ${fmt1(wholeWeekRatio.currentRatio)} → ${fmt1(wholeWeekRatio.suggestedRatio)} g/u${wholeWeekRatio.cappedAtLimit ? ' (capped)' : ''}</div>
      <div class="dx-insight__summary">Meals have ${wholeWeekRatio.direction === 'tighten' ? 'run high' : 'gone low'} ${wholeWeekRatio.n} time${wholeWeekRatio.n === 1 ? '' : 's'} this week overall — not enough meals in any single 3h block to localize this further.</div>
    </div>` : '';

  return heading + table + wholeWeekNote;
}

/* ═══════════════════════════════════════════════════════════
   PWA — Service Worker + Push Notifications
═══════════════════════════════════════════════════════════ */

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      console.log('SW registered:', reg.scope);
    }).catch(err => console.warn('SW registration failed:', err));
  });
}

// Convert VAPID public key to Uint8Array for PushManager
function vapidKeyToUint8Array(base64String) {
  const pad = base64String.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(pad);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// Subscribe this device to push notifications and save to Supabase
async function subscribeToPush() {
  if (!('PushManager' in window)) return; // browser doesn't support push
  if (!currentUser) return;

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    // A subscription is cryptographically bound to whatever
    // applicationServerKey it was created with — if VAPID_PUBLIC above
    // ever changes (e.g. after the key mismatch that made every push
    // silently fail until fixed on 2026-07-24), an existing subscription
    // doesn't just stop working, it becomes permanently invalid, and
    // getSubscription() keeps handing back that same dead one forever
    // since it doesn't know or care whether it still matches the current
    // key. Compare byte-for-byte and force a fresh subscription on any
    // mismatch instead of trusting "a subscription exists" to mean
    // "the right subscription exists".
    if (sub) {
      const currentKey = vapidKeyToUint8Array(VAPID_PUBLIC);
      const existingKey = new Uint8Array(sub.options?.applicationServerKey || []);
      const matches = existingKey.length === currentKey.length &&
        existingKey.every((b, i) => b === currentKey[i]);
      if (!matches) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
    }

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKeyToUint8Array(VAPID_PUBLIC),
      });
    }

    const subJson = sub.toJSON();

    // Save subscription to Supabase (upsert by endpoint)
    await db.from('push_subscriptions').upsert({
      user_id:    currentUser.id,
      endpoint:   subJson.endpoint,
      p256dh:     subJson.keys.p256dh,
      auth_key:   subJson.keys.auth,
      user_agent: navigator.userAgent.slice(0, 200),
    }, { onConflict: 'user_id,endpoint' });

    console.log('Push subscription saved');
  } catch (err) {
    // User denied permission or browser issue — silent fail
    console.warn('Push subscription failed:', err.message);
  }
}

// Ask for notification permission after login (with a small delay so UI is settled)
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    await subscribeToPush();
    return;
  }
  if (Notification.permission === 'denied') return;

  // Wait 2s after login before prompting — less jarring
  setTimeout(async () => {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') await subscribeToPush();
  }, 2000);
}

/* ═══════════════════════════════════════════════════════════
   DETECTED ACTIVITY — health-sync.js flags a burst of elevated heart
   rate + dense steps Apple Health never logged as a Workout (see
   detectUndetectedActivity() there) as a pending row here. Checked on
   every app open; confirming writes a real apple_health_workouts row
   (workout_type "Walking"), indistinguishable downstream from a real
   Apple Watch-detected workout — feeds Strain, the Diabetes tab's
   workout-impact analysis, "Last workout", all of it. Never auto-
   logged — this popup is the only path a detection can actually land.
   ═══════════════════════════════════════════════════════════ */
let dxDetectedQueue = [];

async function checkDetectedActivities() {
  if (!currentUser) return;
  const { data, error } = await db.from('detected_activities')
    .select('id, started_at, ended_at, duration_min, avg_heart_rate, max_heart_rate, steps, active_energy_kcal')
    .eq('user_id', currentUser.id)
    .eq('status', 'pending')
    .order('started_at', { ascending: true });
  if (error) { console.error('checkDetectedActivities error:', error.message); return; }
  dxDetectedQueue = data || [];
  if (dxDetectedQueue.length) showDetectedActivityPopup();
}

function showDetectedActivityPopup() {
  const activity = dxDetectedQueue[0];
  if (!activity || !el.detectedActivityModal) return;
  const start = new Date(activity.started_at);
  const when = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dayLabel = start.toDateString() === new Date().toDateString() ? 'Today' : start.toLocaleDateString(undefined, { weekday: 'long' });
  const bits = [`${dayLabel} at ${when}`, `~${Math.round(activity.duration_min)} min`];
  if (activity.avg_heart_rate != null) bits.push(`avg ${Math.round(activity.avg_heart_rate)}bpm`);
  if (activity.steps != null) bits.push(`~${activity.steps.toLocaleString()} steps`);
  if (activity.active_energy_kcal != null) bits.push(`~${Math.round(activity.active_energy_kcal)} kcal (estimated)`);
  if (el.detectedActivityDesc) {
    el.detectedActivityDesc.textContent = `Looks like a walk — ${bits.join(', ')}. Apple Health didn't log this as a workout. Add it?`;
  }
  if (el.detectedActivityQueueNote) {
    const more = dxDetectedQueue.length - 1;
    el.detectedActivityQueueNote.hidden = more <= 0;
    el.detectedActivityQueueNote.textContent = more > 0 ? `${more} more waiting after this one.` : '';
  }
  el.detectedActivityModal.hidden = false;
}

function closeDetectedActivityPopup() {
  if (el.detectedActivityModal) el.detectedActivityModal.hidden = true;
}

function advanceDetectedActivityQueue() {
  dxDetectedQueue.shift();
  if (dxDetectedQueue.length) showDetectedActivityPopup();
  else closeDetectedActivityPopup();
}

el.btnDetectedActivityConfirm?.addEventListener('click', async () => {
  const activity = dxDetectedQueue[0];
  if (!activity || !currentUser) return;
  setBtn(el.btnDetectedActivityConfirm, true, 'Log as workout', 'Saving…');
  try {
    const { error: insertErr } = await db.from('apple_health_workouts').insert({
      user_id: currentUser.id,
      external_id: `detected-${activity.id}`,
      workout_type: 'Walking',
      started_at: activity.started_at,
      ended_at: activity.ended_at,
      duration_min: activity.duration_min,
      avg_heart_rate: activity.avg_heart_rate,
      max_heart_rate: activity.max_heart_rate,
      active_energy_kcal: activity.active_energy_kcal,
    });
    if (insertErr) { showToast("Couldn't log it: " + insertErr.message, true); return; }
    await db.from('detected_activities').update({ status: 'confirmed' }).eq('id', activity.id);
    showToast('Logged as a walk.');
    advanceDetectedActivityQueue();
    // Refresh anything already on screen that a new workout would affect
    // (Strain, "Last workout") — harmless no-op if some other tab is open.
    if (el.viewDashboard && !el.viewDashboard.hidden) loadDashboard();
  } finally {
    setBtn(el.btnDetectedActivityConfirm, false, 'Log as workout');
  }
});

async function ignoreDetectedActivity() {
  const activity = dxDetectedQueue[0];
  if (!activity || !currentUser) return;
  await db.from('detected_activities').update({ status: 'dismissed' }).eq('id', activity.id);
  advanceDetectedActivityQueue();
}
el.btnDetectedActivityIgnore?.addEventListener('click', ignoreDetectedActivity);
el.detectedActivityClose?.addEventListener('click', ignoreDetectedActivity);

/* ═══════════════════════════════════════════════════════════
   METRIC DETAIL SHEET
═══════════════════════════════════════════════════════════ */
/* ── VO2 Max → Fitness Age conversion (ACSM male norms) ─── */
function vo2ToFitnessAge(vo2) {
  if (vo2 == null) return null;
  if      (vo2 >= 54) return 20;
  else if (vo2 >= 51) return 22;
  else if (vo2 >= 48) return 24;
  else if (vo2 >= 46) return 26;
  else if (vo2 >= 44) return 28;
  else if (vo2 >= 42) return 32;
  else if (vo2 >= 40) return 36;
  else if (vo2 >= 38) return 40;
  else if (vo2 >= 36) return 44;
  else if (vo2 >= 34) return 48;
  else if (vo2 >= 32) return 52;
  else if (vo2 >= 29) return 57;
  else if (vo2 >= 26) return 62;
  else return 65;
}

// polarity decides which extreme (min or max over the 30-day window)
// gets labelled "Best" vs "Worst" in the sheet below:
//   'higher' — bigger numbers are healthier (VO2 Max, SpO2)
//   'lower'  — smaller numbers are healthier (average HR, fitness age)
//   'neutral' — this metric doesn't have a "more is healthier" direction
//     at all; it's a stay-in-range/homeostasis reading (respiratory
//     rate, wrist temp deviation from baseline, blood glucose), so the
//     extremes are shown as plain "Highest"/"Lowest" instead of
//     "Best"/"Worst" — calling someone's lowest blood glucose reading
//     their "best" would mislabel a hypo as a good result.
const METRIC_CONFIG = {
  spo2:       { icon:'🫁', title:'Blood Oxygen (SpO2)',  unit:'%',         field:'spo2_avg',         format: v => fmt1(v),    label:'SpO2',        color:'#16A34A', min:90, max:100, polarity:'higher' },
  resp:       { icon:'💨', title:'Respiratory Rate',     unit:'brpm',      field:'respiratory_rate', format: v => fmt1(v),    label:'Resp rate',   color:'#3B7FF5', min:10, max:25,  polarity:'neutral' },
  temp:       { icon:'🌡️', title:'Wrist Temperature',    unit:'°C dev',    field:'wrist_temp_dev',   format: v => (v>0?'+':'')+fmt1(v), label:'Wrist temp', color:'#7C3AED', polarity:'neutral' },
  vo2:        { icon:'❤️‍🔥', title:'VO2 Max',           unit:'mL/kg/min', field:'vo2_max',           format: v => fmt1(v),    label:'VO2 Max',     color:'#7C3AED', polarity:'higher' },
  hr:         { icon:'❤️', title:'Average Heart Rate',      unit:'bpm',       field:'heart_rate_avg',    format: v => fmtInt(v),  label:'Avg HR',      color:'#DC2626', polarity:'lower' },
  glucose:    { icon:'🩸', title:'Blood Glucose',         unit:'mmol/L',    field:'glucose_avg_mmol', format: v => fmt1(v),    label:'Glucose',     color:'#DC2626', min:3,  max:12,  polarity:'neutral' },
  fitnessAge: { icon:'🧬', title:'Fitness Age (VO2 Max)','unit':'years',   field:'vo2_max',           format: v => String(vo2ToFitnessAge(v) ?? '—'), label:'Fitness age', color:'#7C3AED', min:20, max:65, polarity:'lower' },
};

// Wire health tile clicks
document.addEventListener('click', e => {
  const tile = e.target.closest('.health-tile[id]');
  if (!tile) return;
  const key = tile.id.replace('tile', '').replace(/^./, c => c.toLowerCase());
  const cfg = METRIC_CONFIG[key];
  if (cfg) openMetricSheet(key, cfg);
});

// Close sheet — tap ✕ button OR tap backdrop outside the sheet panel
document.addEventListener('click', e => {
  if (e.target.closest('#metricSheetClose')) {
    closeMetricSheet();
    return;
  }
  // Tapping backdrop (metricSheet div) but NOT the inner sheet panel
  const backdrop = $('metricSheet');
  if (backdrop && !backdrop.hidden && e.target.closest('#metricSheet') && !e.target.closest('.bottom-sheet')) {
    closeMetricSheet();
  }
});

// Also close on swipe down
(function() {
  let startY = 0;
  document.addEventListener('touchstart', e => {
    const sheet = $('metricSheet');
    if (sheet && !sheet.hidden && e.target.closest('.bottom-sheet')) {
      startY = e.touches[0].clientY;
    }
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const sheet = $('metricSheet');
    if (sheet && !sheet.hidden && e.target.closest('.bottom-sheet')) {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 80) closeMetricSheet(); // swiped down 80px+
    }
  }, { passive: true });
})();

function closeMetricSheet() {
  const sheet = $('metricSheet');
  if (sheet) sheet.hidden = true;
}

async function openMetricSheet(key, cfg) {
  if (!currentUser || !db) return;
  const sheet = $('metricSheet');
  if (!sheet) return;

  sheet.hidden = false;

  $('metricSheetIcon').textContent      = cfg.icon;
  $('metricSheetTitle').textContent     = cfg.title;
  $('metricSheetSub').textContent       = 'Last 30 days';
  $('metricSheetColHeader').textContent = cfg.label + ' (' + cfg.unit + ')';
  $('metricSheetStats').innerHTML       = '<div class="metric-stat"><div class="metric-stat__label">Loading…</div></div>';
  $('metricSheetTableBody').innerHTML   = '';
  $('metricSheetEmpty').hidden          = true;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const { data, error } = await db
    .from('health_daily')
    .select(`log_date, ${cfg.field}`)
    .eq('user_id', currentUser.id)
    .gte('log_date', thirtyDaysAgo)
    .order('log_date', { ascending: true });

  if (error) {
    $('metricSheetStats').innerHTML = `<div class="metric-stat"><div class="metric-stat__label" style="color:var(--red)">Error: ${error.message}</div></div>`;
    return;
  }

  const rows = (data || []).filter(r => r[cfg.field] != null);

  if (!rows.length) {
    $('metricSheetStats').innerHTML = '<div class="metric-stat"><div class="metric-stat__label">No data in last 30 days</div></div>';
    $('metricSheetEmpty').hidden = false;
    $('metricSheetTableBody').innerHTML = '';
    return;
  }

  const vals   = rows.map(r => cfg.field === 'vo2_max' && key === 'fitnessAge'
    ? vo2ToFitnessAge(Number(r[cfg.field]))
    : Number(r[cfg.field])
  ).filter(v => v != null);

  const latest  = vals[vals.length - 1];
  const avg     = vals.reduce((a, b) => a + b, 0) / vals.length;
  const minVal  = Math.min(...vals);
  const maxVal  = Math.max(...vals);

  // See METRIC_CONFIG's polarity comment — which extreme is "Best" flips
  // per metric, and metrics with no real best/worst direction (glucose,
  // resp rate, wrist temp) get neutral "Highest"/"Lowest" labels instead.
  const lowerIsBest = cfg.polarity === 'lower';
  const bestVal    = lowerIsBest ? minVal : maxVal;
  const worstVal   = lowerIsBest ? maxVal : minVal;
  const bestLabel  = cfg.polarity === 'neutral' ? 'Highest' : 'Best';
  const worstLabel = cfg.polarity === 'neutral' ? 'Lowest'  : 'Worst';

  $('metricSheetStats').innerHTML = `
    <div class="metric-stat">
      <span class="metric-stat__label">Latest</span>
      <span class="metric-stat__val">${cfg.format(key === 'fitnessAge' ? latest : Number(rows[rows.length-1][cfg.field]))}</span>
      <span class="metric-stat__unit">${cfg.unit}</span>
    </div>
    <div class="metric-stat">
      <span class="metric-stat__label">30d avg</span>
      <span class="metric-stat__val">${cfg.format(key === 'fitnessAge' ? Math.round(avg) : avg)}</span>
      <span class="metric-stat__unit">${cfg.unit}</span>
    </div>
    <div class="metric-stat">
      <span class="metric-stat__label">${bestLabel}</span>
      <span class="metric-stat__val">${cfg.format(bestVal)}</span>
      <span class="metric-stat__unit">${cfg.unit}</span>
    </div>
    <div class="metric-stat">
      <span class="metric-stat__label">${worstLabel}</span>
      <span class="metric-stat__val">${cfg.format(worstVal)}</span>
      <span class="metric-stat__unit">${cfg.unit}</span>
    </div>`;

  // Chart
  if ($('metricSheetChart')) {
    drawSparkline('metricSheetChart', vals, {
      stroke:     cfg.color || 'var(--blue)',
      fillTop:    (cfg.color || '#3B7FF5') + '33',
      fillBottom: (cfg.color || '#3B7FF5') + '00',
      min: cfg.min,
      max: cfg.max,
    });
  }

  // Table — most recent first
  const reversedRows = [...rows].reverse();
  $('metricSheetTableBody').innerHTML = reversedRows.map(r => {
    const rawVal = Number(r[cfg.field]);
    const display = cfg.format(rawVal);
    return `<tr>
      <td>${fmtDate(r.log_date)}</td>
      <td style="font-weight:600">${display} <span style="font-size:11px;color:var(--ink-4);font-weight:400">${cfg.unit}</span></td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   NATIVE HEALTHKIT SYNC
   Reads Apple Health directly via @capgo/capacitor-health, replacing the
   third-party Health Auto Export app. No bundler in this project (app.js
   loads as a plain <script>), so the plugin isn't imported — Capacitor's
   native bridge exposes it as window.Capacitor.Plugins.Health once the
   app is running inside the native shell; on web every method but
   isAvailable() throws, so every call here is native-gated.

   Writes straight to health_daily/apple_health_workouts via the same
   RLS-scoped `db` client the rest of the app already uses for those
   tables (see the manual health-entry upsert and detected-activity
   insert above) — no backend function involved.
═══════════════════════════════════════════════════════════ */

const HEALTHKIT_READ_TYPES = [
  'steps', 'distance', 'calories', 'basalCalories', 'dietaryEnergyConsumed',
  'heartRate', 'restingHeartRate', 'weight', 'bodyFat', 'heartRateVariability',
  'respiratoryRate', 'oxygenSaturation', 'vo2Max', 'appleSleepingWristTemperature',
  'exerciseTime', 'sleep', 'workouts',
];
// Weight is the only thing this app ever writes back to Health — every
// other type here is read-only, sourced FROM Health.
const HEALTHKIT_WRITE_TYPES = ['weight'];

function healthKitAvailable() { return !!window.Capacitor?.isNativePlatform?.(); }

function getHealthPlugin() {
  const Health = window.Capacitor?.Plugins?.Health;
  if (!Health) throw new Error('HealthKit is not available on this platform');
  return Health;
}

async function requestHealthKitAuth() {
  // On iOS, HealthKit never reveals whether a READ type was actually
  // granted or denied (a deliberate Apple privacy restriction — only
  // WRITE-type authorization is inspectable) — readAuthorized here just
  // means "the permission sheet has been resolved for this type", not
  // "granted". A denied read type silently returns empty data rather
  // than erroring, so there's nothing further to gate on here.
  return getHealthPlugin().requestAuthorization({ read: HEALTHKIT_READ_TYPES, write: HEALTHKIT_WRITE_TYPES });
}

// Best-effort write-back to Health for a weight the user just entered in
// fitl00p — gated on the same "Built-in Health sync" toggle as the read
// path, rather than a separate switch, since this app only ever writes
// this one data type and it's the natural complement to reading the rest
// from Health. startDate uses noon local on the log's own date (not
// "now") so a backdated weigh-in lands on the right day in Health rather
// than today's — same noon-anchor trick used elsewhere in this codebase
// to dodge a DST-related day-shift.
async function writeWeightToHealthKit(weightKg, logDateStr) {
  if (!healthKitAvailable() || !profile?.healthkit_sync_enabled) {
    // console.warn (not silent return) — mirrored to error_logs, same as
    // the success/failure cases below, so a skip here is distinguishable
    // from the call never happening at all.
    console.warn('HealthKit weight write-back skipped — native:', healthKitAvailable(), 'toggle on:', !!profile?.healthkit_sync_enabled);
    return;
  }
  try {
    const startDate = new Date(`${logDateStr}T12:00:00`).toISOString();
    await getHealthPlugin().saveSample({ dataType: 'weight', value: weightKg, startDate });
    console.warn('HealthKit weight write-back succeeded:', weightKg, 'kg at', startDate); // mirrored to error_logs — see installErrorLogging()
  } catch (err) {
    console.error('HealthKit weight write-back failed:', err); // mirrored to error_logs — see installErrorLogging()
  }
}

function hkRound1(n) { return Math.round(n * 10) / 10; }
function hkRound2(n) { return Math.round(n * 100) / 100; }

// HealthKit's own 'day' bucketing (and every sample's own startDate) is
// anchored to the device's LOCAL calendar day, not UTC — bucket-start for
// local midnight 16 Sep BST is "2026-09-15T23:00:00.000Z", so slicing
// that string's first 10 characters silently gives back the 15th, not
// the 16th, for the whole 1-hour-per-year (well, per DST transition)
// this app is ever running in BST. new Date(input) preserves the exact
// instant regardless of what string form HealthKit handed back; the
// non-UTC getters below then read it out in the RUNTIME's own local
// timezone — the device's — which is exactly the calendar HealthKit
// itself used to decide which day this sample/bucket belongs to.
// Confirmed live: this was shifting every aggregated metric (steps,
// active energy, dietary energy, heart rate, resting HR, weight) one
// day early for the whole BST half of the year.
function hkLocalDateStr(input) {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hkByDay(samples) {
  const byDate = {};
  for (const s of samples) {
    const d = hkLocalDateStr(s.startDate);
    if (!d) continue;
    (byDate[d] = byDate[d] || []).push(s);
  }
  return byDate;
}
function hkSum(samples) { return samples.reduce((a, s) => a + (Number(s.value) || 0), 0); }
function hkAvg(samples) { return samples.length ? hkSum(samples) / samples.length : null; }

async function hkAggregatedByDay(dataType, startISO, endISO, aggregation) {
  const { samples } = await getHealthPlugin().queryAggregated({ dataType, startDate: startISO, endDate: endISO, bucket: 'day', aggregation });
  const out = {};
  for (const s of samples || []) {
    const d = hkLocalDateStr(s.startDate);
    if (d) out[d] = s.value;
  }
  return out;
}

// readSamples() has no built-in pagination for a date-range query — a
// generous limit is used instead of paging, since even the busiest of
// these types (HRV, respiratory rate, SpO2 — a few samples/day) stays
// far under it across the 7-30 day windows this app ever syncs.
async function hkReadAll(dataType, startISO, endISO) {
  const { samples } = await getHealthPlugin().readSamples({ dataType, startDate: startISO, endDate: endISO, limit: 5000, ascending: true });
  return samples || [];
}

// Raw HealthKit sleep data is many small per-stage segments (inBed/
// asleep/awake/rem/deep/light — HealthKit's own "core" stage is
// reported as 'light' by this plugin), not one row per night. Groups
// contiguous segments (gap < 90 min) into sessions and attributes each
// whole session to the calendar date of its LAST segment (the wake-up
// date), matching how "last night's sleep" is normally reported.
function hkSleepSessionsByWakeDate(samples) {
  const sorted = [...samples].sort((a, b) => (a.startDate || '').localeCompare(b.startDate || ''));
  const GAP_MS = 90 * 60000;
  const sessions = [];
  let cur = null;
  for (const s of sorted) {
    const startMs = new Date(s.startDate).getTime();
    const endMs = new Date(s.endDate || s.startDate).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (cur && startMs - cur.lastEndMs <= GAP_MS) {
      cur.segments.push(s);
      cur.lastEndMs = Math.max(cur.lastEndMs, endMs);
    } else {
      cur = { segments: [s], lastEndMs: endMs };
      sessions.push(cur);
    }
  }

  const byWakeDate = {};
  for (const session of sessions) {
    const segs = session.segments;
    const asleepSegs = segs.filter(s => s.sleepState && s.sleepState !== 'inBed' && s.sleepState !== 'awake');
    if (!asleepSegs.length) continue;
    const wakeDate = hkLocalDateStr(Math.max(...segs.map(s => new Date(s.endDate || s.startDate).getTime())));
    const hrsOf = state => asleepSegs.filter(s => s.sleepState === state).reduce((a, s) => a + (Number(s.value) || 0), 0) / 60;
    byWakeDate[wakeDate] = {
      sleep_total_hrs: hkRound2(asleepSegs.reduce((a, s) => a + (Number(s.value) || 0), 0) / 60),
      sleep_deep_hrs:  hkRound2(hrsOf('deep')),
      sleep_rem_hrs:   hkRound2(hrsOf('rem')),
      sleep_core_hrs:  hkRound2(hrsOf('light')),
      sleep_start: segs.reduce((a, s) => a.startDate < s.startDate ? a : s, segs[0]).startDate,
      sleep_end:   segs.reduce((a, s) => (a.endDate || a.startDate) > (s.endDate || s.startDate) ? a : s, segs[0]).endDate,
    };
  }
  return byWakeDate;
}

async function hkSyncWorkouts(startISO, endISO) {
  const { workouts } = await getHealthPlugin().queryWorkouts({ startDate: startISO, endDate: endISO, limit: 200 });
  const rows = [];
  for (const w of workouts || []) {
    // The plugin's Workout has no avg/max heart rate of its own — read
    // heart-rate samples within the workout's own window and derive them,
    // the same numbers Health Auto Export used to send directly.
    let avgHr = null, maxHr = null;
    try {
      const hrSamples = await hkReadAll('heartRate', w.startDate, w.endDate);
      if (hrSamples.length) {
        avgHr = hkRound1(hkAvg(hrSamples));
        maxHr = hkRound1(Math.max(...hrSamples.map(s => Number(s.value))));
      }
    } catch { /* heart rate during the workout is optional */ }

    rows.push({
      user_id: currentUser.id,
      external_id: w.platformId || `${w.workoutType}_${w.startDate}`,
      workout_type: w.workoutType,
      started_at: w.startDate,
      ended_at: w.endDate,
      duration_min: w.duration != null ? hkRound1(w.duration / 60) : null,
      active_energy_kcal: w.totalEnergyBurned != null ? hkRound1(w.totalEnergyBurned) : null,
      distance_km: w.totalDistance != null ? hkRound2(w.totalDistance / 1000) : null,
      avg_heart_rate: avgHr,
      max_heart_rate: maxHr,
      synced_at: new Date().toISOString(),
    });
  }
  return rows;
}

// Shared by both the 30-day backfill (on first enabling the toggle) and
// the routine 7-day trailing sync (on every app open + the manual "Sync
// Health Now" button) — the trailing window re-covers the last few days
// on every call rather than just "since last sync", to pick up samples
// that land late (sleep logged after waking, a delayed Watch sync).
// Resolves a single HealthKit fetch, falling back to `fallback` (and
// logging) on failure instead of letting one type's rejection (a type
// the user denied, or "Authorization not determined" for a scope added
// after the toggle was already on) take down the whole Promise.all with
// it — every other type should still sync.
function hkSafe(promise, fallback) {
  return promise.catch(err => {
    console.error('HealthKit fetch failed:', err.message); // mirrored to error_logs — see installErrorLogging()
    return fallback;
  });
}

let hkAutoAuthDone = false;

// Background delivery (native HealthBackgroundSync.swift): iOS wakes the
// app when new Health data lands and it uploads daily totals itself via
// the health-ingest edge function. The native side can't use this web
// view's Supabase session, so it gets a random per-user ingest token —
// raw token stays on-device (localStorage + native), only its SHA-256
// hash is stored server-side (health_ingest_tokens, own-row RLS).
async function enableHealthBackgroundDelivery() {
  const Plugin = window.Capacitor?.Plugins?.HealthBackground;
  if (!Plugin || !currentUser) return;
  try {
    const storeKey = 'fitl00p:hkIngestToken:' + currentUser.id;
    let token = null;
    try { token = localStorage.getItem(storeKey); } catch {}
    if (!token) {
      token = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('');
      const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
      const token_hash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
      const { error } = await db.from('health_ingest_tokens').upsert({ user_id: currentUser.id, token_hash }, { onConflict: 'user_id' });
      if (error) throw error;
      try { localStorage.setItem(storeKey, token); } catch {}
    }
    await Plugin.configure({ userId: currentUser.id, token, url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY });
  } catch (err) {
    console.error('Enabling background Health delivery failed:', err?.message || err);
  }
}

function disableHealthBackgroundDelivery() {
  window.Capacitor?.Plugins?.HealthBackground?.disable?.().catch(() => {});
}

async function runHealthKitSync({ days, interactive = false }) {
  if (!currentUser || !healthKitAvailable()) return;

  // Automatic (app-open) syncs must not fire the permission request while
  // the app isn't foregrounded — iOS fails it with "FrontBoard failed to
  // launch com.apple.HealthPrivacyService", leaving every scope
  // undetermined so all ~16 reads then fail too (seen in error_logs).
  // Interactive callers (toggle, "Sync Health Now") are user gestures, so
  // the app is by definition active and always get the full path.
  if (!interactive) {
    if (document.visibilityState !== 'visible') return;
    if (!hkAutoAuthDone) {
      try {
        await requestHealthKitAuth();
        hkAutoAuthDone = true;
      } catch (err) {
        // One log line, no reads — retried on the next app-open.
        console.warn('HealthKit auto-sync skipped, authorization request failed:', err.message);
        return;
      }
    }
  }

  // Re-requesting on every sync (not just when the toggle first flips
  // on) is deliberate and safe: HealthKit only re-prompts for scopes
  // that are genuinely undetermined, silently no-ops for anything
  // already granted. Without this, a scope added to HEALTHKIT_READ_TYPES/
  // HEALTHKIT_WRITE_TYPES in a later app update (e.g. the 'weight' write
  // scope added alongside writeWeightToHealthKit) never actually gets
  // requested for someone whose toggle was already on from before that
  // update shipped — confirmed live: exactly this caused every sync to
  // fail outright with "Authorization not determined" until this fix.
  if (interactive) {
    await requestHealthKitAuth().catch(err => console.error('HealthKit re-auth failed:', err.message));
  }

  // Sync running at all means the toggle is on — (re)register background
  // delivery so it survives reinstalls and token/session changes.
  enableHealthBackgroundDelivery();

  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 86400000);
  const startISO = startDate.toISOString();
  const endISO = endDate.toISOString();
  const ignoreWeight = !!profile?.manual_weight_logging; // see health-sync.js's identical guard

  const [steps, distance, calories, heartRate, restingHeartRate, weightAgg, dietaryEnergy] = await Promise.all([
    hkSafe(hkAggregatedByDay('steps', startISO, endISO, 'sum'), {}),
    hkSafe(hkAggregatedByDay('distance', startISO, endISO, 'sum'), {}),
    hkSafe(hkAggregatedByDay('calories', startISO, endISO, 'sum'), {}),
    hkSafe(hkAggregatedByDay('heartRate', startISO, endISO, 'average'), {}),
    hkSafe(hkAggregatedByDay('restingHeartRate', startISO, endISO, 'average'), {}),
    ignoreWeight ? Promise.resolve({}) : hkSafe(hkAggregatedByDay('weight', startISO, endISO, 'average'), {}),
    hkSafe(hkAggregatedByDay('dietaryEnergyConsumed', startISO, endISO, 'sum'), {}),
  ]);

  // basalCalories, exerciseTime, vo2Max and appleSleepingWristTemperature
  // are NOT in the plugin's aggregation allow-list (confirmed in its iOS
  // source — only steps/distance/calories/dietaryWater/dietaryEnergyConsumed
  // support 'sum' and heartRate/weight/restingHeartRate support 'average';
  // everything else is rejected) — these, plus the other instantaneous
  // measurement types, go through readSamples() and get bucketed by day here.
  const [basalSamples, exerciseSamples, hrvSamples, respSamples, spo2Samples, vo2Samples, wristSamples, bodyFatSamples, sleepSamples] = await Promise.all([
    hkSafe(hkReadAll('basalCalories', startISO, endISO), []),
    hkSafe(hkReadAll('exerciseTime', startISO, endISO), []),
    hkSafe(hkReadAll('heartRateVariability', startISO, endISO), []),
    hkSafe(hkReadAll('respiratoryRate', startISO, endISO), []),
    hkSafe(hkReadAll('oxygenSaturation', startISO, endISO), []),
    hkSafe(hkReadAll('vo2Max', startISO, endISO), []),
    hkSafe(hkReadAll('appleSleepingWristTemperature', startISO, endISO), []),
    hkSafe(hkReadAll('bodyFat', startISO, endISO), []),
    // Widened a day either side so a session starting just before startISO
    // or ending just after endISO isn't truncated mid-session.
    hkSafe(hkReadAll('sleep', new Date(startDate.getTime() - 86400000).toISOString(), new Date(endDate.getTime() + 86400000).toISOString()), []),
  ]);

  const basalByDay    = hkByDay(basalSamples);
  const exerciseByDay = hkByDay(exerciseSamples);
  const hrvByDay      = hkByDay(hrvSamples);
  const respByDay     = hkByDay(respSamples);
  const spo2ByDay      = hkByDay(spo2Samples);
  const vo2ByDay       = hkByDay(vo2Samples);
  const wristByDay     = hkByDay(wristSamples);
  const bodyFatByDay   = hkByDay(bodyFatSamples);
  const sleepByWakeDate = hkSleepSessionsByWakeDate(sleepSamples);

  const allDates = new Set([
    ...Object.keys(steps), ...Object.keys(distance), ...Object.keys(calories),
    ...Object.keys(heartRate), ...Object.keys(restingHeartRate), ...Object.keys(weightAgg),
    ...Object.keys(dietaryEnergy), ...Object.keys(basalByDay), ...Object.keys(exerciseByDay),
    ...Object.keys(hrvByDay), ...Object.keys(respByDay), ...Object.keys(spo2ByDay),
    ...Object.keys(vo2ByDay), ...Object.keys(wristByDay), ...Object.keys(bodyFatByDay),
    ...Object.keys(sleepByWakeDate),
  ]);

  const rows = [];
  for (const logDate of allDates) {
    const row = { user_id: currentUser.id, log_date: logDate, synced_at: new Date().toISOString() };
    if (steps[logDate] != null)            row.steps = Math.round(steps[logDate]);
    if (distance[logDate] != null)         row.distance_km = hkRound2(distance[logDate] / 1000);
    if (calories[logDate] != null)         row.active_energy_kcal = hkRound1(calories[logDate]);
    if (heartRate[logDate] != null)        row.heart_rate_avg = hkRound1(heartRate[logDate]);
    if (restingHeartRate[logDate] != null) row.resting_hr = hkRound1(restingHeartRate[logDate]);
    if (!ignoreWeight && weightAgg[logDate] != null) row.weight_kg = hkRound2(weightAgg[logDate]);
    if (dietaryEnergy[logDate] != null)    row.dietary_energy_kcal = hkRound1(dietaryEnergy[logDate]);
    if (basalByDay[logDate])    row.resting_energy_kcal = hkRound1(hkSum(basalByDay[logDate]));
    if (exerciseByDay[logDate]) row.exercise_mins = Math.round(hkSum(exerciseByDay[logDate]));
    if (hrvByDay[logDate])      row.hrv_ms = hkRound2(hkAvg(hrvByDay[logDate]));
    if (respByDay[logDate])     row.respiratory_rate = hkRound1(hkAvg(respByDay[logDate]));
    if (spo2ByDay[logDate]) {
      row.spo2_avg = hkRound1(hkAvg(spo2ByDay[logDate]));
      row.spo2_min = hkRound1(Math.min(...spo2ByDay[logDate].map(s => Number(s.value))));
    }
    if (vo2ByDay[logDate])      row.vo2_max = hkRound1(hkAvg(vo2ByDay[logDate]));
    if (wristByDay[logDate])    row.wrist_temp_dev = hkRound2(hkAvg(wristByDay[logDate]));
    if (bodyFatByDay[logDate])  row.body_fat_pct = hkRound2(hkAvg(bodyFatByDay[logDate]));
    if (sleepByWakeDate[logDate]) Object.assign(row, sleepByWakeDate[logDate]);
    rows.push(row);
  }

  if (rows.length) {
    const { error } = await db.from('health_daily').upsert(rows, { onConflict: 'user_id,log_date' });
    if (error) throw error;
  }

  try {
    const workoutRows = await hkSyncWorkouts(startISO, endISO);
    if (workoutRows.length) {
      const { error } = await db.from('apple_health_workouts').upsert(workoutRows, { onConflict: 'user_id,external_id' });
      if (error) throw error;
    }
  } catch (err) {
    // Daily metrics above already saved successfully by this point —
    // don't let a workouts-specific failure (e.g. that scope denied)
    // make the whole sync look like it failed.
    console.error('HealthKit workout sync failed:', err.message);
  }
}

$('setHealthKitSyncEnabled')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  if (!currentUser) return;
  e.target.disabled = true;
  try {
    if (checked) {
      await requestHealthKitAuth();
      const { error } = await saveNsProfileFields({ healthkit_sync_enabled: true });
      if (error) throw error;
      showToast('Health sync enabled — backfilling the last 30 days…');
      await runHealthKitSync({ days: 30, interactive: true });
      showToast('Health sync backfill complete.');
    } else {
      const { error } = await saveNsProfileFields({ healthkit_sync_enabled: false });
      if (error) throw error;
      disableHealthBackgroundDelivery();
    }
  } catch (err) {
    console.error('HealthKit sync toggle failed:', err); // mirrored to error_logs — see installErrorLogging()
    showToast("Couldn't update Health sync: " + err.message, true);
    e.target.checked = !checked; // revert the visible toggle on failure
  } finally {
    e.target.disabled = false;
  }
});

$('btnHealthKitSyncNow')?.addEventListener('click', async () => {
  const btn = $('btnHealthKitSyncNow');
  setBtn(btn, true, 'Sync Health Now', 'Syncing…');
  try {
    await runHealthKitSync({ days: 7, interactive: true });
    showToast('Health synced.');
  } catch (err) {
    console.error('HealthKit manual sync failed:', err); // mirrored to error_logs — see installErrorLogging()
    showToast("Couldn't sync: " + err.message, true);
  }
  setBtn(btn, false, 'Sync Health Now');
});

/* ═══════════════════════════════════════════════════════════
   MANUAL WEIGHT LOGGING
   Toggle lives in Settings; the actual logging UI is the ⚖️ button/card
   on the History tab (see loadHistory() and the handlers below) so it's
   available right where weight history is already being looked at.
   Reuses daily_logs.weight — the same field the dashboard/weight-plan
   cards already read from — rather than a new table, so a manually-
   logged weight shows up everywhere weight already does. health-sync.js
   skips writing this field entirely for a user with the toggle on (see
   there), so this is the only path that can ever set it for them.
═══════════════════════════════════════════════════════════ */
$('setManualWeightLogging')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  if (!currentUser) return;
  const updates = { manual_weight_logging: checked };
  const { error } = await saveNsProfileFields(updates);
  if (error) {
    showToast("Couldn't save: " + error.message, true);
    e.target.checked = !checked; // revert the visible toggle on failure
    return;
  }
  // Reflect immediately on the History tab's button too, in case it's
  // already been visited this session (its own loadHistory() call would
  // otherwise be the only thing to pick this up, on the next visit).
  const toggleBtn = $('btnWeightLogToggle');
  if (toggleBtn) toggleBtn.hidden = !checked;
  if (!checked) {
    const card = $('weightLogCard');
    if (card) card.hidden = true;
  }
});

$('btnWeightLogToggle')?.addEventListener('click', () => {
  const card = $('weightLogCard');
  if (!card) return;
  card.hidden = !card.hidden;
  if (!card.hidden) {
    const mwDate = $('mwDate');
    if (mwDate && !mwDate.value) mwDate.value = todayISO();
    renderManualWeightRecent();
  }
});
$('btnWeightLogClose')?.addEventListener('click', () => {
  const card = $('weightLogCard');
  if (card) card.hidden = true;
});

$('btnSaveManualWeight')?.addEventListener('click', async () => {
  if (!currentUser) return;
  const btn = $('btnSaveManualWeight');
  const date = $('mwDate')?.value || todayISO();
  const unit = BODY_WEIGHT_UNIT;
  const inputWeight = parseFloat($('mwWeight')?.value);
  if (!Number.isFinite(inputWeight) || inputWeight <= 0) {
    flash($('manualWeightStatus'), 'Enter a weight.', true);
    return;
  }
  setBtn(btn, true, 'Log weight', 'Saving…');
  const { error, queued } = await queuedWrite(
    'daily_logs',
    'upsert',
    { user_id: currentUser.id, log_date: date, weight: weightToKg(inputWeight, unit) },
    { onConflict: 'user_id,log_date' }
  );
  setBtn(btn, false, 'Log weight');
  if (error) {
    flash($('manualWeightStatus'), 'Error: ' + error.message, true);
    return;
  }
  flash($('manualWeightStatus'), queued ? "Saved offline — will sync when you're back online." : 'Saved.');
  if ($('mwWeight')) $('mwWeight').value = '';
  writeWeightToHealthKit(weightToKg(inputWeight, unit), date); // local HealthKit write — not a network call, works offline too
  if (!queued) renderManualWeightRecent();
});

async function renderManualWeightRecent() {
  const el2 = $('manualWeightRecent');
  if (!el2 || !currentUser) return;
  const { data, error } = await db
    .from('daily_logs')
    .select('log_date, weight')
    .eq('user_id', currentUser.id)
    .not('weight', 'is', null)
    .order('log_date', { ascending: false })
    .limit(5);
  if (error || !data?.length) {
    el2.innerHTML = 'No weights logged yet.';
    return;
  }
  const unit = BODY_WEIGHT_UNIT;
  el2.innerHTML = 'Recent: ' + data
    .map(r => `${new Date(r.log_date + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })} — ${fmt1(weightFromKg(r.weight, unit))}${unit}`)
    .join(' · ');
}

/* ═══════════════════════════════════════════════════════════
   SMART EAT TARGET — recalculates weekly using real Apple data
═══════════════════════════════════════════════════════════ */
async function computeSmartEatTarget() {
  if (!currentUser || !activePlan || !profile) return null;

  const height = profile.height_cm  || 185.4;
  const age    = profile.age_years  || 37;
  const sex    = profile.sex        || 'male';

  // ── Latest actual weight ──────────────────────────────────
  // Checks both health_daily.weight_kg (Apple Health sync) and
  // daily_logs.weight (manual entry) via the shared helper — a
  // health_daily-only query here would silently ignore every manual
  // weigh-in for an account with manual_weight_logging on (health-sync.js
  // deliberately skips writing weight_kg for them), leaving this stuck on
  // the plan's start_weight from months ago regardless of real progress.
  const currentWeight = (await fetchLatestWeightKg()) ?? Number(activePlan.start_weight);

  // ── BMR — Mifflin-St Jeor ─────────────────────────────────
  const bmr = sex === 'female'
    ? (10 * currentWeight) + (6.25 * height) - (5 * age) - 161
    : (10 * currentWeight) + (6.25 * height) - (5 * age) + 5;

  // ── Last 7 days Apple Health data ─────────────────────────
  const sevenDaysAgoStr = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const [{ data: recentHealth }, { data: recentMfpCals }, { data: recentFoodLog }] = await Promise.all([
    db.from('health_daily')
      .select('active_energy_kcal, dietary_energy_kcal, log_date')
      .eq('user_id', currentUser.id)
      .gte('log_date', sevenDaysAgoStr),
    db.from('daily_logs')
      .select('log_date, cal_mfp')
      .eq('user_id', currentUser.id)
      .gte('log_date', sevenDaysAgoStr),
    db.from('food_log')
      .select('log_date, calories_kcal')
      .eq('user_id', currentUser.id)
      .gte('log_date', todayISO()),
  ]);

  const activeVals = (recentHealth || [])
    .map(r => r.active_energy_kcal != null ? Number(r.active_energy_kcal) : null)
    .filter(v => v != null && v > 0);
  const avgActive = activeVals.length
    ? Math.round(activeVals.reduce((a, b) => a + b, 0) / activeVals.length)
    : 800;

  // Native fitl00p food log wins over cal_mfp, which wins over
  // dietary_energy_kcal — same precedence as pickConsumedCalories elsewhere.
  const mfpByDate = Object.fromEntries(
    (recentMfpCals || []).filter(r => r.cal_mfp != null).map(r => [r.log_date, Number(r.cal_mfp)])
  );
  const foodByDate = {};
  (recentFoodLog || []).forEach(r => {
    foodByDate[r.log_date] = (foodByDate[r.log_date] || 0) + (Number(r.calories_kcal) || 0);
  });
  const dietVals = (recentHealth || [])
    .map(r => foodByDate[r.log_date] ?? mfpByDate[r.log_date] ?? (r.dietary_energy_kcal != null ? Number(r.dietary_energy_kcal) : null))
    .filter(v => v != null && v > 800); // only days with realistic complete totals
  const avgIntake = dietVals.length
    ? Math.round(dietVals.reduce((a, b) => a + b, 0) / dietVals.length)
    : null;

  // ── TDEE = BMR + actual average active burn ───────────────
  const tdee = Math.round(bmr + avgActive);

  // ── Observed loss rate from recent weigh-ins ─────────────
  const { data: recentWeights } = await db
    .from('health_daily')
    .select('weight_kg, log_date')
    .eq('user_id', currentUser.id)
    .not('weight_kg', 'is', null)
    .order('log_date', { ascending: false })
    .limit(7);

  let observedWeeklyLoss = null;
  if (recentWeights && recentWeights.length >= 2) {
    const newest   = recentWeights[0];
    const oldest   = recentWeights[recentWeights.length - 1];
    const daysDiff = Math.max(1, (new Date(newest.log_date) - new Date(oldest.log_date)) / 86400000);
    const kgLost   = Number(oldest.weight_kg) - Number(newest.weight_kg);
    observedWeeklyLoss = (kgLost / daysDiff) * 7;
  }

  // ── Plan maths ────────────────────────────────────────────
  const today              = new Date(todayISO() + 'T00:00:00');
  const targetDate         = new Date(activePlan.target_date + 'T00:00:00');
  const daysLeft           = Math.max(1, Math.round((targetDate - today) / 86400000));
  const kgLeft             = Math.max(0, currentWeight - Number(activePlan.target_weight));
  const requiredWeeklyLoss = (kgLeft / daysLeft) * 7;
  const dailyDeficit       = Math.round((requiredWeeklyLoss / 7) * 7700);

  // ── Smart eat target logic ────────────────────────────────
  // If observed loss rate is meeting the required pace, anchor the
  // recommendation to the actual intake average that's delivering results.
  // Only fall back to TDEE formula if loss has stalled.
  let eatTarget;
  let method;

  const paceMet = observedWeeklyLoss != null && observedWeeklyLoss >= requiredWeeklyLoss * 0.85;

  if (paceMet && avgIntake) {
    // Current intake is working — recommend continuing at observed average
    eatTarget = avgIntake;
    method = 'observed';
  } else {
    // Loss has stalled or no intake data — use TDEE minus required deficit
    eatTarget = Math.round(tdee - dailyDeficit);
    method = 'plan';
  }

  // Floor at 1,200 kcal
  eatTarget = Math.max(1200, eatTarget);

  // A manually-set target always wins over the plan-pace calculation above —
  // the auto-calc floors at a bare safety minimum, not what the user actually
  // wants to eat to, so it must never silently overwrite an explicit choice.
  if (profile.eat_target_manual_kcal) {
    eatTarget = profile.eat_target_manual_kcal;
    method = 'manual';
  }

  // ── Persist on Sundays or if never set (manual overrides are never
  // auto-persisted back into eat_target_kcal — that field tracks the
  // auto-calc's own history, independent of the manual override) ──
  const isSunday = new Date().getDay() === 0;
  const neverSet = !profile.eat_target_kcal;
  if (method !== 'manual' && (isSunday || neverSet)) {
    await db.from('profiles').update({
      eat_target_kcal:       eatTarget,
      eat_target_updated_at: todayISO().slice(0, 10),
    }).eq('id', currentUser.id);
    profile.eat_target_kcal       = eatTarget;
    profile.eat_target_updated_at = todayISO().slice(0, 10);
  }

  return {
    eatTarget, tdee, bmr: Math.round(bmr),
    avgActive, avgIntake,
    observedWeeklyLoss: observedWeeklyLoss ? Math.round(observedWeeklyLoss * 100) / 100 : null,
    requiredWeeklyLoss: Math.round(requiredWeeklyLoss * 100) / 100,
    dailyDeficit, daysLeft, kgLeft, method,
  };
}
async function createApprovalRequest() {
  if (!currentUser) return;
  // Upsert so we don't duplicate on repeated logins
  await db.from('approval_requests').upsert({
    user_id:      currentUser.id,
    email:        currentUser.email,
    name:         profile?.display_name || null,
    status:       'pending',
  }, { onConflict: 'user_id', ignoreDuplicates: true });
}

// Pending / rejected sign-out buttons
document.addEventListener('click', async e => {
  if (e.target.closest('#btnPendingSignout') || e.target.closest('#btnRejectedSignout')) {
    resetAuthForms();
    try { await db?.auth.signOut(); } catch {}
    window.location.href = window.location.origin + window.location.pathname;
  }
});

// ── Workout Admin Editor ──────────────────────────────────

// All exercise names for autocomplete
const ALL_EXERCISES = [
  // ── CHEST ─────────────────────────────────────────────────
  'Barbell Bench Press','Dumbbell Bench Press','Incline Barbell Bench Press',
  'Incline Dumbbell Press','Decline Bench Press','Close-Grip Bench Press',
  'Cable Fly','Dumbbell Fly','Incline Dumbbell Fly','Decline Dumbbell Fly',
  'Pec Deck Machine','Cable Crossover','Low Cable Fly','High Cable Fly',
  'Machine Chest Press','Incline Machine Press','Decline Machine Press',
  'Chest Dip','Svend Press','Floor Press','Push-Up','Wide Push-Up',
  'Diamond Push-Up','Archer Push-Up','Decline Push-Up','Pike Push-Up',
  'Plank to Push-Up',
  // ── BACK ──────────────────────────────────────────────────
  'Barbell Row','Dumbbell Row','Cable Row','Seated Cable Row',
  'Single Arm Cable Row','Chest Supported Row','Meadows Row',
  'Lat Pulldown','Wide Grip Lat Pulldown','Close Grip Lat Pulldown',
  'Reverse Grip Lat Pulldown','Straight Arm Pulldown','Pull-Up','Chin-Up',
  'Assisted Pull-Up','Inverted Row','Machine Row','Hammer Strength Row',
  'Pendlay Row','Rack Pull','Deadlift','Romanian Deadlift',
  'Stiff Leg Deadlift','Sumo Deadlift','Trap Bar Deadlift',
  'Good Morning','Hyperextension','Back Extension','Superman Hold',
  // ── SHOULDERS ─────────────────────────────────────────────
  'Barbell Overhead Press','Dumbbell Shoulder Press','Machine Shoulder Press',
  'Smith Machine Overhead Press','Arnold Press','Behind the Neck Press',
  'Seated Dumbbell Press','Cable Overhead Press',
  'Dumbbell Lateral Raise','Cable Lateral Raise','Machine Lateral Raise',
  'Plate Lateral Raise','Dumbbell Front Raise','Cable Front Raise',
  'Barbell Front Raise','Dumbbell Rear Delt Fly','Rear Delt Fly Machine',
  'Bent Over Lateral Raise','Face Pull','Cable Face Pull',
  'Band Pull-Apart','Upright Row','Barbell Shrug','Dumbbell Shrug',
  'Machine Shrug','Cable Shrug','Trap Bar Shrug',
  // ── BICEPS ────────────────────────────────────────────────
  'Barbell Curl','Dumbbell Curl','Hammer Curl','Incline Dumbbell Curl',
  'Cable Bicep Curl','EZ Bar Curl','Preacher Curl','Machine Preacher Curl',
  'Machine Curl','Concentration Curl','Spider Curl','Bayesian Curl',
  'Cross Body Curl','Zottman Curl','Reverse Curl','Cable Hammer Curl',
  'Seated Incline Curl','Overhead Cable Curl',
  // ── TRICEPS ───────────────────────────────────────────────
  'Tricep Pushdown','Rope Tricep Pushdown','Straight Bar Pushdown',
  'Overhead Tricep Extension','Dumbbell Overhead Tricep Extension',
  'Cable Overhead Tricep Extension','Skull Crushers','EZ Bar Skull Crusher',
  'Close-Grip Bench Press','Tricep Dip','Machine Tricep Dip',
  'Diamond Push-Up','Tricep Kickback','Cable Kickback',
  'Single Arm Tricep Pushdown','JM Press',
  // ── LEGS — QUADS ──────────────────────────────────────────
  'Barbell Squat','Front Squat','Hack Squat','Smith Machine Squat',
  'Goblet Squat','Dumbbell Squat','Bulgarian Split Squat',
  'Dumbbell Goblet Squat','Leg Press','45 Degree Leg Press',
  'Leg Extension','Sissy Squat','Wall Sit','Step Up',
  'Barbell Lunge','Dumbbell Lunge','Reverse Lunge','Walking Lunge',
  'Lateral Lunge','Jump Squat','Box Jump','Bodyweight Squat',
  'Pistol Squat','Skater Squat','Zercher Squat','Safety Bar Squat',
  // ── LEGS — HAMSTRINGS / GLUTES ────────────────────────────
  'Romanian Deadlift','Dumbbell Romanian Deadlift','Nordic Curl',
  'Leg Curl','Seated Leg Curl','Prone Leg Curl','Cable Pull Through',
  'Hip Thrust','Barbell Hip Thrust','Dumbbell Hip Thrust',
  'Glute Bridge','Single Leg Glute Bridge','Cable Glute Kickback',
  'Machine Glute Kickback','Donkey Kick','Fire Hydrant',
  'Hip Abductor Machine','Hip Adductor Machine',
  // ── LEGS — CALVES ─────────────────────────────────────────
  'Standing Calf Raise','Seated Calf Raise','Calf Raise',
  'Single Leg Calf Raise','Donkey Calf Raise','Leg Press Calf Raise',
  'Smith Machine Calf Raise','Tibialis Raise',
  // ── CORE ──────────────────────────────────────────────────
  'Plank','Side Plank','Plank Hip Dip','Dead Bug','Bird Dog',
  'Cable Crunch','Machine Crunch','Ab Wheel Rollout','Hollow Body Hold',
  'Hanging Leg Raise','Hanging Knee Raise','Decline Sit-Up',
  'V-Up','Bicycle Crunch','Russian Twist','Pallof Press',
  'Cable Woodchop','Landmine Rotation','L-Sit Hold',
  'Toe Touch Crunch','Reverse Crunch','Dragon Flag',
  // ── FULL BODY / COMPOUND ──────────────────────────────────
  'Burpee','Mountain Climber','Thruster','Clean and Press',
  'Power Clean','Snatch','Push Press','Hang Clean','Man Maker',
  'Devil Press','Bear Crawl','Sled Push','Sled Pull',
  'Battle Rope Waves','Battle Rope Slams','Box Step Up',
  "Farmer's Carry",'Landmine Press','Landmine Squat',
  // ── KETTLEBELL ────────────────────────────────────────────
  'KB Swing','Kettlebell Swing','KB Goblet Squat','KB Press',
  'KB Row','KB Deadlift','KB Romanian Deadlift','KB Turkish Get-Up',
  'KB Clean','KB Snatch','KB Clean and Press','KB Farmers Carry',
  'KB Floor Press','KB Double Front Squat','KB Bulgarian Split Squat',
  'KB Hip Thrust','KB Windmill','KB Figure 8','KB Halo',
  'KB Lateral Lunge','KB Single Leg Deadlift','KB Around the World',
  'KB High Pull','KB Renegade Row','KB Thruster','KB Front Rack Squat',
  'KB Half Kneeling Press','KB Strict Press','KB Push Press',
  'KB Overhead Walk','KB Single Arm Swing','KB Sumo Deadlift',
  // ── CABLE ─────────────────────────────────────────────────
  'Cable Bicep Curl','Cable Fly','Cable Crossover','Low Cable Fly',
  'High Cable Fly','Cable Row','Seated Cable Row','Single Arm Cable Row',
  'Cable Lateral Raise','Cable Front Raise','Cable Face Pull',
  'Cable Overhead Press','Cable Chest Press','Cable Overhead Tricep Extension',
  'Rope Tricep Pushdown','Straight Bar Pushdown','Cable Kickback',
  'Single Arm Tricep Pushdown','Cable Glute Kickback','Cable Pull Through',
  'Cable Woodchop','Pallof Press','Cable Crunch','Straight Arm Pulldown',
  'Cable Hammer Curl','Overhead Cable Curl','Cable Upright Row',
  'Cable Shrug','Cable Hip Abduction','Cable Hip Adduction',
  // ── MACHINE ───────────────────────────────────────────────
  'Machine Chest Press','Incline Machine Press','Pec Deck Machine',
  'Machine Row','Hammer Strength Row','Machine Shoulder Press',
  'Machine Lateral Raise','Rear Delt Fly Machine','Lat Pulldown',
  'Assisted Pull-Up','Machine Preacher Curl','Machine Curl',
  'Machine Tricep Dip','Leg Press','45 Degree Leg Press','Hack Squat',
  'Leg Extension','Leg Curl','Seated Leg Curl','Prone Leg Curl',
  'Hip Abductor Machine','Hip Adductor Machine','Machine Glute Kickback',
  'Standing Calf Raise','Seated Calf Raise','Smith Machine Squat',
  'Smith Machine Overhead Press','Smith Machine Calf Raise',
  'Machine Crunch','Machine Shrug','Chest Supported Row',
].filter((v, i, a) => a.indexOf(v) === i).sort();

let waRoutines      = [];  // all loaded routine templates
let waExercises     = {};  // routineId -> [exercise rows]
let waActiveTab     = 'routines'; // 'routines'

async function loadWorkoutAdminData() {
  const list = $('routineAdminList');
  if (list) list.innerHTML = '<p style="color:var(--ink-3);text-align:center;padding:20px">Loading…</p>';

  // Fetch all routines + exercises in parallel
  const [routineRes, exerciseRes] = await Promise.all([
    db.from('routine_templates')
      .select('id, name, split_type, goal, equipment_id, min_duration, max_duration, rest_seconds')
      .order('goal').order('equipment_id').order('split_type').order('min_duration'),
    db.from('routine_exercises')
      .select('id, routine_id, name, sets, reps, notes, sort_order')
      .order('sort_order'),
  ]);

  waRoutines = routineRes.data || [];

  // Index exercises by routine_id
  waExercises = {};
  for (const ex of (exerciseRes.data || [])) {
    if (!waExercises[ex.routine_id]) waExercises[ex.routine_id] = [];
    waExercises[ex.routine_id].push({ ...ex });
  }

  renderWorkoutAdmin();
}

function renderWorkoutAdmin() {
  const list = $('routineAdminList');
  if (!list) return;

  // Apply filters
  const goal  = $('waFilterGoal')?.value      || '';
  const equip = $('waFilterEquipment')?.value || '';
  const split = $('waFilterSplit')?.value     || '';

  const filtered = waRoutines.filter(r =>
    (!goal  || r.goal         === goal)  &&
    (!equip || r.equipment_id === equip) &&
    (!split || r.split_type   === split)
  );

  if (!filtered.length) {
    list.innerHTML = '<p style="color:var(--ink-3);text-align:center;padding:20px">No routines match these filters.</p>';
    return;
  }

  list.innerHTML = filtered.map(r => {
    const exes = (waExercises[r.id] || []);

    return `
    <div class="routine-admin-card" id="wac-${r.id}">
      <div class="routine-admin-card__head" onclick="toggleRoutineCard('${r.id}')">
        <div>
          <div class="routine-admin-card__name">${r.name}</div>
          <div class="routine-admin-card__meta">
            ${r.goal.replace('_',' ')} · ${r.equipment_id.replace('_',' ')} · ${r.split_type} · ${r.min_duration}–${r.max_duration} min · ${exes.length} exercises
          </div>
        </div>
        <span class="routine-admin-card__chevron" id="chev-${r.id}">▼</span>
      </div>
      <div class="routine-admin-card__body" id="body-${r.id}">
        <div class="exercise-admin-headers">
          <span>↕</span><span>Exercise</span><span>Sets</span><span>Reps</span><span>Notes</span><span></span>
        </div>
        <div class="exercise-admin-list" id="exlist-${r.id}">
          ${exes.map((ex, i) => renderExerciseAdminRow(r.id, ex, i)).join('')}
        </div>
        <div class="add-exercise-row">
          <input list="exercise-datalist" id="newExName-${r.id}" placeholder="Add exercise…" autocomplete="off">
          <button onclick="addExerciseRow('${r.id}')">+ Add</button>
        </div>
        <datalist id="exercise-datalist">
          ${ALL_EXERCISES.map(e => `<option value="${e}">`).join('')}
        </datalist>
        <div class="routine-admin-save-row">
          <button class="btn btn--primary btn--small" onclick="saveRoutineExercises('${r.id}')">Save changes</button>
          <span class="save-status" id="save-status-${r.id}"></span>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderExerciseAdminRow(routineId, ex, idx) {
  return `
  <div class="exercise-admin-row" id="exrow-${routineId}-${ex.id}" draggable="true"
       ondragstart="waDragStart(event,'${routineId}','${ex.id}')"
       ondragover="event.preventDefault()"
       ondrop="waDrop(event,'${routineId}','${ex.id}')">
    <span class="drag-handle">⠿</span>
    <input type="text" list="exercise-datalist" value="${ex.name}"
      onchange="waUpdateField('${routineId}','${ex.id}','name',this.value)"
      style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--ink)">
    <input type="number" value="${ex.sets}" min="1" max="10" style="width:100%;padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--ink);text-align:center"
      onchange="waUpdateField('${routineId}','${ex.id}','sets',+this.value)">
    <input type="number" value="${ex.reps}" min="1" max="100" style="width:100%;padding:4px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--ink);text-align:center"
      onchange="waUpdateField('${routineId}','${ex.id}','reps',+this.value)">
    <input type="text" value="${ex.notes || ''}" placeholder="Notes…"
      onchange="waUpdateField('${routineId}','${ex.id}','notes',this.value)"
      style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid var(--border);background:var(--surface);color:var(--ink-2);font-size:12px">
    <button class="del-btn" onclick="deleteExerciseRow('${routineId}','${ex.id}')">✕</button>
  </div>`;
}

function toggleRoutineCard(id) {
  const body = $(`body-${id}`);
  const chev = $(`chev-${id}`);
  if (!body) return;
  const open = body.classList.toggle('open');
  if (chev) chev.classList.toggle('open', open);
}

// Drag and drop reordering
let waDragId = null;
function waDragStart(e, routineId, exId) {
  waDragId = { routineId, exId };
  e.dataTransfer.effectAllowed = 'move';
}
function waDrop(e, routineId, targetExId) {
  e.preventDefault();
  if (!waDragId || waDragId.routineId !== routineId || waDragId.exId === targetExId) return;
  const exes = waExercises[routineId];
  if (!exes) return;
  const fromIdx = exes.findIndex(x => x.id === waDragId.exId);
  const toIdx   = exes.findIndex(x => x.id === targetExId);
  if (fromIdx < 0 || toIdx < 0) return;
  const [moved] = exes.splice(fromIdx, 1);
  exes.splice(toIdx, 0, moved);
  // Re-render just this routine's exercise list
  const list = $(`exlist-${routineId}`);
  if (list) list.innerHTML = exes.map((ex, i) => renderExerciseAdminRow(routineId, ex, i)).join('');
}

function waUpdateField(routineId, exId, field, value) {
  const exes = waExercises[routineId];
  if (!exes) return;
  const ex = exes.find(x => x.id === exId);
  if (ex) ex[field] = value;
}

function deleteExerciseRow(routineId, exId) {
  const exes = waExercises[routineId];
  if (!exes) return;
  const idx = exes.findIndex(x => x.id === exId);
  if (idx >= 0) exes.splice(idx, 1);
  const row = $(`exrow-${routineId}-${exId}`);
  if (row) row.remove();
}

function addExerciseRow(routineId) {
  const input = $(`newExName-${routineId}`);
  const name  = input?.value?.trim();
  if (!name) return;

  const exes = waExercises[routineId] || [];
  const newEx = {
    id:         'new-' + Date.now(),
    routine_id: routineId,
    name,
    sets:       3,
    reps:       10,
    notes:      '',
    sort_order: exes.length,
    _isNew:     true,
  };
  exes.push(newEx);
  waExercises[routineId] = exes;

  const list = $(`exlist-${routineId}`);
  if (list) list.insertAdjacentHTML('beforeend', renderExerciseAdminRow(routineId, newEx, exes.length - 1));
  if (input) input.value = '';
}

async function saveRoutineExercises(routineId) {
  const statusEl = $(`save-status-${routineId}`);
  if (statusEl) statusEl.textContent = 'Saving…';

  const exes = waExercises[routineId] || [];
  exes.forEach((ex, i) => { ex.sort_order = i; });

  try {
    const toInsert = exes.filter(ex => ex._isNew).map(({ _isNew, ...ex }) => ex);
    const toUpdate = exes.filter(ex => !ex._isNew);

    if (toUpdate.length) {
      for (const ex of toUpdate) {
        await db.from('routine_exercises').update({
          name:       ex.name,
          sets:       ex.sets,
          reps:       ex.reps,
          notes:      ex.notes || null,
          sort_order: ex.sort_order,
        }).eq('id', ex.id);
      }
    }

    if (toInsert.length) {
      const rows = toInsert.map(ex => ({
        routine_id: routineId,
        name:       ex.name,
        sets:       ex.sets,
        reps:       ex.reps,
        notes:      ex.notes || null,
        sort_order: ex.sort_order,
      }));
      const { data: inserted } = await db.from('routine_exercises').insert(rows).select();
      if (inserted) {
        inserted.forEach((ins, i) => {
          const tmp = toInsert[i];
          const ex = exes.find(e => e._isNew && e.name === tmp.name);
          if (ex) { ex.id = ins.id; delete ex._isNew; }
        });
      }
    }

    // Clear localStorage workout state so next workout load gets fresh DB data
    clearWorkoutState();

    if (statusEl) {
      statusEl.textContent = '✓ Saved — workout will reload fresh next session';
      setTimeout(() => { statusEl.textContent = ''; }, 4000);
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = 'Error: ' + err.message;
  }
}

// Wire filter changes to re-render
['waFilterGoal','waFilterEquipment','waFilterSplit'].forEach(id => {
  document.addEventListener('change', e => {
    if (e.target.id === id) renderWorkoutAdmin();
  });
});
document.addEventListener('click', e => {
  if (e.target.closest('#btnOpenIam')) openIamPortal();
  if (e.target.closest('#iamModalClose')) $('iamModal').hidden = true;
  if (e.target.closest('#btnOpenWorkoutAdmin')) navigateTo('workoutAdmin');
  if (e.target.closest('#btnBackFromWorkoutAdmin')) navigateTo('settings');
});

async function openIamPortal() {
  $('iamModal').hidden = false;
  await loadIamData();
}

async function loadIamData() {
  $('iamPendingList').innerHTML  = '<p class="empty-state">Loading…</p>';
  $('iamApprovedList').innerHTML = '<p class="empty-state">Loading…</p>';
  $('iamRejectedList').innerHTML = '<p class="empty-state">Loading…</p>';

  // Fetch all approval requests
  const { data: requests } = await db.from('approval_requests')
    .select('*')
    .order('requested_at', { ascending: false });

  // Fetch all profiles for cross-reference
  const { data: profiles2 } = await db.from('profiles')
    .select('id, display_name, role, approved_at');

  const profileMap = {};
  (profiles2 || []).forEach(p => { profileMap[p.id] = p; });

  const pending  = (requests || []).filter(r => r.status === 'pending');
  const approved = (requests || []).filter(r => r.status === 'approved');
  const rejected = (requests || []).filter(r => r.status === 'rejected');

  // Pending count badge
  const badge = $('iamPendingCount');
  if (badge) badge.textContent = pending.length || '';

  function userRow(r, actions) {
    const initials = (r.name || r.email || '?').charAt(0).toUpperCase();
    const date = r.requested_at ? new Date(r.requested_at).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}) : '';
    return `<div class="iam-user-row" data-uid="${r.user_id}">
      <div class="iam-user-avatar">${initials}</div>
      <div class="iam-user-info">
        <div class="iam-user-name">${r.name || '—'}</div>
        <div class="iam-user-email">${r.email}</div>
        <div class="iam-user-date">Requested ${date}</div>
      </div>
      <div class="iam-actions">${actions}</div>
    </div>`;
  }

  $('iamPendingList').innerHTML = pending.length
    ? pending.map(r => userRow(r,
        `<button class="iam-approve" data-uid="${r.user_id}" data-action="approve">✓ Approve</button>
         <button class="iam-reject"  data-uid="${r.user_id}" data-action="reject">✗ Reject</button>`
      )).join('')
    : '<p class="empty-state">No pending requests.</p>';

  $('iamApprovedList').innerHTML = approved.length
    ? approved.map(r => userRow(r, `<span class="badge badge--green">Approved</span>`)).join('')
    : '<p class="empty-state">No approved users yet.</p>';

  $('iamRejectedList').innerHTML = rejected.length
    ? rejected.map(r => userRow(r,
        `<button class="iam-re-approve" data-uid="${r.user_id}" data-action="approve">Re-approve</button>`
      )).join('')
    : '<p class="empty-state">None.</p>';

  // Wire approve/reject buttons
  $('iamModal').querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid    = btn.dataset.uid;
      const action = btn.dataset.action;
      btn.disabled = true;
      btn.textContent = action === 'approve' ? 'Approving…' : 'Rejecting…';

      const session = (await db.auth.getSession()).data.session;
      const res = await fetch(`${FUNCTIONS_ORIGIN}/admin-approve`, {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ userId: uid, action }),
      });
      const data = await res.json();

      if (data.success) {
        showToast(action === 'approve' ? 'User approved ✓' : 'User rejected');
        await loadIamData(); // refresh list
      } else {
        showToast('Error: ' + (data.error || 'unknown'), true);
        btn.disabled = false;
      }
    });
  });
}

/* ═══════════════════════════════════════════════════════════
   ONBOARDING
═══════════════════════════════════════════════════════════ */
function initOnboarding() {
  let currentStep = 0;
  const totalSteps = 4;

  // State
  const state = {
    name:         profile?.display_name || '',
    goal:         profile?.goal         || null,
    duration:     profile?.session_duration || 45,
    fullBody:     profile?.prefer_full_body || false,
    equipment:    profile?.equipment    || [],
    injuries:     profile?.injuries     || [],
    startWeight:  null,
    targetWeight: null,
    targetDate:   null,
  };

  // Pre-fill from profile if returning user
  if (state.name)    { const el2 = $('obName'); if (el2) el2.value = state.name; }
  if (state.goal)    activateCard($('obGoal'), state.goal);
  activatePill($('obDuration'), String(state.duration));
  if (state.fullBody) { const cb = $('obFullBody'); if (cb) cb.checked = true; }
  state.equipment.forEach(v => activateCard($('obEquipment'), v));
  state.injuries.forEach(v => activateCard($('obInjuries'), v));

  // ── Pill selector wiring ──────────────────────────────
  function activatePill(container, val) {
    if (!container) return;
    container.querySelectorAll('.pill').forEach(p => {
      p.classList.toggle('active', p.dataset.val === val);
    });
  }

  function activateCard(container, val) {
    if (!container) return;
    const card = container.querySelector(`[data-val="${val}"]`);
    if (card) card.classList.toggle('active');
  }

  // Wire pill groups
  $('obDuration')?.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      state.duration = parseInt(p.dataset.val);
      activatePill($('obDuration'), p.dataset.val);
    });
  });

  // Wire goal cards (single select)
  $('obGoal')?.querySelectorAll('.goal-card').forEach(c => {
    c.addEventListener('click', () => {
      state.goal = c.dataset.val;
      $('obGoal').querySelectorAll('.goal-card').forEach(x => x.classList.remove('active'));
      c.classList.add('active');
    });
  });

  // Wire equipment cards (multi select)
  $('obEquipment')?.querySelectorAll('.equip-card').forEach(c => {
    c.addEventListener('click', () => {
      const val = c.dataset.val;
      c.classList.toggle('active');
      if (state.equipment.includes(val)) {
        state.equipment = state.equipment.filter(v => v !== val);
      } else {
        state.equipment.push(val);
      }
    });
  });

  // Wire injury pills (multi select)
  $('obInjuries')?.querySelectorAll('.injury-pill').forEach(p => {
    p.addEventListener('click', () => {
      const val = p.dataset.val;
      p.classList.toggle('active');
      if (state.injuries.includes(val)) {
        state.injuries = state.injuries.filter(v => v !== val);
      } else {
        state.injuries.push(val);
      }
    });
  });

  // Wire full body toggle
  $('obFullBody')?.addEventListener('change', e => {
    state.fullBody = e.target.checked;
  });

  // ── Progress dots ─────────────────────────────────────
  function updateProgress(step) {
    document.querySelectorAll('.onboard-step-dot').forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < step)  dot.classList.add('done');
      if (i === step) dot.classList.add('active');
    });
  }

  // ── Navigation ────────────────────────────────────────
  function goToStep(step, direction = 'forward') {
    const current = $(`obStep${currentStep}`);
    const next    = $(`obStep${step}`);
    if (!next) return;

    current?.classList.remove('active');
    currentStep = step;
    next.classList.add('active');
    if (direction === 'back') {
      next.style.animation = 'obSlideInBack .3s cubic-bezier(.25,.8,.25,1)';
      setTimeout(() => { next.style.animation = ''; }, 300);
    }

    updateProgress(step);

    // Back button
    const backBtn = $('obBack');
    if (backBtn) backBtn.hidden = step === 0;

    // Next button text
    const nextBtn = $('obNext');
    if (nextBtn) nextBtn.textContent = step === totalSteps - 1 ? "Let's go 🚀" : 'Continue →';

    // Scroll to top
    $('screenOnboard')?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Validation per step ───────────────────────────────
  function validateStep(step) {
    if (step === 0) {
      const name = $('obName')?.value.trim();
      if (!name) {
        $('obName')?.focus();
        $('obName')?.style && ($('obName').style.borderColor = 'var(--red)');
        setTimeout(() => { if ($('obName')) $('obName').style.borderColor = ''; }, 1500);
        return false;
      }
      state.name = name;
    }
    if (step === 1 && !state.goal) {
      // Highlight goal cards
      $('obGoal')?.classList.add('shake');
      setTimeout(() => $('obGoal')?.classList.remove('shake'), 400);
      return false;
    }
    if (step === 2 && state.equipment.length === 0) {
      $('obEquipment')?.classList.add('shake');
      setTimeout(() => $('obEquipment')?.classList.remove('shake'), 400);
      return false;
    }
    if (step === 3) {
      const sw = parseFloat($('obCurrentWeight')?.value);
      const tw = parseFloat($('obTargetWeight')?.value);
      const td = $('obTargetDate')?.value;
      // This step's own copy says "optionally set a weight goal" — so
      // leaving all three blank must be allowed (skip it entirely).
      // saveOnboarding() only creates a weight_plans row when all three
      // are present (target_date is NOT NULL in that table), so a
      // partial fill can't produce a valid plan either — only block
      // that ambiguous middle case, matching what was previously
      // (incorrectly) required unconditionally.
      const anyFilled = sw || tw || td;
      const allFilled = sw && tw && td;
      if (anyFilled && !allFilled) {
        const panel = $('obStep3') || $('obCurrentWeight')?.closest('.onboard-panel');
        panel?.classList.add('shake');
        setTimeout(() => panel?.classList.remove('shake'), 400);
        return false;
      }
    }
    return true;
  }

  // Next button
  $('obNext')?.addEventListener('click', async () => {
    if (!validateStep(currentStep)) return;

    if (currentStep < totalSteps - 1) {
      goToStep(currentStep + 1, 'forward');
    } else {
      // Final step — collect weight fields and save
      const sw = parseFloat($('obCurrentWeight')?.value);
      const tw = parseFloat($('obTargetWeight')?.value);
      const td = $('obTargetDate')?.value;
      if (sw) state.startWeight  = sw;
      if (tw) state.targetWeight = tw;
      if (td) state.targetDate   = td;
      await saveOnboarding();
    }
  });

  // Back button
  $('obBack')?.addEventListener('click', () => {
    if (currentStep > 0) goToStep(currentStep - 1, 'back');
  });

  // ── Save to Supabase ──────────────────────────────────
  async function saveOnboarding() {
    $('obSaving').hidden  = false;
    $('obNext').disabled  = true;

    const profileUpdate = {
      display_name:       state.name || null,
      goal:               state.goal,
      session_duration:   state.duration,
      prefer_full_body:   state.fullBody,
      equipment:          state.equipment.length ? state.equipment : null,
      injuries:           state.injuries.length  ? state.injuries  : null,
      onboarding_complete: true,
    };

    const { error: pe } = await db.from('profiles')
      .update(profileUpdate)
      .eq('id', currentUser.id);

    if (pe) {
      console.error('Onboarding save failed:', pe.message);
      $('obSaving').textContent = `Something went wrong — ${pe.message}`;
      $('obNext').disabled = false;
      return;
    }

    Object.assign(profile, profileUpdate);

    // Create weight plan if start + target provided — state.startWeight/
    // targetWeight were typed in lb (BODY_WEIGHT_UNIT), converted to
    // canonical kg before storing (same convention as daily_logs.weight
    // elsewhere).
    if (state.startWeight && state.targetWeight && state.targetDate) {
      const today = todayISO();
      const startWeightKg  = weightToKg(state.startWeight, BODY_WEIGHT_UNIT);
      const targetWeightKg = weightToKg(state.targetWeight, BODY_WEIGHT_UNIT);
      await db.from('weight_plans').update({ is_active: false })
        .eq('user_id', currentUser.id).eq('is_active', true);

      const { data: plan } = await db.from('weight_plans').insert({
        user_id:       currentUser.id,
        start_weight:  startWeightKg,
        target_weight: targetWeightKg,
        start_date:    today,
        target_date:   state.targetDate,
        unit:          'kg',
        is_active:     true,
      }).select().single();

      if (plan) activePlan = plan;

      // Also log starting weight in daily_logs
      if (state.startWeight) {
        await db.from('daily_logs').upsert({
          user_id:  currentUser.id,
          log_date: today,
          weight:   startWeightKg,
        }, { onConflict: 'user_id,log_date' });
      }
    }

    // Done — transition to app
    $('obSaving').textContent = 'All set! Loading your dashboard…';
    await new Promise(r => setTimeout(r, 600));
    showScreen('app');
    navigateTo('dashboard');
    requestNotificationPermission();
    checkDetectedActivities();
  }
}

/* ═══════════════════════════════════════════════════════════
   LOG FOOD — fitl00p-native calorie/macro tracking
   Four ways in: barcode scan (native BarcodeDetector where available,
   ZXing as a Safari fallback — see startBarcodeScan — against Open Food
   Facts, client-side, no backend needed for lookups since OFF's API is
   keyless and CORS-open), search the shared custom-foods list, a Claude
   vision estimate from a photo + description, or plain manual entry.
   All four funnel into the same review/save form so the numbers are
   always checked before they're logged, never saved sight-unseen.
═══════════════════════════════════════════════════════════ */
const MEAL_SLOT_BY_HOUR = { 5: 'breakfast', 11: 'lunch', 16: 'dinner', 21: 'snack' };
function defaultMealSlot() {
  const h = new Date().getHours();
  if (h < 11) return 'breakfast';
  if (h < 16) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

// Daily macro targets for Log Food's "Remaining" card. Calories reuse
// the same effective-target resolution as computeNutritionScore (manual
// override wins, else the auto-calculated eat_target_kcal, else a bare
// tdee-500 fallback) rather than re-running computeSmartEatTarget's full
// plan-pace algorithm here — that needs an active weight plan and several
// extra queries just to arrive at the same stored number.
//
// Fat and carbs are the two fixed macros: fat is 25% of the calorie
// target, and carbs are sized off a 1g-per-lb-bodyweight protein
// reference — the same numbers this produced before. Protein used to be
// that same weight-based figure directly, but summing all three that way
// can land a couple kcal over calTarget once each is independently
// rounded (e.g. 212g protein + 50g fat + 126g carbs = 1802 kcal against
// an 1800 target). So protein is now the one derived last: whatever's
// left of calTarget once fat and carbs are taken out, floored rather
// than rounded so the three targets can never sum to more than
// calTarget itself — "reduced to match 1800, or as close as possible"
// without ever asking for more than fits.
async function computeMacroTargets() {
  const calTarget = profile?.eat_target_manual_kcal ?? profile?.eat_target_kcal
    ?? (profile?.tdee ? profile.tdee - 500 : null);
  if (!calTarget) return null;

  const weightKg = await fetchLatestWeightKg();
  const referenceProteinKcal = weightKg != null ? (weightKg / LB_TO_KG) * 4 : 0;
  const fatKcal = calTarget * 0.25;
  const fatTarget = Math.round(fatKcal / 9);
  const carbTarget = Math.round(Math.max(0, calTarget - referenceProteinKcal - fatKcal) / 4);
  const proteinTarget = weightKg != null
    ? Math.floor(Math.max(0, calTarget - fatKcal - carbTarget * 4) / 4)
    : null;

  return { calories: calTarget, protein: proteinTarget, fat: fatTarget, carbs: carbTarget };
}

// Two-person household — same fixed Lewis<->Gemma pairing already
// hardcoded server-side for the Gemma-specific scheduled notifications
// (see GEMMA_USER_ID in netlify/functions/_lib/webpush.js) and now also
// in share-food-log.js, which does the actual cross-account insert
// (food_log's RLS is strictly own-write, so this app can't do it
// directly). This client-side copy only decides whether to show the
// "Also log this for X" checkbox and what name to put in it.
const HOUSEHOLD_PARTNER = {
  'cae63d3e-df60-4415-8a43-64748b6591c3': { id: '2c8bf000-b870-4ea1-8a67-ec00ee7d4041', name: 'Gemma' },
  '2c8bf000-b870-4ea1-8a67-ec00ee7d4041': { id: 'cae63d3e-df60-4415-8a43-64748b6591c3', name: 'Lewis' },
};

let lfSelectedMode = null;
let lfBarcodeStream = null;
let lfBarcodeDetector = null;
let lfBarcodeScanRAF = null;
let lfZxingControls = null; // ZXing's IScannerControls — the Safari fallback path (see startBarcodeScan)
let lfZxingScanAttempts = 0; // frames checked so far this scan session — diagnostic only, see startBarcodeScan
const LF_PHOTO_MAX_ANGLES = 3;
let lfPhotoAngles = []; // up to 3 photos of the meal as served, from different angles — [{base64, mediaType, dataUrl}]
let lfPhotoAfterBase64 = null; // optional "leftovers" photo — when set, the estimate is before-minus-after
let lfPhotoAfterMediaType = null;
let lfSelectedCustomFoodId = null; // set when the review form was populated from an existing custom_foods row (scan/search) — avoids re-saving a duplicate
let lfPendingBarcode = null; // carries a scanned (found-or-not) barcode into save, so a not-found product is still remembered for next time
let lfFavToggleActive = false; // ⭐ toggle in the review form — save this entry to favorite_meals too, alongside logging it
let lfFavoritesData = []; // last-rendered favorite_meals rows, so a chip click can look itself up by id without a refetch
let lfBaseNutrition = null; // per-base-serving {qty, calories_kcal, protein_g, carbs_g, fat_g} from the selected food — lets editing Serving size live-rescale the macro fields
let lfEditingFoodLogId = null; // set while editing an already-logged item (tapped from Today's meals) — routes btnLfSave to an UPDATE instead of an INSERT
let lfEditingOriginal = null; // { logDate, mealSlot, hypoTreatment } the item belonged to when edit opened, so a meal-slot change re-aggregates BOTH the old and new section
let lfCopyYesterdayItems = []; // yesterday's food_log rows for whichever section "+ Add" was just tapped on — populated by updateLfCopyYesterdayButton(), consumed by the button's own click handler
let lfTextItems = []; // Describe mode's parsed items, kept editable in place — [{food_name, serving_desc, calories_kcal, protein_g, carbs_g, fat_g}]

async function loadLogFood() {
  if (el.lfMealSlot) el.lfMealSlot.value = defaultMealSlot();
  resetLfForm();
  selectLfMode(null);
  await Promise.all([renderLfTodayTotals(), renderLfTodayList(), renderLfFavorites()]);
}

el.btnOpenLogFood?.addEventListener('click', () => navigateTo('logFood'));
el.btnLogFoodBack?.addEventListener('click', () => {
  stopBarcodeScan();
  navigateTo('dashboard');
});

/* ── Mode switching ──────────────────────────────────────── */
function selectLfMode(mode) {
  if (lfSelectedMode === 'scan' && mode !== 'scan') stopBarcodeScan();
  lfSelectedMode = mode;
  el.lfModePills?.querySelectorAll('.pill').forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  if (el.lfScanPanel)   el.lfScanPanel.hidden   = mode !== 'scan';
  if (el.lfSearchPanel) el.lfSearchPanel.hidden = mode !== 'search';
  if (el.lfPhotoPanel)  el.lfPhotoPanel.hidden  = mode !== 'photo';
  if (el.lfTextPanel)   el.lfTextPanel.hidden   = mode !== 'text';
  if (mode === 'manual') { resetLfForm(); showLfReviewForm(); }
  else if (el.lfReviewForm) el.lfReviewForm.hidden = true;
  if (mode === 'scan') startBarcodeScan();
}
el.lfModePills?.addEventListener('click', e => {
  const btn = e.target.closest('.pill');
  if (btn) selectLfMode(btn.dataset.mode);
});

function resetLfForm() {
  lfPhotoAngles = [];
  lfPhotoAfterBase64 = null;
  lfPhotoAfterMediaType = null;
  lfSelectedCustomFoodId = null;
  lfPendingBarcode = null;
  lfBaseNutrition = null;
  lfEditingFoodLogId = null;
  lfEditingOriginal = null;
  lfCopyYesterdayItems = [];
  if (el.btnLfCopyYesterday) el.btnLfCopyYesterday.hidden = true;
  if (el.btnLfSave) el.btnLfSave.textContent = 'Log it';
  if (el.lfFoodName) el.lfFoodName.value = '';
  if (el.lfBrand) el.lfBrand.value = '';
  if (el.lfLoggedAt) el.lfLoggedAt.value = toDatetimeLocalValue(new Date());
  if (el.lfPhotoTimeNote) el.lfPhotoTimeNote.hidden = true;
  if (el.lfQuantity) el.lfQuantity.value = '1';
  if (el.lfServingDesc) el.lfServingDesc.value = '';
  if (el.lfCals) el.lfCals.value = '';
  if (el.lfProtein) el.lfProtein.value = '';
  if (el.lfCarbs) el.lfCarbs.value = '';
  if (el.lfFat) el.lfFat.value = '';
  if (el.lfEstimateNote) el.lfEstimateNote.textContent = '';
  if (el.lfSaveStatus) el.lfSaveStatus.textContent = '';
  if (el.lfHypoTreatment) el.lfHypoTreatment.checked = false;
  if (el.lfHypoTreatmentWrap) el.lfHypoTreatmentWrap.hidden = profile?.diabetes_enabled === false;
  if (el.lfSaveAsCustom) el.lfSaveAsCustom.checked = true;
  if (el.lfSaveAsCustomWrap) el.lfSaveAsCustomWrap.hidden = false; // may have been hidden by a scan/search selection — a fresh entry should always offer it
  if (el.lfShare) el.lfShare.checked = false;
  const householdPartner = HOUSEHOLD_PARTNER[currentUser?.id];
  if (el.lfShareWrap) el.lfShareWrap.hidden = !householdPartner;
  if (householdPartner && el.lfShareName) el.lfShareName.textContent = householdPartner.name;
  lfFavToggleActive = false;
  if (el.btnLfFavToggle) { el.btnLfFavToggle.classList.remove('is-active'); el.btnLfFavToggle.setAttribute('aria-pressed', 'false'); }
  renderLfPhotoThumbs();
  if (el.lfPhotoDesc) el.lfPhotoDesc.value = '';
  if (el.lfPhotoInputCamera) el.lfPhotoInputCamera.value = '';
  if (el.lfPhotoInputLibrary) el.lfPhotoInputLibrary.value = '';
  if (el.lfPhotoAfterPreviewWrap) el.lfPhotoAfterPreviewWrap.hidden = true;
  if (el.lfPhotoAfterPreview) el.lfPhotoAfterPreview.src = '';
  if (el.lfPhotoAfterInputCamera) el.lfPhotoAfterInputCamera.value = '';
  if (el.lfPhotoAfterInputLibrary) el.lfPhotoAfterInputLibrary.value = '';
  if (el.btnLfEstimate) el.btnLfEstimate.disabled = true;
  lfTextItems = [];
  if (el.lfTextInput) el.lfTextInput.value = '';
  if (el.lfTextLoggedAt) el.lfTextLoggedAt.value = toDatetimeLocalValue(new Date());
  if (el.lfTextResults) el.lfTextResults.hidden = true;
  if (el.lfTextItems) el.lfTextItems.innerHTML = '';
  if (el.lfTextNote) el.lfTextNote.textContent = '';
  if (el.lfTextEstimateStatus) el.lfTextEstimateStatus.textContent = '';
  if (el.lfTextSaveStatus) el.lfTextSaveStatus.textContent = '';
  if (el.lfTextShare) el.lfTextShare.checked = false;
  if (el.lfTextShareWrap) el.lfTextShareWrap.hidden = !HOUSEHOLD_PARTNER[currentUser?.id];
  if (el.lfTextShareName && HOUSEHOLD_PARTNER[currentUser?.id]) el.lfTextShareName.textContent = HOUSEHOLD_PARTNER[currentUser.id].name;
}
el.btnLfFavToggle?.addEventListener('click', () => {
  lfFavToggleActive = !lfFavToggleActive;
  el.btnLfFavToggle.classList.toggle('is-active', lfFavToggleActive);
  el.btnLfFavToggle.setAttribute('aria-pressed', String(lfFavToggleActive));
});
function showLfReviewForm() {
  if (el.lfReviewForm) el.lfReviewForm.hidden = false;
  el.lfFoodName?.focus();
}

// Opens the review form pre-filled with an already-logged item, tapped
// from a section in Today's meals — lets a quantity/macro typo or a
// wrong meal slot be fixed after the fact instead of delete-and-relog.
// Fields are de-multiplied back to per-serving values (row values are
// quantity * per-serving) since the form always edits per-serving figures
// and re-multiplies on save, same as a fresh manual entry.
function openLfEditItem(row) {
  resetLfForm();
  selectLfMode(null);
  lfEditingFoodLogId = row.id;
  lfEditingOriginal = {
    logDate: (row.logged_at || '').slice(0, 10),
    mealSlot: row.meal_slot,
    hypoTreatment: !!row.hypo_treatment,
  };
  const qty = Number(row.quantity) || 1;
  const perServingCals = Math.round((Number(row.calories_kcal) || 0) / qty);
  const perServingProtein = Math.round((Number(row.protein_g) || 0) / qty * 10) / 10;
  const perServingCarbs = Math.round((Number(row.carbs_g) || 0) / qty * 10) / 10;
  const perServingFat = Math.round((Number(row.fat_g) || 0) / qty * 10) / 10;
  if (el.lfFoodName) el.lfFoodName.value = row.food_name || '';
  if (el.lfBrand) el.lfBrand.value = row.brand || '';
  if (el.lfServingDesc) el.lfServingDesc.value = row.serving_desc || '';
  if (el.lfQuantity) el.lfQuantity.value = qty;
  if (el.lfCals) el.lfCals.value = perServingCals;
  if (el.lfProtein) el.lfProtein.value = perServingProtein;
  if (el.lfCarbs) el.lfCarbs.value = perServingCarbs;
  if (el.lfFat) el.lfFat.value = perServingFat;
  if (el.lfMealSlot) el.lfMealSlot.value = LF_SECTIONS.some(s => s.key === row.meal_slot) ? row.meal_slot : defaultMealSlot();

  // Same rescale-on-edit as a fresh scan/search/favourite pick (see
  // populateLfFormFromFood) — lets editing the serving description of an
  // already-logged item rescale its macros too, not just brand-new entries.
  const baseQty = parseLeadingNumber(row.serving_desc);
  lfBaseNutrition = baseQty ? {
    qty: baseQty,
    calories_kcal: perServingCals,
    protein_g: perServingProtein,
    carbs_g: perServingCarbs,
    fat_g: perServingFat,
  } : null;
  if (el.lfHypoTreatment) el.lfHypoTreatment.checked = !!row.hypo_treatment;
  if (el.lfLoggedAt) el.lfLoggedAt.value = toDatetimeLocalValue(new Date(row.logged_at));
  if (el.lfSaveAsCustomWrap) el.lfSaveAsCustomWrap.hidden = true; // editing an existing entry — not a new reusable food
  if (el.lfSaveAsCustom) el.lfSaveAsCustom.checked = false;
  if (el.btnLfSave) el.btnLfSave.textContent = 'Save changes';
  showLfReviewForm();
  el.lfMealSlot?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ── Barcode scanning ────────────────────────────────────────
   Two decode paths, tried in order:
   1. The native Shape Detection BarcodeDetector API — fast, zero extra
      download, but Safari (iOS and macOS) has never implemented it, so
      this alone leaves every iPhone user stuck on "not supported".
   2. ZXing (@zxing/browser, loaded from a CDN in index.html — see sw.js
      for why that's exempted from the "always refetch" JS rule) — a
      pure-JS decoder that works anywhere getUserMedia does, including
      Safari. Only loaded/used when the native API is missing, so it
      costs nothing on browsers that already have BarcodeDetector. ── */
async function startBarcodeScan() {
  if (!el.lfScanVideo) return;
  const hasNative = 'BarcodeDetector' in window;
  const hasZxingFallback = !hasNative && typeof window.ZXingBrowser !== 'undefined';
  if (!hasNative && !hasZxingFallback) {
    if (el.lfScanUnsupported) el.lfScanUnsupported.hidden = false;
    if (el.lfScanStatus) el.lfScanStatus.hidden = true;
    return;
  }
  if (el.lfScanUnsupported) el.lfScanUnsupported.hidden = true;
  try {
    // No resolution/focus hints previously — left the browser free to pick
    // a low-res, general-purpose default that's fine to look at but often
    // too soft/low-detail for a decoder to actually resolve the bars on,
    // especially up close (the norm for scanning a barcode). `ideal` and
    // `advanced` entries are best-effort — never fail getUserMedia just
    // because a given camera/browser can't honour one.
    lfBarcodeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        advanced: [{ focusMode: 'continuous' }],
      },
    });
    el.lfScanVideo.srcObject = lfBarcodeStream;
    el.lfScanVideo.hidden = false;
    await el.lfScanVideo.play();
    if (el.btnLfScanStop) el.btnLfScanStop.hidden = false;
    if (el.lfScanStatus) { el.lfScanStatus.hidden = false; el.lfScanStatus.textContent = 'Point the camera at a barcode…'; }
    if (hasNative) {
      lfBarcodeDetector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
      scanBarcodeFrame();
    } else {
      const reader = new window.ZXingBrowser.BrowserMultiFormatReader();
      lfZxingScanAttempts = 0;
      lfZxingControls = await reader.decodeFromStream(lfBarcodeStream, el.lfScanVideo, (result, error) => {
        if (result) {
          const barcode = result.getText();
          stopBarcodeScan();
          handleScannedBarcode(barcode);
          return;
        }
        // Fires on every frame, found or not — a miss comes through as
        // `error`, typically NotFoundException, which is the normal,
        // expected case on nearly every single frame mid-scan (no
        // barcode in view yet) and safe to just ignore. Anything else —
        // a genuinely unexpected decode error, not just "haven't found
        // one yet" — was previously silently swallowed here too, along
        // with everything else, giving zero signal to tell "the loop
        // never started" apart from "it's running fine but the barcode
        // itself isn't decodable" (blur, glare, distance, damage — a
        // real-world condition, not a bug). Surfaced now so the next
        // report has something concrete in it either way.
        lfZxingScanAttempts++;
        if (error && error.name !== 'NotFoundException') {
          console.warn('Barcode scan frame error:', error.name, error.message);
          if (el.lfScanStatus) el.lfScanStatus.textContent = `Scan error: ${error.message || error.name}`;
        } else if (lfZxingScanAttempts % 40 === 0) {
          // A periodic heartbeat, not every frame — proves the decode
          // loop is genuinely alive and actively trying, distinguishing
          // "scanning but not finding anything" from a silently dead
          // loop, which looked identical before this (static "Point the
          // camera…" text either way, forever).
          console.log(`Barcode scan: ${lfZxingScanAttempts} frames checked, no match yet.`);
        }
      });
    }
  } catch (err) {
    if (el.lfScanStatus) el.lfScanStatus.textContent = "Couldn't access the camera: " + err.message;
  }
}
function stopBarcodeScan() {
  if (lfBarcodeScanRAF) cancelAnimationFrame(lfBarcodeScanRAF);
  lfBarcodeScanRAF = null;
  lfZxingControls?.stop();
  lfZxingControls = null;
  lfBarcodeStream?.getTracks().forEach(t => t.stop());
  lfBarcodeStream = null;
  if (el.lfScanVideo) { el.lfScanVideo.srcObject = null; el.lfScanVideo.hidden = true; }
  if (el.btnLfScanStop) el.btnLfScanStop.hidden = true;
}
el.btnLfScanStop?.addEventListener('click', () => { stopBarcodeScan(); selectLfMode(null); });

let lfScanBusy = false;
async function scanBarcodeFrame() {
  if (!lfBarcodeStream || !lfBarcodeDetector) return;
  if (!lfScanBusy) {
    lfScanBusy = true;
    try {
      const codes = await lfBarcodeDetector.detect(el.lfScanVideo);
      if (codes.length) {
        const barcode = codes[0].rawValue;
        stopBarcodeScan();
        await handleScannedBarcode(barcode);
        lfScanBusy = false;
        return; // don't reschedule — a barcode was found
      }
    } catch { /* transient detection errors are normal mid-scan — just keep trying */ }
    lfScanBusy = false;
  }
  lfBarcodeScanRAF = requestAnimationFrame(scanBarcodeFrame);
}

async function handleScannedBarcode(barcode) {
  if (el.lfScanStatus) { el.lfScanStatus.hidden = false; el.lfScanStatus.textContent = `Looking up ${barcode}…`; }

  // Check the shared custom-foods list first — instant, no network,
  // and covers anything already added (including a previous scan of
  // this exact product that Open Food Facts didn't have).
  const { data: existing } = await db.from('custom_foods')
    .select('id, name, brand, serving_desc, serving_qty, serving_unit, calories_kcal, protein_g, carbs_g, fat_g')
    .eq('barcode', barcode)
    .limit(1);
  if (existing?.length) {
    populateLfFormFromFood(existing[0], { custom_food_id: existing[0].id, hideSaveAsCustom: true });
    selectLfMode(null); // closes the scan panel, but keep the review form (selectLfMode(null) hides it too — reopen explicitly)
    showLfReviewForm();
    return;
  }

  const off = await fetchOpenFoodFacts(barcode);
  if (off) {
    populateLfFormFromFood(off, { barcode });
    selectLfMode(null);
    showLfReviewForm();
    return;
  }

  showToast(`Barcode ${barcode} not found — add it manually and it'll be remembered next time.`);
  resetLfForm();
  if (el.lfServingDesc) el.lfServingDesc.value = '100g';
  lfPendingBarcode = barcode;
  selectLfMode(null);
  showLfReviewForm();
}

async function fetchOpenFoodFacts(barcode) {
  try {
    const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,nutriments`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 1 || !data.product) return null;
    const n = data.product.nutriments || {};
    const cals = n['energy-kcal_100g'] ?? (n['energy_100g'] != null ? n['energy_100g'] / 4.184 : null);
    if (cals == null) return null; // no usable nutrition data — treat as not found
    return {
      name: data.product.product_name || 'Unknown product',
      brand: data.product.brands || null,
      serving_desc: '100g',
      serving_qty: 100,
      serving_unit: 'g',
      calories_kcal: Math.round(cals),
      protein_g: Math.round((n.proteins_100g || 0) * 10) / 10,
      carbs_g: Math.round((n.carbohydrates_100g || 0) * 10) / 10,
      fat_g: Math.round((n.fat_100g || 0) * 10) / 10,
      barcode,
    };
  } catch {
    return null;
  }
}

// Favourites and manually-typed servings don't carry a separate numeric
// serving_qty column (only scan/search results do) — falls back to the
// leading number in the serving-description text itself (e.g. "150g" -> 150,
// "1 cup" -> 1), so the rescale-on-edit below still has a base to work from.
function parseLeadingNumber(str) {
  const m = /^([\d.]+)/.exec(String(str || '').trim());
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function populateLfFormFromFood(food, opts = {}) {
  lfSelectedCustomFoodId = opts.custom_food_id || null;
  if (el.lfFoodName) el.lfFoodName.value = food.name || '';
  if (el.lfBrand) el.lfBrand.value = food.brand || '';
  if (el.lfQuantity) el.lfQuantity.value = '1';
  if (el.lfServingDesc) el.lfServingDesc.value = food.serving_desc || '';
  if (el.lfCals) el.lfCals.value = food.calories_kcal ?? '';
  if (el.lfProtein) el.lfProtein.value = food.protein_g ?? '';
  if (el.lfCarbs) el.lfCarbs.value = food.carbs_g ?? '';
  if (el.lfFat) el.lfFat.value = food.fat_g ?? '';
  if (el.lfEstimateNote) el.lfEstimateNote.textContent = '';
  if (el.lfSaveAsCustomWrap) el.lfSaveAsCustomWrap.hidden = !!opts.hideSaveAsCustom;
  lfPendingBarcode = opts.barcode || null;

  const explicitQty = Number(food.serving_qty);
  const baseQty = Number.isFinite(explicitQty) && explicitQty > 0 ? explicitQty : parseLeadingNumber(food.serving_desc);
  lfBaseNutrition = baseQty ? {
    qty: baseQty,
    calories_kcal: Number(food.calories_kcal) || 0,
    protein_g: Number(food.protein_g) || 0,
    carbs_g: Number(food.carbs_g) || 0,
    fat_g: Number(food.fat_g) || 0,
  } : null;
}

// Editing Serving size after a scan/search/favourite selection (e.g.
// "100g" -> "50g") rescales Calories/Protein/Carbs/Fat proportionally,
// rather than leaving them stuck at the originally-populated figures. Only
// active when lfBaseNutrition is set — a serving description with no
// leading number at all (e.g. "estimated meal", "handful") has nothing to
// scale from and leaves the fields untouched, same as before.
el.lfServingDesc?.addEventListener('input', () => {
  if (!lfBaseNutrition) return;
  const m = /^([\d.]+)/.exec(el.lfServingDesc.value.trim());
  if (!m) return;
  const amount = Number(m[1]);
  if (!Number.isFinite(amount) || amount <= 0) return;
  const factor = amount / lfBaseNutrition.qty;
  if (el.lfCals) el.lfCals.value = Math.round(lfBaseNutrition.calories_kcal * factor);
  if (el.lfProtein) el.lfProtein.value = Math.round(lfBaseNutrition.protein_g * factor * 10) / 10;
  if (el.lfCarbs) el.lfCarbs.value = Math.round(lfBaseNutrition.carbs_g * factor * 10) / 10;
  if (el.lfFat) el.lfFat.value = Math.round(lfBaseNutrition.fat_g * factor * 10) / 10;
});

/* ── Search mode ──────────────────────────────────────────────
   Two sources, queried in parallel: custom_foods (the household's own
   previously scanned/added items — instant, no network beyond Supabase)
   and Open Food Facts' public product database via food-search.js (a
   common product neither of them had ever scanned before, e.g. a
   specific juice/smoothie, used to always come back "No matches" even
   though OFF almost certainly has it). Shown as two labeled groups
   rather than merged into one list, since "already in your list" vs
   "new from Open Food Facts" changes what saving it will do. ────── */
let lfSearchDebounce = null;
el.lfSearchInput?.addEventListener('input', () => {
  clearTimeout(lfSearchDebounce);
  const q = el.lfSearchInput.value.trim();
  lfSearchDebounce = setTimeout(() => runLfSearch(q), 300);
});

function lfSearchResultButton(f, source, id) {
  return `<button type="button" class="lf-search-result" data-source="${source}" data-id="${id}">
    <span class="lf-search-result__name">${escapeHtml(f.name)}${f.brand ? ` <span class="lf-search-result__brand">${escapeHtml(f.brand)}</span>` : ''}</span>
    <span class="lf-search-result__cals">${Math.round(f.calories_kcal)} kcal</span>
  </button>`;
}

async function runLfSearch(query) {
  if (!el.lfSearchResults) return;
  if (query.length < 2) { el.lfSearchResults.innerHTML = ''; return; }

  const [customRes, offRes] = await Promise.all([
    db.from('custom_foods')
      .select('id, name, brand, serving_desc, serving_qty, serving_unit, calories_kcal, protein_g, carbs_g, fat_g')
      .or(`name.ilike.%${query}%,brand.ilike.%${query}%`)
      .order('name', { ascending: true })
      .limit(20),
    fetch(`${FUNCTIONS_ORIGIN}/food-search?q=${encodeURIComponent(query)}`, { headers: FUNCTIONS_ANON_HEADERS })
      .then(r => (r.ok ? r.json() : { results: [] }))
      .catch(() => ({ results: [] })),
  ]);

  const customFoods = customRes.data || [];
  const offFoods = offRes.results || [];

  if (!customFoods.length && !offFoods.length) {
    el.lfSearchResults.innerHTML = '<p class="empty-state">No matches — try Photo or Manual instead.</p>';
    return;
  }

  el.lfSearchResults.innerHTML = [
    customFoods.length ? `<p class="field-hint" style="margin:10px 0 4px">Your foods</p>${customFoods.map(f => lfSearchResultButton(f, 'custom', f.id)).join('')}` : '',
    offFoods.length ? `<p class="field-hint" style="margin:10px 0 4px">Open Food Facts</p>${offFoods.map((f, i) => lfSearchResultButton(f, 'off', i)).join('')}` : '',
  ].join('');

  el.lfSearchResults.querySelectorAll('.lf-search-result').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.source === 'custom') {
        const food = customFoods.find(f => f.id === btn.dataset.id);
        if (!food) return;
        populateLfFormFromFood(food, { custom_food_id: food.id, hideSaveAsCustom: true });
      } else {
        const food = offFoods[Number(btn.dataset.id)];
        if (!food) return;
        populateLfFormFromFood(food, { barcode: food.barcode }); // not yet in custom_foods — offers "Save to shared list", same as a fresh scan
      }
      showLfReviewForm();
    });
  });
}

/* ── EXIF capture-time extraction ────────────────────────────
   Reads DateTimeOriginal straight out of the JPEG's own EXIF bytes — no
   library, just walking the APP1/TIFF segment structure by hand (same
   "no external deps" approach as the rest of this app). Has to run on
   the ORIGINAL file, before resizeImageToBase64's canvas round-trip,
   since re-encoding through <canvas> always strips EXIF entirely. Only
   reads the first 256KB (EXIF always lives right after the JPEG SOI
   marker, long before any actual image data) so this stays cheap even
   on a full-resolution photo. */
function readExifDateTaken(file) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const view = new DataView(reader.result);
        if (view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return resolve(null); // not a JPEG
        let offset = 2;
        while (offset + 4 <= view.byteLength) {
          const marker = view.getUint16(offset, false);
          if ((marker & 0xFF00) !== 0xFF00) break;
          if (marker === 0xFFDA) break; // start of scan — no more metadata segments follow
          const segLen = view.getUint16(offset + 2, false);
          if (marker === 0xFFE1 && offset + 4 + 6 <= view.byteLength) {
            const exifStart = offset + 4;
            if (view.getUint32(exifStart, false) === 0x45786966 && view.getUint16(exifStart + 4, false) === 0x0000) {
              return resolve(readExifDateFromTiff(view, exifStart + 6));
            }
          }
          offset += 2 + segLen;
        }
        resolve(null);
      } catch {
        resolve(null); // malformed/truncated segment — just skip the prefill, never block logging
      }
    };
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file.slice(0, 256 * 1024));
  });
}

function readExifDateFromTiff(view, tiffStart) {
  const bom = view.getUint16(tiffStart, false);
  if (bom !== 0x4949 && bom !== 0x4D4D) return null;
  const little = bom === 0x4949;
  const get16 = o => view.getUint16(o, little);
  const get32 = o => view.getUint32(o, little);
  const readAscii = (offset, count) => {
    let s = '';
    for (let i = 0; i < count - 1; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  const readIFD = ifdOffset => {
    const entries = [];
    const count = get16(ifdOffset);
    for (let i = 0; i < count; i++) {
      const entryOffset = ifdOffset + 2 + i * 12;
      const tag = get16(entryOffset);
      const type = get16(entryOffset + 2);
      const valCount = get32(entryOffset + 4);
      const valueOffset = entryOffset + 8;
      entries.push({ tag, type, count: valCount, valueOffset });
    }
    return entries;
  };
  const stringTag = (entries, tag) => {
    const e = entries.find(x => x.tag === tag && x.type === 2);
    if (!e) return null;
    const strOffset = e.count <= 4 ? e.valueOffset : tiffStart + get32(e.valueOffset);
    return readAscii(strOffset, e.count);
  };

  const ifd0 = readIFD(tiffStart + get32(tiffStart + 4));
  const exifPtr = ifd0.find(x => x.tag === 0x8769);
  if (exifPtr) {
    const subEntries = readIFD(tiffStart + get32(exifPtr.valueOffset));
    const original = stringTag(subEntries, 0x9003); // DateTimeOriginal
    if (original) return original;
  }
  return stringTag(ifd0, 0x0132); // DateTime — IFD0 fallback
}

// EXIF dates are "YYYY:MM:DD HH:MM:SS", the camera's own local wall-clock
// time with no reliable timezone info attached — treated as local time
// here, same as reading it off the camera's own clock display would be.
function parseExifDateTime(str) {
  if (!str) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (Number.isNaN(dt.getTime())) return null;
  // An unset/wrong camera clock is common enough to guard against —
  // silently skip the prefill rather than set a nonsense logged time.
  const now = Date.now();
  if (dt.getTime() > now + 5 * 60000 || dt.getTime() < now - 5 * 365 * 24 * 3600000) return null;
  return dt;
}

function toDatetimeLocalValue(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function lfFormatPhotoTime(d) {
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = d.toDateString() === new Date().toDateString();
  const dayLabel = isToday ? 'today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  return `${dayLabel} at ${time}`;
}

/* ── Photo mode — two separate inputs share this handler: the camera
   one (capture="environment") for a photo taken right now, the library
   one (no capture attribute) for picking an existing photo — e.g.
   logging a meal after the fact from a photo taken earlier. Either way,
   the photo's own EXIF capture time (when present) prefills "Logged at"
   in the review form — the point of the whole feature: what the pump/
   Nightscout timeline lines this meal up against should be when it was
   actually eaten, not whenever the user got around to logging it. ── */
async function handleLfPhotoInputChange(inputEl) {
  const file = inputEl.files?.[0];
  inputEl.value = ''; // clear so picking the same file again for another angle still fires 'change'
  if (!file) return;
  if (lfPhotoAngles.length >= LF_PHOTO_MAX_ANGLES) return;
  try {
    const isFirstPhoto = lfPhotoAngles.length === 0;
    const [{ base64, mediaType, dataUrl }, exifDateStr] = await Promise.all([
      resizeImageToBase64(file),
      isFirstPhoto ? readExifDateTaken(file) : Promise.resolve(null),
    ]);
    lfPhotoAngles.push({ base64, mediaType, dataUrl });
    renderLfPhotoThumbs();
    if (el.btnLfEstimate) el.btnLfEstimate.disabled = false;

    // Only the first photo's capture time seeds "Logged at" — later
    // angles are the same meal, not a new one.
    if (isFirstPhoto) {
      const takenAt = parseExifDateTime(exifDateStr);
      if (takenAt) {
        if (el.lfLoggedAt) el.lfLoggedAt.value = toDatetimeLocalValue(takenAt);
        if (el.lfPhotoTimeNote) {
          el.lfPhotoTimeNote.hidden = false;
          el.lfPhotoTimeNote.textContent = `📷 Photo taken ${lfFormatPhotoTime(takenAt)} — set as the logged time (adjust above if needed)`;
        }
      } else if (el.lfPhotoTimeNote) {
        el.lfPhotoTimeNote.hidden = true;
      }
    }
  } catch (err) {
    showToast("Couldn't read that photo: " + err.message, true);
  }
}
el.lfPhotoInputCamera?.addEventListener('change', () => handleLfPhotoInputChange(el.lfPhotoInputCamera));
el.lfPhotoInputLibrary?.addEventListener('change', () => handleLfPhotoInputChange(el.lfPhotoInputLibrary));

// Renders the thumbnail strip for the (up to 3) "before" angle photos,
// each with a ✕ to remove it, and hides the add-photo buttons once the
// cap is reached.
function renderLfPhotoThumbs() {
  if (el.lfPhotoThumbs) {
    el.lfPhotoThumbs.hidden = lfPhotoAngles.length === 0;
    el.lfPhotoThumbs.innerHTML = lfPhotoAngles.map((p, i) => `
      <div style="position:relative">
        <img src="${p.dataUrl}" style="width:72px;height:72px;object-fit:cover;border-radius:var(--r-md);display:block">
        <button type="button" class="lf-photo-thumb-remove" data-idx="${i}" aria-label="Remove photo" style="position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:var(--danger,#c0392b);color:#fff;border:none;font-size:12px;line-height:1;cursor:pointer">✕</button>
      </div>
    `).join('');
  }
  // lfPhotoButtons carries an inline `style="display:flex"` (index.html),
  // which beats the `[hidden]{display:none}` UA rule — so the `hidden`
  // IDL property alone wouldn't actually hide it; toggle display directly.
  if (el.lfPhotoButtons) el.lfPhotoButtons.style.display = lfPhotoAngles.length >= LF_PHOTO_MAX_ANGLES ? 'none' : 'flex';
}
el.lfPhotoThumbs?.addEventListener('click', e => {
  const btn = e.target.closest('.lf-photo-thumb-remove');
  if (!btn) return;
  lfPhotoAngles.splice(Number(btn.dataset.idx), 1);
  renderLfPhotoThumbs();
  if (el.btnLfEstimate) el.btnLfEstimate.disabled = lfPhotoAngles.length === 0;
});

// Optional "after eating" photo of the leftovers — same resize/read
// path as the main photo, but stored separately and only sent to the
// estimator when present (see btnLfEstimate below), so a before/after
// pair estimates what was actually eaten rather than the whole plate.
async function handleLfPhotoAfterInputChange(inputEl) {
  const file = inputEl.files?.[0];
  if (!file) return;
  try {
    const { base64, mediaType, dataUrl } = await resizeImageToBase64(file);
    lfPhotoAfterBase64 = base64;
    lfPhotoAfterMediaType = mediaType;
    if (el.lfPhotoAfterPreview) el.lfPhotoAfterPreview.src = dataUrl;
    if (el.lfPhotoAfterPreviewWrap) el.lfPhotoAfterPreviewWrap.hidden = false;
  } catch (err) {
    showToast("Couldn't read that photo: " + err.message, true);
  }
}
el.lfPhotoAfterInputCamera?.addEventListener('change', () => handleLfPhotoAfterInputChange(el.lfPhotoAfterInputCamera));
el.lfPhotoAfterInputLibrary?.addEventListener('change', () => handleLfPhotoAfterInputChange(el.lfPhotoAfterInputLibrary));
el.btnLfPhotoAfterClear?.addEventListener('click', () => {
  lfPhotoAfterBase64 = null;
  lfPhotoAfterMediaType = null;
  if (el.lfPhotoAfterPreviewWrap) el.lfPhotoAfterPreviewWrap.hidden = true;
  if (el.lfPhotoAfterPreview) el.lfPhotoAfterPreview.src = '';
  if (el.lfPhotoAfterInputCamera) el.lfPhotoAfterInputCamera.value = '';
  if (el.lfPhotoAfterInputLibrary) el.lfPhotoAfterInputLibrary.value = '';
});

// Downscales to a max 1024px side and re-encodes as JPEG — keeps the
// upload small/cheap regardless of the original photo's resolution,
// comfortably under the function's own size cap.
function resizeImageToBase64(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const MAX = 1024;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      resolve({ base64: dataUrl.split(',')[1], mediaType: 'image/jpeg', dataUrl });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not load image')); };
    img.src = url;
  });
}

el.btnLfEstimate?.addEventListener('click', async () => {
  if (lfPhotoAngles.length === 0) return;
  setBtn(el.btnLfEstimate, true, 'Estimate calories & macros', 'Estimating…');
  if (el.lfEstimateStatus) el.lfEstimateStatus.textContent = '';
  try {
    const session = (await db.auth.getSession()).data.session;
    const res = await fetch(`${FUNCTIONS_ORIGIN}/food-photo-estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({
        // Up to 3 photos of the same meal from different angles.
        images: lfPhotoAngles.map(p => ({ base64: p.base64, media_type: p.mediaType })),
        description: el.lfPhotoDesc?.value || '',
        // Optional leftovers photo — when present, the server estimates
        // what was actually eaten (before minus after) instead of the
        // whole plate as served.
        image_base64_after: lfPhotoAfterBase64 || undefined,
        media_type_after: lfPhotoAfterMediaType || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (el.lfEstimateStatus) el.lfEstimateStatus.textContent = data.error || 'Estimate failed.';
      return;
    }
    lfSelectedCustomFoodId = null;
    // A read title (from a nutrition-label screenshot) beats the photo
    // description as the food name — it's the actual name of the thing,
    // not just whatever the person typed as a caption.
    if (el.lfFoodName && (!el.lfFoodName.value || data.food_name)) el.lfFoodName.value = data.food_name || el.lfPhotoDesc?.value?.slice(0, 60) || 'Photo estimate';
    if (el.lfQuantity) el.lfQuantity.value = '1';
    if (el.lfServingDesc) el.lfServingDesc.value = data.food_name ? '1 serving' : 'estimated meal';
    if (el.lfCals) el.lfCals.value = data.calories_kcal;
    if (el.lfProtein) el.lfProtein.value = data.protein_g;
    if (el.lfCarbs) el.lfCarbs.value = data.carbs_g;
    if (el.lfFat) el.lfFat.value = data.fat_g;
    if (el.lfEstimateNote) {
      el.lfEstimateNote.textContent = data.food_name
        ? `Read from label (${data.confidence} confidence): ${data.note || 'no notes'} — review and adjust before saving.`
        : `Claude's estimate (${data.confidence} confidence): ${data.note || 'no notes'} — review and adjust before saving.`;
    }
    if (el.lfSaveAsCustomWrap) el.lfSaveAsCustomWrap.hidden = false;
    if (el.lfSaveAsCustom) el.lfSaveAsCustom.checked = false; // a one-off estimated meal usually isn't worth saving as a reusable food
    showLfReviewForm();
  } catch (err) {
    if (el.lfEstimateStatus) el.lfEstimateStatus.textContent = "Couldn't reach the estimator: " + err.message;
  } finally {
    setBtn(el.btnLfEstimate, false, 'Estimate calories & macros');
  }
});

/* ── Describe mode ───────────────────────────────────────── */
// One parsed item behaves exactly like a photo/scan/search result — it
// drops into the shared review form, so favourites, "save to food list",
// hypo and share all keep working. Several items can't: the review form
// edits one food at a time, so they get their own list with the same
// numbers editable in place, saved as one food_log row each.
el.btnLfTextEstimate?.addEventListener('click', async () => {
  const text = el.lfTextInput?.value.trim();
  if (!text) {
    if (el.lfTextEstimateStatus) el.lfTextEstimateStatus.textContent = 'Describe what you ate first.';
    return;
  }
  setBtn(el.btnLfTextEstimate, true, 'Estimate calories & macros', 'Estimating…');
  if (el.lfTextEstimateStatus) el.lfTextEstimateStatus.textContent = '';
  try {
    const session = (await db.auth.getSession()).data.session;
    const res = await fetch(`${FUNCTIONS_ORIGIN}/food-text-estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
      body: JSON.stringify({ text }),
    });
    const data = await res.json();
    if (!res.ok) {
      if (el.lfTextEstimateStatus) el.lfTextEstimateStatus.textContent = data.error || 'Estimate failed.';
      return;
    }
    const noteText = `Claude's estimate (${data.confidence} confidence): ${data.note || 'no notes'} — review and adjust before saving.`;

    if (data.items.length === 1) {
      const item = data.items[0];
      lfSelectedCustomFoodId = null;
      lfTextItems = [];
      if (el.lfTextResults) el.lfTextResults.hidden = true;
      if (el.lfFoodName) el.lfFoodName.value = item.food_name;
      if (el.lfQuantity) el.lfQuantity.value = '1';
      if (el.lfServingDesc) el.lfServingDesc.value = item.serving_desc || '';
      if (el.lfCals) el.lfCals.value = item.calories_kcal;
      if (el.lfProtein) el.lfProtein.value = item.protein_g;
      if (el.lfCarbs) el.lfCarbs.value = item.carbs_g;
      if (el.lfFat) el.lfFat.value = item.fat_g;
      if (el.lfLoggedAt && el.lfTextLoggedAt?.value) el.lfLoggedAt.value = el.lfTextLoggedAt.value;
      if (el.lfEstimateNote) el.lfEstimateNote.textContent = noteText;
      if (el.lfSaveAsCustomWrap) el.lfSaveAsCustomWrap.hidden = false;
      if (el.lfSaveAsCustom) el.lfSaveAsCustom.checked = false; // a one-off estimate usually isn't worth saving as a reusable food
      showLfReviewForm();
      return;
    }

    lfTextItems = data.items;
    if (el.lfReviewForm) el.lfReviewForm.hidden = true;
    if (el.lfTextNote) el.lfTextNote.textContent = noteText;
    if (el.lfTextSaveStatus) el.lfTextSaveStatus.textContent = '';
    renderLfTextItems();
    if (el.lfTextResults) el.lfTextResults.hidden = false;
  } catch (err) {
    if (el.lfTextEstimateStatus) el.lfTextEstimateStatus.textContent = "Couldn't reach the estimator: " + err.message;
  } finally {
    setBtn(el.btnLfTextEstimate, false, 'Estimate calories & macros');
  }
});

const LF_TEXT_MACRO_FIELDS = [
  { key: 'calories_kcal', label: 'kcal', step: '1' },
  { key: 'carbs_g', label: 'Carbs', step: '0.1' },
  { key: 'fat_g', label: 'Fat', step: '0.1' },
  { key: 'protein_g', label: 'Protein', step: '0.1' },
];

function renderLfTextItems() {
  if (!el.lfTextItems) return;
  if (!lfTextItems.length) {
    el.lfTextItems.innerHTML = '<p class="empty-state">No items left.</p>';
    if (el.lfTextTotal) el.lfTextTotal.textContent = '';
    return;
  }
  el.lfTextItems.innerHTML = lfTextItems.map((item, idx) => `
    <div class="lf-text-item" data-idx="${idx}">
      <div class="lf-text-item__head">
        <input type="text" class="lf-text-item__name" data-field="food_name" value="${escapeHtml(item.food_name)}">
        <button type="button" class="lf-text-item__remove" data-remove="${idx}" aria-label="Remove ${escapeHtml(item.food_name)}">✕</button>
      </div>
      ${item.serving_desc ? `<div class="lf-text-item__serving">${escapeHtml(item.serving_desc)}</div>` : ''}
      <div class="lf-text-item__macros">
        ${LF_TEXT_MACRO_FIELDS.map(f => `
          <label>${f.label}
            <input type="number" min="0" step="${f.step}" inputmode="decimal" data-field="${f.key}" value="${item[f.key]}">
          </label>`).join('')}
      </div>
    </div>`).join('');
  renderLfTextTotal();
}

function renderLfTextTotal() {
  if (!el.lfTextTotal) return;
  const t = lfTextItems.reduce((acc, it) => ({
    cals: acc.cals + (Number(it.calories_kcal) || 0),
    carbs: acc.carbs + (Number(it.carbs_g) || 0),
    fat: acc.fat + (Number(it.fat_g) || 0),
    protein: acc.protein + (Number(it.protein_g) || 0),
  }), { cals: 0, carbs: 0, fat: 0, protein: 0 });
  const r1 = n => Math.round(n * 10) / 10;
  el.lfTextTotal.innerHTML = `<span>${lfTextItems.length} item${lfTextItems.length === 1 ? '' : 's'} · ${Math.round(t.cals)} kcal</span>`
    + `<span class="lf-text-total__macros">${r1(t.carbs)}g C · ${r1(t.fat)}g F · ${r1(t.protein)}g P</span>`;
}

el.lfTextItems?.addEventListener('input', e => {
  const input = e.target.closest('[data-field]');
  if (!input) return;
  const idx = Number(input.closest('.lf-text-item')?.dataset.idx);
  const item = lfTextItems[idx];
  if (!item) return;
  const field = input.dataset.field;
  item[field] = field === 'food_name' ? input.value : (Number(input.value) || 0);
  if (field !== 'food_name') renderLfTextTotal();
});

el.lfTextItems?.addEventListener('click', e => {
  const btn = e.target.closest('[data-remove]');
  if (!btn) return;
  lfTextItems.splice(Number(btn.dataset.remove), 1);
  renderLfTextItems();
});

el.btnLfTextCancel?.addEventListener('click', () => { resetLfForm(); selectLfMode(null); });

el.btnLfTextSave?.addEventListener('click', async () => {
  if (!currentUser || !lfTextItems.length) return;
  const usable = lfTextItems.filter(it => it.food_name.trim() && (Number(it.calories_kcal) || 0) > 0);
  if (!usable.length) {
    if (el.lfTextSaveStatus) el.lfTextSaveStatus.textContent = 'Each item needs a name and calories.';
    return;
  }
  const mealSlot = el.lfMealSlot?.value || defaultMealSlot();
  const loggedAtInput = el.lfTextLoggedAt?.value ? new Date(el.lfTextLoggedAt.value) : null;
  const loggedAt = loggedAtInput && !Number.isNaN(loggedAtInput.getTime()) ? loggedAtInput : new Date();
  const logDate = loggedAt.toISOString().slice(0, 10);
  const wantsShare = !!el.lfTextShare?.checked && !!HOUSEHOLD_PARTNER[currentUser.id];

  setBtn(el.btnLfTextSave, true, 'Log all', 'Saving…');
  try {
    const rows = usable.map(it => ({
      user_id: currentUser.id,
      log_date: logDate,
      logged_at: loggedAt.toISOString(),
      meal_slot: mealSlot,
      source: 'text',
      food_name: it.food_name.trim(),
      serving_desc: it.serving_desc || null,
      quantity: 1,
      calories_kcal: Math.round(Number(it.calories_kcal) || 0),
      protein_g: Math.round((Number(it.protein_g) || 0) * 10) / 10,
      carbs_g: Math.round((Number(it.carbs_g) || 0) * 10) / 10,
      fat_g: Math.round((Number(it.fat_g) || 0) * 10) / 10,
      estimate_note: el.lfTextNote?.textContent || null,
      hypo_treatment: false,
    }));
    const { data: saved, error } = await db.from('food_log').insert(rows).select('id');
    if (error) {
      if (el.lfTextSaveStatus) el.lfTextSaveStatus.textContent = "Couldn't save: " + error.message;
      return;
    }

    // Snacks are dosed per item, so each row needs its own bridge call.
    // Every other slot aggregates the whole section from food_log, so one
    // call after all the rows are in re-sums the lot — running it per row
    // would just repeat the same full re-sum N times.
    let dxBridgeError = null;
    if (profile?.diabetes_enabled !== false) {
      const bridgeItem = i => ({
        food_name: rows[i].food_name,
        carbs_g: rows[i].carbs_g,
        fat_g: rows[i].fat_g,
        protein_g: rows[i].protein_g,
        logged_at: rows[i].logged_at,
      });
      if (mealSlot === 'snack') {
        for (let i = 0; i < rows.length; i++) {
          const { error: e } = await bridgeLfMealChange(logDate, mealSlot, false, saved[i].id, bridgeItem(i));
          if (e) dxBridgeError = e;
        }
      } else {
        const last = rows.length - 1;
        const { error: e } = await bridgeLfMealChange(logDate, mealSlot, false, saved[last].id, bridgeItem(last));
        if (e) dxBridgeError = e;
      }
    }

    let shareError = null;
    if (wantsShare) {
      try {
        const session = (await db.auth.getSession()).data.session;
        for (const row of rows) {
          const shareRes = await fetch(`${FUNCTIONS_ORIGIN}/share-food-log`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
            body: JSON.stringify({
              log_date: row.log_date, logged_at: row.logged_at, meal_slot: row.meal_slot,
              food_name: row.food_name, brand: null, serving_desc: row.serving_desc,
              quantity: 1,
              calories_kcal: row.calories_kcal, protein_g: row.protein_g, carbs_g: row.carbs_g, fat_g: row.fat_g,
              barcode: null,
            }),
          });
          if (!shareRes.ok) {
            const errData = await shareRes.json().catch(() => ({}));
            shareError = errData.error || `HTTP ${shareRes.status}`;
          }
        }
      } catch (err) {
        shareError = err.message;
      }
    }

    const label = `${rows.length} item${rows.length === 1 ? '' : 's'}`;
    resetLfForm();
    selectLfMode(null);
    await Promise.all([renderLfTodayTotals(), renderLfTodayList(), renderLfFavorites()]);
    if (shareError) {
      showToast(`Logged ${label}, but couldn't share: ${shareError}`, true);
    } else if (dxBridgeError) {
      showToast(`Logged ${label}, but it won't show in the dose calculator: ${dxBridgeError}`, true);
    } else if (wantsShare) {
      showToast(`Logged ${label} — shared with ${HOUSEHOLD_PARTNER[currentUser.id].name}.`);
    } else {
      showToast(`Logged ${label}.`);
    }
  } finally {
    setBtn(el.btnLfTextSave, false, 'Log all');
  }
});

/* ── Save ────────────────────────────────────────────────── */
el.btnLfCancel?.addEventListener('click', () => { resetLfForm(); selectLfMode(null); });

el.btnLfSave?.addEventListener('click', async () => {
  if (!currentUser) return;
  const name = el.lfFoodName?.value.trim();
  const quantity = Number(el.lfQuantity?.value) || 1;
  const baseCals = Number(el.lfCals?.value) || 0;
  const baseProtein = Number(el.lfProtein?.value) || 0;
  const baseCarbs = Number(el.lfCarbs?.value) || 0;
  const baseFat = Number(el.lfFat?.value) || 0;
  if (!name || baseCals <= 0) {
    if (el.lfSaveStatus) el.lfSaveStatus.textContent = 'Enter a food name and calories first.';
    return;
  }
  const mealSlot = el.lfMealSlot?.value || defaultMealSlot();
  const brand = el.lfBrand?.value.trim() || null;
  const servingDesc = el.lfServingDesc?.value.trim() || null;
  const hypoTreatment = !!el.lfHypoTreatment?.checked;
  const wantsShare = !!el.lfShare?.checked && !!HOUSEHOLD_PARTNER[currentUser.id];

  // Editing an already-logged item (tapped from Today's meals) updates
  // that row in place instead of inserting a new one — a separate, much
  // simpler path than the fresh-entry flow below since none of the
  // custom-food/favourite/share side effects apply to fixing a typo.
  if (lfEditingFoodLogId) {
    setBtn(el.btnLfSave, true, 'Save changes', 'Saving…');
    try {
      const loggedAtInput = el.lfLoggedAt?.value ? new Date(el.lfLoggedAt.value) : null;
      const loggedAt = loggedAtInput && !Number.isNaN(loggedAtInput.getTime()) ? loggedAtInput : new Date();
      const logDate = loggedAt.toISOString().slice(0, 10);
      const { error } = await db.from('food_log').update({
        log_date: logDate,
        logged_at: loggedAt.toISOString(),
        meal_slot: mealSlot,
        food_name: name, brand, serving_desc: servingDesc,
        quantity,
        calories_kcal: Math.round(baseCals * quantity),
        protein_g: Math.round(baseProtein * quantity * 10) / 10,
        carbs_g: Math.round(baseCarbs * quantity * 10) / 10,
        fat_g: Math.round(baseFat * quantity * 10) / 10,
        hypo_treatment: hypoTreatment,
      }).eq('id', lfEditingFoodLogId);
      if (error) {
        if (el.lfSaveStatus) el.lfSaveStatus.textContent = "Couldn't save: " + error.message;
        return;
      }

      // Re-sync the section this item lands in — and, if the date, meal
      // slot or hypo flag changed, the section it USED to belong to as
      // well. For an aggregated section that's a full re-sum from
      // scratch; for Snacks it's this one item's own dose row — the old
      // section gets `item: null` since by now food_log already reflects
      // the NEW section, not the one being cleaned up (see
      // upsertDiabetesMealItem's comment).
      let dxBridgeError = null;
      if (profile?.diabetes_enabled !== false) {
        const orig = lfEditingOriginal;
        const moved = orig && (orig.logDate !== logDate || orig.mealSlot !== mealSlot || orig.hypoTreatment !== hypoTreatment);
        if (moved) {
          const { error: oldErr } = await bridgeLfMealChange(orig.logDate, orig.mealSlot, orig.hypoTreatment, lfEditingFoodLogId, null);
          if (oldErr) dxBridgeError = oldErr;
        }
        const itemForBridge = {
          food_name: name,
          carbs_g: Math.round(baseCarbs * quantity * 10) / 10,
          fat_g: Math.round(baseFat * quantity * 10) / 10,
          protein_g: Math.round(baseProtein * quantity * 10) / 10,
          logged_at: loggedAt.toISOString(),
        };
        const { error: bridgeErr } = await bridgeLfMealChange(logDate, mealSlot, hypoTreatment, lfEditingFoodLogId, itemForBridge);
        if (bridgeErr) dxBridgeError = bridgeErr;
      }

      resetLfForm();
      selectLfMode(null);
      await Promise.all([renderLfTodayTotals(), renderLfTodayList(), renderLfFavorites()]);
      if (dxBridgeError) {
        showToast(`Saved ${name}, but it won't show in the dose calculator: ${dxBridgeError}`, true);
      } else {
        showToast(`Saved ${name}.`);
      }
    } finally {
      setBtn(el.btnLfSave, false, lfEditingFoodLogId ? 'Save changes' : 'Log it');
    }
    return;
  }

  setBtn(el.btnLfSave, true, 'Log it', 'Saving…');
  try {
    let customFoodId = lfSelectedCustomFoodId;
    if (!customFoodId && el.lfSaveAsCustom?.checked) {
      const { data: saved, error: saveErr } = await db.from('custom_foods').insert({
        user_id: currentUser.id, name, brand,
        barcode: lfPendingBarcode, serving_desc: servingDesc,
        serving_qty: 1, serving_unit: 'serving',
        calories_kcal: baseCals, protein_g: baseProtein, carbs_g: baseCarbs, fat_g: baseFat,
      }).select('id').single();
      if (!saveErr) customFoodId = saved?.id || null;
    }

    // datetime-local's value parses as local wall-clock time, which is
    // exactly what we want whether it came from the user typing it or
    // from a photo's EXIF capture time — falls back to now for a blank/
    // unparseable value rather than blocking the save over it.
    const loggedAtInput = el.lfLoggedAt?.value ? new Date(el.lfLoggedAt.value) : null;
    const loggedAt = loggedAtInput && !Number.isNaN(loggedAtInput.getTime()) ? loggedAtInput : new Date();
    const logDate = loggedAt.toISOString().slice(0, 10);
    const { data: savedFoodLog, error } = await db.from('food_log').insert({
      user_id: currentUser.id,
      log_date: logDate,
      logged_at: loggedAt.toISOString(),
      meal_slot: mealSlot,
      source: lfSelectedCustomFoodId ? (lfSelectedMode === 'search' ? 'search' : 'scan') : (lfPhotoAngles.length > 0 ? 'photo' : (lfPendingBarcode ? 'scan' : (lfSelectedMode === 'text' ? 'text' : 'manual'))),
      food_name: name, brand, serving_desc: servingDesc,
      quantity,
      calories_kcal: Math.round(baseCals * quantity),
      protein_g: Math.round(baseProtein * quantity * 10) / 10,
      carbs_g: Math.round(baseCarbs * quantity * 10) / 10,
      fat_g: Math.round(baseFat * quantity * 10) / 10,
      barcode: lfPendingBarcode,
      estimate_note: el.lfEstimateNote?.textContent || null,
      custom_food_id: customFoodId,
      hypo_treatment: hypoTreatment,
    }).select('id').single();
    if (error) {
      if (el.lfSaveStatus) el.lfSaveStatus.textContent = "Couldn't save: " + error.message;
      return;
    }

    // Bridge into the diabetes tab's own meal log too — Snacks get their
    // own per-item dose row, everything else upserts the whole SECTION
    // (day + meal slot, or Hypo Treatment), re-summed from every item
    // currently in it. See bridgeLfMealChange/upsertDiabetesMealSection
    // for why and how it protects a dose already linked to a real bolus.
    //
    // dxBridgeError, not thrown/returned — the food_log row above already
    // saved successfully, so a bridge failure here shouldn't look like the
    // whole log failed. Surfaced as a toast instead, alongside the normal
    // "Logged X" success message below (this used to be silently
    // swallowed entirely — seen in practice — before that was fixed).
    let dxBridgeError = null;
    if (profile?.diabetes_enabled !== false) {
      const itemForBridge = {
        food_name: name,
        carbs_g: Math.round(baseCarbs * quantity * 10) / 10,
        fat_g: Math.round(baseFat * quantity * 10) / 10,
        protein_g: Math.round(baseProtein * quantity * 10) / 10,
        logged_at: loggedAt.toISOString(),
      };
      const { error: bridgeErr } = await bridgeLfMealChange(logDate, mealSlot, hypoTreatment, savedFoodLog.id, itemForBridge);
      if (bridgeErr) dxBridgeError = bridgeErr;
    }

    // Save as a favourite too, when the ⭐ toggle is on — base per-serving
    // values (not multiplied by quantity), same as the shared custom_foods
    // insert above, since a favourite is a reusable template to pick a
    // quantity against again, not a record of what was eaten this time.
    if (lfFavToggleActive) {
      const { error: favErr } = await db.from('favorite_meals').insert({
        user_id: currentUser.id, name, brand, serving_desc: servingDesc,
        calories_kcal: baseCals, protein_g: baseProtein, carbs_g: baseCarbs, fat_g: baseFat,
        barcode: lfPendingBarcode,
      });
      if (favErr) showToast("Couldn't save as favourite: " + favErr.message, true);
    }

    // Also log this exact entry into a linked household partner's own
    // food_log, when the "Also log this for X" toggle is on — the actual
    // cross-account insert happens server-side (RLS on food_log is
    // strictly own-write), passing the same already-quantity-multiplied
    // totals just saved above rather than the per-serving base values.
    let shareError = null;
    if (wantsShare) {
      try {
        const session = (await db.auth.getSession()).data.session;
        const shareRes = await fetch(`${FUNCTIONS_ORIGIN}/share-food-log`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token}` },
          body: JSON.stringify({
            log_date: logDate, logged_at: loggedAt.toISOString(), meal_slot: mealSlot, food_name: name, brand, serving_desc: servingDesc,
            quantity,
            calories_kcal: Math.round(baseCals * quantity),
            protein_g: Math.round(baseProtein * quantity * 10) / 10,
            carbs_g: Math.round(baseCarbs * quantity * 10) / 10,
            fat_g: Math.round(baseFat * quantity * 10) / 10,
            barcode: lfPendingBarcode,
          }),
        });
        if (!shareRes.ok) {
          const errData = await shareRes.json().catch(() => ({}));
          shareError = errData.error || `HTTP ${shareRes.status}`;
        }
      } catch (err) {
        shareError = err.message;
      }
    }

    resetLfForm();
    selectLfMode(null);
    await Promise.all([renderLfTodayTotals(), renderLfTodayList(), renderLfFavorites()]);
    if (shareError) {
      showToast(`Logged ${name}, but couldn't share: ${shareError}`, true);
    } else if (dxBridgeError) {
      showToast(`Logged ${name}, but it won't show in the dose calculator: ${dxBridgeError}`, true);
    } else if (wantsShare) {
      showToast(`Logged ${name} — shared with ${HOUSEHOLD_PARTNER[currentUser.id].name}.`);
    } else {
      showToast(`Logged ${name}.`);
    }
  } finally {
    setBtn(el.btnLfSave, false, 'Log it');
  }
});

/* ── Today's totals + list ──────────────────────────────────── */
async function fetchTodayFoodLog() {
  if (!currentUser) return [];
  const { data, error } = await db.from('food_log')
    .select('id, meal_slot, food_name, brand, quantity, serving_desc, calories_kcal, protein_g, carbs_g, fat_g, source, logged_at, hypo_treatment')
    .eq('user_id', currentUser.id)
    .eq('log_date', todayISO())
    .order('logged_at', { ascending: true });
  if (error) { console.error('fetchTodayFoodLog error:', error.message); return []; }
  return data || [];
}

async function renderLfTodayTotals() {
  const rows = await fetchTodayFoodLog();
  const totals = rows.reduce((t, r) => ({
    cals: t.cals + (Number(r.calories_kcal) || 0),
    protein: t.protein + (Number(r.protein_g) || 0),
    carbs: t.carbs + (Number(r.carbs_g) || 0),
    fat: t.fat + (Number(r.fat_g) || 0),
  }), { cals: 0, protein: 0, carbs: 0, fat: 0 });
  if (el.mtCals) el.mtCals.textContent = Math.round(totals.cals);
  if (el.mtProtein) el.mtProtein.textContent = `${Math.round(totals.protein)}g`;
  if (el.mtCarbs) el.mtCarbs.textContent = `${Math.round(totals.carbs)}g`;
  if (el.mtFat) el.mtFat.textContent = `${Math.round(totals.fat)}g`;
  await renderLfRemaining(totals);
  return totals;
}

// Ideal remaining (target - eaten) for each macro is independent of the
// others, so on a day where carbs/fat are already near target but protein
// is behind, "51g protein" and "1g carbs" can individually be true while
// jointly impossible — 51g protein alone costs more calories than remain.
// This reconciles the three against the actual remaining calorie budget
// so what's shown can always be eaten together. Protein is treated as the
// non-negotiable figure (it's a fixed 1g/lb-bodyweight goal) and gets
// first claim on whatever calories are left; carbs/fat — the flexible
// "fill" macros — share whatever's left over after that, scaled down
// together (preserving their relative ratio) if even their reduced
// targets don't both fit. Nothing here is ever allowed to ask for more
// calories than are actually left today.
function computeAchievableRemaining(targets, totals) {
  const calRemaining = targets.calories - totals.cals;
  const idealProtein = targets.protein != null ? targets.protein - totals.protein : null;
  const idealFat = targets.fat - totals.fat;
  const idealCarbs = targets.carbs - totals.carbs;

  const proteinOver = idealProtein != null && idealProtein < 0;
  const fatOver = idealFat < 0;
  const carbsOver = idealCarbs < 0;

  const proteinNeed = idealProtein != null ? Math.max(0, idealProtein) : 0;
  const fatNeed = Math.max(0, idealFat);
  const carbsNeed = Math.max(0, idealCarbs);

  const budget = Math.max(0, calRemaining);
  const proteinKcalUsed = Math.min(proteinNeed * 4, budget);
  const protein = idealProtein != null ? proteinKcalUsed / 4 : null;
  const leftoverAfterProtein = budget - proteinKcalUsed;

  const fatIdealKcal = fatNeed * 9;
  const carbsIdealKcal = carbsNeed * 4;
  const totalIdealKcal = fatIdealKcal + carbsIdealKcal;
  let fat, carbs;
  if (totalIdealKcal === 0 || totalIdealKcal <= leftoverAfterProtein) {
    fat = fatNeed; carbs = carbsNeed;
  } else {
    const scale = leftoverAfterProtein / totalIdealKcal;
    fat = fatNeed * scale;
    carbs = carbsNeed * scale;
  }

  // computeMacroTargets rounds protein/fat/carbs to whole grams independently,
  // so their kcal sum is routinely a few kcal off calTarget even on a
  // perfectly on-plan day — that alone shouldn't trip the "trimmed" note.
  // 1g is below the rounding the UI displays at anyway, so a diff smaller
  // than that is invisible regardless.
  const EPS = 1;
  const adjusted =
    (protein != null && protein < proteinNeed - EPS) ||
    fat < fatNeed - EPS ||
    carbs < carbsNeed - EPS;

  return { calRemaining, protein, fat, carbs, proteinOver, fatOver, carbsOver, proteinNeed, fatNeed, carbsNeed, adjusted };
}

// Target minus today's totals (see computeMacroTargets), reconciled to be
// jointly achievable within today's remaining calories (see
// computeAchievableRemaining). Takes the same totals renderLfTodayTotals
// just computed rather than re-fetching food_log itself. Negative (over
// target) renders in the same warning colour used elsewhere rather than a
// confusing negative number.
async function renderLfRemaining(totals) {
  if (!el.lfRemainingCard) return;
  const targets = await computeMacroTargets();
  if (!targets) { el.lfRemainingCard.hidden = true; return; }
  el.lfRemainingCard.hidden = false;

  const r = computeAchievableRemaining(targets, totals);

  const setRemaining = (valEl, remaining, over) => {
    if (!valEl) return;
    valEl.textContent = Math.round(Math.abs(remaining)) + (valEl === el.rtCals ? '' : 'g');
    valEl.classList.toggle('macro-total__val--over', over);
  };
  setRemaining(el.rtCals, r.calRemaining, r.calRemaining < 0);
  if (r.protein != null) setRemaining(el.rtProtein, r.protein, r.proteinOver);
  else if (el.rtProtein) el.rtProtein.textContent = '—';
  setRemaining(el.rtCarbs, r.carbs, r.carbsOver);
  setRemaining(el.rtFat, r.fat, r.fatOver);

  if (el.rtAdjustedNote) {
    if (r.adjusted) {
      const bits = [];
      if (r.protein != null && r.protein < r.proteinNeed - 1) bits.push(`${Math.round(r.proteinNeed)}g protein`);
      if (r.carbs < r.carbsNeed - 1) bits.push(`${Math.round(r.carbsNeed)}g carbs`);
      if (r.fat < r.fatNeed - 1) bits.push(`${Math.round(r.fatNeed)}g fat`);
      el.rtAdjustedNote.textContent = `Full targets (${bits.join(', ')}) won't fit in today's remaining calories — trimmed to the most protein-priority split that still does.`;
      el.rtAdjustedNote.hidden = false;
    } else {
      el.rtAdjustedNote.hidden = true;
    }
  }
}

const LF_SOURCE_ICON = { scan: '📷', search: '🔍', photo: '📸', manual: '✏️', shared: '🍽️' };

// MFP-style meal sections — fixed order, always all five shown (even
// empty) so "+ Add to X" is always reachable rather than only appearing
// once something's already been logged there. Hypo Treatment groups by
// the existing hypo_treatment boolean, not meal_slot (see the schema
// note on diabetes_meals.meal_slot) — a hypo item still carries a normal
// meal_slot value underneath, it just displays under its own section.
const LF_SECTIONS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch',     label: 'Lunch' },
  { key: 'dinner',    label: 'Dinner' },
  { key: 'snack',     label: 'Snacks' },
  { key: 'hypo',      label: 'Hypo Treatment' },
];

// hypoEnabled gates whether a hypo-flagged item actually groups into its
// own section — when diabetes tracking is off there's no Hypo Treatment
// section rendered at all (see renderLfTodayList), so routing there
// would silently drop the item from the list entirely.
function lfSectionOf(r, hypoEnabled) {
  if (r.hypo_treatment && hypoEnabled) return 'hypo';
  return LF_SECTIONS.some(s => s.key === r.meal_slot) ? r.meal_slot : 'snack';
}

// Yesterday's items already routed into a given section (same grouping
// rule as the day's own list — see lfSectionOf), for the "Copy
// yesterday's X" button. UTC day window, same convention as todayISO()
// everywhere else — 'yesterday' is calendar-yesterday relative to now,
// not tied to whichever section is being added to.
async function fetchYesterdaySectionItems(sectionKey) {
  if (!currentUser) return [];
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { data, error } = await db.from('food_log')
    .select('food_name, brand, serving_desc, quantity, calories_kcal, protein_g, carbs_g, fat_g, source, barcode, custom_food_id, meal_slot, hypo_treatment')
    .eq('user_id', currentUser.id)
    .eq('log_date', yesterday);
  if (error) { console.error('fetchYesterdaySectionItems error:', error.message); return []; }
  const hypoEnabled = profile?.diabetes_enabled !== false;
  return (data || []).filter(r => lfSectionOf(r, hypoEnabled) === sectionKey);
}

// Populates and shows/hides the "Copy yesterday's X" button whenever the
// add-item flow opens for a section — hidden entirely when yesterday has
// nothing logged there, so it never offers to copy zero items.
async function updateLfCopyYesterdayButton(sectionKey) {
  if (!el.btnLfCopyYesterday) return;
  const items = await fetchYesterdaySectionItems(sectionKey);
  lfCopyYesterdayItems = items;
  if (!items.length) { el.btnLfCopyYesterday.hidden = true; return; }
  const label = LF_SECTIONS.find(s => s.key === sectionKey)?.label || 'meal';
  el.btnLfCopyYesterday.hidden = false;
  el.btnLfCopyYesterday.textContent = `📋 Copy yesterday's ${label} (${items.length} item${items.length === 1 ? '' : 's'})`;
  el.btnLfCopyYesterday.title = items.map(i => i.food_name).join(', ');
}

el.btnLfCopyYesterday?.addEventListener('click', async () => {
  if (!currentUser || !lfCopyYesterdayItems.length) return;
  const originalLabel = el.btnLfCopyYesterday.textContent;
  el.btnLfCopyYesterday.disabled = true;
  el.btnLfCopyYesterday.textContent = 'Copying…';
  try {
    const logDate = todayISO();
    const loggedAt = new Date().toISOString();
    // Inserted one row at a time rather than a single bulk insert — a
    // bulk `.insert(rows).select('id')` doesn't guarantee its returned
    // array comes back in the same order the rows were given, so
    // matching result[i] back to lfCopyYesterdayItems[i] by position
    // could silently attach the wrong food_log_id to a snack's dosing
    // bridge below. One insert per row costs an extra round trip each,
    // but this only ever runs on a small hand-picked batch, and it's the
    // only way to know for certain which id belongs to which item.
    const insertedRows = [];
    for (const r of lfCopyYesterdayItems) {
      const { data: inserted, error: rowErr } = await db.from('food_log').insert({
        user_id: currentUser.id, log_date: logDate, logged_at: loggedAt,
        meal_slot: r.meal_slot, food_name: r.food_name, brand: r.brand, serving_desc: r.serving_desc,
        quantity: r.quantity, calories_kcal: r.calories_kcal, protein_g: r.protein_g,
        carbs_g: r.carbs_g, fat_g: r.fat_g, source: r.source, barcode: r.barcode,
        custom_food_id: r.custom_food_id, hypo_treatment: r.hypo_treatment,
      }).select('id').single();
      if (rowErr) {
        showToast("Couldn't copy: " + rowErr.message, true);
        el.btnLfCopyYesterday.textContent = originalLabel;
        return;
      }
      insertedRows.push(inserted);
    }
    if (profile?.diabetes_enabled !== false) {
      // Every copied row shares the same section (fetchYesterdaySectionItems
      // already filtered to one). Snacks dose per-item, so each copied row
      // needs its own bridge call; everything else re-aggregates once.
      const first = lfCopyYesterdayItems[0];
      if (!first.hypo_treatment && first.meal_slot === 'snack') {
        for (let i = 0; i < lfCopyYesterdayItems.length; i++) {
          const r = lfCopyYesterdayItems[i];
          const insertedId = insertedRows[i]?.id;
          if (!insertedId) continue;
          const { error: bridgeErr } = await upsertDiabetesMealItem(insertedId, {
            food_name: r.food_name, carbs_g: r.carbs_g, fat_g: r.fat_g, protein_g: r.protein_g, logged_at: loggedAt,
          });
          if (bridgeErr) showToast(`Copied, but it won't show in the dose calculator: ${bridgeErr}`, true);
        }
      } else {
        const { error: bridgeErr } = await upsertDiabetesMealSection(logDate, first.meal_slot, !!first.hypo_treatment);
        if (bridgeErr) showToast(`Copied, but it won't show in the dose calculator: ${bridgeErr}`, true);
      }
    }
    resetLfForm();
    selectLfMode(null);
    await Promise.all([renderLfTodayTotals(), renderLfTodayList(), renderLfFavorites()]);
    showToast(`Copied ${insertedRows.length} item${insertedRows.length === 1 ? '' : 's'} from yesterday.`);
  } finally {
    el.btnLfCopyYesterday.disabled = false;
  }
});

// Sub-line under the food name, MFP-style: brand + serving description,
// e.g. "Asda · 2 wrap" — omits either half when the item doesn't have it
// (a manual/photo-estimate entry usually has neither).
function lfItemDesc(r) {
  const parts = [];
  if (r.brand) parts.push(escapeHtml(r.brand));
  if (r.serving_desc) {
    const qty = Number(r.quantity) || 1;
    parts.push(`${qty !== 1 ? qty + ' × ' : ''}${escapeHtml(r.serving_desc)}`);
  }
  return parts.join(' · ');
}

function lfRowHtml(r) {
  const loggedAt = new Date(r.logged_at);
  const timeStr = `${String(loggedAt.getHours()).padStart(2, '0')}:${String(loggedAt.getMinutes()).padStart(2, '0')}`;
  const desc = lfItemDesc(r);
  return `
    <div class="lf-item" data-action="food-edit-item" data-id="${r.id}">
      <div class="lf-item__main">
        <span class="lf-item__name">${LF_SOURCE_ICON[r.source] || ''} ${escapeHtml(r.food_name)}</span>
        <span class="lf-item__kcal">${Math.round(r.calories_kcal)}</span>
      </div>
      <div class="lf-item__sub">
        <span class="lf-item__desc">${desc}</span>
        <span class="lf-today-actions">
          <button type="button" class="btn btn--ghost btn--small" data-action="food-edit-time" data-id="${r.id}" data-time="${timeStr}">🕐 ${timeStr}</button>
          <button class="btn btn--ghost btn--small" data-action="food-delete" data-id="${r.id}">Delete</button>
        </span>
      </div>
    </div>`;
}

async function renderLfTodayList() {
  if (!el.lfTodayList) return;
  const rows = await fetchTodayFoodLog();
  const hypoEnabled = profile?.diabetes_enabled !== false;
  const bySection = { breakfast: [], lunch: [], dinner: [], snack: [], hypo: [] };
  rows.forEach(r => bySection[lfSectionOf(r, hypoEnabled)].push(r));

  // Hypo Treatment only makes sense with diabetes tracking on — matches
  // the existing hypo checkbox's own visibility rule in resetLfForm().
  const sections = hypoEnabled ? LF_SECTIONS : LF_SECTIONS.filter(s => s.key !== 'hypo');

  el.lfTodayList.innerHTML = sections.map(({ key, label }) => {
    const items = bySection[key];
    const kcal = Math.round(items.reduce((sum, r) => sum + (Number(r.calories_kcal) || 0), 0));
    const carbs = items.reduce((sum, r) => sum + (Number(r.carbs_g) || 0), 0);
    const fat = items.reduce((sum, r) => sum + (Number(r.fat_g) || 0), 0);
    const protein = items.reduce((sum, r) => sum + (Number(r.protein_g) || 0), 0);
    return `
    <div class="lf-section">
      <div class="lf-section__head">
        <div class="lf-section__headrow">
          <span class="lf-section__name">${label}</span>
          ${items.length ? `<span class="lf-section__total">${kcal} kcal</span>` : ''}
        </div>
        ${items.length ? `<div class="lf-section__macros">Carbs ${fmt1(carbs)}g · Fat ${fmt1(fat)}g · Protein ${fmt1(protein)}g</div>` : ''}
      </div>
      ${items.map(lfRowHtml).join('')}
      <button type="button" class="lf-section__add" data-slot="${key}">ADD FOOD</button>
    </div>`;
  }).join('');
}
el.lfTodayList?.addEventListener('click', async e => {
  // Presets the Meal dropdown (and, for Hypo Treatment, the hypo
  // checkbox) to this section before jumping to the existing add-item
  // flow — same mode-pill/review-form UI every other entry point already
  // uses, just arriving with the right section pre-selected instead of
  // whatever defaultMealSlot()'s hour-based guess would've picked.
  const addBtn = e.target.closest('.lf-section__add');
  if (addBtn) {
    const slot = addBtn.dataset.slot;
    resetLfForm();
    if (slot === 'hypo') {
      if (el.lfMealSlot) el.lfMealSlot.value = defaultMealSlot();
      if (el.lfHypoTreatment) el.lfHypoTreatment.checked = true;
    } else if (el.lfMealSlot) {
      el.lfMealSlot.value = slot;
    }
    selectLfMode(null);
    el.lfMealSlot?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    updateLfCopyYesterdayButton(slot);
    return;
  }

  const delBtn = e.target.closest('[data-action="food-delete"]');
  if (delBtn) {
    // Fetched before deleting — need this row's section identity
    // afterward to re-aggregate what's left in it (upsertDiabetesMealSection
    // re-sums from scratch, it doesn't know what just got removed).
    const { data: doomedRow } = await db.from('food_log')
      .select('log_date, meal_slot, hypo_treatment')
      .eq('id', delBtn.dataset.id).single();
    const { error } = await db.from('food_log').delete().eq('id', delBtn.dataset.id);
    if (error) { showToast("Couldn't delete: " + error.message, true); return; }
    if (doomedRow && profile?.diabetes_enabled !== false) {
      await bridgeLfMealChange(doomedRow.log_date, doomedRow.meal_slot, !!doomedRow.hypo_treatment, delBtn.dataset.id, null);
    }
    await Promise.all([renderLfTodayTotals(), renderLfTodayList()]);
    return;
  }

  // Tapping the time chip swaps it for an inline <input type="time"> +
  // Save right there in the row — editing when a meal actually happened
  // shouldn't require reopening the whole log form.
  const editBtn = e.target.closest('[data-action="food-edit-time"]');
  if (editBtn) {
    const wrap = document.createElement('span');
    wrap.className = 'lf-time-edit';
    wrap.innerHTML = `<input type="time" class="lf-time-input" value="${editBtn.dataset.time}"><button type="button" class="btn btn--primary btn--small" data-action="food-save-time" data-id="${editBtn.dataset.id}">Save</button>`;
    editBtn.replaceWith(wrap);
    wrap.querySelector('input')?.focus();
    return;
  }

  const saveBtn = e.target.closest('[data-action="food-save-time"]');
  if (saveBtn) {
    const timeVal = saveBtn.previousElementSibling?.value;
    if (!timeVal) return;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    await saveLfLoggedTime(saveBtn.dataset.id, timeVal);
    await Promise.all([renderLfTodayTotals(), renderLfTodayList()]);
    return;
  }

  // Tapping anywhere else on an item row opens it in the review form for
  // a full edit (name/quantity/macros/meal slot), not just the time chip
  // above. Re-fetches rather than trusting stale DOM state, since the
  // list may have re-rendered since this row was drawn.
  const itemRow = e.target.closest('[data-action="food-edit-item"]');
  if (itemRow) {
    const rows = await fetchTodayFoodLog();
    const row = rows.find(r => String(r.id) === String(itemRow.dataset.id));
    if (row) openLfEditItem(row);
  }
});

// Updates a food_log entry's time in place, then re-aggregates its
// section (upsertDiabetesMealSection) so the diabetes_meals row's
// eaten_at reflects whichever item in the section is now earliest —
// the old food_log_id 1:1 link this used to sync through doesn't fit
// the aggregate one-row-per-section model (that FK can only ever point
// at one of the section's possibly-several items).
async function saveLfLoggedTime(foodLogId, timeVal) {
  const { data: foodRow, error: fetchErr } = await db.from('food_log')
    .select('logged_at, log_date, meal_slot, hypo_treatment, food_name, carbs_g, fat_g, protein_g').eq('id', foodLogId).single();
  if (fetchErr || !foodRow) { showToast("Couldn't load that entry", true); return; }

  const oldLoggedAt = new Date(foodRow.logged_at);
  const [h, m] = timeVal.split(':').map(Number);
  const newLoggedAt = new Date(oldLoggedAt.getFullYear(), oldLoggedAt.getMonth(), oldLoggedAt.getDate(), h, m);
  const newIso = newLoggedAt.toISOString();
  const newLogDate = newIso.slice(0, 10);

  const { error: updErr } = await db.from('food_log').update({ logged_at: newIso, log_date: newLogDate }).eq('id', foodLogId);
  if (updErr) { showToast("Couldn't update time: " + updErr.message, true); return; }

  if (profile?.diabetes_enabled !== false) {
    const isHypo = !!foodRow.hypo_treatment;
    const itemForBridge = {
      food_name: foodRow.food_name,
      carbs_g: foodRow.carbs_g, fat_g: foodRow.fat_g, protein_g: foodRow.protein_g,
      logged_at: newIso,
    };
    if (newLogDate !== foodRow.log_date) {
      // Crosses a UTC day boundary (rare): clean up on the day it's
      // leaving (upsertDiabetesMealSection re-aggregates what's left;
      // upsertDiabetesMealItem removes its own now-orphaned row) and
      // bridge fresh on the day it's arriving at.
      await bridgeLfMealChange(foodRow.log_date, foodRow.meal_slot, isHypo, foodLogId, null);
      await bridgeLfMealChange(newLogDate, foodRow.meal_slot, isHypo, foodLogId, itemForBridge);
    } else {
      await bridgeLfMealChange(foodRow.log_date, foodRow.meal_slot, isHypo, foodLogId, itemForBridge);
    }
  }
  showToast('Time updated.');
}

/* ── Favourites — ⭐-toggled quick-add shortcuts (see btnLfFavToggle) ── */
async function fetchFavoriteMeals() {
  if (!currentUser) return [];
  const { data, error } = await db.from('favorite_meals')
    .select('id, name, brand, serving_desc, calories_kcal, protein_g, carbs_g, fat_g, barcode')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) { console.error('fetchFavoriteMeals error:', error.message); return []; }
  return data || [];
}

async function renderLfFavorites() {
  if (!el.lfFavoritesCard || !el.lfFavoritesSelect) return;
  lfFavoritesData = await fetchFavoriteMeals();
  el.lfFavoritesCard.hidden = !lfFavoritesData.length;
  if (!lfFavoritesData.length) return;
  el.lfFavoritesSelect.innerHTML = lfFavoritesData.map(f =>
    `<option value="${f.id}">⭐ ${escapeHtml(f.name)} — ${Math.round(f.calories_kcal)} kcal</option>`).join('');
}
el.lfFavoritesAdd?.addEventListener('click', () => {
  const fav = lfFavoritesData.find(f => f.id === el.lfFavoritesSelect.value);
  if (!fav) return;
  selectLfMode(null);
  populateLfFormFromFood(fav, { barcode: fav.barcode || null });
  showLfReviewForm();
});
el.lfFavoritesDelete?.addEventListener('click', async () => {
  const id = el.lfFavoritesSelect.value;
  if (!id) return;
  const { error } = await db.from('favorite_meals').delete().eq('id', id);
  if (error) { showToast("Couldn't remove favourite: " + error.message, true); return; }
  await renderLfFavorites();
});

/* ═══════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════ */
const THEME_KEY = 'fitl00p:theme';

function applyTheme(theme, persist = true) {
  // Migrate old theme names → new equivalents. "midnight" mapped to
  // obsidian here refers to a genuinely retired old theme name from
  // before the 3-theme consolidation — unrelated to Nebula, a distinct
  // new 4th theme added later with its own real data-theme value.
  const OLD_MAP = { light: 'aurora', dark: 'slate', midnight: 'obsidian', forest: 'slate', rose: 'aurora', '': 'nebula' };
  const validThemes = ['slate','obsidian','aurora','nebula','nebula-light'];
  const t = validThemes.includes(theme) ? theme : (OLD_MAP[theme] || 'nebula');

  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);

  // Update picker active state
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.theme === t);
  });

  // Update PWA theme-color meta
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    const themeColors = {
      slate:        '#F5F5F5', // Hybrid
      obsidian:     '#121212', // Dark
      aurora:       '#FFFFFF', // Light
      nebula:       '#09090F', // Nebula
      'nebula-light': '#F6F3FC', // Nebula Light
    };
    metaTheme.content = themeColors[t] || '#09090F';
  }

  // Persist to Supabase if logged in — fire and forget, never block login
  if (persist && currentUser) {
    db.from('profiles')
      .update({ theme: t })
      .eq('id', currentUser.id)
      .then(({ error }) => {
        if (error) console.warn('Theme persist failed (non-critical):', error.message);
        else if (profile) profile.theme = t;
      })
      .catch(err => console.warn('Theme persist error (non-critical):', err));
  }
}

// ── BOOT ─────────────────────────────────────────────────
// Apply theme immediately (before network — uses localStorage)
// Migrate old theme names → new equivalents
const OLD_THEME_MAP = { light: 'aurora', dark: 'slate', midnight: 'obsidian', forest: 'slate', rose: 'aurora' };
const rawSavedTheme = localStorage.getItem(THEME_KEY) || 'nebula';
const savedTheme = OLD_THEME_MAP[rawSavedTheme] || rawSavedTheme;
if (OLD_THEME_MAP[rawSavedTheme]) localStorage.setItem(THEME_KEY, savedTheme); // update stored value
applyTheme(savedTheme, false);

// Wire theme picker
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

/* ═══════════════════════════════════════════════════════════
   SCREEN WAKE LOCK — keeps the phone from sleeping while fitl00p
   is the active foreground tab. A device-local preference, not
   synced to Supabase — carrying "keep my phone awake" across to a
   different device doesn't mean anything, unlike theme/profile
   settings. Requires iOS 16.4+ (Safari's Wake Lock API support) —
   feature-detected below, degrades to a disabled/explained checkbox
   on anything older.

   The browser force-releases the lock the instant the tab is
   backgrounded (screen locked, app-switched away from, etc.) — that
   part is outside our control by design (it's what stops a hidden
   tab draining the battery forever). We only re-acquire it on
   visibilitychange while the preference is still on, so it comes
   back the moment the user returns to the app.
═══════════════════════════════════════════════════════════ */
const KEEP_AWAKE_KEY = 'fitl00p:keepAwake';
let wakeLockSentinel = null;
// A NotAllowedError reflects a persistent platform restriction (Low Power
// Mode, or iOS often blocking Wake Lock entirely in standalone/home-screen
// PWA mode) — not a transient blip that's worth retrying. Without this,
// the visibilitychange listener below re-attempts (and re-logs) an
// identical failure every single time the screen wakes, spamming both the
// real console and the on-screen debug panel for the rest of the session.
let wakeLockDeniedThisSession = false;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
    wakeLockDeniedThisSession = false;
    return true;
  } catch (err) {
    // Can legitimately fail (e.g. Low Power Mode) — not an error worth
    // surfacing to the user, the checkbox just won't have taken effect.
    console.warn('Wake lock request failed (non-fatal):', err?.message || err);
    if (err?.name === 'NotAllowedError') wakeLockDeniedThisSession = true;
    wakeLockSentinel = null;
    return false;
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !wakeLockDeniedThisSession && localStorage.getItem(KEEP_AWAKE_KEY) === '1') {
    requestWakeLock();
  }
});

const keepAwakeCheckbox = $('setKeepAwake');
if (keepAwakeCheckbox) {
  if (!('wakeLock' in navigator)) {
    keepAwakeCheckbox.disabled = true;
    const unsupportedEl = $('keepAwakeUnsupported');
    if (unsupportedEl) unsupportedEl.hidden = false;
  } else {
    keepAwakeCheckbox.checked = localStorage.getItem(KEEP_AWAKE_KEY) === '1';
    if (keepAwakeCheckbox.checked) requestWakeLock();
    keepAwakeCheckbox.addEventListener('change', () => {
      localStorage.setItem(KEEP_AWAKE_KEY, keepAwakeCheckbox.checked ? '1' : '0');
      if (keepAwakeCheckbox.checked) {
        // An explicit toggle is deliberate user intent — always worth one
        // fresh attempt, in case whatever caused the denial has changed
        // (e.g. Low Power Mode turned off) since the last passive retry.
        wakeLockDeniedThisSession = false;
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    });
  }
}

// Show auth screen immediately so there's never a black screen gap
// It will be replaced by the app screen if a valid session is found
showScreen('auth');

// Unregisters the service worker and clears its caches, then reloads —
// the actual fix for a PWA stuck on a frozen/stale service worker.
// Clearing Safari's own site data does NOT touch this: a Home-Screen-
// installed PWA keeps its service worker, caches and storage in a
// separate silo from Safari, invisible to Settings > Safari > Clear
// Website Data. This can only be done from inside the app's own
// context, which is exactly what a stuck boot screen can't normally
// reach — it's offered as a button on the connectivity-error screens.
window.__fitl00pHardReset = async function () {
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
  } catch {}
  window.location.reload();
};

// Wired here, immediately after the function it calls is defined —
// this button is painted from the very first frame (it's inside the
// static #screenBoot markup, not gated behind the connectivity-error
// screen below), so it needs to be live before anything async below
// has a chance to run.
el.btnBootHardReset?.addEventListener('click', () => window.__fitl00pHardReset());

function showBootConnectivityError() {
  markBootResolved();
  document.body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;
                font-family:sans-serif;padding:24px;text-align:center;background:#111318;color:#F0F2F7">
      <div>
        <div style="font-size:32px;margin-bottom:12px">📡</div>
        <p style="font-size:17px;font-weight:600;margin-bottom:8px">fitl00p couldn't connect</p>
        <p style="font-size:14px;color:#888;max-width:320px;line-height:1.5">
          Still couldn't reach the server after a few tries — this can happen right after opening the app from the home screen. Check your connection and try again.
        </p>
        <div style="display:flex;gap:10px;justify-content:center;margin-top:16px;flex-wrap:wrap">
          <button onclick="window.location.reload()" style="padding:10px 22px;border:none;border-radius:10px;background:#C6FF00;color:#111318;font-weight:700;font-size:15px">Retry</button>
          <button onclick="window.__fitl00pHardReset()" style="padding:10px 22px;border:1.5px solid #444;border-radius:10px;background:transparent;color:#F0F2F7;font-weight:600;font-size:15px">Clear cache &amp; retry</button>
        </div>
        <p style="font-size:11px;color:#555;margin-top:14px;max-width:320px;line-height:1.4">
          Still stuck after that? Delete the fitl00p icon from your Home Screen and re-add it — Safari's own "Clear Website Data" doesn't reach an installed app's storage, but this does.
        </p>
      </div>
    </div>`;
}

// Absolute failsafe, entirely independent of fetch()/AbortController
// actually working — on iOS the service worker itself can be fully
// suspended by the OS mid-request, and there's no guarantee an abort
// signal from the page reaches a worker in that state. Cleared only by
// markBootResolved() (called from hideBootScreen() and the two error
// paths below), which is what makes this a genuine end-to-end
// failsafe rather than one that only covers the config fetch: it stays
// armed all the way through profile load AND the target tab's own data
// load (navigateTo), since neither of those has its own timeout on
// every individual query they run — a hang in any of them previously
// left the boot spinner up forever with nothing to catch it. 90s
// comfortably clears the legitimate worst case (≈25s of config
// retries + ≈31s of profile-load retries + real data-query time on a
// slow connection) without false-triggering mid-boot; the manual
// reset button on the boot screen is available the whole time
// regardless, for anyone who doesn't want to wait that long.
let bootResolved = false;
const bootWatchdog = setTimeout(() => {
  if (!bootResolved) showBootConnectivityError();
}, 90000);

// Starts the app. No separate loading indicator needed here — screenBoot
// (index.html) is already visible from the very first paint and stays up
// on top of whatever showScreen('auth') reveals underneath, all the way
// through auth resolution and (for the main app case) the initial view's
// own data fetch. See hideBootScreen()'s call sites in initApp(). This
// used to start with a network round-trip to a Netlify Function just to
// learn SUPABASE_URL/SUPABASE_ANON_KEY (see the retrying fetchWithRetries
// helper this replaced) — now that those are hardcoded constants above,
// the client can init synchronously and there's nothing left here that
// can fail on connectivity grounds specifically.
(async () => {
  try {
    // ── Defensive session storage check ──────────────────────
    // Supabase's JS client stores the current session as JSON under a
    // predictable key: sb-<project-ref>-auth-token. If a previous write to
    // this key was interrupted (e.g. the app crashed or the tab closed
    // mid-refresh), the stored value can end up truly malformed — not
    // valid JSON, or missing the tokens outright. That's the only case
    // handled here: an access token merely being *old* is normal (it
    // expires hourly by design) and is NOT a reason to clear anything —
    // that's exactly what refresh_token + autoRefreshToken are for, and
    // they need the stored session intact to do it. An earlier version of
    // this check also wiped the session whenever the access token looked
    // expired, which silently deleted a perfectly good refresh_token any
    // time the app was reopened more than ~an hour after last use —
    // forcing a fresh password login constantly instead of the silent
    // renewal this was supposed to enable. Removed.
    try {
      const projectRef = new URL(SUPABASE_URL).hostname.split('.')[0];
      const authStorageKey = `sb-${projectRef}-auth-token`;
      const stored = localStorage.getItem(authStorageKey);
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (!parsed?.access_token || !parsed?.refresh_token) {
            console.warn('Stored session missing required fields — clearing.');
            localStorage.removeItem(authStorageKey);
          }
        } catch {
          console.warn('Stored session is not valid JSON — clearing.');
          localStorage.removeItem(authStorageKey);
        }
      }
    } catch (storageCheckErr) {
      // If this check itself fails for any reason, don't let that block
      // boot — just proceed and let normal auth flow handle it.
      console.warn('Session storage pre-check failed (non-fatal):', storageCheckErr);
    }

    db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        // These three settings together mean: never sign the user out on
        // page refresh or app reopen, and always attempt to silently renew
        // the session in the background for as long as the underlying
        // refresh token remains valid.
        //
        // NOTE: the actual maximum session/refresh-token lifetime (e.g. "10
        // days") is NOT controlled here — it's a Supabase project setting
        // under Authentication > Sessions in the dashboard, not something
        // this client code can set. persistSession + autoRefreshToken only
        // guarantee the app never gives up on a session early; they don't
        // change how long Supabase itself considers that session valid.
        autoRefreshToken:   true,
        persistSession:     true,
        detectSessionInUrl: false,
        lock:               tabLocalAuthLock,
      }
    });
  } catch (err) {
    // No hideBootScreen() call needed — this replaces all of document.body,
    // screenBoot included, so the error message beneath is what appears.
    // Genuinely unexpected at this point (e.g. window.supabase itself
    // failed to load) — SUPABASE_URL/SUPABASE_ANON_KEY are hardcoded
    // constants, not fetched, so there's no connectivity-specific case
    // to distinguish here anymore.
    markBootResolved();
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;
                  font-family:sans-serif;padding:24px;text-align:center;background:#111318;color:#F0F2F7">
        <div>
          <div style="font-size:32px;margin-bottom:12px">⚠️</div>
          <p style="font-size:17px;font-weight:600;margin-bottom:8px">fitl00p couldn't start</p>
          <p style="font-size:14px;color:#888;max-width:320px;line-height:1.5">
            Something went wrong before the app could even sign you in. Try reloading — if it keeps happening, this needs a real fix, not just a retry.
          </p>
          <p style="font-size:12px;color:#666;margin-top:8px">${err.message}</p>
        </div>
      </div>`;
    return;
  }

  // NOTE: bootWatchdog stays armed here on purpose — config/auth resolved
  // successfully, but the real data load (navigateTo() inside the
  // SIGNED_IN handler initApp() wires up below) hasn't started yet, and
  // it has no timeout of its own. The watchdog now covers that phase too;
  // it's disarmed later by hideBootScreen() once a tab actually finishes
  // loading (or by showBootConnectivityError()/markBootResolved() if
  // something still hangs past the 90s window).

  // Wire all db-dependent listeners now that db is initialised
  initApp();

  // supabase-js's own first-session check (what fires the initial
  // SIGNED_IN/INITIAL_SESSION event handleAuthStateChange is waiting on)
  // has no timeout of its own. It's normally near-instant — reading the
  // persisted session from localStorage synchronously and returning
  // immediately if the token isn't expired — but when the token IS
  // expired it has to refresh over the network first, and a slow or
  // hung refresh right after a cold app launch leaves the boot spinner
  // up with nothing else bounding it until the 90s bootWatchdog finally
  // gives up.
  //
  // Race it against a short, boot-only fallback: if nothing's arrived
  // within FIRST_AUTH_EVENT_FALLBACK_MS, feed the session already
  // sitting in localStorage through the exact same handler, which
  // renders instantly from the cached profile exactly like a real
  // SIGNED_IN would. Nothing here is treated as final — the authCompleted
  // guard inside handleAuthStateChange means the real event, whenever it
  // eventually arrives, just quietly refreshes currentUser instead of
  // re-rendering; and if that real event turns out to be a genuine
  // SIGNED_OUT (the cached tokens were actually dead, not just slow to
  // check), the existing SIGNED_OUT branch bounces back to the sign-in
  // screen exactly as it already does today.
  const FIRST_AUTH_EVENT_FALLBACK_MS = 3000;
  Promise.race([
    firstAuthEventPromise.then(() => false),
    new Promise(resolve => setTimeout(() => resolve(true), FIRST_AUTH_EVENT_FALLBACK_MS)),
  ]).then(timedOut => {
    if (!timedOut) return;
    const cachedSession = readRawCachedSession();
    if (!cachedSession) {
      // No stored session at all, yet the client's first event is still
      // pending (seen: a 10s+ spinner on a fresh install before the login
      // screen). Nothing to render from cache, so show the sign-in form
      // now rather than leave the spinner up — if the real event later
      // turns out to carry a session, handleAuthStateChange still takes
      // over normally since authCompleted is untouched here.
      authTrace('no first auth event after 3s and no cached session — showing sign-in');
      if (!authCompleted && !authHandling) { showScreen('auth'); hideBootScreen(); }
      return;
    }
    console.warn('Initial session check is slow — rendering from cached session/profile while it resolves.');
    handleAuthStateChange('INITIAL_SESSION', cachedSession);
  });

  // autoRefreshToken handles the common case (a timer silently renewing
  // the token before it expires) with no help needed here. What it can't
  // cover: iOS suspending this PWA instance's JS entirely, another
  // launch of the same app rotating the refresh token in the meantime
  // (see tabLocalAuthLock above for why that rotation matters), and then
  // this instance resuming with an in-memory session that's now stale.
  // getSession() re-reads the session from localStorage on every call
  // (not just the cached in-memory copy — see auth-js's __loadSession)
  // and refreshes it if needed, so calling it the moment the app is
  // foregrounded again recovers silently from that case whenever a
  // still-valid session exists on disk. Any resulting change flows
  // through the normal onAuthStateChange handler in initApp() already —
  // nothing else to wire up. Gated on authCompleted so this can't fire
  // mid-way through the very first login.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && db && authCompleted) {
      db.auth.getSession().catch(err => console.warn('Resume session re-sync failed (non-fatal):', err?.message || err));
    }
  });

})();
