// 목록 페이지 넘김("이전 1 / 3 다음") 공통 계산.
// board.html·business.html에서는 <script src>로, 테스트에서는 Node 모듈로 불러 쓴다.
(function (root) {
  function totalPages(total, pageSize) {
    return Math.max(1, Math.ceil((Number(total) || 0) / pageSize));
  }

  // 넘길 페이지가 없으면(글이 없거나 한 페이지 이하) 페이지 넘김을 숨긴다.
  // 범위를 벗어난 페이지(?page=5)에 들어와 있을 때는 돌아갈 수 있게 그대로 보여 준다.
  function shouldShowPagination(page, total, pageSize) {
    return totalPages(total, pageSize) > 1 || page > 1;
  }

  const api = { totalPages, shouldShowPagination };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Pagination = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
