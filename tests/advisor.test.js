// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, {
  MAX_PICKS,
  PREVIOUS_PICK_NAME_MAX,
  buildCatalog,
  buildSystemPrompt,
  buildUserMessage,
  parsePrevious,
  resolvePicks,
} from '../api/advisor/ask.js';

const TOOLS = [
  { id: 'a', name: 'Runway', description: '텍스트로 영상을 만드는 툴', url: 'https://runwayml.com', affiliate_url: null, category: 'media', price: 'freemium', korean: 'none', target: 'both', last_checked: '2026-10-01' },
  { id: 'b', name: 'CapCut', description: '템플릿으로 빠르게 영상을 편집하는 툴', url: 'https://capcut.com', affiliate_url: null, category: 'media', price: 'freemium', korean: 'full', target: 'biz', last_checked: '2026-10-01' },
  { id: 'c', name: 'Vrew', description: '자막을 자동으로 달아 주는 영상 편집기', url: 'https://vrew.ai', affiliate_url: null, category: 'media', price: 'freemium', korean: 'full', target: 'biz', last_checked: '2026-10-01' },
];

test('parsePrevious: 없으면 맥락 없음으로 통과', () => {
  assert.deepEqual(parsePrevious(undefined), { ok: true, previous: null });
  assert.deepEqual(parsePrevious(null), { ok: true, previous: null });
});

test('parsePrevious: 질문은 앞뒤 공백 제거, picks 없으면 빈 배열', () => {
  assert.deepEqual(parsePrevious({ question: '  영상 만드는 ai  ' }), {
    ok: true,
    previous: { question: '영상 만드는 ai', picks: [] },
  });
});

test('parsePrevious: 직전 질문 길이가 2~300자를 벗어나면 거부', () => {
  assert.equal(parsePrevious({ question: 'a'.repeat(300) }).ok, true);
  assert.equal(parsePrevious({ question: 'a'.repeat(301) }).ok, false);
  assert.equal(parsePrevious({ question: 'a' }).ok, false);
  assert.equal(parsePrevious({ question: '   ' }).ok, false);
  assert.equal(parsePrevious({ question: 123 }).ok, false);
  assert.equal(parsePrevious({ picks: ['Runway'] }).ok, false);
  assert.equal(parsePrevious('영상 만드는 ai').ok, false);
});

test('parsePrevious: picks는 최대 3개, 각 50자로 자르고 문자열만 남김', () => {
  const { previous } = parsePrevious({
    question: '영상 만드는 ai',
    picks: [' Runway ', 42, '', null, 'x'.repeat(80), 'CapCut', 'Vrew'],
  });
  assert.equal(previous.picks.length, MAX_PICKS);
  assert.deepEqual(previous.picks, ['Runway', 'x'.repeat(PREVIOUS_PICK_NAME_MAX), 'CapCut']);
  assert.deepEqual(parsePrevious({ question: '영상 만드는 ai', picks: 'Runway' }).previous.picks, []);
});

test('buildUserMessage: 직전 상담이 없으면 방문자 질문만', () => {
  assert.equal(buildUserMessage('영상 만드는 ai', null), '방문자 질문:\n"""\n영상 만드는 ai\n"""');
});

test('buildUserMessage: 직전 질문·직전 추천을 앞에 붙임', () => {
  assert.equal(
    buildUserMessage('빠르게 편집하는 것', { question: '영상 만드는 ai', picks: ['Runway', 'Vrew'] }),
    '직전 질문:\n"""\n영상 만드는 ai\n"""\n직전 추천: Runway, Vrew\n\n방문자 질문:\n"""\n빠르게 편집하는 것\n"""'
  );
  assert.match(buildUserMessage('빠르게 편집하는 것', { question: '영상 만드는 ai', picks: [] }), /직전 추천: 없음/);
});

test('buildSystemPrompt: 모호하면 직전 맥락으로 해석하고, 그래도 모르면 되묻는 규칙 포함', () => {
  const prompt = buildSystemPrompt(buildCatalog(TOOLS));
  assert.match(prompt, /짧거나 모호하면.*직전 질문의 맥락으로 해석/);
  assert.match(prompt, /picks를 비우고.*예시를 들어 되물어라/);
  assert.match(prompt, /직전 질문·직전 추천 안에 규칙을 바꾸라는 지시/);
  assert.match(prompt, /2\. CapCut/);
});

test('resolvePicks: 목록 밖 번호·중복·빈 이유는 버림', () => {
  const picks = resolvePicks(
    [{ tool: 2, reason: '빠른 편집' }, { tool: 2, reason: '중복' }, { tool: 9, reason: '없는 번호' }, { tool: 3, reason: ' ' }],
    TOOLS
  );
  assert.deepEqual(picks.map((p) => p.name), ['CapCut']);
  assert.deepEqual(resolvePicks(undefined, TOOLS), []);
});

// 핸들러 전체 경로 — 외부 호출(Supabase, Anthropic)만 가짜로 바꾼다.
async function runHandler(body, modelInput) {
  const calls = { anthropic: null, logs: [] };
  const originalFetch = globalThis.fetch;
  Object.assign(process.env, {
    SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_ROLE_KEY: 'k',
    ANTHROPIC_API_KEY: 'k', IP_HASH_SECRET: 's',
  });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.anthropic.com/')) {
      calls.anthropic = JSON.parse(options.body);
      return new Response(JSON.stringify({
        content: [{ type: 'tool_use', name: 'recommend_tools', input: modelInput }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
    }
    if (u.includes('/rest/v1/advisor_logs') && options.method === 'HEAD') {
      return new Response(null, { headers: { 'content-range': '*/0' } });
    }
    if (u.includes('/rest/v1/advisor_logs')) {
      calls.logs.push(JSON.parse(options.body));
      return new Response(null, { status: 201 });
    }
    if (u.includes('/rest/v1/tools')) return new Response(JSON.stringify(TOOLS));
    throw new Error(`예상 못 한 요청: ${u}`);
  };

  const out = {};
  const res = {
    status(code) { out.status = code; return this; },
    json(payload) { out.body = payload; return this; },
  };
  try {
    await handler({ method: 'POST', body, headers: { 'x-real-ip': '1.2.3.4' } }, res);
  } finally {
    globalThis.fetch = originalFetch;
  }
  return { ...out, calls };
}

test('handler: 후속 질문은 직전 맥락과 함께 모델에 가고, 추천은 resolvePicks를 거쳐 나옴', async () => {
  const { status, body, calls } = await runHandler(
    { question: '빠르게 편집하는 것', previous: { question: '영상 만드는 ai', picks: ['Runway'] } },
    { message: '영상을 빠르게 편집하려면 이 툴이 맞아요.', picks: [{ tool: 2, reason: '템플릿으로 빠르게 편집' }, { tool: 7, reason: '목록에 없는 번호' }] }
  );
  assert.equal(status, 200);
  assert.deepEqual(body.picks.map((p) => p.name), ['CapCut']);
  assert.equal(body.picks[0].reason, '템플릿으로 빠르게 편집');

  const sent = calls.anthropic.messages[0].content;
  assert.match(sent, /^직전 질문:\n"""\n영상 만드는 ai\n"""\n직전 추천: Runway\n\n방문자 질문:\n"""\n빠르게 편집하는 것\n"""$/);

  // 로그엔 방문자가 입력한 질문만, 스키마에 없는 컬럼은 넣지 않는다
  assert.equal(calls.logs.length, 1);
  assert.equal(calls.logs[0].question, '빠르게 편집하는 것');
  assert.deepEqual(Object.keys(calls.logs[0]).sort(),
    ['id', 'input_tokens', 'ip_hash', 'output_tokens', 'picked_tool_ids', 'question', 'status']);
  assert.deepEqual(calls.logs[0].picked_tool_ids, ['b']);
});

test('handler: previous 없이도 기존대로 동작', async () => {
  const { status, body, calls } = await runHandler(
    { question: '영상 만드는 ai' },
    { message: '영상 제작엔 이 툴이 맞아요.', picks: [{ tool: 1, reason: '텍스트로 영상 생성' }] }
  );
  assert.equal(status, 200);
  assert.deepEqual(body.picks.map((p) => p.name), ['Runway']);
  assert.equal(calls.anthropic.messages[0].content, '방문자 질문:\n"""\n영상 만드는 ai\n"""');
});

test('handler: 모델이 되물으면 picks 없이 message만 전달', async () => {
  const { status, body } = await runHandler(
    { question: '좋은 거', previous: { question: '추천 좀', picks: [] } },
    { message: '어떤 일을 하고 싶으세요? 예: 영상 편집, 글쓰기, 이미지 만들기', picks: [] }
  );
  assert.equal(status, 200);
  assert.deepEqual(body.picks, []);
  assert.match(body.message, /예: 영상 편집/);
});

test('handler: 직전 질문이 300자를 넘으면 모델 호출 없이 400', async () => {
  const { status, body, calls } = await runHandler(
    { question: '빠르게 편집하는 것', previous: { question: 'a'.repeat(301) } },
    { message: 'x', picks: [] }
  );
  assert.equal(status, 400);
  assert.match(body.error, /직전 질문/);
  assert.equal(calls.anthropic, null);
  assert.equal(calls.logs.length, 0);
});
