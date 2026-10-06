// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import businessModule from '../business.js';

const { PROMPTS, SHORTCUTS, previewText, recommendedToolsUrl, toolLink, writeLink, prefillTitle, shouldShowPrompts } = businessModule;

test('previewText: 본문 첫 줄만, 빈 줄은 건너뛴다', () => {
  assert.equal(previewText('첫 줄입니다\n둘째 줄입니다'), '첫 줄입니다');
  assert.equal(previewText('\n\n   \n  실제 첫 줄  \n다음'), '실제 첫 줄');
  assert.equal(previewText('탭\t과   공백이   많은 줄'), '탭 과 공백이 많은 줄');
});

test('previewText: 60자를 넘으면 잘라서 말줄임표', () => {
  const sixty = '가'.repeat(60);
  assert.equal(previewText(sixty), sixty);
  assert.equal(previewText(`${sixty}나`), `${sixty}…`);
  assert.equal(previewText('가나 다라마', 3), '가나…');
  // 이모지를 반으로 자르지 않는다
  assert.equal(previewText('😀😀😀😀', 2), '😀😀…');
});

test('previewText: 본문이 없으면 빈 문자열', () => {
  for (const body of ['', '   \n \n', null, undefined]) assert.equal(previewText(body), '');
});

test('recommendedToolsUrl: 사업자용 + 한국어 완전 지원, sort_order 순 6개', () => {
  const url = new URL(recommendedToolsUrl('https://db.example'));
  assert.equal(url.pathname, '/rest/v1/tools');
  assert.equal(url.searchParams.get('target'), 'in.(biz,both)');
  assert.equal(url.searchParams.get('korean'), 'eq.full');
  assert.equal(url.searchParams.get('is_published'), 'eq.true');
  assert.match(url.searchParams.get('order'), /^sort_order\.asc/);
  assert.equal(url.searchParams.get('limit'), '6');
  assert.equal(url.searchParams.get('select'), 'name,description,category');
});

test('toolLink: tools.html의 해당 카테고리로', () => {
  assert.equal(toolLink('image'), 'tools.html?category=image');
  assert.equal(toolLink(''), 'tools.html');
  assert.equal(toolLink(undefined), 'tools.html');
});

test('SHORTCUTS: 리뷰 답글·홍보 이미지·숏폼 영상 3개가 chat/image/media로 연결', () => {
  assert.deepEqual(SHORTCUTS.map((s) => [s.label, s.href]), [
    ['리뷰 답글 쓰기', 'tools.html?category=chat'],
    ['홍보 이미지 만들기', 'tools.html?category=image'],
    ['숏폼 영상', 'tools.html?category=media'],
  ]);
});

test('PROMPTS: 예시 질문 3개, 글쓰기 제목 제한(2~60자) 안', () => {
  assert.equal(PROMPTS.length, 3);
  for (const title of PROMPTS) {
    assert.ok(title.length >= 2 && title.length <= 60, title);
    assert.equal(prefillTitle(title), title);
  }
});

test('writeLink: 사장님 모임 카테고리 + 제목을 미리 채운 글쓰기 링크', () => {
  const url = new URL(writeLink('리뷰 답글, AI로 어떻게 쓰고 계세요?'), 'https://site.example/');
  assert.equal(url.pathname, '/write.html');
  assert.equal(url.searchParams.get('category'), 'business');
  assert.equal(url.searchParams.get('title'), '리뷰 답글, AI로 어떻게 쓰고 계세요?');
  assert.equal(prefillTitle(new URL(writeLink('a&b=c #d'), 'https://site.example/').searchParams.get('title')), 'a&b=c #d');
});

test('prefillTitle: 공백 정리 + 60자 제한', () => {
  assert.equal(prefillTitle('  줄\n바꿈  제목  '), '줄 바꿈 제목');
  assert.equal(prefillTitle('가'.repeat(80)), '가'.repeat(60));
  assert.equal(prefillTitle(null), '');
});

test('shouldShowPrompts: 글이 3개 미만일 때만', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(shouldShowPrompts), [true, true, true, false, false]);
});

test('business.html·write.html이 business.js를 불러 쓴다', () => {
  const page = readFileSync(new URL('../business.html', import.meta.url), 'utf8');
  assert.match(page, /<script src="business\.js"><\/script>/);
  for (const id of ['introCard', 'toolStrip', 'shortcuts', 'postList', 'prompts', 'pagination']) {
    assert.match(page, new RegExp(`id="${id}"`), id);
  }
  assert.match(page, /가게·1인 사업 하시는 분들이 AI로 일 줄이는 방법을 나누는 곳/);
  assert.match(page, /써보신 AI 활용법, 질문 아무거나 환영/);
  // 화면에 넣는 값은 전부 textContent로 — 게시글·툴 데이터를 innerHTML로 넣지 않는다
  assert.ok(!page.includes('innerHTML'));

  const write = readFileSync(new URL('../write.html', import.meta.url), 'utf8');
  assert.match(write, /<script src="business\.js"><\/script>/);
  assert.match(write, /prefillTitle/);
});
