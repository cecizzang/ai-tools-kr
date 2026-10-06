// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { findToolProblem } from '../api/cron/discover-tools.js';

const NOW = new Date('2026-10-04T03:00:00Z');

const tool = (overrides = {}) => ({
  name: 'Example',
  url: 'https://example.com',
  description: '회의 녹음을 자동으로 요약해 주는 툴',
  category: 'docs',
  price: 'freemium',
  korean: 'partial',
  target: 'both',
  launched: '2025-01',
  evidence: '',
  ...overrides,
});

const EVIDENCE = '출시 한 달 만에 가입자 10만 명을 넘겼다고 발표';

test('findToolProblem: 오래된 툴은 사용자 근거가 없어도 통과 (cron_runs id=2에서 잘못 탈락한 두 건)', () => {
  // 예전에는 "released 15개월 전: 2025-07", "released 13개월 전: 2025-09"로 탈락했다
  assert.equal(findToolProblem(tool({ name: '센텐시파이', launched: '2025-07' }), NOW), null);
  assert.equal(findToolProblem(tool({ name: '가제트', launched: '2025-09' }), NOW), null);
  assert.equal(findToolProblem(tool({ launched: '2019-03' }), NOW), null);
});

test('findToolProblem: 출시 6개월 미만 + 사용자 근거 없음만 거부', () => {
  assert.match(findToolProblem(tool({ launched: '2026-10' }), NOW), /^출시 0개월 \+ 사용자 근거 없음/);
  assert.match(findToolProblem(tool({ launched: '2026-05' }), NOW), /^출시 5개월 \+ 사용자 근거 없음/);
  assert.match(findToolProblem(tool({ launched: '2026-08', evidence: '   ' }), NOW), /^출시 2개월 \+ 사용자 근거 없음/);
});

test('findToolProblem: 출시 6개월 미만이어도 사용자 근거가 있으면 통과', () => {
  assert.equal(findToolProblem(tool({ launched: '2026-10', evidence: EVIDENCE }), NOW), null);
  assert.equal(findToolProblem(tool({ launched: '2026-05', evidence: EVIDENCE }), NOW), null);
});

test('findToolProblem: 정확히 6개월 전부터는 근거 없이 통과', () => {
  assert.equal(findToolProblem(tool({ launched: '2026-04' }), NOW), null);
});

test('findToolProblem: 출시 연월을 모르면 신생 툴로 보고 근거를 요구', () => {
  for (const launched of ['', '2026-9', '2026/09', '2026-13', '2026', '최근', undefined, null, 202609]) {
    assert.match(findToolProblem(tool({ launched }), NOW), /^출시 연월 미확인 \+ 사용자 근거 없음/, `launched=${launched}`);
    assert.equal(findToolProblem(tool({ launched, evidence: EVIDENCE }), NOW), null, `launched=${launched}`);
  }
});

test('findToolProblem: 미래 연월도 신생 툴로 본다', () => {
  assert.match(findToolProblem(tool({ launched: '2026-11' }), NOW), /^출시 0개월 \+ 사용자 근거 없음/);
  assert.equal(findToolProblem(tool({ launched: '2026-11', evidence: EVIDENCE }), NOW), null);
});

test('findToolProblem: 연월은 한국 시간 기준', () => {
  // UTC로는 9월 30일이지만 KST로는 10월 1일 → 4월 출시가 정확히 6개월 전
  const kstOct1 = new Date('2026-09-30T16:00:00Z');
  assert.equal(findToolProblem(tool({ launched: '2026-04' }), kstOct1), null);
  assert.match(findToolProblem(tool({ launched: '2026-05' }), kstOct1), /^출시 5개월/);
});

test('findToolProblem: description에 메타 문구가 있으면 거부', () => {
  assert.match(
    findToolProblem(tool({ description: '정확한 기능은 추가 검색이 필요합니다' }), NOW),
    /^description meta phrase/
  );
});

test('findToolProblem: description에 영어가 섞이면 거부', () => {
  assert.match(
    findToolProblem(tool({ description: 'AI notetaker for meetings with automatic summaries' }), NOW),
    /^description english words/
  );
});

test('findToolProblem: 고유명사만 영어인 description은 통과', () => {
  assert.equal(findToolProblem(tool({ description: 'Slack·Notion과 연동되는 AI 회의록 작성 툴' }), NOW), null);
});

test('findToolProblem: description이 없으면 출시일만 본다', () => {
  assert.equal(findToolProblem(tool({ description: undefined }), NOW), null);
});
