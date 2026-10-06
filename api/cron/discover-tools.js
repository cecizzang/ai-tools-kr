import { findSummaryProblem } from './update-companies.js';

export const config = { maxDuration: 60 };

// 한 회차에 최대 이만큼만 추가 — 비용 통제 + 스팸성 대량 삽입 방지.
const MAX_NEW_TOOLS_PER_RUN = 5;
// 카테고리 요청 하나가 내야 하는 후보 수.
const MIN_PROPOSALS_PER_CATEGORY = 2;
const MAX_PROPOSALS_PER_CATEGORY = 4;
// 카테고리 요청 하나가 쓸 수 있는 웹 검색 횟수.
const MAX_WEB_SEARCHES_PER_REQUEST = 5;
// released가 이보다 오래된 툴은 "최근 툴"이 아니므로 저장하지 않는다.
const MAX_RELEASED_AGE_MONTHS = 12;
// 출시된 지 이만큼이 안 된 툴은 사용자 근거(evidence)가 있어야 저장한다.
const MIN_LAUNCH_AGE_MONTHS = 6;
const MIN_EVIDENCE_LENGTH = 10;

const CATEGORY_LABELS = {
  chat: '대화형 AI', writing: '글쓰기·번역', image: '이미지·디자인',
  media: '영상·음성', dev: '코딩·개발', automation: '자동화·업무', docs: '문서·회의',
};
const CATEGORY_IDS = Object.keys(CATEGORY_LABELS);

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 이번 회차에 찾을 카테고리. 7개를 2주에 한 바퀴 돈다 — 한 주는 앞 4개, 다음 주는 뒤 3개.
// 주는 한국 시간 월요일에 바뀌므로 같은 주에 수동으로 다시 돌려도 같은 카테고리가 나온다.
export function categoriesForRun(now = new Date()) {
  const kstDay = Math.floor((now.getTime() + KST_OFFSET_MS) / DAY_MS);
  // 1970-01-01이 목요일이라 3일을 더해 월요일 시작으로 맞춘다.
  const week = Math.floor((kstDay + 3) / 7);
  return week % 2 === 0 ? CATEGORY_IDS.slice(0, 4) : CATEGORY_IDS.slice(4);
}

const PROPOSE_TOOLS_TOOL = {
  name: 'propose_tools',
  description: '이번 카테고리에서 새로 발굴한 AI 툴 목록을 구조화된 형태로 반환한다.',
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
            price: { type: 'string', enum: ['free', 'freemium', 'paid'] },
            korean: { type: 'string', enum: ['full', 'partial', 'none'], description: '한국어 UI/기능 지원 수준' },
            domestic: { type: 'boolean', description: '한국 회사가 만든 국내 서비스면 true' },
            target: { type: 'string', enum: ['dev', 'biz', 'both'], description: '1인 개발자용인지 소상공인/1인사업자용인지' },
            released: { type: 'string', description: '출시 또는 마지막 주요 업데이트 연월. YYYY-MM 형식 (예: 2026-09)' },
            launched: { type: 'string', description: '최초 출시 연월. YYYY-MM 형식. 확인하지 못했으면 빈 문자열' },
            evidence: { type: 'string', description: '실제 사용자가 있다는 근거를 한국어 한 문장으로 (사용자 수, 리뷰·평점, 투자 유치, 주요 매체 보도 등). 검색으로 확인하지 못했으면 빈 문자열' },
          },
          required: ['name', 'url', 'description', 'price', 'korean', 'domestic', 'target', 'released', 'launched', 'evidence'],
        },
      },
    },
    required: ['tools'],
  },
};

function buildSystemPrompt(todayKR) {
  return `너는 한국의 1인 개발자·소상공인·1인 사업자를 위한 AI 툴 큐레이터다.
오늘 날짜는 ${todayKR}이다.

목표: 사용자가 지정한 카테고리 하나에서, 한국 사용자가 지금 실제로 쓸 만한 AI 툴을 검색해
최소 ${MIN_PROPOSALS_PER_CATEGORY}개, 최대 ${MAX_PROPOSALS_PER_CATEGORY}개 제안해라.

규칙:
- 지정된 카테고리에 속하는 툴만 제안해라.
- 후보는 최소 ${MIN_PROPOSALS_PER_CATEGORY}개 이상 내라. 첫 검색에서 부족하면 검색어를 바꿔 다시 찾아라.
  그래도 아래 조건을 만족하는 툴이 ${MIN_PROPOSALS_PER_CATEGORY}개가 안 되면, 조건에 안 맞는 툴로 채우지 말고 찾은 만큼만 반환해라.
- 한국 사용자 기준으로 골라라. 한국어 UI·한국어 입출력을 지원하는 툴과 국내(한국) 서비스를 우선하고,
  조건이 비슷하면 그런 툴을 먼저 제안해라. 해외 툴은 한국에서 가입해 쓸 수 있는 것만 제안해라.
- 최근 ${MAX_RELEASED_AGE_MONTHS}개월 안에 출시됐거나 주요 업데이트가 있었던 툴만 제안해라.
  released에는 검색으로 확인한 출시 또는 마지막 주요 업데이트 연월을 YYYY-MM 형식으로 써라. 연월을 확인하지 못한 툴은 제안하지 마라.
- launched에는 최초 출시 연월을 YYYY-MM 형식으로 써라.
- 출시된 지 ${MIN_LAUNCH_AGE_MONTHS}개월이 안 된 툴은, 실제 사용자가 있다는 근거(공개된 사용자 수, 리뷰·평점, 투자 유치,
  주요 매체 보도 등)를 검색으로 확인한 경우에만 제안해라. 근거를 찾지 못한 신생 툴은 제안하지 마라.
- evidence에는 확인한 사용자 근거를 한국어 한 문장으로 써라. 확인하지 못했으면 지어내지 말고 빈 문자열로 둬라.
- 빅테크(OpenAI, Google, Microsoft, Meta, Anthropic, Amazon, Apple 등)의 본체 서비스나 모델 자체는 제외해라.
  예: ChatGPT, Gemini, Veo, Copilot, Claude 같은 서비스·모델은 제안하지 마라.
- 이미 목록에 있다고 알려준 툴은 절대 다시 제안하지 마라.
- 실제로 검색으로 확인한, 접근 가능한 공식 URL만 써라. URL을 추측하지 마라.
- description은 한국어 40자 안팎의 한 문장으로, 과장이나 광고성 문구 없이 무슨 기능을 하는 툴인지만 정확히 써라.
- 가격 정보(price)는 검색으로 확인 안 되면 'freemium'으로 보수적으로 표시해라. 확신 없는 걸 'free'로 단정하지 마라.
- price/korean/target은 반드시 주어진 값 중 하나만 써라.
- 반드시 propose_tools 도구를 호출해서만 응답해라.`;
}

function buildUserPrompt(category, categoryTools, descriptionExamples) {
  const existingList = categoryTools.length > 0
    ? categoryTools.map((t) => `- ${t.name} (${t.url})`).join('\n')
    : '(이 카테고리에 등록된 툴 없음)';
  const examples = descriptionExamples.length > 0
    ? `\n\ndescription 예시 (이 길이와 톤에 맞춰라):\n${descriptionExamples.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
    : '';

  return `이번 카테고리: ${category} (${CATEGORY_LABELS[category]})

아래는 이 카테고리에 이미 등록되어 있는 툴이다 (등록 대기 중인 것 포함). 이 목록에 있는 건 절대 다시 제안하지 마라:
${existingList}${examples}

이 카테고리에서 한국 1인 개발자·소상공인에게 유용한 AI 툴을 검색해서, 위 목록에 없는 것을 최소 ${MIN_PROPOSALS_PER_CATEGORY}개 propose_tools로 반환해라.`;
}

async function fetchExistingTools() {
  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/tools?select=name,url,description,category,is_published,source&order=sort_order.asc`,
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

// "YYYY-MM"이 지금(KST)으로부터 몇 개월 전인지. 형식이 틀리면 null.
function monthsAgo(yearMonth, now) {
  const m = String(yearMonth ?? '').match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!m) return null;
  const [nowYear, nowMonth] = now
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' })
    .split('-')
    .map(Number);
  return (nowYear * 12 + nowMonth) - (Number(m[1]) * 12 + Number(m[2]));
}

// 저장하면 안 되는 제안이면 이유 문자열을, 문제없으면 null을 돌려준다.
export function findToolProblem(tool, now = new Date()) {
  const released = String(tool.released ?? '');
  const ageMonths = monthsAgo(released, now);
  if (ageMonths === null) return `released 형식 오류: ${released}`;
  if (ageMonths > MAX_RELEASED_AGE_MONTHS) return `released ${ageMonths}개월 전: ${released}`;
  if (ageMonths < 0) return `released 미래 연월: ${released}`;

  // 신생 툴은 사용자 근거가 있어야 한다. 출시 연월을 모르면 신생 툴로 본다.
  const launchAge = monthsAgo(tool.launched, now);
  const isNew = launchAge === null || launchAge < MIN_LAUNCH_AGE_MONTHS;
  if (isNew && String(tool.evidence ?? '').trim().length < MIN_EVIDENCE_LENGTH) {
    return launchAge === null
      ? '출시 연월 미확인 + 사용자 근거 없음'
      : `출시 ${Math.max(launchAge, 0)}개월 + 사용자 근거 없음`;
  }

  // 회사 소식 요약과 같은 기준으로 메타 문구·영어 섞인 문장을 걸러낸다.
  const problem = findSummaryProblem(String(tool.description ?? ''), now);
  if (problem) return `description ${problem}`;

  return null;
}

function todayKST() {
  // YYYY-MM-DD (sv-SE 로케일이 ISO 형식으로 출력됨)
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// 카테고리 하나당 pause_turn 이어받기 + propose_tools 재촉을 합친 최대 요청 횟수.
const MAX_CLAUDE_REQUESTS = 3;
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
          { type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES_PER_REQUEST },
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
      const timeout = new Error(`요청이 ${timeoutMs}ms 안에 끝나지 않아 중단함`);
      timeout.name = 'TimeoutError';
      throw timeout;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }

  if (data.error) {
    throw new Error(`Anthropic ${response.status} ${data.error.message}`);
  }
  return data;
}

// 카테고리 하나를 검색해 후보를 받아 온다. 던지지 않고 결과(status: ok / skipped / error)로 돌려준다 —
// 한 카테고리가 실패하거나 시간이 모자라도 나머지 카테고리는 그대로 진행한다.
async function discoverCategory(category, existingTools, startedAt, system) {
  const outcome = {
    category, status: 'ok', reason: null, proposed: [],
    requests: 0, webSearches: 0, inputTokens: 0, outputTokens: 0,
  };
  const skip = (reason) => Object.assign(outcome, { status: 'skipped', reason });

  // 토큰을 줄이려고 기존 툴은 이 카테고리 것만 넘긴다. 다른 카테고리와의 중복은 삽입 전에 코드가 걸러낸다.
  const categoryTools = existingTools.filter((t) => t.category === category);
  // 자동으로 들어온 문구가 다시 예시가 되면 톤이 점점 틀어지므로, 사람이 쓰고 발행한 것만 쓴다.
  const isExample = (t) => t.is_published && t.source === 'manual' && t.description;
  let descriptionExamples = categoryTools.filter(isExample).slice(0, 3);
  if (descriptionExamples.length === 0) descriptionExamples = existingTools.filter(isExample).slice(0, 3);

  const messages = [{ role: 'user', content: buildUserPrompt(category, categoryTools, descriptionExamples) }];

  try {
    for (let attempt = 1; attempt <= MAX_CLAUDE_REQUESTS; attempt++) {
      const elapsed = Date.now() - startedAt;
      if (elapsed > CLAUDE_START_CUTOFF_MS) {
        skip(`시간 부족 — 시작 후 ${elapsed}ms, 요청 ${outcome.requests}회 뒤 생략`);
        break;
      }

      const data = await callClaude(system, messages, CLAUDE_HARD_DEADLINE_MS - elapsed);
      const webSearches = data.usage?.server_tool_use?.web_search_requests ?? 0;
      outcome.requests += 1;
      outcome.webSearches += webSearches;
      outcome.inputTokens += data.usage?.input_tokens ?? 0;
      outcome.outputTokens += data.usage?.output_tokens ?? 0;
      console.log(
        `discover-tools: [${category}] request #${attempt} stop_reason=${data.stop_reason} ` +
        `web_search_requests=${webSearches} input_tokens=${data.usage?.input_tokens} ` +
        `output_tokens=${data.usage?.output_tokens} elapsed=${Date.now() - startedAt}ms`
      );

      const toolUse = data.content.find((b) => b.type === 'tool_use' && b.name === 'propose_tools');
      if (toolUse) {
        outcome.proposed = Array.isArray(toolUse.input?.tools) ? toolUse.input.tools : [];
        break;
      }
      if (attempt === MAX_CLAUDE_REQUESTS) {
        throw new Error(`${MAX_CLAUDE_REQUESTS}번 요청 안에 propose_tools를 호출하지 않음`);
      }

      // 서버 쪽 web_search 루프가 중간에 멈춘 경우 — 응답을 그대로 붙여서 다시 보내면 이어서 진행한다.
      messages.push({ role: 'assistant', content: data.content });
      if (data.stop_reason !== 'pause_turn') {
        // 검색만 하고 텍스트로 끝낸 경우 — 결과를 propose_tools로 정리하라고 재촉한다.
        messages.push({
          role: 'user',
          content: '지금까지 검색한 결과를 바탕으로 propose_tools 도구를 호출해서 답해라.',
        });
      }
    }
  } catch (e) {
    if (e.name === 'TimeoutError') skip(`시간 부족 — ${e.message}`);
    else Object.assign(outcome, { status: 'error', reason: redactSecrets(e.message) });
  }

  console.log(
    `discover-tools: [${category}] status=${outcome.status} proposed=${outcome.proposed.length} ` +
    `requests=${outcome.requests} web_searches=${outcome.webSearches} reason=${outcome.reason ?? '-'}`
  );
  return outcome;
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

// 한 회차 추가 한도 안에서 먼저 넣을 후보를 정하는 점수 — 한국어 지원과 국내 서비스에 가산한다.
function koreanScore(tool) {
  const korean = { full: 2, partial: 1 }[tool?.korean] ?? 0;
  return korean + (tool?.domestic === true ? 1 : 0);
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

// 발굴 한 회차. 카테고리마다 따로, 동시에 요청한다.
// dryRun이면 같은 흐름을 그대로 타되 DB에는 아무것도 쓰지 않는다 (tools 삽입, cron_runs 기록 모두 생략).
export async function runDiscovery({ dryRun = false, startedAt = Date.now(), now = new Date(), categories = categoriesForRun(now) } = {}) {
  const existingTools = await fetchExistingTools();
  const system = buildSystemPrompt(now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' }));

  const outcomes = await Promise.all(
    categories.map((category) => discoverCategory(category, existingTools, startedAt, system))
  );

  // 후보를 한데 모아 한국어 지원·국내 서비스가 앞에 오게 한다 (같은 점수면 받은 순서 유지).
  const proposals = outcomes
    .flatMap((o) => o.proposed.map((tool) => ({
      category: o.category,
      tool: tool && typeof tool === 'object' ? { ...tool, category: o.category } : tool,
    })))
    .sort((a, b) => koreanScore(b.tool) - koreanScore(a.tool));

  // 같은 실행 안에서 같은 툴이 두 번 제안되는 것도 막도록, 통과한 후보를 여기에 더해 간다.
  const knownTools = existingTools.map((t) => ({ name: t.name, url: t.url }));
  const candidates = [];
  let accepted = 0;

  for (const [i, { category, tool }] of proposals.entries()) {
    const entry = {
      category,
      name: tool?.name ?? null,
      url: tool?.url ?? null,
      evidence: tool?.evidence || null,
      ...checkCandidate(tool, knownTools, now),
    };
    if (entry.result === 'ok' && accepted >= MAX_NEW_TOOLS_PER_RUN) {
      Object.assign(entry, { result: 'over_limit', reason: `회차당 최대 ${MAX_NEW_TOOLS_PER_RUN}개` });
    } else if (entry.result === 'ok') {
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
      if (entry.result !== 'insert_error') {
        accepted += 1;
        knownTools.push({ name: tool.name, url: tool.url });
      }
    }
    console.log(
      `discover-tools: candidate #${i + 1} category=${category} name=${JSON.stringify(entry.name)} ` +
      `url=${JSON.stringify(entry.url)} result=${RESULT_LABELS[entry.result]} reason=${entry.reason ?? '-'}`
    );
    candidates.push(entry);
  }

  const categorySummaries = outcomes.map(({ proposed, ...rest }) => ({ ...rest, proposed: proposed.length }));
  const insertedCount = candidates.filter((c) => c.result === 'inserted').length;
  // 후보를 못 받은 카테고리(시간 부족으로 생략 / 요청 실패)는 한 줄로도 남긴다.
  const categoryProblems = categorySummaries
    .filter((c) => c.status !== 'ok')
    .map((c) => `${c.category}: ${c.status} (${c.reason})`)
    .join('; ') || null;

  console.log(
    `discover-tools: done${dryRun ? ' (dry run)' : ''} categories=${categories.join(',')} ` +
    `existing=${existingTools.length} proposed=${proposals.length} inserted=${insertedCount} ` +
    `web_searches=${categorySummaries.reduce((n, c) => n + c.webSearches, 0)} ` +
    `input_tokens=${categorySummaries.reduce((n, c) => n + c.inputTokens, 0)} ` +
    `output_tokens=${categorySummaries.reduce((n, c) => n + c.outputTokens, 0)}`
  );
  if (!dryRun) {
    await recordCronRun({
      proposed: proposals.length,
      inserted: insertedCount,
      results: { categories: categorySummaries, candidates },
      error: categoryProblems,
    });
  }

  return { dryRun, categories: categorySummaries, proposed: proposals.length, inserted: insertedCount, candidates };
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
      categories: run.categories,
      inserted: names('inserted'),
      skippedDuplicates: names('duplicate'),
      skippedInvalid: withReason('invalid'),
      skippedOverLimit: names('over_limit'),
      failed: withReason('insert_error'),
      candidates: run.candidates,
    });
  } catch (e) {
    const message = redactSecrets(e.message);
    console.error(`discover-tools: ${message}`);
    if (!dryRun) {
      await recordCronRun({ proposed: 0, inserted: 0, results: { categories: [], candidates: [] }, error: message });
    }
    return res.status(500).json({ error: message });
  }
}
