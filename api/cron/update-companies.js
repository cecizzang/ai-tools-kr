export const config = { maxDuration: 60 };

const COMPANIES = [
  { id: 'anthropic', name: 'Anthropic', queryBase: 'Anthropic Claude latest model release update' },
  { id: 'openai',    name: 'OpenAI',    queryBase: 'OpenAI GPT latest model release update' },
  { id: 'google',    name: 'Google DeepMind', queryBase: 'Google Gemini latest model release update' },
  { id: 'meta',      name: 'Meta AI',   queryBase: 'Meta Llama latest model release update' },
  { id: 'mistral',   name: 'Mistral AI', queryBase: 'Mistral AI latest model release update' },
  { id: 'xai',        name: 'xAI',        queryBase: 'xAI Grok latest model release update' },
  { id: 'deepseek',   name: 'DeepSeek',   queryBase: 'DeepSeek latest model release update' },
  { id: 'perplexity', name: 'Perplexity', queryBase: 'Perplexity AI latest model feature update' },
];

const MIN_SUMMARY_LENGTH = 20;

function buildSystemPrompt(todayKR) {
  return `You are a concise AI model release tracker.
오늘 날짜는 ${todayKR}입니다.
The user will ask about recent model releases and updates from a specific AI company.
Search the web and return a clear summary in Korean.

최근 30일 이내에 나온 소식을 우선적으로 찾아. 검색 결과에 날짜가 다른 여러 소식이 섞여 있으면,
그중 가장 최근 날짜를 기준으로 "지금 시점에 가장 최신인 모델/버전"이 무엇인지 다시 한번 확인한 뒤 답변해.
더 최신 버전이 이미 나왔는데 오래된 버전을 최신이라고 쓰지 마.

날짜 표기 규칙:
- 각 문장이 다루는 소식 자체에 날짜가 명시되어 있는 경우에만 그 문장 끝에 (M/D) 형식으로 표시해.
- 날짜를 모르면 표시하지 말고, 앞 문장에 쓴 날짜를 다른 소식에 재사용하지 마. 각 날짜는 그 소식에만 해당해.
- 연속된 문장이 같은 날짜를 다룬다면 날짜는 마지막 문장에만 한 번 표시하고 그 앞 문장들에는 쓰지 마.
- 문장 순서는 날짜와 무관하게 임의로 쓰지 말고, 날짜가 확인된 소식 중 가장 최근 날짜의 소식을 첫 문장에 배치해.

Do NOT use any markdown formatting — no **, #, -, or bullet symbols of any kind.
Do NOT use field labels or headings.
항목명이나 제목 쓰지 말고, 최신 소식 핵심만 3줄 이내 평문으로 작성해. 각 줄은 한 문장.
Separate lines using line breaks alone.

Keep it short and factual. No fluff.`;
}

async function fetchCompanySummary(company) {
  const now = new Date();
  const todayKR = now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
  const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const query = `${company.queryBase} ${yearMonth}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: buildSystemPrompt(todayKR),
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [
        {
          role: 'user',
          content: `${company.name}의 최신 AI 모델 릴리즈와 업데이트 정보를 알려줘. 쿼리: ${query}`,
        },
      ],
    }),
  });

  const data = await response.json();

  if (data.error) {
    console.error(`[${company.id}] Anthropic API error: status=${response.status} body=${JSON.stringify(data.error)}`);
    throw new Error(data.error.message);
  }

  // Merge every text block (Haiku can emit more than one, interleaved with
  // web_search tool_use/tool_result blocks) — never just the first one.
  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .replace(/\n{3,}/g, '\n')
    .trim();

  console.log(`[${company.id}] content blocks=${data.content.map((b) => b.type).join(',')} extracted text length=${text.length}`);

  if (text.length < MIN_SUMMARY_LENGTH) {
    console.error(`[${company.id}] summary too short: length=${text.length} text=${JSON.stringify(text)}`);
    throw new Error(`summary too short (${text.length} chars)`);
  }

  return text;
}

async function saveCompanyUpdate(company, summary) {
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/company_updates?on_conflict=company_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      company_id: company.id,
      company_name: company.name,
      summary,
      fetched_at: new Date().toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`[${company.id}] Supabase upsert failed: status=${res.status} body=${body}`);
    throw new Error(`supabase upsert failed: ${res.status} ${body}`);
  }
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const results = await Promise.allSettled(
    COMPANIES.map(async (company) => {
      const summary = await fetchCompanySummary(company);
      await saveCompanyUpdate(company, summary);
      return company.id;
    })
  );

  const updated = [];
  const failed = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      updated.push(result.value);
    } else {
      failed.push({ id: COMPANIES[i].id, reason: result.reason.message });
    }
  });

  return res.status(200).json({ updated, failed });
}
