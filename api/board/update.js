import {
  LIMITS,
  validateLength,
  verifyPassword,
  hashIp,
  getClientIp,
  supabaseFetch,
  ATTEMPT_LIMIT,
  ATTEMPT_WINDOW_SECONDS,
  checkAdminKey,
  isAttemptRateLimited,
  recordAttempt,
} from './_lib.js';

// Edits record no new row in posts, so create.js's "any recent row from this IP"
// check has nothing to look at. Every attempt (including wrong passwords and wrong
// admin keys) is logged to its own table instead, which also slows down guessing.
export const EDIT_ATTEMPT_LIMIT = ATTEMPT_LIMIT;
export const EDIT_ATTEMPT_WINDOW_SECONDS = ATTEMPT_WINDOW_SECONDS;

// Only a post's title and body can be edited — category, nickname and images stay
// as they were written, whatever else the request body carries.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { id, password, adminKey, title, body } = req.body || {};

  if (typeof id !== 'string' || id.length === 0) {
    return res.status(400).json({ error: '요청이 올바르지 않습니다' });
  }
  // 운영자 글은 글 비밀번호 대신 운영자 키(adminKey)로도 수정할 수 있다.
  const admin = checkAdminKey(adminKey);
  if (admin === 'none' && (typeof password !== 'string' || password.length === 0)) {
    return res.status(400).json({ error: '비밀번호가 필요합니다' });
  }
  if (!validateLength(title, LIMITS.title)) {
    return res.status(400).json({ error: `제목은 ${LIMITS.title[0]}~${LIMITS.title[1]}자여야 합니다` });
  }
  if (!validateLength(body, LIMITS.postBody)) {
    return res.status(400).json({ error: `본문은 ${LIMITS.postBody[0]}~${LIMITS.postBody[1]}자여야 합니다` });
  }

  const ipHash = hashIp(getClientIp(req));
  if (await isAttemptRateLimited(ipHash)) {
    return res.status(429).json({ error: `잠시 후 다시 시도해주세요 (1분에 ${EDIT_ATTEMPT_LIMIT}번)` });
  }
  await recordAttempt(ipHash);

  if (admin === 'denied') {
    return res.status(403).json({ error: '운영자 키가 올바르지 않습니다' });
  }

  const columns = admin === 'ok' ? 'is_official' : 'password_hash';
  const lookupRes = await supabaseFetch(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=${columns}`);
  if (!lookupRes.ok) {
    return res.status(500).json({ error: `조회 실패: ${lookupRes.status}` });
  }
  const [row] = await lookupRes.json();
  if (!row) {
    return res.status(404).json({ error: '게시물을 찾을 수 없습니다' });
  }

  if (admin === 'ok') {
    // 운영자 키로는 운영자 글만 고칠 수 있다 — 방문자 글은 여전히 그 글의 비밀번호가 필요하다.
    if (row.is_official !== true) {
      return res.status(403).json({ error: '운영자 키로는 운영자 글만 수정할 수 있습니다' });
    }
  } else if (!verifyPassword(password, row.password_hash)) {
    return res.status(403).json({ error: '비밀번호가 일치하지 않습니다' });
  }

  const updateRes = await supabaseFetch(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      title: title.trim(),
      body: body.trim(),
      updated_at: new Date().toISOString(),
    }),
  });

  if (!updateRes.ok) {
    return res.status(500).json({ error: `수정 실패: ${updateRes.status}` });
  }

  return res.status(200).json({ ok: true });
}
