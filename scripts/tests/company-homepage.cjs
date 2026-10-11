const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');

// 회사 리서치가 먼저 읽는 회사 홈페이지: 주소 고르기, 내부 주소 차단, 본문 추출, EUC-KR 디코딩, http 재시도.
const mod = { exports: {} };
new Function('require', 'module', 'exports', ts.transpileModule(fs.readFileSync('lib/company-homepage.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(require, mod, mod.exports);
const { pickHomepageUrl, isPublicHost, extractHomepageText, fetchHomepage } = mod.exports;

// 채용 대행 주소와 형식이 틀린 값은 건너뛰고, 첫 홈페이지의 첫 화면을 고른다.
assert.equal(pickHomepageUrl(['https://acme.career.greetinghr.com/o/123', 'www.masteram.co.kr/recruit', 'https://other.example.com']), 'https://www.masteram.co.kr/');
assert.equal(pickHomepageUrl(['https://www.saramin.co.kr/zf_user/jobs', '']), null);
assert.equal(pickHomepageUrl(['http://localhost:3000', 'https://192.168.0.10/', 'http://127.0.0.1']), null);
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
  console.log('PASS homepage URL picking, private-host guard, text extraction, EUC-KR decoding, http fallback, cache');
})().catch((error) => { console.error(error); process.exitCode = 1; });
