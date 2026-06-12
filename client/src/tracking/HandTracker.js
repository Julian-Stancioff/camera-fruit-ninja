// Thin wrapper around MediaPipe HandLandmarker: loads the self-hosted model + wasm,
// runs per-frame detection, and returns a smoothed blade point (index fingertip,
// landmark 8) in normalized [0,1] coordinates plus the raw landmarks for debug.
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import { OneEuroFilter } from "./OneEuroFilter.js";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";
const BLADE_LANDMARK = 8; // INDEX_FINGER_TIP

export class HandTracker {
  constructor({ numHands = 1 } = {}) {
    this.numHands = numHands;
    this.landmarker = null;
    this.delegate = null;
    this.lastTs = 0;
    // NOTE: we filter NORMALIZED (0..1) coords, so the speed term `beta` must be
    // ~100x larger than the pixel-space values quoted in most 1€ examples, or it
    // never engages and the blade lags. High minCutoff + high beta = snappy blade.
    this.filterX = new OneEuroFilter(30, 2.6, 2.2);
    this.filterY = new OneEuroFilter(30, 2.6, 2.2);
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: "VIDEO",
      numHands: this.numHands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    // Prefer GPU; transparently fall back to CPU where WebGPU/WebGL is unavailable.
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("GPU"));
      this.delegate = "GPU";
    } catch (err) {
      console.warn("[tracker] GPU delegate failed, falling back to CPU:", err?.message || err);
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts("CPU"));
      this.delegate = "CPU";
    }
    return this.delegate;
  }

  /**
   * Run detection for one video frame.
   * @returns {{present:boolean, blade:{x,y}|null, landmarks:Array, handedness:string|null}}
   *          blade.{x,y} are smoothed, normalized [0,1] in the video's own frame
   *          (caller mirrors for display).
   */
  detect(video, tsMs) {
    if (!this.landmarker) return { present: false, blade: null, landmarks: [], handedness: null };
    const results = this.landmarker.detectForVideo(video, tsMs);
    const hand = results.landmarks?.[0];
    if (!hand) {
      // Reset filters so the next acquisition snaps to the new position (no lerp from stale point).
      this.filterX.reset();
      this.filterY.reset();
      return { present: false, blade: null, landmarks: [], handedness: null };
    }
    const dt = tsMs - this.lastTs;
    const freq = dt > 0 ? 1000 / dt : 30;
    this.lastTs = tsMs;
    const tip = hand[BLADE_LANDMARK];
    const blade = {
      x: this.filterX.filter(tip.x, freq),
      y: this.filterY.filter(tip.y, freq),
    };
    return {
      present: true,
      blade,
      landmarks: hand,
      handedness: results.handedness?.[0]?.[0]?.categoryName ?? null,
    };
  }

  close() {
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}

export { BLADE_LANDMARK };
