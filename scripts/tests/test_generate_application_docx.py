import base64
import importlib.util
import io
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
import zipfile

spec = importlib.util.spec_from_file_location('generate_application', Path(__file__).parents[1] / 'generate-application-docx.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
NS = {'w': module.W}


class GenerateApplicationTests(unittest.TestCase):
    def test_ooxml_package_preserves_text_and_editable_layout(self):
        essay = '첫 번째 문단 <>& 😀\n\n둘째 문단입니다.'
        long_text = '긴 업무 내용입니다. ' * 1200
        payload = {'company': '테스트 회사', 'role': '분석', 'name': '지원자', 'contacts': ['candidate@example.test'], 'pages': [
            {'title': '입사지원서', 'blocks': [{'type': 'table', 'title': '경력', 'headers': ['기간', '회사', '직위', '담당업무'], 'widths': [18, 28, 20, 34], 'rows': [['2020-01 - 2021-01', '회사 A', '사원', long_text], ['2021-02 - 2022-02', '회사 B', '연구원', '다른 업무']]}]},
            {'title': '자기소개서', 'blocks': [{'type': 'entries', 'title': '', 'entries': [{'title': '지원동기', 'lines': [{'label': '', 'text': essay}]}]}]},
        ]}
        blob = base64.b64decode(module.generate(payload)['document'])
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            for path in archive.namelist():
                if path.endswith(('.xml', '.rels')):
                    ET.fromstring(archive.read(path))
            root = ET.fromstring(archive.read('word/document.xml'))
            text = '\n'.join(t.text or '' for t in root.findall('.//w:t', NS))
            self.assertIn(long_text, text)
            self.assertIn('첫 번째 문단 <>& 😀', text)
            self.assertIn('둘째 문단입니다.', text)
            work = next(t for t in root.findall('.//w:tbl', NS) if t.find('w:tblPr/w:tblCaption', NS).get(module.tag('val')) == 'findar_work_table')
            self.assertEqual(len(work.findall('w:tr', NS)), 3)
            self.assertEqual(len(root.findall('.//w:tblHeader', NS)), 1)
            self.assertEqual(len(root.findall('.//w:pageBreakBefore', NS)), 1)
            self.assertFalse(root.findall('.//w:br[@w:type="page"]', NS))
            self.assertFalse(root.findall('.//w:trHeight', NS))
            self.assertFalse(work.findall('w:tr', NS)[1].findall('w:trPr/w:cantSplit', NS))
            self.assertFalse(root.findall('.//w:drawing', NS))
            self.assertIn('candidate@example.test', text)
            self.assertNotIn('테스트 회사', ''.join(ET.fromstring(archive.read('word/header1.xml')).itertext()))
            self.assertIn('PAGE', archive.read('word/footer1.xml').decode())

    def test_reference_package_parts_and_geometry_remain_unchanged(self):
        payload = {'mode': 'blank', 'company': '[지원 회사]', 'role': '[지원 팀 또는 직무]', 'name': '[성명]', 'pages': [
            {'title': '입사지원서', 'blocks': []}, {'title': '경력 및 경험 상세', 'blocks': []}, {'title': '자기소개서', 'blocks': []},
        ]}
        with zipfile.ZipFile(module.TEMPLATE) as source, zipfile.ZipFile(io.BytesIO(base64.b64decode(module.generate(payload)['document']))) as output:
            self.assertEqual(set(source.namelist()), set(output.namelist()))
            editable = {'word/document.xml', 'word/header1.xml', 'word/footer1.xml', 'word/settings.xml'}
            for name in source.namelist():
                if name not in editable:
                    self.assertEqual(source.read(name), output.read(name), name)
            original = ET.fromstring(source.read('word/document.xml'))
            result = ET.fromstring(output.read('word/document.xml'))
            self.assertEqual(ET.tostring(original.find('w:body/w:sectPr', NS)), ET.tostring(result.find('w:body/w:sectPr', NS)))
            self.assertEqual(result.find('w:body/w:sectPr/w:pgSz', NS).get(module.tag('w')), '11906')
            self.assertIn('updateFields', output.read('word/settings.xml').decode())

    def test_company_and_team_are_prominent_in_body_not_header_only(self):
        payload = {'company': '지원 대상 회사', 'role': '리서치운용팀', 'applicationType': '신입', 'name': '지원자', 'contacts': [], 'personalRows': [['성명', '지원자', '연락처', '010-0000-0000'], ['이메일', 'candidate@example.test'], ['주소', '주소 원문']], 'pages': [{'title': '입사지원서', 'blocks': []}]}
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(module.generate(payload)['document']))) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
            paragraphs = root.findall('w:body/w:p', NS)
            self.assertEqual(''.join(paragraphs[0].itertext()), '입사지원서')
            tables = root.findall('w:body/w:tbl', NS)
            rows = tables[0].findall('w:tr', NS)
            self.assertEqual([''.join(c.itertext()) for c in rows[0].findall('w:tc', NS)], ['지원 회사', '지원 대상 회사'])
            self.assertEqual([''.join(c.itertext()) for c in rows[1].findall('w:tc', NS)], ['지원 부서', '리서치운용팀', '지원 구분', '신입'])
            self.assertEqual(rows[0].findall('w:tc', NS)[1].find('w:p/w:r/w:rPr/w:sz', NS).get(module.tag('val')), '22')
            self.assertEqual(len(tables[1].findall('w:tr', NS)), 3)
            self.assertIn('주소 원문', ''.join(tables[1].itertext()))
            self.assertFalse(root.findall('.//w:bookmarkStart', NS), 'authoring anchors must not be duplicated in generated text')

    def test_xml_invalid_controls_removed_without_dropping_korean_or_emoji(self):
        self.assertEqual(module.clean('한글\x00\x0b\n😀\t'), '한글\n😀\t')

    def test_long_resume_details_are_full_width_paragraphs(self):
        text = '긴 설명 원문을 넓은 문단에 보존합니다.'
        payload = {'company': '회사', 'role': '분석팀', 'name': '지원자', 'pages': [
            {'title': '입사지원서', 'blocks': [{'type': 'entries', 'title': '담당업무 상세', 'entries': [
                {'title': '회사 A', 'lines': [{'label': '담당업무', 'text': text + '\n다음 문단 원문 끝'}]},
            ]}]},
        ]}
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(module.generate(payload)['document']))) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
            paragraphs = root.findall('w:body/w:p', NS)
            self.assertTrue(any(text in ''.join(p.itertext()) for p in paragraphs))
            continuation = next(p for p in paragraphs if ''.join(p.itertext()) == '다음 문단 원문 끝')
            self.assertEqual(continuation.find('w:r/w:rPr/w:b', NS).get(module.tag('val')), '0')
            self.assertFalse(any(text in ''.join(t.itertext()) for t in root.findall('w:body/w:tbl', NS)))


if __name__ == '__main__':
    unittest.main()
