// node --test physiocap/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jointAngle, computeAngles, filtfilt, analyze, toTRC, toCSV, buildSeries, fppa, findPeaks, symmetryIndex, LANDMARK_NAMES,
} from '../web/js/analysis.js';

const D = Math.PI / 180;

// 측면에서 본 합성 인체 (월드: 미터, y 아래, 골반 중심). kneeFlex/hipFlex(도)
function sideFrame(t, { kneeL = 0, kneeR = 0, hipL = 0, hipR = 0, ankL = 0, ankR = 0, footDxL = 0, footDxR = 0, liftL = 0, hipShiftX = 0 } = {}) {
  const w = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0 }));
  const set = (i, x, y, z) => { w[i] = { x, y, z }; };
  set(0, 0, -0.65, 0);
  set(11, 0, -0.5, -0.18); set(12, 0, -0.5, 0.18);
  set(13, 0, -0.22, -0.2); set(14, 0, -0.22, 0.2);
  set(15, 0.02, 0.05, -0.2); set(16, 0.02, 0.05, 0.2);
  const leg = (hipI, kneeI, ankI, heelI, footI, z, hipF, kneeF, ankDf, dx, lift) => {
    set(hipI, 0, 0, z);
    // 대퇴: 수직 아래에서 앞(+x)으로 hipF 회전
    const kx = 0.42 * Math.sin(hipF * D) + dx, ky = 0.42 * Math.cos(hipF * D) - lift;
    set(kneeI, kx, ky, z);
    // 하퇴: 대퇴 방향에서 뒤로 kneeF 꺾임
    const sa = (hipF - kneeF) * D;
    const ax = kx + 0.4 * Math.sin(sa), ay = ky + 0.4 * Math.cos(sa);
    set(ankI, ax, ay, z);
    set(heelI, ax - 0.05, ay + 0.03, z);
    // 발: 하퇴에 수직(90°) + 배측굴곡 ankDf 만큼 안쪽으로
    const fa = sa - (90 - ankDf) * D;
    set(footI, ax + 0.18 * Math.sin(fa + Math.PI), ay + 0.18 * Math.cos(fa + Math.PI), z);
  };
  leg(23, 25, 27, 29, 31, -0.1, hipL, kneeL, ankL, footDxL, liftL);
  leg(24, 26, 28, 30, 32, 0.1, hipR, kneeR, ankR, footDxR, 0);
  const lm = w.map((p) => ({ x: 0.5 + hipShiftX + p.x * 0.35 + p.z * 0.05, y: 0.45 + p.y * 0.35, z: 0, visibility: 0.99 }));
  return { t, lm, wlm: w, w: 1000, h: 1000 };
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
