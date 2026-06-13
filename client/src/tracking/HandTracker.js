// Thin wrapper around MediaPipe HandLandmarker: loads the self-hosted model + wasm
// and returns the RAW index-fingertip (landmark 8) in normalized [0,1] coords.
// Smoothing happens downstream in screen-pixel space (see main.js) so the 1€ filter
// directly controls on-screen jitter with well-behaved pixel parameters.
import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";

const WASM_PATH = "/mediapipe/wasm";
const MODEL_PATH = "/models/hand_landmarker.task";
const BLADE_LANDMARK = 8; // INDEX_FINGER_TIP

export class HandTracker {
  constructor({ numHands = 1 } = {}) {
    this.numHands = numHands;
    this.landmarker = null;
    this.delegate = null;
  }

  async init() {
    const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_PATH, delegate },
      runningMode: "VIDEO",
      numHands: this.numHands,
      // v2 robust tracking: lower presence/tracking thresholds so MediaPipe HOLDS
      // the hand through marginal frames (motion blur, odd angles) instead of
      // dropping it — far fewer "it stopped tracking" gaps.
      minHandDetectionConfidence: 0.4,
      minHandPresenceConfidence: 0.3,
      minTrackingConfidence: 0.3,
    });
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

  /** @returns {{present, blade:{x,y}|null, hands:[{x,y}], landmarks, handedness}} */
  detect(video, tsMs) {
    if (!this.landmarker) return { present: false, blade: null, hands: [], landmarks: [], handedness: null };
    const results = this.landmarker.detectForVideo(video, tsMs);
    const all = results.landmarks || [];
    if (!all.length) return { present: false, blade: null, hands: [], landmarks: [], handedness: null };
    const hands = all.map((h) => ({ x: h[BLADE_LANDMARK].x, y: h[BLADE_LANDMARK].y }));
    return {
      present: true,
      blade: hands[0],          // first hand drives solo/versus
      hands,                    // all fingertips (split-screen uses both)
      landmarks: all[0],
      allLandmarks: all,        // every hand's full 21-point skeleton (ready gate dots)
      handedness: results.handedness?.[0]?.[0]?.categoryName ?? null,
    };
  }

  close() {
    this.landmarker?.close?.();
    this.landmarker = null;
  }
}

export { BLADE_LANDMARK };
