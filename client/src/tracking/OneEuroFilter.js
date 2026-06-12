// 1€ filter: adaptive low-pass smoothing for noisy interactive signals.
// Low speed → heavy smoothing (stable blade point); high speed → low lag (fast
// swipes respond instantly). One instance per scalar (so one per x and per y).
// Reference: https://gery.casiez.net/1euro/
export class OneEuroFilter {
  constructor(freq = 30, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  _alpha(cutoff) {
    const te = 1.0 / this.freq;
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / te);
  }

  /** Feed a raw value; returns the smoothed value. `freq` may be updated per-frame. */
  filter(x, freq) {
    if (freq && freq > 0) this.freq = freq;
    if (this.x === null) {
      this.x = x;
      return x;
    }
    const dxRaw = (x - this.x) * this.freq;
    this.dx += this._alpha(this.dCutoff) * (dxRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += this._alpha(cutoff) * (x - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}
