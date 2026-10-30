const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-company-watch-test-'));
const modules = new Map();

function load(relative) {
  const filename = path.resolve(root, relative);
  if (modules.has(filename)) return modules.get(filename).exports;
  const mod = { exports: {} };
  modules.set(filename, mod);
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  function req(id) {
    if (id.startsWith('@/')) return load(id.slice(2) + '.ts');
    if (id.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts')));
    return require(id);
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

// 페이지 묶음으로 만든 가짜 요청 함수(실제 사이트에 요청하지 않는다). redirects는 첫 화면 이동을 흉내 낸다.
function fakeFetcher(pages, redirects = {}) {
  const requested = [];
  return {
    requested,
    async text(url) {
      requested.push(url);
      const finalUrl = redirects[url] ?? url;
      if (!(finalUrl in pages)) throw new (load('lib/watch-fetch.ts').WatchFetchError)(`HTTP 404 ${finalUrl}`);
      const page = pages[finalUrl];
      if (page instanceof Error) throw page;
      return { url: finalUrl, text: page };
    },
  };
}

function nextDataPage(queries) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { dehydratedState: { queries } } } })}</script></body></html>`;
}

(async () => {
  process.chdir(scratch);
  const { parseRobots, robotsAllows, WatchBlockedError } = load('lib/watch-fetch.ts');
  const { companyKey, titleKey, titleSimilarity, duplicateReason } = load('lib/job-dedup.ts');
  const { greetingAdapter, saraminAtsAdapter, recruiterAppsiteAdapter, pageWatchAdapter, endpointAdapter, workdayAdapter, tossCareerAdapter, isPostLink, rowDates, periodEnd, htmlToText } = load('lib/watch-adapters.ts');
  const { jobSource, postingLink, isWatchSeq, isKofiaSeq } = load('lib/job-source.ts');

  // robots.txt: 가장 긴 규칙이 이긴다(recruiter.co.kr 구형 테넌트는 Disallow: / 뒤에 Allow: /appsite/).
  const recruiter = parseRobots('User-agent: *\nDisallow: /\nAllow: /appsite/\n');
  assert.equal(robotsAllows(recruiter, '/appsite/company/getMainView'), true);
  assert.equal(robotsAllows(recruiter, '/app/jobnotice/list'), false);
  // 그리팅: 지원서 작성만 막는다. ClaudeBot 그룹은 이 도구에 적용되지 않는다.
  const greetingRobots = parseRobots('User-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\nDisallow: /o/*/apply\nDisallow: /ko/o/*/apply\nDisallow: /m/*\n');
  assert.equal(robotsAllows(greetingRobots, '/ko/o/235042'), true);
  assert.equal(robotsAllows(greetingRobots, '/ko/o/235042/apply'), false);
  assert.equal(robotsAllows(greetingRobots, '/'), true);
  // 이 도구 이름의 그룹이 있으면 그것을 쓴다. 빈 Disallow는 모두 허용.
  assert.equal(robotsAllows(parseRobots('User-agent: FindarResearch\nDisallow: /jobs\n\nUser-agent: *\nDisallow:\n'), '/jobs/1'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow:\n'), '/anything'), true);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.asp$\n'), '/a/index.asp'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /*.asp$\n'), '/a/index.asp?x=1'), true);

  // 출처 판정과 원문 링크.
  assert.equal(jobSource('42872'), 'kofia');
  assert.equal(jobSource('manual-abc'), 'manual');
  assert.equal(jobSource('greeting-242026'), 'greeting');
  assert.equal(jobSource('saraminats-ksd-3942'), 'saraminAts');
  assert.equal(isWatchSeq('greeting-1'), true);
  assert.equal(isWatchSeq('manual-1'), false);
  assert.equal(isKofiaSeq('42872'), true);
  assert.equal(postingLink({ seq: 'greeting-1', siteUrl: 'https://careers.kait.com/ko/o/1' }), 'https://careers.kait.com/ko/o/1');
  assert.equal(postingLink({ seq: '42872', siteUrl: 'https://kispricing.career.greetinghr.com' }), 'https://www.kofia.or.kr/brd/m_96/view.do?seq=42872');

  // 중복 판정 — 실제로 겹친 두 건.
  const kisKofia = { seq: '42872', company: 'KIS자산평가', title: '[KIS자산평가] 금융컨설팅본부 솔루션실 신입/경력(1년 이상) 채용 공고', deadline: '2026-11-06', url: 'https://kispricing.career.greetinghr.com/ko/home' };
  const kisGreeting = { seq: 'greeting-242026', company: 'KIS자산평가', title: '[KIS자산평가] 금융컨설팅본부 솔루션실 신입/경력 채용 공고', deadline: '2026-11-06', url: 'https://kispricing.career.greetinghr.com/ko/o/242026' };
  assert.equal(duplicateReason(kisGreeting, kisKofia), 'title+deadline');
  const niceKofia = { seq: '42783', company: '나이스신용평가', title: '[NICE신용평가] 신용평가 애널리스트', deadline: '2026-11-09', url: '' };
  const niceGreeting = { seq: 'greeting-240402', company: '나이스신용평가', title: '[NICE신용평가] 신용평가 애널리스트', deadline: '2026-11-09', url: 'https://nice.career.greetinghr.com/ko/o/240402' };
  assert.equal(duplicateReason(niceGreeting, niceKofia), 'title+deadline');
  // 마감일이 이틀 넘게 다르면 재공고로 본다. 회사가 다르면 같은 제목이어도 다른 공고.
  assert.equal(duplicateReason({ ...kisGreeting, deadline: '2026-11-20' }, kisKofia), null);
  assert.equal(duplicateReason({ ...niceGreeting, company: '나이스피앤아이' }, niceKofia), null);
  // 마감일을 모르면 더 엄격하게(0.85). 다른 부서 공고는 걸리지 않는다.
  assert.equal(duplicateReason({ ...kisGreeting, deadline: '' }, { ...kisKofia, title: '[KIS자산평가] 채권평가본부 원화상품실 신입/경력 채용 공고' }), null);
  assert.equal(duplicateReason({ ...niceGreeting, deadline: '' }, niceKofia), 'title');
  // 채용 사이트 첫 화면 주소는 근거가 못 되고, 같은 공고 주소면 바로 중복.
  assert.equal(duplicateReason(
    { seq: 'a', company: 'X', title: '리스크관리', deadline: '', url: 'https://x.career.greetinghr.com/' },
    { seq: 'b', company: 'X', title: 'IT 개발', deadline: '', url: 'https://x.career.greetinghr.com' }), null);
  assert.equal(duplicateReason(
    { seq: 'a', company: '(주)엑스', title: '리스크관리', deadline: '', url: 'https://x.career.greetinghr.com/ko/o/241009' },
    { seq: 'b', company: '엑스', title: 'IT 개발', deadline: '', url: 'https://x.career.greetinghr.com/ko/o/241009/' }), 'url');
  // 실제 오판정 사례: BNK "CM부 백오피스"(그리팅 242339)와 금투협 "주식운용 백오피스"(그리팅 242126을 가리킴)는
  // 제목 Dice가 0.6이었다. 같은 채용 사이트의 서로 다른 공고 주소면 다른 공고다.
  const bnkKofia = { seq: '42875', company: '비엔케이투자증권', title: '[BNK투자증권] 주식운용 백오피스 경력직원 채용 (~11/9)', deadline: '2026-11-09', url: 'https://careers.bnkfn.co.kr/ko/o/242126' };
  assert.equal(duplicateReason({ seq: 'greeting-242339', company: '비엔케이투자증권', title: 'CM부 백오피스 경력직 채용', deadline: '2026-11-08', url: 'https://careers.bnkfn.co.kr/ko/o/242339' }, bnkKofia), null);
  assert.equal(duplicateReason({ seq: 'x', company: '비엔케이투자증권', title: 'CM부 백오피스 경력직 채용', deadline: '2026-11-08', url: '' }, { ...bnkKofia, url: '' }), null);
  assert.equal(duplicateReason({ seq: 'greeting-242126', company: '비엔케이투자증권', title: '주식운용 백오피스 경력직 채용', deadline: '', url: 'https://careers.bnkfn.co.kr/ko/o/242126' }, bnkKofia), 'url');
  // 금투협에 적힌 그리팅 주소는 언어 경로가 없기도 하다. 넥스트증권 재공고(다른 공고 번호)는 제목이 비슷해도 다른 공고.
  assert.equal(duplicateReason(
    { seq: 'greeting-241147', company: 'KB증권', title: '리서치', deadline: '', url: 'https://kbsec.career.greetinghr.com/ko/o/241147' },
    { seq: '42788', company: 'KB증권', title: '다른 제목', deadline: '', url: 'https://kbsec.career.greetinghr.com/o/241147' }), 'url');
  assert.equal(duplicateReason(
    { seq: 'greeting-239724', company: '넥스트증권', title: 'Communication Manager', deadline: '', url: 'https://nextsecurities.career.greetinghr.com/ko/o/239724' },
    { seq: '42049', company: '넥스트증권', title: '[넥스트증권] Sr.Communication Manager', deadline: '', url: 'https://nextsecurities.career.greetinghr.com/ko/o/228880' }), null);
  // 마감일이 같고 한쪽 제목이 다른 쪽을 품으면 같은 공고(IBK). 마감일이 연장된 공고는 따로 둔다(금투협 쪽은 이미 마감).
  const ibkKofia = { seq: '42620', company: 'IBK투자증권', title: '[IBK투자증권] 투자분석부 채용 공고', deadline: '2026-10-30', url: 'https://recruit.ibks.com/cv/announces/ibks' };
  assert.equal(duplicateReason({ seq: 'api-ibks-2496991', company: 'IBK투자증권', title: '투자분석부(경제, 시황/투자전략 애널리스트) 채용 공고', deadline: '2026-10-30', url: 'https://recruit.ibks.com/cv/announces/ibks/2496991' }, ibkKofia), 'title+deadline');
  assert.equal(duplicateReason({ seq: 'x', company: 'IBK투자증권', title: '투자분석부(RA) 채용 공고', deadline: '2026-10-30', url: '' }, { ...ibkKofia, deadline: '' }), null);
  assert.equal(duplicateReason(
    { seq: 'api-ibks-2505050', company: 'IBK투자증권', title: '리스크관리부(부서장) 채용 공고', deadline: '2026-10-30', url: '' },
    { seq: '42654', company: 'IBK투자증권', title: '[IBK투자증권] 리스크관리부(부서장) 채용 공고', deadline: '2026-10-25', url: '' }), null);
  // 회사 키: (주)·공백·영문 약어 한글화, (구. …) 제거.
  assert.equal(companyKey('KB자산운용'), companyKey('케이비자산운용'));
  assert.equal(companyKey('우리투자증권(구. 우리종합금융)'), companyKey('우리투자증권'));
  assert.equal(titleKey('[키움증권] ICT부문 품질관리팀 경력직 채용 (~10/31)', '키움증권'), 'ict부문품질관리팀경력직');
  assert.equal(titleKey('[키움증권] S&T Market부문 패시브솔루션팀 「ETF 운용 담당」 채용 공고 (~ 기간연장 10/31)', '키움증권'), 'stmarket부문패시브솔루션팀etf운용담당');
  assert.ok(titleSimilarity('abc', 'abd') > 0 && titleSimilarity('abc', 'abd') < 1);

  // 마감 기간 문자열의 끝 날짜.
  assert.equal(periodEnd('접수기간 : 26.08.31(월) ~ 26.09.13(일) 23:00'), '2026-09-13');
  assert.equal(periodEnd('2026-08-21 09:00 ~ 2026-09-06 23:59'), '2026-09-06');
  assert.equal(periodEnd('2026년 10월 20일 ~ 2026년 11월 2일'), '2026-11-02');
  assert.equal(periodEnd('상시 채용'), '');
  assert.equal(htmlToText('<p>모집 부문</p><ul><li>리스크</li><li>IT</li></ul><p>A<br>B</p>'), '모집 부문\n리스크\nIT\nA\nB');

  // 그리팅: 첫 화면 __NEXT_DATA__의 openings, 공고 페이지의 getOpeningById 본문.
  const greetingHome = nextDataPage([
    { queryKey: ['publicCareer', 'getCareerBaseInfo', 'careers'], state: { data: {} } },
    { queryKey: ['openings'], state: { data: [
      { openingId: 235042, title: '한국자산신탁 채용연계형 인턴직원  공개채용', openDate: '2026-10-29T08:49:10Z', dueDate: null },
      { openingId: 242026, title: '[KIS] 솔루션실', openDate: '2026-10-27T03:30:00Z', dueDate: '2026-11-06T14:59:59Z' },
    ] } },
  ]);
  const greetingPages = {
    'https://careers.kait.com/ko/home': greetingHome,
    'https://careers.kait.com/ko/o/235042': nextDataPage([{ queryKey: ['career', 'getOpeningById', { openingId: 235042 }], state: { data: { data: { openingsInfo: { detail: '<h3>인재를 모집합니다.</h3><p>모집 부문</p><p>신탁사업</p>' } } } } }]),
  };
  const greetingFetcher = fakeFetcher(greetingPages, { 'https://careers.kait.com/': 'https://careers.kait.com/ko/home' });
  const openings = await greetingAdapter.list('https://careers.kait.com/', greetingFetcher);
  assert.deepEqual(openings.map((o) => [o.seq, o.title, o.url, o.postedAt, o.deadline]), [
    ['greeting-235042', '한국자산신탁 채용연계형 인턴직원 공개채용', 'https://careers.kait.com/ko/o/235042', '2026-10-29 17:49:10', ''],
    // 마감 2026-11-06T14:59:59Z는 서울 기준 11월 6일 23:59
    ['greeting-242026', '[KIS] 솔루션실', 'https://careers.kait.com/ko/o/242026', '2026-10-27 12:30:00', '2026-11-06'],
  ]);
  assert.equal((await greetingAdapter.content(openings[0], greetingFetcher)).text, '인재를 모집합니다.\n모집 부문\n신탁사업');
  await assert.rejects(greetingAdapter.list('https://x.career.greetinghr.com/', fakeFetcher({ 'https://x.career.greetinghr.com/': '<html>no data</html>' })), /그리팅 공고 목록을 찾지 못함/);

  // 사람인 기업 채용 사이트 (1) 채용 한 건의 첫 화면으로 가는 루트(키움): 제목 h1과 접수기간.
  const micrositeHtml = (title, period = '') => `<html><body><div class="unified-panel"><div><span>진행중</span><a href="https://www.kiwoom.com">홈페이지 바로가기</a></div>
    <h1 style="font-size:28px">${title}</h1>${period ? `<p>접수기간 : <span>${period}</span></p>` : ''}
    <div class="menu-grid"><a href="/service/kiwoom/3946/applicant/apply/recruit_default.asp">채용공고</a></div></div></body></html>`;
  const kiwoom = fakeFetcher({
    'https://kiwoom.saramin.co.kr/service/kiwoom/3946/applicant/apply/index.asp': micrositeHtml('2026년 하반기 키움증권 대졸 신입사원 공개채용', '26.08.31(월) ~ 26.09.13(일) 23:00'),
    'https://kiwoom.saramin.co.kr/service/kiwoom/3946/applicant/apply/recruit_default.asp': '<html><body><div class="menu">채용메뉴</div><div class="contents"><div class="recruit"><p>모집분야</p><table><tr><td>리스크</td><td>대체투자 모니터링</td></tr></table></div></div></body></html>',
  }, { 'https://kiwoom.saramin.co.kr/': 'https://kiwoom.saramin.co.kr/service/kiwoom/3946/applicant/apply/index.asp' });
  const kiwoomPostings = await saraminAtsAdapter.list('https://kiwoom.saramin.co.kr/', kiwoom);
  assert.deepEqual(kiwoomPostings.map((p) => [p.seq, p.title, p.deadline, p.url]), [[
    'saraminats-kiwoom-3946', '2026년 하반기 키움증권 대졸 신입사원 공개채용', '2026-09-13', 'https://kiwoom.saramin.co.kr/service/kiwoom/3946/applicant/apply/index.asp',
  ]]);
  assert.equal((await saraminAtsAdapter.content(kiwoomPostings[0], kiwoom)).text, '모집분야\n리스크 대체투자 모니터링');

  // (1') 진행 중 채용 여러 건을 소개하는 첫 화면(거래소).
  const krx = fakeFetcher({
    'https://krx.saramin.co.kr/service/krx/index.asp': '<html><a href="https://krx.saramin.co.kr/service/krx/4013/applicant/apply/index.asp"><img></a><a href="https://krx.saramin.co.kr/service/krx/4014/applicant/apply/index.asp"><img></a></html>',
    'https://krx.saramin.co.kr/service/krx/4013/applicant/apply/index.asp': micrositeHtml('2026년 한국거래소 시장분석전문가 채용'),
    'https://krx.saramin.co.kr/service/krx/4014/applicant/apply/index.asp': micrositeHtml('2026년 한국거래소 증권·파생상품연구인력 채용'),
  }, { 'https://krx.saramin.co.kr/': 'https://krx.saramin.co.kr/service/krx/index.asp' });
  assert.deepEqual((await saraminAtsAdapter.list('https://krx.saramin.co.kr/', krx)).map((p) => [p.seq, p.deadline]), [
    ['saraminats-krx-4013', ''], ['saraminats-krx-4014', ''],
  ]);

  // (2) /apply_site/ 목록(대한토지신탁): 마감·발표중 행은 뺀다. 진행 중 채용이 없으면 ending_page.
  const reitpia = fakeFetcher({
    'https://reitpia.saramin.co.kr/main/index': '<html><a href="/apply_site/recruit/list">채용공고</a></html>',
    'https://reitpia.saramin.co.kr/apply_site/recruit/list': `<ul>
      <li><em class="ico ing">진행중</em><div class="tit"><a class="recruit_view" href="https://reitpia.saramin.co.kr/apply_site/recruit/view/40001"> 신규직원(신입) 채용 공고</a></div><div class="txt"><span class="tx1">2026-10-20 09:00 ~ 2026-11-05 23:59</span></div></li>
      <li><em class="ico end">마감</em><div class="tit"><a class="recruit_view" href="https://reitpia.saramin.co.kr/apply_site/recruit/view/37928"> 신규직원(경력) 채용 공고</a></div><div class="txt"><span class="tx1">2026-08-21 09:00 ~ 2026-09-06 23:59</span></div></li>
      <li><em class="ico">발표중</em><div class="tit"><a class="recruit_view" href="https://reitpia.saramin.co.kr/apply_site/recruit/view/35350"> 신규직원 채용</a></div></li>
    </ul>`,
    'https://reitpia.saramin.co.kr/apply_site/recruit/contents_data/40001': '<html><body><p>회사소개</p><p>모집부문 재무</p></body></html>',
  }, { 'https://reitpia.saramin.co.kr/': 'https://reitpia.saramin.co.kr/main/index' });
  const reitpiaPostings = await saraminAtsAdapter.list('https://reitpia.saramin.co.kr/', reitpia);
  assert.deepEqual(reitpiaPostings.map((p) => [p.seq, p.title, p.deadline, p.url]), [[
    'saraminats-reitpia-40001', '신규직원(신입) 채용 공고', '2026-11-05', 'https://reitpia.saramin.co.kr/apply_site/recruit/view/40001',
  ]]);
  assert.equal((await saraminAtsAdapter.content(reitpiaPostings[0], reitpia)).text, '회사소개\n모집부문 재무');
  assert.deepEqual(await saraminAtsAdapter.list('https://koscom.saramin.co.kr/', fakeFetcher(
    { 'https://koscom.saramin.co.kr/ending_page.html': '<html>종료</html>' }, { 'https://koscom.saramin.co.kr/': 'https://koscom.saramin.co.kr/ending_page.html' })), []);

  // recruiter.co.kr 구형: /appsite/ 아래 목록만. 본문 페이지(/app/)는 robots.txt 금지라 요청하지 않고 목록 정보로 본문을 만든다.
  const recruiterRequests = [];
  const recruiterFetcher = {
    async text(url, init = {}) {
      recruiterRequests.push([init.method ?? 'GET', url, init.body ?? '']);
      if (url === 'https://ls-sec.recruiter.co.kr/appsite/company/index') return { url, text: '<input type="hidden" id="appsiteSn" value="6179"/>' };
      if (url === 'https://ls-sec.recruiter.co.kr/appsite/company/getMainView' && init.method === 'POST' && init.body === 'appsiteSn=6179') {
        return { url, text: JSON.stringify({ jobnoticeInProgressList: [
          { jobnoticeSn: 269740, jobnoticeName: '경력직 수시채용(고객만족센터(인바운드))', applyStartDate: '2026-10-20 00:00:00', applyEndDate: '2026-11-02 23:59:59', receiptState: '접수중', recruitTypeName: '일반채용', recruitClassName: '수시', systemKindCode: 'MRS2' },
          { jobnoticeSn: 265005, jobnoticeName: '2026년 하반기 신입사원(채용전제형 인턴) 공개 채용(대졸)', applyStartDate: '2026-08-31 08:00:00', applyEndDate: '2026-09-13 23:59:59', receiptState: '접수마감', systemKindCode: 'MRS2' },
        ] }) };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  const recruiterPostings = await recruiterAppsiteAdapter.list('https://ls-sec.recruiter.co.kr/', recruiterFetcher);
  assert.deepEqual(recruiterPostings.map((p) => [p.seq, p.title, p.deadline, p.postedAt, p.url]), [[
    'recruiter-ls-sec-269740', '경력직 수시채용(고객만족센터(인바운드))', '2026-11-02', '2026-10-20 00:00:00',
    'https://ls-sec.recruiter.co.kr/app/jobnotice/view?systemKindCode=MRS2&jobnoticeSn=269740',
  ]]);
  const recruiterContent = (await recruiterAppsiteAdapter.content(recruiterPostings[0], recruiterFetcher)).text;
  assert.match(recruiterContent, /^경력직 수시채용\(고객만족센터\(인바운드\)\)\n채용 구분: 일반채용 · 수시\n접수 기간: 2026-10-20 00:00:00 ~ 2026-11-02 23:59:59\n※/);
  assert.ok(recruiterRequests.every(([, url]) => new URL(url).pathname.startsWith('/appsite/')));
  assert.equal(jobSource('recruiter-ls-sec-269740'), 'recruiterAppsite');
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /\nAllow: /appsite/\nAllow: /bbs/appsite/\nUser-agent: Googlebot\nUser-agent: Yeti\nAllow: /\n'), '/app/jobnotice/view'), false);

  // 자체 채용 사이트의 목록 API(endpoint): 주소·필드 이름 설정만으로 받는다(IBK).
  const ibkApi = { list: '/rec/api/ibks/announce/list?searchWord=&includeFinAnno=N&page=1', items: 'rows', id: 'annoId', title: 'title', period: 'term', detail: '/rec/api/ibks/announce?annoId={id}', page: '/cv/announces/ibks/{id}' };
  const ibkFetcher = fakeFetcher({
    'https://recruit.ibks.com/rec/api/ibks/announce/list?searchWord=&includeFinAnno=N&page=1': JSON.stringify({ total: 1, rows: [
      { annoId: 2496991, title: '투자분석부(경제, 시황/투자전략 애널리스트) 채용 공고', term: '2026.10.12 00:00 ~ 2026.10.30 23:59', status: 'DOC' },
      { title: 'ID 없는 행' },
    ] }),
    'https://recruit.ibks.com/rec/api/ibks/announce?annoId=2496991': JSON.stringify({ title: 't', content: '<p>[IBK투자증권] 경력직 채용 공고<br>1. 모집분야</p><p><img src="/rec/api/ibks/image/a1"></p>' }),
    'https://x.example/list': '<html>점검 중</html>',
  });
  const ibk = await endpointAdapter.list('https://recruit.ibks.com/', ibkFetcher, { api: ibkApi });
  assert.deepEqual(ibk.map((p) => [p.seq, p.title, p.deadline, p.postedAt, p.url]), [[
    'api-ibks-2496991', '투자분석부(경제, 시황/투자전략 애널리스트) 채용 공고', '2026-10-30', '2026-10-12 00:00:00', 'https://recruit.ibks.com/cv/announces/ibks/2496991',
  ]]);
  assert.deepEqual(await endpointAdapter.content(ibk[0], ibkFetcher), { text: '[IBK투자증권] 경력직 채용 공고\n1. 모집분야', images: ['https://recruit.ibks.com/rec/api/ibks/image/a1'], files: [] });
  await assert.rejects(endpointAdapter.list('https://x.example/', ibkFetcher, { api: { ...ibkApi, list: '/list' } }), /JSON이 아님/);
  assert.equal(jobSource('api-ibks-2496991'), 'endpoint');

  // endpoint 확장: 목록 POST 폼 값, 최상위 배열, "2026.11.08" 날짜, ISO 마감(서울 날짜), HTML 상세, {data:{content}} 상세.
  const endpointRequests = [];
  const shinhanFetcher = { async text(url, init = {}) {
    endpointRequests.push([init.method ?? 'GET', url, init.body ?? '', init.json === true]);
    if (url === 'https://recruit.shinhansec.com/recruit/mainList.do') return { url, text: JSON.stringify([
      { ANNO_ID: 4175211, ANNO_SUBJECT: '리서치본부 RA 공개채용', ACCEPT_STA_YMD: '2026.10.23', ACCEPT_END_YMD: '2026.11.08' },
    ]) };
    if (url === 'https://recruit.shinhansec.com/recruit/view.do?annoId=4175211') return { url, text: '<html><body><header>메뉴</header><div class="view_wrap"><h3>리서치본부 RA 공개채용</h3><p>모집구분 신입 · 마감일 2026.11.08</p></div></body></html>' };
    if (url === 'https://hana-aamc.applyin.co.kr/jobs?v=1.2.0&size=50') return { url, text: JSON.stringify({ data: [{ id: 23451, title: '전략자산운용 경력직원 채용', start: '2026-10-11T15:00:00.000000Z', end: '2026-11-30T14:59:59.000000Z' }] }) };
    if (url === 'https://hana-aamc.applyin.co.kr/jobs/23451?v=1.2.0') return { url, text: JSON.stringify({ data: { content: '<p>국내 부동산 투자 경력</p>' } }) };
    throw new Error(`unexpected ${url}`);
  } };
  const { DEFAULT_WATCHLIST } = load('lib/company-watchlist.ts');
  const sourceOf = (name) => DEFAULT_WATCHLIST.companies.find((c) => c.name === name).sources[0];
  const shinhan = await endpointAdapter.list('https://recruit.shinhansec.com/', shinhanFetcher, { api: sourceOf('신한투자증권').api });
  assert.deepEqual(shinhan.map((p) => [p.seq, p.title, p.deadline, p.postedAt, p.url]), [[
    'api-shinhansec-4175211', '리서치본부 RA 공개채용', '2026-11-08', '2026-10-23 00:00:00', 'https://recruit.shinhansec.com/recruit/view.do?annoId=4175211',
  ]]);
  assert.equal((await endpointAdapter.content(shinhan[0], shinhanFetcher)).text, '리서치본부 RA 공개채용\n모집구분 신입 · 마감일 2026.11.08');
  const applyin = await endpointAdapter.list('https://hana-aamc.applyin.co.kr/', shinhanFetcher, { api: sourceOf('하나대체투자자산운용').api });
  assert.deepEqual(applyin.map((p) => [p.seq, p.deadline, p.postedAt, p.url]), [['api-hana-aamc-23451', '2026-11-30', '2026-10-12 00:00:00', 'https://hana-aamc.applyin.co.kr/jobs/23451']]);
  assert.equal((await endpointAdapter.content(applyin[0], shinhanFetcher)).text, '국내 부동산 투자 경력');
  assert.deepEqual(endpointRequests.map(([method, , body, json]) => [method, body, json]), [
    ['POST', 'searchType=A', true], ['GET', '', true], ['GET', '', true], ['GET', '', true],
  ]);

  // Workday: 서울 검색 결과 중 근무지가 한국인 공고만, 마감일·게시일은 본문 응답에서.
  const wdRequests = [];
  const wdFetcher = {
    async text(url, init = {}) {
      wdRequests.push([init.method ?? 'GET', url, init.body ?? '']);
      if (url === 'https://blackrock.wd1.myworkdayjobs.com/wday/cxs/blackrock/BlackRock_Professional/jobs') {
        const body = JSON.parse(init.body);
        assert.equal(body.searchText, 'Seoul');
        return { url, text: JSON.stringify({ total: 3, jobPostings: [
          { title: 'Director, Korea Institutional Client Business Team', externalPath: '/job/Seoul-Korea/Director--Korea-Institutional-Client-Business-Team_R266341', locationsText: 'Seoul, Korea', bulletFields: ['R266341'] },
          { title: 'Seoul Desk Coverage (London based)', externalPath: '/job/London/Seoul-Desk_R1', locationsText: 'London, United Kingdom', bulletFields: ['R1'] },
          { title: 'Regional role', externalPath: '/job/x/Regional_R2', locationsText: '3 Locations', bulletFields: ['R2'] },
        ] }) };
      }
      if (url === 'https://blackrock.wd1.myworkdayjobs.com/wday/cxs/blackrock/BlackRock_Professional/job/Seoul-Korea/Director--Korea-Institutional-Client-Business-Team_R266341') {
        return { url, text: JSON.stringify({ jobPostingInfo: { title: 'Director', jobDescription: '<p><b>About this role</b></p><p>Coverage of Korean institutions.</p>', location: 'Seoul, Korea', timeType: 'Full time', startDate: '2026-10-20', endDate: '2026-11-13' } }) };
      }
      throw new Error(`unexpected ${url}`);
    },
  };
  const wd = await workdayAdapter.list('https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional', wdFetcher);
  assert.deepEqual(wd.map((p) => [p.seq, p.title, p.url]), [[
    'workday-blackrock-R266341', 'Director, Korea Institutional Client Business Team',
    'https://blackrock.wd1.myworkdayjobs.com/BlackRock_Professional/job/Seoul-Korea/Director--Korea-Institutional-Client-Business-Team_R266341',
  ]]);
  const wdContent = await workdayAdapter.content(wd[0], wdFetcher);
  assert.equal(wdContent.text, '근무지: Seoul, Korea\n근무 형태: Full time\n마감: 2026-11-13\n\nAbout this role\nCoverage of Korean institutions.');
  assert.equal(wdContent.deadline, '2026-11-13');
  assert.equal(wdContent.postedAt, '2026-10-20 00:00:00');
  assert.equal(wdRequests.length, 2); // total 3 ≤ 한 쪽(20)이라 다음 쪽은 부르지 않는다
  await assert.rejects(workdayAdapter.list('https://x.wd1.myworkdayjobs.com/', wdFetcher), /사이트 이름/);
  // 첫 bulletField가 고용 형태인 테넌트(AIA): 주소 끝 번호를 쓴다. 공고마다 seq가 달라야 한다.
  const aiaFetcher = { async text(url) {
    return { url, text: JSON.stringify({ total: 2, jobPostings: [
      { title: '[AIAPP] Data Analysis Manager', externalPath: '/job/Seoul-KR-AIA-Korea/AIAPP--Data-Analysis-Manager_JR-118207', locationsText: 'Seoul, KR-AIA Korea', bulletFields: ['Permanent'] },
      { title: 'Product Strategy & Governance', externalPath: '/job/Seoul-KR-AIA-Korea/Product-Strategy---Governance_JR-117810', locationsText: 'Seoul, KR-AIA Korea', bulletFields: ['Permanent'] },
    ] }) };
  } };
  assert.deepEqual((await workdayAdapter.list('https://aia.wd3.myworkdayjobs.com/External', aiaFetcher)).map((p) => p.seq), ['workday-aia-JR-118207', 'workday-aia-JR-117810']);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nAllow: /BlackRock_Professional/\nDisallow: /BlackRock_AIG/\nDisallow: /refreshFacet/\n'), '/wday/cxs/blackrock/BlackRock_Professional/jobs'), true);

  // 토스 채용: 계열사 통합 목록 JSON 한 번(본문 포함)에서 이 계열사 공고만. 같은 공고가 여러 묶음에 나오면 한 번만.
  const tossMetaOf = (sub, extra = {}) => [
    { name: 'Employment_Type', value: '정규직' },
    { name: '포지션의 소속 자회사를 선택해 주세요.', value: sub },
    { name: 'Job Description을 작성해 주세요.(작성 전, 채용 커뮤니케이션 가이드 노션을 꼭 참고해 주세요.)', value: '## 합류하게 될 팀\n- 리스크관리' },
    { name: '커리어페이지 메뉴에 "미노출" 되어야 하는 Job인가요?', value: extra.hidden ? 'True' : 'False' },
    { name: '커리어페이지 채용공고 클로징 일자 (서류접수 마감일이 정해진 경우)', value: extra.closing ?? '' },
  ];
  const tossRequests = [];
  const tossFetcher = { async text(url, init = {}) {
    tossRequests.push([url, init.maxBytes]);
    return { url, text: JSON.stringify({ resultType: 'SUCCESS', success: [
      { primary_job: { id: 111, title: 'Risk Manager', first_published: '2021-01-25T14:11:36Z', application_deadline: null, metadata: tossMetaOf('토스증권') }, jobs: [
        { id: 111, title: 'Risk Manager', metadata: tossMetaOf('토스증권') },
        { id: 222, title: 'Android Developer', metadata: tossMetaOf('토스') },
      ] },
      { primary_job: { id: 333, title: 'IR Manager', first_published: '2026-10-01T00:00:00Z', metadata: tossMetaOf('토스증권', { closing: '2026-11-15' }) }, jobs: [] },
      { primary_job: { id: 444, title: '숨긴 공고', metadata: tossMetaOf('토스증권', { hidden: true }) }, jobs: [] },
    ] }) };
  } };
  const toss = await tossCareerAdapter.list('https://toss.im/career/jobs', tossFetcher, { affiliate: '토스증권' });
  assert.deepEqual(toss.map((p) => [p.seq, p.title, p.deadline, p.url]), [
    ['toss-111', 'Risk Manager', '', 'https://toss.im/career/job-detail?job_id=111'],
    ['toss-333', 'IR Manager', '2026-11-15', 'https://toss.im/career/job-detail?job_id=333'],
  ]);
  assert.equal((await tossCareerAdapter.content(toss[0], tossFetcher)).text, '토스증권 · Risk Manager\n\n고용 형태: 정규직\n\n## 합류하게 될 팀\n- 리스크관리');
  assert.deepEqual(tossRequests, [['https://api-public.toss.im/api/v3/ipd-eggnog/career/job-groups', 20000000]]);
  assert.equal(jobSource('toss-111'), 'tossCareer');

  // 자체 채용 게시판(pageWatch). 기준일 2026-10-29.
  const today = new Date('2026-10-29T03:00:00Z');
  const B = (u) => new URL(u);
  // 글 링크 판정: 경로 차이의 숫자, 같은 경로면 새 숫자 인자. 쪽 번호·분류·탭은 아니다.
  assert.equal(isPostLink(B('https://hanatrust.com/ko/recruitment/jobNotice/view?seq=44&page=1'), B('https://hanatrust.com/ko/recruitment/jobNotice')), true);
  assert.equal(isPostLink(B('https://hanatrust.com/ko/recruitment/jobNotice?search_employment_type=career'), B('https://hanatrust.com/ko/recruitment/jobNotice')), false);
  assert.equal(isPostLink(B('https://www.syfund.co.kr/board/notice?categorySeq=96&keyword=&page=0'), B('https://www.syfund.co.kr/board/notice?categorySeq=95')), false);
  assert.equal(isPostLink(B('https://www.syfund.co.kr/board/notice/view/8064?categorySeq=95&page=0'), B('https://www.syfund.co.kr/board/notice?categorySeq=95')), true);
  assert.equal(isPostLink(B('http://www.shinyoungret.com/?pages=job&subs=sub01&tab=tab01'), B('http://www.shinyoungret.com/?pages=job&subs=sub01')), false);
  assert.equal(isPostLink(B('http://www.shinyoungret.com/?pages=job&subs=sub01&m=view&idx=20'), B('http://www.shinyoungret.com/?pages=job&subs=sub01')), true);
  assert.equal(isPostLink(B('http://www.shinyoungret.com/?pages=job&subs=sub01&pageno=2&q='), B('http://www.shinyoungret.com/?pages=job&subs=sub01')), false);
  assert.equal(isPostLink(B('https://www.egap.co.kr/bbs/board.php?bo_table=recruit&sca=%EC%8B%A0%EC%9E%85'), B('https://www.egap.co.kr/bbs/board.php?bo_table=recruit')), false);
  assert.equal(isPostLink(B('https://midasasset.com/notices/page/2/'), B('https://midasasset.com/notices/')), false);
  // 줄 날짜: 지난 마감, 올해 전 연도, 연도 없는 마감 표기.
  assert.deepEqual(rowDates('마감 리테일마케팅 경력직 ~ 2026.09.20', today), { deadline: '2026-09-20', postedAt: '', old: true });
  assert.equal(rowDates('2022년 신영부동산신탁 경력직 공개 채용(~3/13)', today).old, true);
  assert.equal(rowDates('[채용]2026년 경력 직원 채용공고(채권운용본부 / ~9.13)', today).old, true);
  assert.deepEqual(rowDates('2026년 하나자산신탁 하반기 직원 채용 2026-10-16 ~ 2026-10-30', today), { deadline: '2026-10-30', postedAt: '2026-10-16 00:00:00', old: false });
  assert.equal(rowDates('재무관리부 신입 업무직원 공개채용(~11/5)', today).deadline, '2026-11-05');

  const boardPages = {
    // 하나자산신탁형: 링크 글자는 "상세보기", 제목은 같은 줄의 제목 칸. 메뉴는 공통 영역이라 빠진다.
    'https://hanatrust.com/ko/recruitment/jobNotice': `<html><body><header><a href="/ko/recruitment/jobNotice/view?seq=1">채용 메뉴 1번 글</a></header>
      <ul class="list"><li><p class="tit">2026년 하나자산신탁 하반기 직원 채용</p><span>2026-10-16 ~ 2026-10-30</span><a href="/ko/recruitment/jobNotice/view?seq=44&page=1">상세보기</a></li>
      <li><p class="tit">2025년 상반기 채용</p><span>2025-03-01 ~ 2025-03-15</span><a href="/ko/recruitment/jobNotice/view?seq=30&page=1">상세보기</a></li>
      <li><p class="tit">경력 채용(마감)</p><span>채용마감</span><a href="/ko/recruitment/jobNotice/view?seq=41&page=1">상세보기</a></li></ul>
      <a href="/ko/recruitment/jobNotice?page=2">2</a><a href="/files/apply.hwp">입사지원서 123.hwp</a></body></html>`,
    'https://hanatrust.com/ko/recruitment/jobNotice/view?seq=44&page=1': `<html><body><nav>메뉴</nav><div class="view"><h3>2026년 하반기 직원 채용</h3><p>모집부문: 신탁사업 신입</p><p>접수: 10/16 ~ 10/30</p></div><footer>주소</footer></body></html>`,
    // 코리아에셋형: 글 링크가 javascript:fn_egov_select('92'), 쪽 번호 함수는 무시.
    'https://www.kasset.co.kr/recruit_list.do': `<table><tr><td class="board_tit"><a href="javascript:fn_egov_select('93');">채권금융팀 인턴사원 모집</a></td><td>2026-10-25 09:00:00 ~ 2026-11-05 23:59:00</td><td>진행중</td></tr>
      <tr><td class="board_tit"><a href="javascript:fn_egov_select('92');">채권금융팀 신입사원 모집</a></td><td>2026-10-21 ~ 2026-10-28</td><td>마감</td></tr></table>
      <a href="javascript:fn_egov_link_page(2);">2</a>`,
    // 우리자산운용형: 글 링크 없이 목록 칸에 내용이 다 있음.
    'https://www.wooriam.kr/company/recruit-list': `<div class="recruit-item"><div class="recruit-item__badge">채용중</div><div class="recruit-item__title"><a>[우리자산운용] 2027년 상반기 인턴 채용</a></div><dl><dt>채용기간</dt><dd>2026-10-25 ~ 2026-11-10</dd><dt>모집분야</dt><dd>운용지원</dd></dl></div>
      <div class="recruit-item"><div class="recruit-item__badge complete">채용완료</div><div class="recruit-item__title"><a>[우리자산운용] 2026년 하반기 공개 채용</a></div><dl><dd>2026-10-01 ~ 2026-10-18</dd></dl></div>`,
  };
  const boardFetcher = fakeFetcher(boardPages);
  const hanaTrust = await pageWatchAdapter.list('https://hanatrust.com/ko/recruitment/jobNotice', boardFetcher, { now: today });
  assert.deepEqual(hanaTrust.map((p) => [p.title, p.deadline, p.url, p.mayNotBePosting]), [
    ['2026년 하나자산신탁 하반기 직원 채용', '2026-10-30', 'https://hanatrust.com/ko/recruitment/jobNotice/view?seq=44&page=1', true],
  ]);
  assert.match(hanaTrust[0].seq, /^page-[0-9a-f]{12}$/);
  // 본문에 목록 제목이 없으면 앞에 붙인다(본문이 이미지·첨부뿐인 글도 요약기가 제목은 본다).
  assert.equal((await pageWatchAdapter.content(hanaTrust[0], boardFetcher)).text, '2026년 하나자산신탁 하반기 직원 채용\n2026년 하반기 직원 채용\n모집부문: 신탁사업 신입\n접수: 10/16 ~ 10/30');
  // 본문이 이미지뿐이고 이전글·다음글만 글로 남는 페이지(코리아에셋): 이전글·다음글은 빼고 제목만.
  boardPages['https://www.kasset.co.kr/recruit_view.do?recruitId=17'] = '<html><body><div class="board_view"><h4>IB부문 전문영업직 채용</h4><img src="/a.png"><div class="board_prev"><span>이전글</span> 신기술투자본부 인턴 채용 공고 2023-02-02</div><div><span>다음글</span> [경력]IT지원팀 모집 2022-10-12</div></div></body></html>';
  assert.equal((await pageWatchAdapter.content({ title: 'IB부문 전문영업직 채용', contentUrl: 'https://www.kasset.co.kr/recruit_view.do?recruitId=17' }, boardFetcher)).text, 'IB부문 전문영업직 채용');
  const kasset = await pageWatchAdapter.list('https://www.kasset.co.kr/recruit_list.do', boardFetcher, { now: today, jsLinkTemplate: 'https://www.kasset.co.kr/recruit_view.do?recruitId={id}' });
  assert.deepEqual(kasset.map((p) => [p.title, p.url, p.deadline]), [['채권금융팀 인턴사원 모집', 'https://www.kasset.co.kr/recruit_view.do?recruitId=93', '2026-11-05']]);
  const wooriam = await pageWatchAdapter.list('https://www.wooriam.kr/company/recruit-list', boardFetcher, { now: today, itemSelector: '.recruit-item' });
  assert.deepEqual(wooriam.map((p) => [p.title, p.deadline, p.url]), [['[우리자산운용] 2027년 상반기 인턴 채용', '2026-11-10', 'https://www.wooriam.kr/company/recruit-list']]);
  assert.match((await pageWatchAdapter.content(wooriam[0], boardFetcher)).text, /모집분야\n?\s*운용지원/);

  // 본문 영역의 이미지·첨부 링크를 함께 돌려준다(공통 영역 로고는 빠짐).
  boardPages['https://www.syfund.co.kr/board/notice/view/8064'] = `<html><body><header><img src="/logo.png"></header><div class="board_view"><h3>[채용] 2026년 하반기 신입사원 채용공고</h3>
    <p><img src="/uploads/board/editor/2026/10/14/a.png"><img src="/uploads/board/editor/2026/10/14/b.png"></p>
    <ul><li><a href="/user/file/download/7502">신입입사지원서_모집부문_이름.docx</a></li><li><a href="/user/file/download/7504">2026년 하반기 신입사원 채용공고.pdf</a></li></ul></div></body></html>`;
  const syfund = await pageWatchAdapter.content({ title: '[채용] 2026년 하반기 신입사원 채용공고', contentUrl: 'https://www.syfund.co.kr/board/notice/view/8064' }, boardFetcher);
  assert.deepEqual(syfund.images, ['https://www.syfund.co.kr/uploads/board/editor/2026/10/14/a.png', 'https://www.syfund.co.kr/uploads/board/editor/2026/10/14/b.png']);
  assert.deepEqual(syfund.files.map((f) => f.name), ['신입입사지원서_모집부문_이름.docx', '2026년 하반기 신입사원 채용공고.pdf']);

  // 얇은 본문 채우기: 양식이 아닌 첨부(PDF)를 먼저 읽고, 충분하면 이미지는 판독하지 않는다.
  const { completeWatchContent } = load('lib/watch-content.ts');
  const { dispositionFilename } = load('lib/watch-fetch.ts');
  const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
  const png = (w, h) => { const b = new Uint8Array(400); b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0); b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8); new DataView(b.buffer).setUint32(16, w); new DataView(b.buffer).setUint32(20, h); return b; };
  const bytesRequested = [];
  const mediaFetcher = { async text() { throw new Error('no'); }, async bytes(url) {
    bytesRequested.push(url);
    if (url.endsWith('/7504')) return { url, bytes: pdfBytes, contentType: 'application/pdf', filename: '' };
    if (url.endsWith('/7502')) return { url, bytes: new Uint8Array([0x50, 0x4b, 3, 4]), contentType: '', filename: '신입입사지원서.docx' };
    if (url.endsWith('a.png')) return { url, bytes: png(900, 3000), contentType: 'image/png', filename: '' };
    if (url.endsWith('b.png')) return { url, bytes: png(900, 12000), contentType: 'image/png', filename: '' };
    if (url.endsWith('/attach1')) return { url, bytes: pdfBytes, contentType: '', filename: '입사지원서 양식_정규직.pdf' };
    throw new Error(`unexpected ${url}`);
  } };
  const transcribed = [];
  const deps = { pdfText: async () => '모집부문: 주식운용 신입\n'.repeat(30), transcribe: async (images) => { transcribed.push(images.length); return '모집부문: 채권운용\n자격: 학사 이상'; }, zipText: () => { throw new Error('form should not be read'); } };
  const filled = await completeWatchContent({ text: '[채용] 2026년 하반기 신입사원 채용공고\n첨부 참조', images: syfund.images, files: syfund.files }, '[채용] 2026년 하반기 신입사원 채용공고', mediaFetcher, deps);
  assert.match(filled, /\[첨부: 2026년 하반기 신입사원 채용공고\.pdf\]\n모집부문: 주식운용 신입/);
  assert.deepEqual(transcribed, []);
  assert.ok(!bytesRequested.some((u) => u.endsWith('/7502'))); // 이름이 입사지원서인 첨부는 받지도 않는다
  // 첨부가 양식뿐이면(이름은 받아 봐야 아는 경우 포함) 본문 이미지를 판독한다. 한 변이 8000px를 넘는 이미지는 건너뛴다.
  const fromImages = await completeWatchContent({ text: '2026년 하나자산신탁 하반기 직원 채용', images: syfund.images, files: [{ url: 'https://h/attach1', name: '' }] }, '2026년 하나자산신탁 하반기 직원 채용', mediaFetcher, deps);
  assert.equal(fromImages, '2026년 하나자산신탁 하반기 직원 채용\n\n[본문 이미지 판독]\n모집부문: 채권운용\n자격: 학사 이상');
  assert.deepEqual(transcribed, [1]);
  // 본문이 충분하면 아무것도 받지 않는다. 판독이 실패해도 원래 글로 저장한다.
  bytesRequested.length = 0;
  const long = '모집부문 '.repeat(100);
  assert.equal(await completeWatchContent({ text: long, images: syfund.images, files: syfund.files }, 't', mediaFetcher, deps), long);
  assert.deepEqual(bytesRequested, []);
  assert.equal(await completeWatchContent({ text: '제목', images: syfund.images, files: [] }, '제목', mediaFetcher, { ...deps, transcribe: async () => { throw new Error('model down'); } }), '제목');
  // Content-Disposition 파일 이름: RFC 5987, 퍼센트 인코딩, latin1로 들어온 UTF-8 바이트.
  assert.equal(dispositionFilename("attachment; filename*=UTF-8''%EC%B1%84%EC%9A%A9.pdf"), '채용.pdf');
  assert.equal(dispositionFilename('attachment; filename="%EC%B1%84%EC%9A%A9.pdf"'), '채용.pdf');
  assert.equal(dispositionFilename(`attachment; filename="${Buffer.from('채용공고.pdf', 'utf8').toString('latin1')}"`), '채용공고.pdf');

  // 수집 흐름: 감시 목록 → 새 공고만 열고, 금투협과 같은 공고는 연결만, 출처별 기록과 하루 한 번.
  const db = load('lib/db.ts');
  const { writeWatchlist } = load('lib/company-watchlist.ts');
  const { runCompanyWatch, linkKofiaDuplicates, dueWatchTasks } = load('lib/company-watch.ts');
  const now = new Date('2026-10-29T09:00:00Z');
  const summary = (s) => ({ seq: s.seq, company: s.company, title: s.title, date: s.date ?? '2026-10-27 16:29:14', applicationPeriod: '', siteUrl: s.siteUrl ?? '', attachments: [], positionType: '신입', experienceYears: '무관', positions: ['솔루션'], jdSummary: '요약', qualifications: [], deadline: s.deadline ?? '' });
  db.upsertJob({ summary: summary(kisKofia), rawContent: '본문', summarizedOk: true });

  writeWatchlist({ version: 1, companies: [
    { name: 'KIS자산평가', segment: '채권평가', enabled: true, sources: [{ type: 'greeting', url: 'https://kispricing.career.greetinghr.com/' }] },
    { name: '나이스신용평가', segment: '신용평가', enabled: true, sources: [{ type: 'greeting', url: 'https://nice.career.greetinghr.com/', titleIncludes: ['NICE신용평가'] }] },
    { name: '나이스피앤아이', segment: '채권평가', enabled: true, sources: [{ type: 'greeting', url: 'https://nice.career.greetinghr.com/', titleIncludes: ['NICE피앤아이'] }] },
    { name: '교보자산신탁', segment: '신탁', enabled: true, sources: [{ type: 'greeting', url: 'https://kyobotrust.career.greetinghr.com/' }] },
    { name: '꺼둔회사', segment: '증권', enabled: false, sources: [{ type: 'greeting', url: 'https://off.career.greetinghr.com/' }] },
    { name: '막힌회사', segment: '증권', enabled: true, sources: [{ type: 'saraminAts', url: 'https://blocked.saramin.co.kr/' }] },
    { name: '바로가기만', segment: '증권', enabled: true, sources: [{ type: 'blocked', url: 'https://nhqv.recruiter.co.kr/' }] },
  ] });
  const opening = (id, title, dueDate = null, openDate = '2026-10-20T00:00:00Z') => ({ openingId: id, title, openDate, dueDate });
  const watchPages = {
    'https://kispricing.career.greetinghr.com/ko/home': nextDataPage([{ queryKey: ['openings'], state: { data: [
      opening(242026, kisGreeting.title, '2026-11-06T14:59:59Z'),
      opening(242100, '[KIS자산평가] 채권평가본부 신입 채용', '2026-11-10T14:59:59Z'),
      opening(230000, '[KIS자산평가] 지난 공고', '2026-10-01T14:59:59Z'),
    ] } }]),
    'https://kispricing.career.greetinghr.com/ko/o/242100': nextDataPage([{ queryKey: ['career', 'getOpeningById', {}], state: { data: { data: { openingsInfo: { detail: '<p>채권평가 본문</p>' } } } } }]),
    'https://nice.career.greetinghr.com/ko/intro': nextDataPage([{ queryKey: ['openings'], state: { data: [
      opening(240402, '[NICE신용평가] 신용평가 애널리스트', '2026-11-09T14:59:59Z'),
      opening(242264, '[NICE디앤알] 웹 서비스 개발', '2026-11-17T07:59:59Z'),
      opening(242300, '[NICE피앤아이] 채권평가 신입', '2026-11-12T14:59:59Z'),
    ] } }]),
    'https://nice.career.greetinghr.com/ko/o/240402': nextDataPage([{ queryKey: ['career', 'getOpeningById', {}], state: { data: { data: { openingsInfo: { detail: '<p>애널리스트 본문</p>' } } } } }]),
    'https://nice.career.greetinghr.com/ko/o/242300': nextDataPage([{ queryKey: ['career', 'getOpeningById', {}], state: { data: { data: { openingsInfo: { detail: '<p>P&amp;I 본문</p>' } } } } }]),
    'https://kyobotrust.career.greetinghr.com/ko/home': nextDataPage([{ queryKey: ['openings'], state: { data: [
      opening(84255, '교보자산신탁 우수인재 등록시스템(DB)', null, '2024-09-03T06:15:08Z'),
      opening(84300, '교보자산신탁 상시 채용(오래됨)', null, '2025-01-03T06:15:08Z'),
    ] } }]),
    'https://blocked.saramin.co.kr/': new WatchBlockedError('HTTP 429 — 자동 접근이 막힘'),
  };
  const watchFetcher = fakeFetcher(watchPages, {
    'https://kispricing.career.greetinghr.com/': 'https://kispricing.career.greetinghr.com/ko/home',
    'https://nice.career.greetinghr.com/': 'https://nice.career.greetinghr.com/ko/intro',
    'https://kyobotrust.career.greetinghr.com/': 'https://kyobotrust.career.greetinghr.com/ko/home',
  });
  const progress = [];
  const result = await runCompanyWatch({ deps: { fetcher: watchFetcher, now: () => now }, onProgress: (p) => progress.push(p) });
  // 금투협에 있는 KIS 공고는 연결만, 마감 지난 공고는 열지 않음, NICE 그룹 사이트는 한 번만 받고 계열사별로 거른다.
  assert.deepEqual(result.details.map((d) => [d.seq, d.company, d.knownDeadline, d.content]), [
    ['greeting-242100', 'KIS자산평가', '2026-11-10', '채권평가 본문'],
    ['greeting-240402', '나이스신용평가', '2026-11-09', '애널리스트 본문'],
    ['greeting-242300', '나이스피앤아이', '2026-11-12', 'P&I 본문'],
  ]);
  assert.equal(result.linked, 1);
  assert.equal(watchFetcher.requested.filter((u) => u === 'https://nice.career.greetinghr.com/').length, 1);
  assert.ok(!watchFetcher.requested.includes('https://kispricing.career.greetinghr.com/ko/o/242026'));
  assert.ok(!watchFetcher.requested.some((u) => u.includes('off.career')));
  assert.ok(!watchFetcher.requested.some((u) => u.includes('nhqv')));
  assert.deepEqual(db.listJobLinks().map((l) => [l.seq, l.canonicalSeq, l.reason]), [['greeting-242026', '42872', 'title+deadline']]);
  const runs = Object.fromEntries(db.getWatchRuns().map((r) => [r.company, [r.status, r.found, r.added]]));
  assert.deepEqual(runs, {
    'KIS자산평가': ['ok', 2, 1],
    '나이스신용평가': ['ok', 1, 1],
    '나이스피앤아이': ['ok', 1, 1],
    '교보자산신탁': ['empty', 0, 0], // 인재풀·마감일 없이 반년 넘게 열린 공고는 뺀다
    '막힌회사': ['blocked', 0, 0],
  });
  assert.equal(progress.length, 5);

  // 하루 안에는 다시 돌지 않는다. 차단된 출처는 일주일 동안. "다시 확인"(기록 삭제)하면 바로 돈다.
  assert.equal(dueWatchTasks(new Date(now.getTime() + 3600_000)).length, 0);
  assert.deepEqual(dueWatchTasks(new Date(now.getTime() + 21 * 3600_000)).map((t) => t.company.name).sort(), ['KIS자산평가', '교보자산신탁', '나이스신용평가', '나이스피앤아이']);
  assert.equal(dueWatchTasks(new Date(now.getTime() + 3600_000), true).length, 5);
  db.clearWatchRuns('교보자산신탁');
  assert.deepEqual(dueWatchTasks(new Date(now.getTime() + 3600_000)).map((t) => t.company.name), ['교보자산신탁']);

  // 저장된 채용 사이트 공고는 다음 수집에서 다시 열지 않는다.
  for (const d of result.details) db.upsertJob({ summary: summary({ ...d, deadline: d.knownDeadline }), rawContent: d.content, summarizedOk: true });
  watchFetcher.requested.length = 0;
  const again = await runCompanyWatch({ force: true, deps: { fetcher: watchFetcher, now: () => now } });
  assert.deepEqual(again.details, []);
  assert.ok(!watchFetcher.requested.some((u) => u.includes('/o/')));

  // 수집 범위 점검: 회사별 금투협 공고 수, 채용 사이트에서 받은 공고 수, 금투협과 겹쳐 연결만 한 수(최근 기간).
  const coverage = db.getCompanyCoverage('2026-05-01');
  assert.deepEqual(coverage.get('KIS자산평가'), { kofia: 1, watch: 1, watchOnKofia: 1 });
  assert.deepEqual(coverage.get('나이스신용평가'), { kofia: 0, watch: 1, watchOnKofia: 0 });
  assert.equal(db.getCompanyCoverage('2099-01-01').get('KIS자산평가'), undefined); // 기간 밖이면 빠진다

  // 채용 사이트 목록에서 내려간 공고는 마감일이 없어도 닫힌다. 다시 보이면 열린다.
  assert.ok(db.getActiveJobs().some((j) => j.seq === 'greeting-242100'));
  watchPages['https://kispricing.career.greetinghr.com/ko/home'] = nextDataPage([{ queryKey: ['openings'], state: { data: [opening(242026, kisGreeting.title, '2026-11-06T14:59:59Z')] } }]);
  await runCompanyWatch({ force: true, deps: { fetcher: watchFetcher, now: () => now } });
  assert.ok(!db.getActiveJobs().some((j) => j.seq === 'greeting-242100'));
  assert.ok(db.getActiveJobs().some((j) => j.seq === '42872')); // 금투협 공고는 건드리지 않는다
  watchPages['https://kispricing.career.greetinghr.com/ko/home'] = nextDataPage([{ queryKey: ['openings'], state: { data: [opening(242100, '[KIS자산평가] 채권평가본부 신입 채용', '2026-11-10T14:59:59Z')] } }]);
  await runCompanyWatch({ force: true, deps: { fetcher: watchFetcher, now: () => now } });
  assert.ok(db.getActiveJobs().some((j) => j.seq === 'greeting-242100'));

  // 금투협에 나중에 같은 공고가 올라오면: 사용자가 손대지 않은 채용 사이트 공고를 목록에서 빼고 금투협 공고를 남긴다.
  db.upsertJob({ summary: summary({ ...niceKofia, date: '2026-10-21 15:09:01' }), rawContent: '본문', summarizedOk: true });
  // 사용자가 찜한 채용 사이트 공고는 남기고, 나중에 온 금투협 공고를 뺀다.
  db.setJobBookmarked('greeting-242300', true);
  db.upsertJob({ summary: summary({ seq: '43001', company: '나이스피앤아이', title: '[NICE피앤아이] 채권평가 신입', deadline: '2026-11-12' }), rawContent: '본문', summarizedOk: true });
  assert.equal(linkKofiaDuplicates([
    { ...niceKofia },
    { seq: '43001', company: '나이스피앤아이', title: '[NICE피앤아이] 채권평가 신입', deadline: '2026-11-12', url: '' },
  ], now), 2);
  const active = db.getActiveJobs().map((j) => j.seq).sort();
  assert.ok(active.includes('42783') && !active.includes('greeting-240402'));
  assert.ok(active.includes('greeting-242300') && !active.includes('43001'));
  assert.ok(active.includes('42872') && active.includes('greeting-242100'));

  // 공고가 아닌 게시판 글로 기록한 것은 다음 수집에서 다시 열지 않는다.
  const { recordNotPosting, isNotPosting } = load('lib/company-watch.ts');
  assert.equal(isNotPosting({ title: '2026년 상반기 서류전형 합격자 발표', mayNotBePosting: true }, { positions: [] }), true);
  assert.equal(isNotPosting({ title: '[채용] 2026년 하반기 신입사원 채용공고', mayNotBePosting: true }, { positions: [] }), false);
  assert.equal(isNotPosting({ title: '홈페이지 개편 안내', mayNotBePosting: true }, { positions: [] }), true);
  assert.equal(isNotPosting({ title: '홈페이지 개편 안내', mayNotBePosting: false }, { positions: [] }), false);
  assert.equal(isNotPosting({ title: '사내 행사', mayNotBePosting: true }, { positions: ['운용'] }), false);
  recordNotPosting({ seq: 'greeting-242100', company: 'KIS자산평가', title: 'x', siteUrl: '' });
  assert.deepEqual([...db.getNotPostingSeqs(['greeting-242100', 'greeting-1'])], ['greeting-242100']);

  // "중복 아님": 저장된 공고는 바로 목록에 돌아오고, 다시 묶이지 않는다.
  assert.deepEqual(db.getJobLinksFor('42783').map((l) => l.seq), ['greeting-240402']);
  db.separateJobLink('greeting-240402');
  assert.ok(db.getActiveJobs().some((j) => j.seq === 'greeting-240402'));
  assert.equal(linkKofiaDuplicates([{ ...niceKofia }], now), 0);
  assert.deepEqual(db.getJobLinksFor('42783'), []);
  // 저장하지 않고 연결만 했던 채용 사이트 공고는 풀면 다음 수집에서 받아 온다(다시 중복으로 판정하지 않음).
  watchPages['https://kispricing.career.greetinghr.com/ko/home'] = nextDataPage([{ queryKey: ['openings'], state: { data: [opening(242026, kisGreeting.title, '2026-11-06T14:59:59Z')] } }]);
  watchPages['https://kispricing.career.greetinghr.com/ko/o/242026'] = nextDataPage([{ queryKey: ['career', 'getOpeningById', {}], state: { data: { data: { openingsInfo: { detail: '<p>솔루션실 본문</p>' } } } } }]);
  db.separateJobLink('greeting-242026');
  const afterSeparate = await runCompanyWatch({ force: true, deps: { fetcher: watchFetcher, now: () => now } });
  assert.deepEqual(afterSeparate.details.map((d) => d.seq), ['greeting-242026']);

  console.log('company-watch tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
