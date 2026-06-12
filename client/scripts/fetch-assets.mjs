// Populate self-hosted MediaPipe assets so nothing is fetched from a third-party
// CDN at runtime (works offline, no CORS surprises). Idempotent: skips anything
// already present, so the committed copies make Docker builds network-free for assets.
import { existsSync, mkdirSync, cpSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "..", "public");

const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const modelPath = resolve(pub, "models", "hand_landmarker.task");
const wasmSrc = resolve(here, "..", "node_modules", "@mediapipe", "tasks-vision", "wasm");
const wasmDst = resolve(pub, "mediapipe", "wasm");

async function downloadModel() {
  if (existsSync(modelPath)) {
    console.log("[assets] model present, skipping download");
    return;
  }
  mkdirSync(dirname(modelPath), { recursive: true });
  console.log("[assets] downloading hand_landmarker.task …");
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: ${res.status}`);
  await new Promise((ok, err) => {
    const file = createWriteStream(modelPath);
    Readable.fromWeb(res.body).pipe(file).on("finish", ok).on("error", err);
  });
  console.log("[assets] model saved");
}

function copyWasm() {
  if (existsSync(wasmDst)) {
    console.log("[assets] wasm present, skipping copy");
    return;
  }
  if (!existsSync(wasmSrc)) {
    console.warn("[assets] tasks-vision wasm not found in node_modules — skipping (deps not installed?)");
    return;
  }
  mkdirSync(dirname(wasmDst), { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log("[assets] wasm copied to public/mediapipe/wasm");
}

await downloadModel();
copyWasm();
