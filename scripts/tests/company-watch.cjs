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
  const { greetingAdapter, saraminAtsAdapter, periodEnd, htmlToText } = load('lib/watch-adapters.ts');
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
  assert.equal(await greetingAdapter.content(openings[0], greetingFetcher), '인재를 모집합니다.\n모집 부문\n신탁사업');
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
  assert.equal(await saraminAtsAdapter.content(kiwoomPostings[0], kiwoom), '모집분야\n리스크 대체투자 모니터링');

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
  assert.equal(await saraminAtsAdapter.content(reitpiaPostings[0], reitpia), '회사소개\n모집부문 재무');
  assert.deepEqual(await saraminAtsAdapter.list('https://koscom.saramin.co.kr/', fakeFetcher(
    { 'https://koscom.saramin.co.kr/ending_page.html': '<html>종료</html>' }, { 'https://koscom.saramin.co.kr/': 'https://koscom.saramin.co.kr/ending_page.html' })), []);

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
