import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCode, validateSubject, effectiveHeight, previousSession, filterSessions, countBySubject, fileSafe,
} from '../web/js/subjects.js';

const S = (id, protocol, date, subjectId) => ({ id, protocol, date, ...(subjectId !== undefined ? { subjectId } : {}) });

test('이전 기록은 같은 대상자·같은 검사에서만 찾는다', () => {
  const list = [
    S('a1', 'squat', 100, 'A'),
    S('b1', 'squat', 200, 'B'), // 더 최근이지만 다른 사람
    S('a2', 'gait', 250, 'A'), // 같은 사람이지만 다른 검사
    S('a3', 'squat', 300, 'A'),
  ];
  assert.equal(previousSession(list, S('new', 'squat', 400, 'A'))?.id, 'a3');
  assert.equal(previousSession(list, S('a3', 'squat', 300, 'A'))?.id, 'a1');
  assert.equal(previousSession(list, S('nb', 'squat', 400, 'B'))?.id, 'b1');
  assert.equal(previousSession(list, S('nc', 'squat', 400, 'C')), null);
});

test('대상자 없는 이전 버전 기록은 미지정끼리만 비교한다', () => {
  const list = [S('old', 'squat', 100), S('a', 'squat', 200, 'A'), S('u', 'squat', 300, null)];
  assert.equal(previousSession(list, S('n', 'squat', 400, null))?.id, 'u');
  assert.equal(previousSession(list, S('u', 'squat', 300, null))?.id, 'old');
  assert.equal(previousSession(list, S('n', 'squat', 400, 'A'))?.id, 'a');
});

test('키: 대상자가 있으면 그 대상자의 키만 쓰고 전역 설정은 쓰지 않는다', () => {
  assert.equal(effectiveHeight({ height: '165' }, '180'), '165');
  assert.equal(effectiveHeight({ height: '' }, '180'), ''); // 다른 사람 키를 끌어오지 않음
  assert.equal(effectiveHeight(null, '180'), '180');
  assert.equal(effectiveHeight(null, ''), '');
});

test('대상자 입력 검증', () => {
  const existing = [{ id: 'p1', code: 'S001', height: '170' }];
  assert.match(validateSubject({ code: '  ' }, existing), /코드를 입력/);
  assert.match(validateSubject({ code: 's001' }, existing), /이미 있는 코드/);
  assert.equal(validateSubject({ id: 'p1', code: 'S001', height: '171' }, existing), null); // 자기 자신 수정
  assert.match(validateSubject({ code: 'S002', height: '50' }, existing), /80~230/);
  assert.equal(validateSubject({ code: 'S002', height: '' }, existing), null);
  assert.equal(normalizeCode('  홍  01 '), '홍 01');
  assert.equal(normalizeCode('x'.repeat(40)).length, 20);
});

test('기록 거르기·개수·파일 이름', () => {
  const list = [S('1', 'squat', 1, 'A'), S('2', 'squat', 2), S('3', 'gait', 3, 'A'), S('4', 'gait', 4, null)];
  assert.deepEqual(filterSessions(list, 'A').map((s) => s.id), ['1', '3']);
  assert.deepEqual(filterSessions(list, '').map((s) => s.id), ['2', '4']);
  assert.equal(filterSessions(list, 'all').length, 4);
  const c = countBySubject(list);
  assert.equal(c.get('A'), 2);
  assert.equal(c.get(null), 2);
  assert.equal(fileSafe('S 001/무릎'), 'S_001_무릎');
  assert.equal(fileSafe(''), '');
});
