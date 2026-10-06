// 실행: node --test
// 페이지 넘김 숨기기와 글 상세의 운영자 배지.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import paginationModule from '../pagination.js';
import officialModule from '../official.js';

const { totalPages, shouldShowPagination } = paginationModule;
const { fetchWithOptionalColumns, isOfficial } = officialModule;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('totalPages: 글이 없어도 1, 페이지 크기로 올림', () => {
  assert.deepEqual([0, 1, 20, 21, 40, 41].map((total) => totalPages(total, 20)), [1, 1, 1, 2, 2, 3]);
  assert.equal(totalPages(NaN, 20), 1);
  assert.equal(totalPages(undefined, 20), 1);
});

test('shouldShowPagination: 글이 없거나 한 페이지 이하면 숨긴다', () => {
  assert.equal(shouldShowPagination(1, 0, 20), false);
  assert.equal(shouldShowPagination(1, 1, 20), false);
  assert.equal(shouldShowPagination(1, 20, 20), false);
  assert.equal(shouldShowPagination(1, NaN, 20), false);
});

test('shouldShowPagination: 두 페이지 이상이면 보인다', () => {
  assert.equal(shouldShowPagination(1, 21, 20), true);
  assert.equal(shouldShowPagination(2, 21, 20), true);
  assert.equal(shouldShowPagination(3, 100, 20), true);
});

test('shouldShowPagination: 범위를 벗어난 페이지에서는 돌아갈 수 있게 보인다', () => {
  assert.equal(shouldShowPagination(5, 3, 20), true);
  assert.equal(shouldShowPagination(2, 0, 20), true);
});

test('board.html·business.html: 같은 규칙으로 페이지 넘김을 숨긴다', () => {
  for (const page of ['board.html', 'business.html']) {
    const html = read(page);
    assert.match(html, /<script src="pagination\.js"><\/script>/, page);
    const fn = html.slice(html.indexOf('function renderPagination'));
    assert.match(fn, /const visible = Pagination\.shouldShowPagination\(page, total, PAGE_SIZE\);/, page);
    assert.match(fn, /el\.style\.display = visible \? '' : 'none';\s*\n\s*if \(!visible\) return;/, page);
    // 숨길지 정하기 전에 "이전/다음"을 그리지 않는다
    assert.ok(fn.indexOf('if (!visible) return;') < fn.indexOf("'이전'"), page);
  }
  // 페이지 넘김을 쓰는 곳은 이 둘뿐이다
  for (const page of ['index.html', 'post.html', 'tools.html', 'write.html']) {
    assert.ok(!read(page).includes('renderPagination'), page);
  }
});

// ---- 글 상세: is_official을 못 읽어도 글은 보여야 한다 ----

const BASE = 'id,title';
// allowed: 읽을 수 있는 선택 컬럼
function fakeRequest(allowed) {
  const requested = [];
  const request = async (columns) => {
    requested.push(columns);
    const optional = columns.split(',').filter((c) => !BASE.split(',').includes(c));
    const ok = optional.every((c) => allowed.includes(c));
    return { ok, status: ok ? 200 : 401, columns };
  };
  return { request, requested };
}

test('fetchWithOptionalColumns: 다 읽을 수 있으면 한 번에', async () => {
  const { request, requested } = fakeRequest(['updated_at', 'is_official']);
  const res = await fetchWithOptionalColumns(request, BASE, ['updated_at', 'is_official']);
  assert.equal(res.ok, true);
  assert.deepEqual(requested, ['id,title,updated_at,is_official']);
});

test('fetchWithOptionalColumns: is_official 권한이 없으면 그 컬럼만 빼고 읽는다', async () => {
  const { request, requested } = fakeRequest(['updated_at']);
  const res = await fetchWithOptionalColumns(request, BASE, ['updated_at', 'is_official']);
  assert.equal(res.ok, true);
  assert.equal(res.columns, 'id,title,updated_at');
  assert.deepEqual(requested, ['id,title,updated_at,is_official', 'id,title,updated_at']);
  // 그렇게 읽은 글에는 is_official이 없으니 배지는 붙지 않는다
  assert.equal(isOfficial({ id: 1, title: '글', nickname: '운영자' }), false);
});

test('fetchWithOptionalColumns: updated_at만 못 읽어도 is_official은 살린다', async () => {
  const { request } = fakeRequest(['is_official']);
  const res = await fetchWithOptionalColumns(request, BASE, ['updated_at', 'is_official']);
  assert.equal(res.ok, true);
  assert.equal(res.columns, 'id,title,is_official');
});

test('fetchWithOptionalColumns: 선택 컬럼을 하나도 못 읽으면 기본 컬럼만으로', async () => {
  const { request, requested } = fakeRequest([]);
  const res = await fetchWithOptionalColumns(request, BASE, ['updated_at', 'is_official']);
  assert.equal(res.ok, true);
  assert.equal(res.columns, 'id,title');
  assert.equal(requested.length, 4);
});

test('fetchWithOptionalColumns: 기본 컬럼조차 실패하면 마지막 실패 응답을 돌려준다', async () => {
  const requested = [];
  const res = await fetchWithOptionalColumns(
    async (columns) => { requested.push(columns); return { ok: false, status: 500 }; },
    BASE,
    ['updated_at', 'is_official']
  );
  assert.equal(res.ok, false);
  assert.equal(requested.at(-1), 'id,title');
});

test('post.html: 작성자 닉네임 앞에 is_official 기준 운영자 배지, 댓글 목록은 그대로', () => {
  const html = read('post.html');
  assert.match(html, /<script src="official\.js"><\/script>/);
  assert.match(html, /\.official-badge \{/);
  assert.match(html, /fetchWithOptionalColumns\(fetchPost, columns, \['updated_at', 'is_official'\]\)/);

  const renderPost = html.slice(html.indexOf('function renderPost'), html.indexOf('function startEditPost'));
  // 배지를 먼저 붙이고 그 뒤에 닉네임 텍스트
  const badgeAt = renderPost.indexOf('if (OfficialPosts.isOfficial(post)) metaEl.appendChild(OfficialPosts.officialBadge());');
  const nicknameAt = renderPost.indexOf('${post.nickname}');
  assert.ok(badgeAt !== -1 && nicknameAt !== -1 && badgeAt < nicknameAt);
  assert.ok(!/nickname\s*===?\s*['"]운영자['"]/.test(html));

  // 배지는 글 작성자에만 — 댓글 쪽 코드에는 없고, 댓글 조회 컬럼도 그대로다
  assert.equal(html.split('OfficialPosts.officialBadge()').length - 1, 1);
  assert.match(html, /comments\?post_id=eq\.\$\{encodeURIComponent\(POST_ID\)\}&select=id,post_id,nickname,body,created_at&order=created_at\.asc/);
});
