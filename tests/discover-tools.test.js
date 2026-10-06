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
  released: '2026-09',
  launched: '2025-01',
  evidence: '',
  ...overrides,
});

test('findToolProblem: 최근 출시 + 한국어 설명은 통과', () => {
  assert.equal(findToolProblem(tool(), NOW), null);
  assert.equal(findToolProblem(tool({ released: '2026-10' }), NOW), null);
});

test('findToolProblem: 정확히 12개월 전은 통과, 13개월 전은 거부', () => {
  assert.equal(findToolProblem(tool({ released: '2025-10' }), NOW), null);
  assert.match(findToolProblem(tool({ released: '2025-09' }), NOW), /^released 13개월 전/);
  assert.match(findToolProblem(tool({ released: '2023-03' }), NOW), /^released 43개월 전/);
});

test('findToolProblem: released 형식이 틀리면 거부', () => {
  for (const released of ['2026-9', '2026/09', '2026-13', '2026-00', '2026-09-15', '2026', '최근', '', undefined, null, 202609]) {
    assert.match(findToolProblem(tool({ released }), NOW), /^released 형식 오류/, `released=${released}`);
  }
});

test('findToolProblem: 미래 연월은 거부', () => {
  assert.match(findToolProblem(tool({ released: '2026-11' }), NOW), /^released 미래 연월/);
});

test('findToolProblem: 연월은 한국 시간 기준', () => {
  // UTC로는 9월 30일이지만 KST로는 10월 1일
  const kstOct1 = new Date('2026-09-30T16:00:00Z');
  assert.equal(findToolProblem(tool({ released: '2026-10' }), kstOct1), null);
  assert.match(findToolProblem(tool({ released: '2025-09' }), kstOct1), /^released 13개월 전/);
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

test('findToolProblem: description이 없으면 released만 본다', () => {
  assert.equal(findToolProblem(tool({ description: undefined }), NOW), null);
});
