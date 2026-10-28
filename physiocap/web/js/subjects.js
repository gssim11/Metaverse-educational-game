// 대상자 구분 규칙 (순수 함수, Node에서 테스트)
// 대상자 없음(미지정)은 subjectId가 비어 있는 기록이다. 이전 버전에서 저장한 기록도 미지정으로 본다.

export const CODE_MAX = 20;
export const HEIGHT_MIN = 80;
export const HEIGHT_MAX = 230;

const sid = (x) => x?.subjectId || null;

export function normalizeCode(code) {
  return String(code ?? '').trim().replace(/\s+/g, ' ').slice(0, CODE_MAX);
}

// 오류 문구를 돌려주고, 문제가 없으면 null
export function validateSubject({ id = null, code, height }, existing = []) {
  const c = normalizeCode(code);
  if (!c) return '대상자 코드를 입력하세요.';
  const dup = existing.find((s) => s.id !== id && normalizeCode(s.code).toLowerCase() === c.toLowerCase());
  if (dup) return `이미 있는 코드입니다: ${dup.code}`;
  const h = String(height ?? '').trim();
  if (h) {
    const n = Number(h);
    if (!Number.isFinite(n) || n < HEIGHT_MIN || n > HEIGHT_MAX) return `키는 ${HEIGHT_MIN}~${HEIGHT_MAX} cm 사이로 입력하세요.`;
  }
  return null;
}

// 분석에 쓸 키(cm 문자열). 대상자가 있으면 그 대상자의 키만 쓴다(비어 있으면 자동 축척).
// 전역 설정의 키는 대상자 미지정일 때만 쓴다.
export function effectiveHeight(subject, fallback = '') {
  if (subject) return Number(subject.height) > 0 ? String(subject.height) : '';
  return Number(fallback) > 0 ? String(fallback) : '';
}

export function sameSubject(a, b) {
  return sid(a) === sid(b);
}

// 같은 대상자·같은 검사에서 이 세션보다 앞선 가장 최근 기록
export function previousSession(list, session) {
  let best = null;
  for (const s of list) {
    if (s.id === session.id || s.protocol !== session.protocol || !(s.date < session.date) || !sameSubject(s, session)) continue;
    if (!best || s.date > best.date) best = s;
  }
  return best;
}

// filter: 'all' = 전체, 그 외 = 해당 대상자(null/'' = 미지정)
export function filterSessions(list, filter) {
  if (filter === 'all') return list;
  const want = filter || null;
  return list.filter((s) => sid(s) === want);
}

export function countBySubject(list) {
  const m = new Map();
  for (const s of list) { const k = sid(s); m.set(k, (m.get(k) || 0) + 1); }
  return m;
}

// 파일 이름에 넣을 수 있게 정리
export function fileSafe(code) {
  return normalizeCode(code).replace(/[^0-9A-Za-z가-힣_-]+/g, '_').replace(/^_+|_+$/g, '');
}
