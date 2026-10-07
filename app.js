/* ============================================================
   PWMS — Panasonic Workforce Management Suite
   Supabase (Postgres + Auth + Realtime) persistence, Chart.js visuals
   ============================================================ */

// ─── SUPABASE CONFIG ────────────────────────────────────────
// TODO: paste your project's URL and anon (public) key here —
// Supabase Dashboard → Project Settings → API. The anon key is safe to
// ship client-side; it only grants what your Row Level Security policies
// allow (see the SQL you were given for the "workpulse_data" table).
const SUPABASE_URL = "https://wgjoufcgxnuuzmlipwrh.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_CwIw3rZXWCNOiAWAsHoCMQ_qDWgYoJA";

// Guard: if the Supabase JS library didn't load (CDN blocked by an ad
// blocker/firewall, offline, or the <script> tag order got changed so this
// file ran before it), fail with a clear on-screen message instead of a
// cryptic "Cannot read properties of undefined" error with no explanation.
if (!window.supabase || typeof window.supabase.createClient !== 'function') {
  const bootEl = document.getElementById('boot-loading');
  const msg = 'Could not load the Supabase library from the CDN. Check your internet connection, ad blocker, or firewall, then reload the page.';
  if (bootEl) {
    bootEl.textContent = msg;
    bootEl.style.color = '#B91C1C';
  } else {
    document.addEventListener('DOMContentLoaded', () => { document.body.insertAdjacentHTML('afterbegin', '<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font:600 14px system-ui,sans-serif;color:#B91C1C;background:#FEF2F2;z-index:99999">' + msg + '</div>'); });
  }
  throw new Error('Supabase JS library failed to load — aborting app init.');
}

// Primary client — used for the signed-in admin/manager/member's own session.
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Secondary client instance — lets an Admin create a Supabase Auth account
// for an employee (auth.signUp) WITHOUT signing the admin's own session out.
// A distinct storageKey + persistSession:false keeps its session completely
// isolated from (and never written to the same browser storage as) the
// primary client above, so creating an employee login can never disturb —
// or race against — the admin's own signed-in session.
const sbSecondary = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { storageKey: 'sb-secondary-auth', persistSession: false, autoRefreshToken: false }
});

// Creates a Supabase Auth account for an employee using the secondary client
// (so it doesn't touch the admin's own signed-in session on the primary
// client), then immediately signs that secondary session back out.
// NOTE: if your Supabase project has "Confirm email" enabled (Authentication
// → Providers → Email, on by default), an account created this way can't
// sign in until the employee clicks the confirmation link Supabase emails
// them. Turn that setting off if you want temp passwords to work immediately,
// the way they did under Firebase.
async function createEmployeeAuthAccount(email, password) {
  const { data, error } = await sbSecondary.auth.signUp({ email, password });
  if(error) throw error;
  await sbSecondary.auth.signOut();
  return data.user.id;
}

// ─── TIMEZONE: US EASTERN ───────────────────────────────────
// The whole app runs on US Eastern time (America/New_York: EST in winter, EDT in
// summer, switching automatically) no matter what timezone the user's device is in.
// - "today", current month/year, month picker, late-vs-on-time checks all use nowET().
// - Saved timestamps (createdAt / responseAt / completedAt) stay ISO-8601 UTC, which is
//   unambiguous; they are converted to Eastern only when displayed (fmtTimeET).
const APP_TZ = 'America/New_York';
const _etFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, hourCycle: 'h23',
  year:'numeric', month:'2-digit', day:'2-digit',
  hour:'2-digit', minute:'2-digit', second:'2-digit'
});
function _etParts(date) {
  const p = {};
  _etFormatter.formatToParts(date || new Date()).forEach(x => { p[x.type] = x.value; });
  return p;
}
// Returns a Date whose LOCAL getters (getFullYear/getMonth/getDate/getDay/getHours…)
// read the current US-Eastern wall-clock. Use it instead of `new Date()` for "now".
function nowET() {
  const p = _etParts();
  return new Date(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
}
// Live Eastern-time clock shown on the dashboard (confirms the app is on ET, not the device clock).
const _etClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TZ, weekday:'short', year:'numeric', month:'short', day:'numeric',
  hour:'numeric', minute:'2-digit', second:'2-digit', timeZoneName:'short'
});
function etClockText() {
  const p = {};
  _etClockFormatter.formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return p.weekday + ', ' + p.month + ' ' + p.day + ', ' + p.year + ' · ' +
         p.hour + ':' + p.minute + ':' + p.second + ' ' + (p.dayPeriod || '') + ' ' + p.timeZoneName;
}
function etClockHtml() {
  return '<div style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-size:12px;color:var(--text2)" title="This app runs on US Eastern time, regardless of your device timezone">' +
         '<span style="width:7px;height:7px;border-radius:50%;background:var(--green)"></span>' +
         '<strong id="et-clock">' + etClockText() + '</strong></div>';
}
function updateETClock() { const el = document.getElementById('et-clock'); if(el) el.textContent = etClockText(); }
setInterval(updateETClock, 1000);

// "YYYY-MM-DD HH:mm ET" for an ISO timestamp (replaces toLocaleString(), which used the device timezone).
function fmtDateTimeET(iso) {
  const p = _etParts(new Date(iso));
  return p.year + '-' + p.month + '-' + p.day + ' ' + String((+p.hour) % 24).padStart(2,'0') + ':' + p.minute + ' ET';
}
// "HH:mm" in US Eastern for an ISO timestamp.
function fmtTimeET(iso) {
  const p = _etParts(new Date(iso));
  return String((+p.hour) % 24).padStart(2,'0') + ':' + p.minute;
}

// ─── STATE ─────────────────────────────────────────────────
const STATE = {
  employees: [],
  projects: [], // {id,name,description,startDate,endDate,status('Active'|'On Hold'|'Completed'),allocations:[{employeeId,hoursPerDay}],createdAt,createdBy}
  leaves: [],
  regularReports: [],
  assignments: [],   // regular report assignments {id, reportId, employeeId, assignedDate}
  reportCompletions: [], // per-occurrence completion log {id, reportId, employeeId, periodKey ('M:YYYY-MM' | 'W:<Monday YYYY-MM-DD>'), dueDate, completedDate, markedBy, note, createdAt, override?:{by,byEmpId,at,reason,originalCompletedDate}}
  adhocTasks: [],
  qualityReviews: [],
  surveyResponses: [], // {id, taskId, employeeId, satisfaction(1-5), onTime(bool), quality(1-5), comments, score(0-100), year, month, recordedAt}
  holidays: [],
  skills: [],        // {id, name, category, description}
  teams: [],         // {id, name, manager}
  currentUser: null, // {role:'admin'|'manager'|'member', empId, name}
  currentMonth: nowET().getMonth(),
  currentYear: nowET().getFullYear(),
  currentPage: 'dashboard',
  reportTeamFilter: 'pending', reportTeamEmp: '', // UI-only filters for the manager Team Report Tracker
  showCompletedAdhoc: false, // UI-only toggle for Adhoc Tasks table, not persisted
  settings: {
    reportTrackingStart: '', // first date regular-report completion is enforced (set automatically on first login; admin can change it on the Regular Reports page)
    surveyInboxEmail: 'adhocsupport@yourcompany.com' // shared inbox that receives click-to-reply survey answers — edit in Adhoc Tasks page
  },
  notifications: [], // in-app activity log — {id,type,title,message,taskId,read,createdAt}, newest first, capped at 200
  charts: {}
};

// ─── PERSISTENCE (Supabase: Postgres + Realtime) ────────────
// Data model: one row per collection key in the "workpulse_data" table,
// holding the whole array as { items: [...] } in a jsonb column — e.g. the
// row with key='employees' has data={items:[...]}. This mirrors the old
// Firestore "one document per collection" shape (and before that, the even
// older "one localStorage key per array" shape) closely, so the hundreds of
// existing save()/STATE mutation call sites don't need to change — every one
// of them just mutates STATE and calls save() with no arguments. save()
// itself diffs STATE against the last known Supabase content and only
// writes the row(s) that actually changed (see save() below), so unrelated
// call sites never risk clobbering each other.
//
// Run this once in the Supabase SQL editor before using the app:
//
//   create table if not exists workpulse_data (
//     key text primary key,
//     data jsonb not null default '{}'::jsonb,
//     updated_at timestamptz not null default now()
//   );
//   alter table workpulse_data enable row level security;
//   create policy "Authenticated can read"   on workpulse_data for select using (auth.role() = 'authenticated');
//   create policy "Authenticated can insert" on workpulse_data for insert with check (auth.role() = 'authenticated');
//   create policy "Authenticated can update" on workpulse_data for update using (auth.role() = 'authenticated');
//   alter publication supabase_realtime add table workpulse_data;  -- enables realtime for this table
//
const DATA_DOC_KEYS = ['employees','leaves','regularReports','assignments','reportCompletions','adhocTasks','qualityReviews','surveyResponses','holidays','skills','teams','notifications','projects'];
const DATA_TABLE = 'workpulse_data';

let _realtimeChannel = null;
let _syncStarting = false;   // an initial load + subscribe is in flight
let _syncWaiters = [];       // onReady callbacks from callers that arrived while it was in flight

// ─── EXPLICIT LIFECYCLE FLAGS ───────────────────────────────
// authReady      → kept as the audited flag name; here it means "Auth
//                       has reported its initial state" (signed in or signed
//                       out — either way "resolved", so Supabase requests
//                       run in a known auth context instead of racing RLS).
// initialDataLoaded  → the initial bulk read of every row has completed, so
//                       STATE reflects real Supabase content (kept as
//                       _initialLoadDone internally; exposed here too).
// isSaving           → a save() write is currently in flight.
// isLoading          → convenience inverse of initialDataLoaded, used to
//                       block save() from ever firing on a half-loaded STATE.
let authReady = false;
let initialDataLoaded = false;
let isSaving = false;
let isLoading = true;
let _initialLoadDone = false; // kept for readability at existing call sites

// Last known-good Supabase content per key, DEEP-CLONED so it never shares
// array/object references with STATE (if it did, mutating STATE — e.g.
// STATE.employees.push(...) — would silently mutate this "remote" copy too,
// making every diff check below a no-op). Used by save() to write ONLY the
// row(s) that actually changed — see save() for why that matters.
let _remoteCache = {};
function _clone(v) { return JSON.parse(JSON.stringify(v)); }

// ─── 3-WAY MERGE HELPERS (lost-update protection) ────────────
// Every collection is stored as ONE row ({items:[…]}). If two people change
// the same collection at about the same time, a plain "last write wins" upsert
// silently deletes the other person's change — e.g. a member closes a report,
// then a manager's/another member's write lands with an older copy of the list
// and the report "re-opens". To prevent that, changes are merged BY RECORD ID:
// we work out what THIS browser changed (added / edited / removed records
// compared with the last copy it saw) and re-apply only those changes on top
// of the newest copy from the database.
function _canMergeById(arr) { return Array.isArray(arr) && arr.every(x => x && typeof x === 'object' && x.id != null); }
function _diffById(base, cur) {
  const baseMap = new Map(base.map(x => [x.id, JSON.stringify(x)]));
  const curIds = new Set(cur.map(x => x.id));
  return {
    upserts: cur.filter(x => !baseMap.has(x.id) || baseMap.get(x.id) !== JSON.stringify(x)),
    removed: new Set(base.filter(x => !curIds.has(x.id)).map(x => x.id))
  };
}
function _applyDiffById(items, d) {
  const out = items.filter(x => !d.removed.has(x.id));
  const idx = new Map(out.map((x, i) => [x.id, i]));
  d.upserts.forEach(x => { if(idx.has(x.id)) out[idx.get(x.id)] = x; else { idx.set(x.id, out.length); out.push(x); } });
  return out;
}
// newRemote + (what we changed locally since `base`) → merged list
function _rebaseItems(newRemote, base, local) {
  if(!_canMergeById(newRemote) || !_canMergeById(base) || !_canMergeById(local)) return newRemote;
  return _applyDiffById(newRemote, _diffById(base, local));
}

function _applyRow(key, data) {
  if(key === 'settings') {
    STATE.settings = Object.assign({}, STATE.settings, data || {});
    _remoteCache.settings = _clone(STATE.settings);
  } else if(DATA_DOC_KEYS.includes(key)) {
    const items = Array.isArray(data && data.items) ? data.items : [];
    // Keep this browser's not-yet-saved changes instead of throwing them away
    // (a realtime update from someone else, or the echo of our own previous
    // write, used to replace STATE wholesale and wipe an in-flight change).
    STATE[key] = (_initialLoadDone && _remoteCache[key] !== undefined)
      ? _rebaseItems(items, _remoteCache[key], STATE[key])
      : items;
    _remoteCache[key] = _clone(items);
  }
}

// Loads every row once (this is the equivalent of Firestore's first
// onSnapshot delivery), then subscribes to realtime changes so any edit —
// from this tab, another tab, or another user — updates STATE and
// re-renders automatically from then on. Calls onReady() once the initial
// load succeeds; never calls it on failure, so the app never renders on top
// of a half-loaded STATE.
// Removes this app's realtime channel (and any stale copy of it). supabase-js
// returns the EXISTING channel when you ask for the same name again, and adding
// postgres_changes callbacks to an already-subscribed channel throws — so a
// second startSync() (auth events firing while the first load is still running,
// or a quick logout/login before removeChannel finished) must never reuse it.
async function _dropRealtimeChannels() {
  const stale = (typeof sb.getChannels === 'function' ? sb.getChannels() : [])
    .filter(ch => ch.topic === 'realtime:workpulse_data_sync');
  if(_realtimeChannel && !stale.includes(_realtimeChannel)) stale.push(_realtimeChannel);
  _realtimeChannel = null;
  for(const ch of stale) { try { await sb.removeChannel(ch); } catch(e) { console.warn('[SUPABASE] removeChannel failed:', e); } }
}

async function startSync(onReady) {
  // Already running → just report ready. Loading right now → queue behind it,
  // so there is only ever one initial load and one realtime subscription.
  if(_initialLoadDone) { onReady(); return; }
  if(_syncStarting) { _syncWaiters.push(onReady); return; }
  _syncStarting = true;
  console.log('[SUPABASE] Loading initial data');
  let rows;
  try {
    const { data, error } = await sb.from(DATA_TABLE).select('key,data');
    if(error) throw error;
    rows = data || [];
  } catch(err) {
    // A failed read must NEVER be treated as "there is no data" — leave
    // STATE exactly at its untouched defaults and surface the error
    // clearly, rather than letting the app proceed with an empty STATE.
    console.error('[SUPABASE] Initial load failed:', err);
    setSyncStatus('error', err.message || String(err));
    toast('Could not load data from Supabase — check your connection', 'error');
    showBootError('Could not load data from Supabase: ' + (err.message || err) +
      '. Check your connection, that the Supabase project is not paused, and the workpulse_data table / RLS policies.');
    _syncStarting = false; _syncWaiters = [];
    return; // deliberately do NOT call onReady()
  }

  const found = new Set();
  rows.forEach(row => { found.add(row.key); _applyRow(row.key, row.data); });
  // Any key with no row yet (brand-new project) keeps STATE's built-in
  // default — just seed _remoteCache to match so save() can detect the
  // first real change and create that row, instead of never writing it.
  DATA_DOC_KEYS.concat(['settings']).forEach(key => {
    if(!found.has(key)) _remoteCache[key] = _clone(STATE[key]);
  });
  console.log('[SUPABASE] Initial data loaded:', rows.length, 'row(s)');

  console.log('[SUPABASE] Subscribing to realtime changes');
  await _dropRealtimeChannels();
  _realtimeChannel = sb.channel('workpulse_data_sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: DATA_TABLE }, payload => {
      const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
      if(!row || !row.key) return;
      console.log('[SUPABASE] Realtime change:', row.key, '(' + payload.eventType + ')');
      _applyRow(row.key, row.data);
      if(!isSaving) setSyncStatus('connected');
      if(row.key === 'notifications') updateNotificationBadge();
      if(_initialLoadDone) render();
    })
    .subscribe(status => {
      console.log('[SUPABASE] Realtime channel status:', status);
      if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Realtime dropping does NOT mean data is gone — STATE keeps
        // whatever it last had. Just tell the user sync is interrupted.
        setSyncStatus('error', 'Realtime disconnected — reload to resync');
      }
    });

  _initialLoadDone = true;
  initialDataLoaded = true;
  isLoading = false;
  _syncStarting = false;
  const waiters = _syncWaiters; _syncWaiters = [];
  onReady();
  waiters.forEach(fn => { try { fn(); } catch(e) { console.error(e); } });
}

function stopSync() {
  _dropRealtimeChannels();
  _syncStarting = false; _syncWaiters = [];
  _initialLoadDone = false;
  initialDataLoaded = false;
  isLoading = true;
  DATA_DOC_KEYS.forEach(k => { STATE[k] = []; });
  _remoteCache = {};
}

// Writes collections + settings back to Supabase in one upsert — but ONLY
// the rows whose content actually differs from the last known Supabase
// state (_remoteCache). This is the key fix carried over from the Firestore
// version: writing every row unconditionally on every save() meant a stale
// tab could silently overwrite another tab's newer edit to a row it never
// even touched. Diffing against _remoteCache means a tab only ever writes
// the key(s) it actually changed, never clobbering rows it didn't touch.
// Writes collections + settings back to Supabase in one upsert — but ONLY
// the rows whose content actually differs from the last known Supabase
// state (_remoteCache). This is the key fix carried over from the Firestore
// version: writing every row unconditionally on every save() meant a stale
// tab could silently overwrite another tab's newer edit to a row it never
// even touched. Diffing against _remoteCache means a tab only ever writes
// the key(s) it actually changed, never clobbering rows it didn't touch.
//
// Returns a Promise that resolves once the write actually lands (or
// immediately if there was nothing to save). Callers that need to do
// something navigation-risky right after saving — e.g. firing a mailto:
// link, which can interrupt an in-flight request in some browsers — should
// `await save()` first rather than treating it as fire-and-forget.
let _saveChain = Promise.resolve();
// Saves are queued one after another so two quick clicks can never land out of order.
// Resolves to true when the write landed (or there was nothing to write), false when it failed.
function save() {
  const p = _saveChain.then(_doSave).catch(e => { console.error('[SUPABASE] save chain error:', e); return false; });
  _saveChain = p;
  return p;
}

async function _doSave() {
  if(isLoading) {
    // Should not be reachable — the login/app UI stays hidden until initial
    // load completes — but this is the hard backstop against ever writing
    // a half-loaded/empty STATE over real Supabase data.
    console.warn('[SUPABASE] save() called before initial data finished loading — ignoring to protect existing data');
    return false;
  }
  const changes = [];
  const merge = {};   // key → {base, snapshot} for collections merged by id
  DATA_DOC_KEYS.forEach(key => {
    if(JSON.stringify(STATE[key]) !== JSON.stringify(_remoteCache[key])) {
      changes.push({ key, data: { items: STATE[key] } });
      if(_canMergeById(STATE[key]) && _canMergeById(_remoteCache[key])) merge[key] = { base: _remoteCache[key], snapshot: _clone(STATE[key]) };
    }
  });
  if(JSON.stringify(STATE.settings) !== JSON.stringify(_remoteCache.settings)) {
    changes.push({ key: 'settings', data: STATE.settings });
  }
  if(changes.length===0) { console.log('[SUPABASE] save() called with no changes — skipping write'); return true; }

  const changedKeys = changes.map(c => c.key);
  console.log('[SUPABASE] Saving', changedKeys.join(', '));
  isSaving = true;
  setSyncStatus('saving');

  // Read the newest copy of each changed collection and re-apply ONLY our
  // changes on top of it, so we never overwrite someone else's record.
  const merged = {};
  try {
    for(const key of Object.keys(merge)) {
      const { data: row, error: rErr } = await sb.from(DATA_TABLE).select('data').eq('key', key).maybeSingle();
      if(rErr) throw rErr;
      const remoteItems = row && row.data && Array.isArray(row.data.items) ? row.data.items : null;
      const m = (remoteItems && _canMergeById(remoteItems))
        ? _applyDiffById(remoteItems, _diffById(merge[key].base, merge[key].snapshot))
        : merge[key].snapshot;
      merged[key] = m;
      changes.find(c => c.key === key).data = { items: m };
    }
  } catch(error) {
    isSaving = false;
    console.error('[SUPABASE] Pre-save read FAILED:', error);
    setSyncStatus('error', error.message || String(error));
    toast('NOT SAVED — ' + (error.message || 'check your connection'), 'error', 10000);
    return false;
  }

  const { error } = await sb.from(DATA_TABLE).upsert(changes, { onConflict: 'key' });
  isSaving = false;
  if(error) {
    // A failed write must never be reported as a success elsewhere.
    console.error('[SUPABASE] Save FAILED:', changedKeys.join(', '), error);
    setSyncStatus('error', error.message || String(error));
    toast('NOT SAVED — ' + (error.message || 'check your connection'), 'error', 10000);
    return false;
  }
  console.log('[SUPABASE] Save successful:', changedKeys.join(', '));
  setSyncStatus('saved');
  let needsRender = false;
  changes.forEach(c => {
    if(c.key === 'settings') { _remoteCache.settings = _clone(STATE.settings); return; }
    if(merged[c.key]) {
      // Our changes are now in the database together with anyone else's.
      // Bring STATE up to date, keeping anything the user changed while the write was in flight.
      _remoteCache[c.key] = _clone(merged[c.key]);
      const next = _rebaseItems(merged[c.key], merge[c.key].snapshot, STATE[c.key]);
      if(JSON.stringify(next) !== JSON.stringify(STATE[c.key])) { STATE[c.key] = next; needsRender = true; }
    } else {
      _remoteCache[c.key] = _clone(STATE[c.key]);
    }
  });
  if(needsRender && _initialLoadDone) render();
  return true;
}

// ─── UTILS ──────────────────────────────────────────────────
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
// Escapes text for safe placement inside an HTML attribute value or element text
// (prevents quotes/angle-brackets in user-typed data like task titles/descriptions
// from breaking out of the input and corrupting the rest of the form).
function escHtml(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// Escapes text for safe placement inside a single-quoted JS string literal that
// itself sits inside a double-quoted HTML attribute (e.g. onclick="fn('${x}')").
function escJsAttr(s) { return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function today() { return fmtDate(nowET()); }
function fmtH(n) { return String(+(parseFloat(n)||0).toFixed(2)); } // 1 -> '1', 1.5 -> '1.5'
function fmtDate(d) {
  const dt = d instanceof Date ? d : parseDate(d);
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
}
function parseDate(s) { return new Date(String(s).slice(0,10) + 'T00:00:00'); }
function daysInMonth(y,m) { return new Date(y, m+1, 0).getDate(); }
function isWeekend(d) { const day=d.getDay(); return day===0||day===6; }
function isHoliday(dateStr) { return STATE.holidays.some(h=>h.date===dateStr); }
function isWorkingDay(d) { return !isWeekend(d) && !isHoliday(fmtDate(d)); }

function getWorkingDays(year, month) {
  const days=[];
  const total=daysInMonth(year,month);
  for(let i=1;i<=total;i++){
    const d=new Date(year,month,i);
    if(isWorkingDay(d)) days.push(fmtDate(d));
  }
  return days;
}

function nthWorkingDay(year, month, n) {
  const wds = getWorkingDays(year,month);
  return wds[n-1] || null;
}

function initials(name) {
  return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
}

function perfLabel(score) {
  if(score>=90) return {label:'Excellent', cls:'perf-excellent'};
  if(score>=75) return {label:'Good', cls:'perf-good'};
  if(score>=60) return {label:'Average', cls:'perf-average'};
  return {label:'Needs Improvement', cls:'perf-poor'};
}

function utilColor(pct) {
  if(pct<=60) return 'util-green';
  if(pct<=85) return 'util-amber';
  return 'util-red';
}
function calColor(pct) {
  if(pct<=60) return 'cal-green';
  if(pct<=85) return 'cal-amber';
  return 'cal-red';
}

// Month helpers
function monthName(m) {
  return ['January','February','March','April','May','June',
          'July','August','September','October','November','December'][m];
}
function selectedMonthLabel() {
  return `${monthName(STATE.currentMonth)} ${STATE.currentYear}`;
}

// ─── MONTH PICKER ───────────────────────────────────────────
function buildMonthPicker() {
  const sel = document.getElementById('month-select');
  sel.innerHTML = '';
  const now = nowET();
  for(let offset=-6; offset<=6; offset++){
    let d = new Date(now.getFullYear(), now.getMonth()+offset, 1);
    const opt = document.createElement('option');
    opt.value = `${d.getFullYear()}-${d.getMonth()}`;
    opt.textContent = `${monthName(d.getMonth())} ${d.getFullYear()}`;
    if(d.getFullYear()===STATE.currentYear && d.getMonth()===STATE.currentMonth) opt.selected=true;
    sel.appendChild(opt);
  }
}
function onMonthChange() {
  const [y,m] = document.getElementById('month-select').value.split('-').map(Number);
  STATE.currentYear = y; STATE.currentMonth = m;
  render();
}

// ─── TOAST ──────────────────────────────────────────────────
function toast(msg, type='info', ms=3000) {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  const icons = {success:'✓', error:'✗', info:'ℹ'};
  t.innerHTML = `<span>${icons[type]||'ℹ'}</span><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, ms);
}

// ─── NAVIGATION ─────────────────────────────────────────────
const PAGE_TITLES = {
  dashboard:'Dashboard', capacity:'Capacity Planner',
  employees:'Employees', leaves:'Leave Management',
  regular:'Regular Reports', adhoc:'Adhoc Tasks',
  assignments:'Assignments', quality:'Quality Management',
  performance:'Performance', holidays:'Holiday Calendar',
  skills:'Skills Library',
  teams:'Teams & Managers',
  projects:'Projects'
};
// ═══════════════════════════════════════════════════════════
// AUTH SYSTEM
// ═══════════════════════════════════════════════════════════

// Role hierarchy
// admin   → full access to everything
// manager → full access but scoped to own team only
// member  → can see all pages (locked message) + own adhoc tasks + own profile

// There is no hardcoded admin account anymore. Convention used here:
// any signed-in Supabase Auth user who does NOT match an employees record
// (by authUid or email) is treated as admin. Since only an admin (via the
// secondary-client flow below) or you personally (via Supabase Dashboard) can
// ever create an Auth account, this is safe for an internal tool — but if
// you want a specific person to be admin rather than "whoever has no
// matching employee record," add an employees record for them with
// role:'admin' and their authUid/email filled in.

// Pages fully accessible by role
const PAGE_ACCESS = {
  admin:   ['dashboard','capacity','employees','leaves','regular','adhoc','assignments','projects','quality','performance','holidays','skills','teams'],
  manager: ['dashboard','capacity','employees','leaves','regular','adhoc','assignments','projects','quality','performance','holidays','skills','teams'],
  member:  ['dashboard','regular','adhoc','performance','projects']  // everything else shows locked
};

function showLogin() {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('app').style.display = 'none';
  setTimeout(()=>document.getElementById('login-user').focus(), 100);
}

function hideLogin() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('app').style.display = '';
}

function doLogin() {
  const email = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.classList.remove('show');

  if(!email || !password) {
    errEl.textContent = 'Enter your email and password';
    errEl.classList.add('show');
    return;
  }

  sb.auth.signInWithPassword({ email, password }).then(({ error }) => {
    if(error) {
      const msg = (error.message || '').toLowerCase();
      errEl.textContent = msg.includes('invalid') || msg.includes('credentials')
        ? 'Incorrect email or password'
        : (error.message || 'Sign-in failed');
      errEl.classList.add('show');
    }
    // Success is handled by the onAuthStateChange listener below, which
    // resolves the Supabase user into a STATE.currentUser and calls afterLogin().
  });
}

let _pendingAuthUser; // undefined = auth state not yet reported, null = signed out, object = signed in
let _onAuthReadyCallback = null; // set by init() — fires once, on the FIRST auth callback
sb.auth.onAuthStateChange((event, session) => {
  const user = session ? session.user : null;
  const isFirstReport = (_pendingAuthUser === undefined);
  _pendingAuthUser = user;
  console.log('[SUPABASE] Auth state ' + (isFirstReport ? 'ready' : 'changed') + ' (' + event + '):', user ? (user.email || user.id) : 'signed out');
  if(isFirstReport) {
    authReady = true;
    // setTimeout(0): beginSync() -> startSync() makes supabase requests. Running those
    // INSIDE this auth callback deadlocks on supabase-js's internal auth lock whenever
    // a saved session exists, leaving the page stuck on "Loading PWMS…" forever.
    if(_onAuthReadyCallback) { const cb = _onAuthReadyCallback; _onAuthReadyCallback = null; setTimeout(cb, 0); }
  } else if(user && !_initialLoadDone) {
    // Signed in after a signed-out cold load (or after a logout): load the data
    // NOW, as the authenticated user. setTimeout(0) keeps supabase calls out of
    // the auth callback itself (avoids a known supabase-js lock deadlock).
    setTimeout(() => startSync(() => {
      setSyncStatus('connected');
      resolveAuthUser(user);
    }), 0);
  } else if(_initialLoadDone) {
    // supabase-js re-fires SIGNED_IN on tab refocus — don't reset the page for the same user
    if(user && STATE.currentUser && STATE.currentUser.authUid === user.id) return;
    resolveAuthUser(user);
  }
});

function resolveAuthUser(user) {
  if(!user) {
    stopSync();
    STATE.currentUser = null;
    const badge = document.getElementById('user-badge');
    if(badge) badge.style.display = 'none';
    showLogin();
    return;
  }
  const emp = STATE.employees.find(e => e.authUid === user.id || (e.email && user.email && e.email.toLowerCase() === user.email.toLowerCase()));
  if(!emp) {
    STATE.currentUser = { role:'admin', empId:null, name: (user.user_metadata && user.user_metadata.full_name) || user.email, authUid: user.id };
    afterLogin();
    return;
  }
  if(emp.status === 'inactive') {
    document.getElementById('login-error').textContent = 'Your account is inactive. Contact admin.';
    document.getElementById('login-error').classList.add('show');
    sb.auth.signOut();
    return;
  }
  if(!emp.authUid) { emp.authUid = user.id; save(); }
  STATE.currentUser = { role: emp.role || 'member', empId: emp.id, name: emp.name, team: emp.team || null, authUid: user.id };
  afterLogin();
}

function afterLogin() {
  ensureReportTrackingStart();
  hideLogin();
  updateUserBadge();
  updateNotificationBadge();
  navigate('dashboard');
}

function logout() {
  sb.auth.signOut();
  document.getElementById('login-user').value = '';
  document.getElementById('login-pass').value = '';
  document.getElementById('login-error').classList.remove('show');
  closeModal();
}

function updateUserBadge() {
  const u = STATE.currentUser;
  if(!u) return;
  const badge = document.getElementById('user-badge');
  const avatar = document.getElementById('ub-avatar');
  const nameEl = document.getElementById('ub-name');
  const roleEl = document.getElementById('ub-role');
  badge.style.display = 'flex';
  avatar.textContent = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
  nameEl.textContent = u.name;
  roleEl.textContent = u.role;
  roleEl.className = 'user-role-badge role-' + u.role;
}

function openUserMenu() {
  const u = STATE.currentUser;
  if(!u) return;
  openModal('Account', `
    <div style="display:flex;align-items:center;gap:14px;margin-bottom:20px">
      <div class="avatar" style="width:48px;height:48px;font-size:18px">${u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase()}</div>
      <div>
        <div style="font-weight:700;font-size:16px">${u.name}</div>
        <span class="user-role-badge role-${u.role}" style="font-size:11px">${u.role}</span>
        ${u.team ? `<div style="font-size:12px;color:var(--text3);margin-top:4px">Team: ${u.team}</div>` : ''}
      </div>
    </div>
    <div style="background:var(--surface2);border-radius:8px;padding:12px 16px;font-size:13px;color:var(--text2)">
      ${u.role==='admin' ? '✓ Full access to all features and data.' :
        u.role==='manager' ? '✓ Full access scoped to your team only.' :
        '✓ View your own tasks, performance, and dashboard.'}
    </div>
  `, [
    {label:'Close', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Sign Out', cls:'btn-danger', fn:'logout()'}
  ]);
}

// Permission helpers
function canAccess(page) {
  const u = STATE.currentUser;
  if(!u) return false;
  return PAGE_ACCESS[u.role]?.includes(page) ?? false;
}

function isAdmin()   { return STATE.currentUser?.role === 'admin'; }
function isManager() { return STATE.currentUser?.role === 'manager'; }
function isMember()  { return STATE.currentUser?.role === 'member'; }
function myEmpId()   { return STATE.currentUser?.empId; }
function myTeam()    { return STATE.currentUser?.team; }

// Adhoc assignment workflow
const SALES_ORGS = ['BCEC','PCONA','PESNA','PPNDA','PAVNA','PIDSA'];
const ADHOC_ASSIGNMENT_STATUSES = ['Pending Acceptance','Accepted','Rejected'];

function taskAssignmentLabel(t) {
  return t.assignmentStatus || (t.status === 'Rejected' ? 'Rejected' : 'Accepted');
}

function isTaskPendingAcceptance(t) {
  return taskAssignmentLabel(t) === 'Pending Acceptance';
}

function taskManagerName(t) {
  const emp = STATE.employees.find(e=>e.id===t.assignedTo);
  return t.assignedByName || emp?.manager || '';
}

function assignmentBadge(status) {
  const map = {'Pending Acceptance':'badge-amber','Accepted':'badge-green','Rejected':'badge-red'};
  return `<span class=\"badge ${map[status]||'badge-gray'}\">${status||'—'}</span>`;
}


// Filter employees visible to current user
function visibleEmployees() {
  const u = STATE.currentUser;
  if(!u) return [];
  if(u.role === 'admin') return STATE.employees;
  if(u.role === 'manager') return STATE.employees.filter(e => e.team === u.team);
  return STATE.employees.filter(e => e.id === u.empId); // member sees only self
}

function lockedPage(pageName) {
  document.getElementById('content').innerHTML = `
    <div class="locked-page">
      <svg width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
        <rect x="3" y="11" width="18" height="11" rx="2"/>
        <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
      </svg>
      <h3>Access Restricted</h3>
      <p>You don't have permission to view <strong>${PAGE_TITLES[pageName]||pageName}</strong>. Contact your admin if you need access.</p>
    </div>`;
}

function navigate(page) {
  if(!STATE.currentUser) { showLogin(); return; }
  STATE.currentPage = page;
  document.querySelectorAll('.nav-item').forEach(n=>{
    n.classList.toggle('active', n.dataset.page===page);
  });
  document.getElementById('page-title').textContent = PAGE_TITLES[page]||page;
  if(!canAccess(page)) { lockedPage(page); return; }
  render();
}


// ─── RENDER ROUTER ──────────────────────────────────────────
function render() {
  // Destroy old charts
  Object.values(STATE.charts).forEach(c=>{ try{ c.destroy(); }catch(e){} });
  STATE.charts = {};

  const pages = {
    dashboard, capacity, employees, leaves,
    regular, adhoc, assignments, quality,
    performance, holidays, skills, teams, projects
  };
  const fn = pages[STATE.currentPage];
  if(fn) fn();
}

// ═══════════════════════════════════════════════════════════
// REGULAR REPORT COMPLETION TRACKING
// Every report is either Monthly (due on the Nth working day of the month)
// or Weekly (due on a chosen weekday, Mon–Fri, of every week). Completion is
// tracked per OCCURRENCE (one record per report + employee + period), so a
// weekly report has ~4–5 completions a month and a monthly report has 1.
//   periodKey  Monthly → 'M:YYYY-MM'      Weekly → 'W:<Monday of that week>'
// Scoring: on time = 100% credit, late = REPORT_LATE_CREDIT, overdue and
// never completed = 0, not yet due = ignored. Occurrences due before the
// tracking start date (or before the assignment date) are not counted, so
// turning this on doesn't retroactively penalise anyone.
// ═══════════════════════════════════════════════════════════
const REPORT_LATE_CREDIT = 0.5;
const WEEKDAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const WEEKDAY_FULL = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

function ensureReportTrackingStart() {
  if(!STATE.settings.reportTrackingStart) {
    STATE.settings.reportTrackingStart = today();
    save();
  }
}
function setReportTrackingStart(val) {
  if(!isAdmin()) return;
  STATE.settings.reportTrackingStart = val || today();
  save(); toast('Completion tracking start date updated','success'); render();
}

function reportFreq(rep) { return rep && rep.frequency==='Weekly' ? 'Weekly' : 'Monthly'; }
function shortDate(d) { const x = d instanceof Date ? d : parseDate(d); return x.getDate()+' '+monthName(x.getMonth()).slice(0,3); }
function mondayOf(d) {
  const x = d instanceof Date ? new Date(d) : parseDate(d);
  x.setDate(x.getDate() - ((x.getDay()+6)%7));
  x.setHours(0,0,0,0);
  return x;
}
function weeklyDueDate(rep, monday) {
  const wd = Math.min(5, Math.max(1, parseInt(rep.dueWeekday)||5));
  const d = new Date(monday);
  d.setDate(d.getDate() + wd - 1);
  for(let i=0; i<7 && !isWorkingDay(d); i++) d.setDate(d.getDate()+1); // holiday → next working day
  return fmtDate(d);
}
// Monthly reports are due either on the Nth working day (default) or on the
// first <weekday> of the month (e.g. first Friday). Both stay one-per-month.
function reportMonthlyMode(rep) { return rep && rep.monthlyMode==='firstWeekday' ? 'firstWeekday' : 'workday'; }
function firstWeekdayDueDate(rep, y, m) {
  const wd = Math.min(5, Math.max(1, parseInt(rep.dueWeekday)||5));
  const d = new Date(y, m, 1);
  while(d.getDay() !== wd) d.setDate(d.getDate()+1);
  for(let i=0; i<7 && !isWorkingDay(d); i++) d.setDate(d.getDate()+1);   // holiday → next working day
  return fmtDate(d);
}
function isReportDueOn(rep, dateStr, wdNum) {
  if(reportFreq(rep)==='Weekly') return weeklyDueDate(rep, mondayOf(dateStr)) === dateStr;
  if(reportMonthlyMode(rep)==='firstWeekday') { const d = parseDate(dateStr); return firstWeekdayDueDate(rep, d.getFullYear(), d.getMonth()) === dateStr; }
  return parseInt(rep.dueWorkingDay) === wdNum;
}
function reportDueLabel(rep) {
  return reportFreq(rep)==='Weekly'
    ? 'Weekly · ' + WEEKDAY_SHORT[Math.min(5,Math.max(1,parseInt(rep.dueWeekday)||5))]
    : reportMonthlyMode(rep)==='firstWeekday' ? 'Monthly · First ' + WEEKDAY_FULL[Math.min(5,Math.max(1,parseInt(rep.dueWeekday)||5))]
    : 'Monthly · Day ' + (rep.dueWorkingDay||1);
}

// Short due text for dropdowns: weekly → 'Fri' style weekday, monthly → 'Day N'
function reportDueShort(rep) {
  return reportFreq(rep)==='Weekly'
    ? 'Weekly · ' + WEEKDAY_FULL[Math.min(5,Math.max(1,parseInt(rep.dueWeekday)||5))]
    : reportMonthlyMode(rep)==='firstWeekday' ? 'First ' + WEEKDAY_FULL[Math.min(5,Math.max(1,parseInt(rep.dueWeekday)||5))]
    : 'Day ' + (rep.dueWorkingDay||1);
}

// All due periods of one report whose due date falls in the given month
function reportPeriods(rep, y, m) {
  const out = [];
  if(reportFreq(rep)==='Weekly') {
    const last = new Date(y, m+1, 0);
    const mon = mondayOf(new Date(y, m, 1));
    mon.setDate(mon.getDate() - 7);
    while(mon <= last) {
      const due = weeklyDueDate(rep, mon);
      const dd = parseDate(due);
      if(dd.getFullYear()===y && dd.getMonth()===m)
        out.push({periodKey:'W:'+fmtDate(mon), label:'Week of '+shortDate(mon), dueDate:due});
      mon.setDate(mon.getDate() + 7);
    }
  } else {
    const wds = getWorkingDays(y, m);
    if(!wds.length) return out;
    const n = parseInt(rep.dueWorkingDay) || 1;
    out.push({periodKey:'M:'+y+'-'+String(m+1).padStart(2,'0'), label:monthName(m)+' '+y, dueDate: reportMonthlyMode(rep)==='firstWeekday' ? firstWeekdayDueDate(rep, y, m) : (wds[n-1] || wds[wds.length-1])});
  }
  return out;
}

function getReportCompletion(reportId, empId, periodKey) {
  return STATE.reportCompletions.find(c=>c.reportId===reportId && c.employeeId===empId && c.periodKey===periodKey) || null;
}

// One occurrence (report + employee + period) with its status + credit.
// Status is date-driven: closed → On Time / Late; not closed → Overdue once the
// due date has passed, Due Today on the due date, Upcoming before it.
function buildReportOccurrence(a, rep, p, empId) {
  const t = today();
  const start = STATE.settings.reportTrackingStart || '';
  const c = getReportCompletion(rep.id, empId, p.periodKey);
  let status, credit = 0, counted = false, overridden = false;
  if(c) {
    status = c.completedDate <= p.dueDate ? 'On Time' : 'Late';
    // Manager/admin override: a late closure approved with an explanation counts as On Time
    if(status==='Late' && c.override) { status = 'On Time'; overridden = true; }
    credit = status==='On Time' ? 1 : REPORT_LATE_CREDIT;
    counted = true;
  } else if(p.dueDate < t) {
    const inScope = (!start || p.dueDate >= start) && (!a.assignedDate || p.dueDate >= a.assignedDate);
    status = inScope ? 'Overdue' : 'Not Tracked';
    counted = inScope;
  } else {
    status = p.dueDate===t ? 'Due Today' : 'Upcoming';
  }
  return {assignment:a, report:rep, periodKey:p.periodKey, label:p.label, dueDate:p.dueDate, completion:c, status, credit, counted, overridden};
}

// Every occurrence for an employee in a month, with status + credit
function getReportOccurrences(empId, y, m) {
  const out = [];
  STATE.assignments.filter(a=>a.employeeId===empId).forEach(a=>{
    const rep = STATE.regularReports.find(r=>r.id===a.reportId);
    if(!rep) return;
    reportPeriods(rep, y, m).forEach(p=> out.push(buildReportOccurrence(a, rep, p, empId)));
  });
  return out.sort((a,b)=>a.dueDate.localeCompare(b.dueDate) || a.report.name.localeCompare(b.report.name));
}

// The current week's (Mon–Fri) period of a weekly report, whatever month is selected
function currentWeekPeriod(rep) {
  const mon = mondayOf(today());
  return {periodKey:'W:'+fmtDate(mon), label:'Week of '+shortDate(mon), dueDate: weeklyDueDate(rep, mon)};
}

// This week's occurrence of every weekly report assigned to an employee
function getThisWeekOccurrences(empId) {
  const out = [];
  STATE.assignments.filter(a=>a.employeeId===empId).forEach(a=>{
    const rep = STATE.regularReports.find(r=>r.id===a.reportId);
    if(!rep || reportFreq(rep)!=='Weekly') return;
    out.push(buildReportOccurrence(a, rep, currentWeekPeriod(rep), empId));
  });
  return out;
}

function dueDayLabel(dateStr) {
  const d = parseDate(dateStr);
  return WEEKDAY_SHORT[d.getDay()] + ' ' + shortDate(d);
}
function dueRelativeText(dateStr) {
  const diff = Math.round((parseDate(dateStr) - parseDate(today())) / 86400000);
  if(diff===0) return 'due today';
  if(diff===1) return 'due tomorrow';
  if(diff>1)   return 'due in '+diff+' days';
  return Math.abs(diff)+' day'+(Math.abs(diff)===1?'':'s')+' overdue';
}
// Due cell: weekly reports show the weekday; open reports also show how far away / overdue
function reportDueCell(o) {
  const weekly = reportFreq(o.report)==='Weekly' || reportMonthlyMode(o.report)==='firstWeekday';
  const open = !o.completion && o.status!=='Not Tracked';
  return `${weekly ? dueDayLabel(o.dueDate)+' <small style="color:var(--text3)">('+o.dueDate+')</small>' : o.dueDate}`
    + (open ? `<div style="font-size:11px;color:${o.status==='Overdue'?'#B91C1C':'var(--text3)'};margin-top:2px">${dueRelativeText(o.dueDate)}</div>` : '');
}

// Regular Reports page: this week's due date + status for a weekly report across its assignees
function weeklyRowSummary(rep) {
  const p = currentWeekPeriod(rep), t = today();
  const occ = STATE.assignments.filter(a=>a.reportId===rep.id).map(a=>buildReportOccurrence(a, rep, p, a.employeeId)).filter(o=>o.status!=='Not Tracked');
  const closed = occ.filter(o=>o.completion).length;
  const open = occ.filter(o=>!o.completion);
  let status;
  if(open.some(o=>o.status==='Overdue')) status = 'Overdue';
  else if(open.some(o=>o.status==='Due Today')) status = 'Due Today';
  else if(open.length) status = 'Upcoming';
  else if(occ.length) status = 'Closed';
  else status = p.dueDate < t ? 'Overdue' : p.dueDate===t ? 'Due Today' : 'Upcoming';   // nobody assigned: date only
  const badge = status==='Closed' ? '<span class="badge badge-green">All closed</span>' : reportStatusBadge(status);
  return `<div style="font-size:11px;color:var(--text3);margin-top:2px">This week: <strong style="color:var(--text)">${dueDayLabel(p.dueDate)}</strong></div>
    <div style="margin-top:3px">${badge}${occ.length ? ` <small style="color:var(--text3)">${closed}/${occ.length} closed</small>` : ''}</div>`;
}

// Dashboard: this week's weekly reports (current Mon–Fri) with weekday, date and live status
function thisWeekReportsCard() {
  const mon = mondayOf(today());
  const fri = new Date(mon); fri.setDate(fri.getDate()+4);
  const emps = isMember()
    ? STATE.employees.filter(e=>e.id===myEmpId())
    : visibleEmployees().filter(e=>e.status==='active');
  const rank = {'Overdue':0,'Due Today':1,'Upcoming':2,'Late':3,'On Time':3};
  const rows = [];
  emps.forEach(e=>getThisWeekOccurrences(e.id).forEach(o=>{ if(o.status!=='Not Tracked') rows.push({emp:e,o}); }));
  if(!rows.length) return '';
  rows.sort((a,b)=>(rank[a.o.status]??4)-(rank[b.o.status]??4) || a.o.dueDate.localeCompare(b.o.dueDate) || a.emp.name.localeCompare(b.emp.name));
  const n = st => rows.filter(r=>r.o.status===st).length;
  const closed = rows.filter(r=>r.o.completion).length;
  const showEmp = !isMember();
  return `<div class="card" style="margin:20px 0">
    <div class="card-header"><div>
      <div class="card-title">This Week's Weekly Reports</div>
      <div style="font-size:12px;color:var(--text3);margin-top:3px">${shortDate(mon)} – ${shortDate(fri)} · ${n('Overdue')} overdue · ${n('Due Today')} due today · ${n('Upcoming')} upcoming · ${closed} closed</div>
    </div></div>
    <div class="table-wrap"><table><thead><tr>${showEmp?'<th>Employee</th>':''}<th>Report</th><th>Due</th><th>Status</th><th>Action</th></tr></thead><tbody>
      ${rows.map(({emp,o})=>`<tr>
        ${showEmp?`<td><strong>${escHtml(emp.name)}</strong></td>`:''}
        <td><strong>${escHtml(o.report.name)}</strong><br><small style="color:var(--text3)">${reportDueLabel(o.report)}</small></td>
        <td>${reportDueCell(o)}</td>
        <td>${reportStatusCell(o)}</td>
        <td>${reportActionButtons(o, emp.id)}</td>
      </tr>`).join('')}
    </tbody></table></div>
  </div>`;
}

function getReportScore(empId, y, m) {
  const occ = getReportOccurrences(empId, y, m).filter(o=>o.counted);
  const due = occ.length;
  const onTime = occ.filter(o=>o.status==='On Time').length;
  const late = occ.filter(o=>o.status==='Late').length;
  const overdue = occ.filter(o=>o.status==='Overdue').length;
  const score = due ? Math.round(occ.reduce((s,o)=>s+o.credit,0)/due*100) : 100;
  return {score, due, onTime, late, overdue, done:onTime+late};
}

function reportStatusBadge(status) {
  const map = {'On Time':'badge-green','Late':'badge-amber','Overdue':'badge-red','Due Today':'badge-blue','Upcoming':'badge-gray','Not Tracked':'badge-gray'};
  return `<span class="badge ${map[status]||'badge-gray'}">${status}</span>`;
}

// Status badge plus, for manager-overridden reports, an "Overridden" tag with the explanation
function reportStatusCell(o) {
  if(!o.overridden) return reportStatusBadge(o.status);
  const ov = o.completion.override;
  const when = ov.at ? ov.at.slice(0,10) : '';
  return `${reportStatusBadge(o.status)} <span class="badge badge-teal" title="Closed late on ${escHtml(ov.originalCompletedDate||o.completion.completedDate)}, changed to On Time by ${escHtml(ov.by||'a manager')}">Overridden</span>
    <div style="font-size:11px;color:var(--text3);margin-top:4px;max-width:240px;white-space:normal">Reason: ${escHtml(ov.reason)}<br>— ${escHtml(ov.by||'')}${when?' · '+when:''}</div>`;
}

function canManageReportsFor(empId) {
  if(isAdmin()) return true;
  if(isManager()) return visibleEmployees().some(e=>e.id===empId);
  return false;
}
function canMarkReportFor(empId) {
  return canManageReportsFor(empId) || (isMember() && empId===myEmpId());
}

function recordReportCompletion(reportId, empId, periodKey, dueDate, completedDate, note, completedAt) {
  const existing = getReportCompletion(reportId, empId, periodKey);
  if(existing) {
    existing.completedDate = completedDate;
    existing.completedAt = completedAt || null;   // exact time only when closed via the button
    existing.markedBy = STATE.currentUser?.name || '';
    if(note!==undefined) existing.note = note;
  } else {
    STATE.reportCompletions.push({id:uid(), reportId, employeeId:empId, periodKey, dueDate, completedDate, completedAt: completedAt || null,
      markedBy: STATE.currentUser?.name || '', note: note||'', createdAt: new Date().toISOString()});
  }
  save();
}

function afterReportChange(empId) {
  if(document.getElementById('emp-tab-content') && document.getElementById('modal-overlay').classList.contains('active')) {
    switchEmpTab('reports', empId);   // manager is looking at the employee profile
  }
  if(STATE.currentPage==='dashboard' || STATE.currentPage==='regular' || STATE.currentPage==='performance') render();
}

// Employee (own) or manager/admin clicks "Mark Complete" — completion date = today
function markReportComplete(reportId, empId, periodKey, dueDate) {
  if(!canMarkReportFor(empId)) { toast('You can only update your own reports','error'); return; }
  const t = today();
  if(t > dueDate && !confirm('This report was due on '+dueDate+'. Closing it now will be recorded as LATE and earns only '+Math.round(REPORT_LATE_CREDIT*100)+'% credit toward the performance score. Close it anyway?')) return;
  recordReportCompletion(reportId, empId, periodKey, dueDate, t, undefined, new Date().toISOString());
  toast(t<=dueDate ? 'Marked complete — on time' : 'Marked complete — late, partial credit applies', t<=dueDate?'success':'info');
  afterReportChange(empId);
}

// Manager/admin: set or correct the completion date (e.g. finished earlier but not logged)
function editReportCompletionDate(reportId, empId, periodKey, dueDate) {
  if(!canManageReportsFor(empId)) return;
  const c = getReportCompletion(reportId, empId, periodKey);
  const val = prompt('Completion date (YYYY-MM-DD)', c ? c.completedDate : today());
  if(val===null) return;
  const v = val.trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(parseDate(v).getTime())) { toast('Enter the date as YYYY-MM-DD','error'); return; }
  if(v > today()) { toast('Completion date cannot be in the future','error'); return; }
  recordReportCompletion(reportId, empId, periodKey, dueDate, v);
  toast(v<=dueDate ? 'Saved — on time' : 'Saved — late, partial credit applies','success');
  afterReportChange(empId);
}

// Manager/admin: a report closed after its due date can be changed to On Time
// with a mandatory explanation. The late penalty is removed because scoring
// treats the occurrence as On Time (see getReportOccurrences). Not allowed on
// your own reports, so the approval always comes from someone else.
function canOverrideReportFor(empId) {
  return canManageReportsFor(empId) && empId !== myEmpId();
}

const OVERRIDE_MIN_REASON = 10;

// Opens a small dialog of its own (not the shared modal), so the employee
// profile popup stays open underneath when this is started from there.
// The explanation is mandatory: Confirm stays disabled until it is filled in,
// and saveReportOverride() re-checks it.
function overrideReportToOnTime(reportId, empId, periodKey, dueDate) {
  if(!canOverrideReportFor(empId)) { toast('Only the employee\'s manager or an admin can do this','error'); return; }
  const c = getReportCompletion(reportId, empId, periodKey);
  if(!c || c.completedDate <= dueDate) { toast('Only reports closed after the due date can be overridden','error'); return; }
  const rep = STATE.regularReports.find(r=>r.id===reportId);
  const emp = STATE.employees.find(e=>e.id===empId);
  closeOverrideDialog();
  const el = document.createElement('div');
  el.id = 'ovr-dialog';
  el.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;z-index:10000;padding:16px';
  el.innerHTML = `
    <div style="background:var(--surface);border-radius:12px;width:100%;max-width:460px;box-shadow:0 20px 50px rgba(0,0,0,.3)">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
        <div style="font-weight:700;font-size:15px">Change report to On Time</div>
        <div style="font-size:12px;color:var(--text3);margin-top:3px">${escHtml(rep?.name||'Report')} · ${escHtml(emp?.name||'')} · due ${escHtml(dueDate)}, closed ${escHtml(c.completedDate)}</div>
      </div>
      <div style="padding:16px 20px">
        <div class="form-group">
          <label style="font-size:12px;font-weight:600">Explanation <span style="color:#B91C1C">*</span></label>
          <textarea id="ovr-reason" class="form-control" rows="4" maxlength="500" placeholder="Why should this count as On Time? (required)"></textarea>
          <div id="ovr-hint" style="font-size:11px;color:var(--text3)">Required — at least ${OVERRIDE_MIN_REASON} characters. The employee will see this explanation.</div>
        </div>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:8px">
        <button class="btn btn-secondary" onclick="closeOverrideDialog()">Cancel</button>
        <button class="btn btn-primary" id="ovr-confirm" disabled style="opacity:.5;cursor:not-allowed"
          onclick="saveReportOverride('${reportId}','${empId}','${periodKey}','${dueDate}')">Confirm — mark On Time</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  const ta = document.getElementById('ovr-reason');
  ta.addEventListener('input', () => {
    const ok = ta.value.trim().length >= OVERRIDE_MIN_REASON;
    const btn = document.getElementById('ovr-confirm');
    btn.disabled = !ok;
    btn.style.opacity = ok ? '1' : '.5';
    btn.style.cursor = ok ? 'pointer' : 'not-allowed';
  });
  ta.focus();
}

function closeOverrideDialog() {
  const el = document.getElementById('ovr-dialog');
  if(el) el.remove();
}

function saveReportOverride(reportId, empId, periodKey, dueDate) {
  if(!canOverrideReportFor(empId)) { toast('Only the employee\'s manager or an admin can do this','error'); return; }
  const c = getReportCompletion(reportId, empId, periodKey);
  if(!c || c.completedDate <= dueDate) { closeOverrideDialog(); toast('Only reports closed after the due date can be overridden','error'); return; }
  const reason = (document.getElementById('ovr-reason')?.value || '').trim();
  if(reason.length < OVERRIDE_MIN_REASON) { toast('An explanation is required (at least '+OVERRIDE_MIN_REASON+' characters)','error'); return; }
  const rep = STATE.regularReports.find(r=>r.id===reportId);
  c.override = {by: STATE.currentUser?.name || '', byEmpId: myEmpId() || null, at: new Date().toISOString(), reason, originalCompletedDate: c.completedDate};
  save();
  addNotification({
    type: 'report_override',
    title: 'Report changed to On Time',
    message: `${c.override.by||'Your manager'} changed "${rep?.name||'a report'}" (due ${dueDate}, closed ${c.completedDate}) from Late to On Time. No late penalty applies. Reason: ${reason}`,
    forEmpId: empId
  });
  closeOverrideDialog();
  toast('Changed to On Time — late penalty removed','success');
  afterReportChange(empId);
}

function revokeReportOverride(reportId, empId, periodKey) {
  if(!canOverrideReportFor(empId)) return;
  const c = getReportCompletion(reportId, empId, periodKey);
  if(!c || !c.override) return;
  if(!confirm('Revoke this override? The report will go back to LATE with '+Math.round(REPORT_LATE_CREDIT*100)+'% credit.')) return;
  const rep = STATE.regularReports.find(r=>r.id===reportId);
  delete c.override;
  save();
  addNotification({
    type: 'report_override_revoked',
    title: 'On Time override revoked',
    message: `${STATE.currentUser?.name||'Your manager'} revoked the On Time override on "${rep?.name||'a report'}" (due ${c.dueDate}). It is counted as Late again.`,
    forEmpId: empId
  });
  toast('Override revoked','info');
  afterReportChange(empId);
}

function undoReportCompletion(reportId, empId, periodKey) {
  const c = getReportCompletion(reportId, empId, periodKey);
  if(!c) return;
  const mine = isMember() && empId===myEmpId() && c.completedDate===today(); // members can only undo same-day mistakes
  if(!canManageReportsFor(empId) && !mine) { toast('Only your manager can undo an earlier completion','error'); return; }
  if(!confirm('Undo this completion and mark the report as not done?')) return;
  STATE.reportCompletions = STATE.reportCompletions.filter(x=>x.id!==c.id);
  save(); toast('Completion removed','info');
  afterReportChange(empId);
}

function fmtCompletedAt(c) {
  if(!c.completedAt) return c.completedDate;
  return c.completedDate + ' ' + fmtTimeET(c.completedAt) + ' ET';
}

function reportActionButtons(o, empId) {
  const args = `'${o.report.id}','${empId}','${o.periodKey}','${o.dueDate}'`;
  if(!o.completion) {
    if(!canMarkReportFor(empId)) return '<span style="color:var(--text3)">—</span>';
    return `<button class="btn btn-primary btn-sm" onclick="markReportComplete(${args})">✓ Close Report</button>`;
  }
  const canManage = canManageReportsFor(empId);
  const canUndo = canManage || (isMember() && empId===myEmpId() && o.completion.completedDate===today());
  return `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
    <span style="font-size:11px;color:var(--text3)">Closed ${fmtCompletedAt(o.completion)}${o.completion.markedBy ? ' · by '+escHtml(o.completion.markedBy) : ''}</span>
    ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="editReportCompletionDate(${args})">Edit date</button>` : ''}
    ${canOverrideReportFor(empId) && o.status==='Late' ? `<button class="btn btn-primary btn-sm" onclick="overrideReportToOnTime(${args})">Mark On Time</button>` : ''}
    ${canOverrideReportFor(empId) && o.overridden ? `<button class="btn btn-secondary btn-sm" onclick="revokeReportOverride('${o.report.id}','${empId}','${o.periodKey}')">Revoke override</button>` : ''}
    ${canUndo ? `<button class="btn btn-danger btn-sm" onclick="undoReportCompletion('${o.report.id}','${empId}','${o.periodKey}')">Undo</button>` : ''}
  </div>`;
}

function reportOccurrencesTable(occ, empId) {
  if(!occ.length) return `<div class="empty-state"><p>No regular reports due in ${selectedMonthLabel()}</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Report</th><th>Period</th><th>Due</th><th>Est Hours</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>
    ${occ.map(o=>`<tr>
      <td><strong>${escHtml(o.report.name)}</strong><br><small style="color:var(--text3)">${reportDueLabel(o.report)}</small></td>
      <td>${o.label}</td>
      <td>${reportDueCell(o)}</td>
      <td>${o.report.estHours}h</td>
      <td><span class="badge ${o.report.priority==='High'?'badge-red':o.report.priority==='Medium'?'badge-amber':'badge-blue'}">${o.report.priority||'Normal'}</span></td>
      <td>${reportStatusCell(o)}</td>
      <td>${reportActionButtons(o, empId)}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function memberReportsCard(empId) {
  if(!empId) return '';
  const occ = getReportOccurrences(empId, STATE.currentYear, STATE.currentMonth);
  const rs = getReportScore(empId, STATE.currentYear, STATE.currentMonth);
  return `<div class="card" style="margin-top:20px">
    <div class="card-header"><div>
      <div class="card-title">My Regular Reports</div>
      <div style="font-size:12px;color:var(--text3);margin-top:3px">${selectedMonthLabel()} · ${rs.due ? `${rs.done}/${rs.due} completed (${rs.onTime} on time, ${rs.late} late${rs.overdue?`, ${rs.overdue} overdue`:''})` : 'nothing counted yet'} · late submissions earn ${Math.round(REPORT_LATE_CREDIT*100)}% credit</div>
    </div>${STATE.currentPage==='dashboard' ? `<button class="btn btn-secondary btn-sm" onclick="navigate('regular')">Open Regular Reports →</button>` : ''}</div>
    ${reportOccurrencesTable(occ, empId)}
  </div>`;
}


// ── Manager / admin: Team Report Tracker ────────────────────
// Pending  = not closed and due before today (Overdue)
// Due Today = every report whose due date is today (open ones first, closed ones after)
// Upcoming = not closed and due after today
// Closed   = completed (On Time or Late)
function setTeamReportFilter(f) { STATE.reportTeamFilter = f; render(); }
function setTeamReportEmp(id)   { STATE.reportTeamEmp = id; render(); }

function teamReportsCard() {
  if(isMember()) return '';
  const y = STATE.currentYear, m = STATE.currentMonth, t = today();
  const team = visibleEmployees().filter(e => e.status==='active' && e.id!==myEmpId());
  const rows = [];
  team.forEach(e => getReportOccurrences(e.id, y, m).forEach(o => rows.push({emp:e, o})));
  const isClosed  = r => !!r.o.completion;
  const isPending = r => !r.o.completion && r.o.dueDate <  t;
  const isUpcoming= r => !r.o.completion && r.o.dueDate >  t;
  // Due Today: always based on the real current date, regardless of the month selected in the dashboard
  const _td = parseDate(t);
  let dueTodayRows;
  if(_td.getFullYear()===y && _td.getMonth()===m) dueTodayRows = rows.filter(r=>r.o.dueDate===t);
  else { dueTodayRows = []; team.forEach(e => getReportOccurrences(e.id, _td.getFullYear(), _td.getMonth()).forEach(o => { if(o.dueDate===t) dueTodayRows.push({emp:e, o}); })); }
  const counts = {pending:rows.filter(isPending).length, duetoday:dueTodayRows.filter(r=>!r.o.completion).length, upcoming:rows.filter(isUpcoming).length, closed:rows.filter(isClosed).length, all:rows.length};
  const overdue = rows.filter(r=>r.o.status==='Overdue').length;
  const late = rows.filter(r=>r.o.status==='Late').length;

  const f = STATE.reportTeamFilter || 'pending';
  const empSel = STATE.reportTeamEmp || '';
  let shown = (f==='duetoday' ? dueTodayRows : rows).filter(r => (empSel ? r.emp.id===empSel : true) &&
    (f==='duetoday' ? true : f==='pending' ? isPending(r) : f==='upcoming' ? isUpcoming(r) : f==='closed' ? isClosed(r) : true));
  shown.sort((a,b) => f==='duetoday'
    ? (!!a.o.completion - !!b.o.completion) || a.emp.name.localeCompare(b.emp.name)
    : f==='closed'
    ? (b.o.completion.completedAt||b.o.completion.completedDate).localeCompare(a.o.completion.completedAt||a.o.completion.completedDate)
    : a.o.dueDate.localeCompare(b.o.dueDate) || a.emp.name.localeCompare(b.emp.name));

  const tab = (key, label) => `<button class="btn ${f===key?'btn-primary':'btn-secondary'} btn-sm" onclick="setTeamReportFilter('${key}')">${label} (${counts[key]})</button>`;
  return `<div class="card" style="margin:20px 0">
    <div class="card-header" style="flex-wrap:wrap;gap:10px">
      <div>
        <div class="card-title">Team Report Tracker</div>
        <div style="font-size:12px;color:var(--text3);margin-top:3px">${selectedMonthLabel()} · ${team.length} team member${team.length!==1?'s':''} · ${overdue} overdue · ${late} closed late</div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${tab('pending','Pending')}${tab('duetoday','Due Today')}${tab('upcoming','Upcoming')}${tab('closed','Closed')}${tab('all','All')}
        <select class="form-control" style="width:auto;padding:5px 8px;font-size:12px" onchange="setTeamReportEmp(this.value)">
          <option value="">All employees</option>
          ${team.map(e=>`<option value="${e.id}" ${empSel===e.id?'selected':''}>${escHtml(e.name)}</option>`).join('')}
        </select>
      </div>
    </div>
    ${shown.length===0
      ? `<div class="empty-state"><p>${f==='duetoday' ? 'No reports are due today' : `No ${f==='all'?'':f+' '}reports for ${selectedMonthLabel()}`}</p></div>`
      : `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Report</th><th>Period</th><th>Due</th><th>Priority</th><th>Status</th><th>Action</th></tr></thead><tbody>
        ${shown.map(({emp,o})=>`<tr>
          <td><strong>${escHtml(emp.name)}</strong><br><small style="color:var(--text3)">${escHtml(emp.team||'')}</small></td>
          <td><strong>${escHtml(o.report.name)}</strong><br><small style="color:var(--text3)">${reportDueLabel(o.report)}</small></td>
          <td>${o.label}</td>
          <td>${reportDueCell(o)}</td>
          <td><span class="badge ${o.report.priority==='High'?'badge-red':o.report.priority==='Medium'?'badge-amber':'badge-blue'}">${o.report.priority||'Normal'}</span></td>
          <td>${reportStatusCell(o)}</td>
          <td>${reportActionButtons(o, emp.id)}</td>
        </tr>`).join('')}
      </tbody></table></div>`}
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// BANDWIDTH ENGINE
// ═══════════════════════════════════════════════════════════
// Planned project hours for one employee on one date. Counts only Active projects whose
// start..end range (inclusive) contains the date, and only on working days (not weekends/holidays).
function getProjectHours(empId, dateStr) {
  if(!STATE.projects.length) return 0;
  const d = parseDate(dateStr);
  if(isNaN(d) || !isWorkingDay(d)) return 0;
  let h = 0;
  STATE.projects.forEach(p => {
    if((p.status||'Active') !== 'Active') return;
    if(!p.startDate || !p.endDate || dateStr < p.startDate || dateStr > p.endDate) return;
    (p.allocations||[]).forEach(a => { if(a.employeeId === empId) h += parseFloat(a.hoursPerDay)||0; });
  });
  return h;
}

function getEmployeeBandwidth(empId, dateStr) {
  const emp = STATE.employees.find(e=>e.id===empId);
  if(!emp || emp.status==='inactive') return {total:0, regular:0, adhoc:0, project:0, leave:0, available:0, pct:100};
  const total = parseFloat(emp.loginHours)||8;

  // Leave check
  const onLeave = STATE.leaves.some(l=>l.employeeId===empId && l.date===dateStr);
  if(onLeave) return {total, regular:0, adhoc:0, project:0, leave:total, available:0, pct:100};

  // Regular reports due this working day
  const wds = getWorkingDays(STATE.currentYear, STATE.currentMonth);
  const wdIndex = wds.indexOf(dateStr);
  const wdNum = wdIndex + 1; // 1-based working day
  let regHrs = 0;
  STATE.assignments.filter(a=>a.employeeId===empId).forEach(a=>{
    const rep = STATE.regularReports.find(r=>r.id===a.reportId);
    if(rep && isReportDueOn(rep, dateStr, wdNum)) regHrs += parseFloat(rep.estHours)||0;
  });

  // Adhoc tasks assigned for this date
  let adhocHrs = 0;
  STATE.adhocTasks.filter(t=>t.assignedTo===empId && t.assignedDate===dateStr && !['Completed','Cancelled'].includes(t.status))
    .forEach(t=>{ adhocHrs += parseFloat(t.estHours)||0; });

  // Project hours: fixed planned hours/day for every working day inside an Active project's date range
  const projHrs = getProjectHours(empId, dateStr);

  const used = Math.min(regHrs+adhocHrs+projHrs, total);
  const available = Math.max(0, total - used);
  const pct = Math.round((used/total)*100);
  return {total, regular:regHrs, adhoc:adhocHrs, project:projHrs, leave:0, available, pct};
}

function getMonthBandwidth(empId) {
  const wds = getWorkingDays(STATE.currentYear, STATE.currentMonth);
  return wds.map(d=>({date:d, ...getEmployeeBandwidth(empId,d)}));
}

// ═══════════════════════════════════════════════════════════
// QUALITY & PERFORMANCE SCORES
// ═══════════════════════════════════════════════════════════
function getQualityScore(empId, year, month) {
  // Quality score now comes entirely from requestor survey feedback (per
  // team decision) rather than manually-logged Quality Reviews. Manual
  // reviews (and auto-generated ones from survey responses — see
  // saveSurveyResponse()) still show up in the Quality Management log for
  // visibility/audit purposes, they just no longer move this number.
  // Defined here as its own function (rather than every caller reaching for
  // getSurveyScore directly) so a future change back to a blended score only
  // needs to happen in one place.
  return getSurveyScore(empId, year, month);
}

function getSurveyScore(empId, year, month) {
  const responses = STATE.surveyResponses.filter(r=>r.employeeId===empId && r.year===year && r.month===month);
  if(!responses.length) return 100; // no responses yet — full credit by default, consistent with other scores
  return Math.round(responses.reduce((s,r)=>s+r.score,0) / responses.length);
}

function getPerformanceScore(empId, year, month) {
  const wds = getWorkingDays(year, month);
  const emp = STATE.employees.find(e=>e.id===empId);
  if(!emp) return 0;

  // Regular reports completion (30%) — per-occurrence: on time = full credit,
  // late = partial credit, overdue = 0 (see REGULAR REPORT COMPLETION TRACKING)
  const regScore = getReportScore(empId, year, month).score;

  // Adhoc tasks (20%)
  const myAdhoc = STATE.adhocTasks.filter(t=>t.assignedTo===empId && t.year===year && t.month===month);
  const adhocDone = myAdhoc.filter(t=>t.status==='Completed').length;
  const adhocScore = myAdhoc.length>0 ? (adhocDone/myAdhoc.length)*100 : 100;

  // Quality & Requestor Survey Feedback (35% combined) — getQualityScore()
  // is now itself defined as the survey score, so this is a single signal,
  // not two independent ones. Combined into one weighted term below instead
  // of adding qScore*.20 + surveyScore*.15 as if they were different numbers.
  const feedbackScore = getSurveyScore(empId, year, month); // === getQualityScore(empId, year, month)

  // Utilization efficiency (10%)
  const bw = getMonthBandwidth(empId);
  const avgUtil = bw.reduce((s,d)=>s+d.pct,0)/Math.max(bw.length,1);
  const utilScore = Math.min(100, avgUtil<50 ? avgUtil*1.5 : avgUtil>95 ? 85 : 100);

  // Attendance (5%)
  const leaves = STATE.leaves.filter(l=>l.employeeId===empId && parseDate(l.date).getFullYear()===year && parseDate(l.date).getMonth()===month);
  const unplanned = leaves.filter(l=>l.type==='Unplanned').length;
  const attScore = Math.max(0, 100 - unplanned*15);

  const final = regScore*.30 + adhocScore*.20 + feedbackScore*.35 + utilScore*.10 + attScore*.05;
  return Math.round(final);
}

// ═══════════════════════════════════════════════════════════
// PAGE: DASHBOARD
// ═══════════════════════════════════════════════════════════
function dashboard() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const allActiveEmps = visibleEmployees().filter(e=>e.status==='active');
  // Managers excluded from every individual/aggregate performance, quality,
  // and utilization figure below — a manager's numbers are reflected via
  // their team's results, not shown as their own row/score. "Total
  // Employees" headcount above still counts everyone, including managers.
  const activeEmps = allActiveEmps.filter(e=>e.role!=='manager');
  const todayStr = today();
  const wds = getWorkingDays(y,m);
  const todayWds = wds.filter(d=>d<=todayStr);

  // KPIs
  const totalEmps = allActiveEmps.length;
  const totalReg = STATE.regularReports.length;
  const visEmpIds = visibleEmployees().map(e=>e.id);
  const totalAdhoc = STATE.adhocTasks.filter(t=>{
    const d=parseDate(t.assignedDate||t.createdAt||'');
    return d.getFullYear()===y && d.getMonth()===m
      && (isAdmin() || (t.assignedTo && visEmpIds.includes(t.assignedTo)));
  }).length;
  const dueToday = STATE.adhocTasks.filter(t=>t.dueDate===todayStr
    && !['Completed','Cancelled'].includes(t.status)
    && (isAdmin() || (t.assignedTo && visEmpIds.includes(t.assignedTo)))
  ).length;

  // Team quality avg
  const qScores = activeEmps.map(e=>getQualityScore(e.id,y,m));
  const avgQuality = qScores.length ? Math.round(qScores.reduce((a,b)=>a+b,0)/qScores.length) : 100;

  // Team utilization
  let totalUtil=0, utilCount=0;
  activeEmps.forEach(e=>{
    const bw = getEmployeeBandwidth(e.id,todayStr);
    totalUtil += bw.pct; utilCount++;
  });
  const avgUtil = utilCount ? Math.round(totalUtil/utilCount) : 0;

  // Available capacity hours today
  let totalAvail=0;
  activeEmps.forEach(e=>{
    const bw = getEmployeeBandwidth(e.id,todayStr);
    totalAvail += bw.available;
  });

  const content = document.getElementById('content');

  // Member: show personal dashboard
  if(isMember()) {
    const me = STATE.employees.find(e=>e.id===myEmpId());
    const bw = me ? getEmployeeBandwidth(me.id, todayStr) : {};
    const myTasks = STATE.adhocTasks.filter(t=>t.assignedTo===myEmpId() && !['Completed','Cancelled','Rejected'].includes(t.status));
    const pendingRequests = STATE.adhocTasks.filter(t=>t.assignedTo===myEmpId() && isTaskPendingAcceptance(t));
    const perfScore = me ? getPerformanceScore(me.id, y, m) : 0;
    const qualScore = me ? getQualityScore(me.id, y, m) : 100;
    content.innerHTML = `
      <div class="section-header"><h2>My Dashboard</h2>${etClockHtml()}</div>
      <div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">
        ${kpiCard('Performance', perfScore, selectedMonthLabel(), '#0B4EA2','#EEF2FF', svgFlash())}
        ${kpiCard('Quality Score', qualScore, selectedMonthLabel(), '#0D9488','#CCFBF1', svgStar())}
        ${kpiCard('Available Today', (bw.available||0).toFixed(1)+'h', 'of '+(bw.total||8)+'h', '#22C55E','#DCFCE7', svgClock())}
        ${kpiCard('Open Tasks', myTasks.filter(t=>!isTaskPendingAcceptance(t)).length, 'Accepted / active', '#F59E0B','#FEF3C7', svgDoc())}
        ${kpiCard('Pending Requests', pendingRequests.length, 'Awaiting your response', '#8B5CF6','#F5F3FF', svgFlash())}
      </div>
      ${pendingRequests.length ? `<div class="card" style="margin-top:20px;border:1px solid #E9D5FF">
        <div class="card-header"><div><div class="card-title">Ad Hoc Assignment Requests</div><div style="font-size:12px;color:var(--text3);margin-top:3px">Review requests from your manager before they become active tasks.</div></div></div>
        <div class="table-wrap"><table><thead><tr><th>Task</th><th>Sales Org</th><th>Due</th><th>Estimated</th><th>Manager</th><th>Action</th></tr></thead><tbody>
          ${pendingRequests.map(t=>`<tr>
            <td><strong>${escHtml(t.name)}</strong><div style="font-size:11px;color:var(--text3)">${escHtml(t.description||'')}</div></td>
            <td><span class="badge badge-teal">${escHtml(t.salesOrg||'—')}</span></td>
            <td>${t.dueDate||'—'}</td><td>${t.estHours||0}h</td><td>${escHtml(taskManagerName(t)||'Manager')}</td>
            <td><div style="display:flex;gap:6px"><button class="btn btn-primary btn-sm" onclick="respondToAdhoc('${t.id}','Accepted')">Accept</button><button class="btn btn-danger btn-sm" onclick="respondToAdhoc('${t.id}','Rejected')">Reject</button></div></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>` : ''}
      ${thisWeekReportsCard()}
      ${memberReportsCard(myEmpId())}
      <div class="card" style="margin-top:20px">
        <div class="card-header"><div class="card-title">My Open Tasks</div>
          <button class="btn btn-primary btn-sm" onclick="navigate('adhoc')">View All Tasks</button>
        </div>
        ${myTasks.filter(t=>!isTaskPendingAcceptance(t)).length===0
          ? '<div class="empty-state"><p>No accepted open tasks assigned to you</p></div>'
          : '<div class="table-wrap" style="max-height:340px;overflow-y:auto"><table><thead><tr style="position:sticky;top:0;background:var(--surface,#fff);z-index:1"><th>Task</th><th>Sales Org</th><th>Category</th><th>Due</th><th>Status</th></tr></thead><tbody>'
            + myTasks.filter(t=>!isTaskPendingAcceptance(t)).slice().reverse().map(t=>`<tr>
                <td><strong>${t.name}</strong></td><td><span class="badge badge-teal">${t.salesOrg||'—'}</span></td>
                <td><span class="badge badge-blue">${t.category||'—'}</span></td>
                <td>${t.dueDate||'—'}</td>
                <td><span class="badge ${t.status==='In Progress'?'badge-amber':t.status==='Not Started'?'badge-gray':'badge-green'}">${t.status}</span></td>
              </tr>`).join('')
            + '</tbody></table></div>'
        }
      </div>`;
    return;
  }

  content.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px">${etClockHtml()}</div>
    <div class="kpi-grid">
      ${kpiCard('Total Employees', totalEmps, 'Active team members', '#0B4EA2', '#EEF2FF', svgPeople())}
      ${kpiCard('Regular Reports', totalReg, 'Recurring reports', '#0D9488', '#CCFBF1', svgDoc())}
      ${kpiCard('Adhoc Tasks', totalAdhoc, selectedMonthLabel(), '#F59E0B', '#FEF3C7', svgFlash())}
      ${kpiCard('Due Today', dueToday, 'Pending completion', '#EF4444', '#FEE2E2', svgClock())}
      ${kpiCard('Avg Quality Score', avgQuality+'%', selectedMonthLabel(), '#8B5CF6', '#F5F3FF', svgStar())}
      ${kpiCard('Team Utilization', avgUtil+'%', 'Today', '#0EA5E9', '#E0F2FE', svgChart())}
      ${kpiCard('Available Hrs', totalAvail.toFixed(1)+'h', 'Team today', '#22C55E', '#DCFCE7', svgBattery())}
    </div>

    ${thisWeekReportsCard()}
    ${myEmpId() ? memberReportsCard(myEmpId()) : ''}
    ${teamReportsCard()}

    ${!isMember() ? (()=>{ const teamIds = visibleEmployees().map(e=>e.id); const pending = STATE.adhocTasks.filter(t=>teamIds.includes(t.assignedTo) && isTaskPendingAcceptance(t)); const responded = STATE.adhocTasks.filter(t=>teamIds.includes(t.assignedTo) && ['Accepted','Rejected'].includes(taskAssignmentLabel(t)) && t.responseAt).sort((a,b)=>new Date(b.responseAt)-new Date(a.responseAt)).slice(0,8); return `<div class="card" style="margin-bottom:20px;border:1px solid #E5E7EB"><div class="card-header"><div><div class="card-title">Ad Hoc Assignment Control</div><div style="font-size:12px;color:var(--text3);margin-top:3px">Track assignment requests and employee responses in one place.</div></div>${pending.length ? `<span class="badge badge-amber">${pending.length} Pending</span>` : '<span class="badge badge-green">No Pending Requests</span>'}</div>${pending.length ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Employee</th><th>Sales Org</th><th>Due</th><th>Response</th></tr></thead><tbody>${pending.map(t=>{const e=STATE.employees.find(x=>x.id===t.assignedTo); return `<tr><td><strong>${escHtml(t.name)}</strong></td><td>${escHtml(e?.name||'—')}</td><td><span class="badge badge-teal">${escHtml(t.salesOrg||'—')}</span></td><td>${t.dueDate||'—'}</td><td>${assignmentBadge(taskAssignmentLabel(t))}</td></tr>`}).join('')}</tbody></table></div>` : ''}${responded.length ? `<div style="padding:12px 16px 6px;font-size:12px;font-weight:700;color:var(--text2)">Recent Employee Responses</div><div class="table-wrap"><table><thead><tr><th>Task</th><th>Employee</th><th>Sales Org</th><th>Response</th><th>When</th></tr></thead><tbody>${responded.map(t=>{const e=STATE.employees.find(x=>x.id===t.assignedTo); return `<tr><td><strong>${escHtml(t.name)}</strong></td><td>${escHtml(e?.name||'—')}</td><td><span class="badge badge-teal">${escHtml(t.salesOrg||'—')}</span></td><td>${assignmentBadge(taskAssignmentLabel(t))}${t.acceptedHours?`<div style="font-size:11px;color:var(--text3);margin-top:3px">${t.acceptedHours}h · ${t.startDate||'—'} → ${t.expectedEndDate||'—'}</div>`:''}${t.responseComment?`<div style="font-size:11px;color:var(--text3);margin-top:3px">${escHtml(t.responseComment)}</div>`:''}</td><td>${t.responseAt ? fmtDateTimeET(t.responseAt) : '—'}</td></tr>`}).join('')}</tbody></table></div>` : ''}</div>`; })() : ''}

    <div class="charts-grid">
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Employee Performance Ranking</div><div class="card-subtitle">${selectedMonthLabel()}</div></div>
        </div>
        <div class="chart-wrap"><canvas id="ch-perf"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Workload Distribution</div><div class="card-subtitle">Today's allocation</div></div>
        </div>
        <div class="chart-wrap"><canvas id="ch-workload"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Regular vs Adhoc Split</div><div class="card-subtitle">${selectedMonthLabel()}</div></div>
        </div>
        <div class="chart-wrap"><canvas id="ch-split"></canvas></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div><div class="card-title">Leave Analysis</div><div class="card-subtitle">${selectedMonthLabel()}</div></div>
        </div>
        <div class="chart-wrap"><canvas id="ch-leave"></canvas></div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div><div class="card-title">Team Overview — ${selectedMonthLabel()}</div></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Employee</th><th>Designation</th><th>Team</th>
            <th>Utilization</th><th>Quality</th><th>Performance</th><th>Action</th>
          </tr></thead>
          <tbody>
            ${activeEmps.length===0 ? `<tr><td colspan="7"><div class="empty-state"><p>No employees yet</p><small>Add employees to see the dashboard</small></div></td></tr>` :
              activeEmps.map(e=>{
                const bw = getEmployeeBandwidth(e.id, todayStr);
                const qs = getQualityScore(e.id,y,m);
                const ps = getPerformanceScore(e.id,y,m);
                const pl = perfLabel(ps);
                return `<tr>
                  <td><div style="display:flex;align-items:center;gap:9px">
                    <div class="avatar">${initials(e.name)}</div>
                    <div><div style="font-weight:600">${e.name}</div><div style="font-size:11px;color:var(--text3)">${e.email}</div></div>
                  </div></td>
                  <td>${e.designation||'—'}</td>
                  <td>${e.team||'—'}</td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div class="progress-bar" style="width:80px"><div class="progress-fill ${utilColor(bw.pct)}" style="width:${bw.pct}%"></div></div>
                      <span style="font-size:12px;font-weight:600;color:var(--text2)">${bw.pct}%</span>
                    </div>
                  </td>
                  <td><span class="badge badge-blue">${qs}/100</span></td>
                  <td><span class="badge ${pl.cls}">${pl.label}</span></td>
                  <td><button class="btn btn-secondary btn-sm" onclick="viewEmployee('${e.id}')">Profile</button></td>
                </tr>`;
              }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Build Charts
  setTimeout(()=>{
    buildPerfChart(activeEmps, y, m);
    buildWorkloadChart(activeEmps, todayStr);
    buildSplitChart(activeEmps, y, m);
    buildLeaveChart(activeEmps, y, m);
  }, 0);
}

function kpiCard(label, value, sub, color, bg, icon) {
  return `<div class="kpi-card" style="--kpi-color:${color};--kpi-bg:${bg}">
    <div class="kpi-icon">${icon}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-label">${label}</div>
    <div class="kpi-delta" style="color:var(--text3);font-weight:400">${sub}</div>
  </div>`;
}

function buildPerfChart(emps, y, m) {
  const ctx = document.getElementById('ch-perf');
  if(!ctx) return;
  const labels = emps.slice(0,8).map(e=>e.name.split(' ')[0]);
  const data = emps.slice(0,8).map(e=>getPerformanceScore(e.id,y,m));
  const colors = data.map(v=>v>=90?'#22C55E':v>=75?'#0D9488':v>=60?'#F59E0B':'#EF4444');
  STATE.charts['perf'] = new Chart(ctx, {
    type:'bar',
    data:{labels, datasets:[{data, backgroundColor:colors, borderRadius:6, borderSkipped:false}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},
      scales:{y:{min:0,max:100,grid:{color:'#F0F2FA'},ticks:{font:{size:11}}},
              x:{grid:{display:false},ticks:{font:{size:11}}}}}
  });
}

function buildWorkloadChart(emps, dateStr) {
  const ctx = document.getElementById('ch-workload');
  if(!ctx) return;
  const buckets = {Available:0, Regular:0, Adhoc:0, Leave:0};
  emps.forEach(e=>{
    const bw = getEmployeeBandwidth(e.id, dateStr);
    buckets.Available += bw.available;
    buckets.Regular   += bw.regular;
    buckets.Adhoc     += bw.adhoc;
    buckets.Leave     += bw.leave;
  });
  STATE.charts['workload'] = new Chart(ctx, {
    type:'doughnut',
    data:{labels:Object.keys(buckets),datasets:[{data:Object.values(buckets),
      backgroundColor:['#22C55E','#0B4EA2','#F59E0B','#EF4444'],borderWidth:0,hoverOffset:6}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'65%',
      plugins:{legend:{position:'right',labels:{font:{size:11},boxWidth:12}}}}
  });
}

function buildSplitChart(emps, y, m) {
  const ctx = document.getElementById('ch-split');
  if(!ctx) return;
  const regAssigned = STATE.assignments.length;
  const adhocCount = STATE.adhocTasks.filter(t=>{
    const d=parseDate(t.assignedDate||'');
    return d.getFullYear()===y && d.getMonth()===m;
  }).length;
  STATE.charts['split'] = new Chart(ctx, {
    type:'pie',
    data:{labels:['Regular Reports','Adhoc Tasks'],
      datasets:[{data:[regAssigned,adhocCount],
        backgroundColor:['#0B4EA2','#F59E0B'],borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}}}
  });
}

function buildLeaveChart(emps, y, m) {
  const ctx = document.getElementById('ch-leave');
  if(!ctx) return;
  const empNames = emps.slice(0,8).map(e=>e.name.split(' ')[0]);
  const planned = emps.slice(0,8).map(e=>STATE.leaves.filter(l=>l.employeeId===e.id&&l.type==='Planned'&&parseDate(l.date).getFullYear()===y&&parseDate(l.date).getMonth()===m).length);
  const unplanned = emps.slice(0,8).map(e=>STATE.leaves.filter(l=>l.employeeId===e.id&&l.type==='Unplanned'&&parseDate(l.date).getFullYear()===y&&parseDate(l.date).getMonth()===m).length);
  STATE.charts['leave'] = new Chart(ctx, {
    type:'bar',
    data:{labels:empNames,datasets:[
      {label:'Planned',data:planned,backgroundColor:'#0B4EA2',borderRadius:4},
      {label:'Unplanned',data:unplanned,backgroundColor:'#EF4444',borderRadius:4}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{position:'bottom',labels:{font:{size:11},boxWidth:12}}},
      scales:{x:{stacked:false,grid:{display:false},ticks:{font:{size:11}}},
              y:{grid:{color:'#F0F2FA'},ticks:{font:{size:11},stepSize:1}}}}
  });
}

// ═══════════════════════════════════════════════════════════
// PAGE: CAPACITY PLANNER
// ═══════════════════════════════════════════════════════════
function capacity() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  // Managers excluded — capacity/utilization here is an individual workload
  // metric, and a manager's contribution is reflected via their team instead.
  const activeEmps = visibleEmployees().filter(e=>e.status==='active' && e.role!=='manager');
  const daysInM = daysInMonth(y,m);
  const dayHeaders = [];
  for(let i=1;i<=daysInM;i++){
    const d=new Date(y,m,i);
    dayHeaders.push({day:i, label:['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()], date:fmtDate(d)});
  }

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Capacity Heatmap — ${selectedMonthLabel()}</h2>
      <div style="display:flex;gap:8px;align-items:center">
        <span class="badge badge-green">● Available</span>
        <span class="badge badge-amber">● Moderate</span>
        <span class="badge badge-red">● Overloaded</span>
        <span class="badge badge-gray">● Weekend/Holiday</span>
      </div>
    </div>

    <div class="card" style="overflow:hidden;padding:0">
      <div style="overflow-x:auto">
        <table style="min-width:900px">
          <thead><tr>
            <th style="position:sticky;left:0;background:var(--surface2);z-index:2;min-width:160px">Employee</th>
            ${dayHeaders.map(d=>`<th style="text-align:center;font-size:11px;padding:8px 4px;min-width:38px">
              <div>${d.label}</div><div style="font-weight:400;color:var(--text3)">${d.day}</div>
            </th>`).join('')}
          </tr></thead>
          <tbody>
            ${activeEmps.length===0 ? `<tr><td colspan="${daysInM+1}" class="empty-state">No employees</td></tr>` :
              activeEmps.map(e=>`<tr>
                <td style="position:sticky;left:0;background:var(--surface);z-index:1;font-weight:600;font-size:13px">
                  <div style="display:flex;align-items:center;gap:8px">
                    <div class="avatar" style="width:28px;height:28px;font-size:10px">${initials(e.name)}</div>
                    ${e.name.split(' ')[0]}
                  </div>
                </td>
                ${dayHeaders.map(d=>{
                  const dt = parseDate(d.date);
                  if(isWeekend(dt)) return `<td style="text-align:center"><div class="cal-cell cal-weekend" style="width:30px;margin:auto">—</div></td>`;
                  if(isHoliday(d.date)) return `<td style="text-align:center"><div class="cal-cell cal-holiday" style="width:30px;margin:auto" data-tip="Holiday">H</div></td>`;
                  const bw = getEmployeeBandwidth(e.id, d.date);
                  const cls = bw.pct===100&&bw.leave>0 ? 'cal-gray' : calColor(bw.pct);
                  const isToday = d.date===today();
                  return `<td style="text-align:center"><div class="cal-cell ${cls}${isToday?' cal-today':''}" style="width:30px;margin:auto" data-tip="${bw.pct}% used · Reg ${fmtH(bw.regular)}h · Adhoc ${fmtH(bw.adhoc)}h · Project ${fmtH(bw.project)}h">${bw.available.toFixed(0)}h</div></td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div style="margin-top:20px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px">
      ${activeEmps.map(e=>{
        const bwList = getMonthBandwidth(e.id);
        const avgUtil = bwList.length ? Math.round(bwList.reduce((s,b)=>s+b.pct,0)/bwList.length) : 0;
        const totalAvail = bwList.reduce((s,b)=>s+b.available,0);
        const projMonth = bwList.reduce((s,b)=>s+(b.project||0),0);
        return `<div class="card">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
            <div class="avatar">${initials(e.name)}</div>
            <div><div style="font-weight:600">${e.name}</div><div style="font-size:12px;color:var(--text3)">${e.team||'—'}</div></div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px">
            <div style="background:var(--surface2);padding:8px;border-radius:8px">
              <div style="color:var(--text3)">Avg Utilization</div>
              <div style="font-weight:700;font-size:16px;color:${avgUtil>85?'var(--coral)':avgUtil>60?'var(--accent)':'var(--green)'}">${avgUtil}%</div>
            </div>
            <div style="background:var(--surface2);padding:8px;border-radius:8px">
              <div style="color:var(--text3)">Total Available</div>
              <div style="font-weight:700;font-size:16px;color:var(--teal)">${totalAvail.toFixed(1)}h</div>
            </div>
          </div>
          <div style="margin-top:8px;font-size:12px;background:var(--surface2);padding:8px;border-radius:8px;display:flex;justify-content:space-between">
            <span style="color:var(--text3)">Project hours this month</span><strong>${fmtH(projMonth)}h</strong>
          </div>
        </div>`;
      }).join('')}
    </div>
  `;
}

// ═══════════════════════════════════════════════════════════
// PAGE: EMPLOYEES
// ═══════════════════════════════════════════════════════════
function employees() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Employees</h2>
      <div style="display:flex;gap:10px">
        <div class="search-bar">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="emp-search" placeholder="Search employees…" oninput="renderEmpTable()" />
        </div>
        <select class="form-control" id="emp-filter-team" onchange="renderEmpTable()" style="width:160px;padding:7px 10px">
          <option value="">All Teams</option>
          ${[...new Set(STATE.employees.map(e=>e.team).filter(Boolean))].map(t=>`<option value="${t}">${t}</option>`).join('')}
        </select>
        <select class="form-control" id="emp-filter-status" onchange="renderEmpTable()" style="width:130px;padding:7px 10px">
          <option value="">All Status</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        ${isAdmin() ? `<button class="btn btn-danger" onclick="clearAllLoginsExceptAdmin()" title="Unlink every employee's Supabase login except yours">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
          Clear All Logins
        </button>` : ''}
        ${isAdmin() || isManager() ? `<button class="btn btn-primary" onclick="openEmpModal()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add Employee
        </button>` : ''}
      </div>
    </div>
    <div class="card" id="emp-table-wrap"></div>
  `;
  renderEmpTable();
}

// Admin-only: unlinks every employee's Supabase record from its Supabase Auth
// account (clears authUid) except the record matching the currently logged-in
// admin, if the admin is also an employee. This does NOT delete the actual
// Supabase Auth accounts — that still has to be done in the Supabase Dashboard
// (Authentication tab), since deleting other users' accounts requires the
// Admin SDK, which isn't available client-side. This just removes the app's
// link to them, so each affected employee will be offered a fresh "Set Login
// Password" field next time you edit them, instead of hitting
// auth/email-already-in-use or a stale "✓ Active" status.
function clearAllLoginsExceptAdmin() {
  const myAuthUid = STATE.currentUser?.authUid;
  const toClear = STATE.employees.filter(e => e.authUid && e.authUid !== myAuthUid);
  if(!toClear.length) { toast('No other logins to clear', 'info'); return; }
  if(!confirm(`Unlink Supabase logins for ${toClear.length} employee(s), keeping only your own admin login?\n\nThis clears the app's link to their account — you still need to delete the actual accounts in the Supabase Dashboard → Authentication tab.`)) return;
  toClear.forEach(e => { delete e.authUid; });
  save();
  toast(`Cleared login link for ${toClear.length} employee(s)`, 'success');
  renderEmpTable();
}

function renderEmpTable() {
  const q=(document.getElementById('emp-search')||{}).value?.toLowerCase()||'';
  const teamF=(document.getElementById('emp-filter-team')||{}).value||'';
  const statF=(document.getElementById('emp-filter-status')||{}).value||'';
  let emps = visibleEmployees().filter(e=>{
    const matchQ = !q||(e.name||'').toLowerCase().includes(q)||(e.email||'').toLowerCase().includes(q)||(e.team||'').toLowerCase().includes(q);
    const matchT = !teamF||e.team===teamF;
    const matchS = !statF||e.status===statF;
    return matchQ&&matchT&&matchS;
  });
  const wrap = document.getElementById('emp-table-wrap');
  if(!wrap) return;
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Employee</th><th>Email</th><th>Designation</th><th>Team</th>
      <th>Manager</th><th>Skills</th><th>Daily Hrs</th><th>Role</th><th>Status</th><th>Actions</th>
    </tr></thead>
    <tbody>
      ${emps.length===0 ? `<tr><td colspan="12"><div class="empty-state">
        <p>No employees found</p><small>Try a different search or add a new employee</small>
      </div></td></tr>` :
        emps.map(e=>{
          const empSkills = (e.skills||[]).map(sid=>STATE.skills.find(s=>s.id===sid)).filter(Boolean);
          return `<tr>
          <td><div style="display:flex;align-items:center;gap:9px">
            <div class="avatar">${initials(e.name)}</div>
            <div><div style="font-weight:600">${e.name}</div><div style="font-size:11px;color:var(--text3)">ID: ${e.empId||e.id.slice(0,8)}</div></div>
          </div></td>
          <td>${e.email||'—'}</td>
          <td>${e.designation||'—'}</td>
          <td>${e.team||'—'}</td>
          <td>${e.manager||'—'}</td>
          <td><div style="display:flex;flex-wrap:wrap;gap:4px;max-width:200px">
            ${empSkills.length ? empSkills.slice(0,3).map(sk=>`<span class="skill-tag" style="font-size:10px;padding:2px 7px">${sk.name}</span>`).join('')+(empSkills.length>3?`<span class="skill-tag" style="font-size:10px;padding:2px 7px;background:var(--surface2);color:var(--text2);border-color:var(--border)">+${empSkills.length-3}</span>`:''): '<span style="color:var(--text3);font-size:12px">—</span>'}
          </div></td>
          <td style="font-weight:600">${e.loginHours||8}h</td>
          <td><span class="user-role-badge role-${e.role||'member'}" style="font-size:10px">${e.role||'member'}</span></td>
          <td><span class="badge ${e.status==='active'?'badge-green':'badge-gray'}">${e.status||'active'}</span></td>
          <td><div class="inline-actions" style="opacity:1">
            <button class="btn btn-secondary btn-sm" onclick="viewEmployee('${e.id}')">Profile</button>
            <button class="btn btn-secondary btn-sm" onclick="openEmpModal('${e.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteEmployee('${e.id}')">Delete</button>
          </div></td>
        </tr>`;}).join('')}
    </tbody>
  </table></div>`;
}

function openEmpModal(id) {
  const emp = id ? STATE.employees.find(e=>e.id===id) : null;
  const empId = id || '';
  const empSkillIds = (emp && emp.skills) ? emp.skills : [];

  // Team dropdown options — manager only sees their own team
  const allowedTeams = isManager()
    ? STATE.teams.filter(function(t){ return t.name === myTeam(); })
    : STATE.teams;

  const teamOpts = allowedTeams.map(function(t) {
    const sel = (emp && emp.team === t.name) ? ' selected' : (isManager() ? ' selected' : '');
    return '<option value="' + t.name + '"' + sel + '>' + t.name + '</option>';
  }).join('');

  // For manager: team is fixed — render as readonly text, not a dropdown
  const teamField = allowedTeams.length === 0
    ? '<p style="font-size:12px;color:var(--text3);margin:4px 0">No teams defined yet.</p><input type="hidden" id="f-team" value=""/>'
    : isManager()
      ? '<input class="form-control" id="f-team" value="' + myTeam() + '" readonly style="background:var(--surface2);color:var(--text2);cursor:default"/>'
      : '<select class="form-control" id="f-team" onchange="onTeamChange()"><option value="">— Select Team —</option>' + teamOpts + '</select>';

  // Skill picker options (exclude already-assigned)
  const availSkillOpts = STATE.skills
    .filter(function(s){ return !empSkillIds.includes(s.id); })
    .map(function(s){ return '<option value="' + s.id + '">' + s.name + '</option>'; })
    .join('');

  // Existing skill tags
  const existingTags = empSkillIds.map(function(sid) {
    const sk = STATE.skills.find(function(s){ return s.id === sid; });
    if(!sk) return '';
    return '<span class="skill-tag">' + sk.name
      + '<span class="skill-tag-remove" onclick="removeSkillFromEmp(\'' + sid + '\')">&#215;</span></span>';
  }).join('');

  const phDisplay = empSkillIds.length ? 'display:none' : '';

  const modal = document.createElement('div');
  modal.className = 'form-grid form-grid-2';
  modal.innerHTML = [
    '<div class="form-group">',
      '<label class="form-label">Employee ID</label>',
      '<input class="form-control" id="f-empId" placeholder="EMP001" value="' + (emp && emp.empId ? emp.empId : '') + '"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Full Name *</label>',
      '<input class="form-control" id="f-name" placeholder="John Doe" value="' + (emp && emp.name ? emp.name : '') + '"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Email</label>',
      '<input class="form-control" id="f-email" type="email" placeholder="john@company.com" value="' + (emp && emp.email ? emp.email : '') + '"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Designation</label>',
      '<input class="form-control" id="f-desg" placeholder="Senior Analyst" value="' + (emp && emp.designation ? emp.designation : '') + '"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Team</label>',
      teamField,
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Manager <span style="font-size:11px;color:var(--text3);font-weight:400">(auto-filled)</span></label>',
      '<input class="form-control" id="f-mgr" placeholder="Auto-filled when team selected" value="' + (isManager() ? (STATE.currentUser.name || '') : (emp && emp.manager ? emp.manager : '')) + '" readonly style="background:var(--surface2);color:var(--text2);cursor:default"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Daily Login Hours</label>',
      '<input class="form-control" id="f-hrs" type="number" min="1" max="12" value="' + (emp ? emp.loginHours || 8 : 8) + '"/>',
    '</div>',
    '<div class="form-group">',
      '<label class="form-label">Status</label>',
      '<select class="form-control" id="f-status">',
        '<option value="active"' + ((!emp || emp.status === 'active') ? ' selected' : '') + '>Active</option>',
        '<option value="inactive"' + (emp && emp.status === 'inactive' ? ' selected' : '') + '>Inactive</option>',
      '</select>',
    '</div>',
    isAdmin() ? '<div class="form-group"><label class="form-label">Role</label>'
      + '<select class="form-control" id="f-role">'
      + '<option value="member"'  + ((!emp || (emp.role||'member')==='member')  ? ' selected' : '') + '>Member</option>'
      + '<option value="manager"' + ((emp && emp.role==='manager') ? ' selected' : '') + '>Manager</option>'
      + '</select></div>' : '',
    isAdmin() ? (
      emp && emp.authUid
        ? '<div class="form-group"><label class="form-label">Login Account</label><div style="display:flex;align-items:center;gap:8px"><span style="font-size:13px;color:var(--success,#0D9488);font-weight:600">✓ Active</span><button type="button" class="btn btn-secondary btn-sm" onclick="sendEmployeePasswordReset(\'' + emp.id + '\')">Send Password Reset</button></div></div>'
        : '<div class="form-group"><label class="form-label">Set Login Password <span style="font-size:11px;color:var(--text3);font-weight:400">(creates their Supabase login — requires Email above)</span></label><input class="form-control" id="f-password" type="password" placeholder="Temporary password (min 6 characters)" autocomplete="new-password"/></div>'
    ) : '',
    '<div class="form-group" style="grid-column:1/-1">',
      '<label class="form-label">Skills</label>',
      STATE.skills.length === 0
        ? '<p style="font-size:12px;color:var(--text3);margin:4px 0">No skills yet. <a href="#" onclick="closeModal();navigate(\'skills\');return false;" style="color:var(--primary);font-weight:600">Add skills first →</a></p><input type="hidden" id="f-skills" value="[]"/>'
        : '<div style="display:flex;gap:8px;margin-bottom:8px;align-items:center">'
          + '<select class="form-control" id="skill-picker" style="max-width:280px"><option value="">— Select skill —</option>' + availSkillOpts + '</select>'
          + '<button type="button" class="btn btn-secondary" onclick="addSkillToEmp()" style="white-space:nowrap">+ Add</button>'
          + '</div>'
          + '<div class="skill-tags-wrap" id="emp-skill-tags">' + existingTags
          + '<span id="emp-skill-placeholder" style="color:var(--text3);font-size:12px;' + phDisplay + '">No skills added yet</span></div>'
          + '<input type="hidden" id="f-skills" value="' + JSON.stringify(empSkillIds).replace(/"/g, "&quot;") + '"/>',
    '</div>'
  ].join('');

  openModal(emp ? 'Edit Employee' : 'Add Employee', modal.outerHTML, [
    {label: 'Cancel', cls: 'btn-secondary', fn: 'closeModal()'},
    {label: emp ? 'Save Changes' : 'Add Employee', cls: 'btn-primary', fn: "saveEmployee('" + empId + "')"}
  ]);
}

function addSkillToEmp() {
  const picker = document.getElementById('skill-picker');
  const sid = picker.value;
  if(!sid) return;
  const hidden = document.getElementById('f-skills');
  let current = JSON.parse(hidden.value||'[]');
  if(current.includes(sid)) { picker.value=''; return; }
  current.push(sid);
  hidden.value = JSON.stringify(current);
  const sk = STATE.skills.find(s=>s.id===sid);
  if(sk) {
    const wrap = document.getElementById('emp-skill-tags');
    const tag = document.createElement('span');
    tag.className='skill-tag';
    tag.innerHTML=`${sk.name}<span class="skill-tag-remove" onclick="removeSkillFromEmp('${sid}')">×</span>`;
    wrap.appendChild(tag);
    // hide placeholder
    const ph = document.getElementById('emp-skill-placeholder');
    if(ph) ph.style.display='none';
  }
  // Remove this option from the picker so it can't be double-added
  const opt = picker.querySelector(`option[value="${sid}"]`);
  if(opt) opt.remove();
  picker.value='';
}

function removeSkillFromEmp(sid) {
  const hidden = document.getElementById('f-skills');
  let current = JSON.parse(hidden.value||'[]');
  current = current.filter(s=>s!==sid);
  hidden.value = JSON.stringify(current);
  // Remove tag from DOM
  const wrap = document.getElementById('emp-skill-tags');
  if(wrap) {
    wrap.querySelectorAll('.skill-tag').forEach(el=>{
      if(el.querySelector('.skill-tag-remove')?.getAttribute('onclick')?.includes(sid)) el.remove();
    });
    // Show placeholder if no skills left
    const ph = document.getElementById('emp-skill-placeholder');
    if(ph) ph.style.display = current.length===0 ? '' : 'none';
  }
  // Put the skill option back in the picker
  const picker = document.getElementById('skill-picker');
  if(picker) {
    const sk = STATE.skills.find(s=>s.id===sid);
    if(sk) {
      const opt = document.createElement('option');
      opt.value = sk.id;
      opt.textContent = sk.name;
      // Insert alphabetically
      const opts = Array.from(picker.options);
      const insertBefore = opts.find(o=>o.value && o.textContent > sk.name);
      insertBefore ? picker.insertBefore(opt, insertBefore) : picker.appendChild(opt);
    }
  }
}

async function saveEmployee(id) {
  const skillsEl = document.getElementById('f-skills');
  const teamEl = document.getElementById('f-team');
  const teamName = isManager() ? myTeam() : (teamEl ? teamEl.value.trim() : '');
  const teamObj = STATE.teams.find(t => t.name === teamName);
  const managerName = isManager() ? STATE.currentUser.name : (teamObj ? teamObj.manager : (document.getElementById('f-mgr') ? document.getElementById('f-mgr').value.trim() : ''));
  const existingEmp = id ? STATE.employees.find(e => e.id === id) : null;
  const fields = {
    empId: document.getElementById('f-empId').value.trim(),
    name:  document.getElementById('f-name').value.trim(),
    email: document.getElementById('f-email').value.trim(),
    designation: document.getElementById('f-desg').value.trim(),
    team:    teamName,
    manager: managerName,
    loginHours: parseFloat(document.getElementById('f-hrs').value)||8,
    status: document.getElementById('f-status').value,
    role: (isAdmin() && document.getElementById('f-role')) ? document.getElementById('f-role').value : (existingEmp ? (existingEmp.role||'member') : 'member'),
    skills: skillsEl ? JSON.parse(skillsEl.value||'[]') : []
  };
  if(!fields.name) { toast('Employee name is required','error'); return; }

  // If a temp password was entered (only shown when the employee has no
  // Supabase Auth account yet), create their login before saving the record.
  const pwEl = document.getElementById('f-password');
  const tempPassword = pwEl ? pwEl.value.trim() : '';
  let newAuthUid = existingEmp ? existingEmp.authUid : undefined;
  if(tempPassword) {
    if(!fields.email) { toast('Add an email before setting a login password','error'); return; }
    if(tempPassword.length < 6) { toast('Password must be at least 6 characters','error'); return; }
    try {
      newAuthUid = await createEmployeeAuthAccount(fields.email, tempPassword);
      toast('Login account created for ' + fields.email, 'success');
    } catch(err) {
      const msg = err.message || err.code || 'unknown error';
      if(/rate limit/i.test(msg) && /email/i.test(msg)) {
        toast('Email rate limit hit — Supabase\'s default email service caps confirmation emails per hour. If you don\'t need employees to confirm by email, turn off "Confirm email" under Authentication → Providers → Email in your Supabase Dashboard, then try again.', 'error');
      } else {
        toast('Could not create login: ' + msg, 'error');
      }
      return;
    }
  }

  if(id) {
    const idx = STATE.employees.findIndex(e=>e.id===id);
    if(idx>-1) {
      STATE.employees[idx] = {...STATE.employees[idx], ...fields};
      if(newAuthUid) STATE.employees[idx].authUid = newAuthUid;
    }
    toast('Employee updated','success');
  } else {
    const newEmp = {...fields, id:uid(), createdAt:today()};
    if(newAuthUid) newEmp.authUid = newAuthUid;
    STATE.employees.push(newEmp);
    toast('Employee added','success');
  }
  save(); closeModal(); employees();
}

// Sends a Supabase-hosted "reset your password" email to an employee who
// already has a login account. Client-side apps can't directly change
// another user's password (that needs the Admin API, which requires the
// service role key and must never run in the browser), so this is the
// supported self-service path. Requires a redirect URL to be configured in
// Supabase Dashboard → Authentication → URL Configuration for the reset
// link in the email to work.
function sendEmployeePasswordReset(id) {
  const emp = STATE.employees.find(e => e.id === id);
  if(!emp || !emp.email) { toast('This employee has no email on file','error'); return; }
  sb.auth.resetPasswordForEmail(emp.email)
    .then(({ error }) => {
      if(error) toast('Could not send reset email: ' + error.message, 'error');
      else toast('Password reset email sent to ' + emp.email, 'success');
    });
}

function deleteEmployee(id) {
  if(!confirm('Delete this employee? This cannot be undone.')) return;

  STATE.employees = STATE.employees.filter(e=>e.id!==id);

  // Regular-report assignments only exist to link this employee to a
  // report — remove them entirely.
  STATE.assignments = STATE.assignments.filter(a=>a.employeeId!==id);
  STATE.reportCompletions = STATE.reportCompletions.filter(c=>c.employeeId!==id);

  // Personal records that belong to this employee specifically — leaves,
  // quality reviews (manual + auto-generated from surveys), and survey
  // responses. These are the employee's "details" and shouldn't linger
  // in Supabase referencing an ID that no longer exists.
  STATE.leaves          = STATE.leaves.filter(l=>l.employeeId!==id);
  STATE.qualityReviews  = STATE.qualityReviews.filter(r=>r.employeeId!==id);
  STATE.surveyResponses = STATE.surveyResponses.filter(r=>r.employeeId!==id);

  // Work items (adhoc tasks) are organizational records, not the employee's
  // own data — unassign rather than delete, so the task and its history
  // survive and can be handed to someone else instead of silently
  // disappearing.
  STATE.adhocTasks.forEach(t=>{ if(t.assignedTo===id) t.assignedTo = null; });

  save(); toast('Employee and their records deleted','info'); employees();
}

function viewEmployee(id) {
  const emp = STATE.employees.find(e=>e.id===id);
  if(!emp) return;
  const y=STATE.currentYear, m=STATE.currentMonth;
  const qs = getQualityScore(id,y,m);
  const ps = getPerformanceScore(id,y,m);
  const pl = perfLabel(ps);
  const bw = getEmployeeBandwidth(id, today());
  const myReps = STATE.assignments.filter(a=>a.employeeId===id).map(a=>STATE.regularReports.find(r=>r.id===a.reportId)).filter(Boolean);
  const myAdhoc = STATE.adhocTasks.filter(t=>t.assignedTo===id).slice(0,8);
  const myLeaves = STATE.leaves.filter(l=>l.employeeId===id).slice(-10).reverse();

  openModal('Employee Profile', `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border)">
      <div class="avatar" style="width:56px;height:56px;font-size:20px">${initials(emp.name)}</div>
      <div>
        <div style="font-size:20px;font-weight:800">${emp.name}</div>
        <div style="color:var(--text3)">${emp.designation||'—'} · ${emp.team||'—'}</div>
        <div style="color:var(--text3);font-size:12px">${emp.email||''} · Manager: ${emp.manager||'—'}</div>
      </div>
      <div style="margin-left:auto;display:flex;gap:12px">
        <div style="text-align:center;padding:12px 20px;background:var(--primary-lt);border-radius:var(--radius)">
          <div style="font-size:22px;font-weight:800;color:var(--primary)">${ps}</div>
          <div style="font-size:11px;color:var(--text3)">Perf Score</div>
          <span class="badge ${pl.cls}" style="margin-top:4px">${pl.label}</span>
        </div>
        <div style="text-align:center;padding:12px 20px;background:var(--teal-lt);border-radius:var(--radius)">
          <div style="font-size:22px;font-weight:800;color:var(--teal)">${qs}</div>
          <div style="font-size:11px;color:var(--text3)">Quality</div>
        </div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-bottom:20px">
      <div style="background:var(--surface2);padding:12px;border-radius:8px;text-align:center">
        <div style="font-weight:700;font-size:18px">${bw.total}h</div>
        <div style="font-size:11px;color:var(--text3)">Daily Capacity</div>
      </div>
      <div style="background:var(--surface2);padding:12px;border-radius:8px;text-align:center">
        <div style="font-weight:700;font-size:18px;color:var(--primary)">${(bw.regular+bw.adhoc).toFixed(1)}h</div>
        <div style="font-size:11px;color:var(--text3)">Allocated Today</div>
      </div>
      <div style="background:var(--green-lt);padding:12px;border-radius:8px;text-align:center">
        <div style="font-weight:700;font-size:18px;color:var(--green)">${bw.available.toFixed(1)}h</div>
        <div style="font-size:11px;color:var(--text3)">Available Today</div>
      </div>
      <div style="background:var(--surface2);padding:12px;border-radius:8px;text-align:center">
        <div style="font-weight:700;font-size:18px;color:${bw.pct>85?'var(--coral)':'var(--accent)'}">${bw.pct}%</div>
        <div style="font-size:11px;color:var(--text3)">Utilization</div>
      </div>
    </div>
    ${(()=>{
      const empSkills = (emp.skills||[]).map(sid=>STATE.skills.find(s=>s.id===sid)).filter(Boolean);
      if(!empSkills.length) return '';
      return `<div style="margin-bottom:20px;padding:14px 16px;background:var(--primary-lt);border-radius:var(--radius);border:1px solid #C7D2FE">
        <div style="font-size:12px;font-weight:700;color:var(--primary);margin-bottom:8px;text-transform:uppercase;letter-spacing:.05em">Skills</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${empSkills.map(sk=>`<span class="skill-tag">${sk.name}</span>`).join('')}</div>
      </div>`;
    })()}

    <div class="tabs" id="emp-tabs">
      <div class="tab active" onclick="switchEmpTab('reports','${id}')">Regular Reports</div>
      <div class="tab" onclick="switchEmpTab('adhoc','${id}')">Adhoc Tasks</div>
      <div class="tab" onclick="switchEmpTab('leaves','${id}')">Leave History</div>
    </div>
    <div id="emp-tab-content">
      ${empReportsTab(myReps, id)}
    </div>
  `, [{label:'Close', cls:'btn-secondary', fn:'closeModal()'}], true);
}

function switchEmpTab(tab, empId) {
  document.querySelectorAll('#emp-tabs .tab').forEach((t,i)=>{
    t.classList.toggle('active', ['reports','adhoc','leaves'][i]===tab);
  });
  const myReps = STATE.assignments.filter(a=>a.employeeId===empId).map(a=>STATE.regularReports.find(r=>r.id===a.reportId)).filter(Boolean);
  const myAdhoc = STATE.adhocTasks.filter(t=>t.assignedTo===empId);
  const myLeaves = STATE.leaves.filter(l=>l.employeeId===empId).reverse();
  const tc = document.getElementById('emp-tab-content');
  if(tab==='reports') tc.innerHTML = empReportsTab(myReps, empId);
  if(tab==='adhoc')   tc.innerHTML = empAdhocTab(myAdhoc);
  if(tab==='leaves')  tc.innerHTML = empLeavesTab(myLeaves);
}
function empReportsTab(reps, empId) {
  if(!reps.length) return `<div class="empty-state"><p>No regular reports assigned</p></div>`;
  const y=STATE.currentYear, m=STATE.currentMonth;
  const rs = getReportScore(empId, y, m);
  return `<div style="font-size:12px;color:var(--text3);margin-bottom:10px">${selectedMonthLabel()} · Report score <strong style="color:var(--text)">${rs.score}%</strong>${rs.due ? ` · ${rs.onTime} on time, ${rs.late} late, ${rs.overdue} overdue` : ''}</div>`
    + reportOccurrencesTable(getReportOccurrences(empId, y, m), empId);
}
function empAdhocTab(tasks) {
  if(!tasks.length) return `<div class="empty-state"><p>No adhoc tasks assigned</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Due</th><th>Hours</th><th>Status</th></tr></thead><tbody>
    ${tasks.map(t=>`<tr><td><strong>${t.name}</strong></td><td>${t.dueDate||'—'}</td><td>${t.estHours}h</td>
      <td><span class="badge ${statusBadge(t.status)}">${t.status}</span></td></tr>`).join('')}
  </tbody></table></div>`;
}
function empLeavesTab(leaves) {
  if(!leaves.length) return `<div class="empty-state"><p>No leave records</p></div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Reason</th></tr></thead><tbody>
    ${leaves.map(l=>`<tr><td>${l.date}</td>
      <td><span class="badge ${l.type==='Planned'?'badge-blue':'badge-red'}">${l.type}</span></td>
      <td>${l.reason||'—'}</td></tr>`).join('')}
  </tbody></table></div>`;
}

// ═══════════════════════════════════════════════════════════
// PAGE: LEAVES
// ═══════════════════════════════════════════════════════════
function leaves() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const visEmpIds = visibleEmployees().map(e=>e.id);
  const monthLeaves = STATE.leaves.filter(l=>{ const d=parseDate(l.date); return d.getFullYear()===y&&d.getMonth()===m && visEmpIds.includes(l.employeeId); });
  const planned = monthLeaves.filter(l=>l.type==='Planned');
  const unplanned = monthLeaves.filter(l=>l.type==='Unplanned');
  const todayStr = today();
  const future = STATE.leaves.filter(l=>l.date>todayStr&&l.type==='Planned'&&visEmpIds.includes(l.employeeId));

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">
      ${kpiCard('Planned Leaves', planned.length, selectedMonthLabel(), '#0B4EA2','#EEF2FF', svgDoc())}
      ${kpiCard('Unplanned Leaves', unplanned.length, selectedMonthLabel(), '#EF4444','#FEE2E2', svgFlash())}
      ${kpiCard('Future Planned', future.length, 'Upcoming', '#22C55E','#DCFCE7', svgClock())}
    </div>

    <div class="section-header">
      <h2>Leave Records — ${selectedMonthLabel()}</h2>
      <button class="btn btn-primary" onclick="openLeaveModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Leave
      </button>
    </div>
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Employee</th><th>Date</th><th>Type</th><th>Reason</th><th>Bandwidth Impact</th><th>Actions</th></tr></thead>
        <tbody>
          ${monthLeaves.length===0 ? `<tr><td colspan="6"><div class="empty-state"><p>No leaves in ${selectedMonthLabel()}</p></div></td></tr>` :
            monthLeaves.map(l=>{
              const emp = STATE.employees.find(e=>e.id===l.employeeId);
              return `<tr>
                <td><div style="display:flex;align-items:center;gap:8px">
                  <div class="avatar" style="width:28px;height:28px;font-size:10px">${initials(emp?.name||'?')}</div>
                  <span style="font-weight:600">${emp?.name||'Unknown'}</span>
                </div></td>
                <td>${l.date}</td>
                <td><span class="badge ${l.type==='Planned'?'badge-blue':'badge-red'}">${l.type}</span></td>
                <td>${l.reason||'—'}</td>
                <td><span class="badge badge-red">Bandwidth → 0h</span></td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteLeave('${l.id}')">Remove</button></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table></div>
    </div>
  `;
}

function openLeaveModal(id) {
  openModal('Add Leave', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Employee *</label>
        <select class="form-control" id="f-lemp">
          <option value="">— Select Employee —</option>
          ${visibleEmployees().filter(e=>e.status==='active').map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Leave Date *</label>
          <input class="form-control" id="f-ldate" type="date" value="${today()}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Leave Type *</label>
          <select class="form-control" id="f-ltype">
            <option value="Planned">Planned</option>
            <option value="Unplanned">Unplanned</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Reason</label>
        <textarea class="form-control" id="f-lreason" placeholder="Optional reason…"></textarea>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Add Leave', cls:'btn-primary', fn:`saveLeave()`}
  ]);
}

function saveLeave() {
  const empId = document.getElementById('f-lemp').value;
  const date  = document.getElementById('f-ldate').value;
  const type  = document.getElementById('f-ltype').value;
  const reason= document.getElementById('f-lreason').value.trim();
  if(!empId||!date) { toast('Employee and date are required','error'); return; }
  // Check duplicate
  if(STATE.leaves.some(l=>l.employeeId===empId&&l.date===date)) { toast('Leave already exists for this date','error'); return; }
  STATE.leaves.push({id:uid(), employeeId:empId, date, type, reason, createdAt:today()});
  save(); closeModal(); toast('Leave recorded','success'); leaves();
}

function deleteLeave(id) {
  STATE.leaves = STATE.leaves.filter(l=>l.id!==id);
  save(); toast('Leave removed','info'); leaves();
}

// ═══════════════════════════════════════════════════════════
// PAGE: REGULAR REPORTS
// ═══════════════════════════════════════════════════════════
function regular() {
  const content = document.getElementById('content');
  if(isMember()) {
    content.innerHTML = `<div class="section-header"><h2>My Regular Reports</h2></div>` + (memberReportsCard(myEmpId()) || '<div class="empty-state"><p>No employee record linked to your login</p></div>');
    return;
  }
  content.innerHTML = `
    <div class="section-header">
      <div>
        <h2>Regular Reports</h2>
        ${isAdmin() ? `<div style="font-size:12px;color:var(--text3);margin-top:4px;display:flex;align-items:center;gap:6px">Completion tracking counts from
          <input type="date" class="form-control" style="width:auto;padding:2px 6px;font-size:12px" value="${STATE.settings.reportTrackingStart||''}" onchange="setReportTrackingStart(this.value)"/></div>` : ''}
      </div>
      <button class="btn btn-primary" onclick="openRegModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Create Report
      </button>
    </div>
    ${teamReportsCard()}
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Report Name</th><th>Description</th><th>Est Hours</th><th>Schedule</th>
          <th>Priority</th><th>Report Owner</th><th>Backup Owner</th><th>Assigned To</th><th>${monthName(STATE.currentMonth)} Progress</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${STATE.regularReports.length===0 ? `<tr><td colspan="10"><div class="empty-state"><p>No regular reports yet</p><small>Create recurring reports to assign to employees</small></div></td></tr>` :
            STATE.regularReports.map(r=>{
              const assignees = STATE.assignments.filter(a=>a.reportId===r.id).map(a=>{
                const e = STATE.employees.find(em=>em.id===a.employeeId);
                return e ? `<div class="avatar" style="width:24px;height:24px;font-size:9px" data-tip="${e.name}">${initials(e.name)}</div>` : '';
              }).join('');
              const dueDate = reportMonthlyMode(r)==='firstWeekday' ? dueDayLabel(firstWeekdayDueDate(r, STATE.currentYear, STATE.currentMonth)) : nthWorkingDay(STATE.currentYear, STATE.currentMonth, parseInt(r.dueWorkingDay));
              const progOcc = STATE.assignments.filter(a=>a.reportId===r.id).flatMap(a=>getReportOccurrences(a.employeeId, STATE.currentYear, STATE.currentMonth).filter(o=>o.report.id===r.id));
              const progDone = progOcc.filter(o=>o.completion).length;
              const progLate = progOcc.filter(o=>o.status==='Late').length;
              const progOver = progOcc.filter(o=>o.status==='Overdue').length;
              return `<tr>
                <td><strong>${r.name}</strong></td>
                <td style="color:var(--text3);font-size:12px;max-width:200px">${r.description||'—'}</td>
                <td style="font-weight:600">${r.estHours}h</td>
                <td>
                  <span class="badge badge-blue">${reportDueLabel(r)}</span>
                  <div style="font-size:11px;color:var(--text3);margin-top:2px">${reportFreq(r)==='Weekly' ? '' : (dueDate||'—')}</div>${reportFreq(r)==='Weekly' ? weeklyRowSummary(r) : ''}
                </td>
                <td><span class="badge ${r.priority==='High'?'badge-red':r.priority==='Medium'?'badge-amber':'badge-blue'}">${r.priority||'Normal'}</span></td>
                <td>${escHtml(r.owner||'—')}</td>
                <td>${escHtml(r.backupOwner||'—')}</td>
                <td><div style="display:flex;gap:3px;flex-wrap:wrap">${assignees||'<span style="color:var(--text3);font-size:12px">Unassigned</span>'}</div></td>
                <td>${progOcc.length ? `<strong>${progDone}/${progOcc.length}</strong> done${progLate?` <span class="badge badge-amber">${progLate} late</span>`:''}${progOver?` <span class="badge badge-red">${progOver} overdue</span>`:''}` : '<span style="color:var(--text3);font-size:12px">—</span>'}</td>
                <td><div style="display:flex;gap:6px">
                  <button class="btn btn-secondary btn-sm" onclick="openRegModal('${r.id}')">Edit</button>
                  <button class="btn btn-danger btn-sm" onclick="deleteReg('${r.id}')">Delete</button>
                </div></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table></div>
    </div>
  `;
}

// <option> list of every employee name (A–Z). Keeps a saved value that is no
// longer in the employee list (e.g. legacy free-text backup owner) selectable.
function empNameOptions(selected) {
  const names = STATE.employees.map(e=>e.name).filter(Boolean).sort((a,b)=>a.localeCompare(b));
  const list = (selected && !names.includes(selected)) ? [selected].concat(names) : names;
  return `<option value="">— Select —</option>` + list.map(n=>`<option value="${escHtml(n)}" ${selected===n?'selected':''}>${escHtml(n)}</option>`).join('');
}

function openRegModal(id) {
  const rep = id ? STATE.regularReports.find(r=>r.id===id) : null;
  openModal(rep?'Edit Report':'Create Regular Report', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Report Name *</label>
        <input class="form-control" id="f-rname" placeholder="Monthly Revenue Report" value="${rep?.name||''}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-control" id="f-rdesc" placeholder="Brief description…">${rep?.description||''}</textarea>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Frequency *</label>
          <select class="form-control" id="f-rfreq" onchange="toggleRegFreq()">
            ${['Monthly','Weekly'].map(f=>`<option ${reportFreq(rep)===f?'selected':''}>${f}</option>`).join('')}
          </select>
        </div>
        <div class="form-group" id="g-rmode">
          <label class="form-label">Monthly Due Date *</label>
          <select class="form-control" id="f-rmode" onchange="toggleRegFreq()">
            <option value="workday" ${reportMonthlyMode(rep)==='workday'?'selected':''}>Nth working day of the month</option>
            <option value="firstWeekday" ${reportMonthlyMode(rep)==='firstWeekday'?'selected':''}>First weekday of the month (e.g. first Friday)</option>
          </select>
        </div>
        <div class="form-group" id="g-rday">
          <label class="form-label">Due Working Day of Month *</label>
          <input class="form-control" id="f-rday" type="number" min="1" max="25" placeholder="1" value="${rep?.dueWorkingDay||1}"/>
        </div>
        <div class="form-group" id="g-rweekday" style="display:none">
          <label class="form-label">Due Weekday *</label>
          <select class="form-control" id="f-rweekday">
            ${[[1,'Monday'],[2,'Tuesday'],[3,'Wednesday'],[4,'Thursday'],[5,'Friday']].map(([v,n])=>`<option value="${v}" ${(parseInt(rep?.dueWeekday)||5)===v?'selected':''}>${n}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Estimated Hours *</label>
          <input class="form-control" id="f-rhrs" type="number" min="0.5" step="0.5" value="${rep?.estHours||1}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Priority</label>
          <select class="form-control" id="f-rprio">
            ${['Low','Normal','Medium','High'].map(p=>`<option ${rep?.priority===p?'selected':''}>${p}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Report Owner</label>
          <select class="form-control" id="f-rowner">${empNameOptions(rep?.owner)}</select>
        </div>
        <div class="form-group">
          <label class="form-label">Backup Owner</label>
          <select class="form-control" id="f-rback">${empNameOptions(rep?.backupOwner)}</select>
        </div>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:rep?'Save Changes':'Create Report', cls:'btn-primary', fn:`saveReg('${id||''}')`}
  ]);
  toggleRegFreq();
}

function toggleRegFreq() {
  const weekly = document.getElementById('f-rfreq').value==='Weekly';
  const firstWd = !weekly && document.getElementById('f-rmode').value==='firstWeekday';
  document.getElementById('g-rmode').style.display = weekly ? 'none' : '';
  document.getElementById('g-rday').style.display = (weekly || firstWd) ? 'none' : '';
  document.getElementById('g-rweekday').style.display = (weekly || firstWd) ? '' : 'none';
}

function saveReg(id) {
  const fields = {
    name:         document.getElementById('f-rname').value.trim(),
    description:  document.getElementById('f-rdesc').value.trim(),
    estHours:     parseFloat(document.getElementById('f-rhrs').value)||1,
    frequency:    document.getElementById('f-rfreq').value,
    monthlyMode:  document.getElementById('f-rmode').value,
    dueWorkingDay:parseInt(document.getElementById('f-rday').value)||1,
    dueWeekday:   parseInt(document.getElementById('f-rweekday').value)||5,
    priority:     document.getElementById('f-rprio').value,
    owner:        document.getElementById('f-rowner').value,
    backupOwner:  document.getElementById('f-rback').value
  };
  if(!fields.name) { toast('Report name required','error'); return; }
  if(id) {
    const idx = STATE.regularReports.findIndex(r=>r.id===id);
    if(idx>-1) STATE.regularReports[idx] = {...STATE.regularReports[idx], ...fields};
    toast('Report updated','success');
  } else {
    STATE.regularReports.push({...fields, id:uid(), createdAt:today()});
    toast('Report created','success');
  }
  save(); closeModal(); regular();
}

function deleteReg(id) {
  if(!confirm('Delete this report and all its assignments?')) return;
  STATE.regularReports = STATE.regularReports.filter(r=>r.id!==id);
  STATE.assignments = STATE.assignments.filter(a=>a.reportId!==id);
  STATE.reportCompletions = STATE.reportCompletions.filter(c=>c.reportId!==id);
  save(); toast('Report deleted','info'); regular();
}

// ═══════════════════════════════════════════════════════════
// PAGE: ADHOC TASKS
// ═══════════════════════════════════════════════════════════
function adhoc() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const u = STATE.currentUser;
  const monthTasks = STATE.adhocTasks.filter(t=>{
    const d=parseDate(t.assignedDate||t.createdAt||'');
    const inMonth = d.getFullYear()===y && d.getMonth()===m;
    if(!inMonth) return false;
    if(isMember()) return t.assignedTo === myEmpId();  // member sees only own
    if(isManager()) {
      // manager sees tasks assigned to own team members
      const emp = STATE.employees.find(e=>e.id===t.assignedTo);
      return !emp || emp.team === myTeam();
    }
    return true; // admin sees all
  });
  const completedCount = monthTasks.filter(t=>t.status==='Completed').length;
  const visibleTasks = STATE.showCompletedAdhoc ? monthTasks : monthTasks.filter(t=>t.status!=='Completed');

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>${isMember() ? 'My Tasks' : 'Adhoc Tasks'} — ${selectedMonthLabel()}</h2>
      <div style="display:flex;gap:10px;align-items:center">
        ${completedCount>0 ? `<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text2);cursor:pointer">
          <input type="checkbox" id="f-show-completed" ${STATE.showCompletedAdhoc?'checked':''} onchange="toggleShowCompletedAdhoc()"/>
          Show Completed (${completedCount})
        </label>` : ''}
        <button class="btn btn-primary" onclick="openAdhocModal()">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          ${isMember() ? 'Add My Task' : 'Create Ad Hoc Task'}
        </button>
      </div>
    </div>
    ${!isMember() ? `<div class="card" style="margin-bottom:16px;padding:12px 16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <span style="font-size:12.5px;color:var(--text3);white-space:nowrap">✉ Survey replies go to:</span>
      <input class="form-control" id="f-surveyinbox" style="max-width:280px;padding:6px 10px;font-size:13px" value="${escHtml(STATE.settings.surveyInboxEmail||'')}" placeholder="adhocsupport@yourcompany.com"/>
      <button class="btn btn-secondary btn-sm" onclick="saveSurveyInboxEmail()">Save</button>
    </div>` : ''}
    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Task</th><th>Sales Org</th><th>Requestor</th><th>Category</th><th>Assigned To</th>
          <th>Est Hours</th><th>Due Date</th><th>Assignment</th><th>Status</th><th>Criticality</th><th>Survey</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${visibleTasks.length===0 ? `<tr><td colspan="12"><div class="empty-state"><p>${monthTasks.length===0 ? `No adhoc tasks in ${selectedMonthLabel()}` : 'No active tasks — all tasks this month are Completed'}</p></div></td></tr>` :
            visibleTasks.map(t=>{
              const emp = STATE.employees.find(e=>e.id===t.assignedTo);
              const survey = STATE.surveyResponses.find(r=>r.taskId===t.id);
              return `<tr>
                <td><div><strong>${t.name}</strong><div style="font-size:11px;color:var(--text3)">ID: ${t.taskId||t.id.slice(0,8)}</div></div></td>
                <td><span class="badge badge-teal">${t.salesOrg||'—'}</span></td>
                <td>${t.requestor||'—'}</td>
                <td><span class="badge badge-blue">${t.category||'—'}</span></td>
                <td>${emp ? `<div style="display:flex;align-items:center;gap:6px"><div class="avatar" style="width:24px;height:24px;font-size:9px">${initials(emp.name)}</div>${emp.name}</div>` : '<span style="color:var(--text3)">Unassigned</span>'}</td>
                <td style="font-weight:600">${t.acceptedHours||t.estHours}h${t.acceptedHours?'<div style="font-size:10px;color:var(--text3)">accepted</div>':''}</td>
                <td>${t.expectedEndDate||t.dueDate||'—'}</td>
                <td>${assignmentBadge(taskAssignmentLabel(t))}</td>
                <td><span class="badge ${statusBadge(t.status)}">${t.status}</span></td>
                <td><span class="badge ${critBadge(t.criticality)}">${t.criticality||'—'}</span></td>
                <td>${t.status!=='Completed' ? '<span style="color:var(--text3)">—</span>' : survey ? `<span class="survey-score-pill">★ ${survey.score}/100</span>` : '<span class="badge badge-amber">Pending</span>'}</td>
                <td><div style="display:flex;gap:6px;flex-wrap:wrap">
                  ${isMember() && isTaskPendingAcceptance(t) ? `<button class="btn btn-primary btn-sm" onclick="respondToAdhoc('${t.id}','Accepted')">Accept</button><button class="btn btn-danger btn-sm" onclick="respondToAdhoc('${t.id}','Rejected')">Reject</button>` : ''}
                  ${(!isMember() || t.selfCreated) ? `<button class="btn btn-secondary btn-sm" onclick="openAdhocModal('${t.id}')">Edit</button>` : ''}
                  ${!isTaskPendingAcceptance(t) && t.assignmentStatus !== 'Rejected' ? `<button class="btn btn-teal btn-sm" onclick="updateTaskStatus('${t.id}')">Status</button>` : ''}
                  ${t.status==='Completed' ? `<button class="btn btn-secondary btn-sm" onclick="sendSurveyEmailToOutlook('${t.id}')" title="Open a new Outlook email to the requestor with the click-to-reply survey copied to your clipboard">✉ Email</button>` : ''}
                  ${t.status==='Completed' ? `<button class="btn btn-secondary btn-sm" onclick="copySurveyToClipboard('${t.id}')" title="Re-copy the survey if it didn't paste in last time">⧉ Copy Survey</button>` : ''}
                  ${t.status==='Completed' ? `<button class="btn btn-primary btn-sm" onclick="openSurveyModal('${t.id}')">${survey ? '★ Update' : '★ Record'}</button>` : ''}
                  ${(!isMember() || t.selfCreated) ? `<button class="btn btn-danger btn-sm" onclick="deleteAdhoc('${t.id}')">✕</button>` : ''}
                </div></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table></div>
    </div>
  `;
}

function toggleShowCompletedAdhoc() {
  STATE.showCompletedAdhoc = document.getElementById('f-show-completed').checked;
  adhoc();
}

function statusBadge(s) {
  const map = {'Awaiting Acceptance':'badge-amber','Not Started':'badge-gray','In Progress':'badge-blue','Completed':'badge-green','Delayed':'badge-red','Cancelled':'badge-gray'};
  return map[s]||'badge-gray';
}
function critBadge(c) {
  const map = {'Data Pull':'badge-teal','Analysis Request':'badge-blue','Executive Request':'badge-red','Automation Enhancement':'badge-amber'};
  return map[c]||'badge-gray';
}

function onAssignedDateChange() {
  const asgdEl = document.getElementById('f-tasgd');
  const dueEl = document.getElementById('f-tdue');
  if(!asgdEl || !dueEl) return;
  dueEl.min = asgdEl.value || today();
  // If due date is now before the new assigned date, bump it up
  if(dueEl.value && dueEl.value < asgdEl.value) {
    dueEl.value = asgdEl.value;
  }
}

function openAdhocModal(id) {
  const task = id ? STATE.adhocTasks.find(t=>t.id===id) : null;
  if(isMember() && id && (!task || task.assignedTo!==myEmpId() || !task.selfCreated)) { toast('You can only edit tasks you created for yourself','error'); return; }
  const cats = ['Data Pull','Analysis Request','Executive Request','Automation Enhancement'];
  const statuses = ['Not Started','In Progress','Completed','Delayed','Cancelled'];
  openModal(isMember() ? (task?'Edit My Task':'Add Task for Myself') : (task?'Edit Adhoc Task':'Create Adhoc Task'), `
    <div class="form-grid">
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Task ID</label>
          <input class="form-control" id="f-tid" placeholder="ADH001" value="${escHtml(task?.taskId||'')}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Task Name *</label>
          <input class="form-control" id="f-tname" placeholder="Q3 Revenue Analysis" value="${escHtml(task?.name||'')}"/>
        </div>
      </div>
      <div class="form-grid form-grid-3">
        <div class="form-group">
          <label class="form-label">Sales Organization *</label>
          <select class="form-control" id="f-tsalesorg">
            <option value="">— Select Sales Organization —</option>
            ${SALES_ORGS.map(o=>`<option value="${o}" ${task?.salesOrg===o?'selected':''}>${o}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Requestor</label>
          <input class="form-control" id="f-treq" placeholder="Business Owner" value="${escHtml(task?.requestor||'')}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Category / Criticality *</label>
          <select class="form-control" id="f-tcat">
            ${cats.map(c=>`<option ${task?.category===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Requestor Email <span style="color:var(--text3);font-weight:400">(for completion survey)</span></label>
          <input class="form-control" id="f-tremail" type="email" placeholder="requestor@company.com" value="${escHtml(task?.requestorEmail||'')}"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-control" id="f-tdesc" placeholder="Task details…">${escHtml(task?.description||'')}</textarea>
      </div>
      <div class="form-grid form-grid-3">
        <div class="form-group">
          <label class="form-label">Estimated Hours *</label>
          <input class="form-control" id="f-thrs" type="number" min="0.5" step="0.5" value="${task?.estHours||2}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Assigned Date</label>
          <input class="form-control" id="f-tasgd" type="date" ${task ? 'disabled title="Assigned date is fixed once the task is created" style="background:#F3F4F6;color:#9CA3AF;cursor:not-allowed"' : `min="${today()}"`} value="${task?.assignedDate||today()}" onchange="onAssignedDateChange()"/>
        </div>
        <div class="form-group">
          <label class="form-label">Due Date</label>
          <input class="form-control" id="f-tdue" type="date" min="${task?.assignedDate||today()}" value="${task?.dueDate||''}"/>
        </div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Status</label>
          <select class="form-control" id="f-tstat">
            ${statuses.map(s=>`<option ${(task?.status||'Not Started')===s?'selected':''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Assign To *</label>
          ${isMember()
            ? `<input class="form-control" value="${STATE.employees.find(e=>e.id===myEmpId())?.name||''}" readonly style="background:var(--surface2);color:var(--text2)"/>
               <input type="hidden" id="f-tassign" value="${myEmpId()}"/>`
            : `<select class="form-control" id="f-tassign">
                <option value="">— Use Smart Assign —</option>
                ${(isManager()
                    ? STATE.employees.filter(e=>e.status==='active' && e.team===myTeam())
                    : STATE.employees.filter(e=>e.status==='active')
                  ).map(e=>`<option value="${e.id}" ${task?.assignedTo===e.id?'selected':''}>${e.name}</option>`).join('')}
               </select>`
          }
        </div>
      </div>
      ${STATE.skills.length > 0 ? `
      <div class="form-group">
        <label class="form-label">Required Skills <span style="color:var(--text3);font-weight:400">(used by Smart Assign)</span></label>
        <div style="margin-bottom:6px">
          <select class="form-control" id="task-skill-picker" onchange="addSkillToTask()" style="max-width:300px">
            <option value="">— Add required skill —</option>
            ${STATE.skills.map(s=>`<option value="${s.id}">${s.name}</option>`).join('')}
          </select>
        </div>
        <div class="skill-tags-wrap" id="task-skill-tags">
          ${(task?.requiredSkills||[]).map(sid=>{
            const sk=STATE.skills.find(s=>s.id===sid);
            return sk?`<span class="skill-tag">${sk.name}<span class="skill-tag-remove" onclick="removeSkillFromTask('${sid}')">×</span></span>`:'';
          }).join('')}
        </div>
        <input type="hidden" id="f-treq-skills" value="${JSON.stringify(task?.requiredSkills||[]).replace(/"/g,'&quot;')}"/>
      </div>` : ''}
      <div id="smart-recs"></div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    ...(!isMember() ? [{label:'Smart Assign', cls:'btn-teal', fn:'showSmartAssign()'}] : []),
    {label:task?'Save Changes':(isMember()?'Add Task':'Create Task'), cls:'btn-primary', fn:`saveAdhoc('${id||''}')`}
  ]);
}

function showSmartAssign() {
  const estHrs = parseFloat(document.getElementById('f-thrs').value)||2;
  const cat = document.getElementById('f-tcat').value;
  const dateStr = document.getElementById('f-tasgd').value||today();
  const reqSkillsEl = document.getElementById('f-treq-skills');
  const requiredSkillIds = reqSkillsEl ? JSON.parse(reqSkillsEl.value||'[]') : [];
  const recs = getSmartRecommendations(estHrs, cat, dateStr, requiredSkillIds);
  const el = document.getElementById('smart-recs');
  el.innerHTML = `<div class="divider"></div><div style="font-weight:600;font-size:13px;margin-bottom:10px">Smart Assignment Recommendations</div>
    ${recs.map((r,i)=>`
      <div class="rec-card" onclick="selectRec('${r.emp.id}',this)">
        <div class="rec-rank ${i===1?'r2':i===2?'r3':''}">${i+1}</div>
        <div class="avatar">${initials(r.emp.name)}</div>
        <div style="flex:1">
          <div style="font-weight:600">${r.emp.name}</div>
          <div style="font-size:11px;color:var(--text3)">${r.emp.designation||'—'} · ${r.emp.team||'—'}</div>
          <div style="display:flex;gap:8px;margin-top:4px;flex-wrap:wrap">
            <span class="badge badge-blue" style="font-size:10px">BW: ${r.bwScore}%</span>
            <span class="badge badge-teal" style="font-size:10px">Exp: ${r.expScore}%</span>
            <span class="badge badge-green" style="font-size:10px">Qual: ${r.qualScore}%</span>
            ${requiredSkillIds.length>0 ? `<span class="badge ${r.skillScore===100?'badge-green':r.skillScore>0?'badge-amber':'badge-red'}" style="font-size:10px">Skills: ${r.skillScore}%</span>` : ''}
          </div>
          ${r.matchedSkills.length>0 ? `<div style="margin-top:5px;display:flex;flex-wrap:wrap;gap:3px">${r.matchedSkills.map(sk=>`<span class="skill-tag" style="font-size:10px;padding:1px 6px">✓ ${sk}</span>`).join('')}</div>` : ''}
        </div>
        <div style="font-size:17px;font-weight:800;color:var(--primary)">${r.total}%</div>
      </div>
    `).join('')}`;
}

function getSmartRecommendations(estHrs, category, dateStr, requiredSkillIds=[]) {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const activeEmps = STATE.employees.filter(e=>e.status==='active');
  return activeEmps.map(e=>{
    const bw = getEmployeeBandwidth(e.id, dateStr);
    const bwScore = Math.round(Math.max(0, (bw.available / (e.loginHours||8)) * 100));
    // Experience: count similar tasks completed
    const similarDone = STATE.adhocTasks.filter(t=>t.assignedTo===e.id&&t.category===category&&t.status==='Completed').length;
    const expScore = Math.min(100, similarDone*20);
    // Quality
    const qualScore = getQualityScore(e.id,y,m);
    // Workload balance: lower is better
    const wlScore = Math.max(0, 100-bw.pct);
    // Skills match score
    let skillScore = 0;
    if(requiredSkillIds.length > 0) {
      const empSkills = e.skills || [];
      const matched = requiredSkillIds.filter(sid=>empSkills.includes(sid)).length;
      skillScore = Math.round((matched / requiredSkillIds.length) * 100);
    }
    // Composite: skills present → 30% BW + 20% Exp + 15% Qual + 10% WL + 25% Skills
    //            no skills req  → 40% BW + 25% Exp + 20% Qual + 15% WL (original)
    const total = requiredSkillIds.length > 0
      ? Math.round(bwScore*.30 + expScore*.20 + qualScore*.15 + wlScore*.10 + skillScore*.25)
      : Math.round(bwScore*.40 + expScore*.25 + qualScore*.20 + wlScore*.15);
    const matchedSkills = requiredSkillIds.length > 0
      ? requiredSkillIds.filter(sid=>(e.skills||[]).includes(sid)).map(sid=>STATE.skills.find(s=>s.id===sid)?.name).filter(Boolean)
      : [];
    return {emp:e, bwScore, expScore, qualScore:Math.round(qualScore), wlScore, skillScore, matchedSkills, total};
  }).sort((a,b)=>b.total-a.total).slice(0,3);
}

function addSkillToTask() {
  const picker = document.getElementById('task-skill-picker');
  const sid = picker.value;
  if(!sid) return;
  const hidden = document.getElementById('f-treq-skills');
  let current = JSON.parse(hidden.value||'[]');
  if(current.includes(sid)) { picker.value=''; return; }
  current.push(sid);
  hidden.value = JSON.stringify(current);
  const sk = STATE.skills.find(s=>s.id===sid);
  if(sk) {
    const wrap = document.getElementById('task-skill-tags');
    const tag = document.createElement('span');
    tag.className='skill-tag';
    tag.innerHTML=`${sk.name}<span class="skill-tag-remove" onclick="removeSkillFromTask('${sid}')">×</span>`;
    wrap.appendChild(tag);
  }
  picker.value='';
}

function removeSkillFromTask(sid) {
  const hidden = document.getElementById('f-treq-skills');
  let current = JSON.parse(hidden.value||'[]');
  current = current.filter(s=>s!==sid);
  hidden.value = JSON.stringify(current);
  const wrap = document.getElementById('task-skill-tags');
  if(wrap) {
    wrap.querySelectorAll('.skill-tag').forEach(el=>{
      if(el.querySelector('.skill-tag-remove')?.getAttribute('onclick')?.includes(sid)) el.remove();
    });
  }
}

function selectRec(empId, el) {
  document.querySelectorAll('.rec-card').forEach(c=>c.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('f-tassign').value = empId;
}

async function saveAdhoc(id) {
  if(isMember()) {
    if(id) {
      const existing = STATE.adhocTasks.find(t=>t.id===id);
      if(!existing || existing.assignedTo !== myEmpId() || !existing.selfCreated) { toast('You can only edit tasks you created for yourself','error'); return; }
    }
  }
  const reqSkillsEl = document.getElementById('f-treq-skills');
  const fields = {
    taskId:         document.getElementById('f-tid').value.trim(),
    name:           document.getElementById('f-tname').value.trim(),
    salesOrg:       document.getElementById('f-tsalesorg').value,
    requestor:      document.getElementById('f-treq').value.trim(),
    requestorEmail: document.getElementById('f-tremail').value.trim(),
    category:       document.getElementById('f-tcat').value,
    description:    document.getElementById('f-tdesc').value.trim(),
    estHours:       parseFloat(document.getElementById('f-thrs').value)||2,
    assignedDate:   document.getElementById('f-tasgd').value,
    dueDate:        document.getElementById('f-tdue').value,
    status:         document.getElementById('f-tstat').value,
    assignedTo:     isMember() ? myEmpId() : document.getElementById('f-tassign').value,
    assignmentStatus: isMember() ? 'Accepted' : (id ? (STATE.adhocTasks.find(t=>t.id===id)?.assignmentStatus || 'Accepted') : 'Pending Acceptance'),
    assignedById:   isMember() ? (STATE.adhocTasks.find(t=>t.id===id)?.assignedById||'') : myEmpId(),
    assignedByName: isMember() ? (STATE.adhocTasks.find(t=>t.id===id)?.assignedByName||'') : (STATE.currentUser?.name||''),
    criticality:    document.getElementById('f-tcat').value,
    requiredSkills: reqSkillsEl ? JSON.parse(reqSkillsEl.value||'[]') : [],
    year:           STATE.currentYear,
    month:          STATE.currentMonth
  };
  if(!fields.name) { toast('Task name required','error'); return; }
  if(!fields.salesOrg) { toast('Sales Organization is required','error'); return; }
  if(!fields.assignedTo) { toast('Please assign the task to an employee','error'); return; }
  const todayStr = today();
  // Assigned date is locked on edit, so only validate it for new tasks
  if(!id && fields.assignedDate && fields.assignedDate < todayStr) {
    toast('Assigned date cannot be in the past', 'error');
    return;
  }
  if(fields.dueDate && fields.assignedDate && fields.dueDate < fields.assignedDate) {
    toast('Due date cannot be before the assigned date', 'error');
    return;
  }
  // Admin/manager assigning a task to THEMSELVES: nobody else needs to accept it,
  // so it is accepted automatically (no "Awaiting Acceptance" step).
  const selfAssignedByLead = !isMember() && !!myEmpId() && fields.assignedTo === myEmpId();
  if(selfAssignedByLead) {
    fields.assignmentStatus = 'Accepted';
    const prev = id ? STATE.adhocTasks.find(t=>t.id===id) : null;   // keep a start date already recorded on edit
    fields.acceptedHours    = fields.estHours;
    fields.startDate        = prev?.startDate || fields.assignedDate || today();
    fields.expectedEndDate  = fields.dueDate || fields.startDate;
  }
  let justCompletedId = null;
  if(id) {
    const idx=STATE.adhocTasks.findIndex(t=>t.id===id);
    if(idx>-1) {
      const wasCompleted = STATE.adhocTasks[idx].status === 'Completed';
      STATE.adhocTasks[idx]={...STATE.adhocTasks[idx],...fields};
      const nowCompleted = STATE.adhocTasks[idx].status === 'Completed';
      if(nowCompleted && !wasCompleted) justCompletedId = STATE.adhocTasks[idx].id;
    }
  } else {
    const newTask = {...fields, id:uid(), createdAt:today(), status: (isMember() || selfAssignedByLead) ? fields.status : 'Awaiting Acceptance', assignmentStatus: (isMember() || selfAssignedByLead) ? 'Accepted' : 'Pending Acceptance', selfCreated: isMember(), responseAt:null, responseComment:''};
    STATE.adhocTasks.push(newTask);
    if(newTask.status === 'Completed') justCompletedId = newTask.id;
  }
  closeModal(); adhoc();
  const saved = await save();
  if(!saved) {
    toast('Task is NOT saved to the server yet. Do not close or refresh this page — check your connection and try again.', 'error', 10000);
    return;
  }
  toast(id ? 'Task updated' : 'Task created','success');
  if(justCompletedId) {
    sendSurveyEmailToOutlook(justCompletedId);
  }
}

function respondToAdhoc(id, decision) {
  const idx = STATE.adhocTasks.findIndex(t=>t.id===id);
  if(idx < 0) return;
  const task = STATE.adhocTasks[idx];
  if(task.assignedTo !== myEmpId() || !isMember()) { toast('Only the assigned employee can respond to this request','error'); return; }
  if(!isTaskPendingAcceptance(task)) { toast('This assignment has already been responded to','info'); return; }

  if(decision === 'Rejected') {
    const comment = prompt('Optional reason for rejecting this task:','');
    if(comment === null) return;
    task.assignmentStatus = 'Rejected';
    task.responseAt = new Date().toISOString();
    task.responseComment = comment || '';
    task.status = 'Rejected';
    save();
    toast('Task rejected — your manager has been updated','info');
    dashboard();
    return;
  }

  // Acceptance requires the employee to commit to the expected effort and dates.
  openModal('Accept Ad Hoc Task', `
    <div style="margin-bottom:14px;padding:12px;border-radius:8px;background:var(--surface2);font-size:12px;color:var(--text2)">
      <strong>${escHtml(task.name)}</strong><br/>
      ${escHtml(task.salesOrg||'')} · Manager estimate: ${task.estHours||0}h
    </div>
    <div class="form-grid form-grid-3">
      <div class="form-group">
        <label class="form-label">Expected Hours *</label>
        <input class="form-control" id="f-accept-hours" type="number" min="0.5" step="0.5" value="${task.acceptedHours||task.estHours||2}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Start Date *</label>
        <input class="form-control" id="f-accept-start" type="date" min="${today()}" value="${task.startDate||task.assignedDate||today()}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Expected End Date *</label>
        <input class="form-control" id="f-accept-end" type="date" min="${task.startDate||task.assignedDate||today()}" value="${task.expectedEndDate||task.dueDate||task.startDate||task.assignedDate||today()}"/>
      </div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Note to Manager <span style="color:var(--text3);font-weight:400">(optional)</span></label>
      <textarea class="form-control" id="f-accept-comment" placeholder="Add any context about your planned completion…">${escHtml(task.responseComment||'')}</textarea>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Accept & Start Task', cls:'btn-primary', fn:`confirmAdhocAcceptance('${id}')`}
  ]);
}

async function confirmAdhocAcceptance(id) {
  const idx = STATE.adhocTasks.findIndex(t=>t.id===id);
  if(idx < 0) return;
  const task = STATE.adhocTasks[idx];
  if(task.assignedTo !== myEmpId() || !isMember()) { toast('Only the assigned employee can accept this request','error'); return; }
  if(!isTaskPendingAcceptance(task)) { toast('This assignment has already been responded to','info'); closeModal(); return; }

  const hours = parseFloat(document.getElementById('f-accept-hours')?.value)||0;
  const startDate = document.getElementById('f-accept-start')?.value||'';
  const endDate = document.getElementById('f-accept-end')?.value||'';
  const comment = document.getElementById('f-accept-comment')?.value.trim()||'';
  const todayStr = today();

  if(hours <= 0) { toast('Expected hours must be greater than 0','error'); return; }
  if(!startDate || !endDate) { toast('Start date and expected end date are required','error'); return; }
  if(startDate < todayStr) { toast('Start date cannot be in the past','error'); return; }
  if(endDate < startDate) { toast('Expected end date cannot be before the start date','error'); return; }

  task.assignmentStatus = 'Accepted';
  task.responseAt = new Date().toISOString();
  task.responseComment = comment;
  task.acceptedHours = hours;
  task.startDate = startDate;
  task.expectedEndDate = endDate;
  task.status = 'In Progress';

  // Wait for the acceptance to actually be persisted BEFORE doing anything
  // navigation-risky (the mailto: below). Firing that navigation while the
  // Supabase write is still in flight risks interrupting it in some
  // browsers, so the status change never lands in the database even though
  // it briefly looked accepted on screen.
  await save();

  closeModal();
  toast('Task accepted and moved to In Progress — your manager has been updated','success');
  notifyRequestorOfAcceptance(task);
  dashboard();
}

// ═══════════════════════════════════════════════════════════
// IN-APP NOTIFICATIONS — lightweight activity log, shared via
// Supabase like everything else in STATE, so any signed-in user
// (not just the tab that triggered it) sees the same history.
// ═══════════════════════════════════════════════════════════
function addNotification({ type, title, message, taskId, forEmpId }) {
  STATE.notifications.unshift({
    id: uid(),
    type,
    title,
    message,
    taskId: taskId || null,
    forEmpId: forEmpId || null,   // when set, only that employee sees it
    read: false,
    createdAt: new Date().toISOString()
  });
  // Cap so this collection doesn't grow unbounded — this is an activity
  // feed, not a permanent audit log.
  if(STATE.notifications.length > 200) STATE.notifications.length = 200;
  save();
  updateNotificationBadge();
}

// Notifications addressed to one employee (forEmpId) are visible only to them;
// everything else stays visible to everyone, as before.
function notificationVisible(n) { return !n.forEmpId || n.forEmpId === myEmpId(); }
function visibleNotifications() { return STATE.notifications.filter(notificationVisible); }

function updateNotificationBadge() {
  const el = document.getElementById('notif-badge');
  if(!el) return;
  const unread = visibleNotifications().filter(n=>!n.read).length;
  if(unread > 0) {
    el.textContent = unread > 99 ? '99+' : String(unread);
    el.style.display = 'flex';
  } else {
    el.style.display = 'none';
  }
}

function notificationTimeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs/60000);
  if(mins < 1) return 'just now';
  if(mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins/60);
  if(hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs/24)}d ago`;
}

function openNotificationsPanel() {
  const items = visibleNotifications().slice(0,50);
  const body = items.length ? `
    <div style="display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto">
      ${items.map(n => `
        <div style="padding:10px 12px;border-radius:8px;background:${n.read?'var(--surface2)':'#EEF2FF'};border:1px solid ${n.read?'var(--border)':'#C7D2FE'}">
          <div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">
            <strong style="font-size:13px">${escHtml(n.title)}</strong>
            <span style="font-size:11px;color:var(--text3);white-space:nowrap">${notificationTimeAgo(n.createdAt)}</span>
          </div>
          <div style="font-size:12px;color:var(--text2);margin-top:3px">${escHtml(n.message)}</div>
        </div>
      `).join('')}
    </div>
  ` : `<div class="empty-state"><p>No notifications yet</p></div>`;

  openModal('Notifications', body, [
    {label:'Close', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Mark all read', cls:'btn-primary', fn:'markAllNotificationsRead()'}
  ]);
  // Opening the panel is treated as "seen" — clear the unread badge but
  // leave items visually distinct (still tinted above) until explicitly
  // marked read, so nothing is lost if the user just glances and closes.
  markAllNotificationsRead({ silent:true });
}

function markAllNotificationsRead(opts) {
  const silent = opts && opts.silent;
  visibleNotifications().forEach(n=>{ n.read = true; });
  save();
  updateNotificationBadge();
  if(!silent) { toast('All notifications marked read','success'); closeModal(); }
}

// Emails the requestor (task.requestorEmail, entered at task creation) the
// moment an employee accepts the assignment, and logs the outcome to the
// in-app notification feed above — the requestor themselves isn't a
// PWMS user, so the feed is the confirmation trail for managers/admins
// that the requestor was (or wasn't) actually informed.
function notifyRequestorOfAcceptance(task) {
  const emp = STATE.employees.find(e=>e.id===task.assignedTo);
  const empName = emp?.name || 'The assigned employee';
  const taskRef = `${task.name} [${task.taskId || task.id.slice(0,8)}]`;

  if(!task.requestorEmail) {
    addNotification({
      type: 'requestor_email_skipped',
      title: 'Requestor not emailed',
      message: `${empName} accepted "${taskRef}", but no requestor email is on file for this task — add one to notify them automatically next time.`,
      taskId: task.id
    });
    return;
  }

  const subject = `Your request has been accepted: ${task.name}`;
  const body = `Hi ${task.requestor || 'there'},\n\n`
    + `Good news — your request "${task.name}" has been accepted by ${empName} and is now in progress.\n\n`
    + `Expected effort: ${task.acceptedHours}h\n`
    + `Start date: ${task.startDate}\n`
    + `Expected completion: ${task.expectedEndDate}\n`
    + (task.responseComment ? `\nNote from ${empName}: ${task.responseComment}\n` : '')
    + `\nWe'll follow up once the work is complete.`;
  const mailtoLink = `mailto:${task.requestorEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailtoLink;

  addNotification({
    type: 'requestor_email_sent',
    title: 'Requestor notified',
    message: `${empName} accepted "${taskRef}" — an email to ${task.requestorEmail} was opened in Outlook.`,
    taskId: task.id
  });
}

function updateTaskStatus(id) {
  const task = STATE.adhocTasks.find(t=>t.id===id);
  if(!task) return;
  if(isTaskPendingAcceptance(task)) { toast('This task is awaiting employee acceptance','info'); return; }
  if(taskAssignmentLabel(task)==='Rejected') { toast('Rejected assignments cannot be updated','info'); return; }
  const statuses = ['Not Started','In Progress','Completed','Delayed','Cancelled'];
  openModal('Update Task Status', `
    <div class="form-group">
      <label class="form-label">Task: <strong>${task.name}</strong></label>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">New Status</label>
      <select class="form-control" id="f-ustat">
        ${statuses.map(s=>`<option ${task.status===s?'selected':''}>${s}</option>`).join('')}
      </select>
    </div>
    <div class="form-grid form-grid-2" style="margin-top:12px">
      <div class="form-group">
        <label class="form-label">Start Date</label>
        <input class="form-control" type="date" id="f-ustart" value="${task.startDate||''}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Completion Date</label>
        <input class="form-control" type="date" id="f-ucomplete" value="${task.completionDate||''}"/>
      </div>
    </div>
    <div class="form-group" style="margin-top:12px">
      <label class="form-label">Actual Hours</label>
      <input class="form-control" type="number" id="f-uactual" step="0.5" value="${task.actualHours||task.estHours}"/>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Update', cls:'btn-primary', fn:`saveTaskStatus('${id}')`}
  ]);
}

function saveTaskStatus(id) {
  const idx=STATE.adhocTasks.findIndex(t=>t.id===id);
  if(idx>-1 && taskAssignmentLabel(STATE.adhocTasks[idx]) !== 'Accepted') { toast('Task must be accepted before status can be updated','error'); return; }
  if(idx>-1) {
    const wasCompleted = STATE.adhocTasks[idx].status === 'Completed';
    STATE.adhocTasks[idx].status = document.getElementById('f-ustat').value;
    STATE.adhocTasks[idx].startDate = document.getElementById('f-ustart').value;
    STATE.adhocTasks[idx].completionDate = document.getElementById('f-ucomplete').value;
    STATE.adhocTasks[idx].actualHours = parseFloat(document.getElementById('f-uactual').value)||0;
    const nowCompleted = STATE.adhocTasks[idx].status === 'Completed';
    save(); closeModal(); toast('Status updated','success'); adhoc();
    if(nowCompleted && !wasCompleted) {
      sendSurveyEmailToOutlook(STATE.adhocTasks[idx].id);
    }
    return;
  }
  save(); closeModal(); toast('Status updated','success'); adhoc();
}

function saveSurveyInboxEmail() {
  const val = document.getElementById('f-surveyinbox').value.trim();
  if(!val) { toast('Enter an inbox email address', 'error'); return; }
  STATE.settings.surveyInboxEmail = val;
  save();
  toast('Survey reply inbox updated', 'success');
}

// ═══════════════════════════════════════════════════════════
// POST-COMPLETION SURVEY — click-to-reply HTML email
// (Outlook strips <script> from messages, so true in-email JS
// capture isn't possible. Each rating is instead its own mailto
// link — one click sends a ready-made reply with that answer,
// so the requestor only has to hit Send, never type a rating.)
// ═══════════════════════════════════════════════════════════
function buildAnswerMailto(task, qLabel, answer) {
  const inbox = STATE.settings.surveyInboxEmail || 'adhocsupport@yourcompany.com';
  const taskRef = `${task.name} [${task.taskId||task.id.slice(0,8)}]`;
  const subject = `Survey Response — ${taskRef} — ${qLabel}: ${answer}`;
  const body = `Task: ${taskRef}\nQuestion: ${qLabel}\nAnswer: ${answer}\n\n(This reply was pre-filled by clicking in the survey email — just hit Send.)`;
  return `mailto:${inbox}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildSurveyEmailHtml(task) {
  const satLinks = [1,2,3,4,5].map(n=>
    `<td align="center" bgcolor="#0B4EA2" style="border-radius:6px;padding:0;"><a href="${buildAnswerMailto(task,'Satisfaction',n)}" style="display:block;width:36px;padding:10px 0;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;font-size:15px;">${n}</a></td><td width="8"></td>`
  ).join('');
  const timeLinks = ['Yes','No'].map(v=>
    `<td align="center" bgcolor="${v==='Yes'?'#22C55E':'#EF4444'}" style="border-radius:6px;padding:0;"><a href="${buildAnswerMailto(task,'On-Time Delivery',v)}" style="display:block;padding:10px 22px;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;font-size:15px;">${v}</a></td><td width="8"></td>`
  ).join('');
  const qualLinks = [1,2,3,4,5].map(n=>
    `<td align="center" bgcolor="#F59E0B" style="border-radius:6px;padding:0;"><a href="${buildAnswerMailto(task,'Quality',n)}" style="display:block;width:36px;padding:10px 0;color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-weight:bold;font-size:15px;">${n}</a></td><td width="8"></td>`
  ).join('');
  const commentMailto = buildAnswerMailto(task, 'Comments', '(type your comment here)');

  return `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="font-family:Arial,sans-serif;max-width:600px;border:1px solid #E5E7EB;border-radius:10px;overflow:hidden;">
  <tr><td style="background:#111827;padding:20px 24px;"><span style="color:#ffffff;font-size:17px;font-weight:bold;">How did we do?</span></td></tr>
  <tr><td style="padding:22px 24px 6px;">
    <p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0 0 4px;">Hi ${escHtml(task.requestor||'there')},</p>
    <p style="font-family:Arial,sans-serif;font-size:14px;color:#374151;margin:0 0 18px;">Your request "${escHtml(task.name)}" was just completed. Just click your answer below — no typing needed.</p>
  </td></tr>
  <tr><td style="padding:0 24px 6px;"><p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0 0 8px;font-weight:bold;">1. How satisfied are you with the overall support?</p></td></tr>
  <tr><td style="padding:0 24px 4px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${satLinks}</tr></table>
    <p style="font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;margin:6px 0 0;">1 = Very Unsatisfied &nbsp;·&nbsp; 5 = Very Satisfied</p>
  </td></tr>
  <tr><td style="padding:20px 24px 6px;"><p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0 0 8px;font-weight:bold;">2. Was the request delivered within the expected timeline?</p></td></tr>
  <tr><td style="padding:0 24px 4px;"><table role="presentation" cellpadding="0" cellspacing="0"><tr>${timeLinks}</tr></table></td></tr>
  <tr><td style="padding:20px 24px 6px;"><p style="font-family:Arial,sans-serif;font-size:14px;color:#111827;margin:0 0 8px;font-weight:bold;">3. Quality, accuracy &amp; completeness of the deliverable?</p></td></tr>
  <tr><td style="padding:0 24px 4px;">
    <table role="presentation" cellpadding="0" cellspacing="0"><tr>${qualLinks}</tr></table>
    <p style="font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;margin:6px 0 0;">1 = Poor &nbsp;·&nbsp; 5 = Excellent</p>
  </td></tr>
  <tr><td style="padding:22px 24px 24px;"><p style="font-family:Arial,sans-serif;font-size:13px;color:#374151;margin:0;">Have a suggestion for next time? <a href="${commentMailto}" style="color:#0B4EA2;">Click here to send a quick comment</a>.</p></td></tr>
  <tr><td style="background:#F9FAFB;padding:14px 24px;border-top:1px solid #E5E7EB;"><p style="font-family:Arial,sans-serif;font-size:11px;color:#9CA3AF;margin:0;">Thanks for helping us improve our ad-hoc request support!</p></td></tr>
</table>`;
}

// Copies the click-to-reply HTML survey to the clipboard and reports whether
// it actually succeeded. Split out from sendSurveyEmailToOutlook() so it can
// also be used as a manual "Copy Survey" retry button if the first copy
// silently failed (e.g. clipboard permission blocked) or got overwritten
// before the user pasted it.
async function copySurveyToClipboard(taskId, { silent } = {}) {
  const task = STATE.adhocTasks.find(t=>t.id===taskId);
  if(!task) return false;
  const html = buildSurveyEmailHtml(task);
  const plain = `How did we do?\n\n1. How satisfied are you with the overall support (1-5)?\n2. Was it delivered within the expected timeline (Yes/No)?\n3. How would you rate quality, accuracy & completeness (1-5)?\n4. What could we do better for future requests?`;
  try {
    if(!navigator.clipboard || !window.ClipboardItem) throw new Error('Clipboard API unavailable');
    const item = new ClipboardItem({
      'text/html': new Blob([html], {type:'text/html'}),
      'text/plain': new Blob([plain], {type:'text/plain'})
    });
    // Awaited (not fire-and-forget) so callers know the copy actually landed
    // before doing anything that assumes it did (e.g. opening Outlook).
    await navigator.clipboard.write([item]);
    if(!silent) toast('✓ Survey copied — press Ctrl+V in Outlook, then Send', 'success');
    return true;
  } catch(e) {
    console.warn('[SURVEY] Clipboard copy failed:', e);
    if(!silent) toast('Copy failed — your browser may be blocking clipboard access. Try the "Copy Survey" button again, or allow clipboard permission for this site.', 'error');
    return false;
  }
}

async function sendSurveyEmailToOutlook(taskId) {
  const task = STATE.adhocTasks.find(t=>t.id===taskId);
  if(!task) return;
  if(!task.requestorEmail) {
    toast('Add a Requestor Email on this task first so I know who to send the survey to', 'info');
    return;
  }

  // Wait for the copy to actually finish (or fail) before opening Outlook —
  // previously this fired the clipboard write and the mailto: navigation at
  // the same time, so on a slow/first write the clipboard could still be
  // empty by the time the user hit Ctrl+V.
  const copied = await copySurveyToClipboard(taskId, { silent: true });

  const subject = `Feedback Request: ${task.name} — Ad-hoc Support Survey`;
  const body = copied
    ? `(Your one-click survey is on your clipboard — press Ctrl+V right here to paste it in, then hit Send.)`
    : `(Auto-copy didn't go through — click the "Copy Survey" button next to this task, then paste it here with Ctrl+V before sending.)`;
  const mailtoLink = `mailto:${task.requestorEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.location.href = mailtoLink;

  if(copied) {
    toast(`✓ Copied — Outlook opening for ${task.requestorEmail}. Press Ctrl+V, then Send.`, 'success');
  } else {
    toast(`Outlook opening for ${task.requestorEmail}, but the auto-copy failed — use "Copy Survey" to retry, then paste manually`, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// SURVEY RESPONSE RECORDING (click-based, entered in-app by the
// assigned employee/manager after getting the requestor's feedback)
// ═══════════════════════════════════════════════════════════
function openSurveyModal(taskId) {
  const task = STATE.adhocTasks.find(t=>t.id===taskId);
  if(!task) return;
  const existing = STATE.surveyResponses.find(r=>r.taskId===taskId);

  const body = `
    <div class="form-group" style="margin-bottom:16px">
      <div style="font-size:13px;color:var(--text3)">Task</div>
      <div style="font-weight:700">${escHtml(task.name)}</div>
      ${task.requestor ? `<div style="font-size:12.5px;color:var(--text3)">Requestor: ${escHtml(task.requestor)}</div>` : ''}
    </div>

    <div class="form-group">
      <label class="form-label">1. How satisfied were they with the overall ad-hoc request support?</label>
      <div class="survey-scale" id="sv-sat" data-value="${existing?.satisfaction||''}">
        ${[1,2,3,4,5].map(n=>`<button type="button" class="survey-btn ${existing?.satisfaction===n?'selected':''}" data-val="${n}" onclick="pickSurveyValue('sv-sat',${n})">${n}</button>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:4px">1 = Very Unsatisfied · 5 = Very Satisfied</div>
    </div>

    <div class="form-group" style="margin-top:16px">
      <label class="form-label">2. Was the request delivered within the expected timeline?</label>
      <div class="survey-scale" id="sv-time" data-value="${existing? (existing.onTime?'yes':'no') : ''}">
        <button type="button" class="survey-btn ${existing?.onTime===true?'selected':''}" data-val="yes" onclick="pickSurveyValue('sv-time','yes')">Yes</button>
        <button type="button" class="survey-btn ${existing?.onTime===false?'selected':''}" data-val="no" onclick="pickSurveyValue('sv-time','no')">No</button>
      </div>
    </div>

    <div class="form-group" style="margin-top:16px">
      <label class="form-label">3. Quality, accuracy & completeness of the deliverable?</label>
      <div class="survey-scale" id="sv-qual" data-value="${existing?.quality||''}">
        ${[1,2,3,4,5].map(n=>`<button type="button" class="survey-btn ${existing?.quality===n?'selected':''}" data-val="${n}" onclick="pickSurveyValue('sv-qual',${n})">${n}</button>`).join('')}
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:4px">1 = Poor · 5 = Excellent</div>
    </div>

    <div class="form-group" style="margin-top:16px">
      <label class="form-label">4. What could we do better for future requests? <span style="color:var(--text3);font-weight:400">(optional)</span></label>
      <textarea class="form-control" id="f-svcomment" rows="3" placeholder="Notes from the requestor…">${escHtml(existing?.comments||'')}</textarea>
    </div>
  `;

  openModal('Record Feedback Survey', body, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label: existing ? 'Update Response' : 'Save Response', cls:'btn-primary', fn:`saveSurveyResponse('${taskId}')`}
  ]);
}

function pickSurveyValue(groupId, val) {
  const group = document.getElementById(groupId);
  group.dataset.value = val;
  Array.from(group.children).forEach(btn=>{
    btn.classList.toggle('selected', String(btn.dataset.val)===String(val));
  });
}

// Maps a 0-100 survey score to Quality Review fields, so a requestor's
// feedback shows up in Quality Management the same way a manually-logged
// review would. Uses the same 80/60 cutoffs as the score color-coding
// elsewhere in the app (green/amber/red) — change here if auto-generated
// reviews should use different thresholds than the score display does.
function surveyScoreToQualityFields(score, onTime) {
  const result   = score >= 80 ? 'Passed' : score >= 60 ? 'Rework Required' : 'Failed';
  const severity = score >= 80 ? ''       : score >= 60 ? 'Low'             : score >= 40 ? 'Medium' : 'High';
  return { result, severity, lateDelivery: !onTime };
}

function saveSurveyResponse(taskId) {
  const task = STATE.adhocTasks.find(t=>t.id===taskId);
  if(!task) return;

  const satVal  = document.getElementById('sv-sat').dataset.value;
  const timeVal = document.getElementById('sv-time').dataset.value;
  const qualVal = document.getElementById('sv-qual').dataset.value;

  if(!satVal || !timeVal || !qualVal) {
    toast('Please click an answer for all 3 rating questions', 'error');
    return;
  }

  const satisfaction = parseInt(satVal);
  const quality = parseInt(qualVal);
  const onTime = timeVal === 'yes';
  const comments = document.getElementById('f-svcomment').value.trim();

  // Normalize each answer to 0-100, then average for the survey score
  const score = Math.round(((satisfaction/5*100) + (onTime?100:0) + (quality/5*100)) / 3);

  const existingIdx = STATE.surveyResponses.findIndex(r=>r.taskId===taskId);
  const record = {
    id: existingIdx>-1 ? STATE.surveyResponses[existingIdx].id : uid(),
    taskId,
    employeeId: task.assignedTo,
    satisfaction, onTime, quality, comments, score,
    year: task.year, month: task.month,
    recordedAt: today()
  };
  if(existingIdx>-1) STATE.surveyResponses[existingIdx] = record;
  else STATE.surveyResponses.push(record);

  // Also log this as a Quality Review so it's visible in Quality Management,
  // not just folded silently into the score. Matched on
  // (linkedTaskId + source:'survey') so re-recording the same task's survey
  // updates that one entry instead of piling up duplicates each time.
  const qFields = surveyScoreToQualityFields(score, onTime);
  const qIdx = STATE.qualityReviews.findIndex(r=>r.linkedTaskId===taskId && r.source==='survey');
  const qReview = {
    id: qIdx>-1 ? STATE.qualityReviews[qIdx].id : uid(),
    employeeId: task.assignedTo,
    taskName: task.name,
    linkedTaskId: taskId,
    linkedReportId: null,
    result: qFields.result,
    severity: qFields.severity,
    errorCount: qIdx>-1 ? (STATE.qualityReviews[qIdx].errorCount||0) : 0,
    lateDelivery: qFields.lateDelivery,
    reviewDate: today(),
    year: task.year, month: task.month,
    source: 'survey' // marks this as auto-generated from a requestor survey rather than entered manually
  };
  if(qIdx>-1) STATE.qualityReviews[qIdx] = qReview;
  else STATE.qualityReviews.push(qReview);

  save(); closeModal();
  toast(`Survey recorded — average score ${score}/100`, 'success');
  adhoc();
}

function deleteAdhoc(id) {
  if(isMember()) {
    const existing = STATE.adhocTasks.find(t=>t.id===id);
    if(!existing || existing.assignedTo !== myEmpId() || !existing.selfCreated) { toast('You can only delete tasks you created for yourself','error'); return; }
  }
  STATE.adhocTasks = STATE.adhocTasks.filter(t=>t.id!==id);
  save(); toast('Task deleted','info'); adhoc();
}

// ═══════════════════════════════════════════════════════════
// PAGE: ASSIGNMENTS
// ═══════════════════════════════════════════════════════════
function assignments() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Report Assignments</h2>
      <button class="btn btn-primary" onclick="openAssignModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Assign Report
      </button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px">
      ${visibleEmployees().filter(e=>e.status==='active').map(e=>{
        const myReps = STATE.assignments.filter(a=>a.employeeId===e.id);
        const totalHrs = myReps.reduce((s,a)=>{
          const r = STATE.regularReports.find(rep=>rep.id===a.reportId);
          return s+(r?parseFloat(r.estHours):0);
        },0);
        const capacity = parseFloat(e.loginHours)||8;
        const bw = getEmployeeBandwidth(e.id, today());
        return `<div class="card">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
            <div class="avatar">${initials(e.name)}</div>
            <div style="flex:1">
              <div style="font-weight:700">${e.name}</div>
              <div style="font-size:12px;color:var(--text3)">${e.team||'—'}</div>
            </div>
            <span class="badge badge-blue">${myReps.length} reports</span>
          </div>

          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px">
            <span style="color:var(--text3)">Regular Report Hours</span>
            <strong>${totalHrs.toFixed(1)}h / ${capacity}h</strong>
          </div>
          <div class="progress-bar" style="margin-bottom:12px">
            <div class="progress-fill ${utilColor(Math.round(totalHrs/capacity*100))}" style="width:${Math.min(100,Math.round(totalHrs/capacity*100))}%"></div>
          </div>

          ${myReps.map(a=>{
            const r = STATE.regularReports.find(rep=>rep.id===a.reportId);
            return r ? `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
              <span>${r.name}</span>
              <div style="display:flex;align-items:center;gap:8px">
                <span style="color:var(--text3)">${r.estHours}h</span>
                <button class="btn btn-danger btn-sm" style="padding:2px 7px;font-size:11px" onclick="removeAssignment('${a.id}')">✕</button>
              </div>
            </div>` : '';
          }).join('')}

          <button class="btn btn-secondary btn-sm" style="margin-top:10px;width:100%" onclick="openAssignModal('${e.id}')">+ Assign Report</button>
        </div>`;
      }).join('')}
    </div>
  `;
}

function openAssignModal(empId) {
  const unassigned = () => STATE.regularReports.filter(r=>!STATE.assignments.some(a=>a.reportId===r.id));
  openModal('Assign Report to Employee', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Employee *</label>
        <select class="form-control" id="f-aemp" onchange="updateUnassignedReports()">
          <option value="">— Select Employee —</option>
          ${STATE.employees.filter(e=>e.status==='active').map(e=>`<option value="${e.id}" ${empId===e.id?'selected':''}>${e.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Report *</label>
        <select class="form-control" id="f-arep">
          <option value="">— Select Report —</option>
          ${unassigned().map(r=>`<option value="${r.id}">${r.name} (${r.estHours}h, ${reportDueShort(r)})</option>`).join('')}
        </select>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Assign', cls:'btn-primary', fn:`saveAssignment()`}
  ]);
}

function updateUnassignedReports() {
  const sel = document.getElementById('f-arep');
  const available = STATE.regularReports.filter(r=>!STATE.assignments.some(a=>a.reportId===r.id));
  sel.innerHTML = `<option value="">— Select Report —</option>${available.map(r=>`<option value="${r.id}">${r.name} (${r.estHours}h, ${reportDueShort(r)})</option>`).join('')}`;
}

function saveAssignment() {
  const empId = document.getElementById('f-aemp').value;
  const repId = document.getElementById('f-arep').value;
  if(!empId||!repId) { toast('Select both employee and report','error'); return; }
  if(STATE.assignments.some(a=>a.reportId===repId)) { toast('Report is already assigned to someone','error'); return; }
  STATE.assignments.push({id:uid(), employeeId:empId, reportId:repId, assignedDate:today()});
  save(); closeModal(); toast('Report assigned','success'); assignments();
}

function removeAssignment(id) {
  STATE.assignments = STATE.assignments.filter(a=>a.id!==id);
  save(); toast('Assignment removed','info'); assignments();
}

// ═══════════════════════════════════════════════════════════
// PAGE: QUALITY MANAGEMENT
// ═══════════════════════════════════════════════════════════
function quality() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const visEmpIds2 = visibleEmployees().map(e=>e.id);
  const monthReviews = STATE.qualityReviews.filter(r=>r.year===y&&r.month===m&&visEmpIds2.includes(r.employeeId));
  const activeEmps = visibleEmployees().filter(e=>e.status==='active');

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Quality Management — ${selectedMonthLabel()}</h2>
      <button class="btn btn-primary" onclick="openQualModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Quality Review
      </button>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;margin-bottom:24px">
      ${activeEmps.map(e=>{
        const qs=getQualityScore(e.id,y,m);
        const reviews=monthReviews.filter(r=>r.employeeId===e.id);
        const color=qs>=80?'var(--green)':qs>=60?'var(--accent)':'var(--coral)';
        return `<div class="card" style="text-align:center">
          <div class="avatar" style="width:42px;height:42px;font-size:16px;margin:0 auto 10px">${initials(e.name)}</div>
          <div style="font-weight:700;font-size:13px">${e.name.split(' ')[0]}</div>
          <div style="font-size:32px;font-weight:900;color:${color};margin:8px 0;line-height:1">${qs}</div>
          <div style="font-size:11px;color:var(--text3)">Quality Score</div>
          <div style="font-size:11px;margin-top:6px;color:var(--text3)">${reviews.length} review${reviews.length!==1?'s':''}</div>
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Quality Reviews — ${selectedMonthLabel()}</div></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Employee</th><th>Task/Report</th><th>Result</th>
          <th>Errors</th><th>Severity</th><th>Late</th><th>Date</th><th>Actions</th>
        </tr></thead>
        <tbody>
          ${monthReviews.length===0 ? `<tr><td colspan="8"><div class="empty-state"><p>No quality reviews yet</p></div></td></tr>` :
            monthReviews.map(r=>{
              const emp=STATE.employees.find(e=>e.id===r.employeeId);
              return `<tr>
                <td><strong>${emp?.name||'—'}</strong></td>
                <td>${r.taskName||'—'}${r.source==='survey' ? ' <span class="badge badge-teal" title="Auto-generated from the requestor survey">Auto</span>' : ''}</td>
                <td><span class="badge ${r.result==='Passed'?'badge-green':r.result==='Rework Required'?'badge-amber':'badge-red'}">${r.result}</span></td>
                <td style="font-weight:600">${r.errorCount||0}</td>
                <td><span class="badge ${r.severity==='Low'?'badge-teal':r.severity==='Medium'?'badge-amber':'badge-red'}">${r.severity||'None'}</span></td>
                <td>${r.lateDelivery?'<span class="badge badge-red">Yes</span>':'<span class="badge badge-green">No</span>'}</td>
                <td>${r.reviewDate||'—'}</td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteQual('${r.id}')">Delete</button></td>
              </tr>`;
            }).join('')}
        </tbody>
      </table></div>
    </div>
  `;
}

function openQualModal() {
  openModal('Add Quality Review', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Employee *</label>
        <select class="form-control" id="f-qemp" onchange="onQualEmpChange()">
          <option value="">— Select Employee —</option>
          ${visibleEmployees().filter(e=>e.status==='active').map(e=>`<option value="${e.id}">${e.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Completed Task / Report *</label>
        <select class="form-control" id="f-qtask" onchange="onQualTaskChange()" disabled>
          <option value="">— Select employee first —</option>
        </select>
        <div id="f-qtask-hint" style="font-size:11px;color:var(--text3);margin-top:4px"></div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Result *</label>
          <select class="form-control" id="f-qresult">
            <option>Passed</option>
            <option>Rework Required</option>
            <option>Failed</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Severity</label>
          <select class="form-control" id="f-qsev">
            <option value="">None</option>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </div>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Number of Errors</label>
          <input class="form-control" type="number" id="f-qerr" min="0" value="0"/>
        </div>
        <div class="form-group">
          <label class="form-label">Review Date</label>
          <input class="form-control" type="date" id="f-qdate" value="${today()}"/>
        </div>
      </div>
      <div class="form-group">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="f-qlate"/>
          <span class="form-label" style="margin:0">Late Delivery (−5 pts)</span>
          <span id="f-qlate-badge" style="display:none;font-size:11px;color:var(--coral);font-weight:600">● Auto-detected</span>
        </label>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Save Review', cls:'btn-primary', fn:`saveQual()`}
  ]);
}

function onQualEmpChange() {
  const empId = document.getElementById('f-qemp').value;
  const taskSel = document.getElementById('f-qtask');
  const hint = document.getElementById('f-qtask-hint');

  // Reset
  taskSel.innerHTML = '';
  taskSel.disabled = !empId;
  hint.textContent = '';
  document.getElementById('f-qlate').checked = false;
  document.getElementById('f-qlate-badge').style.display = 'none';

  if(!empId) {
    taskSel.innerHTML = '<option value="">— Select employee first —</option>';
    return;
  }

  const completedAdhoc = STATE.adhocTasks.filter(t =>
    t.assignedTo === empId && t.status === 'Completed'
  );
  const assignedReports = STATE.assignments
    .filter(a => a.employeeId === empId)
    .map(a => STATE.regularReports.find(r => r.id === a.reportId))
    .filter(Boolean);

  if(completedAdhoc.length === 0 && assignedReports.length === 0) {
    taskSel.innerHTML = '<option value="">No completed tasks or assigned reports found</option>';
    hint.textContent = 'Mark an adhoc task as Completed or assign a regular report first.';
    return;
  }

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '— Select a task or report —';
  taskSel.appendChild(placeholder);

  if(completedAdhoc.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Adhoc Tasks — Completed (' + completedAdhoc.length + ')';
    completedAdhoc.forEach(t => {
      const opt = document.createElement('option');
      opt.value = 'adhoc:' + t.id;
      opt.dataset.dueDate = t.dueDate || '';
      opt.dataset.completionDate = t.completionDate || '';
      opt.textContent = t.name + (t.dueDate ? ' · due ' + t.dueDate : '');
      grp.appendChild(opt);
    });
    taskSel.appendChild(grp);
  }

  if(assignedReports.length > 0) {
    const grp = document.createElement('optgroup');
    grp.label = 'Regular Reports — Assigned (' + assignedReports.length + ')';
    assignedReports.forEach(r => {
      const opt = document.createElement('option');
      opt.value = 'report:' + r.id;
      opt.dataset.dueDate = '';
      opt.dataset.completionDate = '';
      opt.textContent = r.name + ' · ' + ((reportFreq(r)==='Weekly' || reportMonthlyMode(r)==='firstWeekday') ? reportDueLabel(r) : 'WD' + (r.dueWorkingDay||1)) + ' · ' + r.estHours + 'h';
      grp.appendChild(opt);
    });
    taskSel.appendChild(grp);
  }

  hint.textContent = 'Showing completed adhoc tasks and assigned regular reports only.';
}

function onQualTaskChange() {
  const taskSel = document.getElementById('f-qtask');
  const lateChk = document.getElementById('f-qlate');
  const lateBadge = document.getElementById('f-qlate-badge');
  const selected = taskSel.options[taskSel.selectedIndex];

  if(!selected || !selected.value) {
    lateChk.checked = false;
    lateBadge.style.display = 'none';
    return;
  }

  const dueDate = selected.dataset.dueDate;
  const completionDate = selected.dataset.completionDate;

  if(dueDate) {
    const due = parseDate(dueDate);
    const completed = completionDate ? parseDate(completionDate) : parseDate(today());
    const isLate = completed > due;
    lateChk.checked = isLate;
    lateBadge.style.display = isLate ? 'inline' : 'none';
  } else {
    lateChk.checked = false;
    lateBadge.style.display = 'none';
  }
}

function saveQual() {
  const empId = document.getElementById('f-qemp').value;
  const taskVal = document.getElementById('f-qtask').value;
  if(!empId) { toast('Select an employee', 'error'); return; }
  if(!taskVal) { toast('Select a task or report', 'error'); return; }

  // Resolve display name and linked ID from the selection
  const taskSel = document.getElementById('f-qtask');
  const selectedOpt = taskSel.options[taskSel.selectedIndex];
  const taskName = selectedOpt ? selectedOpt.textContent.split(' · ')[0] : taskVal;
  const isAdhoc = taskVal.startsWith('adhoc:');
  const linkedId = taskVal.split(':')[1];

  STATE.qualityReviews.push({
    id: uid(),
    employeeId: empId,
    taskName: taskName,
    linkedTaskId: isAdhoc ? linkedId : null,
    linkedReportId: isAdhoc ? null : linkedId,
    result:   document.getElementById('f-qresult').value,
    severity: document.getElementById('f-qsev').value,
    errorCount: parseInt(document.getElementById('f-qerr').value) || 0,
    lateDelivery: document.getElementById('f-qlate').checked,
    reviewDate: document.getElementById('f-qdate').value,
    year: STATE.currentYear, month: STATE.currentMonth
  });
  save(); closeModal(); toast('Review saved', 'success'); quality();
}

function deleteQual(id) {
  STATE.qualityReviews = STATE.qualityReviews.filter(r=>r.id!==id);
  save(); quality();
}

// ═══════════════════════════════════════════════════════════
// PAGE: PERFORMANCE
// ═══════════════════════════════════════════════════════════
function performance() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  // Managers are excluded from individual performance scoring — a manager's
  // performance is reflected through their team's aggregate numbers, not an
  // individual score card/leaderboard row. This also means a manager viewing
  // their own Performance tab sees no personal card, since visibleEmployees()
  // for a manager includes their own record (same team), and this filter
  // removes it.
  const activeEmps = visibleEmployees().filter(e=>e.status==='active' && e.role!=='manager');

  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Performance Scores — ${selectedMonthLabel()}</h2>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;margin-bottom:24px">
      ${activeEmps.map(e=>{
        const ps = getPerformanceScore(e.id,y,m);
        const qs = getQualityScore(e.id,y,m);
        const pl = perfLabel(ps);
        const bw = getEmployeeBandwidth(e.id,today());
        const myAdhoc = STATE.adhocTasks.filter(t=>t.assignedTo===e.id&&t.year===y&&t.month===m);
        const adhocDone = myAdhoc.filter(t=>t.status==='Completed').length;
        const leaves = STATE.leaves.filter(l=>l.employeeId===e.id&&parseDate(l.date).getFullYear()===y&&parseDate(l.date).getMonth()===m);
        return `<div class="card">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
            <div class="avatar" style="width:44px;height:44px;font-size:17px">${initials(e.name)}</div>
            <div style="flex:1">
              <div style="font-weight:700;font-size:15px">${e.name}</div>
              <div style="font-size:12px;color:var(--text3)">${e.designation||'—'} · ${e.team||'—'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:28px;font-weight:900;color:var(--primary);line-height:1">${ps}</div>
              <span class="badge ${pl.cls}">${pl.label}</span>
            </div>
          </div>

          <div style="font-size:12px;color:var(--text3);margin-bottom:8px">Score Breakdown</div>
          ${scoreBar('Regular Reports (30%)', getReportScore(e.id,y,m).score, 30, '#0B4EA2')}
          ${scoreBar('Adhoc Tasks (20%)', myAdhoc.length?Math.round(adhocDone/myAdhoc.length*100):100, 20, '#0D9488')}
          ${scoreBar('Quality & Requestor Survey (35%)', qs, 35, '#F59E0B')}
          ${scoreBar('Utilization (10%)', bw.pct, 10, '#0EA5E9')}
          ${scoreBar('Attendance (5%)', Math.max(0,100-leaves.filter(l=>l.type==='Unplanned').length*15), 5, '#22C55E')}
        </div>`;
      }).join('')}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">Performance Leaderboard — ${selectedMonthLabel()}</div></div>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>#</th><th>Employee</th><th>Team</th>
          <th>Reg. Reports</th><th>Adhoc Done</th><th>Quality/Survey</th>
          <th>Utilization</th><th>Perf Score</th><th>Grade</th>
        </tr></thead>
        <tbody>
          ${activeEmps.sort((a,b)=>getPerformanceScore(b.id,y,m)-getPerformanceScore(a.id,y,m)).map((e,i)=>{
            const ps=getPerformanceScore(e.id,y,m);
            const qs=getQualityScore(e.id,y,m);
            const pl=perfLabel(ps);
            const bw=getEmployeeBandwidth(e.id,today());
            const myA=STATE.adhocTasks.filter(t=>t.assignedTo===e.id&&t.year===y&&t.month===m);
            return `<tr>
              <td><strong style="color:var(--primary)">${i+1}</strong></td>
              <td><div style="display:flex;align-items:center;gap:8px">
                <div class="avatar" style="width:28px;height:28px;font-size:10px">${initials(e.name)}</div>
                <span style="font-weight:600">${e.name}</span>
              </div></td>
              <td>${e.team||'—'}</td>
              <td>${(()=>{ const rs=getReportScore(e.id,y,m); return rs.due ? `${rs.done}/${rs.due} done${rs.late?` <small style="color:var(--text3)">(${rs.late} late)</small>`:''}` : STATE.assignments.filter(a=>a.employeeId===e.id).length+' reports'; })()}</td>
              <td>${myA.filter(t=>t.status==='Completed').length}/${myA.length}</td>
              <td><span class="badge badge-blue">${qs}/100</span></td>
              <td>
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="progress-bar" style="width:60px"><div class="progress-fill ${utilColor(bw.pct)}" style="width:${bw.pct}%"></div></div>
                  <span style="font-size:12px">${bw.pct}%</span>
                </div>
              </td>
              <td><strong style="font-size:16px;color:var(--primary)">${ps}</strong></td>
              <td><span class="badge ${pl.cls}">${pl.label}</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </div>
  `;
}

function scoreBar(label, value, weight, color) {
  const contribution = Math.round(value * weight / 100);
  return `<div style="margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
      <span style="color:var(--text2)">${label}</span>
      <span style="font-weight:600;color:var(--text)">${contribution}/${weight}pts</span>
    </div>
    <div class="progress-bar">
      <div class="progress-fill" style="width:${Math.min(100,value)}%;background:${color}"></div>
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// PAGE: SKILLS LIBRARY
// ═══════════════════════════════════════════════════════════
function skills() {
  const cats = [...new Set(STATE.skills.map(s=>s.category).filter(Boolean))];
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Skills Library</h2>
      <button class="btn btn-primary" onclick="openSkillModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Skill
      </button>
    </div>

    <div class="alert alert-info" style="margin-bottom:20px">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Skills defined here can be assigned to employees and used as filters when Smart Assigning adhoc tasks.
    </div>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px">
      ${kpiCard('Total Skills', STATE.skills.length, 'In library', '#0B4EA2','#EEF2FF', svgStar())}
      ${kpiCard('Categories', cats.length||0, 'Skill groups', '#0D9488','#CCFBF1', svgChart())}
      ${kpiCard('Employees with Skills', STATE.employees.filter(e=>e.skills&&e.skills.length>0&&e.status==='active').length, 'Active', '#F59E0B','#FEF3C7', svgPeople())}
    </div>

    <div class="card">
      <div class="card-header">
        <div class="card-title">All Skills</div>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="form-control" id="skill-cat-filter" onchange="renderSkillsTable()" style="width:160px;padding:5px 10px">
            <option value="">All Categories</option>
            ${cats.map(c=>`<option>${c}</option>`).join('')}
          </select>
        </div>
      </div>
      <div id="skills-table-wrap"></div>
    </div>
  `;
  renderSkillsTable();
}

function renderSkillsTable() {
  const catF = (document.getElementById('skill-cat-filter')||{}).value||'';
  let list = STATE.skills.filter(s=>!catF||s.category===catF);
  const wrap = document.getElementById('skills-table-wrap');
  if(!wrap) return;
  if(list.length===0) {
    wrap.innerHTML=`<div class="empty-state"><p>No skills yet</p><small>Click "Add Skill" to create your first skill</small></div>`;
    return;
  }
  wrap.innerHTML = `<div class="table-wrap"><table>
    <thead><tr>
      <th>Skill Name</th><th>Category</th><th>Description</th><th>Employees</th><th>Actions</th>
    </tr></thead>
    <tbody>
      ${list.map(s=>{
        const empCount = STATE.employees.filter(e=>e.status==='active'&&(e.skills||[]).includes(s.id)).length;
        return `<tr>
          <td><span class="skill-tag">${s.name}</span></td>
          <td><span class="badge badge-blue">${s.category||'—'}</span></td>
          <td style="color:var(--text2);max-width:280px">${s.description||'—'}</td>
          <td>
            <span style="font-weight:600;color:var(--primary)">${empCount}</span>
            <span style="color:var(--text3);font-size:12px"> employee${empCount!==1?'s':''}</span>
          </td>
          <td><div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="openSkillModal('${s.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteSkill('${s.id}')">Remove</button>
          </div></td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;
}

function openSkillModal(id) {
  const sk = id ? STATE.skills.find(s=>s.id===id) : null;
  const existingCats = [...new Set(STATE.skills.map(s=>s.category).filter(Boolean))];
  openModal(sk ? 'Edit Skill' : 'Add Skill', `
    <div class="form-grid">
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Skill Name *</label>
          <input class="form-control" id="f-sname" placeholder="e.g. Python, SQL, Tableau" value="${sk?.name||''}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Category</label>
          <input class="form-control" id="f-scat" list="skill-cat-list" placeholder="e.g. Technical, Analytical" value="${sk?.category||''}"/>
          <datalist id="skill-cat-list">
            ${existingCats.map(c=>`<option value="${c}"/>`).join('')}
          </datalist>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <textarea class="form-control" id="f-sdesc" placeholder="Brief description of this skill…">${sk?.description||''}</textarea>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label: sk?'Save Changes':'Add Skill', cls:'btn-primary', fn:`saveSkill('${id||''}')`}
  ]);
}

function saveSkill(id) {
  const name = document.getElementById('f-sname').value.trim();
  const category = document.getElementById('f-scat').value.trim();
  const description = document.getElementById('f-sdesc').value.trim();
  if(!name) { toast('Skill name is required','error'); return; }
  // Check duplicate name (case-insensitive)
  const dup = STATE.skills.find(s=>s.name.toLowerCase()===name.toLowerCase()&&s.id!==id);
  if(dup) { toast('A skill with this name already exists','error'); return; }
  if(id) {
    const idx = STATE.skills.findIndex(s=>s.id===id);
    if(idx>-1) STATE.skills[idx] = {...STATE.skills[idx], name, category, description};
    toast('Skill updated','success');
  } else {
    STATE.skills.push({id:uid(), name, category, description, createdAt:today()});
    toast('Skill added','success');
  }
  save(); closeModal(); skills();
}

function deleteSkill(id) {
  const sk = STATE.skills.find(s=>s.id===id);
  if(!sk) return;
  // Check how many employees use this skill
  const used = STATE.employees.filter(e=>(e.skills||[]).includes(id)).length;
  const msg = used>0
    ? `Remove skill "${sk.name}"? It is currently assigned to ${used} employee${used!==1?'s':''}. It will be removed from their profiles too.`
    : `Remove skill "${sk.name}"?`;
  if(!confirm(msg)) return;
  STATE.skills = STATE.skills.filter(s=>s.id!==id);
  // Remove from all employees
  STATE.employees.forEach(e=>{ if(e.skills) e.skills=e.skills.filter(sid=>sid!==id); });
  // Remove from adhoc task requirements
  STATE.adhocTasks.forEach(t=>{ if(t.requiredSkills) t.requiredSkills=t.requiredSkills.filter(sid=>sid!==id); });
  save(); toast('Skill removed','info'); skills();
}

// ─── TEAM AUTO-FILL HELPER ──────────────────────────────────
function onTeamChange() {
  const sel = document.getElementById('f-team');
  const mgrInput = document.getElementById('f-mgr');
  if(!sel || !mgrInput) return;
  const team = STATE.teams.find(t => t.name === sel.value);
  mgrInput.value = team ? team.manager : '';
}

// ═══════════════════════════════════════════════════════════
// PAGE: TEAMS & MANAGERS
// ═══════════════════════════════════════════════════════════
function teams() {
  const content = document.getElementById('content');
  const empCountByTeam = (teamName) =>
    STATE.employees.filter(e => e.status === 'active' && e.team === teamName).length;

  content.innerHTML = `
    <div class="section-header">
      <h2>Teams &amp; Managers</h2>
      <button class="btn btn-primary" onclick="openTeamModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Team
      </button>
    </div>

    <div class="alert alert-info" style="margin-bottom:20px">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      Teams defined here appear as a dropdown when adding or editing employees. Selecting a team auto-fills the manager name.
    </div>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px">
      ${kpiCard('Total Teams', STATE.teams.length, 'Defined', '#0B4EA2','#EEF2FF', svgChart())}
      ${kpiCard('Managers', [...new Set(STATE.teams.map(t=>t.manager).filter(Boolean))].length, 'Unique', '#0D9488','#CCFBF1', svgPeople())}
      ${kpiCard('Unassigned Employees', STATE.employees.filter(e=>e.status==='active'&&!e.team).length, 'Active, no team', '#F59E0B','#FEF3C7', svgPeople())}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">All Teams</div></div>
      ${STATE.teams.length === 0
        ? `<div class="empty-state"><p>No teams yet</p><small>Click "Add Team" to create your first team</small></div>`
        : `<div class="table-wrap"><table>
            <thead><tr>
              <th>Team Name</th><th>Manager</th><th>Active Members</th><th>Actions</th>
            </tr></thead>
            <tbody>
              ${STATE.teams.map(t => {
                const count = empCountByTeam(t.name);
                const members = STATE.employees.filter(e => e.status==='active' && e.team===t.name);
                return `<tr>
                  <td><strong>${t.name}</strong></td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <div class="avatar" style="width:28px;height:28px;font-size:11px">${t.manager ? t.manager.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase() : '?'}</div>
                      ${t.manager || '<span style="color:var(--text3)">—</span>'}
                    </div>
                  </td>
                  <td>
                    <div style="display:flex;align-items:center;gap:8px">
                      <span style="font-weight:600;color:var(--primary)">${count}</span>
                      ${members.length ? `<div style="display:flex;gap:3px">${members.slice(0,4).map(e=>`<div class="avatar" style="width:22px;height:22px;font-size:9px" title="${e.name}">${initials(e.name)}</div>`).join('')}${members.length>4?`<div style="font-size:11px;color:var(--text3);align-self:center">+${members.length-4}</div>`:''}</div>` : '<span style="color:var(--text3);font-size:12px">No members</span>'}
                    </div>
                  </td>
                  <td>
                    <div style="display:flex;gap:6px">
                      <button class="btn btn-secondary btn-sm" onclick="openTeamModal('${t.id}')">Edit</button>
                      <button class="btn btn-danger btn-sm" onclick="deleteTeam('${t.id}')">Remove</button>
                    </div>
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>`
      }
    </div>
  `;
}

function openTeamModal(id) {
  const t = id ? STATE.teams.find(t => t.id === id) : null;
  openModal(t ? 'Edit Team' : 'Add Team', `
    <div class="form-grid">
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Team Name *</label>
          <input class="form-control" id="f-tname" placeholder="e.g. Analytics, Engineering" value="${t?.name||''}"/>
        </div>
        <div class="form-group">
          <label class="form-label">Manager Name *</label>
          <input class="form-control" id="f-tmgr" placeholder="e.g. Rajesh Kumar" value="${t?.manager||''}"/>
        </div>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label: t ? 'Save Changes' : 'Add Team', cls:'btn-primary', fn:`saveTeam('${id||''}')`}
  ]);
}

function saveTeam(id) {
  const name    = document.getElementById('f-tname').value.trim();
  const manager = document.getElementById('f-tmgr').value.trim();
  if(!name)    { toast('Team name is required', 'error'); return; }
  if(!manager) { toast('Manager name is required', 'error'); return; }

  const dup = STATE.teams.find(t => t.name.toLowerCase() === name.toLowerCase() && t.id !== id);
  if(dup) { toast('A team with this name already exists', 'error'); return; }

  if(id) {
    const idx = STATE.teams.findIndex(t => t.id === id);
    if(idx > -1) {
      const oldManager = STATE.teams[idx].manager;
      STATE.teams[idx] = { ...STATE.teams[idx], name, manager };
      // Sync manager on employees whose team name matches
      STATE.employees.forEach(e => {
        if(e.team === STATE.teams[idx].name || e.team === name) {
          e.manager = manager;
        }
      });
    }
    toast('Team updated', 'success');
  } else {
    STATE.teams.push({ id: uid(), name, manager, createdAt: today() });
    toast('Team added', 'success');
  }
  save(); closeModal(); teams();
}

function deleteTeam(id) {
  const t = STATE.teams.find(t => t.id === id);
  if(!t) return;
  const count = STATE.employees.filter(e => e.status==='active' && e.team===t.name).length;
  const msg = count > 0
    ? `Remove team "${t.name}"? ${count} active employee${count!==1?'s are':' is'} in this team. Their team field will be cleared.`
    : `Remove team "${t.name}"?`;
  if(!confirm(msg)) return;
  STATE.teams = STATE.teams.filter(t => t.id !== id);
  // Clear team & manager on affected employees
  STATE.employees.forEach(e => { if(e.team === t.name) { e.team = ''; e.manager = ''; } });
  save(); toast('Team removed', 'info'); teams();
}

// ═══════════════════════════════════════════════════════════
// PAGE: PROJECTS
// Admin/Manager creates a project (date range) and assigns each member a FIXED number of
// planned hours per working day for that range. Those hours are counted in
// getEmployeeBandwidth() (via getProjectHours) like regular-report and adhoc hours, so they
// reduce the member's available capacity on every working day in the range. Weekends,
// holidays and leave days are excluded. Only "Active" projects count toward capacity.
// ═══════════════════════════════════════════════════════════
const PROJECT_STATUSES = ['Active','On Hold','Completed'];

function eligibleProjectEmployees() {
  return visibleEmployees().filter(e => e.status==='active' && e.role!=='manager');
}
function visibleProjects() {
  if(isAdmin()) return STATE.projects;
  const ids = new Set(visibleEmployees().map(e => e.id));
  const me = STATE.currentUser && STATE.currentUser.authUid;
  return STATE.projects.filter(p => (me && p.createdBy === me) || (p.allocations||[]).some(a => ids.has(a.employeeId)));
}
function projectPhase(p) {
  const st = p.status || 'Active', t = today();
  if(st === 'Completed') return {label:'Completed', cls:'badge-gray'};
  if(st === 'On Hold')   return {label:'On Hold',   cls:'badge-amber'};
  if(t < p.startDate)    return {label:'Upcoming',  cls:'badge-blue'};
  if(t > p.endDate)      return {label:'Ended',     cls:'badge-gray'};
  return {label:'Running', cls:'badge-green'};
}
function countWorkingDaysBetween(startStr, endStr) {
  const s = parseDate(startStr), e = parseDate(endStr);
  if(isNaN(s) || isNaN(e) || e < s) return 0;
  let n = 0, guard = 0;
  for(const d = new Date(s); d <= e && guard < 4000; d.setDate(d.getDate()+1), guard++) { if(isWorkingDay(d)) n++; }
  return n;
}

// Read-only page for members: only THEIR OWN assignments, and only Active + upcoming projects
// (status Active and not yet past the end date). Shows name, dates, status and their own hours/day.
function myProjects() {
  const me = myEmpId(), t = today();
  const mine = [];
  STATE.projects.forEach(p => {
    if((p.status||'Active') !== 'Active' || !p.endDate || p.endDate < t) return;
    const a = (p.allocations||[]).find(x => x.employeeId === me);
    if(a) mine.push({p, hoursPerDay: parseFloat(a.hoursPerDay)||0});
  });
  return mine.sort((x,y) => (x.p.startDate||'').localeCompare(y.p.startDate||''));
}

function projectsMemberView() {
  const mine = myProjects(), t = today();
  const hoursToday = getEmployeeBandwidth(myEmpId(), t).project || 0;
  const upcoming = mine.filter(x => t < x.p.startDate).length;
  document.getElementById('content').innerHTML = `
    <div class="section-header"><h2>My Projects</h2></div>
    <div class="alert alert-info" style="margin-bottom:20px">
      These are the projects you've been assigned to. The hours per day below are included in your daily workload and reduce your available capacity on working days within each project's dates.
    </div>
    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px">
      ${kpiCard('Assigned Projects', mine.length, 'Active & upcoming', '#0B4EA2','#EEF2FF', svgChart())}
      ${kpiCard('Project Hours Today', fmtH(hoursToday)+'h', 'Included in your workload', '#F59E0B','#FEF3C7', svgClock())}
      ${kpiCard('Upcoming', upcoming, 'Not started yet', '#0D9488','#CCFBF1', svgFlash())}
    </div>
    <div class="card">
      <div class="card-header"><div class="card-title">Active &amp; Upcoming Projects</div></div>
      ${mine.length === 0
        ? `<div class="empty-state"><p>No active or upcoming projects assigned to you</p><small>When a manager assigns you to a project, it will appear here</small></div>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Project</th><th>Dates</th><th>Status</th><th>My hours/day</th></tr></thead>
            <tbody>
              ${mine.map(({p, hoursPerDay}) => {
                const ph = projectPhase(p);
                return `<tr>
                  <td><strong>${escHtml(p.name)}</strong>${p.description ? `<div style="font-size:12px;color:var(--text3);max-width:320px">${escHtml(p.description)}</div>` : ''}</td>
                  <td style="white-space:nowrap">${escHtml(p.startDate)} → ${escHtml(p.endDate)}<div style="font-size:12px;color:var(--text3)">${countWorkingDaysBetween(p.startDate, p.endDate)} working days</div></td>
                  <td><span class="badge ${ph.cls}">${ph.label}</span></td>
                  <td><strong>${fmtH(hoursPerDay)}h</strong></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>`}
    </div>`;
}

function projects() {
  if(isMember()) { projectsMemberView(); return; }
  const list = visibleProjects().slice().sort((a,b) => (b.startDate||'').localeCompare(a.startDate||''));
  const t = today();
  const running = list.filter(p => projectPhase(p).label === 'Running').length;
  let hoursToday = 0;
  eligibleProjectEmployees().forEach(e => { hoursToday += getEmployeeBandwidth(e.id, t).project || 0; });
  const empName = id => { const e = STATE.employees.find(x => x.id === id); return e ? e.name : 'Removed employee'; };

  document.getElementById('content').innerHTML = `
    <div class="section-header">
      <h2>Projects</h2>
      <button class="btn btn-primary" onclick="openProjectModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        New Project
      </button>
    </div>

    <div class="alert alert-info" style="margin-bottom:20px">
      Assign each member a fixed number of hours per working day for the project's date range. Those hours are added to their
      daily workload in the Capacity Planner automatically (weekends, holidays and leave days are skipped; only <strong>Active</strong> projects count).
    </div>

    <div class="kpi-grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:20px">
      ${kpiCard('Projects', list.length, 'In your view', '#0B4EA2','#EEF2FF', svgChart())}
      ${kpiCard('Running Today', running, 'Active & in date range', '#0D9488','#CCFBF1', svgFlash())}
      ${kpiCard('Project Hours Today', fmtH(hoursToday)+'h', 'Across team members', '#F59E0B','#FEF3C7', svgClock())}
    </div>

    <div class="card">
      <div class="card-header"><div class="card-title">All Projects</div></div>
      ${list.length === 0
        ? `<div class="empty-state"><p>No projects yet</p><small>Click "New Project" to add one and assign hours to team members</small></div>`
        : `<div class="table-wrap"><table>
            <thead><tr><th>Project</th><th>Dates</th><th>Status</th><th>Team &amp; hours/day</th><th>Total h/day</th><th>Actions</th></tr></thead>
            <tbody>
              ${list.map(p => {
                const ph = projectPhase(p);
                const al = p.allocations || [];
                const total = al.reduce((s,a) => s + (parseFloat(a.hoursPerDay)||0), 0);
                return `<tr>
                  <td><strong>${escHtml(p.name)}</strong>${p.description ? `<div style="font-size:12px;color:var(--text3);max-width:260px">${escHtml(p.description)}</div>` : ''}</td>
                  <td style="white-space:nowrap">${escHtml(p.startDate)} → ${escHtml(p.endDate)}<div style="font-size:12px;color:var(--text3)">${countWorkingDaysBetween(p.startDate, p.endDate)} working days</div></td>
                  <td><span class="badge ${ph.cls}">${ph.label}</span></td>
                  <td>${al.length ? al.map(a => `<div style="font-size:13px">${escHtml(empName(a.employeeId))} <span style="color:var(--text3)">· ${fmtH(a.hoursPerDay)}h</span></div>`).join('') : '<span style="color:var(--text3)">—</span>'}</td>
                  <td><strong>${fmtH(total)}h</strong></td>
                  <td><div style="display:flex;gap:6px">
                    <button class="btn btn-secondary btn-sm" onclick="openProjectModal('${p.id}')">Edit</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteProject('${p.id}')">Delete</button>
                  </div></td>
                </tr>`;
              }).join('')}
            </tbody>
          </table></div>`}
    </div>
  `;
}

function openProjectModal(id) {
  if(!(isAdmin() || isManager())) { toast('Only admins and managers can manage projects', 'error'); return; }
  const p = id ? STATE.projects.find(x => x.id === id) : null;
  const emps = eligibleProjectEmployees();
  const hoursOf = eid => { const a = ((p && p.allocations) || []).find(x => x.employeeId === eid); return a ? a.hoursPerDay : null; };
  openModal(p ? 'Edit Project' : 'New Project', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Project Name *</label>
        <input class="form-control" id="f-pname" placeholder="e.g. Warehouse Migration" value="${escHtml(p ? p.name : '')}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Description</label>
        <input class="form-control" id="f-pdesc" placeholder="Optional" value="${escHtml(p ? (p.description||'') : '')}"/>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group">
          <label class="form-label">Start Date *</label>
          <input class="form-control" id="f-pstart" type="date" value="${p ? p.startDate : today()}"/>
        </div>
        <div class="form-group">
          <label class="form-label">End Date *</label>
          <input class="form-control" id="f-pend" type="date" value="${p ? p.endDate : ''}"/>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-control" id="f-pstatus">
          ${PROJECT_STATUSES.map(st => `<option value="${st}" ${(p ? (p.status||'Active') : 'Active') === st ? 'selected' : ''}>${st}</option>`).join('')}
        </select>
        <small style="color:var(--text3)">Only Active projects reduce capacity. Set On Hold or Completed to release the hours.</small>
      </div>
      <div class="form-group">
        <label class="form-label">Team members &amp; planned hours per working day *</label>
        <div style="max-height:260px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:4px 10px">
          ${emps.length === 0 ? '<div style="padding:10px;color:var(--text3)">No active team members available</div>' : emps.map(e => {
            const h = hoursOf(e.id), on = h !== null;
            return `<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--border)">
              <input type="checkbox" id="pa-chk-${e.id}" ${on ? 'checked' : ''} onchange="document.getElementById('pa-hrs-${e.id}').disabled=!this.checked"/>
              <label for="pa-chk-${e.id}" style="flex:1;cursor:pointer;font-size:13px">${escHtml(e.name)} <span style="color:var(--text3)">· ${escHtml(e.team||'—')} · ${fmtH(e.loginHours||8)}h/day</span></label>
              <input class="form-control" id="pa-hrs-${e.id}" type="number" min="0.25" max="12" step="0.25" value="${on ? h : 1}" ${on ? '' : 'disabled'} style="width:84px;padding:5px 8px"/>
              <span style="font-size:12px;color:var(--text3)">h/day</span>
            </div>`;
          }).join('')}
        </div>
      </div>
    </div>`,
    [{cls:'btn-secondary', label:'Cancel', fn:'closeModal()'},
     {cls:'btn-primary', label: p ? 'Save Changes' : 'Create Project', fn:`saveProject('${p ? p.id : ''}')`}],
    true);
}

function saveProject(id) {
  if(!(isAdmin() || isManager())) { toast('Only admins and managers can manage projects', 'error'); return; }
  const name = document.getElementById('f-pname').value.trim();
  const description = document.getElementById('f-pdesc').value.trim();
  const startDate = document.getElementById('f-pstart').value;
  const endDate = document.getElementById('f-pend').value;
  const status = document.getElementById('f-pstatus').value;
  if(!name) { toast('Project name is required', 'error'); return; }
  if(!startDate || !endDate) { toast('Start and end dates are required', 'error'); return; }
  if(endDate < startDate) { toast('End date must be on or after the start date', 'error'); return; }

  const existing = id ? STATE.projects.find(p => p.id === id) : null;
  const editable = eligibleProjectEmployees();
  const editableIds = new Set(editable.map(e => e.id));
  // keep allocations for people this user can't see/edit (e.g. another team's members)
  const allocations = ((existing && existing.allocations) || []).filter(a => !editableIds.has(a.employeeId));
  for(const e of editable) {
    const chk = document.getElementById('pa-chk-' + e.id);
    if(!chk || !chk.checked) continue;
    const hrs = parseFloat(document.getElementById('pa-hrs-' + e.id).value);
    const cap = parseFloat(e.loginHours) || 8;
    if(!(hrs > 0) || hrs > 12) { toast(`${e.name}: enter hours per day between 0.25 and 12`, 'error'); return; }
    if(hrs > cap) { toast(`${e.name} logs ${fmtH(cap)}h/day — project hours can't exceed that`, 'error'); return; }
    allocations.push({employeeId: e.id, hoursPerDay: Math.round(hrs*100)/100});
  }
  if(!allocations.length) { toast('Assign at least one team member', 'error'); return; }

  if(existing) {
    Object.assign(existing, {name, description, startDate, endDate, status, allocations});
    toast('Project updated', 'success');
  } else {
    STATE.projects.push({id: uid(), name, description, startDate, endDate, status, allocations,
      createdAt: today(), createdBy: (STATE.currentUser && STATE.currentUser.authUid) || ''});
    toast('Project created', 'success');
  }
  save(); closeModal(); projects();
}

function deleteProject(id) {
  if(!(isAdmin() || isManager())) { toast('Only admins and managers can manage projects', 'error'); return; }
  const p = STATE.projects.find(x => x.id === id);
  if(!p) return;
  if(!confirm(`Delete project "${p.name}"? Its planned hours will be removed from everyone's capacity.`)) return;
  STATE.projects = STATE.projects.filter(x => x.id !== id);
  save(); toast('Project deleted', 'info'); projects();
}

// ═══════════════════════════════════════════════════════════
// PAGE: HOLIDAYS
// ═══════════════════════════════════════════════════════════
function holidays() {
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section-header">
      <h2>Holiday Calendar</h2>
      <button class="btn btn-primary" onclick="openHolidayModal()">
        <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Holiday
      </button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
      <div class="card">
        <div class="card-header"><div class="card-title">Company Holidays</div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Holiday Name</th><th>Day</th><th>Action</th></tr></thead>
          <tbody>
            ${STATE.holidays.length===0 ? `<tr><td colspan="4"><div class="empty-state"><p>No holidays configured</p></div></td></tr>` :
              STATE.holidays.sort((a,b)=>a.date.localeCompare(b.date)).map(h=>`<tr>
                <td style="font-weight:600">${h.date}</td>
                <td>${h.name}</td>
                <td style="color:var(--text3)">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseDate(h.date).getDay()]}</td>
                <td><button class="btn btn-danger btn-sm" onclick="deleteHoliday('${h.id}')">Remove</button></td>
              </tr>`).join('')}
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">Working Days — ${selectedMonthLabel()}</div></div>
        <div>
          ${buildMiniCalendar()}
        </div>
      </div>
    </div>
  `;
}

function buildMiniCalendar() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const daysInM = daysInMonth(y,m);
  const firstDay = new Date(y,m,1).getDay();
  let html = `<div class="cal-grid">`;
  ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=>{
    html += `<div class="cal-header-cell">${d}</div>`;
  });
  for(let i=0;i<firstDay;i++) html += `<div></div>`;
  for(let i=1;i<=daysInM;i++){
    const dt=new Date(y,m,i);
    const dateStr=fmtDate(dt);
    const isToday=dateStr===today();
    let cls='cal-green', title='Working Day';
    if(isWeekend(dt)) { cls='cal-weekend'; title='Weekend'; }
    else if(isHoliday(dateStr)) {
      cls='cal-holiday';
      title=STATE.holidays.find(h=>h.date===dateStr)?.name||'Holiday';
    }
    html += `<div class="cal-cell ${cls}${isToday?' cal-today':''}" data-tip="${title}">${i}</div>`;
  }
  html += '</div>';
  const wds = getWorkingDays(y,m);
  html += `<div style="margin-top:12px;font-size:13px;color:var(--text2)">
    <strong>${wds.length}</strong> working days · <strong>${daysInM-wds.length}</strong> non-working
  </div>`;
  return html;
}

function openHolidayModal() {
  openModal('Add Holiday', `
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Holiday Date *</label>
        <input class="form-control" id="f-hdate" type="date" value="${today()}"/>
      </div>
      <div class="form-group">
        <label class="form-label">Holiday Name *</label>
        <input class="form-control" id="f-hname" placeholder="Independence Day"/>
      </div>
    </div>
  `, [
    {label:'Cancel', cls:'btn-secondary', fn:'closeModal()'},
    {label:'Add Holiday', cls:'btn-primary', fn:`saveHoliday()`}
  ]);
}

function saveHoliday() {
  const date=document.getElementById('f-hdate').value;
  const name=document.getElementById('f-hname').value.trim();
  if(!date||!name) { toast('Date and name required','error'); return; }
  if(STATE.holidays.some(h=>h.date===date)) { toast('Holiday already exists','error'); return; }
  STATE.holidays.push({id:uid(), date, name});
  save(); closeModal(); toast('Holiday added','success'); holidays();
}

function deleteHoliday(id) {
  STATE.holidays=STATE.holidays.filter(h=>h.id!==id);
  save(); holidays();
}

// ═══════════════════════════════════════════════════════════
// MODAL HELPER
// ═══════════════════════════════════════════════════════════
function openModal(title, body, actions=[], isLg=false) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-sub').textContent = '';
  document.getElementById('modal-body').innerHTML = body;
  document.getElementById('modal-footer').innerHTML = actions.map(a=>
    `<button class="btn ${a.cls}" onclick="${a.fn}">${a.label}</button>`
  ).join('');
  document.getElementById('modal-box').className = 'modal' + (isLg?' modal-lg':'');
  document.getElementById('modal-overlay').classList.add('active');
}
function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}
function closeModalOutside(e) {
  if(e.target===document.getElementById('modal-overlay')) closeModal();
}

// ═══════════════════════════════════════════════════════════
// CSV EXPORT
// ═══════════════════════════════════════════════════════════
function exportCSV() {
  const y=STATE.currentYear, m=STATE.currentMonth;
  const activeEmps = STATE.employees.filter(e=>e.status==='active');
  const rows = [['Employee','Team','Designation','Perf Score','Quality Score','Utilization%','Assigned Reports','Adhoc Tasks','Project Hrs Today']];
  activeEmps.forEach(e=>{
    const ps=getPerformanceScore(e.id,y,m);
    const qs=getQualityScore(e.id,y,m);
    const bw=getEmployeeBandwidth(e.id,today());
    const reps=STATE.assignments.filter(a=>a.employeeId===e.id).length;
    const adhoc=STATE.adhocTasks.filter(t=>t.assignedTo===e.id&&t.year===y&&t.month===m).length;
    rows.push([e.name,e.team||'',e.designation||'',ps,qs,bw.pct,reps,adhoc,bw.project||0]);
  });
  const csv = rows.map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv],{type:'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pwms_${monthName(m)}_${y}.csv`;
  a.click();
  toast('CSV exported','success');
}

// ═══════════════════════════════════════════════════════════
// SVG ICONS
// ═══════════════════════════════════════════════════════════
function svgPeople() { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><circle cx="19" cy="7" r="2"/><path d="M23 21v-2a4 4 0 0 0-2-3.5"/></svg>`; }
function svgDoc()    { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>`; }
function svgFlash()  { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><polygon points="13,2 3,14 12,14 11,22 21,10 12,10 13,2"/></svg>`; }
function svgClock()  { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12,6 12,12 16,14"/></svg>`; }
function svgStar()   { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26 12,2"/></svg>`; }
function svgChart()  { return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`; }
function svgBattery(){ return `<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" viewBox="0 0 24 24"><rect x="1" y="6" width="18" height="12" rx="2"/><path d="M23 13v-2"/><line x1="5" y1="12" x2="10" y2="12"/></svg>`; }

// ═══════════════════════════════════════════════════════════
// SEED DATA (if empty)
// ═══════════════════════════════════════════════════════════
function seedData() {
  if(STATE.employees.length) return;
  // Seed teams
  if(!STATE.teams.length) {
    STATE.teams = [
      {id:uid(), name:'Analytics',   manager:'Manager A', createdAt:today()},
      {id:uid(), name:'Engineering', manager:'Manager B', createdAt:today()},
    ];
  }

  // Seed skills first
  if(!STATE.skills.length) {
    STATE.skills = [
      {id:'sk01', name:'SQL',       category:'Technical',   description:'Structured Query Language for databases', createdAt:today()},
      {id:'sk02', name:'Python',    category:'Technical',   description:'Python scripting and data analysis',      createdAt:today()},
      {id:'sk03', name:'Tableau',   category:'BI Tools',    description:'Tableau dashboard & visualisation',       createdAt:today()},
      {id:'sk04', name:'Excel',     category:'BI Tools',    description:'Advanced Excel including VBA & pivot',    createdAt:today()},
      {id:'sk05', name:'Executive Presentations', category:'Communication', description:'Crafting and presenting board-level decks', createdAt:today()},
      {id:'sk06', name:'Statistical Analysis',    category:'Analytical',   description:'Statistical modelling and inference',      createdAt:today()},
    ];
  }
  const emps = [
    {id:uid(),empId:'EMP001',name:'Arjun Sharma',email:'arjun@company.com',designation:'Senior Analyst',team:'Analytics',manager:'Manager A',loginHours:8,status:'active',role:'manager',skills:['sk01','sk02','sk05'],createdAt:today()},
    {id:uid(),empId:'EMP002',name:'Priya Mehta',email:'priya@company.com',designation:'Data Analyst',team:'Analytics',manager:'Manager A',loginHours:8,status:'active',skills:['sk01','sk03','sk06'],createdAt:today()},
    {id:uid(),empId:'EMP003',name:'Rohan Kumar',email:'rohan@company.com',designation:'BI Developer',team:'Engineering',manager:'Manager B',loginHours:8,status:'active',role:'manager',skills:['sk02','sk03','sk04'],createdAt:today()},
    {id:uid(),empId:'EMP004',name:'Neha Singh',email:'neha@company.com',designation:'Analyst',team:'Analytics',manager:'Manager A',loginHours:8,status:'active',skills:['sk04','sk06'],createdAt:today()},
  ];
  STATE.employees = emps;

  const reps = [
    {id:uid(),name:'Daily Revenue Report',description:'End of day revenue summary',estHours:1.5,dueWorkingDay:1,priority:'High',criticality:'Critical',backupOwner:'Team Lead',createdAt:today()},
    {id:uid(),name:'Weekly KPI Report',description:'Key performance indicators',estHours:2,dueWorkingDay:3,priority:'Medium',criticality:'High',backupOwner:'Team Lead',createdAt:today()},
    {id:uid(),name:'Month-End Summary',description:'Monthly consolidated report',estHours:3,dueWorkingDay:5,priority:'High',criticality:'Critical',backupOwner:'Manager',createdAt:today()},
  ];
  STATE.regularReports = reps;

  // Assign first two reports to first two employees
  STATE.assignments = [
    {id:uid(),employeeId:emps[0].id,reportId:reps[0].id,assignedDate:today()},
    {id:uid(),employeeId:emps[0].id,reportId:reps[1].id,assignedDate:today()},
    {id:uid(),employeeId:emps[1].id,reportId:reps[1].id,assignedDate:today()},
    {id:uid(),employeeId:emps[1].id,reportId:reps[2].id,assignedDate:today()},
    {id:uid(),employeeId:emps[2].id,reportId:reps[0].id,assignedDate:today()},
  ];

  // Sample adhoc tasks
  const y=nowET().getFullYear(), m=nowET().getMonth();
  STATE.adhocTasks = [
    {id:uid(),taskId:'ADH001',name:'Q3 Executive Deck',requestor:'CEO',category:'Executive Request',description:'Q3 performance deck for board',estHours:4,assignedDate:today(),dueDate:today(),status:'In Progress',assignedTo:emps[0].id,year:y,month:m,createdAt:today()},
    {id:uid(),taskId:'ADH002',name:'Customer Segmentation Pull',requestor:'Marketing',category:'Data Pull',description:'Segment data pull',estHours:2,assignedDate:today(),dueDate:today(),status:'Completed',assignedTo:emps[1].id,year:y,month:m,completionDate:today(),actualHours:1.5,createdAt:today()},
  ];

  // Sample quality reviews
  STATE.qualityReviews = [
    {id:uid(),employeeId:emps[0].id,taskName:'Daily Revenue Report',result:'Passed',severity:'',errorCount:0,lateDelivery:false,reviewDate:today(),year:y,month:m},
    {id:uid(),employeeId:emps[1].id,taskName:'Q3 Executive Deck',result:'Rework Required',severity:'Medium',errorCount:2,lateDelivery:true,reviewDate:today(),year:y,month:m},
  ];

  save();
}

// ─── SYNC STATUS INDICATOR ──────────────────────────────────
// Small, non-intrusive status text in the sidebar footer (see index.html)
// so it's always obvious whether the app is actually connected to and
// synced with Supabase, independent of any one action's toast message.
function setSyncStatus(state, detail) {
  const el = document.getElementById('sync-status');
  if(!el) return;
  const cfg = {
    connecting: { dot:'●', text:'Connecting…',        cls:'sync-connecting' },
    connected:  { dot:'●', text:'Supabase Connected', cls:'sync-connected'  },
    saving:     { dot:'●', text:'Saving…',             cls:'sync-saving'    },
    saved:      { dot:'●', text:'Saved',               cls:'sync-connected' },
    error:      { dot:'⚠', text:'Sync Error',      cls:'sync-error'     }
  }[state] || { dot:'●', text:String(state), cls:'' };
  el.className = 'sync-status ' + cfg.cls;
  el.textContent = cfg.dot + ' ' + cfg.text;
  el.title = detail || cfg.text;
}

// ═══════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════
// Startup order (deliberate — do not reorder):
//   Supabase client created (top of file, runs at parse time)
//   → Auth reports its initial state (signed in OR signed out — either
//     counts as "ready"; this is _onAuthReadyCallback below)
//   → Supabase data sync attached (startSync)
//   → the initial bulk read of every row has arrived (onReady)
//   → STATE is fully populated → UI/login screen shown
// Sync deliberately does NOT start until auth has reported at least once, so
// it never races a Row Level Security check against an unresolved auth
// token on a cold load.
function showBootError(msg) {
  const el = document.getElementById('boot-loading');
  if(!el || el.style.display === 'none') return;
  el.style.flexDirection = 'column';
  el.style.gap = '14px';
  el.style.padding = '24px';
  el.style.textAlign = 'center';
  el.style.color = '#B91C1C';
  el.textContent = '';
  const p = document.createElement('div');
  p.textContent = msg;
  const b = document.createElement('button');
  b.textContent = 'Reload';
  b.style.cssText = 'padding:8px 18px;border:0;border-radius:6px;background:#0B4EA2;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer';
  b.onclick = () => location.reload();
  el.append(p, b);
}

function init() {
  console.log('[SUPABASE] Initializing');
  setSyncStatus('connecting');
  const bootEl = document.getElementById('boot-loading');
  // Watchdog: if startup hasn't finished in 15s, say so instead of spinning forever.
  setTimeout(() => {
    if(bootEl && bootEl.style.display !== 'none') {
      showBootError('Startup is taking too long. Check your connection and that the Supabase project is active, then reload. (Details in the browser console, F12.)');
    }
  }, 15000);

  function beginSync() {
    // Signed out on a cold load: RLS would return ZERO rows for the anon role,
    // and the app would then treat that as "no data". So skip the read, show
    // the login screen, and let onAuthStateChange load data after sign-in.
    if(!_pendingAuthUser) {
      console.log('[SUPABASE] No session — showing login; data loads after sign-in');
      if(bootEl) bootEl.style.display = 'none';
      setSyncStatus('connecting', 'Sign in to load data');
      buildMonthPicker();
      showLogin();
      return;
    }
    console.log('[SUPABASE] Auth ready — starting data sync');
    startSync(() => {
      // Fires once, after the initial bulk read of every row has arrived.
      console.log('[SUPABASE] Initial data loaded');
      if(bootEl) bootEl.style.display = 'none';
      setSyncStatus('connected');
      // NOTE: auto-seeding on empty state was removed — it used to silently
      // overwrite real Supabase data with dummy employees/reports whenever
      // the app failed to load existing data (bad config, cold sync, etc.).
      // The app now shows normal empty states and data is added manually.
      buildMonthPicker();
      if(_pendingAuthUser !== undefined) resolveAuthUser(_pendingAuthUser);
      // else: onAuthStateChange hasn't reported yet — it will call
      // resolveAuthUser() itself the moment it does, since _initialLoadDone is now true.
    });
  }

  if(authReady) beginSync(); // auth already reported before DOMContentLoaded fired
  else _onAuthReadyCallback = beginSync;
}

document.addEventListener('DOMContentLoaded', init);
