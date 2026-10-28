// MediaPipe Pose Landmarker 래퍼 — 번들된 로컬 자산 우선, 없으면 CDN
const LOCAL = new URL('../vendor/', import.meta.url).href;
const CDN_VER = '1.1.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${CDN_VER}`;
const MODEL_REMOTE = (m) => `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${m}/float16/latest/pose_landmarker_${m}.task`;

// MediaPipe 웹 런타임은 성능 통계(작업 종류·지연시간)를 Google 로깅 서버로 보낸다. 끌 수 있는 옵션이 없어
// 해당 주소로 가는 fetch 만 네트워크에 나가지 않게 막는다. (응답이 200이 아니면 로거가 스스로 멈춘다)
const TELEMETRY_HOST = 'odml.pa.googleapis.com';
if (!globalThis.__physiocapNoTelemetry) {
  globalThis.__physiocapNoTelemetry = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || String(input);
    if (url.includes(TELEMETRY_HOST)) return Promise.resolve(new Response(null, { status: 204 }));
    return realFetch(input, init);
  };
}

let vision = null;
let wasmBase = null;

async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok;
  } catch { return false; }
}

async function loadVision() {
  if (vision) return vision;
  if (await exists(LOCAL + 'tasks-vision/vision_bundle.mjs')) {
    vision = await import(LOCAL + 'tasks-vision/vision_bundle.mjs');
    wasmBase = LOCAL + 'tasks-vision/wasm';
  } else {
    vision = await import(`${CDN}/vision_bundle.mjs`);
    wasmBase = `${CDN}/wasm`;
  }
  return vision;
}

export async function modelAvailable(model) {
  return exists(`${LOCAL}models/pose_landmarker_${model}.task`);
}

// model: 'lite' | 'full' | 'heavy'
export async function createPose({ model = 'full', mode = 'VIDEO', onStatus = () => {} } = {}) {
  onStatus('엔진 불러오는 중…');
  const { FilesetResolver, PoseLandmarker } = await loadVision();
  const files = await FilesetResolver.forVisionTasks(wasmBase);
  const local = `${LOCAL}models/pose_landmarker_${model}.task`;
  const modelAssetPath = (await exists(local)) ? local : MODEL_REMOTE(model);
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath, delegate },
    runningMode: mode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  let lm, delegate = 'GPU';
  onStatus(`모델(${model}) 준비 중…`);
  try {
    lm = await PoseLandmarker.createFromOptions(files, opts('GPU'));
  } catch (e) {
    console.warn('GPU 실패, CPU로 전환', e);
    delegate = 'CPU';
    lm = await PoseLandmarker.createFromOptions(files, opts('CPU'));
  }
  onStatus('');
  return { landmarker: lm, delegate, model, connections: PoseLandmarker.POSE_CONNECTIONS };
}

// 결과 → 직렬화 가능한 프레임
export function toFrame(result, t, w, h) {
  const lm = result?.landmarks?.[0];
  const wlm = result?.worldLandmarks?.[0];
  if (!lm || !wlm) return { t, lm: null, wlm: null, w, h };
  return {
    t, w, h,
    lm: lm.map((p) => ({ x: p.x, y: p.y, z: p.z, visibility: p.visibility ?? 1 })),
    wlm: wlm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
  };
}
