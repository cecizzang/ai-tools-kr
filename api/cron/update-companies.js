export const config = { maxDuration: 60 };

const COMPANIES = [
  { id: 'anthropic', name: 'Anthropic', query: 'Anthropic Claude latest model release update 2026' },
  { id: 'openai',    name: 'OpenAI',    query: 'OpenAI GPT latest model release update 2026' },
  { id: 'google',    name: 'Google DeepMind', query: 'Google Gemini latest model release update 2026' },
  { id: 'meta',      name: 'Meta AI',   query: 'Meta Llama latest model release update 2026' },
  { id: 'mistral',   name: 'Mistral AI', query: 'Mistral AI latest model release update 2026' },
];

const MIN_SUMMARY_LENGTH = 20;

const systemPrompt = `You are a concise AI model release tracker.
The user will ask about recent model releases and updates from a specific AI company.
Search the web and return a clear, structured summary in Korean.

Do NOT use any markdown formatting — no **, #, -, or bullet symbols of any kind.
Write plain text only. Separate items using line breaks alone.

Include, each on its own line:
최신 모델명과 출시일
주요 특징/변경점 (한 줄에 하나씩, 줄바꿈으로 구분)
출처 링크 1~2개

Keep it short and factual. No fluff.`;

async function fetchCompanySummary(company) {
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
      system: systemPrompt,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [
        {
          role: 'user',
          content: `${company.name}의 최신 AI 모델 릴리즈와 업데이트 정보를 알려줘. 쿼리: ${company.query}`,
        },
      ],
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  const text = data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  if (text.length < MIN_SUMMARY_LENGTH) {
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
    throw new Error(`supabase upsert failed: ${res.status} ${await res.text()}`);
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
