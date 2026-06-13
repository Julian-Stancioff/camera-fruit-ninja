// XP-based level progression, themed as martial-arts belts.
// You earn XP from your GAME SCORES (banked at the end of each game), not from
// raw slices. Levels get progressively harder — reaching the first belt takes a
// few good games. Leveling happens on the game-over screen, never mid-game.
const KEY = "fn_xp_v2";

// Each level is a belt. `xp` = cumulative XP required to REACH that level.
// Curve is steep so higher belts demand many strong games.
export const LEVELS = [
  { level: 1, name: "White",  color: "#eef0f2", xp: 0 },
  { level: 2, name: "Yellow", color: "#f4d03f", xp: 250 },
  { level: 3, name: "Orange", color: "#e67e22", xp: 650 },
  { level: 4, name: "Green",  color: "#27ae60", xp: 1300 },
  { level: 5, name: "Blue",   color: "#2e86de", xp: 2300 },
  { level: 6, name: "Purple", color: "#8e44ad", xp: 3800 },
  { level: 7, name: "Brown",  color: "#8b5a2b", xp: 6000 },
  { level: 8, name: "Red",    color: "#c0392b", xp: 9000 },
  { level: 9, name: "Black",  color: "#1a1a1a", xp: 13000 },
];

export function getXP() { return Number(localStorage.getItem(KEY) || 0); }
export function addXP(n) {
  const xp = getXP() + Math.max(0, Math.round(n));
  localStorage.setItem(KEY, String(xp));
  return xp;
}

export function levelFor(xp) {
  let lv = LEVELS[0];
  for (const l of LEVELS) if (xp >= l.xp) lv = l;
  return lv;
}
export function nextLevel(xp) { return LEVELS.find((l) => l.xp > xp) || null; }

/** Progress 0..1 from the current level toward the next (1 if maxed). */
export function levelProgress(xp) {
  const cur = levelFor(xp), nxt = nextLevel(xp);
  if (!nxt) return 1;
  return (xp - cur.xp) / (nxt.xp - cur.xp);
}

/** XP remaining to the next level (0 if maxed). */
export function xpToNext(xp) {
  const nxt = nextLevel(xp);
  return nxt ? nxt.xp - xp : 0;
}
