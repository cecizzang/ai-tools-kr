// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSummary, findSummaryProblem, fixDateOrder } from '../api/cron/update-companies.js';

const OCT_3 = new Date('2026-10-03T03:00:00Z');
const JAN_5 = new Date('2027-01-05T03:00:00Z');

// 크론이 실제로 거치는 순서대로 검사한다.
const problemOf = (text, now) => findSummaryProblem(cleanSummary(fixDateOrder(text)), now);

test('cleanSummary: 같은 모델을 다시 말하는 줄은 제거', () => {
  assert.equal(
    cleanSummary('Muse Spark 1.3은 코딩에 강하다. (9/2)\n\nMuse Spark 1.3은 2026년 9월 2일 출시되었다.'),
    'Muse Spark 1.3은 코딩에 강하다. (9/2)'
  );
});

test('cleanSummary: 모델명이 다르면 둘 다 유지', () => {
  const text = 'Claude Sonnet 5.5 출시 (9/28)\nClaude Opus 5.5 출시';
  assert.equal(cleanSummary(text), text);
});

test('cleanSummary: 버전이 다르면 둘 다 유지', () => {
  const text = 'Muse Spark 1.3은 코딩에 강하다.\nMuse Spark 1.4는 코딩에 강하다.';
  assert.equal(cleanSummary(text), text);
});

test('cleanSummary: 서로 다른 소식은 유지', () => {
  const text = 'OpenAI는 GPT-5.5를 출시했다. (9/30)\nSora 2 앱이 한국에 공개되었다. (9/25)';
  assert.equal(cleanSummary(text), text);
});

test('cleanSummary: 최대 3줄', () => {
  assert.equal(
    cleanSummary('가 나 다 라\n마 바 사 아\n자 차 카 타\n파 하 거 너\n더 러 머 버'),
    '가 나 다 라\n마 바 사 아\n자 차 카 타'
  );
});

test('cleanSummary: 빈 줄과 앞뒤 공백 제거', () => {
  assert.equal(cleanSummary('\n\n  첫 줄이다  \n\n\n\n둘째 줄은 다르다\n'), '첫 줄이다\n둘째 줄은 다르다');
  assert.equal(cleanSummary(''), '');
});

test('fixDateOrder: "9월 2026년" → "2026년 9월"', () => {
  assert.equal(fixDateOrder('9월 2026년 출시'), '2026년 9월 출시');
});

test('findSummaryProblem: 영어 섞인 문장 거부 (Google "parent company")', () => {
  assert.match(
    problemOf('Google의 parent company Alphabet이 Gemini 3.8 Flash를 공개했다. (9/30)', OCT_3),
    /^english words/
  );
});

test('findSummaryProblem: 메타 문구 거부 (Mistral "추가 검색")', () => {
  assert.match(problemOf('Mistral AI의 최신 모델을 확인하려면 추가 검색이 필요합니다.', OCT_3), /^meta phrase/);
  assert.match(problemOf('Let me search for more.\nClaude Opus 5.5가 출시되었다.', OCT_3), /^meta phrase/);
});

test('findSummaryProblem: 미래 날짜 거부', () => {
  assert.match(problemOf('OpenAI가 GPT-6 Luna를 출시했다. (10/24)', OCT_3), /^future date: 10\/24/);
  assert.match(problemOf('GPT-6이 11월 3일 출시된다고 발표했다.', OCT_3), /^future date: 11\/3/);
});

test('findSummaryProblem: 오늘·내일 날짜는 통과', () => {
  assert.equal(problemOf('GPT-6이 출시되었다. (10/3)\nSora 3이 공개되었다. (10/4)', OCT_3), null);
});

test('findSummaryProblem: 1월에 본 12월 날짜는 작년으로 보고 통과', () => {
  assert.equal(problemOf('Google이 Gemini 4를 출시했다. (12/28)', JAN_5), null);
  assert.match(problemOf('Google이 Gemini 4를 출시했다. (2/10)', JAN_5), /^future date/);
});

test('findSummaryProblem: 정상 요약 통과 (Claude Opus (9/22))', () => {
  assert.equal(problemOf('Anthropic이 Claude Opus 5.5를 출시했다. (9/22)', OCT_3), null);
  assert.equal(problemOf('Meta AI가 Muse Spark 1.3을 출시했다. (9/2)', OCT_3), null);
});
