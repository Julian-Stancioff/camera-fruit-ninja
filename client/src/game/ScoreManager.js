// Score, strikes (lives), combos, and the persisted high score.
const BEST_KEY = "fn_best_v1";
const COMBO_MS = 600;     // fruit sliced within this window count toward a combo
const START_STRIKES = 3;

export class ScoreManager {
  constructor() {
    this.best = Number(localStorage.getItem(BEST_KEY) || 0);
    this.reset();
  }

  reset() {
    this.score = 0;
    this.strikes = START_STRIKES;
    this._recent = [];
  }

  /** Record a fruit slice; returns { comboSize, gained }. */
  recordSlice(now) {
    this._recent = this._recent.filter((t) => now - t < COMBO_MS);
    this._recent.push(now);
    const comboSize = this._recent.length;
    let gained = 1;
    if (comboSize >= 3) gained += comboSize; // combo bonus, like the original
    this.score += gained;
    if (this.score > this.best) {
      this.best = this.score;
      localStorage.setItem(BEST_KEY, String(this.best));
    }
    return { comboSize, gained };
  }

  /** A fruit fell off-screen unsliced. Returns remaining strikes. */
  recordMiss() {
    this.strikes = Math.max(0, this.strikes - 1);
    return this.strikes;
  }

  get dead() { return this.strikes <= 0; }
}
