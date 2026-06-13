// Dojo belt-rank progression — the game's "sense of advancement" (case-study
// requirement). Rank up by total fruit sliced across all games, persisted locally.
const KEY = "fn_total_sliced_v1";

export const BELTS = [
  { name: "White",  color: "#eef0f2", at: 0 },
  { name: "Yellow", color: "#f4d03f", at: 40 },
  { name: "Orange", color: "#e67e22", at: 120 },
  { name: "Green",  color: "#27ae60", at: 280 },
  { name: "Blue",   color: "#2e86de", at: 550 },
  { name: "Purple", color: "#8e44ad", at: 950 },
  { name: "Brown",  color: "#8b5a2b", at: 1500 },
  { name: "Black",  color: "#1a1a1a", at: 2400 },
];

export function getTotal() {
  return Number(localStorage.getItem(KEY) || 0);
}

export function addSlices(n) {
  const total = getTotal() + n;
  localStorage.setItem(KEY, String(total));
  return total;
}

export function beltFor(total) {
  let belt = BELTS[0];
  for (const b of BELTS) if (total >= b.at) belt = b;
  return belt;
}

export function nextBelt(total) {
  return BELTS.find((b) => b.at > total) || null;
}

/** Progress (0..1) from the current belt toward the next (1 if at max). */
export function beltProgress(total) {
  const cur = beltFor(total), nxt = nextBelt(total);
  if (!nxt) return 1;
  return (total - cur.at) / (nxt.at - cur.at);
}
