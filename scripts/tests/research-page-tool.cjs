const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// 회사 리서치 모델의 페이지 읽기 도구: https 인증서 오류 시 http 재시도, 봇 차단은 우회하지 않고 실패로, PDF는 WebFetch로.
const root = path.resolve(__dirname, '../..');
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const req = (id) => id === '@anthropic-ai/claude-agent-sdk' ? { createSdkMcpServer: (o) => o, tool: (name, description, schema, handler) => ({ name, handler }) }
    : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id);
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}
const { readResearchPage, isBlockedResearchHost, researchPageServer, READ_FAILED } = load('lib/research-page-tool.ts');

const response = (body, { status = 200, contentType = 'text/html; charset=utf-8', url } = {}) => ({
  ok: status >= 200 && status < 300, status, url, headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});
const certError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID', message: "Hostname/IP does not match certificate's altnames" } });
const page = `<html><head><title>페블즈자산운용</title></head><body><div id="header"><a href="/identity.php">회사소개</a><a href="/disclosure.php">경영공시</a><a href="https://other.example.com/">외부</a></div>
  <div id="content">${'숨은 가치와 리스크를 찾아내어 수익성과 안정성을 최대화합니다. '.repeat(6)}</div><div class="footer">저작권</div></body></html>`;

(async () => {
  // https가 인증서 오류면 http로 다시 읽고 그 사실을 적는다. 머리·바닥은 빼고 같은 사이트 링크는 남긴다.
  const tried = [];
  const viaHttp = await readResearchPage('https://www.pebbles.example.com/', { fetchImpl: async (url, init) => {
    tried.push(url);
    assert.match(init.headers['User-Agent'], /FindarResearch/, 'the tool identifies itself instead of posing as a browser');
    if (url.startsWith('https:')) throw certError();
    return response(page, { url });
  } });
  assert.deepEqual(tried, ['https://www.pebbles.example.com/', 'http://www.pebbles.example.com/']);
  assert.ok(!viaHttp.startsWith(READ_FAILED));
  assert.match(viaHttp, /주소: http:\/\/www\.pebbles\.example\.com\//);
  assert.match(viaHttp, /https 인증서 오류로 http로 읽었습니다/);
  assert.ok(viaHttp.includes('숨은 가치와 리스크') && !viaHttp.includes('저작권'));
  assert.ok(viaHttp.includes('- 경영공시: http://www.pebbles.example.com/disclosure.php') && !viaHttp.includes('other.example.com'));

  // 인증서가 아닌 연결 실패는 http로 재시도하지 않는다.
  let count = 0;
  const refused = await readResearchPage('https://down.example.com/', { fetchImpl: async () => { count++; throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(count, 1); assert.ok(refused.startsWith(READ_FAILED));

  // 봇 차단: 목록의 사이트는 요청조차 하지 않고, 403·챌린지 페이지는 우회하지 않고 실패로 돌려준다.
  assert.equal(isBlockedResearchHost('https://thevc.kr/pebblesinvestment'), true);
  assert.equal(isBlockedResearchHost('https://www.jobplanet.co.kr/companies/1'), true);
  assert.equal(isBlockedResearchHost('https://www.koreaap.com/'), false);
  const blocked = await readResearchPage('https://thevc.kr/pebblesinvestment', { fetchImpl: async () => assert.fail('blocked sites are not requested') });
  assert.ok(blocked.startsWith(READ_FAILED) && blocked.includes('검색 요약'));
  const forbidden = await readResearchPage('https://news.example.com/a', { fetchImpl: async (url) => response('', { url, status: 403 }) });
  assert.ok(forbidden.startsWith(READ_FAILED) && forbidden.includes('우회하지 말고'));
  const challenge = await readResearchPage('https://waf.example.com/a', { fetchImpl: async (url) => response('<script>window.awsWafCookieDomainList = []; window.gokuProps = {}</script>', { url, status: 202 }) });
  assert.ok(challenge.startsWith(READ_FAILED) && challenge.includes('봇 차단'));
  // 큰 일반 페이지에 reCAPTCHA 같은 단어가 있어도 차단으로 보지 않는다.
  const normal = await readResearchPage('https://normal.example.com/', { fetchImpl: async (url) => response(page.replace('</body>', `<p>${'본문 '.repeat(25000)}</p><script src="https://www.google.com/recaptcha/api.js"></script></body>`), { url }) });
  assert.ok(!normal.startsWith(READ_FAILED));

  // PDF는 WebFetch로 넘기고, 내부 주소·잘못된 주소는 요청하지 않는다.
  const pdf = await readResearchPage('https://rating.example.com/fileDown.do?fileName=a.pdf', { fetchImpl: async (url) => response('%PDF', { url, contentType: 'application/pdf' }) });
  assert.ok(pdf.startsWith(READ_FAILED) && pdf.includes('WebFetch'));
  for (const bad of ['http://192.168.0.1/', 'file:///etc/passwd', 'not a url'])
    assert.ok((await readResearchPage(bad, { fetchImpl: async () => assert.fail('must not fetch') })).startsWith(READ_FAILED));

  // MCP 서버는 read_page 하나만 내놓는다.
  const server = researchPageServer();
  assert.deepEqual(server.tools.map((t) => t.name), ['read_page']);
  console.log('PASS read_page: TLS → http fallback, self-identifying UA, chrome stripped with same-site links, blocked sites not requested, 403/challenge not bypassed, PDF handed to WebFetch, private hosts refused');
})().catch((error) => { console.error(error); process.exitCode = 1; });
