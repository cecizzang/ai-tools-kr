import crypto from 'node:crypto';
import { LIMITS, validateLength, hashPassword, hashIp, getClientIp, supabaseFetch, isRateLimited } from './_lib.js';

const CATEGORIES = ['free', 'dev'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { type, honeypot, nickname, password } = req.body || {};

  // Silently pretend success — never reveal to a bot that the honeypot caught it.
  if (honeypot) {
    return res.status(200).json({ id: crypto.randomUUID() });
  }

  if (type !== 'post' && type !== 'comment') {
    return res.status(400).json({ error: 'type이 올바르지 않습니다' });
  }

  if (!validateLength(nickname, LIMITS.nickname)) {
    return res.status(400).json({ error: `닉네임은 ${LIMITS.nickname[0]}~${LIMITS.nickname[1]}자여야 합니다` });
  }
  if (!validateLength(password, LIMITS.password)) {
    return res.status(400).json({ error: `비밀번호는 ${LIMITS.password[0]}~${LIMITS.password[1]}자여야 합니다` });
  }

  const ip = getClientIp(req);
  const ipHash = hashIp(ip);

  if (type === 'post') {
    const { category, title, body } = req.body;

    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'category가 올바르지 않습니다' });
    }
    if (!validateLength(title, LIMITS.title)) {
      return res.status(400).json({ error: `제목은 ${LIMITS.title[0]}~${LIMITS.title[1]}자여야 합니다` });
    }
    if (!validateLength(body, LIMITS.postBody)) {
      return res.status(400).json({ error: `본문은 ${LIMITS.postBody[0]}~${LIMITS.postBody[1]}자여야 합니다` });
    }

    if (await isRateLimited('posts', ipHash, 60)) {
      return res.status(429).json({ error: '잠시 후 다시 시도해주세요 (1분에 1개)' });
    }

    const insertRes = await supabaseFetch('/rest/v1/posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        category,
        nickname: nickname.trim(),
        title: title.trim(),
        body: body.trim(),
        password_hash: hashPassword(password),
        ip_hash: ipHash,
      }),
    });

    if (!insertRes.ok) {
      return res.status(500).json({ error: `저장 실패: ${insertRes.status}` });
    }

    const [row] = await insertRes.json();
    return res.status(200).json({ id: row.id });
  }

  // type === 'comment'
  const { postId, body } = req.body;

  if (typeof postId !== 'string' || postId.length === 0) {
    return res.status(400).json({ error: 'postId가 필요합니다' });
  }
  if (!validateLength(body, LIMITS.commentBody)) {
    return res.status(400).json({ error: `댓글은 ${LIMITS.commentBody[0]}~${LIMITS.commentBody[1]}자여야 합니다` });
  }

  if (await isRateLimited('comments', ipHash, 20)) {
    return res.status(429).json({ error: '잠시 후 다시 시도해주세요 (20초에 1개)' });
  }

  const insertRes = await supabaseFetch('/rest/v1/comments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      post_id: postId,
      nickname: nickname.trim(),
      body: body.trim(),
      password_hash: hashPassword(password),
      ip_hash: ipHash,
    }),
  });

  if (!insertRes.ok) {
    return res.status(500).json({ error: `저장 실패: ${insertRes.status}` });
  }

  const [row] = await insertRes.json();
  return res.status(200).json({ id: row.id });
}
