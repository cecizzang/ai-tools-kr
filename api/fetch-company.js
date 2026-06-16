export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { companyName, query } = req.body;

  if (!companyName || !query) {
    return res.status(400).json({ error: 'companyName과 query가 필요합니다' });
  }

  const systemPrompt = `You are a concise AI model release tracker.
The user will ask about recent model releases and updates from a specific AI company.
Search the web and return a clear, structured summary in Korean.
Format:
- 최신 모델명과 출시일
- 주요 특징/변경점 (간결한 항목으로)
- 출처 링크 1~2개

Keep it short and factual. No fluff.`;

  try {
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
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `${companyName}의 최신 AI 모델 릴리즈와 업데이트 정보를 알려줘. 쿼리: ${query}`,
          },
        ],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const text = data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
