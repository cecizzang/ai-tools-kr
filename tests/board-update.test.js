// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { EDIT_ATTEMPT_LIMIT } from '../api/board/update.js';
import { LIMITS, hashPassword } from '../api/board/_lib.js';

const POST_ID = '11111111-2222-3333-4444-555555555555';
const PASSWORD = 'pass1234';
const VALID = { id: POST_ID, password: PASSWORD, title: '새 제목', body: '새 본문입니다' };

// 핸들러를 실제로 돌리되 Supabase 호출만 가짜로 바꾼다.
async function run(body, { method = 'POST', post = { password_hash: hashPassword(PASSWORD) }, recentAttempts = 0, patchStatus = 204 } = {}) {
  const calls = { attemptsLogged: 0, patches: [], lookups: 0 };
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  Object.assign(process.env, { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k', IP_HASH_SECRET: 's' });
  console.error = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const m = options.method || 'GET';
    if (u.includes('/rest/v1/board_edit_attempts')) {
      if (m === 'POST') { calls.attemptsLogged++; calls.attemptRow = JSON.parse(options.body); return new Response(null, { status: 201 }); }
      return new Response(JSON.stringify(Array.from({ length: recentAttempts }, (_, i) => ({ id: String(i) }))));
    }
    if (u.includes('/rest/v1/posts') && m === 'GET') {
      calls.lookups++;
      calls.lookupUrl = u;
      return new Response(JSON.stringify(post ? [post] : []));
    }
    if (u.includes('/rest/v1/posts') && m === 'PATCH') {
      calls.patches.push({ url: u, body: JSON.parse(options.body) });
      return new Response(null, { status: patchStatus });
    }
    throw new Error(`예상 못 한 요청: ${m} ${u}`);
  };

  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  try {
    await handler({ method, body, headers: { 'x-real-ip': '1.2.3.4' } }, res);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }
  return { ...out, calls };
}

test('비밀번호가 맞으면 제목·본문과 updated_at만 수정', async () => {
  const before = Date.now();
  const { status, body, calls } = await run({ ...VALID, title: '  새 제목  ', body: '\n새 본문입니다\n' });
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true });
  assert.equal(calls.patches.length, 1);

  const patch = calls.patches[0];
  assert.match(patch.url, new RegExp(`/rest/v1/posts\\?id=eq\\.${POST_ID}$`));
  assert.deepEqual(Object.keys(patch.body).sort(), ['body', 'title', 'updated_at']);
  assert.equal(patch.body.title, '새 제목');
  assert.equal(patch.body.body, '새 본문입니다');
  const updatedAt = new Date(patch.body.updated_at).getTime();
  assert.ok(updatedAt >= before && updatedAt <= Date.now(), 'updated_at은 지금 시각');
});

test('카테고리·닉네임·이미지·비밀번호는 요청에 넣어도 바뀌지 않음', async () => {
  const { status, calls } = await run({
    ...VALID, category: 'notice', nickname: '관리자', image_urls: ['https://evil.example/x.png'],
    images: ['data:image/png;base64,AAAA'], password_hash: 'x', ip_hash: 'y', created_at: '2000-01-01',
  });
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(calls.patches[0].body).sort(), ['body', 'title', 'updated_at']);
});

test('비밀번호가 틀리면 403, 수정 안 함', async () => {
  const { status, body, calls } = await run({ ...VALID, password: 'wrong-pass' });
  assert.equal(status, 403);
  assert.equal(body.error, '비밀번호가 일치하지 않습니다');
  assert.equal(calls.patches.length, 0);
  assert.equal(calls.attemptsLogged, 1, '틀린 시도도 레이트리밋에 잡히도록 기록');
});

test('없는 글은 404', async () => {
  const { status, calls } = await run(VALID, { post: null });
  assert.equal(status, 404);
  assert.equal(calls.patches.length, 0);
});

test('제목·본문 길이는 create.js와 같은 LIMITS', async () => {
  const cases = [
    [{ title: 'a' }, /제목은 2~60자/],
    [{ title: 'a'.repeat(LIMITS.title[1] + 1) }, /제목은 2~60자/],
    [{ title: '   ' }, /제목은/],
    [{ title: undefined }, /제목은/],
    [{ body: 'a' }, /본문은 2~5000자/],
    [{ body: 'a'.repeat(LIMITS.postBody[1] + 1) }, /본문은 2~5000자/],
    [{ body: 123 }, /본문은/],
  ];
  for (const [override, message] of cases) {
    const { status, body, calls } = await run({ ...VALID, ...override });
    assert.equal(status, 400, JSON.stringify(override).slice(0, 40));
    assert.match(body.error, message);
    assert.equal(calls.lookups, 0, '검증 실패는 DB 조회 전에 끝나야 함');
    assert.equal(calls.attemptsLogged, 0);
  }
  const ok = await run({ ...VALID, title: 'a'.repeat(LIMITS.title[1]), body: 'a'.repeat(LIMITS.postBody[1]) });
  assert.equal(ok.status, 200);
});

test('id·비밀번호가 없으면 400', async () => {
  assert.equal((await run({ ...VALID, id: '' })).status, 400);
  assert.equal((await run({ ...VALID, id: 123 })).status, 400);
  assert.equal((await run({ ...VALID, password: '' })).status, 400);
  assert.equal((await run({ ...VALID, password: undefined })).status, 400);
  assert.equal((await run(undefined)).status, 400);
});

test('POST가 아니면 405', async () => {
  const { status, calls } = await run(VALID, { method: 'GET' });
  assert.equal(status, 405);
  assert.equal(calls.lookups, 0);
});

test('같은 IP의 최근 시도가 한도에 차면 429, 비밀번호 확인도 안 함', async () => {
  const limited = await run(VALID, { recentAttempts: EDIT_ATTEMPT_LIMIT });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /잠시 후 다시/);
  assert.equal(limited.calls.lookups, 0);
  assert.equal(limited.calls.patches.length, 0);
  assert.equal(limited.calls.attemptsLogged, 0);

  const allowed = await run(VALID, { recentAttempts: EDIT_ATTEMPT_LIMIT - 1 });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.calls.attemptsLogged, 1);
  assert.match(allowed.calls.attemptRow.ip_hash, /^[0-9a-f]{64}$/, 'IP는 해시로만 저장');
});

test('DB 수정이 실패하면 500 (updated_at 컬럼을 아직 안 만든 경우 포함)', async () => {
  const { status, body } = await run(VALID, { patchStatus: 400 });
  assert.equal(status, 500);
  assert.match(body.error, /수정 실패: 400/);
});

test('id는 URL에 인코딩해서 넣음', async () => {
  const { calls } = await run({ ...VALID, id: 'x&select=password_hash' }, { post: null });
  assert.match(calls.lookupUrl, /id=eq\.x%26select%3Dpassword_hash&select=password_hash$/);
});
