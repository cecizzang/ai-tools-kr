// 사장님 모임(business.html) 화면에 쓰는 순수 함수와 고정 문구.
// business.html에서는 <script src>로, 테스트에서는 Node 모듈로 불러 쓴다.
(function (root) {
  const PREVIEW_LENGTH = 60;
  const RECOMMENDED_TOOL_COUNT = 6;
  // 사장님들의 글(운영자 글 제외)이 이보다 적으면 목록 아래에 "이런 글을 기다려요"를 보여 준다.
  const MIN_POSTS_WITHOUT_PROMPTS = 3;
  const TITLE_MAX_LENGTH = 60;

  const SHORTCUTS = [
    { label: '리뷰 답글 쓰기', hint: '손님 리뷰에 정중한 답글 초안', href: 'tools.html?category=chat' },
    { label: '홍보 이미지 만들기', hint: '메뉴판·전단·SNS용 이미지', href: 'tools.html?category=image' },
    { label: '숏폼 영상', hint: '릴스·쇼츠용 짧은 영상 편집', href: 'tools.html?category=media' },
  ];

  const PROMPTS = [
    '리뷰 답글, AI로 어떻게 쓰고 계세요?',
    '홍보 이미지 만들 때 쓰는 AI 추천해 주세요',
    'AI로 줄인 가게 일, 하나씩 공유해요',
  ];

  // 본문 첫 줄(빈 줄은 건너뜀)을 60자까지. 넘치면 말줄임표를 붙인다.
  function previewText(body, maxLength = PREVIEW_LENGTH) {
    const firstLine = String(body ?? '')
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .find(Boolean) || '';
    const chars = Array.from(firstLine);
    return chars.length > maxLength ? `${chars.slice(0, maxLength).join('').trimEnd()}…` : firstLine;
  }

  // 사장님 추천 툴: 사업자용(biz·both)이면서 한국어를 완전히 지원하는 발행된 툴, sort_order 순.
  function recommendedToolsUrl(supabaseUrl) {
    return `${supabaseUrl}/rest/v1/tools?select=name,description,category` +
      '&is_published=eq.true&target=in.(biz,both)&korean=eq.full' +
      `&order=sort_order.asc,created_at.desc&limit=${RECOMMENDED_TOOL_COUNT}`;
  }

  function toolLink(category) {
    return category ? `tools.html?category=${encodeURIComponent(category)}` : 'tools.html';
  }

  // 제목을 미리 채운 글쓰기 링크.
  function writeLink(title) {
    return `write.html?category=business&title=${encodeURIComponent(title)}`;
  }

  // write.html이 ?title= 값을 제목 칸에 넣기 전에 다듬는다.
  function prefillTitle(value) {
    return Array.from(String(value ?? '').replace(/\s+/g, ' ').trim()).slice(0, TITLE_MAX_LENGTH).join('');
  }

  function shouldShowPrompts(ownerPostCount) {
    return ownerPostCount < MIN_POSTS_WITHOUT_PROMPTS;
  }

  const api = {
    PREVIEW_LENGTH, RECOMMENDED_TOOL_COUNT, SHORTCUTS, PROMPTS,
    previewText, recommendedToolsUrl, toolLink, writeLink, prefillTitle, shouldShowPrompts,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BusinessPage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
