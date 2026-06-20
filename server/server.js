/* =====================================================================
   SNAP//QUICKADD server — serves the static app and handles the real
   Snap Login Kit OAuth lifecycle: connect, status (with token refresh),
   disconnect. Falls back to DEMO MODE when no credentials are configured.
   ===================================================================== */
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import {
  isConfigured, makePkce, randomState, buildAuthUrl,
  exchangeCode, refreshTokens, fetchProfile,
} from './snap-oauth.js';
import {
  MAIL_DEV, publicUser, findById, createUser, verifyPassword,
  consumeVerifyToken, refreshVerifyToken, updateProfile, sendVerification,
  setStats, leaderboard, recordAction, undoSkip, setSkin, setSnapUsername,
  lookupProfiles, setGroups, toggleSuperbad, changePassword, setPublic,
} from './accounts.js';
import { scanConfigured, extractUsernames } from './scan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const DEMO = !isConfigured();

const PROD = process.env.NODE_ENV === 'production';
const app = express();
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);   // honor X-Forwarded-Proto behind a proxy (secure cookies)

// minimal security headers (no extra dependency)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// tiny in-memory rate limiter (per IP + bucket). Good enough for a single node;
// swap for a shared store if you scale horizontally.
const buckets = new Map();
function rateLimit(bucket, max, windowMs) {
  return (req, res, next) => {
    const key = `${bucket}:${req.ip}`;
    const now = Date.now();
    let e = buckets.get(key);
    if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; buckets.set(key, e); }
    if (++e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
      return res.status(429).json({ error: 'rate_limited' });
    }
    next();
  };
}
// periodic cleanup so the map can't grow unbounded
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (now > v.reset) buckets.delete(k); }, 60_000).unref();

app.use(express.json({ limit: '12mb' })); // base64 frames are large

// file-backed session store so logins survive server restarts ("remember me")
const FileStore = FileStoreFactory(session);
app.use(session({
  name: 'sqa.sid',
  store: new FileStore({
    // same DATA_DIR as accounts → lands on the persistent disk in production
    path: path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'sessions'),
    ttl: 60 * 60 * 24 * 30,      // 30 days
    retries: 1,
    logFn: () => {},             // quiet
  }),
  secret: process.env.SESSION_SECRET || 'dev-only-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true,                 // refresh cookie+ttl on activity
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: 1000 * 60 * 60 * 24 * 30,   // 30 days
  },
}));

/* helper: public-safe view of the connection */
function publicProfile(req) {
  const a = req.session.auth;
  if (!a) return { connected: false, demo: DEMO };
  return { connected: true, demo: a.demo === true, profile: a.profile };
}

/* ensure the access token is fresh; refresh if we can, else disconnect */
async function ensureFresh(req) {
  const a = req.session.auth;
  if (!a || a.demo) return;
  if (Date.now() < a.expiresAt - 30_000) return; // still valid
  if (!a.refreshToken) { delete req.session.auth; const e = new Error('expired'); e.kind = 'expired'; throw e; }
  const tokens = await refreshTokens(a.refreshToken);
  Object.assign(a, tokens);
}

/* ---- 1. start the OAuth dance ---- */
app.get('/api/auth/login', (req, res) => {
  if (DEMO) {
    // No credentials configured → simulate a successful connect.
    req.session.auth = {
      demo: true,
      profile: { displayName: 'Demo Snapchatter', externalId: 'demo-0001', avatar: null },
    };
    return res.redirect('/#account&connected=demo');
  }
  const { verifier, challenge } = makePkce();
  const state = randomState();
  req.session.oauth = { verifier, state };
  res.redirect(buildAuthUrl({ state, challenge }));
});

/* ---- 2. Snap redirects back here ---- */
app.get('/api/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/#account&error=denied');     // user declined perms
  const saved = req.session.oauth;
  if (!saved || !code || state !== saved.state) {
    return res.redirect('/#account&error=state');               // CSRF / bad state
  }
  delete req.session.oauth;
  try {
    const tokens = await exchangeCode({ code, verifier: saved.verifier });
    const profile = await fetchProfile(tokens.accessToken);
    req.session.auth = { ...tokens, profile };
    res.redirect('/#account&connected=1');
  } catch (err) {
    const kind = err.kind === 'network' ? 'network'
      : err.kind === 'invalid_grant' ? 'token'
      : 'token';
    res.redirect(`/#account&error=${kind}`);
  }
});

/* ---- 3. current status (drives the whole UI) ---- */
app.get('/api/auth/status', async (req, res) => {
  try {
    await ensureFresh(req);
    res.json(publicProfile(req));
  } catch (err) {
    delete req.session.auth;
    res.status(200).json({ connected: false, demo: DEMO, error: err.kind || 'unknown' });
  }
});

/* ---- 4. disconnect ---- */
app.post('/api/auth/logout', (req, res) => {
  delete req.session.auth;
  delete req.session.oauth;
  res.json({ connected: false, demo: DEMO });
});

/* ===================================================================
   APP ACCOUNTS — email/password + email verification
   =================================================================== */
function currentUser(req) {
  return req.session.userId ? findById(req.session.userId) : null;
}

app.post('/api/account/signup', rateLimit('signup', 10, 60_000), async (req, res) => {
  try {
    const { email, password, displayName } = req.body || {};
    const user = createUser({ email, password, displayName });
    req.session.userId = user.id;
    const devLink = await sendVerification(req, user);
    res.json({ user: publicUser(user), mailDev: MAIL_DEV, devVerifyUrl: devLink });
  } catch (e) {
    res.status(400).json({ error: e.code || 'signup_failed' });
  }
});

app.post('/api/account/login', rateLimit('login', 20, 60_000), (req, res) => {
  const { email, password } = req.body || {};
  const user = verifyPassword(email, password);
  if (!user) return res.status(401).json({ error: 'bad_credentials' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post('/api/account/logout', (req, res) => {
  delete req.session.userId;
  delete req.session.auth;   // also drop the Snap link for this session
  delete req.session.oauth;
  res.json({ ok: true });
});

app.get('/api/account/me', (req, res) => {
  res.json({ user: publicUser(currentUser(req)), mailDev: MAIL_DEV });
});

app.post('/api/account/profile', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try {
    const updated = updateProfile(u.id, { displayName: req.body?.displayName });
    res.json({ user: publicUser(updated) });
  } catch (e) {
    res.status(400).json({ error: e.code || 'update_failed' });
  }
});

// save manually-logged stats (Added / Texting / Hangout)
app.post('/api/account/stats', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  const saved = setStats(u.id, req.body || {});
  res.json({ user: publicUser(saved) });
});

// leaderboard of real users ranked by conversion rate
app.get('/api/leaderboard', (_req, res) => {
  res.json({ rows: leaderboard() });
});

// record an add/skip action (XP, streak, achievements) — must be logged in
app.post('/api/account/action', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try {
    res.json(recordAction(u.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.code || 'action_failed' });
  }
});

app.post('/api/account/undo-skip', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try { res.json({ user: undoSkip(u.id, req.body?.username) }); }
  catch (e) { res.status(400).json({ error: e.code || 'undo_failed' }); }
});

app.post('/api/account/skin', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try { res.json({ user: setSkin(u.id, req.body?.category, req.body?.value) }); }
  catch (e) { res.status(400).json({ error: e.code || 'skin_failed' }); }
});

app.post('/api/account/snap-username', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try { res.json({ user: setSnapUsername(u.id, req.body?.username) }); }
  catch (e) { res.status(400).json({ error: e.code || 'snap_failed' }); }
});

// set the user's own groups (their data)
app.post('/api/account/groups', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ user: setGroups(u.id, req.body?.groups) });
});

// change password (requires current password)
app.post('/api/account/password', rateLimit('passwd', 10, 60_000), (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try { res.json({ user: changePassword(u.id, req.body?.current, req.body?.next) }); }
  catch (e) { res.status(400).json({ error: e.code || 'password_failed' }); }
});

// public-profile toggle
app.post('/api/account/public', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  res.json({ user: setPublic(u.id, !!req.body?.public) });
});

// group-info enrichment from our own data only (no scraping)
app.post('/api/profiles/lookup', (req, res) => {
  res.json({ profiles: lookupProfiles(req.body?.usernames || []) });
});

// toggle a SUPERBAD mark (private to the user)
app.post('/api/account/superbad', (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  try { res.json({ user: toggleSuperbad(u.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.code || 'superbad_failed' }); }
});

app.post('/api/account/resend', rateLimit('resend', 4, 60_000), async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'not_logged_in' });
  const fresh = refreshVerifyToken(u.id);
  if (!fresh) return res.json({ alreadyVerified: true });
  const devLink = await sendVerification(req, fresh);
  res.json({ ok: true, mailDev: MAIL_DEV, devVerifyUrl: devLink });
});

// link target the user clicks in the email
app.get('/api/account/verify', (req, res) => {
  const result = consumeVerifyToken(req.query.token);
  if (result === 'expired') return res.redirect('/#account&verify=expired');
  if (!result) return res.redirect('/#account&verify=bad');
  req.session.userId = result.id; // log them in on successful verify
  res.redirect('/#account&verify=ok');
});

/* ===================================================================
   QUICK ADD SCANNER — vision extraction (ephemeral, never persisted)
   =================================================================== */
const MAX_IMAGE_B64 = 9_000_000;   // ~6.7 MB decoded — one preprocessed frame
app.post('/api/scan/extract', rateLimit('scan', 40, 60_000), async (req, res) => {
  if (!scanConfigured()) return res.status(503).json({ error: 'no_api_key' });
  const image = req.body?.image;
  if (typeof image !== 'string' || image.length > MAX_IMAGE_B64) {
    return res.status(413).json({ error: 'image_too_large' });
  }
  const m = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=]+)$/.exec(image);
  if (!m) return res.status(400).json({ error: 'bad_image' });
  const mediaType = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  try {
    const usernames = await extractUsernames({ mediaType, data: m[2] });
    res.json({ usernames });
  } catch (e) {
    console.error('[scan] extract error:', e?.status, e?.message);
    res.status(502).json({ error: 'extract_failed' });
  }
  // image bytes were only ever in memory here — nothing is written to disk
});

app.get('/api/health', (_req, res) =>
  res.json({ ok: true, demo: DEMO, mailDev: MAIL_DEV, scan: scanConfigured() }));

/* ---- static app ---- */
app.use(express.static(ROOT, { extensions: ['html'], maxAge: PROD ? '1h' : 0 }));

// JSON 404 for unknown API routes (static SPA handles everything else)
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

// graceful catch-all: log server-side, return a generic message (no leak)
app.use((err, _req, res, _next) => {
  console.error('[error]', err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error' });
});

const isVercel = Boolean(process.env.VERCEL);

if (!isVercel) {
  const server = app.listen(PORT, () => {
    console.log(`SNAP//QUICKADD on http://localhost:${PORT}  ${DEMO ? '(DEMO — no Snap creds)' : '(live OAuth)'}${PROD ? ' [prod]' : ''}`);
  });
  // don't crash the process on an unexpected error
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

export default app;
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaughtException]', e?.message || e));
