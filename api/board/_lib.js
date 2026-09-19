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

// Sniff the real file type from its magic bytes — never trust a client-supplied
// extension or MIME string for this. Returns { mime, ext } or null if the buffer
// doesn't match any of the four types this board accepts.
const MAGIC_SIGNATURES = [
  { mime: 'image/jpeg', ext: 'jpg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: 'image/png',
    ext: 'png',
    check: (b) =>
      b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    mime: 'image/gif',
    ext: 'gif',
    check: (b) =>
      b.length >= 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    check: (b) =>
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
];

export function sniffImageType(buffer) {
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.check(buffer)) return { mime: sig.mime, ext: sig.ext };
  }
  return null;
}

// Storage uses a different auth surface (still service_role) but is NOT PostgREST,
// so it can't go through supabaseFetch (which hardcodes JSON headers). Body is a
// raw Buffer; contentType drives both the upload's Content-Type and, since Supabase
// Storage derives its own served content-type from what was set at upload time,
// what browsers will later receive when loading the public URL.
export async function supabaseStorageUpload(bucket, path, buffer, contentType) {
  return fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'false',
    },
    body: buffer,
  });
}

export async function supabaseStorageDelete(bucket, paths) {
  if (!paths.length) return { ok: true };
  return fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${bucket}`, {
    method: 'DELETE',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prefixes: paths }),
  });
}

export function publicStorageUrl(bucket, path) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

// Reverse of publicStorageUrl — needed at delete time, since posts only store the
// public URL, not the raw storage path.
export function storagePathFromPublicUrl(bucket, url) {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  return idx === -1 ? null : url.slice(idx + marker.length);
}
