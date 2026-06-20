/* =====================================================================
   Progression: XP, levels, ranks, skins, achievements, streaks, weekly.
   Pure functions over a user's saved data (history of their own add/skip
   actions). No third-party profiles are stored — only the handle strings
   the user themselves chose to add or skip, plus the mutual count they saw.
   ===================================================================== */

export const XP = { add: 10, skip: 2 };

/* ---- levels (100 XP each) + rank bands ---- */
export function levelInfo(xp) {
  xp = Math.max(0, xp | 0);
  const per = 100;
  const level = Math.floor(xp / per) + 1;
  return { level, xpInLevel: xp % per, xpForNext: per, xp };
}
export function rankFor(level) {
  if (level >= 12) return 'LEGEND';
  if (level >= 8) return 'PRO';
  if (level >= 5) return 'CLOSER';
  if (level >= 3) return 'SCOUT';
  return 'ROOKIE';
}

/* ---- cosmetic skins, unlocked by level ---- */
export const SKINS = {
  theme: [
    { id: 'red', name: 'Neon Red', unlock: 1 },
    { id: 'toxic', name: 'Toxic Green', unlock: 3 },
    { id: 'grape', name: 'Grape Soda', unlock: 5 },
    { id: 'gold', name: 'Gold Rush', unlock: 8 },
  ],
  card: [
    { id: 'default', name: 'Standard', unlock: 1 },
    { id: 'neon', name: 'Neon Glow', unlock: 4 },
    { id: 'gold', name: 'Gold Trim', unlock: 9 },
  ],
  sound: [
    { id: 'arcade', name: 'Arcade', unlock: 1 },
    { id: 'soft', name: 'Soft Pack', unlock: 6 },
  ],
};
export function unlockedSkins(level) {
  const out = {};
  for (const cat of Object.keys(SKINS)) {
    out[cat] = SKINS[cat].filter(s => level >= s.unlock).map(s => s.id);
  }
  return out;
}
export function isUnlocked(cat, id, level) {
  const s = (SKINS[cat] || []).find(x => x.id === id);
  return !!s && level >= s.unlock;
}

/* ---- achievements ---- */
export const ACHIEVEMENTS = [
  { id: 'first_add', name: 'First Contact', desc: 'Add your first person', xp: 20, test: c => c.adds >= 1 },
  { id: 'adds_10', name: 'Warmed Up', desc: 'Add 10 people', xp: 30, test: c => c.adds >= 10 },
  { id: 'adds_50', name: 'On A Roll', desc: 'Add 50 people', xp: 60, test: c => c.adds >= 50 },
  { id: 'adds_100', name: 'Century', desc: 'Add 100 people', xp: 120, test: c => c.adds >= 100 },
  { id: 'mutual_20', name: 'Well Connected', desc: 'Add someone with 20+ mutuals', xp: 30, test: c => c.maxMutual >= 20 },
  { id: 'mutual_50', name: 'Inner Circle', desc: 'Add someone with 50+ mutuals', xp: 50, test: c => c.maxMutual >= 50 },
  { id: 'streak_3', name: 'Habit Forming', desc: '3-day streak', xp: 25, test: c => c.streak >= 3 },
  { id: 'streak_7', name: 'Week Strong', desc: '7-day streak', xp: 50, test: c => c.streak >= 7 },
  { id: 'streak_30', name: 'Unstoppable', desc: '30-day streak', xp: 150, test: c => c.streak >= 30 },
  { id: 'level_5', name: 'Closer', desc: 'Reach level 5', xp: 40, test: c => c.level >= 5 },
  { id: 'level_10', name: 'Pro Tier', desc: 'Reach level 10', xp: 80, test: c => c.level >= 10 },
];
const ACH_BY_ID = Object.fromEntries(ACHIEVEMENTS.map(a => [a.id, a]));

// which achievements newly qualify, given a stat context + already-earned set
export function newlyEarned(ctx, earned) {
  const have = new Set(earned);
  return ACHIEVEMENTS.filter(a => !have.has(a.id) && a.test(ctx)).map(a => a.id);
}
export function achievementXp(ids) {
  return ids.reduce((s, id) => s + (ACH_BY_ID[id]?.xp || 0), 0);
}

/* ---- derive sets / stats from the action history ---- */
export function seenFrom(history) {
  const added = [], skipped = [], a = new Set(), s = new Set();
  for (const h of history || []) {
    if (h.a === 'add' && !a.has(h.u)) { a.add(h.u); added.push(h.u); }
    else if (h.a === 'skip' && !s.has(h.u)) { s.add(h.u); skipped.push(h.u); }
  }
  return { added, skipped };
}

export function statsFrom(history) {
  let adds = 0, maxMutual = 0;
  const seenAdd = new Set();
  for (const h of history || []) {
    if (h.a === 'add' && !seenAdd.has(h.u)) {
      seenAdd.add(h.u); adds++;
      if ((h.m | 0) > maxMutual) maxMutual = h.m | 0;
    }
  }
  return { adds, maxMutual };
}

export function weeklyFrom(history) {
  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let adds = 0, newMutuals = 0, xpGained = 0;
  for (const h of history || []) {
    if (h.ts < since) continue;
    if (h.a === 'add') { adds++; newMutuals += h.m | 0; xpGained += XP.add; }
    else if (h.a === 'skip') xpGained += XP.skip;
  }
  return { adds, newMutuals, xpGained };
}

/* short, genuinely supportive lines (never nagging) */
export const ENCOURAGEMENT = [
  'Nice — momentum looks good.',
  'Smooth. Keep that energy.',
  'Every add is a new door. 🚪',
  'You\'re building something here.',
  'Great pace — proud of that.',
  'Little by little adds up.',
  'That\'s the way. Keep going when you feel like it.',
];
