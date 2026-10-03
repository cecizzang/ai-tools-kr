// 실행: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import linkifyModule from '../linkify.js';

const { splitLinks, linkify, EXTERNAL_REL } = linkifyModule;

const text = (value) => ({ type: 'text', text: value });
const link = (href, external = true, shown = href) => ({ type: 'link', href, text: shown, external });

test('일반 URL은 링크로', () => {
  assert.deepEqual(splitLinks('여기 보세요 https://example.com/path?a=1&b=2#top 좋아요'), [
    text('여기 보세요 '),
    link('https://example.com/path?a=1&b=2#top'),
    text(' 좋아요'),
  ]);
  assert.deepEqual(splitLinks('http://example.com'), [link('http://example.com')]);
  assert.deepEqual(splitLinks('HTTPS://Example.com/A'), [link('HTTPS://Example.com/A')]);
});

test('주소 끝 문장부호는 링크에서 뺌', () => {
  for (const tail of ['.', ',', '!', '?', ';', ':', '...', '?!', ').']) {
    assert.deepEqual(splitLinks(`보세요 https://example.com/a${tail}`), [
      text('보세요 '), link('https://example.com/a'), text(tail),
    ], `tail=${tail}`);
  }
  // 주소 중간의 문장부호는 그대로
  assert.deepEqual(splitLinks('https://example.com/a.b,c?d=e!f'), [link('https://example.com/a.b,c?d=e!f')]);
});

test('괄호는 짝이 맞을 때만 포함', () => {
  assert.deepEqual(splitLinks('(https://example.com/a)'), [
    text('('), link('https://example.com/a'), text(')'),
  ]);
  assert.deepEqual(splitLinks('https://en.wikipedia.org/wiki/Claude_(AI)'), [
    link('https://en.wikipedia.org/wiki/Claude_(AI)'),
  ]);
  assert.deepEqual(splitLinks('(참고: https://en.wikipedia.org/wiki/Claude_(AI))'), [
    text('(참고: '), link('https://en.wikipedia.org/wiki/Claude_(AI)'), text(')'),
  ]);
  assert.deepEqual(splitLinks('[https://example.com/a]'), [
    text('['), link('https://example.com/a'), text(']'),
  ]);
});

test('javascript:, data: 등 다른 스킴은 텍스트로', () => {
  for (const value of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'mailto:a@example.com',
    'www.example.com',
    'example.com/path',
  ]) {
    assert.deepEqual(splitLinks(value), [text(value)], value);
  }
});

test('주소처럼 보여도 링크로 못 만들면 텍스트로', () => {
  assert.deepEqual(splitLinks('https://'), [text('https://')]);
  assert.deepEqual(splitLinks('http://.'), [text('http://.')]);
  assert.deepEqual(splitLinks('https://exa mple.com'), [link('https://exa'), text(' mple.com')]);
});

test('HTML처럼 생긴 입력도 태그가 아니라 텍스트 조각', () => {
  assert.deepEqual(splitLinks('<img src=x onerror=alert(1)> <a href="https://evil.example">x</a>'), [
    text('<img src=x onerror=alert(1)> <a href="'),
    link('https://evil.example'),
    text('">x</a>'),
  ]);
});

test('한 줄에 URL 여러 개', () => {
  assert.deepEqual(splitLinks('https://a.example, https://b.example/x 그리고 https://c.example.'), [
    link('https://a.example'), text(', '), link('https://b.example/x'), text(' 그리고 '),
    link('https://c.example'), text('.'),
  ]);
});

test('URL 없는 텍스트는 그대로', () => {
  assert.deepEqual(splitLinks('그냥 글입니다.\n둘째 줄'), [text('그냥 글입니다.\n둘째 줄')]);
  assert.deepEqual(splitLinks(''), []);
  assert.deepEqual(splitLinks(null), []);
  assert.deepEqual(splitLinks(undefined), []);
});

test('줄바꿈은 텍스트 조각에 그대로 남음', () => {
  assert.deepEqual(splitLinks('첫 줄\nhttps://example.com\n\n셋째 줄'), [
    text('첫 줄\n'), link('https://example.com'), text('\n\n셋째 줄'),
  ]);
});

test('한글 조사가 붙어도 주소만 링크', () => {
  assert.deepEqual(splitLinks('https://example.com을 써보세요'), [
    link('https://example.com'), text('을 써보세요'),
  ]);
});

test('우리 사이트 링크는 내부, 나머지는 외부', () => {
  const [internal] = splitLinks('https://ai-tools-kr-rho.vercel.app/tools.html?category=image');
  assert.equal(internal.external, false);
  assert.equal(splitLinks('https://AI-TOOLS-KR-RHO.vercel.app/')[0].external, false);
  assert.equal(splitLinks('https://ai-tools-kr-rho.vercel.app.evil.example/')[0].external, true);
  assert.equal(splitLinks('https://evil.example/ai-tools-kr-rho.vercel.app')[0].external, true);
  assert.equal(splitLinks('https://ai-tools-kr-rho.vercel.app@evil.example/')[0].external, true);
});

test('긴 주소는 표시만 60자 + …, href는 원본', () => {
  const long = `https://example.com/${'a'.repeat(100)}`;
  const [part] = splitLinks(long);
  assert.equal(part.href, long);
  assert.equal(part.text, `${long.slice(0, 60)}…`);
  assert.equal(part.text.length, 61);

  const exact = `https://example.com/${'a'.repeat(40)}`; // 딱 60자
  assert.equal(exact.length, 60);
  assert.equal(splitLinks(exact)[0].text, exact);
});

// linkify는 DOM을 만든다 — 테스트에서는 필요한 만큼만 흉내 낸 가짜 document를 쓴다.
function fakeDocument() {
  const node = (props) => ({ children: [], appendChild(child) { this.children.push(child); }, ...props });
  return {
    createTextNode: (value) => ({ nodeType: 'text', value }),
    createElement: (tag) => node({ nodeType: 'element', tag }),
    container: () => node({ nodeType: 'element', tag: 'div', textContent: '이전 내용' }),
  };
}

test('linkify: 텍스트 노드와 <a>를 순서대로 붙이고 외부 링크만 새 탭', () => {
  const doc = fakeDocument();
  const el = doc.container();
  linkify(el, '외부 https://example.com/a. 내부 https://ai-tools-kr-rho.vercel.app/board.html\n끝', doc);

  assert.equal(el.textContent, '', '기존 내용을 비워야 함');
  assert.deepEqual(el.children.map((c) => c.nodeType), ['text', 'element', 'text', 'element', 'text']);
  assert.equal(el.children[0].value, '외부 ');
  assert.equal(el.children[2].value, '. 내부 ');
  assert.equal(el.children[4].value, '\n끝');

  const [, external, , internal] = el.children;
  assert.equal(external.tag, 'a');
  assert.equal(external.href, 'https://example.com/a');
  assert.equal(external.textContent, 'https://example.com/a');
  assert.equal(external.target, '_blank');
  assert.equal(external.rel, EXTERNAL_REL);
  assert.equal(EXTERNAL_REL, 'noopener noreferrer nofollow ugc');

  assert.equal(internal.href, 'https://ai-tools-kr-rho.vercel.app/board.html');
  assert.equal(internal.target, undefined, '내부 링크는 같은 탭');
  assert.equal(internal.rel, undefined);
});

test('linkify: javascript: 주소는 <a> 없이 텍스트 노드 하나', () => {
  const doc = fakeDocument();
  const el = doc.container();
  linkify(el, 'javascript:alert(1)', doc);
  assert.deepEqual(el.children, [{ nodeType: 'text', value: 'javascript:alert(1)' }]);
});
