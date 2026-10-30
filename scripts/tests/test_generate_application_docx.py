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
            {'title': '입사지원서', 'blocks': [{'type': 'table', 'title': '경력', 'headers': ['기간', '회사', '직위'], 'widths': [22, 50, 28], 'rows': [['2020-01 - 2021-01', '회사 A', long_text], ['2021-02 - 2022-02', '회사 B', '다른 업무']]}]},
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
            self.assertEqual(len(root.findall('.//w:tr', NS)), 3)
            self.assertEqual(len(root.findall('.//w:tblHeader', NS)), 1)
            self.assertEqual(len(root.findall('.//w:pageBreakBefore', NS)), 1)
            self.assertFalse(root.findall('.//w:br[@w:type="page"]', NS))
            self.assertFalse(root.findall('.//w:trHeight', NS))
            self.assertFalse(root.findall('.//w:tr', NS)[1].findall('w:trPr/w:cantSplit', NS))
            self.assertFalse(root.findall('.//w:drawing', NS))
            self.assertIn('candidate@example.test', text)
            self.assertIn('테스트 회사', ''.join(ET.fromstring(archive.read('word/header1.xml')).itertext()))
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
            # Blank output uses the current designed template's exact elements.
            self.assertEqual(ET.tostring(original), ET.tostring(result))
            self.assertIn('updateFields', output.read('word/settings.xml').decode())

    def test_company_and_team_are_prominent_in_body_not_header_only(self):
        payload = {'company': '지원 대상 회사', 'role': '리서치운용팀', 'name': '지원자', 'contacts': [], 'pages': [{'title': '입사지원서', 'blocks': []}]}
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(module.generate(payload)['document']))) as archive:
            root = ET.fromstring(archive.read('word/document.xml'))
            paragraphs = root.findall('w:body/w:p', NS)
            self.assertEqual(''.join(paragraphs[1].itertext()), '지원 대상 회사')
            self.assertIn('리서치운용팀', ''.join(paragraphs[2].itertext()))
            self.assertEqual(paragraphs[1].find('w:r/w:rPr/w:sz', NS).get(module.tag('val')), '44')
            self.assertEqual(paragraphs[2].findall('w:r', NS)[-1].find('w:rPr/w:sz', NS).get(module.tag('val')), '28')
            self.assertIn('지원자', ''.join(paragraphs[3].itertext()))
            self.assertFalse(root.findall('.//w:bookmarkStart', NS), 'authoring anchors must not be duplicated in generated text')

    def test_xml_invalid_controls_removed_without_dropping_korean_or_emoji(self):
        self.assertEqual(module.clean('한글\x00\x0b\n😀\t'), '한글\n😀\t')


if __name__ == '__main__':
    unittest.main()
