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


class PlaceholderAndChoiceTests(unittest.TestCase):
    def document(self, content):
        out = io.BytesIO()
        with zipfile.ZipFile(out, 'w') as z:
            z.writestr('word/document.xml', f'<w:document xmlns:w="{W}"><w:body>{content}</w:body></w:document>')
        return base64.b64encode(out.getvalue()).decode()

    def cell(self, text='', span=None, fill=None):
        pr = ''.join([f'<w:gridSpan w:val="{span}"/>' if span else '', f'<w:shd w:fill="{fill}"/>' if fill else ''])
        body = f'<w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>{text}</w:t></w:r>' if text else ''
        return f'<w:tc><w:tcPr>{pr}</w:tcPr><w:p>{body}</w:p></w:tc>'

    def result_text(self, doc, assignments):
        result = module.process({'document': doc, 'assignments': assignments})
        xml = zipfile.ZipFile(io.BytesIO(base64.b64decode(result['document']))).read('word/document.xml')
        ET.fromstring(xml)
        return ''.join(ET.fromstring(xml).itertext()), xml.decode()

    def test_banner_sections_number_the_repeated_blocks(self):
        row = lambda *cells: '<w:tr>' + ''.join(cells) + '</w:tr>'
        doc = self.document('<w:tbl>' + row(self.cell('> 경력사항 1', 4)) + row(self.cell('회사명'), self.cell(), self.cell('직위'), self.cell())
                            + row(self.cell('> 경력사항 2', 4)) + row(self.cell('회사명'), self.cell(), self.cell('직위'), self.cell()) + '</w:tbl>')
        targets = module.process({'document': doc})['targets']
        self.assertEqual([(t['section'], t['rowIndex'], t['label']) for t in targets], [('경력사항', 0, '회사명'), ('경력사항', 0, '직위'), ('경력사항', 1, '회사명'), ('경력사항', 1, '직위')])

    def test_date_skeleton_placeholder_is_replaced_and_style_kept(self):
        doc = self.document('<w:tbl><w:tr>' + self.cell('재학기간') + self.cell('년   월 ~     년   월      □ 현재 재직 중') + '</w:tr></w:tbl>')
        target = module.process({'document': doc})['targets'][0]
        self.assertEqual((target['mode'], target['placeholder']), ('replace', '년   월 ~     년   월'))
        text, xml = self.result_text(doc, [{'targetId': target['id'], 'value': '2015년 03월 ~ 2018년 02월'}])
        self.assertIn('2015년 03월 ~ 2018년 02월      □ 현재 재직 중', text)
        self.assertIn('<w:sz w:val="20"/>', xml)

    def test_real_values_are_never_treated_as_placeholders(self):
        doc = self.document('<w:tbl><w:tr>' + self.cell('학교명') + self.cell('서울대학교') + self.cell('기간') + self.cell('2015.03 ~ 2018.02') + '</w:tr></w:tbl>')
        self.assertEqual(module.process({'document': doc})['targets'], [])

    def test_choice_cells_mark_the_selected_option(self):
        doc = self.document('<w:tbl><w:tr>' + self.cell('성별') + self.cell('□ 남 □ 여') + self.cell('회화') + self.cell('상 / 중 / 하') + '</w:tr></w:tbl>')
        targets = module.process({'document': doc})['targets']
        self.assertEqual([(t['label'], t['type'], t['options']) for t in targets], [('성별', 'choice', ['남', '여']), ('회화', 'choice', ['상', '중', '하'])])
        text, xml = self.result_text(doc, [{'targetId': targets[0]['id'], 'value': '남'}, {'targetId': targets[1]['id'], 'value': '중'}])
        self.assertIn('■ 남 □ 여', text)
        self.assertIn('<w:b/>', xml)
        with self.assertRaises(ValueError):
            module.process({'document': doc, 'assignments': [{'targetId': targets[0]['id'], 'value': '기타'}]})

    def test_shaded_label_cells_and_consent_boxes_are_not_choices(self):
        doc = self.document('<w:tbl><w:tr>' + self.cell('신입 / 경력', fill='D9D9D9') + self.cell() + self.cell('동의 □ 거부 □') + '</w:tr></w:tbl>')
        self.assertEqual([t['label'] for t in module.process({'document': doc})['targets']], ['신입 / 경력'])

    def test_header_row_table_gets_section_and_row_numbers(self):
        row = lambda *cells: '<w:tr>' + ''.join(cells) + '</w:tr>'
        doc = self.document('<w:tbl>' + row(self.cell('입학년월'), self.cell('학교'), self.cell('전공'), self.cell('졸업구분'))
                            + row(self.cell('년 월'), self.cell('고등학교'), self.cell(), self.cell())
                            + row(self.cell('년 월'), self.cell('대학교'), self.cell(), self.cell()) + '</w:tbl>')
        targets = module.process({'document': doc})['targets']
        self.assertTrue(all(t['section'] == '학력' for t in targets))
        self.assertEqual([(t['rowIndex'], t['label'], t.get('heading')) for t in targets][:4], [(0, '입학년월', '고등학교'), (0, '학교', '고등학교'), (0, '전공', '고등학교'), (0, '졸업구분', '고등학교')])
        self.assertEqual({t['heading'] for t in targets[4:]}, {'대학교'})

if __name__ == '__main__': unittest.main()
