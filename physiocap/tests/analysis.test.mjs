// node --test physiocap/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jointAngle, computeAngles, filtfilt, analyze, toTRC, toCSV, buildSeries, fppa, findPeaks, symmetryIndex, LANDMARK_NAMES,
} from '../web/js/analysis.js';
import { compactFrames, buildBackup, encodeBackup, decodeBackup } from '../web/js/backup.js';

const D = Math.PI / 180;

// 합성 인체 (MediaPipe 월드 좌표: 미터, x 오른쪽, y 아래, z 카메라에서 멀어지는 방향, 골반 중심).
// 사람은 화면 오른쪽(+x)을 향해 서 있다 → 오른쪽 몸은 카메라 쪽(-z), 왼쪽은 +z.
// hip/knee/ank/trunk: 굴곡각(도). camRoll/camPitch: 카메라 기울기(도). noise: 랜드마크 잡음 SD(m)
export function sideFrame(t, {
  kneeL = 0, kneeR = 0, hipL = 0, hipR = 0, ankL = 0, ankR = 0, trunk = 0,
  footDxL = 0, footDxR = 0, liftL = 0, hipShiftX = 0, camRoll = 0, camPitch = 0, noise = 0, rnd = Math.random,
} = {}) {
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i, x, y, z) => { w[i] = { x, y, z }; };
  // 체간: 골반 중심에서 앞으로 trunk 만큼 숙임
  const ts = Math.sin(trunk * D), tc = Math.cos(trunk * D);
  const T = (up, fwd = 0) => [fwd * tc + up * ts, -(up * tc) + fwd * ts]; // (x, y)
  const [nx, ny] = T(0.65); set(0, nx, ny, 0);
  const [sx, sy] = T(0.5); set(12, sx, sy, -0.18); set(11, sx, sy, 0.18);
  set(14, sx, sy + 0.28, -0.2); set(13, sx, sy + 0.28, 0.2);
  set(16, sx + 0.02, sy + 0.55, -0.2); set(15, sx + 0.02, sy + 0.55, 0.2);
  const leg = (hipI, kneeI, ankI, heelI, footI, z, hipF, kneeF, ankDf, dx, lift) => {
    set(hipI, 0, 0, z);
    const kx = 0.42 * Math.sin(hipF * D) + dx, ky = 0.42 * Math.cos(hipF * D) - lift;
    set(kneeI, kx, ky, z);
    const sa = (hipF - kneeF) * D; // 하퇴가 수직 아래에서 앞으로 기운 각
    const ax = kx + 0.4 * Math.sin(sa), ay = ky + 0.4 * Math.cos(sa);
    set(ankI, ax, ay, z);
    // 하퇴 좌표: d = 아래(하퇴 방향), f = 앞. 발은 중립에서 뒤꿈치-발끝 선이 하퇴에 수직
    const d = [Math.sin(sa), Math.cos(sa)], f = [Math.cos(sa), -Math.sin(sa)];
    const a = ankDf * D; // 배측굴곡: 발끝이 정강이 쪽(-d)으로
    const f2 = [Math.cos(a) * f[0] - Math.sin(a) * d[0], Math.cos(a) * f[1] - Math.sin(a) * d[1]];
    const d2 = [Math.sin(a) * f[0] + Math.cos(a) * d[0], Math.sin(a) * f[1] + Math.cos(a) * d[1]];
    const P = (u, v) => [ax + u * f2[0] + v * d2[0], ay + u * f2[1] + v * d2[1]];
    const [hx, hy] = P(-0.05, 0.06); set(heelI, hx, hy, z);
    const [tx, ty] = P(0.17, 0.06); set(footI, tx, ty, z);
  };
  leg(24, 26, 28, 30, 32, -0.1, hipR, kneeR, ankR, footDxR, 0);
  leg(23, 25, 27, 29, 31, 0.1, hipL, kneeL, ankL, footDxL, liftL);
  // 카메라 기울기: 롤(z축), 피치(x축)
  const cr = Math.cos(camRoll * D), sr = Math.sin(camRoll * D), cp = Math.cos(camPitch * D), sp = Math.sin(camPitch * D);
  const g = () => (noise ? noise * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()) : 0);
  const wl = w.map((p) => {
    let { x, y, z } = p;
    [x, y] = [cr * x - sr * y, sr * x + cr * y];
    [y, z] = [cp * y - sp * z, sp * y + cp * z];
    return { x: x + g(), y: y + g(), z: z + g() };
  });
  const lm = w.map((p) => {
    const X = p.x * 0.35 + p.z * 0.05, Y = p.y * 0.35;
    return { x: 0.5 + hipShiftX + cr * X - sr * Y, y: 0.45 + sr * X + cr * Y, z: 0, visibility: 0.99 };
  });
  return { t, lm, wlm: wl, w: 1000, h: 1000 };
}

test('jointAngle: 직각', () => {
  assert.ok(Math.abs(jointAngle([1, 0, 0], [0, 0, 0], [0, 1, 0]) - 90) < 1e-9);
});

test('computeAngles: 합성 무릎·고관절 각 복원', () => {
  for (const k of [0, 30, 60, 90, 120]) {
    const a = computeAngles(sideFrame(0, { kneeL: k, kneeR: k / 2, hipL: k / 2 }));
    assert.ok(Math.abs(a.kneeFlexL - k) < 0.5, `kneeL ${a.kneeFlexL} vs ${k}`);
    assert.ok(Math.abs(a.kneeFlexR - k / 2) < 0.5);
  }
  const a = computeAngles(sideFrame(0, { ankL: 15 }));
  assert.ok(Math.abs(a.ankleDfL - 15) < 0.5, `ank ${a.ankleDfL}`);
});

test('fppa: 무릎이 정중선 쪽이면 +', () => {
  // 정면: 정중선 x=0.5, 왼다리 x≈0.6
  const v = fppa([0.6, 0.5, 0], [0.56, 0.7, 0], [0.6, 0.9, 0], 0.5);
  const vr = fppa([0.6, 0.5, 0], [0.64, 0.7, 0], [0.6, 0.9, 0], 0.5);
  assert.ok(v > 15 && vr < -15, `${v} ${vr}`);
});

test('filtfilt: 저주파 보존, 고주파 감쇠, 위상 지연 없음', () => {
  const fs = 30, n = 300;
  const clean = Array.from({ length: n }, (_, i) => Math.sin(2 * Math.PI * 0.5 * i / fs));
  const noisy = clean.map((v, i) => v + 0.3 * Math.sin(2 * Math.PI * 12 * i / fs));
  const f = filtfilt(noisy, 6, fs);
  let err = 0;
  for (let i = 30; i < n - 30; i++) err = Math.max(err, Math.abs(f[i] - clean[i]));
  assert.ok(err < 0.05, `max err ${err}`);
});

test('스쿼트: 5회 반복과 최대 굴곡', () => {
  const frames = [];
  for (let i = 0; i < 30 * 12; i++) {
    const t = i / 30;
    const ph = Math.max(0, Math.sin(2 * Math.PI * t / 2.2 - Math.PI / 2) * 0.5 + 0.5);
    const k = 5 + 95 * ph;
    frames.push(sideFrame(t + 0.013 * (i % 3), { kneeL: k, kneeR: k * 0.9, hipL: k * 0.8, hipR: k * 0.8 }));
  }
  const { result } = analyze(frames, 'squat');
  const reps = result.metrics.find((m) => m.label === '반복 횟수').value;
  assert.equal(reps, 5);
  const kl = result.metrics.find((m) => m.label === '최대 무릎 굴곡 L').value;
  assert.ok(Math.abs(kl - 100) < 4, `kneeL ${kl}`);
  const si = result.metrics.find((m) => m.label === '무릎 굴곡 대칭지수').value;
  assert.ok(si > 8 && si < 14, `SI ${si}`);
});

test('앉았다 일어서기: 5회 시간', () => {
  const frames = [];
  // 앉은 자세(90°)로 시작, 2초 주기
  for (let i = 0; i < 30 * 10; i++) {
    const t = i / 30;
    const k = 50 + 45 * Math.cos(2 * Math.PI * t / 2); // 95 → 5
    frames.push(sideFrame(t, { kneeL: k, kneeR: k, hipL: k, hipR: k }));
  }
  const { result } = analyze(frames, 'sts');
  assert.equal(result.metrics.find((m) => m.label === '일어서기 횟수').value, 5);
  const t5 = result.metrics.find((m) => m.label === '5회 앉았다 일어서기 시간').value;
  assert.ok(t5 > 8.4 && t5 < 9.2, `t5 ${t5}`);
});

test('보행: 분속수', () => {
  const frames = [];
  const stepT = 0.55; // 걸음 시간 → 109 걸음/분
  for (let i = 0; i < 30 * 8; i++) {
    const t = i / 30;
    const s = Math.sin(Math.PI * t / stepT);
    frames.push(sideFrame(t, { footDxL: 0.3 * s, footDxR: -0.3 * s, kneeL: 20 + 20 * Math.max(0, -s), kneeR: 20 + 20 * Math.max(0, s), hipShiftX: t * 0.08 }));
  }
  const { result } = analyze(frames, 'gait');
  const cad = result.metrics.find((m) => m.label === '분속수(cadence)').value;
  assert.ok(Math.abs(cad - 60 / stepT) < 4, `cadence ${cad}`);
});

test('한발 서기: 유지 시간', () => {
  const frames = [];
  for (let i = 0; i < 30 * 10; i++) {
    const t = i / 30;
    const lift = t > 2 && t < 8 ? 0.15 : 0;
    frames.push(sideFrame(t, { liftL: lift, hipShiftX: 0.003 * Math.sin(t * 5) }));
  }
  const { result } = analyze(frames, 'balance');
  const d = result.metrics.find((m) => m.label === '한발 서기 유지 시간').value;
  assert.ok(Math.abs(d - 6) < 0.3, `dur ${d}`);
  assert.equal(result.metrics.find((m) => m.label === '지지 다리').value, '오른발(R)');
});

test('검출 실패 프레임 처리', () => {
  const frames = Array.from({ length: 60 }, (_, i) => (i % 4 === 0 ? { t: i / 30, lm: null, wlm: null } : sideFrame(i / 30, { kneeL: 30 })));
  const { result } = analyze(frames, 'free');
  assert.equal(result.detectionRate, 75);
  assert.ok(Math.abs(result.rom.kneeFlexL.mean - 30) < 1);
});

test('TRC: 헤더/열 수', () => {
  const frames = Array.from({ length: 31 }, (_, i) => sideFrame(i / 30, { kneeL: i }));
  const trc = toTRC(frames, { fs: 30 });
  const lines = trc.split('\n');
  assert.ok(lines[0].startsWith('PathFileType\t4'));
  assert.equal(lines[2].split('\t')[2], '31');
  const names = lines[3].split('\t');
  assert.equal(names[2], 'Nose');
  assert.equal(names[5], LANDMARK_NAMES[1]);
  assert.equal(lines[4].split('\t').length, 2 + 33 * 3);
  assert.equal(lines[5], '');
  assert.equal(lines[6].split('\t').length, 2 + 33 * 3);
  // 발 높이 ≈ 0 이상
  const row = lines[6].split('\t').map(Number);
  assert.ok(row[2 + 29 * 3 + 1] > -0.01);
});

test('CSV 내보내기', () => {
  const frames = Array.from({ length: 31 }, (_, i) => sideFrame(i / 30, { kneeL: i }));
  const csv = toCSV(buildSeries(frames));
  assert.ok(csv.split('\n')[0].startsWith('time_s,kneeFlexL'));
});

test('findPeaks / 대칭지수', () => {
  const y = Array.from({ length: 100 }, (_, i) => Math.sin(i / 5));
  assert.equal(findPeaks(y, { minDist: 10, minProm: 0.5 }).length, 3);
  assert.equal(symmetryIndex(100, 100), 0);
  assert.ok(Math.abs(symmetryIndex(90, 110) - 20) < 1e-9);
});

// ---------- 역기구학·보정 ----------
import { toMOT } from '../web/js/ik.js';

function lcg(seed = 1) { let s = seed >>> 0; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 4294967296); }
const at = (S, key, tt) => S.series[key][Math.min(S.t.length - 1, Math.round(tt * S.fs))];
const rmse = (a, b) => Math.sqrt(a.reduce((s, v, i) => s + (v - b[i]) ** 2, 0) / a.length);

// 바르게 선 1초 + 스쿼트
function squatTrial({ camRoll = 0, camPitch = 0, trunkAt = 0, noise = 0, seed = 7 } = {}) {
  const rnd = lcg(seed), frames = [], truth = [];
  for (let i = 0; i < 30 * 5; i++) {
    const t = i / 30;
    const ph = t < 1 ? 0 : 0.5 - 0.5 * Math.cos(2 * Math.PI * (t - 1) / 2);
    const k = 2 + 98 * ph, h = 1 + 79 * ph, a = 25 * ph, tr = trunkAt * ph;
    truth.push({ t, k, h, a, tr });
    frames.push(sideFrame(t, { kneeL: k, kneeR: k, hipL: h, hipR: h, ankL: a, ankR: a, trunk: tr, camRoll, camPitch, noise, rnd }));
  }
  return { frames, truth };
}

test('IK: 무릎·고관절·발목 복원 (오차 < 2.5°)', () => {
  const { frames, truth } = squatTrial();
  const S = buildSeries(frames, { cutoff: 6 });
  for (const tr of truth.filter((_, i) => i % 10 === 5)) {
    assert.ok(Math.abs(at(S, 'kneeFlexR', tr.t) - tr.k) < 2.5, `knee ${at(S, 'kneeFlexR', tr.t)} vs ${tr.k}`);
    assert.ok(Math.abs(at(S, 'hipFlexL', tr.t) - tr.h) < 2.5, `hip ${at(S, 'hipFlexL', tr.t)} vs ${tr.h}`);
    assert.ok(Math.abs(at(S, 'ankleDfR', tr.t) - tr.a) < 2.5, `ankle ${at(S, 'ankleDfR', tr.t)} vs ${tr.a}`);
  }
  assert.ok(S.cal.calibrated);
  assert.ok(Math.abs(at(S, 'hipAddR', 2)) < 3 && Math.abs(at(S, 'hipRotR', 2)) < 5, 'no spurious frontal/transverse motion');
});

test('보정: 카메라 롤 8°·피치 10° 기울어져도 체간·발목 각 유지', () => {
  const { frames, truth } = squatTrial({ camRoll: 8, camPitch: 10, trunkAt: 25 });
  const S = buildSeries(frames, { cutoff: 6 });
  assert.ok(S.cal.calibrated);
  const tilt = Math.acos(-S.cal.up[1]) * 180 / Math.PI;
  assert.ok(Math.abs(tilt - 12.8) < 1.5, `tilt ${tilt}`);
  assert.ok(Math.abs(S.cal.roll * 180 / Math.PI - 8) < 1.5, `roll ${S.cal.roll * 180 / Math.PI}`);
  const mid = truth[90];
  assert.ok(Math.abs(at(S, 'trunkLean', mid.t) - mid.tr) < 3, `trunk ${at(S, 'trunkLean', mid.t)} vs ${mid.tr}`);
  assert.ok(Math.abs(at(S, 'ankleDfL', 0.5)) < 2, `ankle zero ${at(S, 'ankleDfL', 0.5)}`);
  assert.ok(Math.abs(at(S, 'kneeFlexL', mid.t) - mid.k) < 2.5);
});

test('고관절 굴곡: 체간을 숙여도 체간-대퇴 각이 아닌 대퇴 각으로 측정', () => {
  const frames = Array.from({ length: 60 }, (_, i) => sideFrame(i / 30, i < 30 ? {} : { hipL: 60, hipR: 60, kneeL: 70, kneeR: 70, trunk: 35 }));
  const S = buildSeries(frames, { cutoff: 6 });
  const h = at(S, 'hipFlexR', 1.8);
  assert.ok(Math.abs(h - 60) < 3, `hip ${h}`); // 체간-대퇴 각이면 95°
  assert.ok(Math.abs(at(S, 'lumbarFlex', 1.8) - 35) < 4, `lumbar ${at(S, 'lumbarFlex', 1.8)}`);
});

test('잡음 1.5cm: 역기구학이 단순 3점 각도보다 정확', () => {
  const { frames, truth } = squatTrial({ noise: 0.015, seed: 3 });
  const S = buildSeries(frames, { cutoff: 6 });
  const rawK = filtfilt(frames.map((f) => computeAngles(f).kneeFlexR), 6, 30);
  const rawA = filtfilt(frames.map((f) => computeAngles(f).ankleDfR), 6, 30);
  const ikK = truth.map((tr) => at(S, 'kneeFlexR', tr.t)), ikA = truth.map((tr) => at(S, 'ankleDfR', tr.t));
  const k = truth.map((tr) => tr.k), a = truth.map((tr) => tr.a);
  const eIK = rmse(ikK, k), eRaw = rmse(rawK, k), eIKa = rmse(ikA, a), eRawa = rmse(rawA, a);
  console.log(`  knee RMSE IK ${eIK.toFixed(2)}° vs raw ${eRaw.toFixed(2)}° · ankle IK ${eIKa.toFixed(2)}° vs raw ${eRawa.toFixed(2)}°`);
  assert.ok(eIK < eRaw && eIKa < eRawa);
});

test('MOT 내보내기', () => {
  const { frames } = squatTrial();
  const S = buildSeries(frames);
  const mot = toMOT(S.t, S.series).split('\n');
  assert.equal(mot[5], 'endheader');
  assert.ok(mot[6].startsWith('time\tpelvis_tilt'));
  assert.equal(mot[7].split('\t').length, mot[6].split('\t').length);
});

test('가려진 관절은 값을 비움 (초깃값을 측정값처럼 내보내지 않음)', () => {
  const frames = Array.from({ length: 40 }, (_, i) => {
    const f = sideFrame(i / 30, { kneeL: 30, kneeR: 30 });
    for (const j of [25, 26, 27, 28, 29, 30, 31, 32]) f.lm[j].visibility = 0.1; // 다리 가림
    return f;
  });
  const S = buildSeries(frames);
  assert.ok(S.series.kneeFlexR.every((v) => !Number.isFinite(v)));
  assert.ok(S.series.ankleDfL.every((v) => !Number.isFinite(v)));
  assert.ok(S.series.elbowFlexR.some(Number.isFinite));
});

test('백업: 좌표 반올림 후 다시 분석해도 관절각 차이가 매우 작다', async () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const frames = [];
  for (let i = 0; i < 30 * 8; i++) {
    const t = i / 30;
    const ph = Math.max(0, Math.sin(2 * Math.PI * t / 2 - Math.PI / 2) * 0.5 + 0.5);
    const k = 5 + 90 * ph;
    frames.push(sideFrame(t, { kneeL: k, kneeR: k * 0.9, hipL: k * 0.8, hipR: k * 0.8, ankL: k * 0.2, noise: 0.01, rnd }));
  }
  const a = analyze(frames, 'squat');
  // 실제 백업 파일을 거쳐(압축 → 해제) 복원한 프레임으로 다시 분석
  const { blob } = await encodeBackup(buildBackup({ sessions: [{ id: 'x', date: 1, protocol: 'squat', frames }] }));
  const restored = (await decodeBackup(blob)).sessions[0].frames;
  assert.deepEqual(restored, compactFrames(frames));
  const b = analyze(restored, 'squat');
  let maxDiff = 0;
  for (const key of Object.keys(a.series.series)) {
    const ya = a.series.series[key], yb = b.series.series[key];
    for (let i = 0; i < ya.length; i++) if (Number.isFinite(ya[i]) && Number.isFinite(yb[i])) maxDiff = Math.max(maxDiff, Math.abs(ya[i] - yb[i]));
  }
  assert.ok(maxDiff < 0.05, `최대 차이 ${maxDiff}°`);
  // 결과 지표는 소수 첫째 자리로 반올림해 표시하므로 경계값에서 0.1 차이가 날 수 있다
  a.result.metrics.forEach((m, i) => {
    const v = b.result.metrics[i].value;
    if (typeof m.value === 'number' && Number.isFinite(m.value)) assert.ok(Math.abs(v - m.value) <= 0.1 + 1e-9, `${m.label} ${m.value} → ${v}`);
    else assert.deepEqual(v, m.value);
  });
  console.log(`# 백업 왕복 관절각 최대 차이 ${maxDiff.toExponential(2)}°`);
});
