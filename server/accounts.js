/* =====================================================================
   Local email/password accounts with email verification.
   Passwords are hashed with scrypt (salt per user). Users persist to
   server/data/users.json. No third-party / scraped data is ever stored
   here — only people who sign up for this site.

   Email delivery: if SMTP isn't configured the verification link is
   returned to the client in DEV mode (and logged) so the flow works
   end-to-end locally. Wire a real mailer in sendVerification() for prod.
   ===================================================================== */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  XP, levelInfo, rankFor, SKINS, unlockedSkins, isUnlocked,
  newlyEarned, achievementXp, seenFrom, statsFrom, weeklyFrom, ACHIEVEMENTS,
} from './progression.js';

const RE_SNAP = /^[a-z][a-z0-9._-]{2,14}$/;
const todayUTC = () => new Date().toISOString().slice(0, 10);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'users.json');

export const MAIL_DEV = !process.env.SMTP_HOST; // no SMTP → show link in UI

function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch {
    // fall back to the last good backup if the main file is missing/corrupt
    try { return JSON.parse(fs.readFileSync(DB_FILE + '.bak', 'utf8')); }
    catch { return { users: [] }; }
  }
}
// atomic write (tmp → rename) + rolling backup so a crash or slip can't
// truncate or lose the accounts file
function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const json = JSON.stringify(db, null, 2);
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, json);
  try { if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch { /* ignore */ }
  fs.renameSync(tmp, DB_FILE);
}

const norm = e => String(e || '').trim().toLowerCase();
// display name shown to other users — strip angle brackets (defense-in-depth vs XSS)
const cleanName = s => String(s || '').replace(/[<>]/g, '').trim().slice(0, 24);
const id = () => crypto.randomBytes(9).toString('base64url');
const token = () => crypto.randomBytes(24).toString('base64url');

function hash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

const ZERO_STATS = { added: 0, texting: 0, hangout: 0 };

/* keep the funnel logically valid: texting ≤ added, hangout ≤ texting.
   This guarantees conversion rate (hangout/added) ≤ 100% on the board. */
function cleanStats(s = {}) {
  const added = Math.max(0, Math.floor(Number(s.added) || 0));
  const texting = Math.min(added, Math.max(0, Math.floor(Number(s.texting) || 0)));
  const hangout = Math.min(texting, Math.max(0, Math.floor(Number(s.hangout) || 0)));
  return { added, texting, hangout };
}

/* backfill progression fields on older accounts */
function ensureProg(u) {
  if (!u) return u;
  if (typeof u.xp !== 'number') u.xp = 0;
  if (!Array.isArray(u.history)) u.history = [];
  if (!Array.isArray(u.achievements)) u.achievements = [];
  if (!u.streak) u.streak = { count: 0, lastDay: null };
  if (!u.skins) u.skins = { theme: 'red', card: 'default', sound: 'arcade' };
  if (!('snapUsername' in u)) u.snapUsername = null;
  if (typeof u.isPublic !== 'boolean') u.isPublic = false;
  if (!Array.isArray(u.groups)) u.groups = [];
  if (!Array.isArray(u.superbad)) u.superbad = [];
  return u;
}

/* toggle a SUPERBAD mark — the user's own private flag list. Stores the
   handle + the name/avatar the user already saw (their own annotation). */
export function toggleSuperbad(uid, { username, name, avatar }) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  const handle = String(username || '').replace(/^@/, '').toLowerCase().trim();
  if (!RE_SNAP.test(handle)) throw err('bad_username');
  const i = u.superbad.findIndex(p => p.username === handle);
  if (i >= 0) u.superbad.splice(i, 1);
  else u.superbad.push({
    username: handle,
    name: String(name || '').slice(0, 60),
    avatar: String(avatar || '').slice(0, 200000),   // small JPEG data URL or ''
    ts: Date.now(),
  });
  save(db);
  return publicUser(u);
}

/* group info comes ONLY from our own users' data — never scraped from
   Snapchat. Returns group info for usernames that match a site user's
   snapUsername (people who opted to be findable by setting their handle). */
export function lookupProfiles(usernames) {
  const want = new Set((usernames || []).map(u => String(u).replace(/^@/, '').toLowerCase()));
  const out = {};
  for (const u of load().users) {
    // only users who opted IN to a public profile are discoverable
    if (!u.isPublic || !u.snapUsername || !want.has(u.snapUsername)) continue;
    out[u.snapUsername] = { displayName: u.displayName, groups: Array.isArray(u.groups) ? u.groups : [] };
  }
  return out;
}

/* change password — requires the current password, enforces strength */
export function changePassword(uid, current, next) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  const cand = hash(current || '', u.salt);
  const a = Buffer.from(cand, 'hex'), b = Buffer.from(u.passHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw err('bad_current');
  if (!strongPassword(next)) throw err('weak_password');
  u.salt = crypto.randomBytes(16).toString('hex');
  u.passHash = hash(next, u.salt);
  save(db);
  return publicUser(u);
}

/* public-profile toggle */
export function setPublic(uid, value) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  u.isPublic = !!value;
  save(db);
  return publicUser(u);
}

export function setGroups(uid, groups) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  u.groups = (Array.isArray(groups) ? groups : [])
    .map(g => String(g).trim().slice(0, 24)).filter(Boolean).slice(0, 12);
  save(db);
  return publicUser(u);
}

/* public-safe view (never leak hash/salt/tokens) */
export function publicUser(u) {
  if (!u) return null;
  ensureProg(u);
  const lvl = levelInfo(u.xp);
  const seen = seenFrom(u.history);
  const share = u.snapUsername
    ? { snapUsername: u.snapUsername, addUrl: `https://snapchat.com/add/${u.snapUsername}` }
    : { snapUsername: null, addUrl: null };
  return {
    id: u.id, email: u.email, displayName: u.displayName, verified: !!u.verified,
    stats: u.stats || { ...ZERO_STATS },
    xp: lvl.xp, level: lvl.level, xpInLevel: lvl.xpInLevel, xpForNext: lvl.xpForNext,
    rank: rankFor(lvl.level),
    streak: { count: u.streak.count, lastDay: u.streak.lastDay },
    achievements: u.achievements,
    achievementDefs: ACHIEVEMENTS.map(a => ({ id: a.id, name: a.name, desc: a.desc })),
    skins: { active: u.skins, unlocked: unlockedSkins(lvl.level), catalog: SKINS },
    groups: u.groups || [],
    isPublic: !!u.isPublic,
    superbad: u.superbad || [],
    seen,
    totals: { adds: seen.added.length },
    weekly: { ...weeklyFrom(u.history), streak: u.streak.count },
    share,
  };
}

export function findByEmail(email) {
  return load().users.find(u => u.email === norm(email)) || null;
}
export function findById(uid) {
  return load().users.find(u => u.id === uid) || null;
}

// password must be ≥ 8 chars with at least one letter and one number
export function strongPassword(p) {
  return typeof p === 'string' && p.length >= 8 && /[A-Za-z]/.test(p) && /\d/.test(p);
}

export function createUser({ email, password, displayName }) {
  email = norm(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw err('invalid_email');
  if (!strongPassword(password)) throw err('weak_password');
  const db = load();
  if (db.users.some(u => u.email === email)) throw err('email_taken');

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: id(),
    email,
    displayName: cleanName(displayName) || email.split('@')[0].slice(0, 24),
    salt,
    passHash: hash(password, salt),
    verified: false,
    verifyToken: token(),
    verifyExpires: Date.now() + 1000 * 60 * 60 * 24,
    stats: { ...ZERO_STATS },         // Added / Texting / Hangout — manually logged
    xp: 0,
    history: [],                      // [{u, a:'add'|'skip', m, ts}] — user's own actions
    achievements: [],
    streak: { count: 0, lastDay: null },
    skins: { theme: 'red', card: 'default', sound: 'arcade' },
    snapUsername: null,
    isPublic: false,                  // public-profile toggle (default private)
    groups: [],
    superbad: [],
    createdAt: Date.now(),
  };
  db.users.push(user);
  save(db);
  return user;
}

export function verifyPassword(email, password) {
  const u = findByEmail(email);
  if (!u) return null;
  const candidate = hash(password, u.salt);
  const a = Buffer.from(candidate, 'hex');
  const b = Buffer.from(u.passHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return u;
}

export function consumeVerifyToken(tok) {
  const db = load();
  const u = db.users.find(x => x.verifyToken && x.verifyToken === tok);
  if (!u) return null;
  if (u.verifyExpires && Date.now() > u.verifyExpires) return 'expired';
  u.verified = true;
  delete u.verifyToken;
  delete u.verifyExpires;
  save(db);
  return u;
}

export function refreshVerifyToken(uid) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u || u.verified) return null;
  u.verifyToken = token();
  u.verifyExpires = Date.now() + 1000 * 60 * 60 * 24;
  save(db);
  return u;
}

export function updateProfile(uid, { displayName }) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  if (typeof displayName === 'string' && cleanName(displayName)) {
    u.displayName = cleanName(displayName);
  }
  save(db);
  return u;
}

/* save a user's manually-logged stats (clamped to a valid funnel) */
export function setStats(uid, stats) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  u.stats = cleanStats(stats);
  save(db);
  return u;
}

/* record a swipe-deck / add-queue action and return progression deltas.
   type 'add' (queued → fired the deep link) or 'skip'. Username + the mutual
   count the user saw are stored as the user's OWN action history. */
export function recordAction(uid, { type, username, mutual, day }) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);

  const name = String(username || '').replace(/^@/, '').toLowerCase().trim();
  if (!RE_SNAP.test(name)) throw err('bad_username');
  if (type !== 'add' && type !== 'skip') throw err('bad_type');

  const seen = seenFrom(u.history);
  const before = { xp: u.xp, level: levelInfo(u.xp).level };
  let gained = 0;

  // never double-count: skip ignored if already added/skipped; add wins over skip
  const inAdded = seen.added.includes(name);
  const inSkipped = seen.skipped.includes(name);
  if (type === 'add' && !inAdded) {
    u.history.push({ u: name, a: 'add', m: Math.max(0, mutual | 0), ts: Date.now() });
    u.xp += XP.add; gained += XP.add;
    bumpStreak(u, day);
  } else if (type === 'skip' && !inSkipped && !inAdded) {
    u.history.push({ u: name, a: 'skip', m: Math.max(0, mutual | 0), ts: Date.now() });
    u.xp += XP.skip; gained += XP.skip;
    bumpStreak(u, day);
  }

  // re-evaluate achievements with the new totals
  const s = statsFrom(u.history);
  const ctx = { adds: s.adds, maxMutual: s.maxMutual, streak: u.streak.count, level: levelInfo(u.xp).level };
  const fresh = newlyEarned(ctx, u.achievements);
  if (fresh.length) {
    u.achievements.push(...fresh);
    const bonus = achievementXp(fresh);
    u.xp += bonus; gained += bonus;
  }

  save(db);
  return {
    user: publicUser(u),
    newAchievements: fresh,
    xpGained: gained,
    leveledUp: levelInfo(u.xp).level > before.level,
  };
}

function bumpStreak(u, day) {
  const today = /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayUTC();
  const last = u.streak.lastDay;
  if (last === today) return;                      // already counted today
  const prev = new Date(today + 'T00:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 1);
  const yesterday = prev.toISOString().slice(0, 10);
  u.streak.count = last === yesterday ? u.streak.count + 1 : 1;
  u.streak.lastDay = today;
}

/* undo a skip: remove the most recent skip for that username */
export function undoSkip(uid, username) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  const name = String(username || '').replace(/^@/, '').toLowerCase().trim();
  for (let i = u.history.length - 1; i >= 0; i--) {
    if (u.history[i].a === 'skip' && u.history[i].u === name) {
      u.history.splice(i, 1);
      u.xp = Math.max(0, u.xp - XP.skip);
      save(db);
      break;
    }
  }
  return publicUser(u);
}

/* choose an active skin (must be unlocked at current level) */
export function setSkin(uid, category, value) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  if (!SKINS[category]) throw err('bad_category');
  const level = levelInfo(u.xp).level;
  if (!isUnlocked(category, value, level)) throw err('locked');
  u.skins[category] = value;
  save(db);
  return publicUser(u);
}

/* set the user's own Snapchat username (drives their shareable add link) */
export function setSnapUsername(uid, username) {
  const db = load();
  const u = db.users.find(x => x.id === uid);
  if (!u) throw err('not_found');
  ensureProg(u);
  const name = String(username || '').replace(/^@/, '').toLowerCase().trim();
  if (!RE_SNAP.test(name)) throw err('bad_username');
  u.snapUsername = name;
  save(db);
  return publicUser(u);
}

/* leaderboard of REAL site users only (people who created an account),
   ranked by conversion = hangout / added. Only those with ≥1 add rank. */
export function leaderboard() {
  return load().users
    .map(u => {
      const s = cleanStats(u.stats);
      return {
        id: u.id,
        name: u.displayName,
        added: s.added, texting: s.texting, hangout: s.hangout,
        conversion: s.added ? s.hangout / s.added : 0,
      };
    })
    .filter(r => r.added > 0)
    .sort((a, b) => b.conversion - a.conversion || b.added - a.added);
}

/* build the verification link + (dev) hand it back to the caller */
export function verificationLink(req, user) {
  const base = `${req.protocol}://${req.get('host')}`;
  return `${base}/api/account/verify?token=${encodeURIComponent(user.verifyToken)}`;
}

/* Real email via SMTP (works with SendGrid, Resend, Mailgun, Postmark, Gmail,
   etc. — anything that speaks SMTP). Configured entirely from env:
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
   If SMTP_HOST is unset, runs in DEV mode (logs + returns the link for the UI). */
let _mailer = null;
async function mailer() {
  if (_mailer) return _mailer;
  const nodemailer = (await import('nodemailer')).default;
  _mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,           // 465 = implicit TLS
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return _mailer;
}

export async function sendVerification(req, user) {
  const link = verificationLink(req, user);
  if (MAIL_DEV) {
    console.log(`[mail:dev] verification for ${user.email}: ${link}`);
    return link;                                             // surface link in the UI
  }
  try {
    const t = await mailer();
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: 'Verify your SNAP//QUICKADD account',
      text: `Welcome! Confirm your email to finish setting up your account:\n\n${link}\n\nThis link expires in 24 hours. If you didn't sign up, ignore this email.`,
      html: `<p>Welcome to <b>SNAP//QUICKADD</b>!</p><p>Confirm your email to finish setting up your account:</p><p><a href="${link}">Verify my email →</a></p><p style="color:#888;font-size:12px">This link expires in 24 hours. If you didn't sign up, ignore this email.</p>`,
    });
  } catch (e) {
    console.error('[mail] send failed:', e?.message);       // don't block signup on mail failure
  }
  return null;
}

function err(code) { const e = new Error(code); e.code = code; return e; }
