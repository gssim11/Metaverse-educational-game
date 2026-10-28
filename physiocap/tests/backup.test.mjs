import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBackup, parseBackup, planMerge, encodeBackup, decodeBackup, BACKUP_KIND } from '../web/js/backup.js';

const ses = (id, subjectId, extra = {}) => ({ id, date: 100, protocol: 'squat', subjectId, subjectCode: '', frames: [], ...extra });

test('백업 파일 형식 확인', () => {
  assert.throws(() => parseBackup({ hello: 1 }), /백업 파일이 아닙니다/);
  assert.throws(() => parseBackup({ kind: BACKUP_KIND, version: 99 }), /더 새 버전/);
  const p = parseBackup({
    kind: BACKUP_KIND, version: 1, exported: 5,
    subjects: [{ id: 'a', code: 'S1' }, { id: 'b', code: '  ' }],
    sessions: [ses('1', 'a'), { id: '2', protocol: 'squat' }],
  });
  assert.equal(p.subjects.length, 1);
  assert.equal(p.sessions.length, 1);
  assert.equal(p.dropped, 2);
});

test('합치기: 기기 기록은 덮어쓰지 않고, 같은 코드는 같은 사람으로 본다', () => {
  const device = { subjects: [{ id: 'd1', code: 'S001', height: '170' }], sessionIds: new Set(['s-old']) };
  const backup = parseBackup(buildBackup({
    subjects: [
      { id: 'd1', code: 'S001', height: '999' }, // 같은 id → 기기 쪽 유지
      { id: 'x2', code: 's001 ' }, // 다른 id, 같은 코드 → 기기 S001에 붙임
      { id: 'x3', code: 'S003', height: '160' }, // 새 대상자
    ],
    sessions: [ses('s-old', 'd1'), ses('n1', 'x2'), ses('n2', 'x3'), ses('n3', null), ses('n4', 'gone', { subjectCode: 'S9' })],
  }));
  const p = planMerge(device, backup);
  assert.deepEqual(p.addSubjects.map((s) => s.id), ['x3']);
  assert.equal(p.matchedSubjects, 2);
  assert.equal(p.skippedSessions, 1);
  const by = Object.fromEntries(p.addSessions.map((s) => [s.id, s]));
  assert.equal(by.n1.subjectId, 'd1');
  assert.equal(by.n1.subjectCode, 'S001');
  assert.equal(by.n2.subjectId, 'x3');
  assert.equal(by.n3.subjectId, null);
  assert.equal(by.n4.subjectId, 'gone'); // 삭제된 대상자 기록도 코드와 함께 보존
  assert.equal(by.n4.subjectCode, 'S9');
});

test('같은 백업을 두 번 불러오면 두 번째는 추가할 것이 없다', () => {
  const backup = parseBackup(buildBackup({ subjects: [{ id: 'a', code: 'A' }], sessions: [ses('1', 'a')] }));
  const first = planMerge({ subjects: [], sessionIds: new Set() }, backup);
  const second = planMerge({ subjects: first.addSubjects, sessionIds: new Set(first.addSessions.map((s) => s.id)) }, backup);
  assert.equal(second.addSubjects.length + second.addSessions.length, 0);
  assert.equal(second.skippedSessions, 1);
});

test('압축 파일과 압축하지 않은 JSON 모두 읽는다', async () => {
  const obj = buildBackup({ subjects: [{ id: 'a', code: 'A' }], sessions: [ses('1', 'a')] });
  const { blob, ext } = await encodeBackup(obj);
  assert.equal(ext, '.json.gz');
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  assert.deepEqual([...head], [0x1f, 0x8b]);
  assert.equal((await decodeBackup(blob)).sessions[0].id, '1');
  assert.equal((await decodeBackup(new Blob([JSON.stringify(obj)]))).subjects[0].code, 'A');
  await assert.rejects(decodeBackup(new Blob(['not json'])), /백업 파일이 아닙니다/);
});
