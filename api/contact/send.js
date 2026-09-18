import { validateLength, hashIp, getClientIp, supabaseFetch, isRateLimited } from '../board/_lib.js';

const LIMITS = { message: [5, 2000] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { email, message, honeypot } = req.body || {};

  // Silently pretend success — never reveal to a bot that the honeypot caught it.
  if (honeypot) {
    return res.status(200).json({ ok: true });
  }

  if (email && (typeof email !== 'string' || !EMAIL_RE.test(email.trim()))) {
    return res.status(400).json({ error: '이메일 형식이 올바르지 않습니다' });
  }
  if (!validateLength(message, LIMITS.message)) {
    return res.status(400).json({ error: `문의 내용은 ${LIMITS.message[0]}~${LIMITS.message[1]}자여야 합니다` });
  }

  const ip = getClientIp(req);
  const ipHash = hashIp(ip);

  if (await isRateLimited('inquiries', ipHash, 60)) {
    return res.status(429).json({ error: '잠시 후 다시 시도해주세요 (1분에 1개)' });
  }

  const insertRes = await supabaseFetch('/rest/v1/inquiries', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      email: typeof email === 'string' && email.trim() ? email.trim() : null,
      message: message.trim(),
      ip_hash: ipHash,
    }),
  });

  if (!insertRes.ok) {
    return res.status(500).json({ error: `저장 실패: ${insertRes.status}` });
  }

  return res.status(200).json({ ok: true });
}
