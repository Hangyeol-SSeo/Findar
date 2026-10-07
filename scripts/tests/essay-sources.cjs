const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

// 저장소 경로가 process.cwd() 기준이라 임시 폴더에서 불러온다.
const root = path.resolve(__dirname, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'findar-essay-sources-'));
process.chdir(work);
const mod = { exports: {} };
const code = ts.transpileModule(fs.readFileSync(path.join(root, 'lib/essay-sources.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('require', 'module', 'exports', code)(require, mod, mod.exports);
const S = mod.exports;

try {
  assert.equal(S.sanitizeEssaySourceName('../../etc/OO증권 자소서.docx', '.txt'), 'OO증권 자소서.txt');
  assert.equal(S.sanitizeEssaySourceName('a<b>:c?.pdf', '.pdf'), 'abc.pdf');
  assert.equal(S.sanitizeEssaySourceName('...', '.txt'), '자료.txt');

  const docxXml = '<w:document><w:body><w:p><w:r><w:t>Q. 지원 동기</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">저는 </w:t></w:r><w:r><w:t>위험을 &amp; 수익을</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>봅니다.</w:t></w:r></w:p></w:body></w:document>';
  assert.equal(S.xmlParagraphsToText(docxXml, 'w'), 'Q. 지원 동기\n저는 위험을 & 수익을\n봅니다.');

  // 실제 zip 구조로 DOCX·HWPX를 만들어 업로드 경로 전체를 확인한다.
  const build = (name, entries) => {
    const dir = fs.mkdtempSync(path.join(work, 'zip-'));
    for (const [entry, content] of Object.entries(entries)) {
      fs.mkdirSync(path.join(dir, path.dirname(entry)), { recursive: true });
      fs.writeFileSync(path.join(dir, entry), content);
    }
    const out = path.join(work, name);
    execFileSync('zip', ['-qr', out, '.'], { cwd: dir });
    return new Uint8Array(fs.readFileSync(out));
  };
  const docx = build('a.docx', { 'word/document.xml': docxXml, '[Content_Types].xml': '<Types/>' });
  assert.equal(S.saveEssaySourceFile('cover_letter', '2024 OO증권.docx', docx), '2024 OO증권.txt');
  const hwpx = build('b.hwpx', {
    'Contents/section1.xml': '<hs:sec><hp:p><hp:run><hp:t>둘째 구역</hp:t></hp:run></hp:p></hs:sec>',
    'Contents/section0.xml': '<hs:sec><hp:p><hp:run><hp:t>첫째<hp:tab/>구역</hp:t></hp:run></hp:p></hs:sec>',
  });
  assert.equal(S.saveEssaySourceFile('interview', '면접.hwpx', hwpx), '면접.txt');

  const files = S.listEssaySources();
  assert.deepEqual(files.map((f) => `${f.kind}/${f.name}`), ['cover_letter/2024 OO증권.txt', 'interview/면접.txt']);
  assert.equal(fs.readFileSync(files[0].path, 'utf8'), 'Q. 지원 동기\n저는 위험을 & 수익을\n봅니다.');
  assert.equal(fs.readFileSync(files[1].path, 'utf8'), '첫째\t구역\n\n둘째 구역', 'HWPX sections must be read in section order');

  assert.throws(() => S.saveEssaySourceFile('cover_letter', 'x.pdf', new TextEncoder().encode('not a pdf')), /PDF 파일이 아닙니다/);
  assert.throws(() => S.saveEssaySourceFile('cover_letter', 'x.hwp', new Uint8Array([1])), /HWP/);
  assert.throws(() => S.saveEssaySourceFile('cover_letter', 'x.exe', new Uint8Array([1])), /만 올릴 수 있습니다/);
  assert.throws(() => S.saveEssaySourceFile('cover_letter', 'broken.docx', new Uint8Array([1, 2, 3])), /PDF로 저장해/);
  assert.equal(S.saveEssaySourceFile('cover_letter', 'real.pdf', new TextEncoder().encode('%PDF-1.4 ...')), 'real.pdf');

  assert.equal(S.saveEssaySourceText('interview', '', 'Q. 자기소개\nA. 안녕하십니까.').startsWith('붙여넣기 '), true);
  assert.throws(() => S.saveEssaySourceText('interview', '빈 글', '   '), /붙여넣을 내용/);

  // 같은 이름+내용이면 해시가 같고, 내용이 바뀌면 달라진다(재분석 여부의 기준).
  const before = S.hashEssaySource(S.listEssaySources('cover_letter').find((f) => f.name === 'real.pdf'));
  S.saveEssaySourceFile('cover_letter', 'real.pdf', new TextEncoder().encode('%PDF-1.4 changed'));
  assert.notEqual(S.hashEssaySource(S.listEssaySources('cover_letter').find((f) => f.name === 'real.pdf')), before);

  // 사용자가 적은 회사·직무: 파일별로 저장되고, 바뀌면 해시가 달라져 다시 분석되며, 파일을 지우면 함께 지워진다.
  assert.equal(S.parseEssaySourceMeta('  ', ''), null);
  assert.deepEqual({ ...S.parseEssaySourceMeta(' 가상방산 ', '임베디드  SW') }, { company: '가상방산', role: '임베디드 SW' });
  const metaName = S.saveEssaySourceText('cover_letter', '방산 지원서', '지원 동기 본문', S.parseEssaySourceMeta('가상방산', '임베디드 SW'));
  const metaFile = () => S.listEssaySources('cover_letter').find((f) => f.name === metaName);
  assert.equal(S.getEssaySourceMeta(metaFile()).company, '가상방산');
  const metaHash = S.hashEssaySource(metaFile());
  S.saveEssaySourceText('cover_letter', '방산 지원서', '지원 동기 본문', null);
  assert.equal(S.getEssaySourceMeta(metaFile()).company, '가상방산', 're-upload without meta keeps the recorded company');
  S.saveEssaySourceText('cover_letter', '방산 지원서', '지원 동기 본문', S.parseEssaySourceMeta('가상방산', '시스템 SW'));
  assert.notEqual(S.hashEssaySource(metaFile()), metaHash, 'changing the role re-analyzes the file');
  assert.equal(S.deleteEssaySource('cover_letter', metaName), true);
  assert.equal(S.getEssaySourceMeta({ kind: 'cover_letter', name: metaName }), null);

  assert.equal(S.deleteEssaySource('cover_letter', '../interviews/면접.txt'), false, 'path traversal must not delete');
  assert.equal(S.deleteEssaySource('interview', '면접.txt'), true);
  assert.equal(S.listEssaySources('interview').some((f) => f.name === '면접.txt'), false);

  console.log('PASS user-entered company/role metadata, name sanitizing, DOCX/HWPX text extraction (entities, breaks, tabs, section order), PDF magic check, unsupported formats, paste, content hash, safe delete');
} finally {
  process.chdir(root);
  fs.rmSync(work, { recursive: true, force: true });
}
