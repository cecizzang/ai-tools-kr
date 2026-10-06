// 실행: node --test
// 운영자 글(posts.is_official) 표시와, 방문자가 is_official을 넣지 못하게 하는 장치들.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import officialModule from '../official.js';
import createHandler from '../api/board/create.js';

const { OFFICIAL_LABEL, isOfficial, officialBadge, fetchWithOfficial } = officialModule;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('isOfficial: is_official이 true일 때만 — 닉네임으로는 판별하지 않는다', () => {
  assert.equal(isOfficial({ nickname: '아무개', is_official: true }), true);
  assert.equal(isOfficial({ nickname: '운영자', is_official: false }), false);
  assert.equal(isOfficial({ nickname: '운영자' }), false); // 컬럼을 못 읽은 경우
  for (const value of ['true', 1, null, undefined]) assert.equal(isOfficial({ is_official: value }), false);
  assert.equal(isOfficial(null), false);
});

test('officialBadge: "운영자" 배지 요소', () => {
  const doc = { createElement: (tag) => ({ tag, className: '', textContent: '' }) };
  assert.deepEqual(officialBadge(doc), { tag: 'span', className: 'official-badge', textContent: '운영자' });
  assert.equal(OFFICIAL_LABEL, '운영자');
});

test('fetchWithOfficial: 읽을 수 있으면 is_official 포함 주소로 한 번만 요청', async () => {
  const requested = [];
  const { res, officialAvailable } = await fetchWithOfficial(
    (official) => `posts?official=${official}`,
    async (url) => { requested.push(url); return { ok: true, status: 200 }; }
  );
  assert.deepEqual(requested, ['posts?official=true']);
  assert.equal(officialAvailable, true);
  assert.equal(res.status, 200);
});

test('fetchWithOfficial: 권한이 없으면(401/403/400) is_official 없이 다시 읽는다', async () => {
  for (const status of [401, 403, 400]) {
    const requested = [];
    const { res, officialAvailable } = await fetchWithOfficial(
      (official) => `posts?official=${official}`,
      async (url) => {
        requested.push(url);
        return url.endsWith('true') ? { ok: false, status } : { ok: true, status: 200 };
      }
    );
    assert.deepEqual(requested, ['posts?official=true', 'posts?official=false'], `status=${status}`);
    assert.equal(officialAvailable, false);
    assert.equal(res.ok, true);
  }
});

test('fetchWithOfficial: 서버 오류는 재시도하지 않고 그대로 돌려준다', async () => {
  const requested = [];
  const { res, officialAvailable } = await fetchWithOfficial(
    (official) => `posts?official=${official}`,
    async (url) => { requested.push(url); return { ok: false, status: 500 }; }
  );
  assert.equal(requested.length, 1);
  assert.equal(res.status, 500);
  assert.equal(officialAvailable, false);
});

test('글 작성 API는 요청에 is_official=true가 들어와도 저장하지 않는다', async () => {
  const realFetch = globalThis.fetch;
  const realEnv = { ...process.env };
  Object.assign(process.env, {
    SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret', IP_HASH_SECRET: 'ip-secret',
  });
  const inserts = [];
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'GET') return new Response('[]', { status: 200 }); // 레이트리밋 조회
    inserts.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify([{ id: 'new-id' }]), { status: 201 });
  };

  try {
    const response = {};
    const res = {
      status(code) { response.status = code; return this; },
      json(body) { response.body = body; return this; },
    };
    await createHandler({
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7' },
      socket: {},
      body: {
        type: 'post', category: 'business', nickname: '운영자', password: 'pass1234',
        title: '운영자인 척하는 글', body: '본문입니다', is_official: true, isOfficial: true,
      },
    }, res);

    assert.equal(response.status, 200);
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].url, /\/rest\/v1\/posts$/);
    assert.ok(!('is_official' in inserts[0].body));
    assert.deepEqual(
      Object.keys(inserts[0].body).sort(),
      ['body', 'category', 'id', 'image_urls', 'ip_hash', 'nickname', 'password_hash', 'title']
    );
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
    Object.assign(process.env, realEnv);
  }
});

test('글 수정 API는 제목·본문·수정 시각만 바꾼다', () => {
  const patchBody = read('api/board/update.js').match(/method: 'PATCH'[\s\S]*?JSON\.stringify\(\{([\s\S]*?)\}\)/)[1];
  const keys = [...patchBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['title', 'body', 'updated_at']);
});

test('official-posts.sql: 읽기 권한 + 방문자 쓰기를 막는 트리거와 restrictive 정책', () => {
  const sql = read('supabase/official-posts.sql');
  assert.match(sql, /add column if not exists is_official boolean not null default false/);
  assert.match(sql, /grant select \(is_official\) on public\.posts to anon, authenticated/);
  assert.match(sql, /current_user in \('anon', 'authenticated'\)/);
  assert.match(sql, /new\.is_official := false/);
  assert.match(sql, /new\.is_official := old\.is_official/);
  assert.match(sql, /before insert or update on public\.posts/);
  // permissive 정책끼리는 OR로 합쳐지므로 반드시 restrictive여야 한다
  assert.equal((sql.match(/as restrictive for (insert|update)/g) || []).length, 2);
  assert.equal((sql.match(/with check \(is_official = false\)/g) || []).length, 2);
  // 방문자에게 is_official 쓰기 권한을 주는 문장은 없다
  assert.ok(!/grant[^;]*(insert|update)[^;]*to anon/i.test(sql));
});

test('목록 페이지들은 official.js로 배지를 그리고 닉네임으로 판별하지 않는다', () => {
  for (const page of ['board.html', 'index.html', 'business.html']) {
    const html = read(page);
    assert.match(html, /<script src="official\.js"><\/script>/, page);
    assert.match(html, /\.official-badge \{/, page);
    assert.match(html, /OfficialPosts\.officialBadge\(\)/, page);
    assert.match(html, /OfficialPosts\.fetchWithOfficial\(/, page);
    assert.ok(!/nickname\s*===?\s*['"]운영자['"]/.test(html), page);

  }
});

test('business.html: 운영자 가이드(최신 3개)와 사장님들의 글을 따로 읽는다', () => {
  const html = read('business.html');
  assert.match(html, /id="guideSection" hidden/);
  assert.match(html, /<h2>운영자 가이드<\/h2>/);
  assert.match(html, /const GUIDE_COUNT = 3;/);
  assert.match(html, /&is_official=eq\.true&order=created_at\.desc&limit=\$\{GUIDE_COUNT\}/);
  assert.match(html, /official \? '&is_official=eq\.false' : ''/);
  assert.match(html, /아직 글이 없어요\. 첫 글을 남겨주세요/);
  // 다크 테마용 얇은 스크롤바
  assert.match(html, /scrollbar-width: thin;/);
  assert.match(html, /\.tool-strip::-webkit-scrollbar \{ height: 6px; \}/);
});
