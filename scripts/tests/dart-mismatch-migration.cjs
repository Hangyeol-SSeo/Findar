const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// 예전 fuzzy DART 매칭으로 만든 지배구조·재무 분석은 partial로 낮추고 안내를 붙여 새로고침 대상으로 돌린다. 매칭은 지운다.
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-dart-mismatch-test-'));
const originalCwd = process.cwd();
function freshDb() {
  const modules = new Map();
  function load(relative) {
    const filename = path.resolve(root, relative);
    if (modules.has(filename)) return modules.get(filename).exports;
    const mod = { exports: {} };
    modules.set(filename, mod);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const req = (id) => id.startsWith('@/') ? load(id.slice(2) + '.ts') : id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(filename), id + '.ts'))) : require(id);
    new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
    return mod.exports;
  }
  return load('lib/db.ts');
}

try {
  process.chdir(scratch);
  const log = console.log; console.log = () => {};
  const first = freshDb();
  first.upsertCompanySeen('DS투자증권'); first.upsertCompanySeen('흥국증권'); first.upsertCompanySeen('예시투자일임');
  first.setCompanyDartMatch('DS투자증권', '01292741', 'fuzzy');
  first.setCompanyDartMatch('흥국증권', '00380836', 'exact');
  first.setCompanyDartMatch('예시투자일임', '01000004', 'fuzzy');
  const section = (content, contentJson) => ({ content, contentJson, sources: [], model: 'm', status: 'ok' });
  first.saveCompanySection('DS투자증권', 'governance_structure', section('대표이사는 이춘모입니다.', { overview: { ceoName: '이춘모' }, executives: [] }));
  first.saveCompanySection('DS투자증권', 'overview', section('개요', { basis: { homepage: null, dart: false, postings: 1 } }));
  first.saveCompanySection('흥국증권', 'governance_structure', section('흥국증권 지배구조', { overview: {}, executives: [] }));
  first.saveCompanySection('예시투자일임', 'governance_structure', section('새 방식 분석', { overview: null, executives: [], dartMatch: 'none' }));
  const db = freshDb();
  console.log = log;
  const gov = db.getCompanySections('DS투자증권').find((s) => s.sectionType === 'governance_structure');
  assert.equal(gov.status, 'partial');
  assert.ok(gov.content.startsWith(db.DART_MISMATCH_NOTICE) && gov.content.endsWith('대표이사는 이춘모입니다.'));
  assert.equal(db.getCompanySections('DS투자증권').find((s) => s.sectionType === 'overview').status, 'ok', 'overview/culture never used fuzzy DART data');
  assert.equal(db.getCompanySections('흥국증권')[0].status, 'ok', 'exact matches are untouched');
  assert.equal(db.getCompanySections('예시투자일임')[0].status, 'ok', 'sections made by the new code carry dartMatch and are untouched');
  assert.equal(db.getCompany('DS투자증권').dartCorpCode, null);
  assert.equal(db.getCompany('흥국증권').dartCorpCode, '00380836');
  // 다시 실행해도 안내가 겹치지 않는다.
  freshDb();
  const again = freshDb().getCompanySections('DS투자증권').find((s) => s.sectionType === 'governance_structure');
  assert.equal(again.content.split(db.DART_MISMATCH_NOTICE).length, 2);
  console.log('PASS fuzzy DART sections marked for re-research once, exact/new sections untouched, fuzzy matches cleared');
} finally {
  process.chdir(originalCwd);
  fs.rmSync(scratch, { recursive: true, force: true });
}
