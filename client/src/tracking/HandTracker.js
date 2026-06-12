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
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
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

  /** @returns {{present:boolean, blade:{x,y}|null, landmarks:Array, handedness:string|null}} */
  detect(video, tsMs) {
    if (!this.landmarker) return { present: false, blade: null, landmarks: [], handedness: null };
    const results = this.landmarker.detectForVideo(video, tsMs);
    const hand = results.landmarks?.[0];
    if (!hand) return { present: false, blade: null, landmarks: [], handedness: null };
    const tip = hand[BLADE_LANDMARK];
    return {
      present: true,
      blade: { x: tip.x, y: tip.y },
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
