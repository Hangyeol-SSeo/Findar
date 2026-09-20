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

if __name__ == '__main__': unittest.main()
