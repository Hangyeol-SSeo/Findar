"""Author the readable v2 template from the retained prototype (stdlib only).

Usage: python3 scripts/design-application-template.py SOURCE.docx OUTPUT.docx
This is a design-time tool. Runtime generation fills the committed template.
"""
import copy
import io
import sys
import zipfile
import xml.etree.ElementTree as ET

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}
SLOTS = [
    'resume.title', 'resume.name', 'resume.contact', 'resume.extra',
    'education.heading', 'education.table', 'work.heading', 'work.table',
    'credentials.heading', 'credentials.table', 'summary.heading', 'summary.line', 'summary.skills', 'summary.reference',
    'details.break', 'details.title', 'details.subtitle', 'details.work.heading', 'details.work.title', 'details.meta',
    'details.work.line', 'details.work.challenge', 'details.work.contribution', 'details.work.result', 'details.work.relevance',
    'details.project.heading', 'details.project.title', 'details.project.meta', 'details.project.scope', 'details.project.role',
    'details.project.line', 'details.project.result', 'details.project.reference',
    'essay.break', 'essay.title', 'essay.identity', 'essay.question', 'essay.body', 'essay.body.end',
    'essay.question.second', 'essay.body.second', 'essay.body.second.end',
    'essay.question.third', 'essay.body.third', 'essay.body.third.end',
]


def q(name):
    return '{' + W + '}' + name


def prop(parent, name, **attrs):
    node = parent.find('w:' + name, NS)
    if node is None:
        node = ET.SubElement(parent, q(name))
    for key, value in attrs.items():
        node.set(q(key), str(value))
    return node


def text(paragraph, value, size, bold=False):
    for node in list(paragraph):
        if node.tag != q('pPr'):
            paragraph.remove(node)
    r = ET.SubElement(paragraph, q('r'))
    rp = ET.SubElement(r, q('rPr'))
    prop(rp, 'sz', val=size)
    prop(rp, 'color', val='000000')
    prop(rp, 'b', val='1' if bold else '0')
    ET.SubElement(r, q('t')).text = value


def mark(node, key, number):
    name = 'findar_' + key.replace('.', '_')
    if node.tag == q('tbl'):
        prop(prop(node, 'tblPr'), 'tblCaption', val=name)
    else:
        start = ET.Element(q('bookmarkStart'), {q('id'): str(number), q('name'): name})
        node.insert(1 if node.find('w:pPr', NS) is not None else 0, start)
        ET.SubElement(node, q('bookmarkEnd'), {q('id'): str(number)})


def build(source_path, output_path):
    with zipfile.ZipFile(source_path) as source:
        raw = source.read('word/document.xml').decode('utf-8')
        for _, (prefix, uri) in ET.iterparse(io.StringIO(raw), events=['start-ns']):
            ET.register_namespace(prefix, uri)
        body = ET.fromstring(raw).find('w:body', NS)
        children = list(body)
        if len(children) != 46:
            raise ValueError('Use the original 3-page prototype as the source.')
        nodes = dict(zip(SLOTS, children))
        for i, (key, node) in enumerate(nodes.items()):
            mark(node, key, 500 + i)
        # Document type is a modest label. The destination company leads the page.
        title = nodes['resume.title']
        text(title, '입사지원서', 22, True)
        mark(title, 'resume.title', 500)
        prop(prop(title, 'pPr'), 'spacing', before=0, after=80, line=260, lineRule='auto')
        company = copy.deepcopy(nodes['resume.name'])
        text(company, '[지원 회사]', 44, True)
        prop(prop(company, 'pPr'), 'spacing', before=0, after=60, line=280, lineRule='auto')
        prop(prop(company, 'pPr'), 'keepNext')
        mark(company, 'resume.company', 600)
        role = copy.deepcopy(nodes['resume.name'])
        text(role, '[지원 팀 또는 직무]', 28, True)
        # Separate label/value runs keep the target conspicuous when filled.
        lead = copy.deepcopy(role.find('w:r', NS))
        lead.find('w:t', NS).text = '지원 팀 및 직무  '
        lead.find('w:t', NS).set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        prop(lead.find('w:rPr', NS), 'sz', val=20)
        prop(lead.find('w:rPr', NS), 'b', val=0)
        role.insert(1, lead)
        prop(prop(role, 'pPr'), 'spacing', before=0, after=100, line=280, lineRule='auto')
        prop(prop(role, 'pPr'), 'keepNext')
        mark(role, 'resume.role', 601)
        body.insert(1, company)
        body.insert(2, role)
        name = nodes['resume.name']
        text(name, '[성명]', 30, True)
        lead = copy.deepcopy(name.find('w:r', NS))
        lead.find('w:t', NS).text = '지원자  '
        lead.find('w:t', NS).set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')
        prop(lead.find('w:rPr', NS), 'sz', val=20)
        prop(lead.find('w:rPr', NS), 'b', val=0)
        name.insert(1, lead)
        mark(name, 'resume.name', 501)
        prop(prop(name, 'pPr'), 'spacing', before=0, after=40, line=260, lineRule='auto')
        for key in ['resume.contact', 'resume.extra']:
            p = nodes[key]
            for r in p.findall('w:r', NS):
                prop(prop(r, 'rPr'), 'sz', val=21)
            prop(prop(p, 'pPr'), 'spacing', before=0, after=60, line=260, lineRule='auto')
        for key in ['details.title', 'essay.title']:
            p = nodes[key]
            for r in p.findall('w:r', NS):
                prop(prop(r, 'rPr'), 'sz', val=40)
            prop(prop(p, 'pPr'), 'spacing', before=0, after=120)
        for key in ['details.subtitle', 'essay.identity']:
            p = nodes[key]
            text(p, '[지원 회사]  [지원 팀 또는 직무]  [성명]', 21)
            mark(p, key, 500 + SLOTS.index(key))
            prop(prop(p, 'pPr'), 'spacing', before=0, after=120, line=270, lineRule='auto')
        for key in ['details.work.title', 'details.project.title']:
            prop(prop(nodes[key], 'pPr'), 'spacing', before=120, after=80)
        for key in ['details.meta', 'details.project.meta']:
            prop(prop(nodes[key], 'pPr'), 'spacing', before=0, after=80)
            for r in nodes[key].findall('w:r', NS):
                prop(prop(r, 'rPr'), 'sz', val=20)
        for key in ['summary.line', 'summary.skills', 'summary.reference']:
            prop(prop(nodes[key], 'pPr'), 'spacing', before=0, after=80, line=280, lineRule='auto')
            for r in nodes[key].findall('w:r', NS):
                prop(prop(r, 'rPr'), 'sz', val=21)
        for table_key in ['education.table', 'work.table', 'credentials.table']:
            table = nodes[table_key]
            for p in table.findall('.//w:p', NS):
                prop(prop(p, 'pPr'), 'snapToGrid', val=0)
                prop(prop(p, 'pPr'), 'spacing', before=0, after=0, line=280, lineRule='auto')
            for r in table.findall('.//w:r', NS):
                prop(prop(r, 'rPr'), 'sz', val=21)
            for margin in table.findall('.//w:tcMar', NS):
                for edge in ['top', 'bottom']:
                    prop(margin, edge, w=85, type='dxa')
            for header in table.findall('w:tr', NS)[:1]:
                for r in header.findall('.//w:r', NS):
                    prop(prop(r, 'rPr'), 'sz', val=20)
        for key, ending in [('education.table', '졸업일'), ('work.table', '종료일 또는 현재')]:
            cell = nodes[key].findall('w:tr', NS)[1].findall('w:tc', NS)[0]
            p = cell.find('w:p', NS)
            text(p, '[시작일]', 21)
            r = p.find('w:r', NS)
            ET.SubElement(r, q('br'))
            ET.SubElement(r, q('t')).text = '- [' + ending + ']'
        # Removing the inherited East Asian text-grid snap makes 10.5/11pt text
        # respect its intended line spacing instead of expanding to an 18pt grid.
        styles = ET.fromstring(source.read('word/styles.xml'))
        for sid in ['Normal', 'Heading1', 'Heading2', 'Title', 'Subtitle', 'Header', 'Footer']:
            s = styles.find('w:style[@w:styleId="' + sid + '"]', NS)
            if s is None:
                continue
            pp = prop(s, 'pPr')
            prop(pp, 'snapToGrid', val=0)
            if sid == 'Normal':
                prop(pp, 'spacing', after=100, line=300, lineRule='auto')
            elif sid == 'Heading1':
                prop(pp, 'spacing', before=240, after=120, line=280, lineRule='auto')
            elif sid == 'Heading2':
                prop(pp, 'spacing', before=160, after=100)
        # Keep every unedited package part from the original reference.
        serialized = ET.tostring(body, encoding='unicode')
        inner = serialized[serialized.index('>') + 1:serialized.rindex('</')]
        document = raw[:raw.index('<w:body>') + len('<w:body>')] + inner + raw[raw.index('</w:body>'):]
        with zipfile.ZipFile(output_path, 'w') as dest:
            for info in source.infolist():
                data = source.read(info.filename)
                if info.filename == 'word/document.xml':
                    data = document.encode('utf-8')
                elif info.filename == 'word/styles.xml':
                    original = data.decode('utf-8')
                    result = ET.tostring(styles, encoding='unicode')
                    # Preserve original root declarations used by compatibility flags.
                    prefix = original[:original.index('>') + 1]
                    if prefix.startswith('<?xml'):
                        start = original.index('<w:styles')
                        prefix = original[:original.index('>', start) + 1]
                    data = (prefix + result[result.index('>') + 1:]).encode('utf-8')
                dest.writestr(info, data)


if __name__ == '__main__':
    build(sys.argv[1], sys.argv[2])
