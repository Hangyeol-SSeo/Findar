"""Conservative DOCX table filling. Only document.xml is patched; all other ZIP entries are copied.
stdin JSON: {document: base64, assignments?: [{targetId,value}]}. stdout JSON.
No files or user data are retained on disk.
"""
import base64
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.parsers import expat
from xml.sax.saxutils import escape

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}


# --- 서식에 미리 적힌 안내문(placeholder), 선택지, 소제목 줄을 알아보는 규칙 ---------------------------
CHECKS = '□☐■☑✔✓'
BANNER = re.compile(r'^[※>▶▷■●◆◇◈▣○]+\s*(?P<body>\S.*)$')
DATE_SKELETON = re.compile(r'년\s*월(?:\s*일)?(?:\s*[~\-–]\s*년\s*월(?:\s*일)?)?')
SCHOOL_HINT = re.compile(r'^(?:고등학교|대학교|\(전문\)대학|전문대학|대학원|대학)$')
UNIT_HINT = re.compile(r'^(?:백?만원|원)(?:\s*\(.*\))?$')
GRADE_HINT = re.compile(r'^/\s*(?:\d+(?:\.\d+)?|\(\s*평점\s*/\s*만점\s*\))?$')
INPUT_HINT = re.compile(r'^\(\s*[^()]*(?:입력|단위|기재|작성)[^()]*\)$')
OPTION_VOCAB = {'상', '중', '하', 'Y', 'N', '신입', '경력', '필', '미필', '면제', '군필', '대상', '비대상', '남', '여', '만기', '의가사',
                '정규', '계약', '인턴', '해당', '비해당', '유', '무', '있음', '없음', '부장', '차장', '과장', '대리', '사원'}
CONSENT_WORDS = re.compile(r'동의|거부|서명|인증')

def classify_filled_cell(text):
    """미리 글이 적힌 칸이 '안내문/선택지'일 때만 입력 대상으로 인정한다. 그 외 기존 값은 그대로 둔다."""
    t = text.strip()
    boxes = re.findall('[' + CHECKS + ']', t)
    if len(boxes) >= 2:
        options = [x.strip() for x in re.split('[' + CHECKS + ']', t) if x.strip()]
        if len(options) >= 2 and all(len(o) <= 12 for o in options) and not CONSENT_WORDS.search(t):
            return {'mode': 'choice', 'options': options, 'style': 'box'}
    if not boxes:
        tokens = [x for x in re.split(r'\s*/\s*|\s+', t) if x]
        if 2 <= len(tokens) <= 6 and len(set(tokens)) == len(tokens) and all(x in OPTION_VOCAB for x in tokens):
            return {'mode': 'choice', 'options': tokens, 'style': 'token'}
    if re.search(r'\d', DATE_SKELETON.sub('', t)):
        return None
    skeleton = DATE_SKELETON.search(t)
    if skeleton and not re.sub(r'[\s~\-–]', '', t.replace(skeleton.group(), '').replace('재직 중', '').replace('현재', '')).strip(CHECKS):
        return {'mode': 'replace', 'sub': skeleton.group()}
    if SCHOOL_HINT.match(t) or UNIT_HINT.match(t) or GRADE_HINT.match(t) or INPUT_HINT.match(t):
        return {'mode': 'replace', 'sub': t}
    return None

DATA_SECTION = re.compile(r'학력|경력|자격|어학|외국어|수상|병역|활동|프로젝트|연구')
SECTION_KEYWORDS = [
    ('학력', ('학교', '전공', '입학', '졸업', '학점', '소재지', '학위')),
    ('경력', ('회사', '직장', '근무', '담당업무', '직위', '퇴직', '퇴사', '연봉')),
    ('자격사항', ('자격', '면허', '취득', '인증기관', '발급')),
    ('외국어능력', ('어학', '점수', '시험', '언어', '등급')),
    ('수상내역', ('수상', '포상', '표창')),
]

def infer_section(texts):
    """열 제목(학교명·전공·…)만 보고 표가 어떤 반복 구역인지 추정한다. 두 개 이상 맞을 때만 인정."""
    joined = ' '.join(texts)
    scored = sorted(((sum(k in joined for k in keys), name) for name, keys in SECTION_KEYWORDS), reverse=True)
    return scored[0][1] if scored[0][0] >= 2 and scored[0][0] > scored[1][0] else ''

def datalike(texts):
    """입력 줄: 빈 칸 또는 안내문(placeholder)·선택지뿐인 줄."""
    cleaned = [t for t in texts]
    return any(not t or classify_filled_cell(t) for t in cleaned) and all(not t or classify_filled_cell(t) or SCHOOL_HINT.match(t) for t in cleaned)

def banner_info(text, cells_count):
    """한 줄 소제목(※ 학력사항, > 경력사항 2 …)에서 구역 이름과 반복 번호를 뽑는다."""
    match = BANNER.match(text.strip())
    if not match or cells_count != 1:
        return None
    body = re.sub(r'\*+', '', match.group('body')).strip()
    number = re.search(r'(\d+)\s*$', body)
    name = re.sub(r'\s*\d+\s*$', '', body).strip()
    return {'name': name if DATA_SECTION.search(name) else '', 'index': int(number.group(1)) - 1 if number else None, 'heading': body}


RPR_LATE = r'(?=<w:(?:effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout|specVanish|oMath)\b)|(?=</w:rPr>)'

def emphasized(rpr):
    """선택한 항목을 굵게+밑줄로 표시한다 (□ 상자가 없는 '상 / 중 / 하' 같은 칸)."""
    if not rpr:
        return '<w:rPr><w:b/><w:u w:val="single"/></w:rPr>'
    rpr = re.sub(r'<w:(?:b|bCs|u)(?:\s[^>]*)?/>', '', rpr)
    fonts = re.search(r'<w:rFonts\b[^>]*/>', rpr)
    rpr = rpr[:fonts.end()] + '<w:b/>' + rpr[fonts.end():] if fonts else rpr.replace('<w:rPr>', '<w:rPr><w:b/>', 1)
    late = re.search(RPR_LATE, rpr)
    return rpr[:late.start()] + '<w:u w:val="single"/>' + rpr[late.start():]

def rewrite_first_text_paragraph(cell, pieces):
    """셀의 첫 글자 문단을 pieces[(text, emphasize)]로 다시 쓴다. 문단 서식과 첫 글자 서식은 유지한다."""
    paragraphs = list(re.finditer(r'<w:p(?:\s[^>]*)?>[\s\S]*?</w:p>', cell))
    target = next((m for m in paragraphs if '<w:t' in m.group()), None)
    if target is None:
        raise ValueError('입력할 문단을 찾지 못했습니다.')
    paragraph = target.group()
    opening = re.match(r'<w:p(?:\s[^>]*)?>', paragraph).group()
    ppr = re.search(r'<w:pPr>[\s\S]*?</w:pPr>|<w:pPr/>', paragraph)
    first_run = re.search(r'<w:r(?:\s[^>]*)?>\s*(<w:rPr>[\s\S]*?</w:rPr>)', paragraph)
    base = first_run.group(1) if first_run else ''
    runs = ''
    for text, emphasize in pieces:
        if not text:
            continue
        runs += '<w:r>' + (emphasized(base) if emphasize else base) + '<w:t xml:space="preserve">' + escape(text) + '</w:t></w:r>'
    return cell[:target.start()] + opening + (ppr.group() if ppr else '') + runs + '</w:p>' + cell[target.end():]

def apply_special(cell, original_text, extra, value):
    if extra['mode'] == 'replace':
        return rewrite_first_text_paragraph(cell, [(original_text.replace(extra['sub'], value.replace('\n', ' '), 1), False)])
    if value not in extra['options']:
        raise ValueError('선택지에 없는 값입니다.')
    if extra['style'] == 'box':
        text, count = re.subn('[□☐]\\s*(?=' + re.escape(value) + ')', lambda m: '■' + m.group()[1:], original_text, count=1)
        if not count:
            raise ValueError('선택지를 찾지 못했습니다.')
        return rewrite_first_text_paragraph(cell, [(text, False)])
    match = re.search(r'(?<![가-힣A-Za-z])' + re.escape(value) + r'(?![가-힣A-Za-z])', original_text)
    if not match:
        raise ValueError('선택지를 찾지 못했습니다.')
    return rewrite_first_text_paragraph(cell, [(original_text[:match.start()], False), (value, True), (original_text[match.end():], False)])

def process(payload):
    blob = base64.b64decode(payload['document'], validate=True)
    if len(blob) > 10 * 1024 * 1024:
        raise ValueError('DOCX는 10MB 이하만 지원합니다.')
    source = zipfile.ZipFile(io.BytesIO(blob))
    entries = source.infolist()
    if len(entries) > 2000 or sum(e.file_size for e in entries) > 50 * 1024 * 1024:
        raise ValueError('압축 해제 크기가 너무 큰 파일입니다.')
    if len({e.filename for e in entries}) != len(entries):
        raise ValueError('중복된 문서 항목이 있습니다.')
    if any(e.filename.lower().endswith('.bin') for e in entries):
        raise ValueError('매크로나 삽입 개체가 있는 문서는 지원하지 않습니다.')
    xml = source.read('word/document.xml').decode('utf-8')
    if '<!DOCTYPE' in xml or '<!ENTITY' in xml:
        raise ValueError('지원하지 않는 XML 문서입니다.')
    ET.fromstring(xml)
    # Keep namespace declarations, compatibility attributes, images, styles, etc. byte-for-byte.
    if f'xmlns:w="{W}"' not in xml and f"xmlns:w='{W}'" not in xml:
        raise ValueError('이 Word 문서 형식은 지원하지 않습니다. Word에서 DOCX로 다시 저장해주세요.')
    if 'word/settings.xml' in source.namelist():
        settings = ET.fromstring(source.read('word/settings.xml'))
        if settings.find('w:documentProtection', NS) is not None:
            raise ValueError('보호된 문서는 Word에서 보호 해제 후 다시 올려주세요.')
    root = ET.fromstring(xml)
    raw = xml.encode('utf-8')
    # Expat supplies exact byte offsets; the XML tree supplies table ancestry and grid geometry.
    # Never serialize the tree: Word namespace/compatibility declarations must stay unchanged.
    parser = expat.ParserCreate()
    spans, stack = [], []
    def start(name, attrs):
        offset = parser.CurrentByteIndex
        end = raw.index(b'>', offset) + 1
        span = [offset, end if raw[offset:end].rstrip().endswith(b'/>') else None]
        spans.append(span)
        stack.append(span)
    def end(name):
        span = stack.pop()
        if span[1] is None:
            span[1] = raw.index(b'>', parser.CurrentByteIndex) + 1
    parser.StartElementHandler, parser.EndElementHandler = start, end
    parser.Parse(raw, True)
    positions = dict(zip(root.iter(), spans))
    def text_of(node):
        return ''.join(t.text or '' for t in node.findall('.//w:t', NS)).strip()
    def normalized(text):
        return re.sub(r'\s+', '', text)
    def prop(node, path, default=''):
        found = node.find(path, NS)
        return found.get(f'{{{W}}}val', default) if found is not None else default
    def safe(node):
        return not any(node.find('.//w:' + tag, NS) is not None for tag in
                       ('tbl', 'drawing', 'pict', 'fldChar', 'sdt', 'ins', 'del', 'sym', 'checkBox'))
    targets, locations = [], {}
    def add(node, label, context, section='', row_index=None, inline=False, extra=None, heading=''):
        if not label or len(label) > 1500:
            return
        tid = f'node-{positions[node][0]}'
        target = {'id': tid, 'label': label, 'context': context[:4000], 'type': 'text'}
        if section:
            target['section'] = section
        if row_index is not None:
            target['rowIndex'] = row_index
        if heading:
            target['heading'] = heading[:200]
        if extra:
            target['mode'] = extra['mode']
            if extra['mode'] == 'choice':
                target['type'] = 'choice'
                target['options'] = extra['options']
            else:
                target['placeholder'] = extra['sub'][:200]
        targets.append(target)
        locations[tid] = (positions[node], inline, extra, text_of(node))
    for ti, table in enumerate(root.findall('.//w:tbl', NS)):
        section, headers, header_row, section_start = '', [], -1, -1
        merges = {}
        banner = None   # 소제목 줄이 정한 구역: {'name','index','heading'}
        hdr_mode = False   # 열 제목 줄 아래의 입력 줄들
        rows = table.findall('w:tr', NS)
        row_texts = [[text_of(c) for c in r.findall('w:tc', NS)] for r in rows]
        for ri, row in enumerate(rows):
            col = int(prop(row, 'w:trPr/w:gridBefore', '0'))
            cells = []
            for cell in row.findall('w:tc', NS):
                width = int(prop(cell, 'w:tcPr/w:gridSpan', '1'))
                merge = cell.find('w:tcPr/w:vMerge', NS)
                continuation = merge is not None and merge.get(f'{{{W}}}val') != 'restart'
                text = text_of(cell)
                effective = merges.get(col, '') if continuation else text
                if merge is not None and not continuation:
                    merges[col] = text
                elif merge is None:
                    merges.pop(col, None)
                cells.append({'node': cell, 'col': col, 'width': width, 'text': text,
                              'effective': effective, 'continuation': continuation})
                col += width
            if not cells:
                continue
            row_banner = banner_info(cells[0]['text'], 1) if all(not c['text'] for c in cells[1:]) else None
            if row_banner:
                banner = row_banner
                section, headers, header_row, hdr_mode = '', [], -1, False
                continue
            first = normalized(cells[0]['effective'])
            repeat_section = re.fullmatch(r'학력|경력|경력사항|수상내역|수상|병역|자격사항|자격증|외국어능력|컴퓨터활용능력|가족사항', first)
            if repeat_section and first != section:
                shared_header = section in ('자격사항', '외국어능력') and first in ('외국어능력', '컴퓨터활용능력')
                section, section_start = first, ri
                if shared_header and headers:
                    header_row = ri - 1
                else:
                    headers, header_row = [], -1
            elif not repeat_section and not (hdr_mode and datalike(row_texts[ri])):
                section, headers, header_row, hdr_mode = '', [], -1, False
            if repeat_section:
                banner = None
                hdr_mode = False
            # 열 제목만 있는 표(입학년월|졸업년월|학교|전공 …)는 아래 입력 줄의 열 제목으로 쓴다.
            if (not section and not banner and not repeat_section and len(cells) >= 3 and all(c['text'] for c in cells)
                    and ri + 1 < len(rows) and datalike(row_texts[ri + 1]) and not any(classify_filled_cell(c['text']) for c in cells)):
                inferred = infer_section([c['text'] for c in cells])
                if inferred:
                    section, headers, header_row, section_start, hdr_mode = inferred, cells, ri, ri, True
                    continue
            # A header row has multiple named columns, not alternating labels and empty values.
            if section and len([c for c in cells[1:] if c['text']]) >= 2 and all(c['text'] for c in cells[1:]):
                headers, header_row = cells[1:], ri
                continue
            for ci, cell in enumerate(cells):
                node, text = cell['node'], cell['text']
                inline = normalized(text) in ('(휴대폰)', '(휴대전화)', '(집전화)')
                extra = None
                if text and not inline:
                    shading = node.find('w:tcPr/w:shd', NS)
                    fill = (shading.get(f'{{{W}}}fill', 'auto') if shading is not None else 'auto').upper()
                    paragraphs_with_text = [p for p in node.findall('w:p', NS) if text_of(p)]
                    if cell['continuation'] or not safe(node) or len(paragraphs_with_text) != 1 or fill not in ('AUTO', 'FFFFFF'):
                        continue
                    extra = classify_filled_cell(text)
                    if not extra:
                        continue
                if cell['continuation'] or not safe(node):
                    continue
                if node.find('w:p', NS) is None:
                    continue
                header = next((h for h in headers if h['col'] == cell['col'] and h['width'] == cell['width']), None)
                left = cells[ci-1]['effective'] if ci else ''
                in_section = section or (banner['name'] if banner else '')
                label = text if inline else header['text'] if header else (f'{in_section} 열 {ci + 1} (열 제목 없음)' if section else left)
                if extra and not (header or left) and not in_section:
                    continue
                if extra and not header:
                    label = left or label
                # Empty section columns must not be guessed from an adjacent empty cell.
                context = f'표 {ti + 1}, 행 {ri + 1}, 열 {cell["col"] + 1}; {in_section}; 항목: {label}' + (f'; 안내문: {extra.get("sub", "")}' if extra and extra.get('sub') else '')
                if header:
                    index = ri - header_row - 1
                elif section:
                    index = ri - section_start
                elif banner:
                    index = banner['index'] if banner['index'] is not None else 0
                else:
                    index = None
                row_hint = next((c['text'] for c in cells if SCHOOL_HINT.match(c['text'])), '')
                add(node, label, context, in_section, index, inline, extra, (banner['heading'] if banner else '') or row_hint)
    # Explicit essay headings followed by a blank paragraph also occur outside tables.
    # Keep drawings/text boxes intact; use only actual empty body paragraphs.
    body = root.find('w:body', NS)
    essay_heading = ''
    if body is not None:
        for node in body:
            if node.tag != f'{{{W}}}p':
                essay_heading = ''
                continue
            text = text_of(node)
            compact = normalized(text)
            if text:
                essay_heading = text if re.fullmatch(r'(?:[0-9]+[.)]?)?(?:자기소개서|지원동기|성장과정|입사후포부|성격의장단점)', compact) and len(text) < 1000 and not re.search(r'동의|서명', text) else ''
            elif essay_heading and safe(node) and node.find('.//w:br', NS) is None and node.find('.//w:sectPr', NS) is None:
                add(node, essay_heading, essay_heading, '자기소개서')
                essay_heading = ''
    result = {'targets': targets, 'unsupported': '기존 내용은 보존합니다. 사진·서명·동의·텍스트 상자 및 저장 정보가 없는 항목은 직접 확인해주세요.'}
    if 'assignments' not in payload:
        return result
    used, patches = set(), []
    for item in payload['assignments']:
        tid, value = item['targetId'], item['value']
        if tid not in locations or tid in used or not isinstance(value, str) or len(value) > 10000:
            raise ValueError('문서 입력 위치 또는 값이 올바르지 않습니다.')
        used.add(tid)
        (start, end), inline, extra, original_text = locations[tid]
        cell = raw[start:end].decode('utf-8')
        if extra:
            patches.append((start, end, apply_special(cell, original_text, extra, value).encode('utf-8')))
            continue
        if inline:
            value = ' ' + value
        runs = '<w:r><w:br/></w:r>'.join('<w:r><w:t xml:space="preserve">' + escape(line) + '</w:t></w:r>' for line in value.split('\n'))
        # Preserve the first run style when present, including font size and family.
        style = re.search(r'<w:rPr(?:\s[^>]*)?>[\s\S]*?</w:rPr>', cell)
        if style:
            runs = runs.replace('<w:r>', '<w:r>' + style.group())
        empty_p = re.search(r'<w:p(?:\s[^>]*)?/>', cell)
        if empty_p:
            paragraph = empty_p.group()[:-2] + '>' + runs + '</w:p>'
            cell = cell[:empty_p.start()] + paragraph + cell[empty_p.end():]
        else:
            cell = cell.replace('</w:p>', runs + '</w:p>', 1)
        patches.append((start, end, cell.encode('utf-8')))
    for start, end, replacement in sorted(patches, reverse=True):
        raw = raw[:start] + replacement + raw[end:]
    xml = raw.decode('utf-8')
    ET.fromstring(xml)  # Structural validation after every edit.
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as dest:
        for entry in entries:
            dest.writestr(entry, xml.encode('utf-8') if entry.filename == 'word/document.xml' else source.read(entry.filename))
    result.update(document=base64.b64encode(output.getvalue()).decode('ascii'), filled=len(used))
    return result

if __name__ == '__main__':
    try:
        print(json.dumps(process(json.load(sys.stdin)), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
