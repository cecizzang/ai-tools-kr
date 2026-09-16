import crypto from 'node:crypto';

export const LIMITS = {
  nickname: [2, 12],
  title: [2, 60],
  postBody: [2, 5000],
  commentBody: [1, 500],
  password: [4, 20],
};

export function validateLength(value, [min, max]) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max;
}

// Password hashing: scrypt with a random salt PER RECORD, stored as "salt:hash".
// A fresh salt each time is what makes this safe against rainbow tables.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = (stored || '').split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const candidate = crypto.scryptSync(password, salt, 64);
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// IP hashing: HMAC with a FIXED server secret (no per-record salt), so the same
// visitor always produces the same hash — required for the rate-limit lookups
// below to find "this IP's" recent rows. This is a different threat model than
// password hashing, which deliberately must NOT be reproducible without the salt.
export function hashIp(ip) {
  return crypto.createHmac('sha256', process.env.IP_HASH_SECRET).update(ip).digest('hex');
}

export function getClientIp(req) {
  const realIp = req.headers['x-real-ip'];
  if (realIp) return Array.isArray(realIp) ? realIp[0] : realIp;
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

export async function supabaseFetch(path, options = {}) {
  return fetch(`${process.env.SUPABASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      ...options.headers,
    },
  });
}

export async function isRateLimited(table, ipHash, windowSeconds) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const res = await supabaseFetch(
    `/rest/v1/${table}?ip_hash=eq.${encodeURIComponent(ipHash)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=1`
  );
  if (!res.ok) return false; // fail open on our own read error — don't block posting over a transient issue
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0;
}
