// 실행: node --test
// board.html 카테고리 탭과 목록 라벨.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../board.html', import.meta.url), 'utf8');

test('board.html: 카테고리 탭에 "사장님 모임"이 일반 다음에 있다', () => {
  const tabs = html.match(/function renderTabs[\s\S]*?\[(\[[\s\S]*?\])\]\.forEach/)[1];
  const entries = [...tabs.matchAll(/\['(\w+)', '([^']+)'\]/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(entries, [
    ['all', '전체'],
    ['notice', '공지사항'],
    ['free', '일반'],
    ['business', '사장님 모임'],
    ['dev', '개발'],
  ]);
});

test('board.html: 탭을 누르면 그 카테고리만 조회한다 (business 포함)', () => {
  // 탭 링크는 ?category=<id>, 목록 조회는 category=eq.<id>
  assert.ok(html.includes("a.href = id === 'all' ? 'board.html' : `board.html?category=${id}`;"));
  assert.match(html, /category === 'all' \? '&category=neq\.notice' : `&category=eq\.\$\{category\}`/);
});

test('board.html: 목록의 카테고리 라벨은 "사장님"으로 짧게, 줄바꿈 없이', () => {
  const labels = html.match(/const CATEGORY_LABELS = \{([^}]*)\}/)[1];
  assert.match(labels, /business: '사장님'(,|\s|$)/);
  assert.ok(!labels.includes('사장님 모임'));

  const css = html.match(/\.post-row \.cat \{([^}]*)\}/)[1];
  assert.match(css, /white-space: nowrap;/);
  // 가장 긴 라벨(공지사항, 4자 × 11px)이 고정 폭 안에 들어간다
  const width = Number(css.match(/width: (\d+)px;/)[1]);
  const fontSize = Number(css.match(/font-size: (\d+)px;/)[1]);
  const longest = Math.max(...[...labels.matchAll(/'([^']+)'/g)].map((m) => m[1].length));
  assert.ok(longest * fontSize <= width, `${longest}자 × ${fontSize}px > ${width}px`);
});
