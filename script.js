/* =====================================================================
   SNAP//QUICKADD — frontend
   - Real Snap Login Kit OAuth via the backend (/api/auth/*).
   - "Add" buttons open Snapchat's official add deep link (real add).
   - Discovery candidate data (mutuals/location/female) is simulated:
     Login Kit does NOT expose friends/location/gender.
   ===================================================================== */

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// escape user-controlled text before putting it in innerHTML
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- state (with light persistence) ---------- */
const SAVED = JSON.parse(localStorage.getItem('sqa') || '{}');
const state = {
  user: null,                                  // app account (email/password), from server
  auth: { connected: false, demo: false, profile: null }, // Snapchat connection
  funnel: SAVED.funnel || { added: 0, texting: 0, hangout: 0 }, // manually logged
  muted: SAVED.muted === true,           // sound effects off
  music: SAVED.music !== false,          // background music on by default
};

function persist() {
  localStorage.setItem('sqa', JSON.stringify({
    funnel: state.funnel,
    muted: state.muted,
    music: state.music,
  }));
}

function myName() {
  return state.user?.displayName || 'you';
}

/* ---------- toast ---------- */
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 250);
  }, 2400);
}

/* ===================================================================
   RETRO SOUND  (real .wav assets — one-shots via Web Audio, looped music)
   - `state.muted` toggles sound effects; `state.music` toggles the loop.
   - Files load + the context unlocks on the first user gesture.
   =================================================================== */
const sfx = (() => {
  let ctx = null, loaded = false, music = null;
  const buffers = {};
  // name → per-sound gain
  const ONESHOTS = { click: 0.4, hover: 0.25, select: 0.55, back: 0.55, coin: 0.5, powerup: 0.6, error: 0.5, start: 0.6 };

  const ac = () => {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return ctx;
  };

  async function ensure() {
    const c = ac(); if (!c) return;
    if (!loaded) {
      loaded = true;
      await Promise.all(Object.keys(ONESHOTS).map(async name => {
        try {
          const r = await fetch(`/sounds/${name}.wav`);
          buffers[name] = await c.decodeAudioData(await r.arrayBuffer());
        } catch { /* a missing clip just stays silent */ }
      }));
    }
    if (!music) { music = new Audio('/sounds/beat_loop.wav'); music.loop = true; music.volume = 0.3; }
  }

  function play(name) {
    if (state.muted) return;
    const c = ac(); if (!c) return;
    const buf = buffers[name]; if (!buf) return;
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = (ONESHOTS[name] ?? 0.5) * (window.__softSound ? 0.5 : 1);
    src.connect(g); g.connect(c.destination); src.start();
  }

  function syncMusic() {
    if (!music) return;
    if (state.music) music.play().catch(() => { /* needs a gesture first */ });
    else music.pause();
  }

  const api = { ensure, syncMusic };
  for (const name of Object.keys(ONESHOTS)) api[name] = () => play(name);
  return api;
})();

function applyAudioUI() {
  const mb = $('#muteBtn'); if (mb) mb.textContent = state.muted ? '🔇' : '🔊';
  const cb = $('#musicBtn'); if (cb) { cb.textContent = '🎵'; cb.classList.toggle('off', !state.music); }
}

$('#muteBtn').addEventListener('click', async () => {
  state.muted = !state.muted;
  persist(); applyAudioUI();
  if (!state.muted) { await sfx.ensure(); sfx.select(); }
});
$('#musicBtn').addEventListener('click', async () => {
  state.music = !state.music;
  persist(); applyAudioUI();
  await sfx.ensure(); sfx.syncMusic();
});

/* unlock audio + start music on the first interaction (autoplay policy) */
function primeAudio() { sfx.ensure().then(() => sfx.syncMusic()); }
window.addEventListener('pointerdown', primeAudio, { once: true });
window.addEventListener('keydown', primeAudio, { once: true });

/* event → sound mapping (add-buttons play their own coin in their handlers) */
document.addEventListener('click', e => {
  const t = e.target;
  if (t.closest('#muteBtn,#musicBtn,[data-add-user],[data-sb]')) return;
  if (t.closest('.back-btn, #logoutBtn, #qaddClear')) sfx.back();      // cancel / down
  else if (t.closest('#confirmBtn, .nav-card')) sfx.select();          // confirm / up
  else if (t.closest('button, a, .seg, .toggle, .board-tab, .step-btn, .auth-tab, .cand-rm')) sfx.click();
}, true);

/* hover ticks (desktop pointers only; one per button entered) */
let _lastHover = null;
document.addEventListener('pointerover', e => {
  if (e.pointerType === 'touch') return;
  const btn = e.target.closest('.nav-card, button, a, .seg, .toggle');
  if (btn) { if (btn !== _lastHover) { _lastHover = btn; sfx.hover(); } }
  else _lastHover = null;
}, true);

/* ===================================================================
   AUTH — talks to the backend OAuth endpoints
   =================================================================== */
async function refreshAuth() {
  try {
    const r = await fetch('/api/auth/status', { credentials: 'same-origin' });
    const data = await r.json();
    state.auth = {
      connected: !!data.connected,
      demo: !!data.demo,
      profile: data.profile || null,
    };
  } catch {
    state.auth = { connected: false, demo: false, profile: null };
  }
  applyAuthUI();
}

function applyAuthUI() {
  const { connected, demo } = state.auth;
  const s = $('#connStatus');
  s.textContent = connected ? (demo ? '● DEMO' : '● ONLINE') : '● OFFLINE';
  s.className = 'conn-status ' + (connected ? 'online' : 'offline');
  // login button reflects the APP account (see updateHeader), not Snap
  if (!$('[data-view="account"]').classList.contains('hidden')) renderAccount();
}

function startConnect() {
  // full-page redirect into the OAuth flow (or demo simulation)
  window.location.href = '/api/auth/login';
}
async function disconnect() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch { /* ignore */ }
  await refreshAuth();
  toast('Disconnected from Snapchat.');
}

/* surface OAuth callback results carried in the hash (#account&error=…) */
function consumeAuthHash() {
  const h = window.location.hash;
  const errMap = {
    denied: 'Snapchat permission was denied.',
    state: 'Login expired, try again.',
    token: 'Could not complete sign-in (token error).',
    network: 'Network error reaching Snapchat.',
  };
  const err = /[#&]error=([a-z]+)/.exec(h);
  const ok = /[#&]connected=(1|demo)/.exec(h);
  if (err) toast(errMap[err[1]] || 'Sign-in failed.');
  else if (ok) toast(ok[1] === 'demo' ? 'Connected (demo mode).' : 'Snapchat connected!');
  if (err || ok) history.replaceState(null, '', '#account');
}

/* ===================================================================
   ROUTING
   =================================================================== */
function go(view) {
  $$('.view').forEach(v => v.classList.toggle('hidden', v.dataset.view !== view));
  $$('.nav-card').forEach(c => c.classList.toggle('active', c.dataset.go === view));
  if (view === 'stats') renderStats();
  if (view === 'leaderboard') renderBoard(currentBoard);
  if (view === 'account') renderAccount();
  if (view === 'qadd') renderQadd();
  if (view === 'stacys') renderStacys();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-go]');
  if (t) { e.preventDefault(); go(t.dataset.go); }
});

/* ADD and Lookup are plain HTTPS anchors (see qaddCardHTML). We DON'T use the
   snapchat:// custom scheme, hidden iframes, window.open, target=_blank, or any
   timer-based "try app then fall back" chain — those cause the "open another
   app" warning and leftover blank tabs. The HTTPS universal link opens the
   Snapchat app directly on mobile (or the web profile if not installed), via a
   single user-gesture navigation in the same tab. */
const SNAP_ADD_URL = u => `https://www.snapchat.com/add/${encodeURIComponent(u)}`;
// Instagram provides NO public way to open the app's search box pre-filled with
// text. The best achievable: open the Instagram app directly and copy the name
// to the clipboard so it's a single paste into search. If the app isn't
// installed, the scheme just no-ops (name is still copied). Kept isolated.
const IG_APP_URL = 'instagram://app';

/* ===================================================================
   STATS
   =================================================================== */
// keep the funnel valid: texting ≤ added, hangout ≤ texting (so rates ≤ 100%)
function clampFunnel(f) {
  f.added = Math.max(0, f.added | 0);
  f.texting = Math.min(f.added, Math.max(0, f.texting | 0));
  f.hangout = Math.min(f.texting, Math.max(0, f.hangout | 0));
  return f;
}

function renderStats() {
  const f = clampFunnel(state.funnel);
  $('#valAdded').textContent = f.added;
  $('#valTexting').textContent = f.texting;
  $('#valHangout').textContent = f.hangout;
  $('#logHint').textContent = state.user
    ? 'Saved to your account for the leaderboard.'
    : 'Log in (Account) to rank on the leaderboard. Numbers are kept on this device for now.';

  const base = Math.max(f.added, 1);
  const steps = [
    { label: 'ADDED', count: f.added },
    { label: 'TEXTING', count: f.texting },
    { label: 'HANGOUT', count: f.hangout },
  ];
  $('#funnel').innerHTML = steps.map(s => {
    const pct = Math.round((s.count / base) * 100);
    return `
      <div class="funnel-row">
        <div class="fr-top"><span>${s.label}</span><span class="fr-count">${s.count}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="fr-rate">${pct}% of adds</div>
      </div>`;
  }).join('');

  const addToText = f.added ? Math.round((f.texting / f.added) * 100) : 0;
  const textToHang = f.texting ? Math.round((f.hangout / f.texting) * 100) : 0;
  const overall = f.added ? Math.round((f.hangout / f.added) * 100) : 0;
  $('#statCards').innerHTML = [
    { n: f.added, l: 'TOTAL QUICK ADDS' },
    { n: addToText + '%', l: 'ADD › TEXT RATE' },
    { n: textToHang + '%', l: 'TEXT › HANGOUT RATE' },
    { n: overall + '%', l: 'CONVERSION (HANGOUT)' },
  ].map(c => `<div class="stat-card"><div class="sc-num">${c.n}</div><div class="sc-label">${c.l}</div></div>`).join('');
}

/* push manually-logged stats to the server (debounced) when logged in */
let _statsTimer = null;
function saveStats() {
  persist();
  if (!state.user) return;
  clearTimeout(_statsTimer);
  _statsTimer = setTimeout(async () => {
    const { ok, data } = await api('/api/account/stats', state.funnel);
    if (ok && data.user) { state.user = data.user; refreshBoard(); }
  }, 400);
}

/* reconcile device funnel with the account on login:
   if the account has no stats yet but the device does, push the device's up;
   otherwise adopt the account's stored stats as the source of truth. */
function syncStats() {
  const s = state.user?.stats;
  if (!s) return;
  const serverEmpty = !s.added && !s.texting && !s.hangout;
  const localHas = state.funnel.added || state.funnel.texting || state.funnel.hangout;
  if (serverEmpty && localHas) saveStats();
  else { state.funnel = { ...s }; persist(); }
}

/* +/- steppers on the Stats view */
document.addEventListener('click', e => {
  const btn = e.target.closest('.step-btn');
  if (!btn) return;
  const stat = btn.closest('[data-stat]').dataset.stat;
  state.funnel[stat] = (state.funnel[stat] | 0) + (+btn.dataset.step);
  clampFunnel(state.funnel);
  renderStats();
  saveStats();
});

/* ===================================================================
   LEADERBOARD
   =================================================================== */
// real users only, fetched from the server. conversion = hangout / added.
let boardRows = [];
let currentBoard = 'rate';
const convPct = r => (r.added ? Math.round((r.hangout / r.added) * 100) : 0);

async function fetchBoard() {
  try {
    const r = await fetch('/api/leaderboard', { credentials: 'same-origin' });
    boardRows = (await r.json()).rows || [];
  } catch { boardRows = []; }
}

async function renderBoard(board) {
  currentBoard = board;
  $$('.board-tab').forEach(t => t.classList.toggle('active', t.dataset.board === board));
  $('#boardList').innerHTML = '<p class="empty-note">Loading leaderboard…</p>';   // loading state
  await fetchBoard();
  paintBoard();
}

function paintBoard() {
  const board = currentBoard;
  const rows = [...boardRows].sort((a, b) =>
    board === 'adds' ? (b.added - a.added) : (b.conversion - a.conversion || b.added - a.added));
  const meId = state.user?.id;

  $('#boardList').innerHTML = rows.length ? rows.map((r, i) => {
    const score = board === 'adds' ? `${r.added} adds` : `${convPct(r)}%`;
    const sub = board === 'adds' ? `${convPct(r)}% conversion` : `${r.added} adds · ${r.hangout} hangouts`;
    const me = r.id === meId;
    const name = esc(r.name || 'player');                     // other users' names → escape
    return `
      <div class="board-row ${me ? 'me' : ''}">
        <div class="board-rank">${i + 1}</div>
        <div class="avatar" style="background:hsl(${(i * 57) % 360} 70% 60%)">${esc((r.name || '?').slice(0, 2).toUpperCase())}</div>
        <div><div class="board-name">${name}${me ? ' (you)' : ''}</div><div class="board-sub">${sub}</div></div>
        <div class="board-score">${score}</div>
      </div>`;
  }).join('') : `<p class="empty-note">No ranked players yet — be the first to log your funnel.</p>`;

  let note = '';
  if (!state.user) note = 'Log in and log your funnel (Stats) to appear here.';
  else if (!rows.some(r => r.id === meId)) note = 'Log at least one Add on the Stats screen to rank.';
  $('#boardNote').textContent = note;
}

// rank-by-conversion position for the logged-in user (or null)
function myRank() {
  if (!state.user) return null;
  const sorted = [...boardRows].sort((a, b) => b.conversion - a.conversion || b.added - a.added);
  const i = sorted.findIndex(r => r.id === state.user.id);
  return i < 0 ? null : i + 1;
}

// refresh board data, repaint whatever's visible
async function refreshBoard() {
  await fetchBoard();
  if (!$('[data-view="leaderboard"]').classList.contains('hidden')) paintBoard();
  if (!$('[data-view="account"]').classList.contains('hidden')) renderAccount();
}

document.addEventListener('click', e => {
  const tab = e.target.closest('.board-tab');
  if (tab) renderBoard(tab.dataset.board);
});

/* ===================================================================
   ACCOUNT  (app login/signup + email verification + profile)
   =================================================================== */

/* ---- talk to the account API ---- */
async function fetchMe() {
  try {
    const r = await fetch('/api/account/me', { credentials: 'same-origin' });
    const data = await r.json();
    state.user = data.user || null;
  } catch {
    state.user = null;
  }
  syncStats();
  applySkins();
  updateHeader();
  if (!$('[data-view="account"]').classList.contains('hidden')) renderAccount();
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  let data = {};
  try { data = await r.json(); } catch { /* ignore */ }
  return { ok: r.ok, status: r.status, data };
}

// password rule mirrors the server: 8+ chars with at least one letter and number
const STRONG_PW = p => typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
const AUTH_ERRORS = {
  invalid_email: 'That email looks invalid.',
  weak_password: 'Password needs 8+ characters with at least one letter and one number.',
  email_taken: 'An account with that email already exists.',
  bad_credentials: 'Wrong email or password.',
  bad_current: 'Current password is incorrect.',
};

function showDevLink(url) {
  const el = $('#devVerifyLink');
  if (!url) { el.classList.add('hidden'); return; }
  el.innerHTML = `Dev mode (no email server): <a href="${url}">click to verify your email →</a>`;
  el.classList.remove('hidden');
}

/* ---- render the account view in the right mode ---- */
function renderAccount() {
  const loggedIn = !!state.user;
  $('#authPanel').classList.toggle('hidden', loggedIn);
  $('#profilePanel').classList.toggle('hidden', !loggedIn);
  if (!loggedIn) return;

  const u = state.user;
  const snap = state.auth;

  // verify banner
  $('#verifyBanner').classList.toggle('hidden', u.verified);
  if (u.verified) showDevLink(null);

  // avatar: Bitmoji from Snap when linked, else initials of display name
  const av = $('#profileAvatar');
  av.classList.remove('tappable'); delete av.dataset.shot;
  if (snap.connected && snap.profile?.avatar) {
    av.style.background = 'transparent';
    av.innerHTML = `<img src="${snap.profile.avatar}" alt="avatar" />`;
    av.classList.add('tappable'); av.dataset.shot = snap.profile.avatar;  // own pic → lightbox
  } else {
    av.style.background = 'hsl(0 70% 60%)';
    av.textContent = (u.displayName || u.email).slice(0, 2).toUpperCase();
  }

  // inline name + email
  if (document.activeElement !== $('#nameInput')) $('#nameInput').value = u.displayName || '';
  $('#profileEmail').textContent = u.email + (u.verified ? ' ✓' : ' (unverified)');

  // rank (by conversion) + stat cards
  const rank = myRank();
  $('#profileRank').textContent = rank ? `RANK #${rank} BY CONVERSION` : 'UNRANKED';
  const f = state.funnel;
  const rate = f.added ? Math.round((f.hangout / f.added) * 100) : 0;
  $('#profileStats').innerHTML = [
    { n: f.added, l: 'QUICK ADDS' },
    { n: f.texting, l: 'TEXTING' },
    { n: f.hangout, l: 'HANGOUTS' },
    { n: rate + '%', l: 'HANGOUT RATE' },
  ].map(c => `<div class="stat-card"><div class="sc-num">${c.n}</div><div class="sc-label">${c.l}</div></div>`).join('');

  // Snapchat connection row
  const row = $('#snapConnRow'), text = $('#snapConnText'), cbtn = $('#snapConnBtn');
  if (snap.connected) {
    row.classList.add('linked');
    text.textContent = snap.demo
      ? `Connected (demo) as ${snap.profile?.displayName || 'Demo'}`
      : `Connected as ${snap.profile?.displayName || 'Snapchatter'}`;
    cbtn.textContent = 'Disconnect';
    cbtn.classList.add('danger');
  } else {
    row.classList.remove('linked');
    text.textContent = 'Not connected';
    cbtn.textContent = 'Connect';
    cbtn.classList.remove('danger');
  }

  renderProgression(u);
}

/* ---------- level / XP / streak / weekly / achievements / skins / share ---------- */
function renderProgression(u) {
  // level + rank + XP bar
  $('#progLevel').textContent = `LV ${u.level || 1}`;
  $('#progRank').textContent = u.rank || 'ROOKIE';
  const inLvl = u.xpInLevel || 0, forNext = u.xpForNext || 100;
  $('#xpBar').style.width = `${Math.round((inLvl / forNext) * 100)}%`;
  $('#xpLabel').textContent = `${inLvl} / ${forNext} XP`;

  // streak + at-risk warning
  const st = u.streak || { count: 0, lastDay: null };
  $('#streakNum').textContent = st.count || 0;
  const today = new Date().toLocaleDateString('en-CA');
  const atRisk = st.count > 0 && st.lastDay && st.lastDay !== today;
  const warn = $('#streakWarn');
  warn.classList.toggle('hidden', !atRisk);
  if (atRisk) warn.textContent = `🔥 Add or skip someone today to keep your ${st.count}-day streak!`;
  $('#progEncourage').textContent = st.count >= 2 ? `${st.count} days strong — keep it rolling.` : 'Welcome back — nice to see you.';

  // weekly summary
  const w = u.weekly || { adds: 0, newMutuals: 0, xpGained: 0, streak: 0 };
  $('#weeklyCards').innerHTML = [
    { n: w.adds, l: 'ADDS' }, { n: w.newMutuals, l: 'NEW MUTUALS' },
    { n: w.xpGained, l: 'XP GAINED' }, { n: w.streak, l: 'STREAK' },
  ].map(c => `<div class="stat-card"><div class="sc-num">${c.n}</div><div class="sc-label">${c.l}</div></div>`).join('');

  // achievements
  const earned = new Set(u.achievements || []);
  $('#achGrid').innerHTML = (u.achievementDefs || []).map(a => `
    <div class="ach ${earned.has(a.id) ? 'earned' : 'locked'}" title="${a.desc}">
      <div class="ach-ic">${earned.has(a.id) ? '🏅' : '🔒'}</div>
      <div class="ach-name">${a.name}</div>
    </div>`).join('');

  // skins chooser
  const sk = u.skins || { active: {}, unlocked: {}, catalog: {} };
  $('#skinChooser').innerHTML = Object.keys(sk.catalog || {}).map(cat => {
    const opts = sk.catalog[cat].map(s => {
      const unlocked = (sk.unlocked[cat] || []).includes(s.id);
      const active = sk.active[cat] === s.id;
      return `<button class="seg ${active ? 'on' : ''} ${unlocked ? '' : 'locked'}" data-skin-cat="${cat}" data-skin="${s.id}" ${unlocked ? '' : 'disabled'}>${s.name}${unlocked ? '' : ` 🔒L${s.unlock}`}</button>`;
    }).join('');
    return `<div class="mc-group"><span class="mc-label">${cat}</span><div class="segmented skin-seg">${opts}</div></div>`;
  }).join('');

  // share link + QR
  if (document.activeElement !== $('#snapUserInput')) $('#snapUserInput').value = u.share?.snapUsername || '';
  const box = $('#shareBox');
  if (u.share?.addUrl) {
    box.classList.remove('hidden');
    $('#shareLink').textContent = u.share.addUrl;
    $('#shareLink').href = u.share.addUrl;
    $('#shareQR').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(u.share.addUrl)}`;
  } else box.classList.add('hidden');

  // your groups
  if (document.activeElement !== $('#groupsInput')) $('#groupsInput').value = (u.groups || []).join(', ');

  // public-profile toggle
  $('#publicToggle').classList.toggle('on', !!u.isPublic);
  $('#publicHint').textContent = u.isPublic
    ? 'ON — people who add you can see your display name and groups.'
    : 'OFF — your profile is private; no one sees your name or groups.';
}

/* account-page progression controls */
$('#snapUserSave').addEventListener('click', async () => {
  const v = $('#snapUserInput').value.trim().replace(/^@/, '').toLowerCase();
  const { ok, data } = await api('/api/account/snap-username', { username: v });
  if (!ok) { sfx.error(); toast('Enter a valid Snapchat username.'); return; }
  state.user = data.user; sfx.select(); renderAccount(); toast('Add link ready.');
});
$('#shareCopy').addEventListener('click', () => {
  const url = state.user?.share?.addUrl; if (!url) return;
  if (copyText(url)) { toast('Link copied!'); sfx.select(); } else toast(url);
});
$('#groupsSave').addEventListener('click', async () => {
  const groups = $('#groupsInput').value.split(',').map(s => s.trim()).filter(Boolean);
  const { ok, data } = await api('/api/account/groups', { groups });
  if (ok) { state.user = data.user; sfx.select(); renderAccount(); toast('Groups saved.'); }
});
$('#publicToggle').addEventListener('click', async () => {
  const next = !state.user?.isPublic;
  const { ok, data } = await api('/api/account/public', { public: next });
  if (ok) { state.user = data.user; sfx.select(); renderAccount(); toast(next ? 'Profile is now public.' : 'Profile is now private.'); }
});
$('#pwForm').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#pwMsg'); msg.classList.add('hidden');
  const next = $('#pwNext').value;
  if (!STRONG_PW(next)) { msg.textContent = AUTH_ERRORS.weak_password; msg.classList.remove('hidden'); sfx.error(); return; }
  const { ok, data } = await api('/api/account/password', { current: $('#pwCurrent').value, next });
  if (!ok) { msg.textContent = AUTH_ERRORS[data.error] || 'Could not change password.'; msg.classList.remove('hidden'); sfx.error(); return; }
  state.user = data.user;
  $('#pwForm').reset();
  sfx.powerup(); toast('Password updated.');
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-skin-cat]');
  if (!b || b.disabled) return;
  const { ok, data } = await api('/api/account/skin', { category: b.dataset.skinCat, value: b.dataset.skin });
  if (!ok) { sfx.error(); toast('Locked — level up to unlock.'); return; }
  state.user = data.user; sfx.powerup(); applySkins(); renderAccount();
});

/* show OAuth-style verify results carried back in the hash */
function consumeVerifyHash() {
  const h = window.location.hash;
  const m = /[#&]verify=(ok|expired|bad)/.exec(h);
  if (!m) return;
  const msg = { ok: 'Email verified! 🎉', expired: 'Verification link expired — resend it.', bad: 'Invalid verification link.' };
  if (m[1] === 'ok') sfx.powerup(); else sfx.error();
  toast(msg[m[1]]);
  history.replaceState(null, '', '#account');
}

/* header: connection dot (Snap) + login button (app account) */
function updateHeader() {
  const lb = $('#loginButton');
  if (state.user) {
    lb.textContent = (state.user.displayName || 'account').toUpperCase();
  } else {
    lb.textContent = 'LOG IN';
  }
}

/* ---- bind all account + auth controls once ---- */
function bindAccountActions() {
  // login / signup tab toggle
  $$('.auth-tab').forEach(tab => tab.addEventListener('click', () => {
    const which = tab.dataset.auth;
    $$('.auth-tab').forEach(t => t.classList.toggle('active', t === tab));
    $('#loginForm').classList.toggle('hidden', which !== 'login');
    $('#signupForm').classList.toggle('hidden', which !== 'signup');
  }));

  // log in
  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#loginMsg'); msg.classList.add('hidden');
    const { ok, data } = await api('/api/account/login', {
      email: $('#loginEmail').value, password: $('#loginPass').value,
    });
    if (!ok) { msg.textContent = AUTH_ERRORS[data.error] || 'Login failed.'; msg.classList.remove('hidden'); return; }
    state.user = data.user;
    $('#loginPass').value = '';
    syncStats(); refreshBoard();
    updateHeader(); renderAccount();
    sfx.select();
    toast(`Welcome back, ${state.user.displayName}.`);
  });

  // sign up
  $('#signupForm').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#signupMsg'); msg.classList.add('hidden');
    const email = $('#suEmail').value, password = $('#suPass').value;
    // client-side validation (server re-checks)
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = AUTH_ERRORS.invalid_email; msg.classList.remove('hidden'); sfx.error(); return; }
    if (!STRONG_PW(password)) { msg.textContent = AUTH_ERRORS.weak_password; msg.classList.remove('hidden'); sfx.error(); return; }
    const { ok, data } = await api('/api/account/signup', {
      email, password, displayName: $('#suName').value,
    });
    if (!ok) { msg.textContent = AUTH_ERRORS[data.error] || 'Sign-up failed.'; msg.classList.remove('hidden'); return; }
    state.user = data.user;
    $('#suPass').value = '';
    syncStats(); refreshBoard();
    updateHeader(); renderAccount();
    if (data.devVerifyUrl) showDevLink(data.devVerifyUrl);
    sfx.powerup();
    toast('Account created — check your email to verify.');
  });

  // inline display-name save
  $('#saveNameBtn').addEventListener('click', async () => {
    const name = $('#nameInput').value.trim();
    if (!name) { toast('Name can’t be empty.'); return; }
    const { ok, data } = await api('/api/account/profile', { displayName: name });
    if (!ok) { toast('Could not save name.'); return; }
    state.user = data.user;
    updateHeader(); renderAccount();
    toast('Name updated.');
  });
  $('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#saveNameBtn').click(); } });

  // resend verification
  $('#resendVerifyBtn').addEventListener('click', async () => {
    const { ok, data } = await api('/api/account/resend', {});
    if (!ok) { toast('Could not resend.'); return; }
    if (data.alreadyVerified) { state.user.verified = true; renderAccount(); toast('Already verified.'); return; }
    if (data.devVerifyUrl) showDevLink(data.devVerifyUrl);
    toast('Verification link sent.');
  });

  // Snapchat connect / disconnect
  $('#snapConnBtn').addEventListener('click', () => {
    if (state.auth.connected) disconnect();
    else startConnect();
  });

  // log out (clears app session + Snap link for this session)
  $('#logoutBtn').addEventListener('click', async () => {
    await api('/api/account/logout', {});
    state.user = null;
    state.auth = { connected: false, demo: false, profile: null };
    updateHeader(); applyAuthUI(); renderAccount();
    toast('Logged out.');
  });
}

/* header buttons */
$('#connectButton').addEventListener('click', startConnect);
$('#loginButton').addEventListener('click', () => go('account'));

/* ===================================================================
   QUICK ADD SCANNER  (screenshot + scrolling video → vision model)
   PRIVACY: frames are sampled in-browser and sent only to the vision
   model (via our server, which never writes them to disk). Neither the
   image/video nor the extracted third-party usernames are persisted.
   Pipeline: capture → preprocess → extract → CONFIRM/EDIT → ADD → discard.
   =================================================================== */

const RE_USERNAME = /^[a-z][a-z0-9._-]{2,14}$/;  // Snapchat username shape

// candidates = pre-confirm editable list; qaddEntries = confirmed add list.
// Both are transient — never persisted.
let candidates = [];
let qaddEntries = [];
let scanBusy = false;
let queueTotal = 0, queueAdded = 0;   // add-queue progress
let skipStack = [];                   // left-swiped people, for undo

/* ---------- feel: haptics, encouragement, skins, never-show set ---------- */
function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch { /* unsupported */ } }

const ENCOURAGE = [
  'Nice — momentum looks good.', 'Smooth. Keep that energy.', 'Every add is a new door.',
  'You\'re building something here.', 'Great pace — proud of that.', 'Little by little adds up.',
  'That\'s the way.', 'Love to see it.',
];
const encourage = () => ENCOURAGE[Math.floor(Math.random() * ENCOURAGE.length)];

// usernames the user already added or skipped — never show again
function seenSet() {
  const s = state.user?.seen;
  return new Set([...(s?.added || []), ...(s?.skipped || [])]);
}

// SUPERBAD marks (the user's own private flags)
function superbadList() { return state.user?.superbad || []; }
function isSuperbad(username) { return superbadList().some(p => p.username === username); }

// apply the active card/theme skin to <body>; soft sound pack lowers volume
function applySkins() {
  const a = state.user?.skins?.active || { theme: 'red', card: 'default', sound: 'arcade' };
  document.body.className = `theme-${a.theme} skin-${a.card}`;
  window.__softSound = a.sound === 'soft';
}

/* ---------- progress UI ---------- */
function showProgress(msg, frac) {
  $('#scanProgress').classList.remove('hidden');
  $('#scanStatus').textContent = msg || '';
  $('#scanBar').style.width = `${Math.round((frac || 0) * 100)}%`;
}
function hideProgress() { $('#scanProgress').classList.add('hidden'); }

/* ---------- preprocess for the vision model ----------
   Upscale small captures so text is legible, cap large ones for cost, and
   apply a light contrast boost. The vision model handles dark/light themes
   natively, so no inversion is needed. Returns the prepared canvas — we both
   send its JPEG to the model AND crop avatars out of it (coords match). */
function visionCanvas(source, sw, sh) {
  const longest = Math.max(sw, sh);
  let scale = 1;
  if (longest < 1100) scale = Math.min(2.5, 1500 / longest);  // upscale small
  else if (longest > 1568) scale = 1568 / longest;            // cap big (cost)
  const w = Math.round(sw * scale), h = Math.round(sh * scale);

  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, w, h);

  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data, k = 1.15, mid = 128;        // mild contrast
  for (let i = 0; i < d.length; i += 4) {
    for (let j = 0; j < 3; j++) {
      let v = (d[i + j] - mid) * k + mid;
      d[i + j] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

/* crop a square avatar thumbnail from the vision canvas using the model's
   normalized bounding box; returns a small JPEG data URL (or null). */
function cropAvatar(canvas, box) {
  if (!canvas || !box) return null;
  const W = canvas.width, H = canvas.height;
  const pw = (box.w || 0) * W, ph = (box.h || 0) * H;
  if (pw < 8 || ph < 8) return null;                       // no/too-small box
  const side = Math.min(Math.max(pw, ph), Math.min(W, H)); // square, clamped
  const cx = (box.x || 0) * W + pw / 2, cy = (box.y || 0) * H + ph / 2;
  const sx = Math.max(0, Math.min(W - side, cx - side / 2));
  const sy = Math.max(0, Math.min(H - side, cy - side / 2));
  const out = document.createElement('canvas');
  out.width = out.height = 96;
  out.getContext('2d').drawImage(canvas, sx, sy, side, side, 0, 0, 96, 96);
  try { return out.toDataURL('image/jpeg', 0.85); } catch { return null; }
}

function fileToVisionCanvas(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(visionCanvas(img, img.naturalWidth, img.naturalHeight));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

/* ---------- call the vision endpoint ---------- */
async function extractFromDataURL(dataURL) {
  const r = await fetch('/api/scan/extract', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataURL }),
  });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `http_${r.status}`);
  }
  return (await r.json()).usernames || [];
}

/* ---------- merge extracted usernames into the candidate list ----------
   carries the exact mutual count (0 = unknown) and a cropped avatar. */
function mergeCandidates(found, sourceCanvas) {
  const seen = seenSet();
  for (const f of found) {
    const u = String(f.username || '').replace(/^@/, '').toLowerCase();
    if (!RE_USERNAME.test(u)) continue;
    if (seen.has(u)) continue;          // never show added/skipped people again
    const mutual = Math.max(0, Math.floor(Number(f.mutual) || 0));   // 0 = unknown
    const avatar = sourceCanvas ? cropAvatar(sourceCanvas, f.box) : null;
    const name = String(f.name || '').trim();                        // display name (ephemeral)
    const existing = candidates.find(c => c.username === u);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, f.confidence || 0);
      existing.mutual = Math.max(existing.mutual || 0, mutual);       // keep the real count
      if (!existing.avatar && avatar) existing.avatar = avatar;
      if (!existing.name && name) existing.name = name;
    } else {
      candidates.push({ username: u, confidence: f.confidence || 0, mutual, avatar, name, include: true });
    }
  }
}

/* ---------- video → stable, de-duplicated frames (in-browser) ----------
   Sample the timeline; keep frames where the scroll is momentarily still
   (low diff vs the previous sample = not mid-scroll motion-blur) AND the
   screen differs from the last kept frame (not a duplicate). Cap for cost. */
async function extractVideoFrames(file, onProgress) {
  const STEP = 0.25, STABLE = 0.02, DUP = 0.06, MAX_FRAMES = 12;
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.src = url;

  await new Promise((res, rej) => {
    video.onloadedmetadata = () => res();
    video.onerror = () => rej(new Error('video_decode'));
  });
  const duration = isFinite(video.duration) ? video.duration : 0;
  const W = video.videoWidth, H = video.videoHeight;
  if (!duration || !W) { URL.revokeObjectURL(url); throw new Error('video_meta'); }

  // tiny grayscale signature for cheap frame-diffing
  const sc = document.createElement('canvas'); sc.width = 32; sc.height = 64;
  const sctx = sc.getContext('2d', { willReadFrequently: true });
  const sig = () => { sctx.drawImage(video, 0, 0, 32, 64); return sctx.getImageData(0, 0, 32, 64).data; };
  const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i] - b[i]); return s / (a.length / 4) / 255; };
  const seek = t => new Promise(r => {
    const h = () => { video.removeEventListener('seeked', h); r(); };
    video.addEventListener('seeked', h);
    video.currentTime = Math.min(t, duration - 0.01);
  });

  const full = document.createElement('canvas'); full.width = W; full.height = H;
  const fctx = full.getContext('2d');
  const kept = [];
  let prevSig = null, lastKeptSig = null;

  for (let t = 0; t <= duration && kept.length < MAX_FRAMES; t += STEP) {
    await seek(t);
    const s = sig();
    const consec = prevSig ? diff(s, prevSig) : 0;      // 0 => first frame is "still"
    const keptDiff = lastKeptSig ? diff(s, lastKeptSig) : 1;
    if (consec < STABLE && keptDiff > DUP) {
      fctx.drawImage(video, 0, 0, W, H);
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      c.getContext('2d').drawImage(full, 0, 0);
      kept.push(c);
      lastKeptSig = s;
    }
    prevSig = s;
    onProgress && onProgress(Math.min(1, t / duration), kept.length);
  }
  URL.revokeObjectURL(url);
  return kept;
}

/* ---------- top-level handlers ---------- */
// new upload → show confirm, keep existing candidates so multiple
// screenshots/videos MERGE into one deduplicated list
function beginScan() {
  $('#qaddResults').classList.add('hidden');
  $('#confirmPanel').classList.remove('hidden');
}
// Restart → wipe everything
function fullReset() {
  candidates = [];
  qaddEntries = [];
  skipStack = [];
  queueTotal = queueAdded = 0;
  renderCandidates();
  $('#qaddResults').classList.add('hidden');
  $('#confirmPanel').classList.remove('hidden');
  hideProgress();
}

function scanError(err) {
  hideProgress();
  sfx.error();
  const map = {
    no_api_key: 'Scanner isn’t configured (no API key). You can still add usernames by hand below.',
    bad_image: 'That image couldn’t be read — try another, or add by hand.',
    extract_failed: 'The scanner couldn’t read that. Try a clearer capture, or add by hand.',
    no_frames: 'Couldn’t find any steady frames — film a slower scroll, or use a screenshot.',
    video_decode: 'Couldn’t open that video. Try a screenshot instead.',
    video_meta: 'That video format isn’t supported here. Try a screenshot.',
  };
  toast(map[err?.message] || 'Scan failed — add usernames by hand below.');
  $('#confirmPanel').classList.remove('hidden');
}

async function handleScreenshot(file) {
  if (!file || scanBusy) return;
  scanBusy = true;
  beginScan();
  sfx.start();
  try {
    showProgress('Reading screenshot…', 0.3);
    const canvas = await fileToVisionCanvas(file);
    const found = await extractFromDataURL(canvas.toDataURL('image/jpeg', 0.85));
    mergeCandidates(found, canvas);
    renderCandidates();
    hideProgress();
    if (candidates.length) sfx.powerup();
    toast(found.length ? `Found ${candidates.length} username${candidates.length === 1 ? '' : 's'} — confirm below.` : 'No usernames found — add by hand.');
  } catch (err) {
    console.error('[scan] screenshot:', err);
    scanError(err);
  } finally {
    scanBusy = false;
    $('#shotFile').value = '';
  }
}

async function handleVideo(file) {
  if (!file || scanBusy) return;
  scanBusy = true;
  beginScan();
  sfx.start();
  try {
    showProgress('Scanning video for steady frames…', 0.05);
    const frames = await extractVideoFrames(file, (p, n) =>
      showProgress(`Scanning video… found ${n} screen${n === 1 ? '' : 's'}`, p * 0.5));
    if (!frames.length) throw new Error('no_frames');

    for (let i = 0; i < frames.length; i++) {
      showProgress(`Reading screen ${i + 1} of ${frames.length}…`, 0.5 + (i / frames.length) * 0.5);
      const vc = visionCanvas(frames[i], frames[i].width, frames[i].height);
      try { mergeCandidates(await extractFromDataURL(vc.toDataURL('image/jpeg', 0.85)), vc); }
      catch (e) { if (e.message === 'no_api_key') throw e; /* skip a bad frame */ }
      renderCandidates(); // incremental — list fills as frames are read
    }
    hideProgress();
    if (candidates.length) sfx.powerup();
    toast(candidates.length ? `Found ${candidates.length} username${candidates.length === 1 ? '' : 's'} — confirm below.` : 'No usernames found — add by hand.');
  } catch (err) {
    console.error('[scan] video:', err);
    scanError(err);
  } finally {
    scanBusy = false;
    $('#vidFile').value = '';
  }
}

/* ---------- CONFIRM / EDIT list ---------- */
function candRowHTML(c, i) {
  const valid = RE_USERNAME.test(c.username);
  const conf = c.confidence >= 0.85 ? 'high' : c.confidence >= 0.6 ? 'med' : 'low';
  const hue = (c.username.charCodeAt(0) * 13 + c.username.length * 29) % 360;
  const av = c.avatar
    ? `<div class="cand-av"><img src="${c.avatar}" alt=""></div>`
    : `<div class="cand-av" style="background:hsl(${hue} 70% 60%)">${c.username.slice(0, 2).toUpperCase()}</div>`;
  const mut = c.mutual > 0 ? `<span class="cand-mut">${c.mutual}🤝</span>` : '';
  return `
    <div class="cand-row" data-i="${i}">
      <input type="checkbox" ${c.include !== false && valid ? 'checked' : ''} />
      ${av}
      <input type="text" class="cand-input ${valid ? '' : 'invalid'}" value="${c.username}" maxlength="15" inputmode="latin" />
      ${mut}
      <span class="conf-dot ${conf}" title="read confidence"></span>
      <button type="button" class="cand-rm" title="remove">✕</button>
    </div>`;
}

function renderCandidates() {
  const list = $('#candList');
  list.innerHTML = candidates.length
    ? candidates.map(candRowHTML).join('')
    : `<p class="empty-note cand-empty">No usernames yet — upload a screenshot or video above, or add one by hand.</p>`;
  $('#candCount').textContent = candidates.length;
}

// pull current DOM state back into the candidates array before any rebuild
function syncFromDOM() {
  const rows = $$('#candList .cand-row');
  rows.forEach((row, i) => {
    if (!candidates[i]) return;
    candidates[i].username = row.querySelector('.cand-input').value.trim().replace(/^@/, '').toLowerCase();
    candidates[i].include = row.querySelector('input[type="checkbox"]').checked;
  });
}

// live validity styling as the user edits a handle
document.addEventListener('input', e => {
  const inp = e.target.closest('.cand-input');
  if (!inp) return;
  const u = inp.value.trim().replace(/^@/, '').toLowerCase();
  inp.classList.toggle('invalid', !RE_USERNAME.test(u));
});

// remove a candidate row
document.addEventListener('click', e => {
  const rm = e.target.closest('.cand-rm');
  if (!rm) return;
  const i = +rm.closest('.cand-row').dataset.i;
  syncFromDOM();
  candidates.splice(i, 1);
  renderCandidates();
});

/* manual add — works even if the scanner is unconfigured or missed someone */
$('#manualAddForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#manualAddInput');
  const u = input.value.trim().replace(/^@/, '').toLowerCase();
  if (!RE_USERNAME.test(u)) { toast('Enter a valid username (3–15 chars).'); return; }
  syncFromDOM();
  if (!candidates.some(c => c.username === u)) {
    candidates.push({ username: u, confidence: 1, mutual: 0, avatar: null, name: '', include: true });
  }
  input.value = '';
  renderCandidates();
});

/* CONFIRM → build the add queue (sorted most-mutuals-first, never-show applied) */
$('#confirmBtn').addEventListener('click', () => {
  syncFromDOM();
  const seen = seenSet(), dedupe = new Set();
  qaddEntries = [];
  for (const c of candidates) {
    const u = c.username;
    if (c.include !== false && RE_USERNAME.test(u) && !seen.has(u) && !dedupe.has(u)) {
      dedupe.add(u);
      qaddEntries.push({ username: u, mutual: c.mutual || 0, avatar: c.avatar || null, name: c.name || '' });
    }
  }
  if (!qaddEntries.length) { toast('Check at least one valid username.'); return; }
  const rank = m => (m > 0 ? m : -1);
  qaddEntries.sort((a, b) => rank(b.mutual) - rank(a.mutual));   // most mutuals first
  queueTotal = qaddEntries.length;
  queueAdded = 0;
  skipStack = [];
  $('#confirmPanel').classList.add('hidden');
  renderQadd();
});

/* ---------- swipeable add-queue cards ---------- */
function personCardHTML(entry, idx, opts = {}) {
  const initials = entry.username.slice(0, 2).toUpperCase();
  const hue = (entry.username.charCodeAt(0) * 13 + entry.username.length * 29) % 360;
  const av = entry.avatar
    ? `<div class="avatar tappable" data-shot="${entry.avatar}"><img src="${entry.avatar}" alt=""></div>`
    : `<div class="avatar" style="background:hsl(${hue} 70% 60%)">${initials}</div>`;
  const mutualText = entry.mutual > 0
    ? `${entry.mutual} mutual friend${entry.mutual === 1 ? '' : 's'}`
    : 'mutuals unknown';
  const nameLine = entry.name ? `<div class="result-name">${esc(entry.name)}</div>` : '';
  const sbOn = isSuperbad(entry.username);
  // STACY'S flag toggle — clear on/off visual
  const sbBtn = `<button class="sb-btn ${sbOn ? 'on' : ''}" data-sb="${entry.username}" data-sb-name="${esc(entry.name || '')}" title="Add to STACY'S">${sbOn ? '★ STACY\'S' : '☆ MARK'}</button>`;
  // IG lookup only when a name exists — plain https anchor, no scheme/new tab
  const lookup = entry.name
    ? `<a class="ig-lookup" href="${IG_APP_URL}" data-ig-name="${esc(entry.name)}" rel="noopener" title="Open Instagram — name copied to paste in search">🔎 IG</a>`
    : '';
  // ADD — plain https universal link anchor (single same-tab nav, no scheme)
  const add = opts.noAdd ? '' :
    `<a class="add-btn" data-add-user="${entry.username}" href="${SNAP_ADD_URL(entry.username)}" rel="noopener">+ ADD</a>`;
  const cls = opts.swipe ? 'result-card swipe-card' : 'result-card';
  return `
    <div class="${cls}" data-id="${idx}" data-mutual="${entry.mutual}" data-user="${entry.username}">
      ${av}
      <div class="result-details">
        <strong>@${entry.username}</strong>
        ${nameLine}
        <div class="result-meta">${mutualText}<span class="shared-grp" data-groups-for="${entry.username}"></span></div>
      </div>
      <div class="card-actions">
        ${sbBtn}${lookup}${add}
      </div>
    </div>`;
}
const qaddCardHTML = (entry, idx) => personCardHTML(entry, idx, { swipe: true });

function renderQadd() {
  $('#qaddList').innerHTML = qaddEntries.map(qaddCardHTML).join('');
  $('#qaddResults').classList.toggle('hidden', qaddEntries.length === 0 && queueAdded === 0);
  $('#queueDone').classList.add('hidden');
  $('#undoSkipBtn').classList.toggle('hidden', skipStack.length === 0);
  updateQueueProgress();
  enrichGroups();   // fill in group info from our own data (see §groups)
}

function updateQueueProgress() {
  const total = Math.max(queueTotal, 1);
  $('#queueProgress').textContent = `${queueAdded} of ${queueTotal}`;
  $('#queueBar').style.width = `${Math.round((queueAdded / total) * 100)}%`;
}

// smoothly collapse a card out of the list (others slide up via CSS transition)
function dismissCard(card, dir) {
  card.style.pointerEvents = 'none';
  card.classList.add(dir === 'left' ? 'swiped-left' : 'swiped-right');
  card.addEventListener('transitionend', () => {
    card.remove();
    if (!$('#qaddList').children.length) finishQueue();
  }, { once: true });
}

function finishQueue() {
  if (queueAdded > 0) { sfx.powerup(); $('#queueDone').textContent = `${encourage()} ${queueAdded} added 🎉`; $('#queueDone').classList.remove('hidden'); }
}

/* record an add/skip action on the server (progression) when logged in.
   keepalive:true so the POST still completes if the ADD anchor navigates away. */
async function recordAction(type, username, mutual) {
  if (!state.user) return null;
  const day = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD local
  let data = {};
  try {
    const r = await fetch('/api/account/action', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, username, mutual, day }),
    });
    data = await r.json();
  } catch { return null; }
  if (data.user) {
    state.user = data.user;
    applySkins();
    if (data.leveledUp) { sfx.powerup(); toast(`Level up! LV ${state.user.level} — ${state.user.rank} 🎉`); }
    for (const id of (data.newAchievements || [])) {
      const def = (state.user.achievementDefs || []).find(d => d.id === id);
      if (def) { sfx.powerup(); toast(`🏅 Achievement: ${def.name}`); }
    }
    if (!$('[data-view="account"]').classList.contains('hidden')) renderAccount();
  }
  return data;
}

/* ADD is a plain <a href> universal link — let it navigate (no preventDefault,
   no scheme, no new tab). We only fire side-effects on the same tap. */
document.addEventListener('click', e => {
  const a = e.target.closest('#qaddList a.add-btn[data-add-user]');
  if (!a) return;
  const card = a.closest('.swipe-card');
  const user = a.dataset.addUser;
  const mutual = +card?.dataset.mutual || 0;
  sfx.coin(); buzz(30);
  const entry = qaddEntries.find(x => x.username === user);
  if (entry) qaddEntries = qaddEntries.filter(x => x !== entry);
  queueAdded++;
  updateQueueProgress();
  recordAction('add', user, mutual);
  if (card) dismissCard(card, 'right');
  // the anchor's default navigation opens Snapchat (universal link) in this tab
});

/* Lookup IG — copy the name to clipboard, then let the anchor open the
   Instagram app (instagram://). Single same-tab nav, no window.open / new tab.
   Instagram can't accept a pre-filled search query from outside the app, so the
   copied name means it's just one paste into IG's search box. */
document.addEventListener('click', e => {
  const a = e.target.closest('a.ig-lookup');
  if (!a) return;
  const name = a.dataset.igName;
  const ok = copyText(name);
  toast(ok ? 'Name copied — paste it into Instagram search 📋' : `Couldn't copy — name: ${name}`);
});

/* clipboard copy that also works on non-secure (http) origins, where
   navigator.clipboard is unavailable — falls back to a hidden textarea. */
function copyText(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
    return true;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(ta);
    ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* STACY'S flag toggle (event-delegated — works on every list) */
function paintSbButtons(username, on) {
  $$(`[data-sb="${CSS.escape(username)}"]`).forEach(btn => {
    btn.classList.toggle('on', on);
    btn.textContent = on ? '★ STACY\'S' : '☆ MARK';
  });
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-sb]');
  if (!b) return;
  if (!state.user) { sfx.error(); toast('Log in on the Account page to mark people.'); go('account'); return; }
  const username = b.dataset.sb;
  const wasOn = isSuperbad(username);

  // confirm before removing someone from the STACY'S panel
  if (wasOn && b.closest('#sbList')) {
    sfx.click();
    const ok = await askConfirm(`Remove @${username} from STACY'S?`, 'Remove');
    if (!ok) return;
  }
  sfx.select(); buzz(12);

  // optimistic toggle so it feels instant
  paintSbButtons(username, !wasOn);

  // grab the cropped avatar from the rendered card (if any) to store with the mark
  const avatar = b.closest('.result-card')?.querySelector('.avatar img')?.getAttribute('src') || '';
  const { ok, data } = await api('/api/account/superbad', {
    username, name: b.dataset.sbName || '', avatar,
  });
  if (!ok || !data.user) {
    paintSbButtons(username, wasOn);   // revert on failure
    sfx.error(); toast('Could not save — try again.');
    return;
  }
  state.user = data.user;
  paintSbButtons(username, isSuperbad(username));
  toast(wasOn ? `Removed @${username} from STACY'S` : `★ @${username} added to STACY'S`);
  if (!$('[data-view="stacys"]').classList.contains('hidden')) renderStacys();
});

/* ---------- swipe-left-to-skip on queue cards ---------- */
function skipCard(card) {
  const user = card.dataset.user;
  const mutual = +card.dataset.mutual || 0;
  sfx.back(); buzz(15);
  const entry = qaddEntries.find(x => x.username === user);
  if (entry) qaddEntries = qaddEntries.filter(x => x !== entry);
  skipStack.push({ username: user, mutual, avatar: entry?.avatar || null });
  $('#undoSkipBtn').classList.remove('hidden');
  recordAction('skip', user, mutual);
  dismissCard(card, 'left');
}

let _swipe = null;
(() => {
  const list = $('#qaddList');
  list.addEventListener('pointerdown', e => {
    const card = e.target.closest('.swipe-card');
    if (!card || e.target.closest('.add-btn, .tappable, .sb-btn, .ig-lookup')) return;
    _swipe = { card, x0: e.clientX, y0: e.clientY, dx: 0, id: e.pointerId, locked: false };
    card.style.transition = 'none';
    try { card.setPointerCapture(e.pointerId); } catch { /* ok */ }
  });
  list.addEventListener('pointermove', e => {
    if (!_swipe || e.pointerId !== _swipe.id) return;
    const dx = e.clientX - _swipe.x0, dy = e.clientY - _swipe.y0;
    if (!_swipe.locked) { if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return; _swipe.locked = Math.abs(dx) > Math.abs(dy); if (!_swipe.locked) { _swipe = null; return; } }
    _swipe.dx = Math.min(0, dx);                       // left only
    _swipe.card.style.transform = `translateX(${_swipe.dx}px) rotate(${_swipe.dx / 50}deg)`;
    _swipe.card.style.opacity = String(Math.max(0.2, 1 + _swipe.dx / 260));
  });
  const end = e => {
    if (!_swipe || e.pointerId !== _swipe.id) return;
    const { card, dx } = _swipe; _swipe = null;
    card.style.transition = '';
    if (dx < -90) skipCard(card);
    else { card.style.transform = ''; card.style.opacity = ''; }  // spring back
  };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
})();

/* undo the most recent skip */
$('#undoSkipBtn').addEventListener('click', async () => {
  const last = skipStack.pop();
  if (!last) return;
  sfx.select();
  if (state.user) {
    const { data } = await api('/api/account/undo-skip', { username: last.username });
    if (data?.user) { state.user = data.user; }
  }
  qaddEntries.unshift({ username: last.username, mutual: last.mutual, avatar: last.avatar });
  $('#queueDone').classList.add('hidden');
  $('#qaddResults').classList.remove('hidden');
  // rebuild the list (keeps it simple + consistent)
  $('#qaddList').innerHTML = qaddEntries.map(qaddCardHTML).join('');
  $('#undoSkipBtn').classList.toggle('hidden', skipStack.length === 0);
  enrichGroups();
});

/* wire the two uploaders + restart */
$('#shotFile').addEventListener('change', e => handleScreenshot(e.target.files[0]));
$('#vidFile').addEventListener('change', e => handleVideo(e.target.files[0]));
$('#qaddClear').addEventListener('click', () => fullReset());

/* ---------- group info (from our OWN data only) ---------- */
const _groupCache = {};
async function enrichGroups() {
  const lines = $$('#qaddList [data-groups-for]');
  if (!lines.length) return;
  const mine = new Set((state.user?.groups || []).map(g => g.toLowerCase()));
  const names = [...new Set(lines.map(l => l.dataset.groupsFor))];
  const need = names.filter(n => !(n in _groupCache));
  if (need.length) {
    try {
      const { data } = await api('/api/profiles/lookup', { usernames: need });
      for (const n of need) _groupCache[n] = (data.profiles && data.profiles[n]) || null;
    } catch { for (const n of need) _groupCache[n] = null; }
  }
  // show only groups SHARED between the person and the current user, inline
  for (const l of lines) {
    const theirs = _groupCache[l.dataset.groupsFor]?.groups || [];
    const shared = theirs.filter(g => mine.has(g.toLowerCase()));
    l.textContent = shared.length === 1 ? ` · in ${shared[0]}`
      : shared.length > 1 ? ` · ${shared.length} shared groups`
        : '';                                    // nothing → clean, no layout shift
  }
}


/* ---------- STACY'S page (the user's flagged list) ---------- */
let sbShowAll = false;
function renderStacys() {
  const marked = superbadList();          // internal store still named `superbad`
  $('#sbCount').textContent = marked.length;
  $('#sbToggle').classList.toggle('on', sbShowAll);

  let entries = marked;
  if (sbShowAll) {                             // also show unmarked people from this scan
    const have = new Set(marked.map(p => p.username));
    entries = [...marked, ...qaddEntries.filter(e => !have.has(e.username))];
  }
  $('#sbEmpty').classList.toggle('hidden', entries.length > 0);
  $('#sbList').innerHTML = entries.map((e, i) => personCardHTML(e, i, { noAdd: true })).join('');
}
$('#sbToggle').addEventListener('click', () => { sbShowAll = !sbShowAll; renderStacys(); });

/* ---------- themed confirm dialog (Promise<boolean>) ---------- */
function askConfirm(message, okLabel = 'Remove') {
  return new Promise(resolve => {
    const dlg = $('#confirmDialog');
    $('#cdMsg').textContent = message;
    $('#cdOk').textContent = okLabel;
    dlg.classList.remove('hidden');
    requestAnimationFrame(() => dlg.classList.add('show'));
    const done = val => {
      dlg.classList.remove('show');
      setTimeout(() => dlg.classList.add('hidden'), 180);
      $('#cdOk').removeEventListener('click', onOk);
      dlg.removeEventListener('click', onCancel);
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = e => { if (e.target.closest('[data-cd-cancel]')) done(false); };
    const onKey = e => { if (e.key === 'Escape') done(false); else if (e.key === 'Enter') done(true); };
    $('#cdOk').addEventListener('click', onOk);
    dlg.addEventListener('click', onCancel);
    document.addEventListener('keydown', onKey);
  });
}

/* ---------- avatar lightbox ---------- */
function openLightbox(src) {
  const lb = $('#lightbox');
  $('#lbImg').src = src;
  lb.classList.remove('hidden');
  requestAnimationFrame(() => lb.classList.add('show'));
}
function closeLightbox() {
  const lb = $('#lightbox');
  lb.classList.remove('show');
  setTimeout(() => { lb.classList.add('hidden'); $('#lbImg').src = ''; }, 200);
}
document.addEventListener('click', e => {
  const tap = e.target.closest('.tappable');
  if (tap) {
    const src = tap.dataset.shot || tap.querySelector('img')?.src;
    if (src) { sfx.click(); openLightbox(src); }
    return;
  }
  if (e.target.closest('[data-lb-close]')) closeLightbox();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#lightbox').classList.contains('hidden')) closeLightbox(); });

/* ===================================================================
   BOOT
   =================================================================== */
bindAccountActions();
renderCandidates();   // seed the scanner's confirm/edit list (empty state)
applyAudioUI();
consumeAuthHash();
consumeVerifyHash();
// open on the account page first (create-account / sign-up when logged out;
// once fetchMe resolves a saved session, it shows the real profile instead)
go('account');
refreshAuth();                  // Snapchat connection status
fetchMe().then(refreshBoard);   // app account status, then leaderboard/rank
