// 세션 기록 — 기기 내부 IndexedDB (서버 전송 없음)
const DB = 'physiocap';
const STORE = 'sessions';

function open() {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
    t.onerror = () => rej(t.error);
  });
}

export async function saveSession(s) {
  try { await tx('readwrite', (st) => st.put(s)); return true; } catch (e) { console.warn(e); return false; }
}
export async function listSessions() {
  try {
    const all = await tx('readonly', (st) => st.getAll());
    return (all || []).map(({ frames, ...meta }) => meta).sort((a, b) => b.date - a.date);
  } catch { return []; }
}
export async function getSession(id) {
  try { return await tx('readonly', (st) => st.get(id)); } catch { return null; }
}
export async function deleteSession(id) {
  try { await tx('readwrite', (st) => st.delete(id)); } catch { /* 무시 */ }
}
