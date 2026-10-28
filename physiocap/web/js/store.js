// 세션·대상자 기록 — 기기 내부 IndexedDB (서버 전송 없음)
const DB = 'physiocap';
const SESSIONS = 'sessions';
const SUBJECTS = 'subjects';

function open() {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB, 2); } catch (e) { rej(e); return; }
    // v1 → v2: 대상자 저장소 추가. 기존 세션 기록은 그대로 둔다.
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(SUBJECTS)) db.createObjectStore(SUBJECTS, { keyPath: 'id' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => { db.close(); res(out instanceof IDBRequest ? out.result : out); };
    t.onerror = () => { db.close(); rej(t.error); };
  });
}

export async function saveSession(s) {
  try { await tx(SESSIONS, 'readwrite', (st) => st.put(s)); return true; } catch (e) { console.warn(e); return false; }
}
export async function listSessions() {
  try {
    const all = await tx(SESSIONS, 'readonly', (st) => st.getAll());
    return (all || []).map(({ frames, ...meta }) => meta).sort((a, b) => b.date - a.date);
  } catch { return []; }
}
export async function getSession(id) {
  try { return await tx(SESSIONS, 'readonly', (st) => st.get(id)); } catch { return null; }
}
export async function deleteSession(id) {
  try { await tx(SESSIONS, 'readwrite', (st) => st.delete(id)); } catch { /* 무시 */ }
}

// 백업용: 프레임을 포함한 전체 기록
export async function exportAll() {
  const sessions = await tx(SESSIONS, 'readonly', (st) => st.getAll());
  const subjects = await tx(SUBJECTS, 'readonly', (st) => st.getAll());
  return { subjects: subjects || [], sessions: (sessions || []).sort((a, b) => a.date - b.date) };
}

// 복원용: 대상자·세션을 한 번에 넣는다(중간에 실패하면 아무것도 들어가지 않음)
export async function importMany(subjects, sessions) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction([SUBJECTS, SESSIONS], 'readwrite');
    const su = t.objectStore(SUBJECTS), se = t.objectStore(SESSIONS);
    for (const s of subjects) su.add(s);
    for (const s of sessions) se.add(s);
    t.oncomplete = () => { db.close(); res(true); };
    t.onerror = () => { db.close(); rej(t.error); };
    t.onabort = () => { db.close(); rej(t.error || new Error('복원 취소')); };
  });
}

export async function listSessionIds() {
  try { return new Set(await tx(SESSIONS, 'readonly', (st) => st.getAllKeys())); } catch { return new Set(); }
}

export async function listSubjects() {
  try {
    const all = await tx(SUBJECTS, 'readonly', (st) => st.getAll());
    return (all || []).sort((a, b) => String(a.code).localeCompare(String(b.code), 'ko', { numeric: true }));
  } catch { return []; }
}
export async function saveSubject(s) {
  try { await tx(SUBJECTS, 'readwrite', (st) => st.put(s)); return true; } catch (e) { console.warn(e); return false; }
}
export async function deleteSubject(id) {
  try { await tx(SUBJECTS, 'readwrite', (st) => st.delete(id)); } catch { /* 무시 */ }
}
