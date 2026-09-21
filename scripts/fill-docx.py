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
    def add(node, label, context, section='', row_index=None, inline=False):
        if not label or len(label) > 1500:
            return
        tid = f'node-{positions[node][0]}'
        target = {'id': tid, 'label': label, 'context': context[:4000], 'type': 'text'}
        if section:
            target['section'] = section
        if row_index is not None:
            target['rowIndex'] = row_index
        targets.append(target)
        locations[tid] = (positions[node], inline)
    for ti, table in enumerate(root.findall('.//w:tbl', NS)):
        section, headers, header_row, section_start = '', [], -1, -1
        merges = {}
        for ri, row in enumerate(table.findall('w:tr', NS)):
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
            first = normalized(cells[0]['effective'])
            repeat_section = re.fullmatch(r'학력|경력|경력사항|수상내역|수상|병역|자격사항|자격증|외국어능력|컴퓨터활용능력|가족사항', first)
            if repeat_section and first != section:
                shared_header = section in ('자격사항', '외국어능력') and first in ('외국어능력', '컴퓨터활용능력')
                section, section_start = first, ri
                if shared_header and headers:
                    header_row = ri - 1
                else:
                    headers, header_row = [], -1
            elif not repeat_section:
                section, headers, header_row = '', [], -1
            # A header row has multiple named columns, not alternating labels and empty values.
            if section and len([c for c in cells[1:] if c['text']]) >= 2 and all(c['text'] for c in cells[1:]):
                headers, header_row = cells[1:], ri
                continue
            for ci, cell in enumerate(cells):
                node, text = cell['node'], cell['text']
                inline = normalized(text) in ('(휴대폰)', '(휴대전화)', '(집전화)')
                if cell['continuation'] or not safe(node) or (text and not inline):
                    continue
                if node.find('w:p', NS) is None:
                    continue
                header = next((h for h in headers if h['col'] == cell['col'] and h['width'] == cell['width']), None)
                left = cells[ci-1]['effective'] if ci else ''
                label = text if inline else header['text'] if header else (f'{section} 열 {ci + 1} (열 제목 없음)' if section else left)
                # Empty section columns must not be guessed from an adjacent empty cell.
                context = f'표 {ti + 1}, 행 {ri + 1}, 열 {cell["col"] + 1}; {section}; 항목: {label}'
                index = ri - header_row - 1 if header else ri - section_start if section else None
                add(node, label, context, section, index, inline)
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
        (start, end), inline = locations[tid]
        cell = raw[start:end].decode('utf-8')
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
