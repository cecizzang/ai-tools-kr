import { LIMITS, validateLength, verifyPassword, hashIp, getClientIp, supabaseFetch } from './_lib.js';

// Edits record no new row in posts, so create.js's "any recent row from this IP"
// check has nothing to look at. Every attempt (including wrong passwords) is logged
// to its own table instead, which also slows down password guessing.
const ATTEMPTS_TABLE = 'board_edit_attempts';
export const EDIT_ATTEMPT_LIMIT = 5;
export const EDIT_ATTEMPT_WINDOW_SECONDS = 60;

async function isEditRateLimited(ipHash) {
  const since = new Date(Date.now() - EDIT_ATTEMPT_WINDOW_SECONDS * 1000).toISOString();
  const res = await supabaseFetch(
    `/rest/v1/${ATTEMPTS_TABLE}?ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=${EDIT_ATTEMPT_LIMIT}`
  );
  if (!res.ok) return false; // fail open on our own read error, same as isRateLimited
  const rows = await res.json();
  return Array.isArray(rows) && rows.length >= EDIT_ATTEMPT_LIMIT;
}

async function recordEditAttempt(ipHash) {
  try {
    const res = await supabaseFetch(`/rest/v1/${ATTEMPTS_TABLE}`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ ip_hash: ipHash }),
    });
    if (!res.ok) console.error(`board update: attempt log failed: ${res.status}`);
  } catch (e) {
    console.error(`board update: attempt log error: ${e.message}`);
  }
}

// Only a post's title and body can be edited — category, nickname and images stay
// as they were written, whatever else the request body carries.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { id, password, title, body } = req.body || {};

  if (typeof id !== 'string' || id.length === 0) {
    return res.status(400).json({ error: '요청이 올바르지 않습니다' });
  }
  if (typeof password !== 'string' || password.length === 0) {
    return res.status(400).json({ error: '비밀번호가 필요합니다' });
  }
  if (!validateLength(title, LIMITS.title)) {
    return res.status(400).json({ error: `제목은 ${LIMITS.title[0]}~${LIMITS.title[1]}자여야 합니다` });
  }
  if (!validateLength(body, LIMITS.postBody)) {
    return res.status(400).json({ error: `본문은 ${LIMITS.postBody[0]}~${LIMITS.postBody[1]}자여야 합니다` });
  }

  const ipHash = hashIp(getClientIp(req));
  if (await isEditRateLimited(ipHash)) {
    return res.status(429).json({ error: `잠시 후 다시 시도해주세요 (1분에 ${EDIT_ATTEMPT_LIMIT}번)` });
  }
  await recordEditAttempt(ipHash);

  const lookupRes = await supabaseFetch(`/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=password_hash`);
  if (!lookupRes.ok) {
    return res.status(500).json({ error: `조회 실패: ${lookupRes.status}` });
  }
  const [row] = await lookupRes.json();
  if (!row) {
    return res.status(404).json({ error: '게시물을 찾을 수 없습니다' });
  }

  if (!verifyPassword(password, row.password_hash)) {
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
