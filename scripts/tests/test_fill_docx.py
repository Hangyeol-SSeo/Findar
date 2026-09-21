import base64
import importlib.util
import io
from pathlib import Path
import unittest
import zipfile
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('fill_docx', Path(__file__).parents[1] / 'fill-docx.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
W = module.W

def fixture():
    xml = f'''<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="{W}"><w:body><w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>성명</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="2000"/></w:tcPr><w:p/></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>연락처</w:t></w:r></w:p></w:tc><w:tc><w:p><w:pPr/><w:r><w:rPr><w:sz w:val="22"/></w:rPr></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>기존 값</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>보존</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl></w:body></w:document>'''
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z:
        z.writestr('word/document.xml', xml)
        z.writestr('word/styles.xml', '<styles>original</styles>')
        z.writestr('word/media/logo.png', b'unchanged-image')
    return base64.b64encode(b.getvalue()).decode()

class FillDocxTests(unittest.TestCase):
    def test_empty_paragraphs_and_existing_text(self):
        result = module.process({'document': fixture()})
        self.assertEqual([t['label'] for t in result['targets']], ['성명', '연락처'])

    def test_fills_exact_cells_and_preserves_other_entries(self):
        original = fixture()
        scan = module.process({'document': original})
        result = module.process({'document': original, 'assignments': [
            {'targetId': scan['targets'][0]['id'], 'value': '홍길동 & 이름'},
            {'targetId': scan['targets'][1]['id'], 'value': '첫 줄\n둘째 줄'},
        ]})
        self.assertEqual(result['filled'], 2)
        with zipfile.ZipFile(io.BytesIO(base64.b64decode(result['document']))) as z:
            root = ET.fromstring(z.read('word/document.xml'))
            text = ''.join(root.itertext())
            self.assertIn('홍길동 & 이름', text)
            self.assertIn('보존', text)
            self.assertEqual(len(root.findall('.//w:br', module.NS)), 1)
            self.assertEqual(z.read('word/styles.xml'), b'<styles>original</styles>')
            self.assertEqual(z.read('word/media/logo.png'), b'unchanged-image')

    def test_invalid_target_rejected(self):
        with self.assertRaises(ValueError):
            module.process({'document': fixture(), 'assignments': [{'targetId': 'unknown', 'value': 'x'}]})

    def test_duplicate_target_rejected(self):
        scan = module.process({'document': fixture()})
        a = {'targetId': scan['targets'][0]['id'], 'value': 'x'}
        with self.assertRaises(ValueError): module.process({'document': fixture(), 'assignments': [a, a]})


class StructuredTableTests(unittest.TestCase):
    def document(self, content):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('word/document.xml', f'<w:document xmlns:w="{W}"><w:body>{content}</w:body></w:document>')
        return base64.b64encode(out.getvalue()).decode()

    def test_grid_span_and_vertical_header_repeated_rows(self):
        doc = self.document('''<w:tbl><w:tr>
<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>학 력</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:gridSpan w:val="3"/></w:tcPr><w:p><w:r><w:t>학교명</w:t></w:r></w:p></w:tc>
<w:tc><w:p><w:r><w:t>전공</w:t></w:r></w:p></w:tc></w:tr>''' + '''<w:tr>
<w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc>
<w:tc><w:tcPr><w:gridSpan w:val="3"/></w:tcPr><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr>''' * 2 + '</w:tbl>')
        targets = module.process({'document': doc})['targets']
        self.assertEqual([(t['label'], t['rowIndex']) for t in targets], [('학교명', 0), ('전공', 0), ('학교명', 1), ('전공', 1)])
        self.assertTrue(all(t['section'] == '학력' for t in targets))

    def test_merged_input_start_and_inline_phone(self):
        doc = self.document('''<w:tbl><w:tr>
<w:tc><w:p><w:r><w:t>E-Mail</w:t></w:r></w:p></w:tc>
<w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p/></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>(휴대폰)</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>''')
        targets = module.process({'document': doc})['targets']
        self.assertEqual([t['label'] for t in targets], ['E-Mail', '(휴대폰)'])
        result = module.process({'document': doc, 'assignments': [{'targetId': targets[1]['id'], 'value': '010-0000-0000'}]})
        xml = zipfile.ZipFile(io.BytesIO(base64.b64decode(result['document']))).read('word/document.xml')
        self.assertIn('(휴대폰) 010-0000-0000', ''.join(ET.fromstring(xml).itertext()))

    def test_shared_header_across_certification_and_language_sections(self):
        def cell(text='', merge=None):
            pr = '<w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' if merge else ''
            return f'<w:tc>{pr}<w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:tc>'
        doc = self.document('<w:tbl><w:tr>' + cell('자격사항', True) + cell('구분') + cell('취득일') + '</w:tr><w:tr>' + cell('외국어능력', True) + cell() + cell() + '</w:tr></w:tbl>')
        targets = module.process({'document': doc})['targets']
        self.assertEqual([(t['section'], t['label'], t['rowIndex']) for t in targets], [('외국어능력', '구분', 0), ('외국어능력', '취득일', 0)])

    def test_nested_table_offsets_and_essay_heading(self):
        doc = self.document('''<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p><w:r><w:t>성명</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>자 기 소 개 서</w:t></w:r></w:p><w:p/><w:p/><w:p><w:r><w:t>개인정보 동의서</w:t></w:r></w:p><w:p/>''')
        targets = module.process({'document': doc})['targets']
        self.assertEqual(len(targets), 2)
        result = module.process({'document': doc, 'assignments': [{'targetId': t['id'], 'value': '홍길동' if i == 0 else '지원 동기\n두 번째 문단'} for i, t in enumerate(targets)]})
        xml = zipfile.ZipFile(io.BytesIO(base64.b64decode(result['document']))).read('word/document.xml')
        root = ET.fromstring(xml)
        self.assertEqual(len(root.findall('.//w:tbl', module.NS)), 2)
        self.assertIn('두 번째 문단', ''.join(root.itertext()))
        self.assertEqual(len(module.process({'document': result['document']})['targets']), 0)

if __name__ == '__main__': unittest.main()
