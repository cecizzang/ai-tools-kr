// 실행: node --test
// 중복 판정과, 후보가 들어와서 추가/중복/검증 탈락/insert 에러로 갈리는 전체 흐름을 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { checkCandidate, findDuplicate, runDiscovery } from '../api/cron/discover-tools.js';

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
  ...overrides,
});

const KNOWN = [
  { name: 'Gemini', url: 'https://gemini.google.com' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/' },
  { name: 'Adobe Firefly', url: 'https://www.adobe.com/products/firefly.html' },
  { name: 'Whisper', url: 'https://github.com/openai/whisper' },
  { name: 'Otter', url: 'https://apps.apple.com/us/app/otter-transcribe/id1276437113' },
  { name: 'Lovable', url: 'https://lovable.dev/pricing' },
];
const dup = (name, url) => findDuplicate({ name, url }, KNOWN);

test('findDuplicate: 이름은 완전 일치만 중복 (대소문자·공백 무시), 부분 일치는 아님', () => {
  assert.match(dup(' gemini ', 'https://other.example'), /^이름 일치: 기존 "Gemini"/);
  assert.equal(dup('Gemini Notebook', 'https://other.example'), null);
  assert.equal(dup('Otter Pilot', 'https://otterpilot.example'), null);
  assert.equal(dup('Perplex', 'https://perplex.example'), null);
});

test('findDuplicate: 같은 툴의 하위 페이지 URL은 중복', () => {
  assert.match(dup('Veo', 'https://gemini.google.com/app'), /^URL 일치: 기존 "Gemini"/);
  assert.match(dup('Perplexity AI', 'http://perplexity.ai/ko/pricing'), /^URL 일치: 기존 "Perplexity"/);
  assert.match(dup('Lovable 2', 'https://www.lovable.dev'), /^URL 일치: 기존 "Lovable"/);
  assert.match(dup('Firefly', 'https://adobe.com/products/firefly.html/features'), /^URL 일치: 기존 "Adobe Firefly"/);
});

test('findDuplicate: 호스트가 같아도 다른 제품 경로면 중복 아님', () => {
  assert.equal(dup('Adobe Podcast', 'https://www.adobe.com/products/podcast.html'), null);
  assert.equal(dup('Comet', 'https://www.perplexity.ai/comet'), null);
  assert.equal(dup('Other', 'https://perplexity.example.com'), null);
});

test('findDuplicate: 공용 호스트는 저장소·앱 단위로 비교', () => {
  assert.match(dup('whisper fork', 'https://github.com/openai/whisper/tree/main'), /^URL 일치: 기존 "Whisper"/);
  assert.equal(dup('Codex', 'https://github.com/openai/codex'), null);
  // 앱스토어 URL은 /us/app 까지가 모든 앱에 공통이다
  assert.equal(dup('Granola', 'https://apps.apple.com/us/app/granola/id6502280012'), null);
  assert.match(dup('Otter KR', 'https://apps.apple.com/kr/app/otter/id1276437113'), /^URL 일치: 기존 "Otter"/);
  const play = [{ name: 'A', url: 'https://play.google.com/store/apps/details?id=com.a.app' }];
  assert.equal(findDuplicate({ name: 'B', url: 'https://play.google.com/store/apps/details?id=com.b.app' }, play), null);
  assert.match(findDuplicate({ name: 'B', url: 'https://play.google.com/store/apps/details?id=com.a.app&hl=ko' }, play), /^URL 일치/);
});

test('findDuplicate: 기존 URL이 비어 있어도 다른 후보를 막지 않는다', () => {
  const known = [{ name: 'Old', url: null }, { name: 'Old2', url: '' }];
  assert.equal(findDuplicate({ name: 'New', url: 'https://new.example' }, known), null);
});

test('checkCandidate: 중복 → 검증 순서로 판정하고 사유를 돌려준다', () => {
  assert.deepEqual(
    checkCandidate(tool({ name: 'Brand New', url: 'https://brandnew.example' }), KNOWN, NOW),
    { result: 'ok', reason: null }
  );
  assert.equal(checkCandidate(tool({ name: 'Gemini' }), KNOWN, NOW).result, 'duplicate');
  const invalid = checkCandidate(tool({ name: 'Old One', url: 'https://old.example', released: '2023-03' }), KNOWN, NOW);
  assert.equal(invalid.result, 'invalid');
  assert.match(invalid.reason, /^released 43개월 전/);
  assert.deepEqual(checkCandidate(tool({ url: '' }), KNOWN, NOW), { result: 'invalid', reason: 'name 또는 url 없음' });
  assert.equal(checkCandidate(null, KNOWN, NOW).result, 'invalid');
});

// ---- runDiscovery: fetch를 가짜로 바꿔 전체 흐름을 돌려 본다 ----

const thisMonth = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
const PROPOSED = [
  tool({ name: 'Fresh Tool', url: 'https://fresh.example', released: thisMonth }),
  tool({ name: 'gemini', url: 'https://elsewhere.example', released: thisMonth }),
  tool({ name: 'Stale Tool', url: 'https://stale.example', released: '2020-01' }),
  tool({ name: 'Fresh Again', url: 'https://fresh.example/app', released: thisMonth }),
  tool({ name: 'Broken Insert', url: 'https://broken.example', released: thisMonth }),
];

const FAKE_ENV = {
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  CRON_SECRET: 'cron-secret',
};

// insertStatus: tools 삽입 응답 코드, cronRunsStatus: cron_runs 삽입 응답 코드
async function withFakes({ insertStatus = () => 201, cronRunsStatus = 201 }, fn) {
  const calls = [];
  const logs = [];
  const real = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
  const realEnv = Object.fromEntries(Object.keys(FAKE_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FAKE_ENV);

  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    if (String(url).includes('api.anthropic.com')) {
      return json(200, {
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 5 } },
        content: [{ type: 'tool_use', name: 'propose_tools', input: { tools: PROPOSED } }],
      });
    }
    if (String(url).includes('/rest/v1/tools') && method === 'GET') {
      return json(200, KNOWN.map((t) => ({ ...t, description: '설명', is_published: true, source: 'manual' })));
    }
    if (String(url).includes('/rest/v1/tools')) {
      const status = insertStatus(body);
      return status < 300
        ? json(status)
        : json(status, { code: '23514', message: 'violates check constraint, key service-role-secret' });
    }
    if (String(url).includes('/rest/v1/cron_runs')) {
      return cronRunsStatus < 300
        ? json(cronRunsStatus)
        : json(cronRunsStatus, { code: 'PGRST205', message: "Could not find the table 'public.cron_runs'" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  console.log = console.warn = console.error = (line) => logs.push(String(line));

  try {
    return await fn({ calls, logs });
  } finally {
    globalThis.fetch = real.fetch;
    Object.assign(console, { log: real.log, warn: real.warn, error: real.error });
    for (const [k, v] of Object.entries(realEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const writes = (calls) => calls.filter((c) => c.method !== 'GET' && !c.url.includes('api.anthropic.com'));

test('runDiscovery: 후보마다 결과와 사유를 남기고 통과한 것만 삽입', async () => {
  await withFakes({ insertStatus: (body) => (body.name === 'Broken Insert' ? 400 : 201) }, async ({ calls, logs }) => {
    const run = await runDiscovery();

    assert.deepEqual(run.candidates.map((c) => [c.name, c.result]), [
      ['Fresh Tool', 'inserted'],
      ['gemini', 'duplicate'],
      ['Stale Tool', 'invalid'],
      ['Fresh Again', 'duplicate'], // 같은 실행에서 먼저 들어간 Fresh Tool과 URL이 겹친다
      ['Broken Insert', 'insert_error'],
    ]);
    assert.equal(run.proposed, 5);
    assert.equal(run.inserted, 1);
    assert.match(run.candidates[1].reason, /이름 일치: 기존 "Gemini"/);
    assert.match(run.candidates[3].reason, /URL 일치: 기존 "Fresh Tool"/);
    assert.match(run.candidates[4].reason, /^Supabase 400 .*violates check constraint/);

    // 후보 5개 전부 이름·URL·결과·사유가 로그에 남는다
    const candidateLogs = logs.filter((l) => l.includes('candidate #'));
    assert.equal(candidateLogs.length, 5);
    assert.match(candidateLogs[0], /name="Fresh Tool" url="https:\/\/fresh\.example" result=추가 reason=-/);
    assert.match(candidateLogs[1], /result=중복 reason=이름 일치/);
    assert.match(candidateLogs[2], /result=검증 탈락 reason=released/);
    assert.match(candidateLogs[4], /result=insert 에러 reason=Supabase 400/);
    // 키는 로그·사유 어디에도 나오지 않는다
    assert.ok(!logs.join('\n').includes('service-role-secret'));
    assert.ok(!JSON.stringify(run).includes('service-role-secret'));

    const inserts = writes(calls).filter((c) => c.url.endsWith('/rest/v1/tools'));
    assert.deepEqual(inserts.map((c) => c.body.name), ['Fresh Tool', 'Broken Insert']);
    assert.equal(inserts[0].body.is_published, false);

    const cronRun = writes(calls).find((c) => c.url.includes('/rest/v1/cron_runs'));
    assert.equal(cronRun.body.job, 'discover-tools');
    assert.equal(cronRun.body.proposed, 5);
    assert.equal(cronRun.body.inserted, 1);
    assert.equal(cronRun.body.results.length, 5);
  });
});

test('runDiscovery: cron_runs 테이블이 없어도 실패하지 않는다', async () => {
  await withFakes({ cronRunsStatus: 404 }, async ({ logs }) => {
    const run = await runDiscovery();
    assert.equal(run.inserted, 2);
    assert.ok(logs.some((l) => l.includes('cron_runs 기록 건너뜀: 404')));
  });
});

test('runDiscovery: dryRun은 DB에 아무것도 쓰지 않는다', async () => {
  await withFakes({}, async ({ calls }) => {
    const run = await runDiscovery({ dryRun: true });
    assert.deepEqual(writes(calls), []);
    assert.equal(run.inserted, 0);
    assert.deepEqual(run.candidates.map((c) => c.result), ['dry_run', 'duplicate', 'invalid', 'duplicate', 'dry_run']);
  });
});

test('handler: ?dryRun=1 은 쓰기 없이 후보 판정만 돌려준다', async () => {
  await withFakes({}, async ({ calls }) => {
    const response = {};
    const res = {
      status(code) { response.status = code; return this; },
      json(body) { response.body = body; return this; },
    };
    await handler({ headers: { authorization: 'Bearer cron-secret' }, query: { dryRun: '1' } }, res);
    assert.equal(response.status, 200);
    assert.equal(response.body.dryRun, true);
    assert.deepEqual(response.body.inserted, []);
    assert.deepEqual(response.body.skippedDuplicates, ['gemini', 'Fresh Again']);
    assert.equal(response.body.candidates.length, 5);
    assert.deepEqual(writes(calls), []);
  });
});
