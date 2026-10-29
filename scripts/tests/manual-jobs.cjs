const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-manual-jobs-test-'));
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
  const { validateManualJobInput, isManualSeq, postingLink } = load('lib/manual-jobs.ts');
  const { saveManualJob, ManualJobError } = load('lib/manual-job-save.ts');

  // 입력 검증: 필수 칸, 링크 형식, 마감일 형식.
  assert.equal(validateManualJobInput({ company: '', title: 't', content: 'c' }).ok, false);
  assert.equal(validateManualJobInput({ company: 'a', title: 't', content: '  ' }).ok, false);
  assert.equal(validateManualJobInput({ company: 'a', title: 't', content: 'c', url: 'javascript:alert(1)' }).ok, false);
  assert.equal(validateManualJobInput({ company: 'a', title: 't', content: 'c', deadline: '2026-02-30' }).ok, false);
  const valid = validateManualJobInput({ company: ' 메리츠증권 ', title: '2026년  대졸 공채', content: '본문', url: 'https://recruit-meritz.com/jobs', deadline: '2099-10-30' });
  assert.equal(valid.ok, true);
  assert.equal(valid.input.company, '메리츠증권');
  assert.equal(valid.input.title, '2026년 대졸 공채');

  const profile = { sourcesHash: 'hash-1' };
  let summarizeCalls = 0;
  let matchCalls = 0;
  const deps = (over = {}) => ({
    profile: () => profile,
    now: () => new Date('2026-10-28T03:04:05Z'),
    summarize: async (job) => {
      summarizeCalls++;
      return {
        seq: job.seq, company: job.company, title: job.title, date: job.date, applicationPeriod: job.applicationPeriod,
        siteUrl: job.siteUrl, attachments: job.attachments, positionType: '신입', experienceYears: '신입',
        positions: ['IB'], jdSummary: '대졸 신입 공채', qualifications: ['학사 이상'], deadline: '2099-10-31',
      };
    },
    match: async (_profile, jobs) => {
      matchCalls++;
      return new Map(jobs.map((j) => [j.seq, { matchScore: 77, matchVerdict: '보통', matchStrengths: [], matchGaps: [], matchReasoning: 'ok' }]));
    },
    ...over,
  });

  // 새 공고: manual- seq, 서울 기준 추가일, 사용자가 적은 마감일이 AI 마감일보다 우선, 매칭 저장.
  const first = await saveManualJob(valid.input, undefined, deps());
  assert.ok(isManualSeq(first.job.seq));
  assert.match(first.job.seq, /^manual-[a-z0-9]+$/);
  assert.equal(first.job.date, '2026-10-28 12:04:05');
  assert.equal(first.job.deadline, '2099-10-30');
  assert.equal(first.job.matchScore, 77);
  assert.deepEqual([first.summarized, first.matched], [true, true]);
  assert.equal(first.job.rawContent, undefined, 'list-shaped job without body');
  assert.ok(db.getActiveJobs().some((j) => j.seq === first.job.seq), 'shows on the board');
  assert.equal(postingLink(first.job), 'https://recruit-meritz.com/jobs');
  assert.equal(postingLink({ seq: '42787', siteUrl: 'https://x.example' }), 'https://www.kofia.or.kr/brd/m_96/view.do?seq=42787');

  // 링크·마감일만 고치면 요약·매칭을 다시 하지 않는다.
  const before = { summarizeCalls, matchCalls };
  const edited = await saveManualJob({ ...valid.input, url: '', deadline: '2099-11-05' }, first.job.seq, deps());
  assert.deepEqual({ summarizeCalls, matchCalls }, before);
  assert.equal(edited.job.siteUrl, '');
  assert.equal(edited.job.deadline, '2099-11-05');
  assert.equal(edited.job.matchScore, 77);
  assert.equal(edited.job.date, first.job.date, 'keeps the added date');
  assert.equal(postingLink(edited.job), null);

  // 본문을 고쳤는데 매칭이 실패하면 옛 점수를 지워 다음 재매칭이 채우게 한다.
  const failedMatch = await saveManualJob({ ...valid.input, content: '바뀐 본문' }, first.job.seq,
    deps({ match: async () => { throw new Error('offline'); } }));
  assert.equal(failedMatch.matched, false);
  assert.equal(failedMatch.job.matchScore, undefined);
  assert.ok(db.getJobsNeedingMatch('hash-1').some((j) => j.seq === first.job.seq));

  // 요약이 실패해도 공고는 목록에 남는다(다음 크롤링이 다시 요약해 주지 않으므로).
  const degraded = await saveManualJob({ ...valid.input, title: '체험형 인턴', deadline: '' }, undefined,
    deps({ summarize: async () => { throw new Error('offline'); } }));
  assert.equal(degraded.summarized, false);
  assert.equal(degraded.job.jdSummary, '요약 실패');
  assert.ok(db.getActiveJobs().some((j) => j.seq === degraded.job.seq));

  // 협회 공고나 없는 seq는 고칠 수 없다.
  db.upsertJob({ summary: {
    seq: '42787', company: '메리츠증권', title: '트레이딩본부 채용', date: '2026-10-21 15:41:31', applicationPeriod: '',
    siteUrl: 'https://www.imeritz.com', attachments: [], positionType: '경력', experienceYears: '3년', positions: ['트레이딩'],
    qualifications: [], jdSummary: '요약', deadline: '2099-10-31',
  }, rawContent: '협회 본문', summarizedOk: true });
  await assert.rejects(saveManualJob(valid.input, '42787', deps()), ManualJobError);
  await assert.rejects(saveManualJob(valid.input, 'manual-missing', deps()), ManualJobError);

  // 회사 리서치: 직접 추가 공고의 링크는 홈페이지 후보가 아니고, 최근 공고는 등록일 순으로 섞인다.
  assert.deepEqual(db.getCompanySiteUrls('메리츠증권'), ['https://www.imeritz.com']);
  const recent = db.getCompanyRecentJobs('메리츠증권', 5).map((j) => j.seq);
  assert.equal(recent[recent.length - 1], '42787');
  assert.ok(recent.includes(first.job.seq));

  // 시트 동기화: 직접 추가 공고는 적어 둔 링크(없으면 빈 칸)를 보낸다.
  const { buildSheetRowPayload } = load('lib/sheet-sync.ts');
  db.upsertApplicationStatus(first.job.seq, '제출완료');
  assert.equal(buildSheetRowPayload(first.job.seq).link, 'https://recruit-meritz.com/jobs');
  await saveManualJob({ ...valid.input, content: '바뀐 본문', url: '' }, first.job.seq, deps());
  assert.equal(buildSheetRowPayload(first.job.seq).link, '');
  db.upsertApplicationStatus('42787', '제출완료');
  assert.equal(buildSheetRowPayload('42787').link, 'https://www.kofia.or.kr/brd/m_96/view.do?seq=42787');

  // 라우트: 같은 출처만 저장, 잘못된 입력은 400, 수정 화면용 GET은 직접 추가 공고만.
  const { GET, POST } = load('app/api/jobs/manual/route.ts');
  const post = (body, origin) => POST(new Request('http://localhost:3000/api/jobs/manual', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body),
  }));
  assert.equal((await post({ company: 'a', title: 't', content: 'c' }, 'https://evil.example')).status, 403);
  assert.equal((await post({ company: 'a', title: '', content: 'c' }, 'http://localhost:3000')).status, 400);
  assert.equal((await post({ seq: '42787', company: 'a', title: 't', content: 'c' }, 'http://localhost:3000')).status, 400);
  const got = await (await GET(new Request(`http://localhost:3000/api/jobs/manual?seq=${first.job.seq}`))).json();
  assert.equal(got.content, '바뀐 본문');
  assert.equal((await GET(new Request('http://localhost:3000/api/jobs/manual?seq=42787'))).status, 404);

  // 본문이 이미지인 공고: 조각 검증(형식은 파일 앞부분으로), 판독 호출, 링크 읽기의 본문 이미지.
  const { parsePostingImages, transcribePostingImages, postingImagePrompt } = load('lib/posting-image-text.ts');
  const jpeg = (width, height, size = 7000) => {
    const bytes = Buffer.alloc(size);
    bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255]);
    return bytes;
  };
  const slice = jpeg(1600, 2000).toString('base64');
  assert.equal(parsePostingImages({ images: [] }).ok, false);
  assert.equal(parsePostingImages({ images: [{ data: 'not base64!' }] }).ok, false);
  assert.equal(parsePostingImages({ images: [{ data: Buffer.from('<html>').toString('base64') }] }).ok, false, 'non-image bytes');
  assert.equal(parsePostingImages({ images: [{ data: jpeg(1600, 9000).toString('base64') }] }).ok, false, 'unsliced long image');
  assert.equal(parsePostingImages({ images: Array.from({ length: 21 }, () => ({ data: slice })) }).ok, false);
  const parsed = parsePostingImages({ images: [{ data: slice }, { data: slice }] });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.images[0].mediaType, 'image/jpeg');

  let sent;
  const fakeQuery = (result) => async function* (input) {
    sent = input;
    yield { type: 'result', subtype: 'success', is_error: false, result };
  };
  const text = await transcribePostingImages(parsed.images, { model: 'claude-sonnet-5-5', queryImpl: fakeQuery('```\n모집 부문: IB\n- 학사 이상\n```') });
  assert.equal(text, '모집 부문: IB\n- 학사 이상');
  assert.equal(sent.inputImages.length, 2);
  assert.deepEqual(sent.options.allowedTools, []);
  assert.equal(sent.prompt, postingImagePrompt(2));
  await assert.rejects(transcribePostingImages(parsed.images, { model: 'claude-sonnet-5-5', queryImpl: fakeQuery('  ') }), /읽지 못했습니다/);
  assert.ok(load('lib/ai-model-types.ts').AI_FEATURES.some((f) => f.id === 'postingImage'), 'model is chosen in settings');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/posting.jpg')) return new Response(jpeg(860, 9000, 9000), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    if (href.endsWith('/logo.png')) return new Response(jpeg(860, 9000), { status: 200 });
    return new Response('<html><head><title>2026 신입 공채</title></head><body><header><img src="/logo.png"></header><main><h1>공고</h1><img src="/posting.jpg" alt="채용공고"></main></body></html>',
      { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  };
  try {
    const { POST: READ } = load('app/api/jobs/manual/read/route.ts');
    const read = await (await READ(new Request('http://localhost:3000/api/jobs/manual/read', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://recruit.example.com/jobs/1' }),
    }))).json();
    assert.equal(read.ok, true);
    assert.equal(read.text, '', 'too little page text to use as body');
    assert.equal(read.title, '2026 신입 공채');
    assert.deepEqual(read.images.map((i) => i.url), ['https://recruit.example.com/posting.jpg'], 'body image only, chrome skipped');
    assert.equal(read.images[0].mediaType, 'image/jpeg');
  } finally {
    globalThis.fetch = realFetch;
  }

  console.log('PASS manual jobs: validation, manual seq, deadline override, edit without re-summarizing, stale match cleared, degraded summary stays visible, KOFIA posts not editable, research/sheet links, route guards, posting images (slice checks, transcription, body images from links)');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
