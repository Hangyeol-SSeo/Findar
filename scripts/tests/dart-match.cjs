const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

// DART 회사 매칭: 정확 일치 → 영문 약어를 한글로 바꾼 정확 일치 → DART 상호가 이 이름을 품은 비슷한 길이의 fuzzy.
// 이 이름 안에 짧은 DART 상호가 들어 있는 경우("DS투자증권" ⊃ "자")는 매칭하지 않는다.
const root = path.resolve(__dirname, '../..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-dart-test-'));
fs.mkdirSync(path.join(scratch, 'data'));
const entry = (corpCode, corpName) => ({ corpCode, corpName, normalizedName: corpName.replace(/\(주\)|㈜|주식회사|\s+/g, ''), stockCode: '' });
fs.writeFileSync(path.join(scratch, 'data', 'dart-corpcodes.json'), JSON.stringify({ fetchedAt: Date.now(), entries: [
  entry('01292741', '주식회사 자'), entry('00514381', '융'), entry('01415430', '케이앤씨'), entry('01000001', '디에스투자증권'),
  entry('01000002', '케이비증권'), entry('01000003', '한국자산평가'), entry('01000004', '한국금융투자협회'), entry('01000005', '마스터자산운용주식회사'),
  entry('01000006', '흥국증권 주식회사'), entry('01000007', '포트코리아자산운용'), entry('01000008', '코리아자산운용'), entry('01000009', 'KB자산운용'),
] }));
process.env.DART_API_KEY = 'test-key';
const cwd = process.cwd();
process.chdir(scratch);
const cache = new Map();
function load(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const mod = { exports: {} }; cache.set(file, mod);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('require', 'module', 'exports', code)((id) => id.startsWith('.') ? load(path.relative(root, path.resolve(path.dirname(file), id + '.ts'))) : require(id), mod, mod.exports);
  return mod.exports;
}
const { findCorpCode, hangulizeLatin } = load('lib/dart.ts');

(async () => {
  assert.equal(hangulizeLatin('DS투자증권'), '디에스투자증권');
  assert.equal(hangulizeLatin('IBK투자증권'), '아이비케이투자증권');
  assert.equal(hangulizeLatin('kb증권'), '케이비증권');
  const match = async (name) => { const m = await findCorpCode(name); return m && [m.corpName, m.confidence]; };
  assert.deepEqual(await match('흥국증권(주)'), ['흥국증권 주식회사', 'exact']);
  assert.deepEqual(await match('DS투자증권'), ['디에스투자증권', 'exact'], 'Latin acronyms match the Hangul DART name');
  assert.deepEqual(await match('KB증권'), ['케이비증권', 'exact']);
  assert.deepEqual(await match('케이비자산운용'), ['KB자산운용', 'exact'], 'and the other way round');
  // 이름 안에 짧은 DART 상호가 들어 있는 것은 매칭이 아니다.
  assert.equal(await match('에픽투자일임'), null, '"자" inside the name is not a match');
  assert.equal(await match('케이앤씨인베스트먼트'), null);
  // DART 상호가 이 이름을 품고 길이가 거의 같으면 fuzzy(리서치는 쓰지 않음). 너무 길면 매칭하지 않는다.
  assert.deepEqual(await match('금융투자협회'), ['한국금융투자협회', 'fuzzy']);
  assert.equal(await match('자산평'), null, 'a much longer DART name is not a fuzzy match');
  assert.deepEqual(await match('포트코리아자산운용'), ['포트코리아자산운용', 'exact'], 'exact wins over a shorter contained name');
  console.log('PASS DART matching: exact, Latin acronym → Hangul exact, near-length fuzzy only, no reverse substring');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { process.chdir(cwd); fs.rmSync(scratch, { recursive: true, force: true }); });
