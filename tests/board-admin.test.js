// 실행: node --test
// 운영자 키(ADMIN_POST_KEY)로 운영자 글을 쓰고 고치는 흐름.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import createHandler from '../api/board/create.js';
import updateHandler from '../api/board/update.js';
import { ADMIN_NICKNAME, ATTEMPT_LIMIT, checkAdminKey, hashPassword, isReservedNickname } from '../api/board/_lib.js';

const ADMIN_KEY = 'correct-horse-battery-staple-9f3a';
const POST_ID = '11111111-2222-3333-4444-555555555555';
const PASSWORD = 'pass1234';
const NEW_POST = { type: 'post', category: 'business', nickname: '사장님', password: PASSWORD, title: '제목입니다', body: '본문입니다' };
const EDIT = { id: POST_ID, title: '새 제목', body: '새 본문입니다' };

// 핸들러를 실제로 돌리되 Supabase 호출만 가짜로 바꾼다.
// adminKeyEnv: ADMIN_POST_KEY 값 (null이면 미설정), recentAttempts: 이 IP의 최근 시도 수, post: 조회되는 글,
// commentsHaveOfficial: comments.is_official 컬럼이 있는지 (없으면 그 컬럼을 넣은 insert는 400)
async function run(handler, body, { adminKeyEnv = ADMIN_KEY, recentAttempts = 0, post = null, commentsHaveOfficial = true } = {}) {
  const calls = { attemptsLogged: 0, inserts: [], patches: [], lookups: [], requests: [] };
  const logs = [];
  const real = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error, key: process.env.ADMIN_POST_KEY };
  Object.assign(process.env, { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k', IP_HASH_SECRET: 's' });
  if (adminKeyEnv === null) delete process.env.ADMIN_POST_KEY;
  else process.env.ADMIN_POST_KEY = adminKeyEnv;
  console.log = console.warn = console.error = (...args) => logs.push(args.join(' '));

  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const m = options.method || 'GET';
    calls.requests.push(`${m} ${u} ${options.body || ''}`);
    if (u.includes('/rest/v1/board_edit_attempts')) {
      if (m === 'POST') { calls.attemptsLogged++; return new Response(null, { status: 201 }); }
      return new Response(JSON.stringify(Array.from({ length: recentAttempts }, (_, i) => ({ id: String(i) }))));
    }
    if (u.includes('/rest/v1/posts') && m === 'GET') {
      if (u.includes('ip_hash=eq.')) return new Response('[]'); // 글 작성 레이트리밋 조회
      calls.lookups.push(u);
      return new Response(JSON.stringify(post ? [post] : []));
    }
    if (u.includes('/rest/v1/posts') && m === 'POST') {
      calls.inserts.push(JSON.parse(options.body));
      return new Response(JSON.stringify([{ id: POST_ID }]), { status: 201 });
    }
    if (u.includes('/rest/v1/comments') && m === 'GET') return new Response('[]');
    if (u.includes('/rest/v1/comments') && m === 'POST') {
      const row = JSON.parse(options.body);
      if ('is_official' in row && !commentsHaveOfficial) {
        return new Response(JSON.stringify({ code: 'PGRST204', message: "Could not find the 'is_official' column" }), { status: 400 });
      }
      calls.inserts.push(row);
      return new Response(JSON.stringify([{ id: 'comment-id' }]), { status: 201 });
    }
    if (u.includes('/rest/v1/posts') && m === 'PATCH') {
      calls.patches.push(JSON.parse(options.body));
      return new Response(null, { status: 204 });
    }
    throw new Error(`예상 못 한 요청: ${m} ${u}`);
  };

  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  try {
    await handler({ method: 'POST', body, headers: { 'x-real-ip': '1.2.3.4' } }, res);
  } finally {
    globalThis.fetch = real.fetch;
    Object.assign(console, { log: real.log, warn: real.warn, error: real.error });
    if (real.key === undefined) delete process.env.ADMIN_POST_KEY;
    else process.env.ADMIN_POST_KEY = real.key;
  }
  return { ...out, calls, logs };
}

// 키가 응답·로그·Supabase로 나가는 요청(DB) 어디에도 없어야 한다.
function assertKeyNeverLeaves(result, key) {
  assert.ok(!JSON.stringify(result.body).includes(key), '응답에 키가 있음');
  assert.ok(!result.logs.join('\n').includes(key), '로그에 키가 있음');
  assert.ok(!result.calls.requests.join('\n').includes(key), 'Supabase 요청에 키가 있음');
}

// ---- checkAdminKey / isReservedNickname ----

test('checkAdminKey: 없음 / 일치 / 불일치', () => {
  process.env.ADMIN_POST_KEY = ADMIN_KEY;
  try {
    for (const none of [undefined, null, '']) assert.equal(checkAdminKey(none), 'none');
    assert.equal(checkAdminKey(ADMIN_KEY), 'ok');
    for (const wrong of ['wrong', ADMIN_KEY.slice(0, -1), `${ADMIN_KEY} `, ADMIN_KEY.toUpperCase(), 12345, true, {}, [ADMIN_KEY]]) {
      assert.equal(checkAdminKey(wrong), 'denied', String(wrong));
    }
  } finally {
    delete process.env.ADMIN_POST_KEY;
  }
});

test('checkAdminKey: ADMIN_POST_KEY가 없거나 비어 있으면 무엇을 보내도 거부', () => {
  for (const env of [undefined, '']) {
    if (env === undefined) delete process.env.ADMIN_POST_KEY;
    else process.env.ADMIN_POST_KEY = env;
    for (const key of [ADMIN_KEY, 'undefined', 'null', ' ']) assert.equal(checkAdminKey(key), 'denied');
    assert.equal(checkAdminKey(''), 'none');
  }
  delete process.env.ADMIN_POST_KEY;
});

test('checkAdminKey: crypto.timingSafeEqual로 비교한다', () => {
  const source = readFileSync(new URL('../api/board/_lib.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export function checkAdminKey'), source.indexOf('export function getClientIp'));
  assert.match(fn, /crypto\.timingSafeEqual\(/);
  assert.ok(!/adminKey\s*===?\s*expected|expected\s*===?\s*adminKey/.test(fn));
});

test('isReservedNickname: "운영자"와 공백·전각·제로폭 변형', () => {
  for (const name of ['운영자', ' 운영자 ', '운 영 자', '운　영자', '운​영‍자', '﻿운영자', '운\t영\n자', '운영자']) {
    assert.equal(isReservedNickname(name), true, JSON.stringify(name));
  }
  for (const name of ['운영자님', '부운영자', '운영', '사장님', '', null, undefined]) {
    assert.equal(isReservedNickname(name), false, JSON.stringify(name));
  }
  assert.equal(ADMIN_NICKNAME, '운영자');
});

// ---- 글 작성 ----

test('작성: 운영자 키가 맞으면 is_official=true, 닉네임은 "운영자"로 저장', async () => {
  const result = await run(createHandler, { ...NEW_POST, nickname: '아무 이름', adminKey: ADMIN_KEY });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: POST_ID });
  assert.equal(result.calls.inserts.length, 1);
  assert.equal(result.calls.inserts[0].is_official, true);
  assert.equal(result.calls.inserts[0].nickname, '운영자');
  assert.equal(result.calls.attemptsLogged, 0); // 성공은 실패 한도에 넣지 않는다
  assertKeyNeverLeaves(result, ADMIN_KEY);
});

test('작성: 운영자 모드에서는 닉네임을 비워 보내도 된다', async () => {
  const { nickname, ...withoutNickname } = NEW_POST;
  const result = await run(createHandler, { ...withoutNickname, adminKey: ADMIN_KEY });
  assert.equal(result.status, 200);
  assert.equal(result.calls.inserts[0].nickname, '운영자');
});

test('작성: 운영자 키가 틀리면 403, 저장하지 않고 실패 시도로 기록', async () => {
  const wrongKey = 'wrong-key-do-not-leak-7c1d';
  const result = await run(createHandler, { ...NEW_POST, adminKey: wrongKey });
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: '운영자 키가 올바르지 않습니다' });
  assert.deepEqual(result.calls.inserts, []);
  assert.equal(result.calls.attemptsLogged, 1);
  assertKeyNeverLeaves(result, wrongKey);
  assertKeyNeverLeaves(result, ADMIN_KEY);
});

test('작성: ADMIN_POST_KEY가 설정되지 않았으면 운영자 모드는 항상 거부', async () => {
  for (const adminKeyEnv of [null, '']) {
    const result = await run(createHandler, { ...NEW_POST, adminKey: ADMIN_KEY }, { adminKeyEnv });
    assert.equal(result.status, 403);
    assert.deepEqual(result.calls.inserts, []);
  }
});

test('작성: 같은 IP의 연속 실패는 한도(1분에 5번)를 넘으면 429 — 키가 맞아도 막힌다', async () => {
  for (const adminKey of ['wrong', ADMIN_KEY]) {
    const result = await run(createHandler, { ...NEW_POST, adminKey }, { recentAttempts: ATTEMPT_LIMIT });
    assert.equal(result.status, 429);
    assert.deepEqual(result.calls.inserts, []);
    assert.equal(result.calls.attemptsLogged, 0);
  }
  const under = await run(createHandler, { ...NEW_POST, adminKey: ADMIN_KEY }, { recentAttempts: ATTEMPT_LIMIT - 1 });
  assert.equal(under.status, 200);
});

test('작성: 운영자 키 없이 닉네임이 "운영자"(변형 포함)면 400', async () => {
  for (const nickname of ['운영자', ' 운영자 ', '운 영 자', '운​영자', '운영자']) {
    const result = await run(createHandler, { ...NEW_POST, nickname });
    assert.equal(result.status, 400, JSON.stringify(nickname));
    assert.deepEqual(result.body, { error: '사용할 수 없는 닉네임입니다' });
    assert.deepEqual(result.calls.inserts, []);
  }
});

test('작성: 댓글도 "운영자" 닉네임은 운영자 키가 있어야 쓴다', async () => {
  const comment = { type: 'comment', postId: POST_ID, nickname: '운영자', password: PASSWORD, body: '댓글입니다' };
  const denied = await run(createHandler, comment);
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.calls.inserts, []);

  const allowed = await run(createHandler, { ...comment, nickname: '아무개', adminKey: ADMIN_KEY });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.calls.inserts[0].nickname, '운영자');
  assert.equal(allowed.calls.inserts[0].is_official, true);
  assertKeyNeverLeaves(allowed, ADMIN_KEY);
});

test('작성: comments.is_official 컬럼이 아직 없으면 운영자 댓글은 표시 없이 저장', async () => {
  const comment = { type: 'comment', postId: POST_ID, nickname: '아무개', password: PASSWORD, body: '댓글입니다', adminKey: ADMIN_KEY };
  const result = await run(createHandler, comment, { commentsHaveOfficial: false });
  assert.equal(result.status, 200);
  assert.equal(result.calls.inserts.length, 1);
  assert.equal(result.calls.inserts[0].nickname, '운영자');
  assert.ok(!('is_official' in result.calls.inserts[0]));
});

test('작성: 일반 댓글은 is_official을 보내지 않는다', async () => {
  const comment = { type: 'comment', postId: POST_ID, nickname: '사장님', password: PASSWORD, body: '댓글입니다', is_official: true };
  const result = await run(createHandler, comment);
  assert.equal(result.status, 200);
  assert.ok(!('is_official' in result.calls.inserts[0]));
});

test('작성: 일반 글은 그대로 — is_official을 보내지 않고 시도 기록도 건드리지 않는다', async () => {
  const result = await run(createHandler, { ...NEW_POST, is_official: true });
  assert.equal(result.status, 200);
  assert.ok(!('is_official' in result.calls.inserts[0]));
  assert.equal(result.calls.inserts[0].nickname, '사장님');
  assert.equal(result.calls.attemptsLogged, 0);
  assert.ok(!result.calls.requests.some((r) => r.includes('board_edit_attempts')));
});

// ---- 글 수정 ----

test('수정: 운영자 글은 글 비밀번호 대신 운영자 키로 수정', async () => {
  const result = await run(updateHandler, { ...EDIT, adminKey: ADMIN_KEY }, { post: { is_official: true } });
  assert.equal(result.status, 200);
  assert.equal(result.calls.patches.length, 1);
  assert.deepEqual(Object.keys(result.calls.patches[0]).sort(), ['body', 'title', 'updated_at']);
  assert.match(result.calls.lookups[0], /select=is_official$/);
  assertKeyNeverLeaves(result, ADMIN_KEY);
});

test('수정: 운영자 키가 틀리면 403, 글을 조회하지도 고치지도 않는다', async () => {
  const wrongKey = 'wrong-key-do-not-leak-7c1d';
  const result = await run(updateHandler, { ...EDIT, adminKey: wrongKey }, { post: { is_official: true } });
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: '운영자 키가 올바르지 않습니다' });
  assert.deepEqual(result.calls.patches, []);
  assert.deepEqual(result.calls.lookups, []);
  assert.equal(result.calls.attemptsLogged, 1);
  assertKeyNeverLeaves(result, wrongKey);
});

test('수정: 틀린 키에 맞는 글 비밀번호를 같이 보내도 거부', async () => {
  const result = await run(
    updateHandler,
    { ...EDIT, adminKey: 'wrong', password: PASSWORD },
    { post: { is_official: true, password_hash: hashPassword(PASSWORD) } }
  );
  assert.equal(result.status, 403);
  assert.deepEqual(result.calls.patches, []);
});

test('수정: ADMIN_POST_KEY가 설정되지 않았으면 운영자 키 수정은 항상 거부', async () => {
  const result = await run(updateHandler, { ...EDIT, adminKey: ADMIN_KEY }, { adminKeyEnv: null, post: { is_official: true } });
  assert.equal(result.status, 403);
  assert.deepEqual(result.calls.patches, []);
});

test('수정: 운영자 키로는 운영자 글만 — 방문자 글은 403', async () => {
  const result = await run(updateHandler, { ...EDIT, adminKey: ADMIN_KEY }, { post: { is_official: false } });
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: '운영자 키로는 운영자 글만 수정할 수 있습니다' });
  assert.deepEqual(result.calls.patches, []);
});

test('수정: 운영자 키 시도도 같은 한도(1분에 5번)에 걸린다', async () => {
  const result = await run(updateHandler, { ...EDIT, adminKey: ADMIN_KEY }, { recentAttempts: ATTEMPT_LIMIT, post: { is_official: true } });
  assert.equal(result.status, 429);
  assert.deepEqual(result.calls.patches, []);
});

test('수정: 비밀번호로 고치는 기존 흐름은 그대로 (운영자 글 포함)', async () => {
  const post = { password_hash: hashPassword(PASSWORD) };
  const ok = await run(updateHandler, { ...EDIT, password: PASSWORD }, { post });
  assert.equal(ok.status, 200);
  assert.match(ok.calls.lookups[0], /select=password_hash$/);

  const wrong = await run(updateHandler, { ...EDIT, password: 'nope1234' }, { post });
  assert.equal(wrong.status, 403);
  assert.deepEqual(wrong.body, { error: '비밀번호가 일치하지 않습니다' });

  const missing = await run(updateHandler, { ...EDIT }, { post });
  assert.equal(missing.status, 400);
});

// ---- 화면 ----

test('write.html: 운영자 키 입력칸은 ?admin=1 일 때만 스크립트가 만든다', () => {
  const html = readFileSync(new URL('../write.html', import.meta.url), 'utf8');
  const [markup, script] = [html.slice(0, html.indexOf('<script src="business.js">')), html.slice(html.indexOf('<script src="business.js">'))];
  // 기본 마크업에는 운영자 키 요소가 없다
  assert.ok(!/adminKey|운영자 키/.test(markup));
  assert.match(script, /get\('admin'\) === '1'/);
  assert.match(script, /if \(ADMIN_MODE\) \{[\s\S]*adminKeyInput = document\.createElement\('input'\)/);
  assert.match(script, /adminKeyInput\.type = 'password'/);
  assert.match(script, /\.\.\.\(adminKeyInput \? \{ adminKey: adminKeyInput\.value \} : \{\}\)/);
  // 키를 브라우저 저장소나 주소에 남기지 않는다
  assert.ok(!/localStorage|sessionStorage/.test(script));
});
