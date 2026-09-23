export const config = { maxDuration: 60 };

// 한 번 실행에 최대 이만큼만 신규 제안 — 비용 통제 + 스팸성 대량 삽입 방지.
const MAX_NEW_TOOLS_PER_RUN = 5;

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
          },
          required: ['name', 'url', 'description', 'category', 'price', 'korean', 'target'],
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

// 여러 툴이 같은 호스트를 공유하는 곳 — 호스트만 비교하면 서로 다른 툴까지 중복으로 막히므로
// 이 호스트들은 앞쪽 경로 2단계까지 비교한다 (예: github.com/owner/repo).
const SHARED_HOSTS = new Set([
  'github.com', 'gitlab.com', 'huggingface.co', 'google.com', 'chromewebstore.google.com',
  'chrome.google.com', 'play.google.com', 'apps.apple.com', 'apps.microsoft.com',
  'marketplace.visualstudio.com', 'producthunt.com', 'notion.site', 'x.com', 'twitter.com',
]);

// 중복 판정용 키 — 보통은 호스트(www 제거)만 쓰고, 공용 호스트는 경로 앞 2단계까지 붙인다.
// 같은 서비스의 /app, /pricing 같은 하위 경로 URL도 같은 툴로 잡힌다 (예: gemini.google.com/app).
function urlKey(url) {
  const raw = String(url || '').trim().toLowerCase();
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`);
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (!SHARED_HOSTS.has(host)) return host;
  const segments = parsed.pathname.split('/').filter(Boolean).slice(0, 2);
  return [host, ...segments].join('/');
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
    throw new Error(`삽입 실패 (${tool.name}): ${res.status} ${body}`);
  }
}

export default async function handler(req, res) {
  const startedAt = Date.now();
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const existingTools = await fetchExistingTools();
    const existingNameSet = new Set(existingTools.map((t) => normalizeName(t.name)));
    const existingUrlKeySet = new Set(existingTools.map((t) => urlKey(t.url)));

    const proposed = await proposeNewTools(existingTools, startedAt);

    const inserted = [];
    const skippedDuplicates = [];
    const failed = [];

    for (const tool of proposed.slice(0, MAX_NEW_TOOLS_PER_RUN)) {
      const isDuplicate =
        existingNameSet.has(normalizeName(tool.name)) || existingUrlKeySet.has(urlKey(tool.url));

      if (isDuplicate) {
        skippedDuplicates.push(tool.name);
        continue;
      }

      try {
        await insertTool(tool);
        inserted.push(tool.name);
        // 같은 실행 안에서 Claude가 비슷한 이름/URL을 중복 제안하는 것도 막는다.
        existingNameSet.add(normalizeName(tool.name));
        existingUrlKeySet.add(urlKey(tool.url));
      } catch (e) {
        console.error(`discover-tools: insert failed for ${tool.name}: ${e.message}`);
        failed.push({ name: tool.name, reason: e.message });
      }
    }

    return res.status(200).json({ inserted, skippedDuplicates, failed });
  } catch (e) {
    console.error(`discover-tools: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
}
