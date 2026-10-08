const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// 이미 올린 과거 자료의 회사·직무를 나중에 고칠 때: 다시 분석하지 않고(AI 호출 없음) 추출 항목과 경험 카드 출처를 코드로 바꾸고,
// 카드 확인은 유지된다. 저장소 경로가 process.cwd() 기준이라 임시 폴더에서 불러온다.
const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-essay-meta-'));
process.chdir(work);
function compile(file, req) {
  const mod = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  return mod.exports;
}

const answer = '투자동아리에서 손실이 한도를 넘자 매매를 멈추고 종목별 손실 기여도를 정리했습니다.';
let calls = 0;
let blockSource = false, sourceReady;
const sdk = {
  query: async function* ({ prompt }) {
    calls++;
    if (blockSource && prompt.includes('{"entries"')) {
      const signal = aiOperation.getAIAbortSignal();
      sourceReady();
      await new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 20), { once: true }));
    }
    let result;
    if (prompt.includes('{"entries"')) result = { entries: [{ company: '', question: '지원 동기', answer, context: '2024 하반기' }] };
    else if (prompt.includes('{"cards"')) {
      const entryId = JSON.parse(prompt.slice(prompt.indexOf('[자료]') + 5, prompt.lastIndexOf('순수 JSON')).trim())[0].entryId;
      result = { cards: [{ event_id: 'a', period: '2024-03 ~ 2024-12', context: '투자동아리', personal_actions: ['종목별 손실 기여도를 정리함'], evidence: [{ entryId, quote: '종목별 손실 기여도를 정리했습니다' }] }] };
    } else result = { styleNotes: '', recurringThemes: [] };
    yield { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(result) };
  },
};
const contract = compile('lib/essay-contract.ts', require);
const sources = compile('lib/essay-sources.ts', require);
const aiOperation = compile('lib/ai-operation.ts', require);
const models = { getAIModelId: () => 'test-model' };
const bank = compile('lib/essay-bank.ts', (id) => ({ './ai-operation': aiOperation, './ai-query': sdk, './ai-model-settings': models, './essay-contract': contract, './essay-sources': sources }[id] ?? require(id)));
const cards = compile('lib/experience-cards.ts', (id) => ({
  './ai-operation': aiOperation, './ai-query': sdk, './ai-model-settings': models, './essay-bank': bank, './essay-contract': contract,
  './vendor-skills': { loadVendorSkills: () => ({ cards: 'skill' }) },
  './resume-inventory': { ensureResumeInventory: async () => null, getCachedResumeInventory: () => null },
  './resume-files': { listResumePdfs: () => [] },
  './applicant-profile': { readApplicantProfile: () => ({}) },
  './resume-tailoring-contract': { buildApplicantItems: () => [] },
}[id] ?? require(id)));

const status = (name) => bank.getEssaySourceStatus().find((f) => f.name === name);
const entryOf = () => bank.getCachedEssayBank().entries.find((e) => e.answer === answer);

(async () => {
  try {
    // 회사 없이 올린 예전 자료: 분석 후 회사를 알 수 없다고 표시된다.
    const name = sources.saveEssaySourceText('cover_letter', '예전 자소서', `Q. 지원 동기\nA. ${answer}`);
    await bank.ensureEssayBank();
    await cards.ensureExperienceCards();
    assert.equal(status(name).companyUnknown, true);
    const [card] = cards.getExperienceCardStatus().cards;
    cards.setCardConfirmed(card.id, true);
    assert.equal(cards.getExperienceCardStatus().stale, false);
    const before = calls;

    // 회사·직무를 적으면: 재분석 필요로 바뀌지 않고, 항목·카드 출처가 바로 바뀌며, 카드 확인은 유지된다.
    cards.syncCardOrigins(() => bank.setEssaySourceMeta('cover_letter', name, sources.parseEssaySourceMeta('가상방산', '임베디드 SW')));
    assert.equal(calls, before, 'no model call on a meta edit');
    assert.equal(status(name).status, 'ready');
    assert.equal(status(name).companyUnknown, false);
    assert.deepEqual({ company: entryOf().company, context: entryOf().context }, { company: '가상방산', context: '임베디드 SW 직무 지원 · 2024 하반기' });
    let after = cards.getExperienceCardStatus();
    assert.equal(after.stale, false, 'cards stay fresh, no rebuild needed');
    assert.deepEqual(after.cards[0].origins.map((o) => [o.company, o.context]), [['가상방산', '임베디드 SW 직무 지원 · 2024 하반기']]);
    assert.equal(cards.getConfirmedCards().length, 1, 'confirmation survives');

    // 직무를 바꾸면 이전 머리말이 쌓이지 않고 교체된다. 둘 다 비우면 모델이 읽은 값으로 돌아간다.
    cards.syncCardOrigins(() => bank.setEssaySourceMeta('cover_letter', name, sources.parseEssaySourceMeta('가상방산', '시스템 SW')));
    assert.equal(entryOf().context, '시스템 SW 직무 지원 · 2024 하반기');
    cards.syncCardOrigins(() => bank.setEssaySourceMeta('cover_letter', name, null));
    assert.deepEqual({ company: entryOf().company, context: entryOf().context }, { company: '', context: '2024 하반기' });
    assert.equal(sources.getEssaySourceMeta({ kind: 'cover_letter', name }), null);
    after = cards.getExperienceCardStatus();
    assert.equal(after.stale, false);
    assert.equal(after.cards[0].origins[0].company, '');
    assert.equal(calls, before);

    // 이 기능 전에 분석한 항목(extracted 없음)도 직무 머리말을 떼고 새 값으로 바꾼다.
    cards.syncCardOrigins(() => bank.setEssaySourceMeta('cover_letter', name, sources.parseEssaySourceMeta('가상방산', '임베디드 SW')));
    const bankPath = path.join(work, 'data', 'essay-bank.json');
    const stored = JSON.parse(fs.readFileSync(bankPath, 'utf8'));
    stored.entries.forEach((e) => { delete e.extracted; });
    fs.writeFileSync(bankPath, JSON.stringify(stored));
    cards.syncCardOrigins(() => bank.setEssaySourceMeta('cover_letter', name, sources.parseEssaySourceMeta('가상방산', '리스크관리')));
    assert.deepEqual({ company: entryOf().company, context: entryOf().context }, { company: '가상방산', context: '리스크관리 직무 지원 · 2024 하반기' });

    // 아직 분석하지 않은 파일은 값만 저장되고, 다음 분석이 그 값을 쓴다.
    const fresh = sources.saveEssaySourceText('interview', '면접', `Q. 자기소개\nA. ${answer}`);
    bank.setEssaySourceMeta('interview', fresh, sources.parseEssaySourceMeta('가상은행', ''));
    assert.equal(status(fresh).status, 'not-analyzed');
    assert.throws(() => bank.setEssaySourceMeta('interview', '없는 파일.txt', null), /찾을 수 없습니다/);

    // Cancelling source extraction must leave it retryable; a new caller arriving during cleanup starts fresh.
    const cancelController = new AbortController();
    blockSource = true;
    const startedSource = new Promise(resolve => sourceReady = resolve);
    const extraction = aiOperation.withAIAbortSignal(cancelController.signal, () => bank.ensureEssayBank());
    const cancelledExtraction = assert.rejects(extraction, { name: 'AbortError' });
    await startedSource;
    cancelController.abort();
    blockSource = false;
    assert.equal(status(fresh).status, 'not-analyzed', 'cancellation must not poison the file as a failed analysis');
    const replacementExtraction = bank.ensureEssayBank();
    await cancelledExtraction;
    await replacementExtraction;
    assert.equal(status(fresh).status, 'ready', 'new work recovers from cancelled shared extraction');

    console.log('PASS editing company/role of already-uploaded sources: no re-analysis or card rebuild, entries and card origins updated in place, confirmation kept, role prefix replaced, clearing restores model values, entries analyzed before this feature');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { fs.rmSync(work, { recursive: true, force: true }); }
})();
