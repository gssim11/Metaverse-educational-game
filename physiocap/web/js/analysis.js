// PhysioCap 분석 엔진 — 브라우저와 Node(테스트) 양쪽에서 쓰는 순수 함수 모음.
// 입력: MediaPipe Pose Landmarker 프레임 목록
//   { t: 초, lm: [{x,y,z,visibility}] (정규화 이미지 좌표), wlm: [{x,y,z}] (미터, 골반 중심) , w, h }

export const LM = {
  nose: 0, lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

export const LANDMARK_NAMES = [
  'Nose', 'LEyeInner', 'LEye', 'LEyeOuter', 'REyeInner', 'REye', 'REyeOuter', 'LEar', 'REar',
  'MouthL', 'MouthR', 'LShoulder', 'RShoulder', 'LElbow', 'RElbow', 'LWrist', 'RWrist',
  'LPinky', 'RPinky', 'LIndex', 'RIndex', 'LThumb', 'RThumb', 'LHip', 'RHip',
  'LKnee', 'RKnee', 'LAnkle', 'RAnkle', 'LHeel', 'RHeel', 'LBigToe', 'RBigToe',
];

// 각도 채널 정의. src: 'w' = 3D 월드 좌표, 'i' = 2D 이미지 좌표(픽셀 비율 보정)
export const ANGLES = [
  { key: 'kneeFlexL', label: '무릎 굴곡 L', unit: '°', group: 'knee' },
  { key: 'kneeFlexR', label: '무릎 굴곡 R', unit: '°', group: 'knee' },
  { key: 'hipFlexL', label: '고관절 굴곡 L', unit: '°', group: 'hip' },
  { key: 'hipFlexR', label: '고관절 굴곡 R', unit: '°', group: 'hip' },
  { key: 'ankleDfL', label: '발목 배측굴곡 L', unit: '°', group: 'ankle' },
  { key: 'ankleDfR', label: '발목 배측굴곡 R', unit: '°', group: 'ankle' },
  { key: 'fppaL', label: '무릎 FPPA L (+외반)', unit: '°', group: 'frontal' },
  { key: 'fppaR', label: '무릎 FPPA R (+외반)', unit: '°', group: 'frontal' },
  { key: 'trunkLean', label: '체간 기울기', unit: '°', group: 'trunk' },
  { key: 'trunkLateral', label: '체간 측방 기울기', unit: '°', group: 'frontal' },
  { key: 'pelvicObliq', label: '골반 경사(전두면)', unit: '°', group: 'frontal' },
  { key: 'shoulderElevL', label: '어깨 거상 L', unit: '°', group: 'upper' },
  { key: 'shoulderElevR', label: '어깨 거상 R', unit: '°', group: 'upper' },
  { key: 'elbowFlexL', label: '팔꿈치 굴곡 L', unit: '°', group: 'upper' },
  { key: 'elbowFlexR', label: '팔꿈치 굴곡 R', unit: '°', group: 'upper' },
];

const VIS_MIN = 0.5;
const RAD = 180 / Math.PI;

// ---------- 벡터 ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

function vecAngle(u, v) {
  const n = norm(u) * norm(v);
  if (!n) return NaN;
  return Math.acos(Math.max(-1, Math.min(1, dot(u, v) / n))) * RAD;
}

// b에서의 내각 (a-b-c)
export function jointAngle(a, b, c) {
  return vecAngle(sub(a, b), sub(c, b));
}

function visible(lm, ...idx) {
  return idx.every((i) => lm[i] && (lm[i].visibility === undefined || lm[i].visibility >= VIS_MIN));
}

// ---------- 프레임 → 각도 ----------
export function computeAngles(frame) {
  const { lm, wlm } = frame;
  const out = {};
  for (const a of ANGLES) out[a.key] = NaN;
  if (!lm || !wlm) return out;
  const aspect = (frame.w || 1) / (frame.h || 1);
  const P = (i) => [wlm[i].x, wlm[i].y, wlm[i].z];
  const I = (i) => [lm[i].x * aspect, lm[i].y, 0]; // y 아래 방향, 종횡비 보정
  const ok = (...i) => visible(lm, ...i);
  const L = LM;

  const side = (s) => {
    const sh = s === 'L' ? L.lShoulder : L.rShoulder;
    const hip = s === 'L' ? L.lHip : L.rHip;
    const knee = s === 'L' ? L.lKnee : L.rKnee;
    const ank = s === 'L' ? L.lAnkle : L.rAnkle;
    const foot = s === 'L' ? L.lFoot : L.rFoot;
    const elb = s === 'L' ? L.lElbow : L.rElbow;
    const wr = s === 'L' ? L.lWrist : L.rWrist;
    if (ok(hip, knee, ank)) out['kneeFlex' + s] = 180 - jointAngle(P(hip), P(knee), P(ank));
    if (ok(sh, hip, knee)) out['hipFlex' + s] = 180 - jointAngle(P(sh), P(hip), P(knee));
    if (ok(knee, ank, foot)) out['ankleDf' + s] = 90 - jointAngle(P(knee), P(ank), P(foot)); // 하퇴-발 90° = 0, 발등이 정강이 쪽으로 가까워지면 +
    if (ok(sh, elb, wr)) out['elbowFlex' + s] = 180 - jointAngle(P(sh), P(elb), P(wr));
    if (ok(hip, sh, elb)) out['shoulderElev' + s] = jointAngle(P(hip), P(sh), P(elb));
    if (ok(L.lHip, L.rHip, hip, knee, ank)) out['fppa' + s] = fppa(I(hip), I(knee), I(ank), mid(I(L.lHip), I(L.rHip))[0]);
  };
  side('L');
  side('R');

  if (ok(L.lShoulder, L.rShoulder, L.lHip, L.rHip)) {
    const sw = mid(P(L.lShoulder), P(L.rShoulder));
    const hw = mid(P(L.lHip), P(L.rHip));
    out.trunkLean = vecAngle(sub(sw, hw), [0, -1, 0]); // 수직(위) 대비 3D 기울기
    const si = mid(I(L.lShoulder), I(L.rShoulder));
    const hi = mid(I(L.lHip), I(L.rHip));
    out.trunkLateral = Math.atan2(si[0] - hi[0], hi[1] - si[1]) * RAD; // 화면상 좌우 기울기(+ = 화면 오른쪽)
  }
  if (ok(L.lHip, L.rHip)) {
    const a = I(L.lHip), b = I(L.rHip);
    let ang = Math.atan2(a[1] - b[1], a[0] - b[0]) * RAD; // 수평 대비
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    out.pelvicObliq = ang;
  }
  return out;
}

// 전두면 투영각: 180 - 2D 무릎 내각. 무릎이 고관절-발목 선보다 정중선 쪽이면 외반(+)
export function fppa(hip, knee, ank, midX) {
  const mag = 180 - jointAngle(hip, knee, ank);
  const dy = ank[1] - hip[1];
  const tt = dy ? (knee[1] - hip[1]) / dy : 0.5;
  const lineX = hip[0] + tt * (ank[0] - hip[0]);
  const medial = Math.abs(knee[0] - midX) < Math.abs(lineX - midX);
  return medial ? mag : -mag;
}

// ---------- 신호 처리 ----------
// 불균일 샘플 → 균일 리샘플링 (선형 보간, NaN 구간은 보간 후 원래 공백이 길면 NaN 유지)
export function resample(t, y, fs) {
  const n = t.length;
  if (n < 2) return { t: t.slice(), y: y.slice() };
  const t0 = t[0], t1 = t[n - 1];
  const m = Math.max(2, Math.floor((t1 - t0) * fs) + 1);
  const tt = new Array(m), yy = new Array(m);
  let j = 0;
  for (let k = 0; k < m; k++) {
    const tk = t0 + k / fs;
    tt[k] = tk;
    while (j < n - 2 && t[j + 1] < tk) j++;
    const ya = y[j], yb = y[j + 1];
    const span = t[j + 1] - t[j];
    if (!Number.isFinite(ya) || !Number.isFinite(yb) || span <= 0) {
      yy[k] = Number.isFinite(ya) && tk - t[j] < 0.5 / fs ? ya : Number.isFinite(yb) && t[j + 1] - tk < 0.5 / fs ? yb : NaN;
    } else {
      yy[k] = ya + ((tk - t[j]) / span) * (yb - ya);
    }
  }
  return { t: tt, y: yy };
}

// 짧은 NaN 공백(<= maxGap 샘플) 선형 보간
export function fillGaps(y, maxGap = 15) {
  const out = y.slice();
  let i = 0;
  while (i < out.length) {
    if (Number.isFinite(out[i])) { i++; continue; }
    let j = i;
    while (j < out.length && !Number.isFinite(out[j])) j++;
    const gap = j - i;
    if (gap <= maxGap && i > 0 && j < out.length) {
      const a = out[i - 1], b = out[j];
      for (let k = i; k < j; k++) out[k] = a + ((k - i + 1) / (gap + 1)) * (b - a);
    }
    i = j;
  }
  return out;
}

// 2차 버터워스 저역통과 계수 (쌍선형 변환)
export function butter2(fc, fs) {
  const K = Math.tan((Math.PI * fc) / fs);
  const q = Math.SQRT2;
  const n = 1 / (1 + q * K + K * K);
  const b0 = K * K * n;
  return { b: [b0, 2 * b0, b0], a: [1, 2 * (K * K - 1) * n, (1 - q * K + K * K) * n] };
}

function lfilter({ b, a }, x) {
  const y = new Array(x.length);
  let x1 = x[0], x2 = x[0], y1 = x[0], y2 = x[0]; // 첫 값으로 초기화해 시작 과도응답 억제
  for (let i = 0; i < x.length; i++) {
    const v = b[0] * x[i] + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

// 영위상 필터(전후방) — 연속 유효 구간마다 적용
export function filtfilt(y, fc, fs) {
  if (!(fc > 0) || fc >= fs / 2) return y.slice();
  const coef = butter2(fc, fs);
  const out = y.slice();
  let i = 0;
  while (i < y.length) {
    if (!Number.isFinite(y[i])) { i++; continue; }
    let j = i;
    while (j < y.length && Number.isFinite(y[j])) j++;
    if (j - i >= 6) {
      const pad = Math.min(j - i - 1, 3 * 3);
      const seg = y.slice(i, j);
      // 반사 패딩
      const ext = [];
      for (let k = pad; k > 0; k--) ext.push(2 * seg[0] - seg[k]);
      ext.push(...seg);
      for (let k = 1; k <= pad; k++) ext.push(2 * seg[seg.length - 1] - seg[seg.length - 1 - k]);
      let f = lfilter(coef, ext);
      f = lfilter(coef, f.reverse()).reverse();
      for (let k = 0; k < seg.length; k++) out[i + k] = f[k + pad];
    }
    i = j;
  }
  return out;
}

// 실시간용 One Euro 필터
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff;
    this.x = null; this.dx = 0; this.t = null;
  }
  static alpha(cutoff, dt) { const r = 2 * Math.PI * cutoff * dt; return r / (r + 1); }
  filter(v, t) {
    if (!Number.isFinite(v)) return v;
    if (this.x === null || this.t === null || t <= this.t) { this.x = v; this.t = t; return v; }
    const dt = t - this.t;
    this.t = t;
    const dx = (v - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}

// ---------- 통계 ----------
const finite = (a) => a.filter(Number.isFinite);
export function stats(arr) {
  const v = finite(arr);
  if (!v.length) return { min: NaN, max: NaN, mean: NaN, sd: NaN, rom: NaN, n: 0 };
  let min = Infinity, max = -Infinity, s = 0;
  for (const x of v) { if (x < min) min = x; if (x > max) max = x; s += x; }
  const mean = s / v.length;
  const sd = Math.sqrt(v.reduce((acc, x) => acc + (x - mean) ** 2, 0) / Math.max(1, v.length - 1));
  return { min, max, mean, sd, rom: max - min, n: v.length };
}

// 대칭 지수 (%) — 0이면 완전 대칭
export function symmetryIndex(l, r) {
  if (!Number.isFinite(l) || !Number.isFinite(r)) return NaN;
  const m = (Math.abs(l) + Math.abs(r)) / 2;
  return m ? (Math.abs(l - r) / m) * 100 : 0;
}

// 극값 탐지 (최소 간격, 최소 돌출도)
export function findPeaks(y, { minDist = 1, minProm = 0, minHeight = -Infinity } = {}) {
  const cand = [];
  for (let i = 1; i < y.length - 1; i++) {
    if (!Number.isFinite(y[i])) continue;
    if (y[i] >= minHeight && y[i] > (y[i - 1] ?? -Infinity) && y[i] >= (y[i + 1] ?? -Infinity)) cand.push(i);
  }
  // 돌출도 계산
  const prom = (i) => {
    let lmin = y[i], rmin = y[i];
    for (let k = i - 1; k >= 0 && !(y[k] > y[i]); k--) if (y[k] < lmin) lmin = y[k];
    for (let k = i + 1; k < y.length && !(y[k] > y[i]); k++) if (y[k] < rmin) rmin = y[k];
    return y[i] - Math.max(lmin, rmin);
  };
  const withP = cand.map((i) => ({ i, p: prom(i) })).filter((c) => c.p >= minProm);
  withP.sort((a, b) => y[b.i] - y[a.i]);
  const keep = [];
  for (const c of withP) if (keep.every((k) => Math.abs(k - c.i) >= minDist)) keep.push(c.i);
  return keep.sort((a, b) => a - b);
}

// ---------- 세션 처리 ----------
// frames → 균일 시계열 { fs, t, series: {key: []}, pts2d, scale }
export function buildSeries(frames, { fs = 30, cutoff = 6, heightM = 0 } = {}) {
  const good = frames.filter((f) => f.lm && f.wlm);
  const t = frames.map((f) => f.t);
  const raw = {};
  for (const a of ANGLES) raw[a.key] = [];
  const extra = { hipX: [], hipY: [], lAnkX: [], rAnkX: [], lAnkY: [], rAnkY: [], lHeelY: [], rHeelY: [] };
  const scales = [];
  for (const f of frames) {
    const ang = f.lm && f.wlm ? computeAngles(f) : null;
    for (const a of ANGLES) raw[a.key].push(ang ? ang[a.key] : NaN);
    const L = LM;
    if (f.lm && visible(f.lm, L.lHip, L.rHip)) {
      const asp = (f.w || 1) / (f.h || 1);
      extra.hipX.push(((f.lm[L.lHip].x + f.lm[L.rHip].x) / 2) * asp);
      extra.hipY.push((f.lm[L.lHip].y + f.lm[L.rHip].y) / 2);
      const v = (i) => (visible(f.lm, i) ? f.lm[i] : null);
      extra.lAnkX.push(v(L.lAnkle) ? v(L.lAnkle).x * asp : NaN);
      extra.rAnkX.push(v(L.rAnkle) ? v(L.rAnkle).x * asp : NaN);
      extra.lAnkY.push(v(L.lAnkle) ? v(L.lAnkle).y : NaN);
      extra.rAnkY.push(v(L.rAnkle) ? v(L.rAnkle).y : NaN);
      extra.lHeelY.push(v(L.lHeel) ? v(L.lHeel).y : NaN);
      extra.rHeelY.push(v(L.rHeel) ? v(L.rHeel).y : NaN);
      // 축척: 월드 다리 길이(m) / 이미지 다리 길이(정규화 높이 단위)
      const sc = legScale(f, asp, heightM);
      if (Number.isFinite(sc)) scales.push(sc);
    } else {
      for (const k in extra) extra[k].push(NaN);
    }
  }
  const series = {};
  let tu = null;
  for (const key of [...Object.keys(raw), ...Object.keys(extra)]) {
    const src = raw[key] || extra[key];
    const r = resample(t, src, fs);
    tu = r.t;
    const filled = fillGaps(r.y, Math.round(fs * 0.5));
    series[key] = filtfilt(filled, cutoff, fs);
  }
  scales.sort((a, b) => a - b);
  const scale = scales.length ? scales[Math.floor(scales.length / 2)] : NaN; // 미터 / (정규화 y 단위)
  return { fs, t: tu || [], series, scale, validFrames: good.length, totalFrames: frames.length };
}

// Winter 인체 분절 비율: 대퇴 0.245H + 하퇴 0.246H
export const LEG_RATIO = 0.491;

function legScale(f, asp, heightM = 0) {
  const L = LM;
  let sum = 0, cnt = 0;
  for (const [h, k, a] of [[L.lHip, L.lKnee, L.lAnkle], [L.rHip, L.rKnee, L.rAnkle]]) {
    if (!visible(f.lm, h, k, a)) continue;
    const I = (i) => [f.lm[i].x * asp, f.lm[i].y, 0];
    const W = (i) => [f.wlm[i].x, f.wlm[i].y, f.wlm[i].z];
    const li = norm(sub(I(h), I(k))) + norm(sub(I(k), I(a)));
    const lw = heightM > 0 ? LEG_RATIO * heightM : norm(sub(W(h), W(k))) + norm(sub(W(k), W(a)));
    if (li > 0.02) { sum += lw / li; cnt++; }
  }
  return cnt ? sum / cnt : NaN;
}

function worldLeg(w) {
  const W = (i) => [w[i].x, w[i].y, w[i].z];
  const one = (h, k, a) => norm(sub(W(h), W(k))) + norm(sub(W(k), W(a)));
  return (one(23, 25, 27) + one(24, 26, 28)) / 2;
}

const avg2 = (a, b) => a.map((v, i) => (Number.isFinite(v) && Number.isFinite(b[i]) ? (v + b[i]) / 2 : Number.isFinite(v) ? v : b[i]));

// 반복 동작 분할: 신호가 hi를 넘었다가 lo 아래로 돌아오면 1회
export function segmentReps(y, t, { hi, lo, minDur = 0.4 }) {
  const reps = [];
  let state = 'up', start = -1, peakI = -1;
  let lastBelow = 0;
  for (let i = 0; i < y.length; i++) {
    const v = y[i];
    if (!Number.isFinite(v)) continue;
    if (state === 'up') {
      if (v < lo) lastBelow = i;
      if (v > hi) { state = 'down'; start = lastBelow; peakI = i; }
    } else {
      if (v > y[peakI]) peakI = i;
      if (v < lo) {
        if (t[i] - t[start] >= minDur) reps.push({ start, peak: peakI, end: i });
        state = 'up'; lastBelow = i;
      }
    }
  }
  return reps;
}

const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : NaN);
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN);

function romTable(S) {
  const rows = {};
  for (const a of ANGLES) {
    const s = stats(S.series[a.key]);
    rows[a.key] = { label: a.label, min: r1(s.min), max: r1(s.max), mean: r1(s.mean), rom: r1(s.rom) };
  }
  return rows;
}

// ---------- 검사 프로토콜 ----------
export const PROTOCOLS = {
  squat: { name: '스쿼트', view: '정면 또는 측면', hint: '전신이 보이게 2.5~3m 거리, 정면 촬영 시 무릎 외반(FPPA)까지 분석' },
  sts: { name: '앉았다 일어서기 (5회/30초)', view: '측면', hint: '의자 옆에서 측면 촬영, 팔은 가슴 앞에 교차' },
  gait: { name: '보행', view: '측면', hint: '카메라 앞을 가로질러 4~5m 걷기, 전신이 화면에 들어오게' },
  balance: { name: '한발 서기 균형', view: '정면', hint: '정면에서 촬영, 한 발을 들고 최대한 유지' },
  rom: { name: '관절가동범위(ROM)', view: '측정 관절이 잘 보이는 방향', hint: '천천히 끝 범위까지 움직였다 돌아오기' },
  free: { name: '자유 동작', view: '자유', hint: '전 관절 각도 시계열 기록' },
};

export function analyze(frames, protocol = 'free', opts = {}) {
  const S = buildSeries(frames, opts);
  const { t, series: s } = S;
  const res = {
    protocol, protocolName: PROTOCOLS[protocol]?.name || protocol,
    duration: r2(t.length ? t[t.length - 1] - t[0] : 0),
    detectionRate: S.totalFrames ? r1((S.validFrames / S.totalFrames) * 100) : 0,
    metrics: [], reps: [], events: [], rom: romTable(S), notes: [],
  };
  const M = (label, value, unit = '', extra = {}) => res.metrics.push({ label, value, unit, ...extra });
  const sym = (label, l, r) => {
    const si = symmetryIndex(l, r);
    M(label + ' 대칭지수', r1(si), '%', { flag: si > 15 ? 'warn' : '' });
  };
  if (res.detectionRate < 70) res.notes.push('신체 검출률이 낮습니다. 전신이 화면에 들어오도록 거리·조명을 조정하세요.');

  if (protocol === 'squat') {
    const knee = avg2(s.kneeFlexL, s.kneeFlexR);
    const reps = segmentReps(knee, t, { hi: 45, lo: 25, minDur: 0.5 });
    res.reps = reps.map((rp, i) => ({
      n: i + 1,
      duration: r2(t[rp.end] - t[rp.start]),
      descent: r2(t[rp.peak] - t[rp.start]),
      ascent: r2(t[rp.end] - t[rp.peak]),
      kneeL: r1(s.kneeFlexL[rp.peak]), kneeR: r1(s.kneeFlexR[rp.peak]),
      hipL: r1(s.hipFlexL[rp.peak]), hipR: r1(s.hipFlexR[rp.peak]),
      trunk: r1(s.trunkLean[rp.peak]),
      fppaL: r1(stats(s.fppaL.slice(rp.start, rp.end + 1)).max),
      fppaR: r1(stats(s.fppaR.slice(rp.start, rp.end + 1)).max),
    }));
    M('반복 횟수', res.reps.length, '회');
    if (res.reps.length) {
      const mean = (k) => r1(stats(res.reps.map((r) => r[k])).mean);
      M('최대 무릎 굴곡 L', mean('kneeL'), '°');
      M('최대 무릎 굴곡 R', mean('kneeR'), '°');
      sym('무릎 굴곡', mean('kneeL'), mean('kneeR'));
      M('최대 고관절 굴곡 L', mean('hipL'), '°');
      M('최대 고관절 굴곡 R', mean('hipR'), '°');
      M('최저점 체간 기울기', mean('trunk'), '°');
      M('최대 FPPA L (+외반)', mean('fppaL'), '°', { flag: mean('fppaL') > 10 ? 'warn' : '' });
      M('최대 FPPA R (+외반)', mean('fppaR'), '°', { flag: mean('fppaR') > 10 ? 'warn' : '' });
      M('평균 반복 시간', mean('duration'), 's');
      M('하강/상승 시간', `${mean('descent')} / ${mean('ascent')}`, 's');
    } else res.notes.push('스쿼트 반복이 검출되지 않았습니다(무릎 굴곡 45° 이상 필요).');
    res.notes.push('FPPA는 정면 촬영에서만 의미가 있습니다. 측면 촬영이면 무시하세요.');
  } else if (protocol === 'sts') {
    const knee = avg2(s.kneeFlexL, s.kneeFlexR);
    // 앉음(무릎 > 65°) → 섬(무릎 < 30°) 전환 시점 = 기립 완료
    const standTimes = [];
    let seated = false;
    for (let i = 0; i < knee.length; i++) {
      const v = knee[i];
      if (!Number.isFinite(v)) continue;
      if (v > 65) seated = true;
      else if (v < 30 && seated) { seated = false; standTimes.push(t[i]); }
    }
    res.events = standTimes.map((tt, i) => ({ n: i + 1, t: r2(tt - t[0]) }));
    M('일어서기 횟수', standTimes.length, '회');
    if (standTimes.length >= 5) M('5회 앉았다 일어서기 시간', r2(standTimes[4] - t[0]), 's');
    const in30 = standTimes.filter((tt) => tt - t[0] <= 30).length;
    if (res.duration >= 29) M('30초 일어서기 횟수', in30, '회');
    const ks = stats(knee);
    M('최대 무릎 굴곡(앉은 자세)', r1(ks.max), '°');
    M('최대 체간 전방 기울기', r1(stats(s.trunkLean).max), '°');
    if (standTimes.length > 1) {
      const d = standTimes.slice(1).map((v, i) => v - standTimes[i]);
      M('반복 주기 평균±SD', `${r2(stats(d).mean)} ± ${r2(stats(d).sd)}`, 's');
    }
    res.notes.push('5회 시간은 기록 시작부터 5번째 기립 완료까지입니다. 시작 신호에 맞춰 기록을 시작하세요.');
  } else if (protocol === 'gait') {
    const d = s.lAnkX.map((v, i) => v - s.rAnkX[i]);
    const minDist = Math.round(S.fs * 0.3);
    const pk = findPeaks(d, { minDist, minProm: 0.03 });
    const tr = findPeaks(d.map((v) => -v), { minDist, minProm: 0.03 });
    const steps = [...pk.map((i) => ({ i, side: 'A' })), ...tr.map((i) => ({ i, side: 'B' }))].sort((a, b) => a.i - b.i);
    res.events = steps.map((e, n) => ({ n: n + 1, t: r2(t[e.i] - t[0]), side: e.side }));
    M('검출 걸음 수', steps.length, '걸음');
    if (steps.length >= 3) {
      const st = steps.slice(1).map((e, n) => t[e.i] - t[steps[n].i]);
      const ss = stats(st);
      M('분속수(cadence)', r1(60 / ss.mean), '걸음/분');
      M('걸음 시간 평균±SD', `${r2(ss.mean)} ± ${r2(ss.sd)}`, 's');
      M('걸음 시간 변동계수', r1((ss.sd / ss.mean) * 100), '%', { flag: (ss.sd / ss.mean) * 100 > 5 ? 'warn' : '' });
      if (Number.isFinite(S.scale)) {
        const len = steps.map((e) => Math.abs(d[e.i]) * S.scale);
        M('걸음 길이(추정)', r2(stats(len).mean), 'm');
        const hx = finite(s.hipX);
        const dist = hx.length ? Math.abs(hx[hx.length - 1] - hx[0]) * S.scale : NaN;
        const tt = t[t.length - 1] - t[0];
        if (dist > 0.5 && tt > 0) M('보행 속도(추정)', r2(dist / tt), 'm/s');
      }
    }
    const kl = stats(s.kneeFlexL), kr = stats(s.kneeFlexR);
    M('무릎 굴곡 최대 L', r1(kl.max), '°');
    M('무릎 굴곡 최대 R', r1(kr.max), '°');
    sym('무릎 굴곡 최대', kl.max, kr.max);
    M('고관절 ROM L / R', `${r1(stats(s.hipFlexL).rom)} / ${r1(stats(s.hipFlexR).rom)}`, '°');
    M('발목 ROM L / R', `${r1(stats(s.ankleDfL).rom)} / ${r1(stats(s.ankleDfR).rom)}`, '°');
    res.notes.push('측면 촬영 기준. 걸음 길이·속도는 다리 길이 기반 축척 추정치이며 카메라 가까이/멀리 걸으면 오차가 커집니다.');
  } else if (protocol === 'balance') {
    const lift = s.lAnkY.map((v, i) => (s.rAnkY[i] - v)); // + = 왼발이 더 높음(y 작음)
    const thr = 0.03;
    const on = lift.map((v) => (Number.isFinite(v) ? (Math.abs(v) > thr ? Math.sign(v) : 0) : 0));
    // 가장 긴 연속 들기 구간
    let best = { len: 0, a: 0, b: 0, side: 0 }, a = 0;
    for (let i = 1; i <= on.length; i++) {
      if (i === on.length || on[i] !== on[a]) {
        if (on[a] !== 0 && i - a > best.len) best = { len: i - a, a, b: i - 1, side: on[a] };
        a = i;
      }
    }
    if (best.len) {
      const dur = t[best.b] - t[best.a];
      M('지지 다리', best.side > 0 ? '오른발(R)' : '왼발(L)');
      M('한발 서기 유지 시간', r2(dur), 's');
      const hx = s.hipX.slice(best.a, best.b + 1), hy = s.hipY.slice(best.a, best.b + 1);
      const sc = Number.isFinite(S.scale) ? S.scale * 100 : NaN; // cm
      const sx = stats(hx), sy = stats(hy);
      M('골반 좌우 흔들림 SD', r2(sx.sd * sc), 'cm');
      M('골반 상하 흔들림 SD', r2(sy.sd * sc), 'cm');
      let path = 0;
      for (let i = 1; i < hx.length; i++) if (Number.isFinite(hx[i]) && Number.isFinite(hx[i - 1])) path += Math.hypot(hx[i] - hx[i - 1], hy[i] - hy[i - 1]);
      M('골반 궤적 속도', r2((path * sc) / Math.max(dur, 1e-6)), 'cm/s');
      M('최대 골반 경사', r1(stats(s.pelvicObliq.slice(best.a, best.b + 1).map(Math.abs)).max), '°');
      M('최대 체간 측방 기울기', r1(stats(s.trunkLateral.slice(best.a, best.b + 1).map(Math.abs)).max), '°');
      res.events = [{ n: 1, t: r2(t[best.a] - t[0]), label: '발 들기' }, { n: 2, t: r2(t[best.b] - t[0]), label: '발 내림' }];
    } else res.notes.push('한발 들기 구간이 검출되지 않았습니다. 정면에서 발이 보이도록 촬영하세요.');
    res.notes.push('흔들림(cm)은 골반 중심의 2D 궤적에 다리 길이 축척을 곱한 추정치입니다(압력판 COP와 다름).');
  } else if (protocol === 'rom') {
    const order = Object.entries(res.rom).filter(([, v]) => Number.isFinite(v.rom)).sort((a, b) => b[1].rom - a[1].rom);
    for (const [, v] of order.slice(0, 6)) M(`${v.label} 범위`, `${v.min} → ${v.max} (${v.rom})`, '°');
    res.notes.push('가장 크게 움직인 관절 순으로 표시합니다. 측정 관절이 카메라에 수직인 평면에서 움직일 때 가장 정확합니다.');
  } else {
    for (const k of ['kneeFlexL', 'kneeFlexR', 'hipFlexL', 'hipFlexR', 'trunkLean']) M(res.rom[k].label + ' ROM', res.rom[k].rom, '°');
  }
  return { result: res, series: S };
}

// ---------- 내보내기 ----------
export function toCSV(S) {
  const keys = Object.keys(S.series);
  const lines = ['time_s,' + keys.join(',')];
  for (let i = 0; i < S.t.length; i++) {
    lines.push([S.t[i] - S.t[0], ...keys.map((k) => S.series[k][i])].map((v) => (Number.isFinite(v) ? +v.toFixed(4) : '')).join(','));
  }
  return lines.join('\n');
}

export function landmarksCSV(frames) {
  const head = ['time_s'];
  for (const n of LANDMARK_NAMES) head.push(`${n}_x`, `${n}_y`, `${n}_vis`, `${n}_wx`, `${n}_wy`, `${n}_wz`);
  const t0 = frames.length ? frames[0].t : 0;
  const rows = [head.join(',')];
  for (const f of frames) {
    const r = [(f.t - t0).toFixed(4)];
    for (let i = 0; i < 33; i++) {
      const a = f.lm?.[i], b = f.wlm?.[i];
      r.push(a ? a.x.toFixed(5) : '', a ? a.y.toFixed(5) : '', a?.visibility != null ? a.visibility.toFixed(3) : '', b ? b.x.toFixed(5) : '', b ? b.y.toFixed(5) : '', b ? b.z.toFixed(5) : '');
    }
    rows.push(r.join(','));
  }
  return rows.join('\n');
}

// OpenSim TRC (미터, Y 위). 월드 좌표(골반 중심) + 2D 골반 궤적 기반 전역 이동 추정
export function toTRC(frames, { fs = 30, name = 'physiocap.trc', heightM = 0 } = {}) {
  const valid = frames.filter((f) => f.wlm && f.lm);
  if (!valid.length) return '';
  const t0 = valid[0].t;
  const asp = (valid[0].w || 1) / (valid[0].h || 1);
  const scales = valid.map((f) => legScale(f, asp, heightM)).filter(Number.isFinite).sort((a, b) => a - b);
  const sc = scales.length ? scales[Math.floor(scales.length / 2)] : 0;
  // 키 입력 시 월드 좌표 자체도 실제 체격으로 보정
  let kW = 1;
  if (heightM > 0) {
    const wl = valid.map((f) => worldLeg(f.wlm)).filter((v) => v > 0.2).sort((a, b) => a - b);
    if (wl.length) kW = (LEG_RATIO * heightM) / wl[Math.floor(wl.length / 2)];
  }
  // 첫 프레임 기준 발바닥(뒤꿈치·발끝) 높이를 0으로
  const f0 = valid[0].wlm;
  const floor = Math.max(f0[29].y, f0[30].y, f0[31].y, f0[32].y) * kW;
  const hip0 = [(valid[0].lm[23].x + valid[0].lm[24].x) / 2 * asp, (valid[0].lm[23].y + valid[0].lm[24].y) / 2];
  // 균일 시간 격자로 리샘플링
  const tEnd = valid[valid.length - 1].t;
  const n = Math.max(1, Math.floor((tEnd - t0) * fs) + 1);
  const M = LANDMARK_NAMES.length;
  const hdr = [
    `PathFileType\t4\t(X/Y/Z)\t${name}`,
    'DataRate\tCameraRate\tNumFrames\tNumMarkers\tUnits\tOrigDataRate\tOrigDataStartFrame\tOrigNumFrames',
    `${fs}\t${fs}\t${n}\t${M}\tm\t${fs}\t1\t${n}`,
    'Frame#\tTime\t' + LANDMARK_NAMES.map((x) => `${x}\t\t\t`).join('').replace(/\t+$/, ''),
    '\t\t' + LANDMARK_NAMES.map((_, i) => `X${i + 1}\tY${i + 1}\tZ${i + 1}`).join('\t'),
    '',
  ];
  const out = [];
  let j = 0;
  for (let k = 0; k < n; k++) {
    const tk = t0 + k / fs;
    while (j < valid.length - 1 && valid[j + 1].t <= tk) j++;
    const A = valid[j], B = valid[Math.min(j + 1, valid.length - 1)];
    const span = B.t - A.t;
    const u = span > 0 ? Math.min(1, Math.max(0, (tk - A.t) / span)) : 0;
    const lerp = (a, b) => a + u * (b - a);
    const hx = lerp((A.lm[23].x + A.lm[24].x) / 2, (B.lm[23].x + B.lm[24].x) / 2) * asp;
    const hy = lerp((A.lm[23].y + A.lm[24].y) / 2, (B.lm[23].y + B.lm[24].y) / 2);
    const gx = (hx - hip0[0]) * sc, gy = -(hy - hip0[1]) * sc;
    const row = [k + 1, (tk - t0).toFixed(5)];
    for (let i = 0; i < M; i++) {
      const x = lerp(A.wlm[i].x, B.wlm[i].x) * kW + gx;
      const y = -lerp(A.wlm[i].y, B.wlm[i].y) * kW + gy + floor;
      const z = -lerp(A.wlm[i].z, B.wlm[i].z) * kW;
      row.push(x.toFixed(5), y.toFixed(5), z.toFixed(5));
    }
    out.push(row.join('\t'));
  }
  return hdr.join('\n') + '\n' + out.join('\n') + '\n';
}
