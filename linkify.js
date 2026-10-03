// 게시판 본문·댓글 속 URL 자동 링크.
// innerHTML을 쓰지 않는다 — 텍스트를 조각내서 텍스트 노드와 <a> 요소를 DOM으로 직접 만든다.
// post.html에서는 <script src>로, 테스트에서는 Node 모듈로 불러 쓴다.
(function (root) {
  const SITE_HOST = 'ai-tools-kr-rho.vercel.app';
  const MAX_LINK_TEXT = 60;
  const EXTERNAL_REL = 'noopener noreferrer nofollow ugc';

  // http:// 또는 https://로 시작하는 것만 후보로 잡는다 (javascript:, data: 등은 애초에 안 걸림).
  // 한글 등 ASCII 밖 문자에서 끊어서 "https://example.com을" 같은 조사가 주소에 붙지 않게 한다.
  const URL_PATTERN = /https?:\/\/[^\s<>"'`\u0080-￿]+/gi;
  const TRAILING_PUNCTUATION = '.,!?;:';
  const BRACKET_PAIRS = { ')': '(', ']': '[', '}': '{' };

  function count(text, ch) {
    return text.split(ch).length - 1;
  }

  // 주소 끝의 문장부호는 뺀다. 닫는 괄호는 주소 안에서 짝이 맞을 때만 남긴다.
  function trimTrailing(url) {
    let end = url.length;
    while (end > 0) {
      const last = url[end - 1];
      const head = url.slice(0, end);
      if (TRAILING_PUNCTUATION.includes(last)) end--;
      else if (BRACKET_PAIRS[last] && count(head, last) > count(head, BRACKET_PAIRS[last])) end--;
      else break;
    }
    return url.slice(0, end);
  }

  function parseHttpUrl(candidate) {
    try {
      const url = new URL(candidate);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null;
    } catch {
      return null;
    }
  }

  // 텍스트를 { type: 'text', text } / { type: 'link', href, text, external } 조각으로 나눈다.
  function splitLinks(text, siteHost = SITE_HOST) {
    const source = String(text ?? '');
    const parts = [];
    let cursor = 0;
    const pushText = (value) => {
      if (!value) return;
      const prev = parts[parts.length - 1];
      if (prev && prev.type === 'text') prev.text += value;
      else parts.push({ type: 'text', text: value });
    };

    for (const match of source.matchAll(URL_PATTERN)) {
      const href = trimTrailing(match[0]);
      const url = parseHttpUrl(href);
      if (!url) continue; // 링크로 못 만들면 그대로 텍스트로 남긴다
      pushText(source.slice(cursor, match.index));
      parts.push({
        type: 'link',
        href,
        text: href.length > MAX_LINK_TEXT ? `${href.slice(0, MAX_LINK_TEXT)}…` : href,
        external: url.hostname.toLowerCase() !== siteHost,
      });
      cursor = match.index + href.length;
    }
    pushText(source.slice(cursor));
    return parts;
  }

  // el의 내용을 text로 바꾸되 URL은 <a>로 만든다. 줄바꿈은 텍스트 노드에 그대로 남는다(white-space: pre-wrap).
  function linkify(el, text, doc = root.document) {
    el.textContent = '';
    for (const part of splitLinks(text)) {
      if (part.type === 'text') {
        el.appendChild(doc.createTextNode(part.text));
        continue;
      }
      const a = doc.createElement('a');
      a.href = part.href;
      a.textContent = part.text;
      if (part.external) {
        a.target = '_blank';
        a.rel = EXTERNAL_REL;
      }
      el.appendChild(a);
    }
  }

  const api = { splitLinks, linkify, SITE_HOST, MAX_LINK_TEXT, EXTERNAL_REL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, { splitLinks, linkify });
})(typeof globalThis !== 'undefined' ? globalThis : this);
