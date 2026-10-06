// 실행: node --test
// 중복 판정, 카테고리 순환, 그리고 카테고리별 요청 → 후보가 추가/중복/검증 탈락/insert 에러/한도 초과로
// 갈리는 전체 흐름을 검사한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import handler, { categoriesForRun, checkCandidate, findDuplicate, runDiscovery } from '../api/cron/discover-tools.js';

const NOW = new Date('2026-10-04T03:00:00Z');

const tool = (overrides = {}) => ({
  name: 'Example',
  url: 'https://example.com',
  description: '회의 녹음을 자동으로 요약해 주는 툴',
  price: 'freemium',
  korean: 'partial',
  domestic: false,
  target: 'both',
  released: '2026-09',
  launched: '2025-01',
  evidence: '',
  ...overrides,
});

const KNOWN = [
  { name: 'Gemini', url: 'https://gemini.google.com', category: 'chat' },
  { name: 'Perplexity', url: 'https://www.perplexity.ai/', category: 'chat' },
  { name: 'Adobe Firefly', url: 'https://www.adobe.com/products/firefly.html', category: 'image' },
  { name: 'Whisper', url: 'https://github.com/openai/whisper', category: 'media' },
  { name: 'Otter', url: 'https://apps.apple.com/us/app/otter-transcribe/id1276437113', category: 'docs' },
  { name: 'Lovable', url: 'https://lovable.dev/pricing', category: 'dev' },
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

test('categoriesForRun: 매주 3~4개씩, 2주에 7개 카테고리를 한 바퀴', () => {
  const monday = new Date('2026-10-05T03:00:00Z'); // 월요일 12:00 KST (크론 실행 시각)
  const weekA = categoriesForRun(monday);
  const weekB = categoriesForRun(new Date(monday.getTime() + 7 * 86_400_000));
  const weekC = categoriesForRun(new Date(monday.getTime() + 14 * 86_400_000));

  assert.deepEqual([weekA.length, weekB.length].sort(), [3, 4]);
  assert.deepEqual([...weekA, ...weekB].sort(), ['automation', 'chat', 'dev', 'docs', 'image', 'media', 'writing']);
  assert.deepEqual(weekC, weekA);
  // 같은 주(KST 월요일 00:00 ~ 일요일 23:59)에는 언제 돌려도 같은 카테고리
  assert.deepEqual(categoriesForRun(new Date('2026-10-04T15:00:00Z')), weekA); // 월 00:00 KST
  assert.deepEqual(categoriesForRun(new Date('2026-10-11T14:59:00Z')), weekA); // 일 23:59 KST
  assert.deepEqual(categoriesForRun(new Date('2026-10-11T15:00:00Z')), weekB); // 다음 주 월 00:00 KST
});

// ---- runDiscovery: fetch를 가짜로 바꿔 전체 흐름을 돌려 본다 ----

const thisMonth = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
const fresh = (name, overrides = {}) =>
  tool({ name, url: `https://${name.toLowerCase().replace(/\s+/g, '-')}.example`, released: thisMonth, ...overrides });

const FAKE_ENV = {
  SUPABASE_URL: 'https://db.example',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret',
  ANTHROPIC_API_KEY: 'anthropic-secret',
  CRON_SECRET: 'cron-secret',
};

// proposals: { 카테고리: 후보 배열 | 숫자(그 상태 코드로 Anthropic 에러) }
// insertStatus: tools 삽입 응답 코드, cronRunsStatus: cron_runs 삽입 응답 코드
async function withFakes({ proposals = {}, insertStatus = () => 201, cronRunsStatus = 201 }, fn) {
  const calls = [];
  const logs = [];
  const real = { fetch: globalThis.fetch, log: console.log, warn: console.warn, error: console.error };
  const realEnv = Object.fromEntries(Object.keys(FAKE_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, FAKE_ENV);

  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (String(url).includes('api.anthropic.com')) {
      const category = body.messages[0].content.match(/이번 카테고리: (\w+)/)[1];
      calls.push({ url: String(url), method, body, category });
      const answer = proposals[category] ?? [];
      if (typeof answer === 'number') {
        return json(answer, { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited, key anthropic-secret' } });
      }
      return json(200, {
        stop_reason: 'tool_use',
        usage: { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 5 } },
        content: [{ type: 'tool_use', name: 'propose_tools', input: { tools: answer } }],
      });
    }
    calls.push({ url: String(url), method, body });
    if (String(url).includes('/rest/v1/tools') && method === 'GET') {
      return json(200, KNOWN.map((t) => ({ ...t, description: `${t.name} 설명`, is_published: true, source: 'manual' })));
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

const claudeCalls = (calls) => calls.filter((c) => c.url.includes('api.anthropic.com'));
const writes = (calls) => calls.filter((c) => c.method !== 'GET' && !c.url.includes('api.anthropic.com'));
const cronRunOf = (calls) => writes(calls).find((c) => c.url.includes('/rest/v1/cron_runs'))?.body;

const MIXED = {
  dev: [fresh('Fresh Tool'), fresh('lovable', { url: 'https://elsewhere.example' })],
  image: [
    fresh('Stale Tool', { released: '2020-01' }),
    fresh('Fresh Again', { url: 'https://fresh-tool.example/app' }),
    fresh('Broken Insert'),
  ],
};

test('runDiscovery: 카테고리마다 따로 요청하고, 그 카테고리의 기존 툴(이름+URL)만 넘긴다', async () => {
  await withFakes({ proposals: MIXED }, async ({ calls }) => {
    await runDiscovery({ categories: ['dev', 'image'] });

    const requests = claudeCalls(calls);
    assert.deepEqual(requests.map((c) => c.category).sort(), ['dev', 'image']);
    for (const request of requests) {
      const search = request.body.tools.find((t) => t.name === 'web_search');
      assert.equal(search.max_uses, 5);
      assert.match(request.body.system, /최소 2개/);
      assert.match(request.body.system, /한국어 UI/);
      assert.match(request.body.system, /6개월이 안 된 툴/);
    }
    const prompt = (category) => requests.find((c) => c.category === category).body.messages[0].content;
    assert.match(prompt('dev'), /- Lovable \(https:\/\/lovable\.dev\/pricing\)/);
    assert.ok(!prompt('dev').includes('Adobe Firefly'));
    assert.ok(!prompt('dev').includes('Gemini'));
    assert.match(prompt('image'), /- Adobe Firefly \(https:\/\/www\.adobe\.com\/products\/firefly\.html\)/);
    assert.ok(!prompt('image').includes('lovable.dev'));
    assert.match(prompt('image'), /최소 2개/);
  });
});

test('runDiscovery: 후보마다 결과와 사유를 남기고 통과한 것만 삽입', async () => {
  await withFakes({ proposals: MIXED, insertStatus: (body) => (body.name === 'Broken Insert' ? 400 : 201) }, async ({ calls, logs }) => {
    const run = await runDiscovery({ categories: ['dev', 'image'] });

    assert.deepEqual(run.candidates.map((c) => [c.category, c.name, c.result]), [
      ['dev', 'Fresh Tool', 'inserted'],
      ['dev', 'lovable', 'duplicate'],
      ['image', 'Stale Tool', 'invalid'],
      ['image', 'Fresh Again', 'duplicate'], // 같은 실행에서 먼저 들어간 Fresh Tool과 URL이 겹친다
      ['image', 'Broken Insert', 'insert_error'],
    ]);
    assert.equal(run.proposed, 5);
    assert.equal(run.inserted, 1);
    assert.match(run.candidates[1].reason, /이름 일치: 기존 "Lovable"/);
    assert.match(run.candidates[3].reason, /URL 일치: 기존 "Fresh Tool"/);
    assert.match(run.candidates[4].reason, /^Supabase 400 .*violates check constraint/);

    // 후보 5개 전부 이름·URL·결과·사유가 로그에 남는다
    const candidateLogs = logs.filter((l) => l.includes('candidate #'));
    assert.equal(candidateLogs.length, 5);
    assert.match(candidateLogs[0], /category=dev name="Fresh Tool" url="https:\/\/fresh-tool\.example" result=추가 reason=-/);
    assert.match(candidateLogs[1], /result=중복 reason=이름 일치/);
    assert.match(candidateLogs[2], /result=검증 탈락 reason=released/);
    assert.match(candidateLogs[4], /result=insert 에러 reason=Supabase 400/);
    // 키는 로그·사유 어디에도 나오지 않는다
    assert.ok(!logs.join('\n').includes('service-role-secret'));
    assert.ok(!JSON.stringify(run).includes('service-role-secret'));

    // 삽입되는 행의 category는 모델이 아니라 요청한 카테고리로 정해진다
    const inserts = writes(calls).filter((c) => c.url.endsWith('/rest/v1/tools'));
    assert.deepEqual(inserts.map((c) => [c.body.name, c.body.category]), [['Fresh Tool', 'dev'], ['Broken Insert', 'image']]);
    assert.equal(inserts[0].body.is_published, false);

    const cronRun = cronRunOf(calls);
    assert.equal(cronRun.job, 'discover-tools');
    assert.equal(cronRun.proposed, 5);
    assert.equal(cronRun.inserted, 1);
    assert.equal(cronRun.error, null);
    assert.equal(cronRun.results.candidates.length, 5);
    assert.deepEqual(
      cronRun.results.categories.map((c) => [c.category, c.status, c.proposed, c.webSearches]),
      [['dev', 'ok', 2, 5], ['image', 'ok', 3, 5]]
    );
  });
});

test('runDiscovery: 한 회차에 추가는 최대 5개, 한국어 지원·국내 서비스 먼저', async () => {
  const proposals = {
    chat: [fresh('Chat A', { korean: 'none' }), fresh('Chat B', { korean: 'none' }), fresh('Chat C', { korean: 'full' }), fresh('Chat D', { korean: 'partial' })],
    docs: [fresh('Docs A', { korean: 'none' }), fresh('Docs B', { korean: 'full', domestic: true }), fresh('Docs C', { korean: 'partial' }), fresh('Docs D', { korean: 'none' })],
  };
  await withFakes({ proposals }, async ({ calls }) => {
    const run = await runDiscovery({ categories: ['chat', 'docs'] });

    assert.equal(run.proposed, 8);
    assert.equal(run.inserted, 5);
    const inserted = writes(calls).filter((c) => c.url.endsWith('/rest/v1/tools')).map((c) => c.body.name);
    assert.deepEqual(inserted, ['Docs B', 'Chat C', 'Chat D', 'Docs C', 'Chat A']);
    const overLimit = run.candidates.filter((c) => c.result === 'over_limit');
    assert.deepEqual(overLimit.map((c) => c.name), ['Chat B', 'Docs A', 'Docs D']);
    assert.match(overLimit[0].reason, /회차당 최대 5개/);
  });
});

test('runDiscovery: 출시 6개월 미만인데 사용자 근거가 없으면 탈락, 근거가 있으면 통과', async () => {
  const proposals = {
    dev: [
      fresh('New No Proof', { launched: thisMonth, evidence: '' }),
      fresh('New With Proof', { launched: thisMonth, evidence: '출시 한 달 만에 가입자 10만 명을 넘겼다고 발표' }),
      fresh('Old No Proof', { launched: '2024-01', evidence: '' }),
    ],
  };
  await withFakes({ proposals }, async () => {
    const run = await runDiscovery({ categories: ['dev'] });
    assert.deepEqual(run.candidates.map((c) => [c.name, c.result]), [
      ['New No Proof', 'invalid'],
      ['New With Proof', 'inserted'],
      ['Old No Proof', 'inserted'],
    ]);
    assert.match(run.candidates[0].reason, /^출시 0개월 \+ 사용자 근거 없음/);
    assert.match(run.candidates[1].evidence, /가입자 10만 명/);
  });
});

test('runDiscovery: 한 카테고리 요청이 실패해도 나머지는 진행하고 cron_runs에 남긴다', async () => {
  await withFakes({ proposals: { dev: 429, image: [fresh('Image One'), fresh('Image Two')] } }, async ({ calls, logs }) => {
    const run = await runDiscovery({ categories: ['dev', 'image'] });

    assert.equal(run.inserted, 2);
    const dev = run.categories.find((c) => c.category === 'dev');
    assert.equal(dev.status, 'error');
    assert.match(dev.reason, /^Anthropic 429 rate limited/);
    assert.ok(!JSON.stringify(run).includes('anthropic-secret'));
    assert.ok(!logs.join('\n').includes('anthropic-secret'));

    const cronRun = cronRunOf(calls);
    assert.match(cronRun.error, /^dev: error \(Anthropic 429/);
    assert.equal(cronRun.results.categories.find((c) => c.category === 'image').status, 'ok');
  });
});

test('runDiscovery: 남은 시간이 부족하면 카테고리 요청을 생략하고 cron_runs에 기록', async () => {
  await withFakes({ proposals: MIXED }, async ({ calls }) => {
    // 핸들러가 시작된 지 이미 31초가 지난 상황
    const run = await runDiscovery({ categories: ['dev', 'image'], startedAt: Date.now() - 31_000 });

    assert.deepEqual(claudeCalls(calls), []);
    assert.equal(run.proposed, 0);
    assert.deepEqual(run.categories.map((c) => c.status), ['skipped', 'skipped']);
    assert.match(run.categories[0].reason, /^시간 부족/);

    const cronRun = cronRunOf(calls);
    assert.equal(cronRun.inserted, 0);
    assert.match(cronRun.error, /dev: skipped \(시간 부족.*image: skipped \(시간 부족/);
  });
});

test('runDiscovery: cron_runs 테이블이 없어도 실패하지 않는다', async () => {
  await withFakes({ proposals: MIXED, cronRunsStatus: 404 }, async ({ logs }) => {
    const run = await runDiscovery({ categories: ['dev', 'image'] });
    assert.equal(run.inserted, 2);
    assert.ok(logs.some((l) => l.includes('cron_runs 기록 건너뜀: 404')));
  });
});

test('runDiscovery: dryRun은 DB에 아무것도 쓰지 않는다', async () => {
  await withFakes({ proposals: MIXED }, async ({ calls }) => {
    const run = await runDiscovery({ dryRun: true, categories: ['dev', 'image'] });
    assert.deepEqual(writes(calls), []);
    assert.equal(run.inserted, 0);
    assert.deepEqual(run.candidates.map((c) => c.result), ['dry_run', 'duplicate', 'invalid', 'duplicate', 'dry_run']);
  });
});

test('handler: 이번 주 카테고리로 요청하고, ?dryRun=1 은 쓰기 없이 후보 판정만 돌려준다', async () => {
  const everyCategory = Object.fromEntries(
    ['chat', 'writing', 'image', 'media', 'dev', 'automation', 'docs'].map((c) => [c, [fresh(`${c} one`), fresh(`${c} two`)]])
  );
  await withFakes({ proposals: everyCategory }, async ({ calls }) => {
    const response = {};
    const res = {
      status(code) { response.status = code; return this; },
      json(body) { response.body = body; return this; },
    };
    await handler({ headers: { authorization: 'Bearer cron-secret' }, query: { dryRun: '1' } }, res);

    assert.equal(response.status, 200);
    assert.equal(response.body.dryRun, true);
    const requested = claudeCalls(calls).map((c) => c.category).sort();
    assert.deepEqual(requested, [...categoriesForRun()].sort());
    assert.ok(requested.length === 3 || requested.length === 4);
    assert.deepEqual(response.body.categories.map((c) => c.category), categoriesForRun());
    assert.deepEqual(response.body.inserted, []);
    assert.equal(response.body.candidates.length, requested.length * 2);
    assert.equal(response.body.candidates.filter((c) => c.result === 'dry_run').length, 5);
    assert.equal(response.body.skippedOverLimit.length, requested.length * 2 - 5);
    assert.deepEqual(writes(calls), []);
  });
});
