const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 회사 리서치가 먼저 읽는 회사 홈페이지: 주소 고르기, 내부 주소 차단, 본문 추출, EUC-KR 디코딩, http 재시도.
const mod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('lib/company-homepage.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, mod, mod.exports);
const { homepageCandidates, emailDomainUrls, isPublicHost, extractHomepageText, redirectTarget, subpageLinks, fetchHomepage, findHomepage } = mod.exports;

// 채용 대행 주소와 형식이 틀린 값은 건너뛰고, 순서를 지키며 첫 화면(origin)만 남긴다.
assert.deepEqual(homepageCandidates(['https://acme.career.greetinghr.com/o/123', 'www.masteram.co.kr/recruit', 'https://www.masteram.co.kr', 'https://other.example.com']), ['https://www.masteram.co.kr/', 'https://other.example.com/']);
assert.deepEqual(homepageCandidates(['https://www.saramin.co.kr/zf_user/jobs', '', 'http://localhost:3000', 'https://192.168.0.10/', 'http://127.0.0.1']), []);
// 지원 이메일 도메인: 많이 나온 순, 개인 메일과 협회 주소는 뺀다.
assert.deepEqual(emailDomainUrls(['지원: kej1205@heungkuksec.co.kr', '문의 hr@heungkuksec.co.kr 또는 someone@gmail.com', 'help@kofia.or.kr', 'recruit@www.other.co.kr']),
  ['https://www.heungkuksec.co.kr/', 'https://heungkuksec.co.kr/', 'https://www.other.co.kr/']);
for (const host of ['localhost', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.1.1', 'intranet', 'printer.local', '::1'])
  assert.equal(isPublicHost(host), false, `${host} must be blocked`);
for (const host of ['www.masteram.co.kr', '8.8.8.8', '172.32.0.1'])
  assert.equal(isPublicHost(host), true, `${host} must be allowed`);

const body = '기업의 가치를 읽는 통찰. IPO 투자자문, 펀드운용, 투자일임. 일반 IPO펀드, 코스닥벤처펀드, 하이일드펀드를 운용합니다. '.repeat(4);
const html = `<html><head><title>마스터자산운용</title><meta name="description" content="IPO 중심 운용사"><script>alert('x')</script><style>p{}</style></head><body><nav>메뉴</nav><p>${body}</p><script>track()</script></body></html>`;
const extracted = extractHomepageText(html);
assert.equal(extracted.title, '마스터자산운용');
assert.ok(extracted.text.startsWith('IPO 중심 운용사'), 'meta description comes first');
assert.ok(extracted.text.includes('하이일드펀드') && !extracted.text.includes('alert') && !extracted.text.includes('track()'));
assert.ok(extractHomepageText(`<body>${'가'.repeat(9000)}</body>`).text.length <= 6000, 'text is capped');

const response = (bytes, { status = 200, contentType = 'text/html', url } = {}) => ({
  ok: status >= 200 && status < 300, status, url, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: async () => bytes,
});
const utf8 = (text) => new TextEncoder().encode(text).buffer;

// 흥국증권 첫 화면은 프레임셋으로 /index.do를 띄운다. meta refresh와 스크립트 이동도 따라간다.
assert.equal(redirectTarget('<frameset><frame name="blank" src=""><frame name="main" src="/index.do"></frameset>', 'https://www.heungkuksec.co.kr/'), 'https://www.heungkuksec.co.kr/index.do');
assert.equal(redirectTarget('<meta http-equiv="Refresh" content="0; url=/main/main.do">', 'https://a.example.com/'), 'https://a.example.com/main/main.do');
assert.equal(redirectTarget('<script>location.href = "/kor/index.jsp";</script>', 'https://b.example.com/'), 'https://b.example.com/kor/index.jsp');
assert.equal(redirectTarget('<p>본문</p>', 'https://c.example.com/'), null);
// 하위 페이지: 회사 정보 메뉴만, 같은 사이트만, 키워드 우선순위대로 최대 4개.
const menu = `<a href="/jsp/company/b_idea.jsp">회사개요</a><a href="/jsp/company/ceo02.jsp">CEO</a><a href="/company/announce/list.do">경영정보</a>
  <a href="/jsp/company/b_headquarters05.jsp">사업영역</a><a href="/research/list.do">리서치</a><a href="http://www.heungkuklife.co.kr">흥국생명 회사소개</a>
  <a href="/jsp/company/history.jsp">연혁</a><a href="/jsp/company/org.jsp">조직도</a><a href="javascript:void(0)">회사소개</a>`;
assert.deepEqual(subpageLinks(menu, 'https://www.heungkuksec.co.kr/index.do').map((l) => l.title), ['회사개요', '사업영역', '연혁', 'CEO']);
assert.ok(subpageLinks(menu, 'https://www.heungkuksec.co.kr/index.do').every((l) => l.url.startsWith('https://www.heungkuksec.co.kr/')));

(async () => {
  // EUC-KR 페이지는 meta charset을 보고 디코딩한다. ("운용" = BF EE BF EB)
  const eucKr = new Uint8Array([...new TextEncoder().encode(`<html><head><meta charset="euc-kr"><title>t</title></head><body>${'a'.repeat(250)}`), 0xbf, 0xee, 0xbf, 0xeb, ...new TextEncoder().encode('</body></html>')]).buffer;
  const decoded = await fetchHomepage('https://euc.example.com/', { fetchImpl: async (url) => response(eucKr, { url }) });
  assert.equal(decoded.status, 'ok');
  assert.ok(decoded.text.endsWith('운용'), `EUC-KR text must decode: ${decoded.text.slice(-10)}`);

  // https가 실패하면 http로 한 번 더 시도한다.
  const tried = [];
  const viaHttp = await fetchHomepage('https://fallback.example.com/', { fetchImpl: async (url) => {
    tried.push(url);
    if (url.startsWith('https:')) throw new Error('certificate has expired');
    return response(utf8(html), { url });
  } });
  assert.deepEqual(tried, ['https://fallback.example.com/', 'http://fallback.example.com/']);
  assert.equal(viaHttp.status, 'ok');
  assert.equal(viaHttp.url, 'http://fallback.example.com/');

  // 내부 주소로 이동하는 페이지, 스크립트로만 그리는 빈 페이지, HTML이 아닌 응답은 읽지 않는다.
  const redirected = await fetchHomepage('https://redirect.example.com/', { fetchImpl: async () => response(utf8(html), { url: 'http://10.0.0.5/admin' }) });
  assert.equal(redirected.status, 'unavailable');
  const empty = await fetchHomepage('https://spa.example.com/', { fetchImpl: async (url) => response(utf8('<html><body><div id="root"></div></body></html>'), { url }) });
  assert.equal(empty.status, 'unavailable');
  assert.match(empty.reason, /본문이 거의 없음/);
  const pdf = await fetchHomepage('https://pdf.example.com/', { fetchImpl: async (url) => response(utf8('%PDF'), { url, contentType: 'application/pdf' }) });
  assert.equal(pdf.status, 'unavailable');

  // 같은 주소는 잠시 재사용한다(개요·인재상 섹션이 연달아 읽는다).
  let count = 0;
  const counting = async (url) => { count++; return response(utf8(html), { url }); };
  await fetchHomepage('https://cache.example.com/', { fetchImpl: counting });
  await fetchHomepage('https://cache.example.com/', { fetchImpl: counting });
  assert.equal(count, 1);
  // 프레임셋 → 실제 첫 화면 → 회사 정보 하위 페이지(머리·메뉴·바닥 제외)를 읽어 페이지 이름을 붙여 합친다.
  const site = {
    'https://www.portal.example.com/': '<html><head><title>예시증권</title></head><frameset><frame src="/index.do"></frameset></html>',
    'https://www.portal.example.com/index.do': `<html><head><title>예시증권</title></head><body><div id="gnb">${menu.replaceAll('heungkuklife', 'other')}</div><p>${'최근 리포트 [2026.10.08] 산업분석 '.repeat(10)}</p><footer>서울특별시 영등포구 국제금융로2길 32</footer></body></html>`,
    'https://www.portal.example.com/jsp/company/b_idea.jsp': `<html><body><div class="header">메뉴 메뉴 메뉴</div><div id="skipToContent">스킵네비게이션</div><div id="content">2000년 설립된 투자매매·중개업 증권사입니다. <img src="v.gif" alt="고객을 존중하는 경영을 실천합니다."><img src="dot.gif" alt="점"> 기관 영업과 대체투자 상품에 강점이 있습니다.</div><div class="footer">저작권</div></body></html>`,
    'https://www.portal.example.com/jsp/company/b_headquarters05.jsp': '<html><body><div>IB, 리서치, 기관영업, Private Funds Group 등 사업부문을 운영합니다. 채권과 대체투자 중개를 합니다.</div></body></html>',
  };
  const crawled = await fetchHomepage('https://www.portal.example.com/', { fetchImpl: async (url) => site[url] ? response(utf8(site[url]), { url }) : response(utf8(''), { url, status: 404 }) });
  assert.equal(crawled.status, 'ok');
  assert.equal(crawled.url, 'https://www.portal.example.com/index.do');
  assert.ok(crawled.text.includes('국제금융로2길 32'), 'the root keeps its footer (address)');
  assert.ok(crawled.text.includes('[회사개요 — https://www.portal.example.com/jsp/company/b_idea.jsp]') && crawled.text.includes('2000년 설립된'));
  assert.ok(crawled.text.includes('[사업영역 — ') && crawled.text.includes('Private Funds Group'));
  assert.ok(!crawled.text.includes('메뉴 메뉴 메뉴') && !crawled.text.includes('저작권') && !crawled.text.includes('스킵네비게이션'), 'subpage header/footer/skip links are stripped');
  assert.ok(crawled.text.includes('고객을 존중하는 경영을 실천합니다.') && !crawled.text.includes(' 점 '), 'image alt sentences are read, short alts are dropped');
  assert.deepEqual(crawled.pages.map((p) => p.title), ['예시증권', '회사개요', '사업영역'], 'pages that failed to load are left out');

  // 후보를 차례로 시도해 처음 읽힌 홈페이지를 쓴다. 후보가 없으면 null.
  const order = [];
  const found = await findHomepage(['https://down.example.com', 'www.up.example.com'], { fetchImpl: async (url) => {
    order.push(url);
    return url.includes('up.example.com') ? response(utf8(html), { url }) : response(utf8(''), { url, status: 503 });
  } });
  assert.equal(found.status, 'ok');
  assert.equal(found.url, 'https://www.up.example.com/');
  assert.ok(order[0].startsWith('https://down.example.com'));
  assert.equal(await findHomepage([]), null);
  const allDown = await findHomepage(['https://gone.example.com'], { fetchImpl: async (url) => response(utf8(''), { url, status: 500 }) });
  assert.equal(allDown.status, 'unavailable');
  console.log('PASS homepage candidates (posting, email domain), private-host guard, frames/redirects, company subpages without site chrome, EUC-KR decoding, http fallback, candidate fallback, cache');
})().catch((error) => { console.error(error); process.exitCode = 1; });
