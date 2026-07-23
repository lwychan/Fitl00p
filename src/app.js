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

/* ── Console log capture panel ─────────────────────────────
   The crash reporter above only catches uncaught throws and
   unhandled promise rejections. Many things in this app fail
   "quietly" via console.error/console.warn without ever
   throwing — e.g. a Supabase query returning an error object,
   a profile load failing, a theme write failing. Those never
   trigger the red crash screen and are normally only visible
   in a real browser dev console.
   This panel mirrors every console.error/console.warn call
   into a small on-screen tab, specifically so this is
   diagnosable from a phone alone with no computer or Web
   Inspector needed. Tap the tab in the bottom-right corner to
   expand/collapse. Does not affect normal console behavior —
   every call still goes to the real console as well. */
(function installConsoleCapture() {
  const entries = [];
  const MAX_ENTRIES = 100;

  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  function fmt(args) {
    return args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
      return String(a);
    }).join(' ');
  }

  function record(level, args) {
    const time = new Date().toLocaleTimeString();
    entries.push({ level, time, text: fmt(args) });
    if (entries.length > MAX_ENTRIES) entries.shift();
    renderPanel();
  }

  console.error = (...args) => {
    origError(...args);
    try { record('error', args); } catch (captureErr) { origError('Console capture failed:', captureErr); }
  };
  console.warn = (...args) => {
    origWarn(...args);
    try { record('warn', args); } catch (captureErr) { origError('Console capture failed:', captureErr); }
  };

  let panelOpen = false;

  function renderPanel() {
    let tab = document.getElementById('__consoleTab');
    if (!tab) {
      tab = document.createElement('button');
      tab.id = '__consoleTab';
      tab.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:999998;' +
        'background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:20px;' +
        'padding:6px 12px;font:11px -apple-system,sans-serif;opacity:0.55;';
      document.documentElement.appendChild(tab);
      tab.addEventListener('click', () => {
        panelOpen = !panelOpen;
        renderPanel();
      });
    }
    tab.textContent = `Log (${entries.length})`;
    tab.style.opacity = entries.length ? '0.9' : '0.55';
    tab.style.background = entries.some(e => e.level === 'error') ? '#4a1414' : '#1a1a1a';

    let panel = document.getElementById('__consolePanel');
    if (!panelOpen) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement('div');
      panel.id = '__consolePanel';
      panel.style.cssText = 'position:fixed;left:8px;right:8px;bottom:52px;top:60px;z-index:999997;' +
        'background:#111;color:#ddd;font:11px/1.4 -apple-system,monospace;overflow:auto;' +
        'border-radius:10px;padding:10px;border:1px solid #333;white-space:pre-wrap;word-break:break-word;';
      document.documentElement.appendChild(panel);
    }
    panel.innerHTML = entries.length
      ? entries.map(e =>
          `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #2a2a2a;color:${e.level === 'error' ? '#ff8080' : '#ffd080'}">` +
          `[${e.time}] ${e.level.toUpperCase()}: ${e.text.replace(/</g,'&lt;')}</div>`
        ).join('')
      : '<div style="color:#777">No console.error or console.warn calls yet.</div>';
  }

  renderPanel();
})();

const VAPID_PUBLIC = 'BKx2HxDg6gYAevOBtaqDvhNHrEQgV3a8a0ytfaUCeBab0TQGKUf_FFylMttDymOFF8c_0aVMxcdAh6Y1mxNOvIo';

const { createClient } = window.supabase;
let db = null; // initialised after config loads

// supabase-js guards auth calls (signInWithPassword, setSession, etc.) with a
// cross-tab mutex built on navigator.locks. If a lock is ever orphaned — an
// aborted request, a reload mid-acquisition, a backgrounded tab — every
// future auth call queues behind it and hangs forever with no error. This
// app only ever runs one tab's worth of auth logic at a time, so trade away
// cross-tab coordination for a lock that can never deadlock.
const noOpAuthLock = async (name, acquireTimeout, fn) => fn();

/* ── DOM shortcuts ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  // screens
  screenAuth: $('screenAuth'),
  screenApp:  $('screenApp'),
  // auth
  formSignin:    $('formSignin'),
  formSignup:    $('formSignup'),
  siEmail:       $('siEmail'),
  siPassword:    $('siPassword'),
  suName:        $('suName'),
  suEmail:       $('suEmail'),
  suPassword:    $('suPassword'),
  btnSignin:     $('btnSignin'),
  btnSignup:     $('btnSignup'),
  btnForgot:     $('btnForgot'),
  msgSignin:     $('msgSignin'),
  msgSignup:     $('msgSignup'),
  // appbar
  appbarUser:    $('appbarUser'),
  appNav:        $('appNav'),
  tabBar:        $('tabBar'),
  btnSignout:    $('btnSignout'),
  btnSignoutHeader: $('btnSignoutHeader'),
  // views
  viewDashboard:    $('viewDashboard'),
  viewWorkout:      $('viewWorkout'),
  viewHistory:      $('viewHistory'),
  viewSettings:     $('viewSettings'),
  viewWorkoutAdmin: $('viewWorkoutAdmin'),
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
  dTodayWeight:   $('dTodayWeight'),
  dTodaySteps:    $('dTodaySteps'),
  dTodayCals:     $('dTodayCals'),
  dTodayBurn:     $('dTodayBurn'),
  dTodayDistance: $('dTodayDistance'),
  dLogTodayBtn:   $('dLogTodayBtn'),
  rSteps:         $('rSteps'),
  rStepsPct:      $('rStepsPct'),
  rCal:           $('rCal'),
  rCalPct:        $('rCalPct'),
  dashChart:      $('dashChart'),
  dashChartEmpty: $('dashChartEmpty'),
  dashChartSkeleton: $('dashChartSkeleton'),
  batteryFill:    $('batteryFill'),
  batteryScore:   $('batteryScore'),
  batteryMeta:    $('batteryMeta'),
  batteryFactors: $('batteryFactors'),
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
  // settings
  setDisplayName:    $('setDisplayName'),
  setUnit:           $('setUnit'),
  setTdee:           $('setTdee'),
  setStepsGoal:      $('setStepsGoal'),
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
  dxReadingAge:      $('dxReadingAge'),
  dxCurrentGlucose:  $('dxCurrentGlucose'),
  dxTrendArrow:      $('dxTrendArrow'),
  dxIob:             $('dxIob'),
  dxCob:             $('dxCob'),
  dxEffective:       $('dxEffective'),
  dxStaleNote:       $('dxStaleNote'),
  dxForecastBody:    $('dxForecastBody'),
  dxCorrectionBody:  $('dxCorrectionBody'),
  dxMealName:        $('dxMealName'),
  dxMealCarbs:       $('dxMealCarbs'),
  dxMealFat:         $('dxMealFat'),
  dxMealProtein:     $('dxMealProtein'),
  dxMealDoseBody:    $('dxMealDoseBody'),
  dxPatternsWindow:  $('dxPatternsWindow'),
  dxPatternsBody:    $('dxPatternsBody'),
  dxHealthBody:      $('dxHealthBody'),
  dxMealMemoryBody:  $('dxMealMemoryBody'),
  dxMfpImportsCard:  $('dxMfpImportsCard'),
  dxMfpImportsBody:  $('dxMfpImportsBody'),
  dxSensitivityBody: $('dxSensitivityBody'),
  dxRegimenBody:     $('dxRegimenBody'),
  dxGlucoseChart:      $('dxGlucoseChart'),
  dxGlucoseChartEmpty: $('dxGlucoseChartEmpty'),
  dxLastSync:        $('dxLastSync'),
  mfpNoToken:        $('mfpNoToken'),
  mfpHasToken:       $('mfpHasToken'),
  mfpBookmarklet:    $('mfpBookmarklet'),
  mfpTokenStatus:    $('mfpTokenStatus'),
  // global
  toast:         $('toast'),
};

/* ── App state ──────────────────────────────────────────── */
let currentUser    = null;
let profile        = null;   // profiles row
let activePlan     = null;   // weight_plans row (is_active=true)
let todayLog       = null;   // daily_logs row for today

const KCAL_PER_KG  = 7700;
const KCAL_PER_LB  = 3500;

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
const fmtInt = n => (n == null ? '—' : Math.round(n).toLocaleString());
const fmtSigned = (n, dp) => (n >= 0 ? '+' : '') + Number(n).toFixed(dp);
const clamp01 = (v, g) => Math.min(100, Math.max(0, (v / (g || 1)) * 100));
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

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
   AUTH — wired in initApp() after db is ready
═══════════════════════════════════════════════════════════ */

// Tab switching (no db needed — wire immediately)
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('auth-tab--active'));
    tab.classList.add('auth-tab--active');
    const which = tab.dataset.tab;
    el.formSignin.hidden = which !== 'signin';
    el.formSignup.hidden = which !== 'signup';
    el.msgSignin.textContent = '';
    el.msgSignup.textContent = '';
  });
});

function resetAuthForms() {
  el.siEmail.value    = '';
  el.siPassword.value = '';
  el.suEmail.value    = '';
  el.suPassword.value = '';
  el.suName.value     = '';
  setBtn(el.btnSignin, false, 'Sign in');
  el.msgSignin.textContent = '';
  el.msgSignup.textContent = '';
  el.msgSignin.classList.remove('is-ok');
  el.msgSignup.classList.remove('is-ok');
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('auth-tab--active'));
  document.querySelector('.auth-tab[data-tab="signin"]').classList.add('auth-tab--active');
  el.formSignin.hidden = false;
  el.formSignup.hidden = true;
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
}

// Auth state — module-scoped so it survives across the auth callback lifecycle
let authHandling  = false;
let authCompleted = false;

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
    setBtn(el.btnSignin, true, 'Sign in', 'Signing in…');
    el.msgSignin.textContent = '';

    const email    = el.siEmail.value.trim();
    const password = el.siPassword.value;

    const { error } = await db.auth.signInWithPassword({ email, password });

    if (error) {
      setBtn(el.btnSignin, false, 'Sign in');
      el.msgSignin.textContent = error.message;
      el.msgSignin.classList.remove('is-ok');
      return;
    }

    // Login succeeded. onAuthStateChange fires SIGNED_IN and handles the
    // screen transition (and button reset on failure) via its own logic.
  });

  // Sign up
  el.formSignup.addEventListener('submit', async e => {
    e.preventDefault();
    setBtn(el.btnSignup, true, 'Create account', 'Creating…');
    el.msgSignup.textContent = '';
    const { error } = await db.auth.signUp({
      email:    el.suEmail.value.trim(),
      password: el.suPassword.value,
      options:  { data: { full_name: el.suName.value.trim() } },
    });
    setBtn(el.btnSignup, false, 'Create account');
    if (error) {
      el.msgSignup.textContent = error.message;
    } else {
      el.msgSignup.textContent = 'Check your email to confirm your account, then sign in.';
      el.msgSignup.classList.add('is-ok');
    }
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
  // Shared by both the Settings-page button and the new header icon.
  async function handleSignOut() {
    await db.auth.signOut().catch(() => {});
    window.location.href = window.location.origin + window.location.pathname;
  }

  el.btnSignout.addEventListener('click', handleSignOut);
  el.btnSignoutHeader?.addEventListener('click', handleSignOut);

  // Auth state — single source of truth (declared at module scope above)

  db.auth.onAuthStateChange(async (event, session) => {
    if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.user) {

      // If we already loaded the app successfully this session, SIGNED_IN is a
      // token refresh event — don't re-run the full login flow, just update user ref
      if (authCompleted && event === 'SIGNED_IN') {
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
          loadProfileWithTimeout().catch(() => {}); // best-effort refresh, not awaited
        } else {
          if (el.msgSignin) el.msgSignin.textContent = 'Connecting…';
          await loadProfileWithTimeout();
        }
      } finally {
        authHandling = false;
      }

      const theme = profile?.theme || localStorage.getItem(THEME_KEY) || 'slate';
      applyTheme(theme, false); // apply visually only — don't write to DB during login

      if (!profile) {
        console.error('Profile failed to load — session valid, showing retry');
        showScreen('auth');
        setBtn(el.btnSignin, false, 'Sign in');
        if (el.msgSignin) {
          el.msgSignin.textContent = 'Could not connect. Check your connection and tap "Sign in" to try again.';
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
            initOnboarding();
          } else {
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

            requestNotificationPermission();
          }
        } else if (role === 'rejected') {
          showScreen('pending');
          $('pendingState').hidden  = true;
          $('rejectedState').hidden = false;
        } else {
          await createApprovalRequest();
          showScreen('pending');
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
        } catch (fallbackErr) {
          console.error('Fallback also failed:', fallbackErr?.message || fallbackErr);
          // Last resort — just show the app screen
          showScreen('app');
        }
      }

    } else if (event === 'SIGNED_OUT' || (event === 'INITIAL_SESSION' && !session)) {
      authHandling  = false;
      authCompleted = false;
      currentUser   = null;
      profile       = null;
      activePlan    = null;
      todayLog      = null;
      clearWorkoutState(); // clear any saved workout on explicit sign out
      resetAuthForms();
      showScreen('auth');
    }
  });
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

const views = {
  dashboard:    el.viewDashboard,
  workout:      el.viewWorkout,
  history:      el.viewHistory,
  diabetes:     el.viewDiabetes,
  settings:     el.viewSettings,
  workoutAdmin: el.viewWorkoutAdmin,
};

const viewLoaders = {
  dashboard:    loadDashboard,
  workout:      loadWorkout,
  history:      loadHistory,
  diabetes:     loadDiabetes,
  settings:     loadSettings,
  workoutAdmin: loadWorkoutAdminData,
};

async function navigateTo(name) {
  // Hide all views including the admin screen
  Object.values(views).forEach(v => { if (v) v.hidden = true; });
  // Only update tab bar for main tabs — admin screen has no tab
  const mainTabs = ['dashboard','workout','history','diabetes','settings'];
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
    await _loadDashboardInner();
  } catch (err) {
    console.error('Dashboard load error:', err);
    // Don't boot the user — just show a quiet error state
    if (el.dLastWorkout) el.dLastWorkout.innerHTML = '<p class="empty-state">Dashboard error — pull to refresh.</p>';
  }
}

async function _loadDashboardInner() {
  const unit = profile?.weight_unit || 'kg';

  // ── Fetch all data in parallel ────────────────────────────
  const [logRes, healthRes, healthHistRes, logsRes, lastSessionRes, lastSyncRes] = await Promise.all([
    db.from('daily_logs')
      .select('*, cal_apple')
      .eq('user_id', currentUser.id)
      .eq('log_date', todayISO())
      .maybeSingle(),

    // Fetch last 2 days of health data — overnight metrics (VO2, HRV, sleep)
    // come from the previous night's sync, not today's row
    db.from('health_daily')
      .select('readiness_score, sleep_total_hrs, sleep_deep_hrs, sleep_rem_hrs, hrv_ms, resting_hr, active_energy_kcal, resting_energy_kcal, dietary_energy_kcal, spo2_avg, spo2_min, respiratory_rate, vo2_max, heart_rate_avg, distance_km, glucose_avg_mmol, weight_kg, steps, log_date')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 1 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: false })
      .limit(2),

    db.from('health_daily')
      .select('log_date, spo2_avg, respiratory_rate, wrist_temp_dev, vo2_max, heart_rate_avg, glucose_avg_mmol, hrv_ms, resting_hr, active_energy_kcal, resting_energy_kcal, dietary_energy_kcal, weight_kg')
      .eq('user_id', currentUser.id)
      .gte('log_date', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: true }),

    db.from('daily_logs')
      .select('log_date, weight')
      .eq('user_id', currentUser.id)
      .not('weight', 'is', null)
      .gte('log_date', new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10))
      .order('log_date', { ascending: true }),

    db.from('workout_sessions')
      .select(`id, session_date, split_type,
               workout_exercises (id, name, sort_order,
                 workout_sets (set_number, reps, weight, unit)
               )`)
      .eq('user_id', currentUser.id)
      .order('session_date', { ascending: false })
      .limit(1)
      .maybeSingle(),

    db.from('health_daily')
      .select('synced_at')
      .eq('user_id', currentUser.id)
      .order('synced_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const log           = logRes.data;
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
  // If resting not available yet, fall back to active only
  const totalBurn = (health, log, bmrFallback) => {
    const a = health?.active_energy_kcal ?? log?.active_energy_kcal;
    const r = health?.resting_energy_kcal ?? bmrFallback;
    if (a != null && r != null) return Math.round(a + r);
    if (a != null) return Math.round(a);
    if (r != null) return Math.round(r);
    return null;
  };

  const healthHistory = healthHistRes.data || [];
  const logs          = logsRes.data || [];
  const lastSession   = lastSessionRes.data;
  const lastSync      = lastSyncRes.data;

  todayLog = log;

  // ── Today metrics ─────────────────────────────────────────
  // Weight: today's log → health_daily today → health_daily yesterday (most recent reading)
  // Most recent known weight: today's log → today's health → latest reading in 30-day history
  const latestHistWeight = healthHistory
    .filter(h => h.weight_kg != null)
    .sort((a, b) => (a.log_date < b.log_date ? 1 : -1))[0]?.weight_kg ?? null;
  const todayWeight = log?.weight ?? health?.weight_kg ?? latestHistWeight;
  el.dTodayWeight.textContent = todayWeight ? fmt1(todayWeight) : '—';
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

  // Consumed — prefer health_daily dietary energy (most recent sync), fall back to daily_logs
  const displayCals = health?.dietary_energy_kcal != null ? health.dietary_energy_kcal
                    : log?.cal_apple != null             ? log.cal_apple
                    : log?.cal_total > 0                 ? log.cal_total
                    : null;
  el.dTodayCals.textContent = displayCals != null ? fmtInt(displayCals) : '—';

  // Burned — total energy expenditure (active + resting)
  if (el.dTodayBurn) {
    const burn = totalBurn(health, log, estimatedBmr);
    el.dTodayBurn.textContent = burn != null ? fmtInt(burn) : '—';
  }

  // Distance — walking + running, from Apple Watch
  if (el.dTodayDistance) {
    const distance = health?.distance_km;
    el.dTodayDistance.textContent = distance != null ? fmt1(distance) : '—';
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
  setRing(el.rSteps, el.rStepsPct, log?.steps, profile?.steps_goal || 10000);
  setRing(el.rCal,   el.rCalPct,   displayCals, activePlan ? parseInt(el.dCalTarget?.textContent?.replace(/[^\d]/g,'')) || 2000 : 2000);

  // ── Smart eat target — computed from real Apple Health data ──
  const smartTarget = await computeSmartEatTarget();

  // ── Weight plan card + mini chart ────────────────────────
  renderPlanCard(logs, smartTarget);
  const hasWeightData = logs.length > 0;
  el.dashChartSkeleton.hidden = true;
  el.dashChart.hidden         = !hasWeightData;
  el.dashChartEmpty.hidden    = hasWeightData;
  if (hasWeightData) drawChart(el.dashChart, el.dashChartEmpty, logs, activePlan);

  // ── Health widgets ────────────────────────────────────────
  renderBodyBattery(health, log);
  renderHealthTiles(health, healthHistory);
  renderNetCalories(health, healthHistory, log, estimatedBmr);

  // ── Last workout ──────────────────────────────────────────
  renderLastWorkout(lastSession);
}

function renderPlanCard(logs, smartTarget) {
  const unit = profile?.weight_unit || 'kg';
  el.dCurrentUnit.textContent = unit;
  el.dTargetUnit.textContent  = unit;

  if (!activePlan) {
    el.dCurrentWeight.textContent = logs.length ? fmt1(logs[logs.length - 1].weight) : '—';
    el.dTargetWeight.textContent  = '—';
    el.dProgressLabel.textContent = 'Set a plan in Settings';
    el.dProgressFill.style.width  = '0%';
    el.dPlanStats.hidden = true;
    return;
  }

  const latestW = logs.length ? Number(logs[logs.length - 1].weight) : Number(activePlan.start_weight);
  el.dCurrentWeight.textContent = fmt1(latestW);
  el.dTargetWeight.textContent  = fmt1(activePlan.target_weight);

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
    const methodNote = smartTarget.method === 'observed'
      ? '(based on your current intake)'
      : '(based on plan target)';
    if (el.dDeficitNeeded) {
      el.dDeficitNeeded.textContent = `${smartTarget.dailyDeficit.toLocaleString()} kcal/day ${methodNote}`;
    }
    const weeklyKg = (smartTarget.kgLeft / smartTarget.daysLeft * 7);
    el.dWeeklyPace.textContent = `${fmtSigned(-weeklyKg, 2)} ${unit}/wk`;
  } else {
    const remaining = activePlan.target_weight - latestW;
    const kcalPer   = unit === 'kg' ? KCAL_PER_KG : KCAL_PER_LB;
    const dailyChg  = remaining / daysLeft;
    const deficit   = -(dailyChg * kcalPer);
    const calTarget = Math.max(1200, Math.round((profile?.tdee || 2200) - deficit));
    el.dCalTarget.textContent = `${calTarget.toLocaleString()} kcal`;
    if (el.dDeficitNeeded) el.dDeficitNeeded.textContent = `${Math.round(deficit).toLocaleString()} kcal/day`;
    el.dWeeklyPace.textContent = `${fmtSigned(dailyChg * 7, 2)} ${unit}/wk`;
  }

  el.dPlanStats.hidden = false;
}

function renderLastWorkout(session) {
  if (!session) {
    el.dLastWorkout.innerHTML = '<p class="empty-state">No workouts logged yet.</p>';
    return;
  }
  const exHtml = (session.workout_exercises || [])
    .sort((a, b) => a.sort_order - b.sort_order)
    .slice(0, 3)
    .map(ex => {
      const chips = (ex.workout_sets || [])
        .sort((a, b) => a.set_number - b.set_number)
        .map(s => `<span class="set-chip">${s.reps ?? '—'} × ${s.weight ?? '—'} ${s.unit}</span>`)
        .join('');
      return `<div class="exercise-row">
        <div class="exercise-name">${ex.name}</div>
        <div class="set-chips">${chips}</div>
      </div>`;
    }).join('');

  const tag = splitTag(session.split_type);
  el.dLastWorkout.innerHTML = `
    <div style="margin-bottom:10px">${tag} <span style="font-size:12px;color:var(--ink-soft);font-family:var(--mono);margin-left:8px">${fmtDate(session.session_date)}</span></div>
    ${exHtml}
    ${(session.workout_exercises || []).length > 3 ? `<p style="font-size:12px;color:var(--ink-faint);font-family:var(--mono);margin-top:6px">+ ${(session.workout_exercises || []).length - 3} more exercises</p>` : ''}
  `;
}

function computeBodyBattery(health, log) {
  // ── Body Battery formula ─────────────────────────────────
  // Combines 4 factors into a 1-100 score:
  //   Sleep quality  40% — duration + stage quality
  //   HRV            25% — higher = better recovered
  //   Resting HR     15% — lower = better recovered
  //   Calorie balance 20% — active energy vs dietary intake

  let totalScore = 0;
  let totalWeight = 0;
  const factors = [];

  // ── Factor 1: Sleep (40%) ─────────────────────────────
  const sleep = health?.sleep_total_hrs;
  if (sleep != null) {
    let sleepScore;
    if      (sleep >= 8)           sleepScore = 100;
    else if (sleep >= 7)           sleepScore = 88;
    else if (sleep >= 6)           sleepScore = 70;
    else if (sleep >= 5)           sleepScore = 50;
    else if (sleep >= 4)           sleepScore = 30;
    else                           sleepScore = 15;

    // Bonus for quality sleep stages
    const deep = health?.sleep_deep_hrs || 0;
    const rem  = health?.sleep_rem_hrs  || 0;
    const qualityBonus = Math.min(10, (deep + rem) * 5);
    sleepScore = Math.min(100, sleepScore + qualityBonus);

    totalScore  += sleepScore * 0.40;
    totalWeight += 0.40;
    factors.push({ label: 'Sleep', val: `${fmt1(sleep)}h`, pct: sleepScore, cls: 'sleep' });
  }

  // ── Factor 2: HRV (25%) ───────────────────────────────
  const hrv = health?.hrv_ms;
  if (hrv != null) {
    let hrvScore;
    if      (hrv >= 100) hrvScore = 100;
    else if (hrv >= 80)  hrvScore = 90;
    else if (hrv >= 60)  hrvScore = 78;
    else if (hrv >= 40)  hrvScore = 62;
    else if (hrv >= 25)  hrvScore = 45;
    else if (hrv >= 15)  hrvScore = 28;
    else                 hrvScore = 15;

    totalScore  += hrvScore * 0.25;
    totalWeight += 0.25;
    factors.push({ label: 'HRV', val: `${Math.round(hrv)}ms`, pct: hrvScore, cls: 'hrv' });
  }

  // ── Factor 3: Resting HR (15%) ────────────────────────
  const rhr = health?.resting_hr;
  if (rhr != null) {
    let hrScore;
    if      (rhr < 50)           hrScore = 100;
    else if (rhr < 55)           hrScore = 92;
    else if (rhr < 60)           hrScore = 82;
    else if (rhr < 65)           hrScore = 70;
    else if (rhr < 70)           hrScore = 58;
    else if (rhr < 80)           hrScore = 42;
    else                         hrScore = 25;

    totalScore  += hrScore * 0.15;
    totalWeight += 0.15;
    factors.push({ label: 'Resting HR', val: `${Math.round(rhr)}bpm`, pct: hrScore, cls: 'hr' });
  }

  // ── Factor 4: Calorie balance (20%) ───────────────────
  // Active energy burned vs dietary intake — fuelled but not over/under
  const active   = health?.active_energy_kcal ?? log?.active_energy_kcal;
  const dietary  = health?.dietary_energy_kcal || log?.cal_total || log?.cal_apple;
  if (active != null && dietary != null) {
    // Ideal: dietary > active (net positive for recovery), but not excessively over
    const net = dietary - active;
    let calScore;
    if      (net >= 300 && net <= 800) calScore = 100; // well fuelled
    else if (net >= 100 && net < 300)  calScore = 88;
    else if (net >= 0   && net < 100)  calScore = 75;
    else if (net >= -200 && net < 0)   calScore = 58;  // slight deficit
    else if (net >= -500 && net < -200) calScore = 38; // meaningful deficit
    else if (net < -500)               calScore = 20;  // big deficit — low battery
    else                               calScore = 65;  // net > 800 — overfuelled

    totalScore  += calScore * 0.20;
    totalWeight += 0.20;
    factors.push({ label: 'Fuelling', val: `${net > 0 ? '+' : ''}${Math.round(net)} kcal`, pct: calScore, cls: 'cals' });
  }

  if (totalWeight === 0) return { score: null, label: '', factors: [] };

  const score = Math.round(totalScore / totalWeight);
  const label = score >= 80 ? 'Fully charged — great day to push hard.' :
                score >= 60 ? 'Good energy — train at normal intensity.' :
                score >= 40 ? 'Moderate — consider a lighter session.' :
                score >= 20 ? 'Low — prioritise recovery today.' :
                              'Depleted — rest day recommended.';

  return { score, label, factors };
}

function renderBodyBattery(health, log) {
  const result = computeBodyBattery(health, log);

  if (result.score == null) {
    el.batteryScore.textContent = '—';
    el.batteryFill.style.height = '0%';
    el.batteryFill.className    = 'battery-fill';
    el.batteryMeta.textContent  = 'Connect Apple Health to see your body battery.';
    el.batteryFactors.innerHTML = '';
    return;
  }

  const { score, label, factors } = result;

  // ── Render score ──────────────────────────────────────
  el.batteryScore.textContent = score;
  el.batteryFill.style.height = score + '%';
  el.batteryFill.className = 'battery-fill ' + (
    score >= 70 ? 'battery-fill--high' :
    score >= 40 ? 'battery-fill--medium' :
                  'battery-fill--low'
  );

  el.batteryMeta.textContent = label;

  // ── Render factor bars ────────────────────────────────
  el.batteryFactors.innerHTML = factors.map(f => `
    <div class="battery-factor">
      <span class="battery-factor__label">${f.label}</span>
      <div class="battery-factor__bar">
        <div class="battery-factor__fill battery-factor__fill--${f.cls}" style="width:${f.pct}%"></div>
      </div>
      <span class="battery-factor__val">${f.val}</span>
    </div>`).join('');
}

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

  // ── Blood Glucose — only show if health data exists ───────
  const glucose     = today?.glucose_avg_mmol;
  const glucoseHist = hist('glucose_avg_mmol');
  showTile('tileGlucose', glucose != null || glucoseHist.length > 0);
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
  const active  = today?.active_energy_kcal ?? log?.active_energy_kcal;
  const resting = today?.resting_energy_kcal ?? bmrFallback;
  const burned  = (active == null && resting == null) ? null
                : Math.round((active || 0) + (resting || 0));
  // If burn data is flowing but nothing eaten is logged yet, eaten = 0 (not yesterday's total)
  const consumed = today?.dietary_energy_kcal ?? (burned != null ? 0 : null);

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
    const hActive   = h.active_energy_kcal;
    const hResting  = h.resting_energy_kcal;
    const hBurned   = (hActive != null && hResting != null) ? hActive + hResting
                    : (hActive != null)                     ? hActive
                    : null;
    if (h.dietary_energy_kcal != null && hBurned != null) {
      weeklyNet += (h.dietary_energy_kcal - hBurned);
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
}
async function loadLog() {
  const unit = profile?.weight_unit || 'kg';
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
  const unit = profile?.weight_unit || 'kg';
  const stepsGoal = profile?.steps_goal || 10000;

  el.logWeight.value  = data?.weight      ?? '';
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
  const unit    = profile?.weight_unit || 'kg';
  const today   = new Date(); today.setHours(0,0,0,0);
  const end     = new Date(activePlan.target_date + 'T00:00:00');
  const daysLeft = Math.max(1, Math.round((end - today) / 86400000));

  // Use the most recent logged weight
  const latestW = todayLog?.weight ?? activePlan.start_weight;
  const remaining = activePlan.target_weight - latestW;
  const kcalPer   = unit === 'kg' ? KCAL_PER_KG : KCAL_PER_LB;
  const deficit   = -((remaining / daysLeft) * kcalPer);
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
  const row = {
    user_id:       currentUser.id,
    log_date:      el.logDate.value,
    weight:        parseFloat(el.logWeight.value)  || null,
    steps:         parseInt(el.logSteps.value)     || null,
    active_energy_kcal: parseFloat(el.logActiveCal.value) || null,
    cal_breakfast: parseInt(el.mBreakfast.value)   || null,
    cal_lunch:     parseInt(el.mLunch.value)        || null,
    cal_dinner:    parseInt(el.mDinner.value)       || null,
    cal_snacks:    parseInt(el.mSnacks.value)       || null,
    notes:         el.logNotes.value.trim() || null,
  };

  const { error } = await db
    .from('daily_logs')
    .upsert(row, { onConflict: 'user_id,log_date' });

  setBtn(el.btnSaveLog, false, 'Save entry');

  if (error) {
    flash(el.logStatus, 'Error saving — ' + error.message, true);
  } else {
    flash(el.logStatus, 'Saved.');
    if (el.logDate.value === todayISO()) {
      todayLog = row;
    }
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
  routineList:       $('routineList'),
  readinessBanner:   $('readinessBanner'),
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
  renderWorkoutReadinessBanner();
  await loadRoutines();
}

// Reads today's Body Battery (same formula as the dashboard) and, if recovery
// is running low, surfaces a banner offering to filter the routine list down
// to the shortest available sessions for today only.
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

  const { score, label } = computeBodyBattery(health, logRes.data);

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
      <div class="readiness-banner__desc">Body battery is at ${score} today — ${label.toLowerCase()}</div>
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

  // If prefer_full_body, only show full_body_day routines; else show PPL (null full_body_day)
  const preferFB = profile?.prefer_full_body;
  const filtered = preferFB
    ? data.filter(r => r.full_body_day !== null)
    : data.filter(r => r.full_body_day === null);

  const routines = filtered.length ? filtered : data;

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
    .select('exercise_name, search_name, gif_url, muscles_primary, muscles_secondary, key_cues, common_mistakes')
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

  // 5. Build active exercise state with per-set tracking
  const userUnit = profile?.weight_unit || 'kg';
  // Determine rest seconds (user override takes priority over routine default)
  const goalKey = { weight_loss: 'rest_weight_loss', tone: 'rest_tone', strength: 'rest_strength' }[profile?.goal || 'tone'];
  const restSecs = profile?.[goalKey] ?? routine.rest_seconds;

  activeRoutine = routine;
  activeExercises = exercises.map(ex => ({
    ...ex,
    media: mediaByName[ex.name] || null,
    pr: prByName[ex.name] || null,
    restSeconds: restSecs,
    sets: Array.from({ length: ex.sets }, (_, i) => ({
      setNum: i + 1,
      reps:   ex.reps ? String(ex.reps) : '',
      weight: '',
      done:   false,
    })),
  }));

  // Default Superset Mode on if this routine was authored with predefined
  // pairs; off otherwise (the toggle can still turn it on for any routine —
  // it just falls back to pairing consecutive exercises by position).
  supersetModeOn = activeExercises.some(e => e.superset_group);

  saveWorkoutState(); // persist immediately on start
  renderActiveWorkout();
}

// Returns { role: 'first'|'second', partnerIndex } for an exercise that's
// part of an active superset pair, or null if it should behave as a normal
// standalone exercise (Superset Mode off, or this exercise isn't grouped).
function getSupersetInfo(ei) {
  if (!supersetModeOn) return null;

  const anyGrouped = activeExercises.some(e => e.superset_group);

  if (anyGrouped) {
    const ex = activeExercises[ei];
    if (!ex.superset_group) return null;
    const next = activeExercises[ei + 1];
    const prev = activeExercises[ei - 1];
    if (next && next.superset_group === ex.superset_group) return { role: 'first', partnerIndex: ei + 1 };
    if (prev && prev.superset_group === ex.superset_group) return { role: 'second', partnerIndex: ei - 1 };
    return null;
  }

  // No predefined pairs anywhere in this routine — the toggle still does
  // something useful by pairing consecutive exercises by position.
  const isFirstOfPair = ei % 2 === 0;
  const partnerIndex  = isFirstOfPair ? ei + 1 : ei - 1;
  if (partnerIndex < 0 || partnerIndex >= activeExercises.length) return null; // odd one out
  return { role: isFirstOfPair ? 'first' : 'second', partnerIndex };
}

// Manually pair two exercises as a superset — breaks either one out of
// whatever pair it was already in, tags both with a shared group id, and
// moves the second one to sit directly after the first so the existing
// adjacency-based rendering/rest-timer logic in getSupersetInfo() just works.
function pairExercises(idxA, idxB) {
  [idxA, idxB].forEach(idx => {
    const g = activeExercises[idx].superset_group;
    if (g) activeExercises.forEach(e => { if (e.superset_group === g) e.superset_group = null; });
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
  if (!g) return;
  activeExercises.forEach(e => { if (e.superset_group === g) e.superset_group = null; });
  saveWorkoutState();
}

function renderActiveWorkout() {
  const unit = profile?.weight_unit || 'kg';
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

  elW.activeExList.innerHTML = activeExercises.map((ex, ei) => {
    const hasMedia = !!ex.media;
    const ssInfo = getSupersetInfo(ei);
    const wrapOpen  = ssInfo?.role === 'first'
      ? `<div class="superset-block"><div class="superset-block__label">
           <span>⚡ SUPERSET · a set of each, then rest</span>
           <button type="button" class="superset-block__unlink" data-ei="${ei}">Unpair</button>
         </div>`
      : '';
    const wrapClose = ssInfo?.role === 'second' ? `</div>` : '';
    const pairBadge = ssInfo
      ? `<span class="exercise-card__pair-badge">${ssInfo.role === 'first' ? '1st' : '2nd'} of pair</span>`
      : '';
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
          ${s.done?'readonly':''}></td>
        <td style="font-size:11px;color:var(--ink-3)">${unit}</td>
        <td>
          ${s.done
            ? `<button type="button" class="set-action-btn is-complete" data-ei="${ei}" data-si="${si}" title="Tap to edit this set">✓</button>`
            : `<button type="button" class="set-action-btn is-done-btn" data-ei="${ei}" data-si="${si}">Done</button>`
          }
        </td>
      </tr>`).join('');

    return `${wrapOpen}<div class="exercise-card" data-ei="${ei}">
      <div class="exercise-card__head">
        <div class="exercise-card__name">
          ${ei === 0 ? '<span class="exercise-card__focus-tag">FOCUS</span>' : ''}
          <div class="exercise-card__name-text">${ex.name} ${subBadge} ${pairBadge}</div>
        </div>
        <div class="exercise-card__actions">
          ${linkModeOn ? `<button type="button" class="exercise-card__link-btn ${linkPendingIndex === ei ? 'is-pending' : ''}" data-ei="${ei}" title="Tap to pair with another exercise">🔗</button>` : ''}
          ${hasMedia ? `<button type="button" class="exercise-card__info-btn" data-ei="${ei}" title="Exercise guide">ⓘ</button>` : ''}
          <button type="button" class="exercise-card__equip-btn" data-ei="${ei}" title="Change equipment">🔁</button>
          <button type="button" class="exercise-card__remove-btn" data-ei="${ei}" title="Remove exercise">✕</button>
        </div>
      </div>
      ${ex.pr && ex.pr.best_weight != null ? `<div class="exercise-card__pr" style="font-size:12px;color:var(--ink-2);margin-bottom:4px">
        🏆 Last best: ${ex.pr.best_weight}${ex.pr.best_weight_unit || 'kg'} × ${ex.pr.best_weight_reps || '?'} reps
      </div>` : ''}
      ${ex.notes ? `<div class="exercise-card__notes">${ex.notes}</div>` : ''}
      ${hasMedia ? `
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
      </div>` : ''}
      <table class="active-sets-table">
        <thead>
          <tr>
            <th>Set</th><th>Reps</th><th>Weight</th><th>${unit}</th><th></th>
          </tr>
        </thead>
        <tbody>${setsHtml}</tbody>
      </table>
    </div>${wrapClose}`;
  }).join('') + `<button type="button" class="add-exercise-btn" id="btnAddExercise">+ Add exercise</button>`;

  const addBtn = document.getElementById('btnAddExercise');
  if (addBtn) addBtn.addEventListener('click', () => openAddExercisePicker());

  // Wire info buttons
  elW.activeExList.querySelectorAll('.exercise-card__info-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei;
      const drawer = $(`drawer-${ei}`);
      const isOpen = drawer.classList.contains('is-open');
      elW.activeExList.querySelectorAll('.exercise-info-drawer').forEach(d => d.classList.remove('is-open'));
      elW.activeExList.querySelectorAll('.exercise-card__info-btn').forEach(b => b.classList.remove('is-open'));
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

  elW.activeExList.querySelectorAll('.superset-block__unlink').forEach(btn => {
    btn.addEventListener('click', () => {
      unlinkPair(+btn.dataset.ei);
      renderActiveWorkout();
    });
  });

  // Wire set inputs
  elW.activeExList.querySelectorAll('.set-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const ei = +inp.dataset.ei, si = +inp.dataset.si;
      activeExercises[ei].sets[si][inp.dataset.field] = inp.value;
      saveWorkoutState(); // persist every keystroke
    });
  });

  // Wire done buttons — complete set + start rest timer
  elW.activeExList.querySelectorAll('.set-action-btn.is-done-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ei = +btn.dataset.ei, si = +btn.dataset.si;
      const ex = activeExercises[ei];
      ex.sets[si].done = true;

      // Carry this set's weight into any remaining not-yet-done sets
      // for the same exercise, as a starting-point default rather than
      // an overwrite — a set the person already typed a weight into
      // (planning ahead, or a deliberate different load) is left alone.
      // The existing generic input handler (data-field="weight") already
      // lets these pre-populated values be freely edited afterward,
      // exactly the same as any value the person typed themselves.
      const completedWeight = ex.sets[si].weight;
      if (completedWeight) {
        for (let laterSi = si + 1; laterSi < ex.sets.length; laterSi++) {
          if (!ex.sets[laterSi].done && !ex.sets[laterSi].weight) {
            ex.sets[laterSi].weight = completedWeight;
          }
        }
      }

      // Superset pairing: the first exercise of a pair goes straight into
      // its partner with no rest — the whole point of pairing them — and
      // only the second exercise of the pair triggers the real rest period.
      const ssInfo = getSupersetInfo(ei);

      renderActiveWorkout();

      if (ssInfo?.role === 'first') {
        const partner = activeExercises[ssInfo.partnerIndex];
        showToast(`Now: ${partner.name} — no rest, straight into the pair`);
        return;
      }

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

  elW.picker.hidden = true;
  elW.active.hidden = false;
}

// ── Lazy GIF fetching via Netlify Function proxy ──────────
async function fetchExerciseGif(ei, excludeId = null) {
  const ex = activeExercises[ei];
  if (!ex.media) return;

  const gifEl = $(`gif-${ei}`);
  if (gifEl) { gifEl.innerHTML = `<span class="exercise-info-drawer__gif--loading">⏳</span>`; }

  try {
    const url = `/.netlify/functions/exercise-media?name=${encodeURIComponent(ex.media.search_name)}`
      + (excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : '');
    const res  = await fetch(url);
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
elW.backToPicker.addEventListener('click', () => {
  activeRoutine   = null;
  activeExercises = [];
  elW.active.hidden  = true;
  elW.picker.hidden  = false;
  loadRoutines();
});

// ── Save workout ──────────────────────────────────────────
elW.btnSaveWorkout.addEventListener('click', async () => {
  if (!activeRoutine) return;
  const unit = profile?.weight_unit || 'kg';
  const date = elW.workoutDate.value || todayISO();

  setBtn(elW.btnSaveWorkout, true, 'Save workout');

  const { data: session, error: se } = await db.from('workout_sessions')
    .insert({ user_id: currentUser.id, session_date: date, split_type: activeRoutine.split_type })
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
  activeRoutine = null; activeExercises = [];
  elW.active.hidden = true;
  elW.picker.hidden = false;
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

async function loadWorkoutHistory() {
  if (!currentUser) return;
  elW.workoutHistoryList.innerHTML = '<p class="empty-state">Loading…</p>';
  let q = db.from('workout_sessions')
    .select(`id, session_date, split_type,
             workout_exercises (id, name, sort_order,
               workout_sets (set_number, reps, weight, unit))`)
    .eq('user_id', currentUser.id)
    .order('session_date', { ascending: false })
    .limit(40);

  if (elW.historyFilterSplit.value) q = q.eq('split_type', elW.historyFilterSplit.value);
  const { data, error } = await q;

  if (error || !data?.length) {
    elW.workoutHistoryList.innerHTML = '<p class="empty-state">No workouts logged yet.</p>';
    return;
  }

  elW.workoutHistoryList.innerHTML = data.map(s => {
    const exHtml = (s.workout_exercises || [])
      .sort((a,b) => a.sort_order - b.sort_order)
      .map(ex => {
        const chips = (ex.workout_sets || [])
          .sort((a,b) => a.set_number - b.set_number)
          .map(st => `<span class="set-chip">${st.reps??'—'} × ${st.weight??'—'} ${st.unit}</span>`)
          .join('');
        return `<div class="wh-exercise">
          <div class="wh-exercise__name">${ex.name}</div>
          <div class="set-chips">${chips || '<span style="color:var(--ink-faint);font-size:11px">No sets logged</span>'}</div>
        </div>`;
      }).join('');

    return `<div class="wh-card">
      <div class="wh-card__head">
        <span class="wh-card__date">${fmtDate(s.session_date)}</span>
        ${splitTag(s.split_type)}
      </div>
      <div class="wh-card__body">${exHtml || '<p class="empty-state">No exercises</p>'}</div>
    </div>`;
  }).join('');

  renderStrengthProgress(data);
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

  const unit = profile?.weight_unit || 'kg';

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
  const unit = profile?.weight_unit || 'kg';

  // Fetch daily logs
  const { data } = await db
    .from('daily_logs')
    .select('log_date, weight, steps, cal_total, cal_apple')
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
    const a = h.active_energy_kcal;
    const r = h.resting_energy_kcal;
    burnByDate[h.log_date] = (a != null && r != null) ? Math.round(a + r)
                           : (a != null)              ? Math.round(a)
                           : null;
  });

  el.historyTableBody.innerHTML = rows.map(r => {
    const cals    = r.cal_apple != null ? r.cal_apple : (r.cal_total > 0 ? r.cal_total : null);
    const burned  = burnByDate[r.log_date] ?? null;
    return `
    <tr>
      <td>${fmtDate(r.log_date)}</td>
      <td class="${r.weight ? '' : 'dim'}">${r.weight ? fmt1(r.weight) + ' ' + unit : '—'}</td>
      <td class="${r.steps ? '' : 'dim'}">${r.steps ? fmtInt(r.steps) : '—'}</td>
      <td class="${cals  ? '' : 'dim'}">${cals   != null ? fmtInt(cals)   + ' kcal' : '—'}</td>
      <td class="${burned ? '' : 'dim'}">${burned != null ? fmtInt(burned) + ' kcal' : '—'}</td>
    </tr>`;
  }).join('');

  const series = rows.filter(r => r.weight != null).reverse();

  drawChart(
    el.historyChart,
    el.historyChartEmpty,
    series.map(r => ({ date: r.log_date, weight: r.weight })),
    activePlan || null
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

  // Latest actual weight — use realSeries not synthetic entry
  const latestActual = realSeries[realSeries.length - 1]?.weight;
  if (latestActual == null) { el2.hidden = true; return; }

  const unit = profile?.weight_unit || 'kg';
  const diff = expectedNow - latestActual; // positive = ahead (lost more than projected)
  const absDiff = Math.abs(diff).toFixed(1);
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

el.btnExportCsv.addEventListener('click', async () => {
  const unit = profile?.weight_unit || 'kg';
  const { data } = await db
    .from('daily_logs')
    .select('log_date, weight, steps, cal_breakfast, cal_lunch, cal_dinner, cal_snacks, cal_total, notes')
    .eq('user_id', currentUser.id)
    .order('log_date', { ascending: true });

  const rows = [['date', `weight_${unit}`, 'steps', 'cal_breakfast', 'cal_lunch', 'cal_dinner', 'cal_snacks', 'cal_total', 'water_L', 'notes']];
  (data || []).forEach(r => rows.push([r.log_date, r.weight??'', r.steps??'', r.cal_breakfast??'', r.cal_lunch??'', r.cal_dinner??'', r.cal_snacks??'', r.cal_total??'', r.notes??'']));
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

  // ── Y axis — clamp to sane weight range (10–500 kg) ──────
  let lo = Math.min(...weights);
  let hi = Math.max(...weights);
  if (planStart) {
    lo = Math.min(lo, plan.target_weight || lo, plan.start_weight || lo);
    hi = Math.max(hi, plan.target_weight || hi, plan.start_weight || hi);
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
  if (plan && plan.start_weight && plan.target_weight && planStart && planEnd) {
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

  // ── 7-day trailing-average trend line ─────────────────────
  // Smooths daily water/glycogen noise so the underlying direction reads
  // clearly at a glance, drawn on top of the raw daily dots above.
  if (series.length >= 3) {
    const smoothed = dataDates.map((d) => {
      const windowStart = new Date(d.getTime() - 6 * 86400000);
      const windowVals = series
        .filter((p, j) => dataDates[j] >= windowStart && dataDates[j] <= d)
        .map(p => Number(p.weight))
        .filter(w => isFinite(w) && w > 0);
      return windowVals.length
        ? windowVals.reduce((a, b) => a + b, 0) / windowVals.length
        : null;
    });

    const trendColor = getComputedStyle(document.documentElement).getPropertyValue('--green').trim() || '#16A34A';

    ctx.save();
    ctx.strokeStyle = trendColor;
    ctx.lineWidth   = 2.5;
    ctx.lineJoin    = 'round';
    ctx.lineCap     = 'round';
    ctx.beginPath();
    let started = false;
    let lastPt = null;
    smoothed.forEach((w, i) => {
      if (w == null) return;
      const x = xDate(dataDates[i]);
      const y = yAt(w);
      if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
      lastPt = { x, y };
    });
    ctx.stroke();

    if (lastPt && H >= 120) {
      ctx.fillStyle    = trendColor;
      ctx.font         = `10px -apple-system,sans-serif`;
      ctx.textBaseline = 'bottom';
      ctx.textAlign    = 'left';
      ctx.fillText('trend', Math.min(lastPt.x + 4, W - px - 32), lastPt.y - 2);
    }
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

  // Sync theme picker
  const currentTheme = localStorage.getItem(THEME_KEY) || 'slate';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.theme === currentTheme);
  });

  loadHealthKeyStatus();

  // Apple Health toggle — defaults to checked/visible when unanswered
  // (profile.uses_apple_health is null, e.g. an account from before
  // this question existed), rather than silently hiding a real feature
  // from someone who was never actually asked.
  const appleToggle = $('setUsesAppleHealth');
  const syncControls = $('appleHealthSyncControls');
  if (appleToggle) {
    appleToggle.checked = profile?.uses_apple_health !== false;
    if (syncControls) syncControls.hidden = !appleToggle.checked;
    appleToggle.addEventListener('change', () => {
      if (syncControls) syncControls.hidden = !appleToggle.checked;
    });
  }

  // Pre-fill manual health date to today
  const mhDate = $('mhDate');
  if (mhDate && !mhDate.value) mhDate.value = todayISO();

  if (!profile) return;

  // Diabetes tracking (Nightscout) config — stored on the profile row,
  // same as every other per-user setting, so it survives across devices.
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
  renderMfpImportSettings();

  el.setDisplayName.value  = profile.display_name || '';
  el.setUnit.value         = profile.weight_unit  || 'kg';
  el.setTdee.value         = profile.tdee         || 2200;
  el.setStepsGoal.value    = profile.steps_goal   || 10000;

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
    el.setPlanStart.value      = activePlan.start_weight;
    el.setPlanTarget.value     = activePlan.target_weight;
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
    weight_unit:      el.setUnit.value,
    uses_apple_health: !!$('setUsesAppleHealth')?.checked,
    tdee:             parseInt(el.setTdee.value)      || 2200,
    steps_goal:       parseInt(el.setStepsGoal.value) || 10000,
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
    await db.from('weight_plans')
      .update({ is_active: false })
      .eq('user_id', currentUser.id)
      .eq('is_active', true);

    const { data: newPlan, error: ple } = await db.from('weight_plans')
      .insert({
        user_id:       currentUser.id,
        start_weight:  pStart,
        target_weight: pTarget,
        start_date:    pSDate,
        target_date:   pTDate,
        unit:          el.setUnit.value,
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

// Fat/protein per meal aren't tracked anywhere upstream (Nightscout
// treatments don't carry them), so this is its own table — diabetes_meals,
// RLS-scoped to auth.uid() same as every other per-user table — that
// suggestMacroMealDose reads back to personalize the split-dose guide once
// there's enough history. Nightscout stays the source of truth for
// glucose/bolus/basal; only the macro-tagged meal entries live here.
async function fetchMacroMealLog() {
  if (!currentUser) return [];
  const { data, error } = await db
    .from('diabetes_meals')
    .select('eaten_at, meal_name, carbs_g, fat_g, protein_g, suggested_units, matched_bolus_units, match_status')
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
    // The confirmed real dose once linked to a Nightscout bolus, else
    // the suggestion it was recorded with — manual entries assume the
    // suggestion was followed (recordMacroMeal), MFP 'suggested' rows
    // with no link yet stay unrated until confirmed.
    actualDose: r.matched_bolus_units != null ? Number(r.matched_bolus_units)
      : (r.match_status == null && r.suggested_units != null ? Number(r.suggested_units) : null),
  }));
}

// Recent MyFitnessPal-sourced entries (mfp-import.js writes these) for the
// review card — separate from fetchMacroMealLog above because this needs
// the match/hypo bookkeeping columns, not the engine-shaped {time, carbs,
// fat, protein} rows suggestMacroMealDose reads.
async function fetchMfpImports() {
  if (!currentUser) return [];
  const sinceIso = new Date(Date.now() - 3 * 24 * 60 * 60000).toISOString();
  const { data, error } = await db
    .from('diabetes_meals')
    .select('id, eaten_at, meal_name, carbs_g, fat_g, protein_g, match_status, hypo_treatment, matched_bolus_time, matched_bolus_units, suggested_units, upfront_units, delayed_units')
    .eq('user_id', currentUser.id)
    .eq('source', 'mfp')
    .gte('eaten_at', sinceIso)
    .order('eaten_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('fetchMfpImports error:', error.message);
    return [];
  }
  return data || [];
}

// Distinct past meal names, most-recently-used first, for the meal-dose
// helper's picker — lets a recurring meal be selected instead of retyped,
// and is exactly what suggestMacroMealDose matches on to personalize.
async function fetchMealNames() {
  if (!currentUser) return [];
  const { data, error } = await db
    .from('diabetes_meals')
    .select('meal_name, eaten_at')
    .eq('user_id', currentUser.id)
    .not('meal_name', 'is', null)
    .order('eaten_at', { ascending: false })
    .limit(200);
  if (error) {
    console.error('fetchMealNames error:', error.message);
    return [];
  }
  const seen = new Set();
  const names = [];
  for (const r of data || []) {
    const name = (r.meal_name || '').trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

async function recordMacroMeal(entry, doseResult) {
  if (!currentUser) return;
  const { error } = await db.from('diabetes_meals').insert({
    user_id: currentUser.id,
    eaten_at: new Date(entry.time).toISOString(),
    meal_name: entry.mealName || null,
    carbs_g: entry.carbs,
    fat_g: entry.fat,
    protein_g: entry.protein,
    suggested_units: doseResult?.suggestedUnits ?? null,
    upfront_units: doseResult?.upfrontUnits ?? null,
    delayed_units: doseResult?.delayedUnits ?? null,
    delay_minutes: doseResult?.guide?.delayMinutes ?? null,
    dose_source: doseResult?.source ?? null,
  });
  if (error) console.error('recordMacroMeal error:', error.message);
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
  flash($('diabetesSettingsStatus'), 'Saved.');
});

/* ── MyFitnessPal import bookmarklet ────────────────────────
   MFP sits behind a Cloudflare bot challenge that blocks any
   server-side fetch (confirmed directly against a real public diary —
   this isn't a "diary is private" issue), so there's no way for a
   Netlify function to poll it. A bookmarklet runs inside the user's
   own already-authenticated MFP tab instead — same-origin, so it can
   read the diary DOM directly with no CORS/Cloudflare problem — and
   POSTs the parsed items to mfp-import.js, which does the actual
   bolus-matching against Nightscout. The __TOKEN__/__ENDPOINT__
   placeholders get swapped for real values (as JSON string literals,
   so they're safely quoted) when the bookmarklet is built. */
const MFP_BOOKMARKLET_SRC = `(function(){
  var TOKEN = __TOKEN__;
  var ENDPOINT = __ENDPOINT__;
  function num(text){
    if (text == null) return null;
    var m = String(text).replace(/,/g, '').match(/-?\\d+(\\.\\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function numFromCell(cell){
    if (!cell) return null;
    var whole = cell.querySelector('.macro-value');
    if (whole) {
      var dec = cell.querySelector('.macro-percentage');
      var s = (whole.textContent || '').trim() + (dec ? '.' + (dec.textContent || '').trim() : '');
      var v = parseFloat(s);
      return isNaN(v) ? null : v;
    }
    return num(cell.textContent);
  }
  function sectionName(numStr){
    var names = {'1':'breakfast','2':'lunch','3':'dinner','4':'snacks','5':'snacks','6':'snacks'};
    return names[numStr] || 'snacks';
  }
  // One item per meal *section* (not per ingredient) — dosing happens
  // per meal, so the section's own totals row (already summed by MFP)
  // becomes the item's macros, and the individual food names are joined
  // into the label purely for display/reference.
  var items = [];
  var rows = document.querySelectorAll('#diary-table tr');
  var section = 'breakfast';
  var sectionLabel = 'Breakfast';
  var sectionNames = [];
  function flushSection(totalsRow){
    if (!sectionNames.length) return;
    var cells = totalsRow.querySelectorAll('td');
    var calories = numFromCell(cells[1]);
    var carbsG = numFromCell(cells[2]);
    var fatG = numFromCell(cells[3]);
    var proteinG = numFromCell(cells[4]);
    if (carbsG != null || fatG != null || proteinG != null || calories != null) {
      items.push({ mealSection: section, name: sectionLabel + ' \\u2014 ' + sectionNames.join(', '), carbsG: carbsG, fatG: fatG, proteinG: proteinG, calories: calories });
    }
    sectionNames = [];
  }
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cls = row.className || '';
    if (/meal_header/i.test(cls)) {
      var headCell = row.querySelector('td');
      var rawSection = headCell ? (headCell.textContent || '').trim() : '';
      section = sectionName(rawSection);
      sectionLabel = rawSection && !/^\\d+$/.test(rawSection) ? rawSection : (section.charAt(0).toUpperCase() + section.slice(1));
      sectionNames = [];
      continue;
    }
    if (/bottom|total/i.test(cls)) {
      flushSection(row);
      continue;
    }
    var cells = row.querySelectorAll('td');
    if (cells.length < 7) continue;
    var rawName = (cells[0].textContent || '').trim();
    if (!rawName) continue;
    var name = rawName.replace(/\\s*\\/?,\\s*[\\d.]+\\s*[a-zA-Z%]*\\s*$/, '').trim() || rawName;
    sectionNames.push(name);
  }
  if (!items.length) {
    alert('fitl00p: no food rows found. Make sure you\\'re on your own MFP diary page (myfitnesspal.com/food/diary) with food logged today.');
    return;
  }
  var preview = items.slice(0, 8).map(function(it){
    return '- ' + it.name + (it.carbsG != null ? ' (' + it.carbsG + 'g carbs)' : ' (no carb figure — turn on Carbs/Fat/Protein columns in MFP Diary Settings for better matching)');
  }).join('\\n') + (items.length > 8 ? '\\n…and ' + (items.length - 8) + ' more' : '');
  if (!confirm('Send ' + items.length + ' item(s) to fitl00p?\\n\\n' + preview)) return;
  var dateInput = document.querySelector('.date-picker input, input[name="date"]');
  var dateVal = (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10);
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, date: dateVal, items: items }),
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res.error) { alert('fitl00p import failed: ' + res.error); return; }
    var lines = (res.suggestions || []).map(function(s){
      if (s.suggestedUnits != null) {
        var line = s.name + ': ' + s.suggestedUnits + 'u';
        if (s.splitTier && s.splitTier !== 'single' && s.delayedUnits > 0) {
          line += ' (' + s.upfrontUnits + 'u now, ' + s.delayedUnits + 'u delayed)';
        }
        if (s.lowGlucoseWarning) line += ' \\u26a0 glucose is low — double-check before dosing';
        return line;
      }
      if (s.hypoTreatment) return s.name + ': hypo treatment — no bolus needed';
      if (s.withheldReason) return s.name + ': no suggestion (' + s.withheldReason + ') — check the Diabetes tab';
      return null;
    }).filter(Boolean);
    var summary = res.autoMatched + ' already matched to an existing bolus' + (res.skippedDuplicate ? ', ' + res.skippedDuplicate + ' already sent before' : '') + '.';
    alert('fitl00p:\\n\\n' + (lines.length ? lines.join('\\n\\n') : 'Nothing new to suggest.') + '\\n\\n' + summary);
  }).catch(function(err){
    alert('fitl00p import failed: ' + err.message);
  });
})();`;

// Shortcuts variant — for the "Run JavaScript on Web Page" action, not a
// bookmark click. Same parsing logic as MFP_BOOKMARKLET_SRC, but that
// action requires the script to call the global completion(result) on
// every exit path (Shortcuts enforces this and won't save the action
// without it) and confirm()/alert() aren't guaranteed to render inside
// its embedded WKWebView context, so this drops both dialogs — no
// preview-before-send, straight to completion(summary) — and surfaces
// the result via whatever the Shortcut does with the returned text
// (e.g. a "Show Result" or "Show Notification" action placed after it).
const MFP_SHORTCUT_SRC = `(function(){
  var TOKEN = __TOKEN__;
  var ENDPOINT = __ENDPOINT__;
  function num(text){
    if (text == null) return null;
    var m = String(text).replace(/,/g, '').match(/-?\\d+(\\.\\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }
  function numFromCell(cell){
    if (!cell) return null;
    var whole = cell.querySelector('.macro-value');
    if (whole) {
      var dec = cell.querySelector('.macro-percentage');
      var s = (whole.textContent || '').trim() + (dec ? '.' + (dec.textContent || '').trim() : '');
      var v = parseFloat(s);
      return isNaN(v) ? null : v;
    }
    return num(cell.textContent);
  }
  function sectionName(numStr){
    var names = {'1':'breakfast','2':'lunch','3':'dinner','4':'snacks','5':'snacks','6':'snacks'};
    return names[numStr] || 'snacks';
  }
  // One item per meal *section* (not per ingredient) — dosing happens
  // per meal, so the section's own totals row (already summed by MFP)
  // becomes the item's macros, and the individual food names are joined
  // into the label purely for display/reference.
  var items = [];
  var rows = document.querySelectorAll('#diary-table tr');
  var section = 'breakfast';
  var sectionLabel = 'Breakfast';
  var sectionNames = [];
  function flushSection(totalsRow){
    if (!sectionNames.length) return;
    var cells = totalsRow.querySelectorAll('td');
    var calories = numFromCell(cells[1]);
    var carbsG = numFromCell(cells[2]);
    var fatG = numFromCell(cells[3]);
    var proteinG = numFromCell(cells[4]);
    if (carbsG != null || fatG != null || proteinG != null || calories != null) {
      items.push({ mealSection: section, name: sectionLabel + ' \\u2014 ' + sectionNames.join(', '), carbsG: carbsG, fatG: fatG, proteinG: proteinG, calories: calories });
    }
    sectionNames = [];
  }
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    var cls = row.className || '';
    if (/meal_header/i.test(cls)) {
      var headCell = row.querySelector('td');
      var rawSection = headCell ? (headCell.textContent || '').trim() : '';
      section = sectionName(rawSection);
      sectionLabel = rawSection && !/^\\d+$/.test(rawSection) ? rawSection : (section.charAt(0).toUpperCase() + section.slice(1));
      sectionNames = [];
      continue;
    }
    if (/bottom|total/i.test(cls)) {
      flushSection(row);
      continue;
    }
    var cells = row.querySelectorAll('td');
    if (cells.length < 7) continue;
    var rawName = (cells[0].textContent || '').trim();
    if (!rawName) continue;
    var name = rawName.replace(/\\s*\\/?,\\s*[\\d.]+\\s*[a-zA-Z%]*\\s*$/, '').trim() || rawName;
    sectionNames.push(name);
  }
  if (!items.length) {
    completion('fitl00p: no food rows found on this page.');
    return;
  }
  var dateInput = document.querySelector('.date-picker input, input[name="date"]');
  var dateVal = (dateInput && dateInput.value) || new Date().toISOString().slice(0, 10);
  fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, date: dateVal, items: items }),
  }).then(function(r){ return r.json(); }).then(function(res){
    if (res.error) { completion('fitl00p import failed: ' + res.error); return; }
    var lines = (res.suggestions || []).map(function(s){
      if (s.suggestedUnits != null) {
        var line = s.name + ': ' + s.suggestedUnits + 'u';
        if (s.splitTier && s.splitTier !== 'single' && s.delayedUnits > 0) {
          line += ' (' + s.upfrontUnits + 'u now, ' + s.delayedUnits + 'u delayed)';
        }
        if (s.lowGlucoseWarning) line += ' \\u26a0 glucose is low';
        return line;
      }
      if (s.hypoTreatment) return s.name + ': hypo treatment, no bolus needed';
      if (s.withheldReason) return s.name + ': no suggestion (' + s.withheldReason + ')';
      return null;
    }).filter(Boolean);
    var summary = res.autoMatched + ' matched to an existing bolus' + (res.skippedDuplicate ? ', ' + res.skippedDuplicate + ' already sent before' : '') + '.';
    completion('fitl00p:\\n\\n' + (lines.length ? lines.join('\\n\\n') : 'Nothing new to suggest.') + '\\n\\n' + summary);
  }).catch(function(err){
    completion('fitl00p import failed: ' + err.message);
  });
})();`;

function buildMfpBookmarklet(token) {
  const endpoint = `${location.origin}/.netlify/functions/mfp-import`;
  const src = MFP_BOOKMARKLET_SRC
    .replace('__TOKEN__', JSON.stringify(token))
    .replace('__ENDPOINT__', JSON.stringify(endpoint));
  return 'javascript:' + src;
}

// Plain script, no "javascript:" prefix — Shortcuts' "Run JavaScript on Web
// Page" action wants raw JS in its script field, not a URI.
function buildMfpShortcutScript(token) {
  const endpoint = `${location.origin}/.netlify/functions/mfp-import`;
  return MFP_SHORTCUT_SRC
    .replace('__TOKEN__', JSON.stringify(token))
    .replace('__ENDPOINT__', JSON.stringify(endpoint));
}

// Kept separately from the anchor's .href on purpose: reading a <a> element's
// .href back from the DOM re-serializes the URL, and because the bookmarklet
// source contains "?" (ternaries), the browser's URL parser treats everything
// after the first one as a query string and percent-encodes spaces in it —
// silently corrupting the copy-to-clipboard text into invalid JS. Clicking
// the link still works (browsers percent-decode javascript: URLs before
// running them), but copying should hand back the exact original string.
let dxMfpBookmarkletRaw = null;
let dxMfpShortcutScriptRaw = null;

function renderMfpImportSettings() {
  const token = profile?.diabetes_mfp_import_token;
  if (el.mfpNoToken) el.mfpNoToken.hidden = !!token;
  if (el.mfpHasToken) el.mfpHasToken.hidden = !token;
  if (token && el.mfpBookmarklet) {
    dxMfpBookmarkletRaw = buildMfpBookmarklet(token);
    el.mfpBookmarklet.href = dxMfpBookmarkletRaw;
    dxMfpShortcutScriptRaw = buildMfpShortcutScript(token);
  }
}

async function generateMfpToken() {
  if (!currentUser) return;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  const { error } = await saveNsProfileFields({ diabetes_mfp_import_token: token });
  if (error) { flash($('mfpTokenStatus'), 'Error: ' + error.message, true); return; }
  renderMfpImportSettings();
  flash($('mfpTokenStatus'), 'Ready — drag the button to your bookmarks bar.');
}

$('btnMfpGenerateToken')?.addEventListener('click', generateMfpToken);
$('btnMfpRegenerateToken')?.addEventListener('click', async () => {
  if (!confirm('This breaks the old bookmarklet — you\'ll need to set it up again. Continue?')) return;
  await generateMfpToken();
});
$('btnMfpCopyLink')?.addEventListener('click', async () => {
  const href = dxMfpBookmarkletRaw;
  if (!href) return;
  try {
    await navigator.clipboard.writeText(href);
    flash($('mfpTokenStatus'), 'Copied — paste it as a bookmark\'s URL.');
  } catch {
    flash($('mfpTokenStatus'), 'Could not copy — long-press the button above instead.', true);
  }
});

$('btnMfpCopyShortcutScript')?.addEventListener('click', async () => {
  const script = dxMfpShortcutScriptRaw;
  if (!script) return;
  try {
    await navigator.clipboard.writeText(script);
    flash($('mfpTokenStatus'), 'Copied — paste into a "Run JavaScript on Web Page" action.');
  } catch {
    flash($('mfpTokenStatus'), 'Could not copy.', true);
  }
});

/* ── Data fetch (via the diabetes-sync Netlify function) ──── */
let diabetesData = null;       // adapted {glucoseHistory, boluses, corrections, basalDoses}
let diabetesFetchedAt = null;
const DIABETES_CACHE_MS = 4 * 60000; // avoid re-hitting Nightscout on every tab switch

async function fetchDiabetesData(force = false) {
  if (!profile?.diabetes_ns_url) return null;

  if (!force && diabetesData && diabetesFetchedAt && (Date.now() - diabetesFetchedAt) < DIABETES_CACHE_MS) {
    return diabetesData;
  }

  const qs = new URLSearchParams({ url: profile.diabetes_ns_url, days: '14' });
  if (profile.diabetes_ns_token)  qs.set('token', profile.diabetes_ns_token);
  if (profile.diabetes_ns_secret) qs.set('secret', profile.diabetes_ns_secret);

  const res = await fetch(`/.netlify/functions/diabetes-sync?${qs.toString()}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || `Sync failed (${res.status})`);

  diabetesData = body;
  diabetesFetchedAt = Date.now();
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

  fetchMealNames().then(names => {
    const list = $('dxMealNameOptions');
    if (list) list.innerHTML = names.map(n => `<option value="${escapeHtml(n)}">`).join('');
  });

  try {
    const data = await fetchDiabetesData();
    await renderDiabetesTab(data);
  } catch (err) {
    console.error('Diabetes sync error:', err);
    el.dxCorrectionBody.innerHTML = `<p class="empty-state" style="color:var(--red)">Couldn't reach Nightscout: ${escapeHtml(err.message)}</p>`;
    [el.dxForecastBody, el.dxPatternsBody, el.dxHealthBody, el.dxMealMemoryBody, el.dxSensitivityBody].forEach(n => { if (n) n.innerHTML = ''; });
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

/* ── Glucose/IOB/projection chart (canvas, no deps) ──────────
   Past ~6h of real glucose, active IOB along the bottom on its own
   scale, and a dashed near-term projection from the same model
   hypoForecast2h/projectedGlucoseCurve use — openly approximate, not
   a real predictive model, capped at 2h out for exactly that reason. */
function drawDxGlucoseChart(canvas, emptyEl, data, settings, now) {
  if (!canvas) return;
  const MAX_W = 800, MAX_H = 260, MIN_W = 100;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const rawW = canvas.parentElement?.clientWidth || 320;
  const rawH = parseInt(canvas.getAttribute('height')) || 180;
  const W = Math.min(MAX_W, Math.max(MIN_W, rawW));
  const H = Math.min(MAX_H, Math.max(120, rawH));
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const PAST_MIN = 360, FUTURE_MIN = 120;
  const windowStart = now - PAST_MIN * 60000;
  const windowEnd = now + FUTURE_MIN * 60000;

  const pastReadings = (data.glucoseHistory || [])
    .map(r => ({ ms: Number(r.time), value: Number(r.value) }))
    .filter(r => Number.isFinite(r.ms) && Number.isFinite(r.value) && r.ms >= windowStart && r.ms <= now)
    .sort((a, b) => a.ms - b.ms);

  if (pastReadings.length < 2) {
    if (emptyEl) emptyEl.hidden = false;
    canvas.hidden = true;
    return;
  }
  if (emptyEl) emptyEl.hidden = true;
  canvas.hidden = false;

  const input = { ...data, settings, activities: { workouts: [] } };
  const projected = DiabetesEngine.projectedGlucoseCurve(input, now, FUTURE_MIN, 15);

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

  const low = Number(settings.targetLow) || 4.5;
  const high = Number(settings.targetHigh) || 8.5;
  const allVals = [...pastReadings.map(r => r.value), ...projected.map(p => p.value), low, high];
  const gLo = Math.max(2, Math.min(...allVals) - 1);
  const gHi = Math.min(22, Math.max(...allVals) + 1);

  const padL = 26, padR = 8, padTop = 6, xAxisH = 14, iobStripH = 26, basalStripH = 26, stripGap = 9;
  const mainH = H - padTop - iobStripH - basalStripH - xAxisH - stripGap * 2 - 4;
  const iobTop = padTop + mainH + stripGap;
  const basalTop = iobTop + iobStripH + stripGap;

  const xAt = ms => padL + ((ms - windowStart) / (windowEnd - windowStart)) * (W - padL - padR);
  const yAt = v => padTop + mainH - ((v - gLo) / (gHi - gLo)) * mainH;

  // Target range band
  ctx.fillStyle = 'rgba(74, 222, 128, 0.10)';
  ctx.fillRect(padL, yAt(high), W - padL - padR, Math.max(0, yAt(low) - yAt(high)));

  // Y gridlines/labels
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  [4, 8, 12, 16, 20].filter(v => v >= gLo && v <= gHi).forEach(v => {
    const y = yAt(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
    ctx.fillText(String(v), padL - 4, y + 3);
  });

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

  // Bolus / correction dose markers along the main chart baseline
  const markerY = padTop + mainH - 3;
  ctx.font = '8px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  (data.boluses || []).forEach(b => {
    const ms = Number(b.time), units = Number(b.units);
    if (!Number.isFinite(ms) || !Number.isFinite(units) || units <= 0 || ms < windowStart || ms > now) return;
    const x = xAt(ms);
    ctx.fillStyle = '#facc15';
    ctx.beginPath();
    ctx.moveTo(x, markerY - 5); ctx.lineTo(x - 3.5, markerY); ctx.lineTo(x + 3.5, markerY);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(250, 204, 21, 0.9)';
    ctx.fillText(units.toFixed(1), x, markerY - 8);
  });
  (data.corrections || []).forEach(c => {
    const ms = Number(c.time), units = Number(c.units);
    if (!Number.isFinite(ms) || !Number.isFinite(units) || units <= 0 || ms < windowStart || ms > now) return;
    const x = xAt(ms);
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.moveTo(x, markerY - 6); ctx.lineTo(x - 3, markerY - 3); ctx.lineTo(x, markerY); ctx.lineTo(x + 3, markerY - 3);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(251, 146, 60, 0.9)';
    ctx.fillText(units.toFixed(1), x, markerY - 9);
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
  ctx.fillText('IOB', padL, iobTop - 1);

  // Basal strip (own 0..max scale) — drawn as step rectangles since
  // Control-IQ delivers as a continuously varying rate, not a flat line.
  if (basalSegments.length) {
    const maxRate = Math.max(0.1, ...basalSegments.map(s => s.rate));
    const basalY = v => basalTop + basalStripH - (v / maxRate) * basalStripH;
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
  ctx.fillText(basalSegments.length ? 'Basal u/hr' : 'Basal u/hr (no data)', padL, basalTop - 1);

  // X-axis hour labels
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  for (let h = -6; h <= 2; h += 2) {
    const t = now + h * 3600000;
    if (t < windowStart || t > windowEnd) continue;
    ctx.fillText(h === 0 ? 'now' : `${h > 0 ? '+' : ''}${h}h`, xAt(t), H - 3);
  }
}

async function renderDiabetesTab(data) {
  const settings = dxSettings();
  const macroMealLog = await fetchMacroMealLog();
  const input = { ...data, settings, activities: { workouts: [] }, macroMealLog };
  const now = Date.now();

  drawDxGlucoseChart(el.dxGlucoseChart, el.dxGlucoseChartEmpty, data, settings, now);

  const ctx = DiabetesEngine.dosingContext(input, now);
  renderDxNow(ctx);

  const forecast = DiabetesEngine.hypoForecast2h(input, now);
  renderDxForecast(forecast);

  const resolved = DiabetesEngine.resolveCorrections(data.corrections, data.glucoseHistory, data.boluses, now);
  const factor = DiabetesEngine.personalCorrectionFactor(resolved);
  const suggestion = DiabetesEngine.suggestCorrectionDose(ctx, factor, data.boluses, data.corrections, now);
  renderDxCorrection(suggestion);

  const patterns = DiabetesEngine.analyzePatterns(input, now);
  renderDxPatterns(patterns);

  const health = DiabetesEngine.insulinHealthCheck(input, now);
  renderDxHealth(health);

  const meals = DiabetesEngine.mealMemory(input, now);
  renderDxMealMemory(meals);

  const mfpImports = await fetchMfpImports();
  renderDxMfpImports(mfpImports, data.boluses || []);

  const sensitivity = DiabetesEngine.sensitivityMap(input, now);
  renderDxSensitivity(sensitivity);

  const regimen = DiabetesEngine.regimenReview(input, now);
  renderDxRegimen(regimen);

  el.dxLastSync.textContent = `Last synced ${new Date(diabetesFetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function renderDxNow(ctx) {
  el.dxCurrentGlucose.textContent = ctx.currentGlucose != null ? fmt1(ctx.currentGlucose) : '—';
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

function renderDxForecast(forecast) {
  if (!forecast.tier) {
    const msg = typeof WITHHELD_MESSAGES[forecast.withheldReason] === 'function'
      ? WITHHELD_MESSAGES[forecast.withheldReason](forecast.factor?.sampleSize)
      : (WITHHELD_MESSAGES[forecast.withheldReason] || 'Not enough data yet.');
    el.dxForecastBody.innerHTML = `<p class="empty-state">${escapeHtml(msg)}</p>`;
    return;
  }
  const t = DX_TIER_LABEL[forecast.tier];
  el.dxForecastBody.innerHTML = `
    <div class="dx-forecast-row">
      <span class="badge ${t.badge}">${t.label}</span>
      <span class="dx-forecast-val">${fmt1(forecast.forecastGlucose)} mmol/L projected</span>
    </div>
    ${forecast.bumpedForTimeOfDay ? '<p class="dx-note">This time of day has run low recently, so the forecast was bumped up a tier.</p>' : ''}
  `;
}

function renderDxCorrection(s) {
  if (s.withheldReason === 'stacking-caution') {
    const doses = s.stackingDoses.map(d => `${fmt1(d.units)}u, ${dxAgeLabel(d.ageMinutes)}`).join('; ');
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
      <span class="dx-suggestion__val">${fmt1(s.suggestedUnits)}u</span>
      <span class="dx-suggestion__meta">factor ${fmt1(s.factor)} mmol/L/u, from ${s.factorSampleSize} corrections</span>
    </div>
    ${s.cappedAt10 ? '<p class="dx-note">Capped at 10u — the raw math suggested more.</p>' : ''}
  `;
}

const DX_MEAL_WITHHELD_MESSAGES = {
  'stale-reading': 'No recent glucose reading — check your sensor app.',
  'missing-carb-ratio': 'Set a carb ratio in Settings first.',
};

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
    const input = { ...data, settings: dxSettings(), activities: { workouts: [] }, macroMealLog: await fetchMacroMealLog() };

    const r = DiabetesEngine.suggestMacroMealDose(input, { carbs, fat, protein, mealName: mealName || null }, now);
    if (r.suggestedUnits == null) {
      el.dxMealDoseBody.innerHTML = `<p class="empty-state">${DX_MEAL_WITHHELD_MESSAGES[r.withheldReason] || 'Not enough data yet.'}</p>`;
      return;
    }

    const glucoseLine = r.currentGlucose != null
      ? `${fmt1(r.currentGlucose)} mmol/L now${r.idealTarget != null ? ` → target ${fmt1(r.idealTarget)}` : ''}`
      : null;

    const doseHtml = r.guide.tier === 'single'
      ? `<div class="dx-suggestion">
          <span class="dx-suggestion__val">${fmt1(r.suggestedUnits)}u</span>
          <span class="dx-suggestion__meta">${escapeHtml(r.guide.message)}</span>
        </div>`
      : `<div class="dx-split-dose">
          <div class="dx-split-dose__part">
            <span class="dx-split-dose__label">Now</span>
            <span class="dx-split-dose__val">${fmt1(r.upfrontUnits)}u</span>
          </div>
          <div class="dx-split-dose__arrow">→</div>
          <div class="dx-split-dose__part">
            <span class="dx-split-dose__label">+${r.guide.delayMinutes}min</span>
            <span class="dx-split-dose__val">${fmt1(r.delayedUnits)}u</span>
          </div>
        </div>
        <p class="dx-note">${escapeHtml(r.guide.message)}</p>`;

    const breakdownParts = [];
    if (carbs > 0) breakdownParts.push(`${fmt1(r.carbUnits)}u for carbs`);
    if (r.correctionAvailable && Math.abs(r.correctionUnits) >= 0.05) {
      breakdownParts.push(`${fmtSigned(r.correctionUnits, 1)}u correction (factor ${fmt1(r.factor)}, ${r.factorSource === 'pump-setting' ? 'from pump settings' : `learned from ${r.factorSampleSize} corrections`})`);
    }
    if (r.iob >= 0.05) breakdownParts.push(`−${fmt1(r.iob)}u active IOB`);

    const personalizedNote = carbs > 0
      ? (r.personalized
        ? `Personalized from ${r.personalizedSampleSize} ${r.personalizedBy === 'meal-name' ? `past "${escapeHtml(mealName)}" meals` : 'similar-fat past meals'}${r.nudgePct ? `, nudged ${fmtSigned(r.nudgePct, 0)}%` : ''}.`
        : 'Guide default — log a few more meals like this to personalize it.')
      : '';

    el.dxMealDoseBody.innerHTML = `
      ${glucoseLine ? `<p class="dx-note" style="margin-bottom:8px">${escapeHtml(glucoseLine)}</p>` : ''}
      ${doseHtml}
      ${breakdownParts.length ? `<p class="dx-note">${escapeHtml(breakdownParts.join(' + '))}</p>` : ''}
      ${r.zeroedByFloor ? '<p class="dx-note" style="color:var(--orange)">The math went negative — capped at 0u since you\'re currently low.</p>' : ''}
      ${r.lowGlucoseWarning ? '<p class="dx-note" style="color:var(--orange)">You\'re below target right now — treat the low first if you need to.</p>' : ''}
      ${!r.correctionAvailable && r.idealTarget == null ? '<p class="dx-note">Set a correction target and factor in Settings to have this account for your current glucose.</p>' : ''}
      ${personalizedNote ? `<p class="dx-note">${personalizedNote}</p>` : ''}
    `;

    if (carbs > 0) await recordMacroMeal({ time: now, mealName: mealName || null, carbs, fat, protein }, r);
  } catch (err) {
    el.dxMealDoseBody.innerHTML = `<p class="empty-state" style="color:var(--red)">${escapeHtml(err.message)}</p>`;
  }
});

const DX_CATEGORY = {
  'needs-attention': { label: 'Needs attention', badge: 'badge--orange' },
  'going-well':       { label: 'Going well',       badge: 'badge--green' },
  'worth-knowing':    { label: 'Worth knowing',    badge: 'badge--blue' },
};

function renderDxPatterns(patterns) {
  if (!patterns.sufficient) {
    el.dxPatternsBody.innerHTML = `<p class="empty-state">Need at least ${patterns.minReadingsNeeded} readings in the last 7 days (have ${patterns.readingCount}).</p>`;
    return;
  }
  const groups = ['needsAttention', 'goingWell', 'worthKnowing'];
  const keyMap = { needsAttention: 'needs-attention', goingWell: 'going-well', worthKnowing: 'worth-knowing' };
  const items = groups.flatMap(g => patterns[g]);
  if (!items.length) {
    el.dxPatternsBody.innerHTML = '<p class="empty-state">No notable patterns this week.</p>';
    return;
  }
  el.dxPatternsBody.innerHTML = items.map(i => {
    const cat = DX_CATEGORY[i.category] || DX_CATEGORY[keyMap[i.category]] || { label: i.category, badge: 'badge--gray' };
    return `
      <div class="dx-insight">
        <div class="dx-insight__head">
          <span class="badge ${cat.badge}">${cat.label}</span>
          <span class="dx-insight__n">n=${i.n}</span>
        </div>
        <div class="dx-insight__title">${escapeHtml(i.title)}</div>
        <div class="dx-insight__summary">${escapeHtml(i.summary)}</div>
      </div>`;
  }).join('');
}

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
  el.dxHealthBody.innerHTML = `
    <div class="dx-health-grid">
      <div class="dx-health-stat"><span class="dx-health-stat__label">Time in range</span><span class="dx-health-stat__val">${fmt1(tw.tir.pctInRange)}%</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Below 3.9</span><span class="dx-health-stat__val">${fmt1(tw.tir.pctBelow)}%</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Above 10.0</span><span class="dx-health-stat__val">${fmt1(tw.tir.pctAbove)}%</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">CV</span><span class="dx-health-stat__val">${tw.cv != null ? fmt1(tw.cv) + '%' : '—'}</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Total daily dose</span><span class="dx-health-stat__val">${fmt1(tw.tdd)}u</span></div>
      <div class="dx-health-stat"><span class="dx-health-stat__label">Basal / bolus split</span><span class="dx-health-stat__val">${tw.basalPct != null ? Math.round(tw.basalPct) + '/' + Math.round(tw.bolusPct) : '—'}</span></div>
    </div>
    ${trendRow}
  `;
}

function renderDxMfpImports(items, boluses) {
  if (!el.dxMfpImportsCard) return;
  if (!items.length) {
    // Only show an empty state if MFP import is actually set up — otherwise
    // keep the card hidden entirely rather than advertising an unused feature.
    el.dxMfpImportsCard.hidden = !profile?.diabetes_mfp_import_token;
    if (!el.dxMfpImportsCard.hidden) {
      el.dxMfpImportsBody.innerHTML = '<p class="empty-state">Nothing imported yet — while viewing your MFP diary, tap the bookmarklet from Settings.</p>';
    }
    return;
  }
  el.dxMfpImportsCard.hidden = false;

  el.dxMfpImportsBody.innerHTML = items.map(it => {
    const eatenMs = new Date(it.eaten_at).getTime();
    const isMatched = it.match_status === 'auto' || it.match_status === 'manual';
    const isSuggested = it.match_status === 'suggested';
    let suggestedHtml = '';
    let actionHtml;
    if (isMatched) {
      actionHtml = `<span class="badge badge--green">✓ ${fmt1(it.matched_bolus_units)}u${it.match_status === 'manual' ? ' (linked)' : ''}</span>`;
    } else if (it.hypo_treatment) {
      actionHtml = `<span class="badge badge--blue">Hypo treatment — no bolus needed</span>
        <button class="btn btn--ghost btn--small" data-action="unhypo" data-id="${it.id}" style="margin-left:6px">Not a hypo?</button>`;
    } else {
      // Both a plain 'unmatched' row (couldn't compute a suggestion) and a
      // 'suggested' row (computed one, but the real bolus hasn't shown up
      // in Nightscout to confirm yet) still need the same "link once you've
      // actually dosed" action — a suggestion isn't a substitute for that.
      if (isSuggested) {
        suggestedHtml = `<div style="margin-bottom:6px"><span class="badge badge--orange">Suggested ${fmt1(it.suggested_units)}u</span>
          ${it.delayed_units > 0 ? `<span class="field-hint" style="margin-left:6px">${fmt1(it.upfront_units)}u now, ${fmt1(it.delayed_units)}u delayed</span>` : ''}</div>`;
      }
      const dayBoluses = boluses.filter(b => {
        const bd = new Date(Number(b.time));
        const id_ = new Date(eatenMs);
        return Number(b.units) > 0 && bd.toDateString() === id_.toDateString();
      });
      actionHtml = `
        <select data-role="mfp-bolus-pick" data-id="${it.id}">
          <option value="">Link the actual dose…</option>
          ${dayBoluses.map(b => `<option value="${b.time}|${b.units}">${new Date(Number(b.time)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — ${fmt1(b.units)}u</option>`).join('')}
        </select>
        <button class="btn btn--ghost btn--small" data-action="link" data-id="${it.id}">Link</button>
        <button class="btn btn--ghost btn--small" data-action="hypo" data-id="${it.id}">Mark hypo</button>`;
    }
    // Meal-grouped imports encode "Section — ingredient, ingredient, …"
    // in meal_name (see MFP_BOOKMARKLET_SRC) — split that into a bold
    // section title plus an ingredient sub-line. Older per-ingredient
    // rows (imported before grouping) have no dash and just show as-is.
    const dashIdx = it.meal_name.indexOf('—');
    const title = dashIdx >= 0 ? it.meal_name.slice(0, dashIdx).trim() : it.meal_name;
    const ingredients = dashIdx >= 0 ? it.meal_name.slice(dashIdx + 1).trim() : '';
    return `
      <div class="dx-mfp-item">
        <div class="dx-mfp-item__head">
          <strong>${escapeHtml(title)}</strong>
          <span class="field-hint">${fmt1(it.carbs_g)}g carbs · ${new Date(eatenMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </div>
        ${ingredients ? `<div class="field-hint" style="margin-top:2px">${escapeHtml(ingredients)}</div>` : ''}
        ${suggestedHtml}
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px">${actionHtml}</div>
      </div>`;
  }).join('');
}

el.dxMfpImportsBody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !currentUser) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;

  let updates = null;
  if (action === 'link') {
    const select = el.dxMfpImportsBody.querySelector(`select[data-id="${id}"]`);
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
  } else if (action === 'unhypo') {
    updates = { match_status: 'unmatched', hypo_treatment: false };
  }
  if (!updates) return;

  const { error } = await db.from('diabetes_meals').update(updates).eq('id', id).eq('user_id', currentUser.id);
  if (error) { showToast('Failed: ' + error.message, true); return; }

  const [mfpImports, data] = await Promise.all([fetchMfpImports(), fetchDiabetesData()]);
  renderDxMfpImports(mfpImports, data?.boluses || []);
});

function renderDxMealMemory(meals) {
  dxMealMemoryData = meals;
  if (!meals.length) {
    el.dxMealMemoryBody.innerHTML = '<p class="empty-state">Log meals with a name and carb count to build this up.</p>';
    return;
  }
  const outcomeLabel = { good: 'stayed in range', high: 'ran high', low: 'ran low' };
  const badge = (m, key, cls, label) => {
    const n = m.doseRatingCounts[key];
    if (!n) return '';
    return `<button type="button" class="badge ${cls}" style="border:none;cursor:pointer" data-dx-dose-meal="${escapeHtml(m.mealName)}" data-dx-dose-outcome="${key}">${n} ${label}</button>`;
  };
  el.dxMealMemoryBody.innerHTML = meals.map(m => {
    const statLines = [];
    if (m.n != null) {
      statLines.push(`${m.n} logged · avg rise ${fmtSigned(m.avgRise, 1)} mmol/L over ${Math.round(m.avgTimeToPeakMin)}m to peak`);
      if (m.lowRiskPct > 0) statLines.push(`<span style="color:var(--orange)">${Math.round(m.lowRiskPct)}% went low after</span>`);
    }
    let doseHtml = '';
    if (m.doseN != null) {
      doseHtml = `
        <div style="margin-top:${statLines.length ? 8 : 4}px">
          <span class="field-hint">Dosed ${m.doseN} time${m.doseN === 1 ? '' : 's'}, avg ${fmt1(m.avgDoseUsed)}u — tap a badge for details</span>
          <div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">
            ${badge(m, 'good', 'badge--green', 'good')}
            ${badge(m, 'high', 'badge--orange', 'ran high')}
            ${badge(m, 'low', 'badge--blue', 'ran low')}
          </div>
          <div class="field-hint" style="margin-top:4px">Last dose: ${fmt1(m.lastDose.units)}u — ${outcomeLabel[m.lastDose.outcome]}</div>
        </div>`;
    }
    return `
      <div class="dx-mfp-item">
        <div class="dx-mfp-item__head">
          <strong>${escapeHtml(m.mealName)}</strong>
          ${m.isDelayedRise ? '<span class="badge badge--purple" style="font-size:9px">delayed rise</span>' : ''}
        </div>
        ${statLines.length ? `<div class="field-hint" style="margin-top:4px">${statLines.join('<br>')}</div>` : ''}
        ${doseHtml}
      </div>`;
  }).join('');
}

function renderDxSensitivity(cells) {
  const withData = cells.filter(c => c.n > 0);
  if (!withData.length) {
    el.dxSensitivityBody.innerHTML = '<p class="empty-state">Not enough clean corrections yet to map this out.</p>';
    return;
  }
  el.dxSensitivityBody.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Time of day</th><th>Rest</th><th>Post-exercise</th></tr></thead>
        <tbody>
          ${['Night (00-06)', 'Morning (06-12)', 'Afternoon (12-18)', 'Evening (18-24)'].map(tod => {
            const rest = cells.find(c => c.timeOfDay === tod && c.context === 'rest');
            const ex   = cells.find(c => c.timeOfDay === tod && c.context === 'post-exercise');
            const fmtCell = c => c && c.n > 0 ? `${fmt1(c.avgDropPerUnit)} (n=${c.n})` : '—';
            return `<tr><td>${tod}</td><td>${fmtCell(rest)}</td><td>${fmtCell(ex)}</td></tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderDxRegimen(regimen) {
  const activeBasal = (regimen.basalByWindow || []).filter(w => !w.withheldReason);
  const ratio = regimen.carbRatio;
  const hasRatio = ratio && !ratio.withheldReason;

  if (!activeBasal.length && !hasRatio) {
    el.dxRegimenBody.innerHTML = '<p class="empty-state">Not enough clean data yet this week to review your basal or carb ratio.</p>';
    return;
  }

  const basalRows = activeBasal.map(w => `
    <div class="dx-insight">
      <div class="dx-insight__head">
        <span class="badge badge--orange">${w.direction === 'increase' ? 'Consider more basal' : 'Consider less basal'}</span>
        <span class="dx-insight__n">n=${w.n}</span>
      </div>
      <div class="dx-insight__title">${escapeHtml(w.timeOfDay)}: ${fmtSigned(w.suggestedPctChange, 0)}%${w.cappedAtLimit ? ' (capped)' : ''}</div>
      <div class="dx-insight__summary">Drifted ${fmtSigned(w.avgDrift, 1)} mmol/L over ${w.n} clean ${w.n === 1 ? 'instance' : 'instances'} with no insulin or carbs active.</div>
    </div>`).join('');

  const ratioRow = hasRatio ? `
    <div class="dx-insight">
      <div class="dx-insight__head">
        <span class="badge badge--orange">${ratio.direction === 'tighten' ? 'Consider tightening' : 'Consider loosening'}</span>
        <span class="dx-insight__n">n=${ratio.n}</span>
      </div>
      <div class="dx-insight__title">Carb ratio: ${fmt1(ratio.currentRatio)} → ${fmt1(ratio.suggestedRatio)} g/u${ratio.cappedAtLimit ? ' (capped)' : ''}</div>
      <div class="dx-insight__summary">Meals have ${ratio.direction === 'tighten' ? 'run high' : 'gone low'} ${ratio.n} time${ratio.n === 1 ? '' : 's'} this week at the current ratio.</div>
    </div>` : '';

  el.dxRegimenBody.innerHTML = basalRows + ratioRow;
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

const METRIC_CONFIG = {
  spo2:       { icon:'🫁', title:'Blood Oxygen (SpO2)',  unit:'%',         field:'spo2_avg',         format: v => fmt1(v),    label:'SpO2',        color:'#16A34A', min:90, max:100 },
  resp:       { icon:'💨', title:'Respiratory Rate',     unit:'brpm',      field:'respiratory_rate', format: v => fmt1(v),    label:'Resp rate',   color:'#3B7FF5', min:10, max:25  },
  temp:       { icon:'🌡️', title:'Wrist Temperature',    unit:'°C dev',    field:'wrist_temp_dev',   format: v => (v>0?'+':'')+fmt1(v), label:'Wrist temp', color:'#7C3AED' },
  vo2:        { icon:'❤️‍🔥', title:'VO2 Max',           unit:'mL/kg/min', field:'vo2_max',           format: v => fmt1(v),    label:'VO2 Max',     color:'#7C3AED' },
  hr:         { icon:'❤️', title:'Average Heart Rate',      unit:'bpm',       field:'heart_rate_avg',    format: v => fmtInt(v),  label:'Avg HR',      color:'#DC2626' },
  glucose:    { icon:'🩸', title:'Blood Glucose',         unit:'mmol/L',    field:'glucose_avg_mmol', format: v => fmt1(v),    label:'Glucose',     color:'#DC2626', min:3,  max:12  },
  fitnessAge: { icon:'🧬', title:'Fitness Age (VO2 Max)','unit':'years',   field:'vo2_max',           format: v => String(vo2ToFitnessAge(v) ?? '—'), label:'Fitness age', color:'#7C3AED', min:20, max:65 },
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

// ── Meal dose incident sheet — click a good/high/low badge in Meal
// memory to see the individual instances behind that count: BG before
// the meal, the dose used, and where glucose ended up afterward. Mirrors
// the #metricSheet bottom-sheet pattern above (same markup shape, swipe
// to dismiss), but its content is simple enough not to need that
// component's chart/stats-row machinery — just a filtered list.
let dxMealMemoryData = [];

const DX_OUTCOME_LABEL = { good: 'Stayed in range', high: 'Ran high', low: 'Ran low' };

function closeDxDoseSheet() {
  const sheet = $('dxDoseSheet');
  if (sheet) sheet.hidden = true;
}

function openDxDoseSheet(mealName, outcome) {
  const sheet = $('dxDoseSheet');
  if (!sheet) return;
  const meal = dxMealMemoryData.find(m => m.mealName === mealName);
  const instances = (meal?.doseInstances || []).filter(i => i.outcome === outcome);
  if (!instances.length) return;

  $('dxDoseSheetTitle').textContent = mealName;
  $('dxDoseSheetSub').textContent = `${DX_OUTCOME_LABEL[outcome]} — ${instances.length} instance${instances.length === 1 ? '' : 's'}`;

  $('dxDoseSheetList').innerHTML = instances.map(i => {
    const afterText = outcome === 'high' ? `peaked at ${fmt1(i.maxGlucose)}`
      : outcome === 'low' ? `dropped to ${fmt1(i.minGlucose)}`
      : `stayed ${fmt1(i.minGlucose)}–${fmt1(i.maxGlucose)}`;
    const when = new Date(i.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return `
      <div class="dx-mfp-item">
        <div class="dx-mfp-item__head">
          <strong>${escapeHtml(when)}</strong>
          <span class="field-hint">${fmt1(i.dose)}u${i.carbs != null ? ` · ${fmt1(i.carbs)}g carbs` : ''}</span>
        </div>
        <div class="field-hint" style="margin-top:4px">
          Before: ${i.preGlucose != null ? fmt1(i.preGlucose) + ' mmol/L' : '—'} → ${afterText} mmol/L
        </div>
      </div>`;
  }).join('');

  sheet.hidden = false;
}

document.addEventListener('click', e => {
  const badge = e.target.closest('[data-dx-dose-outcome]');
  if (badge) {
    openDxDoseSheet(badge.dataset.dxDoseMeal, badge.dataset.dxDoseOutcome);
    return;
  }
  if (e.target.closest('#dxDoseSheetClose')) {
    closeDxDoseSheet();
    return;
  }
  const backdrop = $('dxDoseSheet');
  if (backdrop && !backdrop.hidden && e.target.closest('#dxDoseSheet') && !e.target.closest('.bottom-sheet')) {
    closeDxDoseSheet();
  }
});

(function() {
  let startY = 0;
  document.addEventListener('touchstart', e => {
    const sheet = $('dxDoseSheet');
    if (sheet && !sheet.hidden && e.target.closest('.bottom-sheet')) startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    const sheet = $('dxDoseSheet');
    if (sheet && !sheet.hidden && e.target.closest('.bottom-sheet')) {
      const dy = e.changedTouches[0].clientY - startY;
      if (dy > 80) closeDxDoseSheet();
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
      <span class="metric-stat__label">Best</span>
      <span class="metric-stat__val">${cfg.format(key === 'fitnessAge' ? minVal : minVal)}</span>
      <span class="metric-stat__unit">${cfg.unit}</span>
    </div>
    <div class="metric-stat">
      <span class="metric-stat__label">Worst</span>
      <span class="metric-stat__val">${cfg.format(key === 'fitnessAge' ? maxVal : maxVal)}</span>
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
   MANUAL HEALTH ENTRY
═══════════════════════════════════════════════════════════ */
document.addEventListener('click', async e => {
  if (!e.target.closest('#btnSaveManualHealth') || !currentUser) return;

  const date        = $('mhDate')?.value         || todayISO();
  const sleepTotal  = parseFloat($('mhSleepTotal')?.value)  || null;
  const sleepDeep   = parseFloat($('mhSleepDeep')?.value)   || null;
  const sleepRem    = parseFloat($('mhSleepRem')?.value)    || null;
  const restingHr   = parseFloat($('mhRestingHr')?.value)   || null;
  const hrv         = parseFloat($('mhHrv')?.value)         || null;
  const glucoseAvg  = parseFloat($('mhGlucoseAvg')?.value)  || null;

  // Need at least one field
  if (!sleepTotal && !restingHr && !hrv && !glucoseAvg) {
    flash($('manualHealthStatus'), 'Enter at least one value.', true);
    return;
  }

  // Compute readiness locally using same formula as the server
  function computeReadinessLocal(sleep, hrv, rhr) {
    let score = 100;
    let factors = 0;
    if (sleep != null) {
      const s = sleep;
      let ss = s >= 7 && s <= 9 ? 100 : s >= 6 ? 75 : s >= 5 ? 50 : s > 9 ? 85 : 25;
      score = score * 0.6 + ss * 0.4; factors++;
    }
    if (hrv != null) {
      const h = hrv;
      let hs = h >= 80 ? 100 : h >= 60 ? 85 : h >= 40 ? 70 : h >= 20 ? 50 : 30;
      score = score * 0.7 + hs * 0.3; factors++;
    }
    if (rhr != null) {
      const r = rhr;
      let rs = r < 55 ? 100 : r < 65 ? 85 : r < 75 ? 70 : r < 85 ? 50 : 30;
      score = score * 0.8 + rs * 0.2; factors++;
    }
    return factors > 0 ? Math.round(Math.max(0, Math.min(100, score))) : null;
  }

  const row = {
    user_id:           currentUser.id,
    log_date:          date,
    sleep_total_hrs:   sleepTotal,
    sleep_deep_hrs:    sleepDeep,
    sleep_rem_hrs:     sleepRem,
    resting_hr:        restingHr,
    hrv_ms:            hrv,
    glucose_avg_mmol:  glucoseAvg,
    readiness_score:   computeReadinessLocal(sleepTotal, hrv, restingHr),
  };

  // Remove null values so we don't overwrite existing data
  Object.keys(row).forEach(k => row[k] === null && delete row[k]);

  const { error } = await db
    .from('health_daily')
    .upsert(row, { onConflict: 'user_id,log_date' });

  if (error) {
    flash($('manualHealthStatus'), 'Error: ' + error.message, true);
  } else {
    flash($('manualHealthStatus'), 'Saved.');
    // Clear form
    ['mhSleepTotal','mhSleepDeep','mhSleepRem','mhRestingHr','mhHrv','mhGlucoseAvg']
      .forEach(id => { if ($(id)) $(id).value = ''; });
  }
});

/* ═══════════════════════════════════════════════════════════
   APPLE HEALTH API KEY MANAGEMENT
═══════════════════════════════════════════════════════════ */
async function loadHealthKeyStatus() {
  const dot   = $('healthKeyDot');
  const label = $('healthKeyLabel');
  const btnRevoke = $('btnRevokeKey');
  if (!dot) return;

  try {
    const res  = await fetch('/.netlify/functions/health-apikey', {
      headers: { 'Authorization': `Bearer ${(await db.auth.getSession()).data.session?.access_token}` },
    });
    const data = await res.json();
    if (data.hasKey) {
      dot.className   = 'health-key-dot is-connected';
      label.textContent = `Connected · Last sync: ${data.key?.last_used ? fmtDate(data.key.last_used.slice(0,10)) : 'never'}`;
      btnRevoke.hidden = false;
    } else {
      dot.className   = 'health-key-dot is-none';
      label.textContent = 'Not connected';
      btnRevoke.hidden = true;
    }
  } catch {
    label.textContent = 'Could not check status';
  }
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('#btnGenerateKey');
  if (!btn || !currentUser) return;

  setBtn(btn, true, 'Generate API key', 'Generating…');
  try {
    const session = (await db.auth.getSession()).data.session;
    const res  = await fetch('/.netlify/functions/health-apikey', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${session?.access_token}` },
    });
    const data = await res.json();

    if (data.key) {
      $('healthKeyValue').textContent     = data.key;
      $('healthEndpointValue').textContent = data.endpoint;
      $('healthKeyReveal').hidden = false;
      loadHealthKeyStatus();
    } else {
      showToast('Failed to generate key: ' + (data.error || 'unknown error'), true);
    }
  } catch (err) {
    showToast('Error: ' + err.message, true);
  }
  setBtn(btn, false, 'Generate API key');
});

document.addEventListener('click', async e => {
  if (!e.target.closest('#btnRevokeKey')) return;
  if (!confirm('Revoke your Health Auto Export API key? The app will stop syncing until you generate a new key.')) return;
  const session = (await db.auth.getSession()).data.session;
  await fetch('/.netlify/functions/health-apikey', {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${session?.access_token}` },
  });
  $('healthKeyReveal').hidden = true;
  loadHealthKeyStatus();
  showToast('API key revoked.');
});

document.addEventListener('click', e => {
  if (e.target.closest('#btnCopyKey')) {
    navigator.clipboard.writeText($('healthKeyValue').textContent)
      .then(() => showToast('API key copied.'))
      .catch(() => showToast('Copy failed — select and copy manually.', true));
  }
  if (e.target.closest('#btnCopyEndpoint')) {
    navigator.clipboard.writeText($('healthEndpointValue').textContent)
      .then(() => showToast('Endpoint URL copied.'))
      .catch(() => showToast('Copy failed — select and copy manually.', true));
  }
});

/* ═══════════════════════════════════════════════════════════
   SMART EAT TARGET — recalculates weekly using real Apple data
═══════════════════════════════════════════════════════════ */
async function computeSmartEatTarget() {
  if (!currentUser || !activePlan || !profile) return null;

  const height = profile.height_cm  || 185.4;
  const age    = profile.age_years  || 37;
  const sex    = profile.sex        || 'male';

  // ── Latest actual weight ──────────────────────────────────
  const { data: latestW } = await db
    .from('health_daily')
    .select('weight_kg, log_date')
    .eq('user_id', currentUser.id)
    .not('weight_kg', 'is', null)
    .order('log_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const currentWeight = latestW?.weight_kg
    ? Number(latestW.weight_kg)
    : Number(activePlan.start_weight);

  // ── BMR — Mifflin-St Jeor ─────────────────────────────────
  const bmr = sex === 'female'
    ? (10 * currentWeight) + (6.25 * height) - (5 * age) - 161
    : (10 * currentWeight) + (6.25 * height) - (5 * age) + 5;

  // ── Last 7 days Apple Health data ─────────────────────────
  const { data: recentHealth } = await db
    .from('health_daily')
    .select('active_energy_kcal, dietary_energy_kcal, log_date')
    .eq('user_id', currentUser.id)
    .gte('log_date', new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));

  const activeVals = (recentHealth || [])
    .map(r => r.active_energy_kcal != null ? Number(r.active_energy_kcal) : null)
    .filter(v => v != null && v > 0);
  const avgActive = activeVals.length
    ? Math.round(activeVals.reduce((a, b) => a + b, 0) / activeVals.length)
    : 800;

  const dietVals = (recentHealth || [])
    .map(r => r.dietary_energy_kcal != null ? Number(r.dietary_energy_kcal) : null)
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

  // ── Persist on Sundays or if never set ───────────────────
  const isSunday = new Date().getDay() === 0;
  const neverSet = !profile.eat_target_kcal;
  if (isSunday || neverSet) {
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
      const res = await fetch('/.netlify/functions/admin-approve', {
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
    unit:         profile?.weight_unit  || 'kg',
    usesAppleHealth: profile?.uses_apple_health ?? null,
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
  if (state.unit)    activatePill($('obUnit'), state.unit);
  if (state.usesAppleHealth !== null) activatePill($('obAppleHealth'), state.usesAppleHealth ? 'yes' : 'no');
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
  $('obUnit')?.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      state.unit = p.dataset.val;
      activatePill($('obUnit'), state.unit);
    });
  });

  $('obAppleHealth')?.querySelectorAll('.pill').forEach(p => {
    p.addEventListener('click', () => {
      state.usesAppleHealth = p.dataset.val === 'yes';
      activatePill($('obAppleHealth'), p.dataset.val);
    });
  });

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
      if (state.usesAppleHealth === null) {
        $('obAppleHealth')?.classList.add('shake');
        setTimeout(() => $('obAppleHealth')?.classList.remove('shake'), 400);
        return false;
      }
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
      if (!sw || !tw || !td) {
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
      weight_unit:        state.unit,
      uses_apple_health:  state.usesAppleHealth,
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
      $('obSaving').textContent = 'Something went wrong — try again';
      $('obNext').disabled = false;
      return;
    }

    Object.assign(profile, profileUpdate);

    // Create weight plan if start + target provided
    if (state.startWeight && state.targetWeight && state.targetDate) {
      const today = todayISO();
      await db.from('weight_plans').update({ is_active: false })
        .eq('user_id', currentUser.id).eq('is_active', true);

      const { data: plan } = await db.from('weight_plans').insert({
        user_id:       currentUser.id,
        start_weight:  state.startWeight,
        target_weight: state.targetWeight,
        start_date:    today,
        target_date:   state.targetDate,
        unit:          state.unit,
        is_active:     true,
      }).select().single();

      if (plan) activePlan = plan;

      // Also log starting weight in daily_logs
      if (state.startWeight) {
        await db.from('daily_logs').upsert({
          user_id:  currentUser.id,
          log_date: today,
          weight:   state.startWeight,
        }, { onConflict: 'user_id,log_date' });
      }
    }

    // Done — transition to app
    $('obSaving').textContent = 'All set! Loading your dashboard…';
    await new Promise(r => setTimeout(r, 600));
    showScreen('app');
    navigateTo('dashboard');
    requestNotificationPermission();
  }
}

/* ═══════════════════════════════════════════════════════════
   THEME
═══════════════════════════════════════════════════════════ */
const THEME_KEY = 'fitl00p:theme';

function applyTheme(theme, persist = true) {
  // Migrate old theme names → new equivalents
  const OLD_MAP = { light: 'aurora', dark: 'slate', midnight: 'obsidian', forest: 'slate', rose: 'aurora', '': 'slate' };
  const validThemes = ['slate','obsidian','aurora'];
  const t = validThemes.includes(theme) ? theme : (OLD_MAP[theme] || 'slate');

  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);

  // Update picker active state
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.theme === t);
  });

  // Update logo accent colour
  updateLogoTheme(t);

  // Update PWA theme-color meta
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) {
    const themeColors = {
      slate:    '#111318',
      obsidian: '#0A0A0F',
      aurora:   '#FAF8F5',
    };
    metaTheme.content = themeColors[t] || '#111318';
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

function updateLogoTheme(theme) {
  // Update logo accent colours in the SVG appbar logo
  const accentMap = {
    slate:    '#C8F000',
    obsidian: '#00D4B4',
    aurora:   '#E85D26',
  };
  const accent = accentMap[theme] || '#C8F000';
  // Update any CSS variable we use for logo accent
  document.documentElement.style.setProperty('--logo-accent', accent);
}

// ── BOOT ─────────────────────────────────────────────────
// Apply theme immediately (before network — uses localStorage)
// Migrate old theme names → new equivalents
const OLD_THEME_MAP = { light: 'aurora', dark: 'slate', midnight: 'obsidian', forest: 'slate', rose: 'aurora' };
const rawSavedTheme = localStorage.getItem(THEME_KEY) || 'slate';
const savedTheme = OLD_THEME_MAP[rawSavedTheme] || rawSavedTheme;
if (OLD_THEME_MAP[rawSavedTheme]) localStorage.setItem(THEME_KEY, savedTheme); // update stored value
applyTheme(savedTheme, false);

// Wire theme picker
document.querySelectorAll('.theme-btn').forEach(btn => {
  btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
});

// Show auth screen immediately so there's never a black screen gap
// It will be replaced by the app screen if a valid session is found
showScreen('auth');

// Fetch Supabase credentials from Netlify Function, then start the app
(async () => {
  // Show a minimal loading indicator while config loads
  const loadingEl = document.createElement('div');
  loadingEl.id = 'bootLoader';
  loadingEl.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#111318;z-index:9999;flex-direction:column;gap:16px;';
  loadingEl.innerHTML = `
    <div style="font-family:-apple-system,sans-serif;font-size:22px;font-weight:900;letter-spacing:-.03em;color:#F0F2F7;">You<span style="color:#C8F000">F1t</span></div>
    <div style="width:32px;height:3px;background:rgba(255,255,255,.1);border-radius:3px;overflow:hidden;">
      <div style="height:100%;background:#C8F000;border-radius:3px;animation:bootPulse 1s ease-in-out infinite;"></div>
    </div>
    <style>@keyframes bootPulse{0%,100%{width:0%}50%{width:100%}}</style>`;
  document.body.appendChild(loadingEl);

  const removeLoader = () => {
    try { loadingEl.remove(); } catch {}
    const el2 = document.getElementById('bootLoader');
    if (el2) el2.remove();
  };

  try {
    const cfgRes = await fetch('/.netlify/functions/config');
    if (!cfgRes.ok) throw new Error(`Config HTTP ${cfgRes.status}`);
    const cfg = await cfgRes.json();
    if (!cfg.url || !cfg.key) throw new Error('Missing url or key in config response');

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
      const projectRef = new URL(cfg.url).hostname.split('.')[0];
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

    db = createClient(cfg.url, cfg.key, {
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
        lock:               noOpAuthLock,
      }
    });
  } catch (err) {
    removeLoader();
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;min-height:100dvh;
                  font-family:sans-serif;padding:24px;text-align:center;background:#111318;color:#F0F2F7">
        <div>
          <div style="font-size:32px;margin-bottom:12px">⚠️</div>
          <p style="font-size:17px;font-weight:600;margin-bottom:8px">fitl00p couldn't start</p>
          <p style="font-size:14px;color:#888;max-width:320px;line-height:1.5">
            Configuration missing — check that <strong>SUPABASE_URL</strong> and
            <strong>SUPABASE_ANON_KEY</strong> are set in Netlify environment variables.
          </p>
          <p style="font-size:12px;color:#666;margin-top:8px">${err.message}</p>
        </div>
      </div>`;
    return;
  }

  // Config loaded — remove loader before starting app
  removeLoader();

  // Wire all db-dependent listeners now that db is initialised
  initApp();

  // Supabase handles session persistence and auto-refresh automatically
  // via autoRefreshToken: true — no manual visibility handler needed

})();
