export const config = { maxDuration: 60 };

const COMPANIES = [
  { id: 'anthropic', name: 'Anthropic', queryBase: 'Anthropic Claude latest model release update' },
  { id: 'openai',    name: 'OpenAI',    queryBase: 'OpenAI GPT latest model release update' },
  { id: 'google',    name: 'Google DeepMind', queryBase: 'Google Gemini latest model release update' },
  { id: 'meta',      name: 'Meta AI',   queryBase: 'Meta AI Muse Llama latest model release update' },
  { id: 'mistral',   name: 'Mistral AI', queryBase: 'Mistral AI latest model release update' },
];

const MIN_SUMMARY_LENGTH = 20;
const MAX_SUMMARY_LINES = 3;
const DUPLICATE_WORD_OVERLAP = 0.6;
const MAX_ATTEMPTS = 2;
// Keep in sync with config.maxDuration above (Vercel reads that literal statically).
const MAX_DURATION_MS = 60_000;
// A search-backed Haiku call takes ~15–25s, so don't start a retry with less than this left.
const MIN_RETRY_TIME_LEFT_MS = 25_000;

const META_PHRASES = [
  '추가 검색', '검색이 필요', '확인이 필요', '확인하기 위해', '검색 결과', '검색해 보',
  '찾아보겠', '알려드리겠', '정보를 찾', 'Let me', 'I need', 'I will', "I'll",
];

const ENGLISH_FUNCTION_WORDS = /\b(the|and|of|is|are|was|were|has|have|with|for|its|to|in|on|by|from|that|this|parent|company|released|launched|announced|model)\b/g;

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A yearless date further ahead than this is taken as last year's (e.g. "(12/28)" seen in January).
const LAST_YEAR_THRESHOLD_MS = 60 * DAY_MS;

// "9월 2026년" → "2026년 9월"
export function fixDateOrder(text) {
  return text.replace(/(?<!\d)(\d{1,2})월\s*(\d{4})년/g, '$2년 $1월');
}

const DATE_TAG = /\(\d{1,2}\/\d{1,2}(?:,\s*\d{1,2}\/\d{1,2})?\)/g;

// Words of a line for duplicate detection: the (M/D) date tag and punctuation
// are ignored so "…강하다. (9/2)" and "…강하다" compare as the same words.
function lineWords(line) {
  return new Set(
    line
      .replace(DATE_TAG, ' ')
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean)
  );
}

// English/number tokens of a line (model names, versions) as a sorted key.
// Dates — the (M/D) tag and "2026년 9월 2일" — are left out, so two lines
// about the same model match even when only one of them spells out the date.
function lineModelKey(line) {
  const tokens = (
    line
      .replace(DATE_TAG, ' ')
      .replace(/\d+(?:년|월|일)/g, ' ')
      .toLowerCase()
      .match(/[a-z0-9.]+/g) || []
  )
    .map((t) => t.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean);
  return [...new Set(tokens)].sort().join(' ');
}

// A line is a duplicate only if it shares 60% of its words with an earlier
// line (measured against the shorter one) AND names the same models/versions,
// so "Claude Sonnet 5.5 출시" and "Claude Opus 5.5 출시" both stay.
function isDuplicateLine(a, b) {
  if (a.modelKey !== b.modelKey) return false;
  const smaller = Math.min(a.words.size, b.words.size);
  if (smaller === 0) return false;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w)) shared++;
  return shared >= smaller * DUPLICATE_WORD_OVERLAP;
}

export function cleanSummary(text) {
  const kept = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const entry = { line, words: lineWords(line), modelKey: lineModelKey(line) };
    if (kept.some((k) => isDuplicateLine(entry, k))) continue;
    kept.push(entry);
  }
  return kept.slice(0, MAX_SUMMARY_LINES).map((k) => k.line).join('\n');
}

// Returns a reason string if the summary should be rejected, or null if it's fine.
export function findSummaryProblem(text, now = new Date()) {
  const meta = META_PHRASES.find((p) => text.includes(p));
  if (meta) return `meta phrase: ${meta}`;

  const englishWords = text.match(ENGLISH_FUNCTION_WORDS) || [];
  if (englishWords.length >= 2) return `english words: ${englishWords.join(',')}`;

  // Dates without a year are read as this year (KST). Anything after KST tomorrow is rejected,
  // unless it's more than 60 days ahead — then it's really last year's date and passes.
  const kstNow = new Date(now.getTime() + KST_OFFSET_MS);
  const year = kstNow.getUTCFullYear();
  const today = Date.UTC(year, kstNow.getUTCMonth(), kstNow.getUTCDate());
  const limit = today + DAY_MS;

  const dates = [];
  for (const m of text.matchAll(/\((\d{1,2})\/(\d{1,2})(?:,\s*(\d{1,2})\/(\d{1,2}))?\)/g)) {
    dates.push([m[1], m[2]]);
    if (m[3]) dates.push([m[3], m[4]]);
  }
  for (const m of text.matchAll(/(?<!\d{4}년\s*)(?<!\d)(\d{1,2})월\s*(\d{1,2})일/g)) {
    dates.push([m[1], m[2]]);
  }
  for (const [month, day] of dates) {
    const date = Date.UTC(year, Number(month) - 1, Number(day));
    if (date > limit && date - today <= LAST_YEAR_THRESHOLD_MS) return `future date: ${month}/${day}`;
  }

  return null;
}

function buildSystemPrompt(todayKR) {
  return `You are a concise AI model release tracker.
오늘 날짜는 ${todayKR}입니다.
The user will ask about recent model releases and updates from a specific AI company.
Search the web and return a clear summary in Korean.

최근 30일 이내에 나온 소식을 우선적으로 찾아. 검색 결과에 날짜가 다른 여러 소식이 섞여 있으면,
그중 가장 최근 날짜를 기준으로 "지금 시점에 가장 최신인 모델/버전"이 무엇인지 다시 한번 확인한 뒤 답변해.
더 최신 버전이 이미 나왔는데 오래된 버전을 최신이라고 쓰지 마.

작성 규칙:
- 모든 문장은 한국어로 써. 회사명·모델명 같은 고유명사만 영어로 써도 돼.
- 검색 과정, "확인이 필요합니다", "추가 검색" 같은 메타 발언은 절대 쓰지 마. 결과 요약만 써.
- 1년 넘은 소식이나 오늘(${todayKR})보다 미래 날짜의 소식은 쓰지 마.
- 날짜를 글로 쓸 때 "9월 2026년" 같은 어순은 쓰지 말고 "2026년 9월"처럼 써.
- 파라미터 수 같은 큰 숫자는 쓰지 마.

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

async function fetchCompanySummary(company, now = new Date()) {
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

  // Only the text after the last web search is the answer; earlier text blocks
  // are Haiku narrating its search. Fall back to every text block if none follow.
  const lastSearchIndex = data.content.findLastIndex(
    (b) => b.type === 'server_tool_use' || b.type === 'web_search_tool_result'
  );
  let textBlocks = data.content.slice(lastSearchIndex + 1).filter((b) => b.type === 'text');
  if (textBlocks.length === 0) textBlocks = data.content.filter((b) => b.type === 'text');

  const text = cleanSummary(fixDateOrder(textBlocks.map((b) => b.text).join('')));

  console.log(`[${company.id}] content blocks=${data.content.map((b) => b.type).join(',')} extracted text length=${text.length}`);

  if (text.length < MIN_SUMMARY_LENGTH) {
    console.error(`[${company.id}] summary too short: length=${text.length} text=${JSON.stringify(text)}`);
    throw new Error(`summary too short (${text.length} chars)`);
  }

  const problem = findSummaryProblem(text, now);
  if (problem) {
    console.error(`[${company.id}] summary rejected: ${problem} text=${JSON.stringify(text)}`);
    throw new Error(`summary rejected (${problem})`);
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

// Retries a bad or failed summary once, if there's still time. Supabase errors aren't retried,
// and if every attempt fails nothing is saved, so the previous summary stays in place.
async function updateCompany(company, startedAt) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      const timeLeft = MAX_DURATION_MS - (Date.now() - startedAt);
      if (timeLeft < MIN_RETRY_TIME_LEFT_MS) {
        console.error(`[${company.id}] skipping retry: ${timeLeft}ms left`);
        break;
      }
    }
    let summary;
    try {
      summary = await fetchCompanySummary(company);
    } catch (err) {
      lastError = err;
      console.error(`[${company.id}] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
      continue;
    }
    await saveCompanyUpdate(company, summary);
    return company.id;
  }
  throw lastError;
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    COMPANIES.map((company) => updateCompany(company, startedAt))
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
