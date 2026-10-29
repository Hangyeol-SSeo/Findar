const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-hiring-season-test-'));
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

(async () => {
  process.chdir(scratch);
  const db = load('lib/db.ts');
  const { writeWatchlist } = load('lib/company-watchlist.ts');
  const hs = load('lib/hiring-season.ts');

  // 시즌: 3~5월·8~11월(서울 기준). 시즌 이름은 상·하반기.
  assert.equal(hs.isHiringSeason(new Date('2026-10-29T03:00:00Z')), true);
  assert.equal(hs.isHiringSeason(new Date('2026-07-15T03:00:00Z')), false);
  assert.equal(hs.isHiringSeason(new Date('2026-02-28T16:00:00Z')), true); // 서울은 3월 1일
  assert.equal(hs.seasonLabel(new Date('2026-10-29T03:00:00Z')), '2026 하반기');
  assert.equal(hs.seasonLabel(new Date('2026-04-01T03:00:00Z')), '2026 상반기');

  // 대상: 켜져 있고 season 표시(없으면 기본 목록)인 회사.
  const names = ['NH투자증권', '하나증권', 'DB증권', '메리츠증권', '삼성증권', '미래에셋증권'];
  writeWatchlist({ version: 1, companies: [
    ...names.map((name) => ({ name, segment: '증권', enabled: true, sources: [{ type: 'blocked', url: `https://${name}.example/` }] })),
    { name: '꺼둔증권', segment: '증권', enabled: false, season: true, sources: [] },
    { name: '키움증권', segment: '증권', enabled: true, sources: [{ type: 'saraminAts', url: 'https://kiwoom.saramin.co.kr/' }] },
    { name: '작은운용', segment: '자산운용', enabled: true, season: true, sources: [] },
  ] });
  const now = new Date('2026-10-29T03:00:00Z');
  assert.deepEqual(hs.seasonTargets().map((c) => c.name), [...names, '작은운용']);
  assert.equal(hs.dueSeasonTargets(new Date('2026-07-15T03:00:00Z')).length, 0);
  assert.equal(hs.dueSeasonTargets(new Date('2026-07-15T03:00:00Z'), true).length, 7);

  // 모델 답 거르기: 목록에 없는 회사, found=false, 근거 주소 없음, 지난 마감은 버린다. 채용 사이트를 모르면 감시 목록 주소.
  const batch = hs.seasonTargets().slice(0, 3);
  const answer = JSON.stringify({ results: [
    { company: 'NH투자증권', found: true, title: '2026년 하반기 대졸 신입사원 공채', deadline: '2026-11-05', recruitUrl: '', articleUrl: 'https://news.example/nh', evidence: '연합뉴스 10/20' },
    { company: '(주)하나증권', found: true, title: '하반기 신입 공채', deadline: '2026-10-01', articleUrl: 'https://news.example/hana' },
    { company: 'DB증권', found: true, title: 'DB그룹 공채', deadline: '', articleUrl: 'javascript:alert(1)' },
    { company: '모르는증권', found: true, title: 'x', articleUrl: 'https://news.example/x' },
    { company: 'DB증권', found: false },
  ] });
  assert.deepEqual(hs.parseSeasonFindings(`설명 앞말\n${answer}`, batch, now), [{
    company: 'NH투자증권', title: '2026년 하반기 대졸 신입사원 공채', deadline: '2026-11-05',
    recruitUrl: 'https://NH투자증권.example/', articleUrl: 'https://news.example/nh', evidence: '연합뉴스 10/20',
  }]);
  assert.deepEqual(hs.parseSeasonFindings('JSON 아님', batch, now), []);
  const prompt = hs.seasonPrompt(batch, now);
  assert.match(prompt, /2026 하반기 신입 공개채용/);
  assert.match(prompt, /- NH투자증권 \(채용 사이트: https:\/\/NH투자증권\.example\/\)/);

  // 실행: 5곳씩 묶어 묻고, 찾은 소식과 회사별 확인 시각을 저장한다. 실패한 묶음은 기록하지 않는다(다음에 다시).
  const asked = [];
  const ask = async (_prompt, companies) => {
    asked.push(companies.map((c) => c.name));
    if (companies.some((c) => c.name === '작은운용')) throw new Error('model down');
    return JSON.stringify({ results: [
      { company: 'NH투자증권', found: true, title: '2026년 하반기 대졸 신입사원 공채', deadline: '2026-11-05', articleUrl: 'https://news.example/nh', recruitUrl: 'https://nhqv.recruiter.co.kr/' },
      { company: '삼성증권', found: true, title: '2026 하반기 3급 신입 공채', deadline: '', articleUrl: 'https://news.example/ss' },
    ] });
  };
  const first = hs.runSeasonCheck({ now: () => now, ask });
  assert.equal(hs.isSeasonCheckRunning(), true);
  assert.equal(hs.runSeasonCheck({ now: () => now, ask }), first); // 도는 중이면 같은 실행
  assert.deepEqual(await first, { checked: 5, found: 2, failed: 2 });
  assert.deepEqual(asked, [names.slice(0, 5), [names[5], '작은운용']]);
  assert.equal(hs.isSeasonCheckRunning(), false);
  assert.deepEqual(db.getSeasonChecks().map((c) => c.company).sort(), names.slice(0, 5).sort());
  // 일주일 안에는 확인한 회사를 다시 묻지 않는다(실패한 묶음만 다시).
  assert.deepEqual(hs.dueSeasonTargets(new Date(now.getTime() + 86_400_000)).map((c) => c.name), [names[5], '작은운용']);
  assert.equal(hs.dueSeasonTargets(new Date(now.getTime() + 7 * 86_400_000)).length, 7);

  // 알림: 마감 순. 닫으면 빠지고, 같은 소식을 다시 찾아도 닫힌 채로 남는다.
  let alerts = hs.activeSeasonAlerts(now);
  assert.deepEqual(alerts.map((a) => [a.company, a.deadline, a.recruitUrl]), [
    ['NH투자증권', '2026-11-05', 'https://nhqv.recruiter.co.kr/'],
    ['삼성증권', '', 'https://삼성증권.example/'],
  ]);
  db.dismissSeasonAlert(alerts[1].id);
  await hs.runSeasonCheck({ force: true, now: () => now, ask: async (_p, companies) => companies.some((c) => c.name === '작은운용') ? '{"results":[]}' : await ask(_p, companies.filter((c) => c.name !== '작은운용')) });
  alerts = hs.activeSeasonAlerts(now);
  assert.deepEqual(alerts.map((a) => a.company), ['NH투자증권']);
  // 마감이 지나면 빠진다. 마감을 모르면 찾은 지 45일 뒤에 빠진다.
  assert.deepEqual(hs.activeSeasonAlerts(new Date('2026-11-06T03:00:00Z')).map((a) => a.company), []);
  // 보드에 같은 공고가 있으면(금투협·직접 추가) 알림을 빼서 보낸다.
  db.upsertJob({ summary: { seq: 'manual-nh1', company: 'NH투자증권', title: '[NH투자증권] 2026년 하반기 대졸 신입사원 공채', date: '2026-10-29 10:00:00', applicationPeriod: '', siteUrl: '', attachments: [], positionType: '신입', experienceYears: '신입', positions: ['공채'], jdSummary: 'x', qualifications: [], deadline: '2026-11-05' }, rawContent: 'x', summarizedOk: true });
  assert.deepEqual(hs.activeSeasonAlerts(now), []);

  console.log('PASS hiring-season: season window and labels, targets (default list, disabled), weekly due list, answer filtering (unknown company, not found, bad/missing URL, past deadline), batched run with failed batch retried, single in-flight run, dismissed alerts stay dismissed, expiry, alerts hidden once the posting is on the board');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});
