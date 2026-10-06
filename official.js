// 운영자 글(posts.is_official) 표시에 쓰는 공통 함수.
// board.html·index.html·business.html에서는 <script src>로, 테스트에서는 Node 모듈로 불러 쓴다.
(function (root) {
  const OFFICIAL_LABEL = '운영자';

  // 운영자 글인지는 닉네임이 아니라 is_official 값으로만 판별한다 —
  // 닉네임은 누구나 "운영자"라고 적을 수 있다.
  function isOfficial(row) {
    return row?.is_official === true;
  }

  function officialBadge(doc = root.document) {
    const badge = doc.createElement('span');
    badge.className = 'official-badge';
    badge.textContent = OFFICIAL_LABEL;
    return badge;
  }

  // buildUrl(true)는 is_official을 쓰는 주소, buildUrl(false)는 안 쓰는 주소를 돌려준다.
  // 방문자에게 is_official 읽기 권한이 아직 없으면(supabase/official-posts.sql 실행 전) 요청이
  // 권한 오류로 실패하므로, 그때는 그 컬럼 없이 다시 읽어서 목록이 통째로 깨지지 않게 한다.
  async function fetchWithOfficial(buildUrl, request) {
    const res = await request(buildUrl(true));
    if (res.ok || ![400, 401, 403].includes(res.status)) return { res, officialAvailable: res.ok };
    return { res: await request(buildUrl(false)), officialAvailable: false };
  }

  const api = { OFFICIAL_LABEL, isOfficial, officialBadge, fetchWithOfficial };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OfficialPosts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
