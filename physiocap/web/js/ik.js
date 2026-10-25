// PhysioCap 간이 역기구학(IK)
// 1) 보정: 바르게 선 구간을 찾아 실제 수직축(중력 방향)과 카메라 기울기를 추정
// 2) 스케일링: 보정 구간(없으면 전체)의 중앙값으로 개인 분절 길이·발/체간 형상 고정
// 3) 프레임별 IK: 강체 분절 + 관절 자유도·가동범위 제약 모델을 랜드마크에 Levenberg–Marquardt 로 맞춤
//
// 좌표계(지면 G, OpenSim 관례): X = 전방, Y = 위(보정된 수직), Z = 오른쪽.
// 골반 전후방 경사(tilt)는 MediaPipe 점(ASIS/PSIS 없음)으로 관찰할 수 없어 0(중립)으로 고정한다.
// 따라서 고관절 굴곡 = 골반 중립 가정에서의 대퇴 각, 체간 전방 기울기는 요추 굴곡으로 흡수된다.

const RAD = 180 / Math.PI;
const DEG = Math.PI / 180;
const VIS = 0.5;

// MediaPipe 인덱스
const I = {
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24,
  lKn: 25, rKn: 26, lAn: 27, rAn: 28, lHe: 29, rHe: 30, lTo: 31, rTo: 32,
};

// ---------- 작은 선형대수 ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => { const n = norm(a); return n ? scale(a, 1 / n) : [0, 0, 0]; };
const mid = (a, b) => scale(add(a, b), 0.5);
const median = (arr) => {
  const v = arr.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : NaN;
};

// 3x3 행렬 (행 우선 배열 9개)
const mul = (A, B) => {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
  return C;
};
const mv = (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]];
const Rx = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; };
const Ry = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 1, 0, -s, 0, c]; };
const Rz = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; };

const vis = (lm, ...ix) => !!lm && ix.every((i) => lm[i] && (lm[i].visibility ?? 1) >= VIS);
const W = (f, i) => [f.wlm[i].x, f.wlm[i].y, f.wlm[i].z];

// ---------- 1) 보정 ----------
// 무릎이 펴지고(굴곡 < 15°) 체간-대퇴가 곧은(< 20°) 프레임이 0.4초 이상 이어진 첫 구간 = 바른 선 자세
export function findStanding(frames) {
  const ok = frames.map((f) => {
    if (!f.lm || !f.wlm || !vis(f.lm, I.lHip, I.rHip, I.lKn, I.rKn, I.lAn, I.rAn, I.lSh, I.rSh)) return false;
    const knee = (h, k, a) => 180 - angle3(W(f, h), W(f, k), W(f, a));
    const tt = (s, h, k) => 180 - angle3(W(f, s), W(f, h), W(f, k));
    return knee(I.lHip, I.lKn, I.lAn) < 15 && knee(I.rHip, I.rKn, I.rAn) < 15 && tt(I.lSh, I.lHip, I.lKn) < 20 && tt(I.rSh, I.rHip, I.rKn) < 20;
  });
  let a = -1;
  for (let i = 0; i <= frames.length; i++) {
    if (i < frames.length && ok[i]) { if (a < 0) a = i; continue; }
    if (a >= 0) {
      const dur = frames[i - 1].t - frames[a].t;
      if (dur >= 0.4) {
        // 최대 1.5초만 사용
        let b = i - 1;
        while (b > a && frames[b].t - frames[a].t > 1.5) b--;
        return { start: a, end: b };
      }
      a = -1;
    }
  }
  return null;
}

function angle3(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const n = norm(u) * norm(v);
  return n ? Math.acos(Math.max(-1, Math.min(1, dot(u, v) / n))) * RAD : NaN;
}

// 반환: { calibrated, up (MP 월드 좌표의 위쪽 단위벡터), roll (화면 기울기, 라디안), G: {X,Y,Z}, standing }
export function calibrate(frames) {
  const st = findStanding(frames);
  let up = [0, -1, 0], roll = 0, calibrated = false, reason = '';
  if (st) {
    let u3 = [0, 0, 0], u2x = 0, u2y = 0;
    for (let i = st.start; i <= st.end; i++) {
      const f = frames[i];
      const hip = mid(W(f, I.lHip), W(f, I.rHip));
      const ank = mid(W(f, I.lAn), W(f, I.rAn));
      u3 = add(u3, unit(sub(hip, ank)));
      const asp = (f.w || 1) / (f.h || 1);
      const hx = (f.lm[I.lHip].x + f.lm[I.rHip].x) / 2 * asp, hy = (f.lm[I.lHip].y + f.lm[I.rHip].y) / 2;
      const ax = (f.lm[I.lAn].x + f.lm[I.rAn].x) / 2 * asp, ay = (f.lm[I.lAn].y + f.lm[I.rAn].y) / 2;
      const n = Math.hypot(hx - ax, hy - ay) || 1;
      u2x += (hx - ax) / n; u2y += (hy - ay) / n;
    }
    const cand = unit(u3);
    const tilt = Math.acos(Math.max(-1, Math.min(1, -cand[1]))) * RAD;
    if (tilt <= 25) {
      up = cand;
      roll = Math.atan2(u2x, -u2y); // 화면에서 위쪽 축이 기운 각 (+ = 오른쪽으로 기움)
      calibrated = true;
    } else reason = `선 자세의 다리 축이 카메라 수직과 ${tilt.toFixed(0)}° 달라 보정을 건너뜀`;
  } else reason = '바르게 선 구간(0.4초 이상)이 없어 카메라를 수평으로 가정';
  // 지면 좌표계: Y = 위, X = 카메라 쪽 방향의 수평 성분, Z = X × Y
  const Y = up;
  let X = sub([0, 0, -1], scale(Y, dot([0, 0, -1], Y)));
  X = norm(X) > 1e-6 ? unit(X) : [1, 0, 0];
  const Z = cross(X, Y);
  return { calibrated, up, roll, G: { X, Y, Z }, standing: st, reason };
}

const toG = (G, p) => [dot(p, G.X), dot(p, G.Y), dot(p, G.Z)];

// 2D 화면 기울기 보정 (화면 중심 기준 회전)
export function unrollPoint(x, y, roll, cx, cy) {
  const c = Math.cos(-roll), s = Math.sin(-roll);
  const dx = x - cx, dy = y - cy;
  return [cx + c * dx - s * dy, cy + s * dx + c * dy];
}

// ---------- 2) 스케일링 ----------
export function scaleModel(frames, cal, heightM = 0) {
  const idx = [];
  if (cal.standing) for (let i = cal.standing.start; i <= cal.standing.end; i++) idx.push(i);
  else frames.forEach((f, i) => { if (f.wlm && f.lm) idx.push(i); });
  const pick = idx.map((i) => frames[i]).filter((f) => f.wlm && f.lm);
  const med = (fn) => median(pick.map((f) => { try { return fn(f); } catch { return NaN; } }));
  const d = (f, a, b) => (vis(f.lm, a, b) ? norm(sub(W(f, a), W(f, b))) : NaN);

  const m = {
    hipW: med((f) => d(f, I.lHip, I.rHip)),
    thigh: med((f) => (d(f, I.lHip, I.lKn) + d(f, I.rHip, I.rKn)) / 2),
    shank: med((f) => (d(f, I.lKn, I.lAn) + d(f, I.rKn, I.rAn)) / 2),
    upperArm: med((f) => (d(f, I.lSh, I.lEl) + d(f, I.rSh, I.rEl)) / 2),
    forearm: med((f) => (d(f, I.lEl, I.lWr) + d(f, I.rEl, I.rWr)) / 2),
  };
  // 한쪽만 보이는 경우 대비
  if (!Number.isFinite(m.thigh)) m.thigh = med((f) => d(f, I.lHip, I.lKn) || d(f, I.rHip, I.rKn));
  if (!Number.isFinite(m.shank)) m.shank = med((f) => d(f, I.lKn, I.lAn) || d(f, I.rKn, I.rAn));
  const def = { hipW: 0.18, thigh: 0.42, shank: 0.41, upperArm: 0.29, forearm: 0.26 };
  for (const k in def) if (!(m[k] > 0.05)) m[k] = def[k];

  // 키 입력 시 다리 길이를 Winter 비율(0.245H + 0.246H)에 맞춰 전체 축척 보정
  m.k = 1;
  if (heightM > 0) {
    m.k = (0.491 * heightM) / (m.thigh + m.shank);
    for (const key of ['hipW', 'thigh', 'shank', 'upperArm', 'forearm']) m[key] *= m.k;
  }

  // 발 형상: 바른 자세에서 발목 기준 뒤꿈치·발끝 위치(하퇴 좌표 = 보정 자세에서 수직). 없으면 뒤꿈치-발끝 선이 하퇴에 수직이라 가정
  const footVec = (f, an, he, to, side) => {
    if (!vis(f.lm, an, he, to, I.lHip, I.rHip)) return null;
    const hdg = heading(f, cal);
    const local = (p) => {
      const g = toG(cal.G, sub(W(f, p), W(f, an)));
      const b = [dot(g, hdg.fwd), g[1], dot(g, hdg.right)];
      return [b[0] * m.k, b[1] * m.k, b[2] * m.k * side];
    };
    return { heel: local(he), toe: local(to) };
  };
  if (cal.standing) {
    const fv = [];
    for (const f of pick) {
      const r = footVec(f, I.rAn, I.rHe, I.rTo, 1), l = footVec(f, I.lAn, I.lHe, I.lTo, -1);
      for (const v of [r, l]) if (v) fv.push(v);
    }
    if (fv.length) {
      const c = (k, j) => median(fv.map((v) => v[k][j]));
      m.heel = [c('heel', 0), c('heel', 1), 0];
      m.toe = [c('toe', 0), c('toe', 1), 0];
    }
  }
  if (!m.heel) {
    const dh = med((f) => (d(f, I.lAn, I.lHe) + d(f, I.rAn, I.rHe)) / 2) * m.k || 0.07;
    const dt = med((f) => (d(f, I.lAn, I.lTo) + d(f, I.rAn, I.rTo)) / 2) * m.k || 0.17;
    const fl = med((f) => (d(f, I.lHe, I.lTo) + d(f, I.rHe, I.rTo)) / 2) * m.k || 0.22;
    const a = (fl * fl + dh * dh - dt * dt) / (2 * fl);
    const h = Math.sqrt(Math.max(dh * dh - a * a, 1e-4));
    m.heel = [-a, -h, 0];
    m.toe = [fl - a, -h, 0];
  }

  // 체간: 보정 자세에서 골반 중심 기준 어깨 위치(앞뒤 오프셋 포함). 없으면 수직 위
  const shW = med((f) => d(f, I.lSh, I.rSh)) * m.k || 0.36;
  let shUp = med((f) => (vis(f.lm, I.lSh, I.rSh, I.lHip, I.rHip) ? norm(sub(mid(W(f, I.lSh), W(f, I.rSh)), mid(W(f, I.lHip), W(f, I.rHip)))) : NaN)) * m.k;
  if (!(shUp > 0.2)) shUp = 0.5;
  let shFwd = 0;
  if (cal.standing) {
    shFwd = median(pick.map((f) => {
      if (!vis(f.lm, I.lSh, I.rSh, I.lHip, I.rHip)) return NaN;
      const hdg = heading(f, cal);
      const g = toG(cal.G, sub(mid(W(f, I.lSh), W(f, I.rSh)), mid(W(f, I.lHip), W(f, I.rHip))));
      return dot(g, hdg.fwd) * m.k;
    }));
    if (!Number.isFinite(shFwd)) shFwd = 0;
    shUp = Math.sqrt(Math.max(shUp * shUp - shFwd * shFwd, 0.04));
  }
  m.shoulder = [shFwd, shUp, shW / 2];
  return m;
}

// 골반 진행 방향: 좌→우 고관절 선의 수평 성분 = 오른쪽, 전방 = 위 × 오른쪽
function heading(f, cal) {
  const lat = toG(cal.G, sub(W(f, I.rHip), W(f, I.lHip)));
  const right = unit([lat[0], 0, lat[2]]);
  const fwd = cross([0, 1, 0], right); // Y × Z = X
  return { right, fwd, yaw: Math.atan2(right[0], right[2]) };
}

// ---------- 3) 순기구학 ----------
// 매개변수 (라디안/미터)
export const Q = {
  px: 0, py: 1, pz: 2, yaw: 3, list: 4,
  lumFlex: 5, lumBend: 6, lumRot: 7,
  hipFlexR: 8, hipAddR: 9, hipRotR: 10, hipFlexL: 11, hipAddL: 12, hipRotL: 13,
  kneeR: 14, kneeL: 15, ankleR: 16, ankleL: 17,
  shFlexR: 18, shAbdR: 19, shRotR: 20, shFlexL: 21, shAbdL: 22, shRotL: 23,
  elbR: 24, elbL: 25,
};
const NQ = 26;

// 관절 가동 범위 (도)
const LIMITS = {
  list: [-30, 30], lumFlex: [-30, 90], lumBend: [-40, 40], lumRot: [-45, 45],
  hipFlexR: [-30, 140], hipAddR: [-50, 35], hipRotR: [-50, 50], hipFlexL: [-30, 140], hipAddL: [-50, 35], hipRotL: [-50, 50],
  kneeR: [-15, 155], kneeL: [-15, 155], ankleR: [-45, 45], ankleL: [-45, 45],
  shFlexR: [-70, 185], shAbdR: [-40, 185], shRotR: [-90, 90], shFlexL: [-70, 185], shAbdL: [-40, 185], shRotL: [-90, 90],
  elbR: [-5, 155], elbL: [-5, 155],
};
const LIM = Object.entries(LIMITS).map(([k, [lo, hi]]) => [Q[k], lo * DEG, hi * DEG]);
// 무릎·팔꿈치가 펴져 있으면 장축 회전이 관찰되지 않으므로 0 쪽으로 약하게 당긴다
const PRIOR = ['hipRotR', 'hipRotL', 'shRotR', 'shRotL', 'lumRot'].map((k) => Q[k]);
const W_PRIOR = 0.01;

// 마커 순서 (MediaPipe 인덱스)
const MARKERS = [I.rHip, I.lHip, I.rKn, I.lKn, I.rAn, I.lAn, I.rHe, I.lHe, I.rTo, I.lTo, I.rSh, I.lSh, I.rEl, I.lEl, I.rWr, I.lWr];

export function forward(q, m) {
  const P = [q[Q.px], q[Q.py], q[Q.pz]];
  const pel = mul(Ry(q[Q.yaw]), Rx(q[Q.list]));
  const out = {};
  const trunk = mul(pel, mul(Rz(-q[Q.lumFlex]), mul(Rx(q[Q.lumBend]), Ry(q[Q.lumRot]))));
  out.trunkUp = mv(trunk, [0, 1, 0]);
  out.pel = pel;
  for (const [s, side] of [['R', 1], ['L', -1]]) {
    const hip = add(P, mv(pel, [0, 0, (side * m.hipW) / 2]));
    const thigh = mul(pel, mul(Rz(q[Q['hipFlex' + s]]), mul(Rx(side * q[Q['hipAdd' + s]]), Ry(side * q[Q['hipRot' + s]]))));
    const knee = add(hip, mv(thigh, [0, -m.thigh, 0]));
    const shank = mul(thigh, Rz(-q[Q['knee' + s]]));
    const ank = add(knee, mv(shank, [0, -m.shank, 0]));
    const foot = mul(shank, Rz(q[Q['ankle' + s]]));
    const heel = add(ank, mv(foot, [m.heel[0], m.heel[1], m.heel[2] * side]));
    const toe = add(ank, mv(foot, [m.toe[0], m.toe[1], m.toe[2] * side]));
    const sh = add(P, mv(trunk, [m.shoulder[0], m.shoulder[1], side * m.shoulder[2]]));
    const arm = mul(trunk, mul(Rz(q[Q['shFlex' + s]]), mul(Rx(-side * q[Q['shAbd' + s]]), Ry(side * q[Q['shRot' + s]]))));
    const elb = add(sh, mv(arm, [0, -m.upperArm, 0]));
    const fore = mul(arm, Rz(q[Q['elb' + s]]));
    const wr = add(elb, mv(fore, [0, -m.forearm, 0]));
    Object.assign(out, { ['hip' + s]: hip, ['knee' + s]: knee, ['ank' + s]: ank, ['heel' + s]: heel, ['toe' + s]: toe, ['sh' + s]: sh, ['elb' + s]: elb, ['wr' + s]: wr, ['arm' + s]: arm });
  }
  out.list = [out.hipR, out.hipL, out.kneeR, out.kneeL, out.ankR, out.ankL, out.heelR, out.heelL, out.toeR, out.toeL, out.shR, out.shL, out.elbR, out.elbL, out.wrR, out.wrL];
  return out;
}

// ---------- 선형 풀이 ----------
function solve(A, b, n) {
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

// ---------- 프레임별 IK ----------
const W_SMOOTH = 0.03; // m/rad: 이전 프레임과의 연속성
const W_LIMIT = 0.6;   // m/rad: 가동 범위 위반
const W_DEPTH = 0.5;   // 카메라 깊이 방향 잔차 가중(단안 깊이 추정이 덜 정확함)

function residuals(q, target, wts, depth, m, prev, out) {
  const fk = forward(q, m);
  let n = 0;
  for (let j = 0; j < MARKERS.length; j++) {
    const w = wts[j];
    if (!w) { out[n++] = 0; out[n++] = 0; out[n++] = 0; continue; }
    let r = sub(fk.list[j], target[j]);
    const rd = dot(r, depth);
    r = sub(r, scale(depth, (1 - W_DEPTH) * rd));
    out[n++] = w * r[0]; out[n++] = w * r[1]; out[n++] = w * r[2];
  }
  for (let k = 3; k < NQ; k++) out[n++] = prev ? W_SMOOTH * (q[k] - prev[k]) : 0;
  for (const [k, lo, hi] of LIM) out[n++] = W_LIMIT * (q[k] < lo ? q[k] - lo : q[k] > hi ? q[k] - hi : 0);
  for (const k of PRIOR) out[n++] = W_PRIOR * q[k];
  return n;
}

function lm(q0, target, wts, depth, m, prev, iters) {
  const q = q0.slice();
  const nR = MARKERS.length * 3 + (NQ - 3) + LIM.length + PRIOR.length;
  let r = new Array(nR), rT = new Array(nR);
  residuals(q, target, wts, depth, m, prev, r);
  let cost = r.reduce((s, v) => s + v * v, 0);
  let mu = 1e-3;
  const J = Array.from({ length: nR }, () => new Array(NQ));
  for (let it = 0; it < iters; it++) {
    for (let k = 0; k < NQ; k++) {
      const h = 1e-4;
      const qk = q[k];
      q[k] = qk + h;
      residuals(q, target, wts, depth, m, prev, rT);
      q[k] = qk;
      for (let i = 0; i < nR; i++) J[i][k] = (rT[i] - r[i]) / h;
    }
    const A = Array.from({ length: NQ }, () => new Array(NQ).fill(0));
    const g = new Array(NQ).fill(0);
    for (let i = 0; i < nR; i++) {
      const Ji = J[i], ri = r[i];
      if (!ri && Ji.every((v) => !v)) continue;
      for (let a = 0; a < NQ; a++) {
        const ja = Ji[a];
        if (!ja) continue;
        g[a] += ja * ri;
        for (let b = a; b < NQ; b++) A[a][b] += ja * Ji[b];
      }
    }
    for (let a = 0; a < NQ; a++) for (let b = 0; b < a; b++) A[a][b] = A[b][a];
    let improved = false;
    for (let tries = 0; tries < 6; tries++) {
      const Ad = A.map((row, i) => row.map((v, j) => (i === j ? v + mu * (v + 1e-6) : v)));
      const dq = solve(Ad, g.map((v) => -v), NQ);
      if (!dq) { mu *= 10; continue; }
      const qn = q.map((v, i) => v + dq[i]);
      residuals(qn, target, wts, depth, m, prev, rT);
      const cn = rT.reduce((s, v) => s + v * v, 0);
      if (cn < cost) {
        for (let i = 0; i < NQ; i++) q[i] = qn[i];
        [r, rT] = [rT, r];
        const rel = (cost - cn) / Math.max(cost, 1e-12);
        cost = cn; mu = Math.max(mu / 3, 1e-7); improved = true;
        if (rel < 1e-6) it = iters;
        break;
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  return q;
}

// frames → 프레임별 각도(도) + 모델 적합 오차(cm)
export function runIK(frames, m, cal) {
  const G = cal.G;
  const depth = [G.X[2], G.Y[2], G.Z[2]]; // MediaPipe z(카메라 깊이)를 지면 좌표로
  const out = [];
  let prev = null, yaw0 = null;
  for (const f of frames) {
    if (!f.wlm || !f.lm || !vis(f.lm, I.lHip, I.rHip)) { out.push(null); continue; }
    const target = MARKERS.map((i) => scale(toG(G, W(f, i)), m.k));
    const wts = MARKERS.map((i) => { const v = f.lm[i]?.visibility ?? 1; return v >= VIS ? Math.min(1, v) : 0; });
    let q0;
    if (prev) q0 = prev.slice();
    else {
      q0 = new Array(NQ).fill(0);
      const hdg = heading(f, cal);
      const pm = mid(target[0], target[1]);
      q0[Q.px] = pm[0]; q0[Q.py] = pm[1]; q0[Q.pz] = pm[2];
      q0[Q.yaw] = hdg.yaw;
      q0[Q.kneeR] = q0[Q.kneeL] = 5 * DEG;
      q0[Q.elbR] = q0[Q.elbL] = 10 * DEG;
    }
    // 첫 프레임은 넉넉히, 이후는 이전 해에서 출발
    const q = lm(q0, target, wts, depth, m, prev, prev ? 12 : 60);
    const fk = forward(q, m);
    let se = 0, cnt = 0;
    for (let j = 0; j < MARKERS.length; j++) if (wts[j]) { const e = norm(sub(fk.list[j], target[j])); se += e * e; cnt++; }
    if (yaw0 === null) yaw0 = q[Q.yaw];
    const deg = (k) => q[Q[k]] * RAD;
    const yawRight = [Math.sin(q[Q.yaw]), 0, Math.cos(q[Q.yaw])];
    const tu = fk.trunkUp;
    const armElev = (s) => {
      const a = mv(fk['arm' + s], [0, -1, 0]);
      const td = scale(tu, -1);
      return Math.acos(Math.max(-1, Math.min(1, dot(a, td) / (norm(a) * norm(td))))) * RAD;
    };
    // 해당 관절을 정하는 랜드마크가 보이지 않으면 값을 비운다(모델 초깃값·추정값을 측정값처럼 내보내지 않음)
    const seen = (...ix) => vis(f.lm, ...ix);
    const o = {
      kneeFlexL: deg('kneeL'), kneeFlexR: deg('kneeR'),
      hipFlexL: deg('hipFlexL'), hipFlexR: deg('hipFlexR'),
      hipAddL: deg('hipAddL'), hipAddR: deg('hipAddR'),
      hipRotL: deg('hipRotL'), hipRotR: deg('hipRotR'),
      ankleDfL: deg('ankleL'), ankleDfR: deg('ankleR'),
      lumbarFlex: deg('lumFlex'), lumbarBend: deg('lumBend'), lumbarRot: deg('lumRot'),
      pelvicObliq: deg('list'), pelvisRot: wrapDeg((q[Q.yaw] - yaw0) * RAD),
      trunkLean: Math.acos(Math.max(-1, Math.min(1, tu[1] / norm(tu)))) * RAD,
      trunkLateral: Math.atan2(dot(tu, yawRight), tu[1]) * RAD,
      shoulderElevL: armElev('L'), shoulderElevR: armElev('R'),
      elbowFlexL: deg('elbL'), elbowFlexR: deg('elbR'),
      ikErr: cnt ? Math.sqrt(se / cnt) * 100 : NaN,
    };
    const need = {
      kneeFlexR: [I.rHip, I.rKn, I.rAn], kneeFlexL: [I.lHip, I.lKn, I.lAn],
      hipFlexR: [I.rHip, I.rKn], hipFlexL: [I.lHip, I.lKn], hipAddR: [I.rHip, I.rKn], hipAddL: [I.lHip, I.lKn],
      hipRotR: [I.rHip, I.rKn, I.rAn], hipRotL: [I.lHip, I.lKn, I.lAn],
      ankleDfR: [I.rKn, I.rAn, I.rHe, I.rTo], ankleDfL: [I.lKn, I.lAn, I.lHe, I.lTo],
      lumbarFlex: [I.lSh, I.rSh], lumbarBend: [I.lSh, I.rSh], lumbarRot: [I.lSh, I.rSh], trunkLean: [I.lSh, I.rSh], trunkLateral: [I.lSh, I.rSh],
      shoulderElevR: [I.rSh, I.rEl], shoulderElevL: [I.lSh, I.lEl], elbowFlexR: [I.rSh, I.rEl, I.rWr], elbowFlexL: [I.lSh, I.lEl, I.lWr],
    };
    for (const [k, ix] of Object.entries(need)) if (!seen(...ix)) o[k] = NaN;
    out.push(o);
    prev = q;
  }
  return out;
}

const wrapDeg = (a) => ((a + 540) % 360) - 180;

// OpenSim .mot (좌표 이름은 OpenSim 관례에 맞춤. 부호 규약은 README 참고)
export function toMOT(t, series, name = 'physiocap_ik.mot') {
  const cols = [
    ['pelvis_tilt', null], ['pelvis_list', 'pelvicObliq'], ['pelvis_rotation', 'pelvisRot'],
    ['hip_flexion_r', 'hipFlexR'], ['hip_adduction_r', 'hipAddR'], ['hip_rotation_r', 'hipRotR'],
    ['knee_angle_r', 'kneeFlexR'], ['ankle_angle_r', 'ankleDfR'],
    ['hip_flexion_l', 'hipFlexL'], ['hip_adduction_l', 'hipAddL'], ['hip_rotation_l', 'hipRotL'],
    ['knee_angle_l', 'kneeFlexL'], ['ankle_angle_l', 'ankleDfL'],
    ['lumbar_extension', 'lumbarFlex', -1], ['lumbar_bending', 'lumbarBend'],
    ['elbow_flex_r', 'elbowFlexR'], ['elbow_flex_l', 'elbowFlexL'],
  ];
  const n = t.length;
  const head = [name, 'version=1', `nRows=${n}`, `nColumns=${cols.length + 1}`, 'inDegrees=yes', 'endheader', ['time', ...cols.map((c) => c[0])].join('\t')];
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = [(t[i] - t[0]).toFixed(5)];
    for (const [, key, sign = 1] of cols) {
      const v = key ? series[key]?.[i] : 0;
      r.push(Number.isFinite(v) ? (sign * v).toFixed(4) : '0');
    }
    rows.push(r.join('\t'));
  }
  return head.join('\n') + '\n' + rows.join('\n') + '\n';
}
