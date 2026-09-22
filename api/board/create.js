import crypto from 'node:crypto';
import {
  LIMITS,
  validateLength,
  hashPassword,
  hashIp,
  getClientIp,
  supabaseFetch,
  isRateLimited,
  sniffImageType,
  supabaseStorageUpload,
  publicStorageUrl,
} from './_lib.js';

const CATEGORIES = ['free', 'dev', 'business'];

const IMAGE_BUCKET = 'post-images';
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB, applied to the decoded original the client sends

// Base64 inflates size by ~33%, and up to 4 images ride in one request body —
// raise Vercel's default (4.5mb) so a full 4x5MB batch has room before the
// per-image MAX_IMAGE_BYTES check below ever gets a chance to reject anything.
export const config = { api: { bodyParser: { sizeLimit: '28mb' } } };

// Accepts data URLs ("data:image/webp;base64,...") or bare base64 strings.
function decodeBase64Image(value) {
  if (typeof value !== 'string' || !value) return null;
  const commaIdx = value.indexOf(',');
  const base64 = value.startsWith('data:') && commaIdx !== -1 ? value.slice(commaIdx + 1) : value;
  try {
    return Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
}

// Uploads every image, sniffing+validating each one from its real bytes (never the
// client's claimed type). Throws on the first invalid image so the caller can 400
// before anything is written to storage or the posts table.
async function uploadPostImages(postId, images) {
  if (!Array.isArray(images) || images.length === 0) return [];
  if (images.length > MAX_IMAGES) {
    throw { status: 400, error: `이미지는 최대 ${MAX_IMAGES}장까지 첨부할 수 있습니다` };
  }

  const urls = [];
  for (let i = 0; i < images.length; i++) {
    const buffer = decodeBase64Image(images[i]);
    if (!buffer || buffer.length === 0) {
      throw { status: 400, error: '이미지 데이터를 읽을 수 없습니다' };
    }
    if (buffer.length > MAX_IMAGE_BYTES) {
      throw { status: 400, error: '이미지는 5MB를 초과할 수 없습니다' };
    }
    const detected = sniffImageType(buffer);
    if (!detected) {
      throw { status: 400, error: 'jpg, png, webp, gif 형식의 이미지만 첨부할 수 있습니다' };
    }

    const path = `${postId}/${i}.${detected.ext}`;
    const uploadRes = await supabaseStorageUpload(IMAGE_BUCKET, path, buffer, detected.mime);
    if (!uploadRes.ok) {
      throw { status: 500, error: `이미지 업로드 실패: ${uploadRes.status}` };
    }
    urls.push(publicStorageUrl(IMAGE_BUCKET, path));
  }
  return urls;
}

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
    const { category, title, body, images } = req.body;

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

    // Generated up front (instead of leaving it to the DB default) so uploaded
    // images can live under a path keyed by the post's own id before the row exists.
    const postId = crypto.randomUUID();

    let imageUrls = [];
    if (images) {
      try {
        imageUrls = await uploadPostImages(postId, images);
      } catch (err) {
        if (err && err.status) return res.status(err.status).json({ error: err.error });
        return res.status(500).json({ error: '이미지 업로드 중 오류가 발생했습니다' });
      }
    }

    const insertRes = await supabaseFetch('/rest/v1/posts', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        id: postId,
        category,
        nickname: nickname.trim(),
        title: title.trim(),
        body: body.trim(),
        image_urls: imageUrls,
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
