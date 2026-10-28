// 전체 기록 백업·복원 (순수 함수 + 압축. Node에서 테스트)
// 파일 형식: gzip으로 압축한 JSON. 압축을 못 쓰는 환경이면 압축하지 않은 JSON.
import { normalizeCode } from './subjects.js';

export const BACKUP_KIND = 'physiocap-backup';
export const BACKUP_VERSION = 1;
export const COORD_DECIMALS = 6; // 좌표 소수 자릿수(정규화 좌표 0.000001 = 1280px 화면에서 0.0013px, 월드 좌표 0.001mm)

const round = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)) + 0 : v); // + 0: -0 → 0
const roundPts = (pts, d) => (Array.isArray(pts) ? pts.map((p) => {
  const o = {};
  for (const k in p) o[k] = round(p[k], d);
  return o;
}) : pts);

export function compactFrames(frames, d = COORD_DECIMALS) {
  return (frames || []).map((f) => ({ ...f, t: round(f.t, 4), lm: roundPts(f.lm, d), wlm: roundPts(f.wlm, d) }));
}

export function buildBackup({ subjects = [], sessions = [], now = Date.now() } = {}) {
  return {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    exported: now,
    subjects: subjects.map((s) => ({ ...s })),
    sessions: sessions.map((s) => ({ ...s, frames: compactFrames(s.frames) })),
  };
}

// 형식을 확인하고 쓸 수 있는 항목만 돌려준다. 백업 파일이 아니면 오류
export function parseBackup(obj) {
  if (!obj || typeof obj !== 'object' || obj.kind !== BACKUP_KIND) throw new Error('PhysioCap 백업 파일이 아닙니다.');
  if (!(Number(obj.version) >= 1)) throw new Error('백업 파일 버전을 알 수 없습니다.');
  if (Number(obj.version) > BACKUP_VERSION) throw new Error('더 새 버전의 앱에서 만든 백업입니다. 앱을 업데이트한 뒤 불러오세요.');
  const subjects = (Array.isArray(obj.subjects) ? obj.subjects : [])
    .filter((s) => s && typeof s.id === 'string' && normalizeCode(s.code));
  const sessions = (Array.isArray(obj.sessions) ? obj.sessions : [])
    .filter((s) => s && typeof s.id === 'string' && Number.isFinite(Number(s.date)) && typeof s.protocol === 'string' && Array.isArray(s.frames));
  const dropped = (obj.subjects?.length || 0) - subjects.length + (obj.sessions?.length || 0) - sessions.length;
  return { exported: Number(obj.exported) || null, subjects, sessions, dropped };
}

// 기기에 이미 있는 기록과 합친다. 기기 쪽 기록은 덮어쓰지 않는다.
// - 같은 id의 대상자 → 같은 사람(기기 쪽 코드·키 유지)
// - id는 다르지만 코드가 같은 대상자 → 같은 사람으로 보고 기기 쪽 대상자에 기록을 붙인다
// - 같은 id의 세션 → 이미 있으므로 건너뜀
export function planMerge({ subjects: have = [], sessionIds = new Set() } = {}, backup) {
  const byId = new Map(have.map((s) => [s.id, s]));
  const byCode = new Map(have.map((s) => [normalizeCode(s.code).toLowerCase(), s]));
  const map = new Map(); // 백업 대상자 id → 기기 대상자 id
  const addSubjects = [];
  let matchedSubjects = 0;
  for (const s of backup.subjects) {
    const code = normalizeCode(s.code);
    const key = code.toLowerCase();
    const hit = byId.get(s.id) || byCode.get(key);
    if (hit) { map.set(s.id, hit.id); matchedSubjects++; continue; }
    const ns = { ...s, code };
    addSubjects.push(ns);
    byId.set(ns.id, ns); byCode.set(key, ns);
    map.set(s.id, ns.id);
  }
  const ids = new Set(sessionIds);
  const addSessions = [];
  let skippedSessions = 0;
  for (const s of backup.sessions) {
    if (ids.has(s.id)) { skippedSessions++; continue; }
    ids.add(s.id);
    const subjectId = s.subjectId ? (map.get(s.subjectId) || s.subjectId) : null;
    const subj = subjectId ? byId.get(subjectId) : null;
    addSessions.push({ ...s, subjectId, subjectCode: subj?.code || s.subjectCode || '' });
  }
  return { addSubjects, addSessions, matchedSubjects, skippedSessions };
}

// ---------- 파일 인코딩 ----------
const canGzip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

export async function encodeBackup(obj) {
  const text = JSON.stringify(obj);
  if (canGzip()) {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    const blob = await new Response(stream).blob();
    return { blob: new Blob([blob], { type: 'application/gzip' }), ext: '.json.gz', mime: 'application/gzip' };
  }
  return { blob: new Blob([text], { type: 'application/json' }), ext: '.json', mime: 'application/json' };
}

export async function decodeBackup(blob) {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  let text;
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (!canGzip()) throw new Error('이 환경에서는 압축된 백업을 열 수 없습니다.');
    text = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
  } else text = await blob.text();
  let obj;
  try { obj = JSON.parse(text); } catch { throw new Error('PhysioCap 백업 파일이 아닙니다.'); }
  return parseBackup(obj);
}
