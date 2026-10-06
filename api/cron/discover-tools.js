import { findSummaryProblem } from './update-companies.js';

export const config = { maxDuration: 60 };

// 한 번 실행에 최대 이만큼만 신규 제안 — 비용 통제 + 스팸성 대량 삽입 방지.
const MAX_NEW_TOOLS_PER_RUN = 5;
// released가 이보다 오래된 툴은 "최근 툴"이 아니므로 저장하지 않는다.
const MAX_RELEASED_AGE_MONTHS = 12;

const CATEGORY_LABELS = {
  chat: '대화형 AI', writing: '글쓰기·번역', image: '이미지·디자인',
  media: '영상·음성', dev: '코딩·개발', automation: '자동화·업무', docs: '문서·회의',
};

const PROPOSE_TOOLS_TOOL = {
  name: 'propose_tools',
  description: '이번에 새로 발굴한 해외 AI 툴 목록을 구조화된 형태로 반환한다. 없으면 빈 배열.',
  input_schema: {
    type: 'object',
    properties: {
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '툴의 공식 명칭' },
            url: { type: 'string', description: '공식 웹사이트 URL (추측 금지, 실제 확인된 주소만)' },
            description: { type: 'string', description: '한국어 40자 안팎 한 문장. 과장 광고 문구 없이 핵심 기능만.' },
            category: { type: 'string', enum: Object.keys(CATEGORY_LABELS) },
            price: { type: 'string', enum: ['free', 'freemium', 'paid'] },
            korean: { type: 'string', enum: ['full', 'partial', 'none'], description: '한국어 UI/기능 지원 수준' },
            target: { type: 'string', enum: ['dev', 'biz', 'both'], description: '1인 개발자용인지 소상공인/1인사업자용인지' },
            released: { type: 'string', description: '출시 또는 마지막 주요 업데이트 연월. YYYY-MM 형식 (예: 2026-09)' },
          },
          required: ['name', 'url', 'description', 'category', 'price', 'korean', 'target', 'released'],
        },
      },
    },
    required: ['tools'],
  },
};

function buildSystemPrompt(todayKR, descriptionExamples) {
  const examples = descriptionExamples.length > 0
    ? `\n  기존 등록 툴의 description 예시 (이 길이와 톤에 맞춰라):\n${descriptionExamples.map((t) => `  - ${t.name}: ${t.description}`).join('\n')}`
    : '';

  return `너는 한국의 1인 개발자·소상공인·1인 사업자를 위한 해외 AI 툴 큐레이터다.
오늘 날짜는 ${todayKR}이다.

목표: 최근에 새로 나왔거나 최근 주목받기 시작한 해외(비한국) AI 툴 중에서,
이 타겟에게 실제로 쓸모 있을 만한 것만 골라 최대 ${MAX_NEW_TOOLS_PER_RUN}개까지 제안해라.

규칙:
- 최근 3개월 안에 출시됐거나 주요 업데이트가 있었던 툴을 우선해라. 이미 오래전부터 널리 알려진 툴은 후순위다.
- 빅테크(OpenAI, Google, Microsoft, Meta, Anthropic, Amazon, Apple 등)의 본체 서비스나 모델 자체는 제외해라.
  예: ChatGPT, Gemini, Veo, Copilot, Claude 같은 서비스·모델은 제안하지 마라.
- 이미 목록에 있다고 알려준 툴은 절대 다시 제안하지 마라.
- 실제로 검색으로 확인한, 접근 가능한 공식 URL만 써라. URL을 추측하지 마라.
- description은 한국어 40자 안팎의 한 문장으로, 과장이나 광고성 문구 없이 무슨 기능을 하는 툴인지만 정확히 써라.${examples}
- 가격 정보(price)는 검색으로 확인 안 되면 'freemium'으로 보수적으로 표시해라. 확신 없는 걸 'free'로 단정하지 마라.
- released에는 검색으로 확인한 출시 또는 마지막 주요 업데이트 연월을 YYYY-MM 형식으로 써라.
  연월을 확인하지 못했거나 ${MAX_RELEASED_AGE_MONTHS}개월보다 오래된 툴은 제안하지 마라.
- category/price/korean/target은 반드시 주어진 값 중 하나만 써라.
- 확신이 서는 후보가 ${MAX_NEW_TOOLS_PER_RUN}개보다 적으면 억지로 채우지 말고 그만큼만 반환해라. 없으면 빈 배열을 반환해라.
- 반드시 propose_tools 도구를 호출해서만 응답해라.`;
}

function buildUserPrompt(existingNames) {
  const existingList = existingNames.length > 0
    ? existingNames.map((n) => `- ${n}`).join('\n')
    : '(현재 등록된 툴 없음)';

  return `아래는 이미 사이트에 등록되어 있는 툴 목록이다 (등록 대기 중인 것 포함). 이 목록에 있는 건 절대 다시 제안하지 마라:
${existingList}

카테고리 참고: ${Object.entries(CATEGORY_LABELS).map(([k, v]) => `${k}=${v}`).join(', ')}

최근 새로 나왔거나 화제가 된 해외 AI 툴을 검색해서, 위 목록에 없는 것 중 한국 1인 개발자/소상공인에게 유용할 만한 걸 찾아 propose_tools로 반환해라.`;
}

async function fetchExistingTools() {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/tools?select=name,url,description,is_published,source&order=sort_order.asc`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`기존 tools 조회 실패: ${res.status} ${body}`);
  }
  return res.json();
}

function normalizeName(name) {
  return String(name || '').trim().toLowerCase();
}

// 여러 툴이 같은 호스트를 공유하는 곳 — 이 호스트들은 경로 앞 2단계까지 같아야 같은 툴로 본다
// (예: github.com/owner/repo).
const SHARED_HOSTS = new Set([
  'github.com', 'gitlab.com', 'huggingface.co', 'google.com', 'chromewebstore.google.com',
  'chrome.google.com', 'play.google.com', 'apps.apple.com', 'apps.microsoft.com',
  'marketplace.visualstudio.com', 'producthunt.com', 'notion.site', 'x.com', 'twitter.com',
]);

// 어느 툴에나 있는 하위 경로 — 이것만 다르면 같은 툴이다 (예: gemini.google.com/app).
const GENERIC_PATH_SEGMENTS = new Set([
  'app', 'home', 'index.html', 'pricing', 'plans', 'login', 'signin', 'signup', 'register',
  'download', 'downloads', 'features', 'about', 'docs', 'blog', 'dashboard', 'welcome',
  'en', 'ko', 'kr', 'ja', 'jp', 'zh', 'en-us', 'en-gb', 'ko-kr', 'ja-jp', 'zh-cn', 'intl',
]);

// 중복 판정용으로 URL을 호스트(www 제거)와 툴을 구분하는 경로 조각으로 나눈다.
function urlParts(url) {
  const raw = String(url || '').trim().toLowerCase();
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { host: raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''), path: [], shared: false };
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (!SHARED_HOSTS.has(host)) {
    return { host, path: segments.filter((seg) => !GENERIC_PATH_SEGMENTS.has(seg)), shared: false };
  }
  // 스토어류는 경로 앞 2단계가 모든 앱에 공통이라 (/us/app, /store/apps, /items) 앱 ID로 구분한다.
  const appId =
    parsed.searchParams.get('id') ||
    parsed.searchParams.get('itemname') ||
    segments.find((seg) => /^id\d+$/.test(seg));
  return { host, path: appId ? [appId] : segments.slice(0, 2), shared: true };
}

// 호스트가 같아도 경로가 서로 다른 제품을 가리키면 다른 툴이다 (예: adobe.com/products/firefly 와
// adobe.com/products/podcast). 한쪽 경로가 다른 쪽의 앞부분이면 같은 툴의 하위 페이지로 본다.
function isSameUrl(a, b) {
  if (!a.host || a.host !== b.host) return false;
  if (a.shared) return a.path.join('/') === b.path.join('/');
  if (a.path.length === 0 || b.path.length === 0) return a.path.length === b.path.length;
  const shorter = Math.min(a.path.length, b.path.length);
  return a.path.slice(0, shorter).join('/') === b.path.slice(0, shorter).join('/');
}

// 이미 있는 툴과 겹치면 어느 툴과 왜 겹치는지를, 아니면 null을 돌려준다.
// 이름은 대소문자·앞뒤 공백만 무시한 완전 일치로만 본다 (부분 일치는 쓰지 않는다).
export function findDuplicate(tool, knownTools) {
  const name = normalizeName(tool.name);
  const parts = urlParts(tool.url);
  for (const known of knownTools) {
    if (name && name === normalizeName(known.name)) return `이름 일치: 기존 "${known.name}"`;
    if (isSameUrl(parts, urlParts(known.url))) return `URL 일치: 기존 "${known.name}" (${known.url})`;
  }
  return null;
}

// 저장하면 안 되는 제안이면 이유 문자열을, 문제없으면 null을 돌려준다.
export function findToolProblem(tool, now = new Date()) {
  const released = String(tool.released ?? '');
  const m = released.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return `released 형식 오류: ${released}`;

  const [nowYear, nowMonth] = now
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
    .split('-')
    .map(Number);
  const ageMonths = (nowYear * 12 + nowMonth) - (Number(m[1]) * 12 + Number(m[2]));
  if (ageMonths > MAX_RELEASED_AGE_MONTHS) return `released ${ageMonths}개월 전: ${released}`;
  if (ageMonths < 0) return `released 미래 연월: ${released}`;

  // 회사 소식 요약과 같은 기준으로 메타 문구·영어 섞인 문장을 걸러낸다.
  const problem = findSummaryProblem(String(tool.description ?? ''), now);
  if (problem) return `description ${problem}`;

  return null;
}

function todayKST() {
  // YYYY-MM-DD (sv-SE 로케일이 ISO 형식으로 출력됨)
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// pause_turn 이어받기 + propose_tools 재촉을 합친 최대 요청 횟수.
const MAX_CLAUDE_REQUESTS = 4;
// 검색이 여러 번 도는 요청은 15~25초씩 걸리므로, 핸들러 시작 후 이 시간이 지나면 새 요청을 시작하지 않는다.
const CLAUDE_START_CUTOFF_MS = 30_000;
// 진행 중인 요청도 이 시점에 끊는다 — maxDuration(60s) 전에 Supabase 삽입과 응답까지 끝낼 여유를 남긴다.
const CLAUDE_HARD_DEADLINE_MS = 52_000;

async function callClaude(system, messages, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let data;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        system,
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
          PROPOSE_TOOLS_TOOL,
        ],
        // tool_choice를 propose_tools로 강제하면 web_search를 건너뛰고 바로 답해버린다.
        // auto로 두고 시스템 프롬프트로 propose_tools 호출을 유도한다.
        tool_choice: { type: 'auto' },
        messages,
      }),
    });
    // 본문 수신도 타임아웃 안에 포함되도록 try 안에서 읽는다.
    data = await response.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Anthropic 요청이 ${timeoutMs}ms 안에 끝나지 않아 중단함`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (data.error) {
    console.error(`discover-tools: Anthropic API error: status=${response.status} body=${JSON.stringify(data.error)}`);
    throw new Error(data.error.message);
  }
  return data;
}

async function proposeNewTools(existingTools, startedAt) {
  const now = new Date();
  const todayKR = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const existingNames = existingTools.map((t) => t.name);
  // 자동으로 들어온 문구가 다시 예시가 되면 톤이 점점 틀어지므로, 사람이 쓰고 발행한 것만 쓴다.
  const descriptionExamples = existingTools
    .filter((t) => t.is_published && t.source === 'manual' && t.description)
    .slice(0, 5);

  const system = buildSystemPrompt(todayKR, descriptionExamples);
  const messages = [{ role: 'user', content: buildUserPrompt(existingNames) }];
  let totalWebSearches = 0;

  for (let attempt = 1; attempt <= MAX_CLAUDE_REQUESTS; attempt++) {
    const elapsed = Date.now() - startedAt;
    if (elapsed > CLAUDE_START_CUTOFF_MS) {
      throw new Error(`시간 초과 — ${elapsed}ms 동안 propose_tools 응답을 받지 못함`);
    }

    const data = await callClaude(system, messages, CLAUDE_HARD_DEADLINE_MS - elapsed);
    const webSearches = data.usage?.server_tool_use?.web_search_requests ?? 0;
    totalWebSearches += webSearches;
    console.log(
      `discover-tools: request #${attempt} stop_reason=${data.stop_reason} ` +
      `web_search_requests=${webSearches} (total ${totalWebSearches}) ` +
      `input_tokens=${data.usage?.input_tokens} output_tokens=${data.usage?.output_tokens} ` +
      `elapsed=${Date.now() - startedAt}ms`
    );

    const toolUse = data.content.find((b) => b.type === 'tool_use' && b.name === 'propose_tools');
    if (toolUse) {
      const proposed = Array.isArray(toolUse.input?.tools) ? toolUse.input.tools : [];
      console.log(`discover-tools: Claude proposed ${proposed.length} tool(s) after ${totalWebSearches} web search(es)`);
      return proposed;
    }

    // 서버 쪽 web_search 루프가 중간에 멈춘 경우 — 응답을 그대로 붙여서 다시 보내면 이어서 진행한다.
    messages.push({ role: 'assistant', content: data.content });
    if (data.stop_reason !== 'pause_turn') {
      // 검색만 하고 텍스트로 끝낸 경우 — 결과를 propose_tools로 정리하라고 재촉한다.
      messages.push({
        role: 'user',
        content: '지금까지 검색한 결과를 바탕으로 propose_tools 도구를 호출해서 답해라. 확신 있는 후보가 없으면 빈 배열로 호출해라.',
      });
    }
  }

  throw new Error(`Claude가 ${MAX_CLAUDE_REQUESTS}번 요청 안에 propose_tools를 호출하지 않음`);
}

async function insertTool(tool) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/tools`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      name: tool.name,
      description: tool.description,
      url: tool.url,
      category: tool.category,
      price: tool.price,
      korean: tool.korean,
      target: tool.target,
      // 사람이 Supabase 대시보드에서 검토 후 is_published를 true로 바꾸기 전까지는
      // 사이트에 노출되지 않는다 — 기존 tools 테이블의 수동 큐레이션 원칙을 그대로 따름.
      is_published: false,
      source: 'auto',
      last_checked: todayKST(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${res.status} ${body}`);
  }
}

// 에러 메시지에 키가 섞여 나가지 않게 한다.
function redactSecrets(message) {
  let text = String(message);
  for (const secret of [process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.ANTHROPIC_API_KEY, process.env.CRON_SECRET]) {
    if (secret) text = text.split(secret).join('[REDACTED]');
  }
  return text;
}

const RESULT_LABELS = {
  inserted: '추가',
  dry_run: '추가 예정(드라이런)',
  duplicate: '중복',
  invalid: '검증 탈락',
  insert_error: 'insert 에러',
  over_limit: '한도 초과',
};

// 후보 하나를 저장해도 되는지 판정한다 — DB나 네트워크를 건드리지 않는다.
export function checkCandidate(tool, knownTools, now = new Date()) {
  if (!tool || typeof tool !== 'object') return { result: 'invalid', reason: '후보가 객체가 아님' };
  if (!String(tool.name ?? '').trim() || !String(tool.url ?? '').trim()) {
    return { result: 'invalid', reason: 'name 또는 url 없음' };
  }
  const duplicate = findDuplicate(tool, knownTools);
  if (duplicate) return { result: 'duplicate', reason: duplicate };
  const problem = findToolProblem(tool, now);
  if (problem) return { result: 'invalid', reason: problem };
  return { result: 'ok', reason: null };
}

// 실행 요약을 cron_runs에 남긴다 (supabase/cron-runs.sql). 테이블이 없거나 실패해도 크론은 계속된다.
async function recordCronRun(run) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/cron_runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ job: 'discover-tools', ...run }),
    });
    if (!res.ok) {
      console.warn(`discover-tools: cron_runs 기록 건너뜀: ${res.status} ${redactSecrets(await res.text())}`);
    }
  } catch (e) {
    console.warn(`discover-tools: cron_runs 기록 건너뜀: ${redactSecrets(e.message)}`);
  }
}

// 발굴 한 회차. dryRun이면 같은 흐름을 그대로 타되 DB에는 아무것도 쓰지 않는다 (tools 삽입, cron_runs 기록 모두 생략).
export async function runDiscovery({ dryRun = false, startedAt = Date.now() } = {}) {
  const existingTools = await fetchExistingTools();
  // 같은 실행 안에서 Claude가 같은 툴을 두 번 제안하는 것도 막도록, 통과한 후보를 여기에 더해 간다.
  const knownTools = existingTools.map((t) => ({ name: t.name, url: t.url }));

  const proposed = await proposeNewTools(existingTools, startedAt);
  const candidates = [];

  for (const [i, tool] of proposed.entries()) {
    const entry = { name: tool?.name ?? null, url: tool?.url ?? null };
    if (i >= MAX_NEW_TOOLS_PER_RUN) {
      Object.assign(entry, { result: 'over_limit', reason: `회차당 최대 ${MAX_NEW_TOOLS_PER_RUN}개` });
    } else {
      Object.assign(entry, checkCandidate(tool, knownTools));
      if (entry.result === 'ok') {
        if (dryRun) {
          entry.result = 'dry_run';
        } else {
          try {
            await insertTool(tool);
            entry.result = 'inserted';
          } catch (e) {
            entry.result = 'insert_error';
            entry.reason = redactSecrets(e.message);
          }
        }
        if (entry.result !== 'insert_error') knownTools.push({ name: tool.name, url: tool.url });
      }
    }
    console.log(
      `discover-tools: candidate #${i + 1} name=${JSON.stringify(entry.name)} url=${JSON.stringify(entry.url)} ` +
      `result=${RESULT_LABELS[entry.result]} reason=${entry.reason ?? '-'}`
    );
    candidates.push(entry);
  }

  const insertedCount = candidates.filter((c) => c.result === 'inserted').length;
  console.log(
    `discover-tools: done${dryRun ? ' (dry run)' : ''} existing=${existingTools.length} ` +
    `proposed=${proposed.length} inserted=${insertedCount}`
  );
  if (!dryRun) await recordCronRun({ proposed: proposed.length, inserted: insertedCount, results: candidates });

  return { dryRun, proposed: proposed.length, inserted: insertedCount, candidates };
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ?dryRun=1 이면 후보 판정까지만 하고 DB에는 쓰지 않는다.
  const dryRun = req.query?.dryRun === '1';

  try {
    const run = await runDiscovery({ dryRun, startedAt });
    const names = (result) => run.candidates.filter((c) => c.result === result).map((c) => c.name);
    const withReason = (result) =>
      run.candidates.filter((c) => c.result === result).map((c) => ({ name: c.name, reason: c.reason }));

    return res.status(200).json({
      dryRun,
      inserted: names('inserted'),
      skippedDuplicates: names('duplicate'),
      skippedInvalid: withReason('invalid'),
      failed: withReason('insert_error'),
      candidates: run.candidates,
    });
  } catch (e) {
    const message = redactSecrets(e.message);
    console.error(`discover-tools: ${message}`);
    if (!dryRun) await recordCronRun({ proposed: 0, inserted: 0, results: [], error: message });
    return res.status(500).json({ error: message });
  }
}
