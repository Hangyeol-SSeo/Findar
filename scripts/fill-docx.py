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
    # Nested table cells and tracked edits are left alone, avoiding uncertain structural edits.
    matches = list(re.finditer(r'<w:tc(?:\s[^>]*)?>[\s\S]*?</w:tc>', xml))
    namespaces = ' '.join(dict.fromkeys(re.findall(r'xmlns:[\w]+=[\"\'][^\"\']*[\"\']', xml)))
    targets, locations = [], {}
    for i, match in enumerate(matches):
        cell_xml = match.group()
        if re.search(r'<w:(?:tbl|drawing|pict|fldChar|sdt|ins|del|vMerge)(?:\s|>|/)', cell_xml):
            continue
        # Find the corresponding parsed cell by serial order only for flat tables.
        text = ''.join(re.findall(r'<w:t(?:\s[^>]*)?>([\s\S]*?)</w:t>', cell_xml))
        if text.strip() or not re.search(r'<w:p(?:\s[^>]*)?(?:/>|>)', cell_xml):
            continue
        # Require a row boundary, not trPr. Find the most recent actual opening row.
        rows = list(re.finditer(r'<w:tr(?:\s[^>]*)?>', xml[:match.start()]))
        if not rows:
            continue
        row_start = rows[-1].start()
        preceding = xml[row_start:match.start()]
        label_cells = re.findall(r'<w:tc(?:\s[^>]*)?>[\s\S]*?</w:tc>', preceding)
        if not label_cells:
            continue
        label_xml = label_cells[-1]
        # Entity decoding without changing the surrounding original XML.
        wrapper = f'<root {namespaces}>{label_xml}</root>'
        try:
            label = ''.join(ET.fromstring(wrapper).itertext()).strip()
        except ET.ParseError:
            continue
        if not label or len(label) > 1500:
            continue
        tid = f'cell-{i}'
        targets.append({'id': tid, 'label': label, 'context': label, 'type': 'text'})
        locations[tid] = match
    # Reject text-box-only/non-table templates instead of pretending to have filled them.
    result = {'targets': targets, 'unsupported': '표의 빈 입력칸만 자동 작성합니다. 본문 빈줄·텍스트 상자·체크박스·서명란은 직접 확인해주세요.'}
    if 'assignments' not in payload:
        return result
    used, patches = set(), []
    for item in payload['assignments']:
        tid, value = item['targetId'], item['value']
        if tid not in locations or tid in used or not isinstance(value, str) or len(value) > 10000:
            raise ValueError('문서 입력 위치 또는 값이 올바르지 않습니다.')
        used.add(tid)
        match = locations[tid]
        cell = match.group()
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
        patches.append((match.start(), match.end(), cell))
    for start, end, replacement in sorted(patches, reverse=True):
        xml = xml[:start] + replacement + xml[end:]
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
