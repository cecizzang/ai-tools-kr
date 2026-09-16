import { verifyPassword, supabaseFetch } from './_lib.js';

const TABLES = { post: 'posts', comment: 'comments' };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다' });
  }

  const { type, id, password, adminSecret } = req.body || {};
  const table = TABLES[type];

  if (!table || typeof id !== 'string' || id.length === 0) {
    return res.status(400).json({ error: '요청이 올바르지 않습니다' });
  }

  const isAdmin = Boolean(adminSecret) && adminSecret === process.env.ADMIN_SECRET;

  if (!isAdmin) {
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ error: '비밀번호가 필요합니다' });
    }

    const lookupRes = await supabaseFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}&select=password_hash`);
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
  }

  const deleteRes = await supabaseFetch(`/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });

  if (!deleteRes.ok) {
    return res.status(500).json({ error: `삭제 실패: ${deleteRes.status}` });
  }

  return res.status(200).json({ ok: true });
}
