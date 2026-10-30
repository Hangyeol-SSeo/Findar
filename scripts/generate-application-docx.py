"""Fill the retained approved DOCX prototype using Python 3's standard library.

Source styles, fonts, table components, theme and relationships are preserved.
stdin: FreeformDocument JSON. stdout: {document: base64}. No applicant disk writes.
"""
import base64
import copy
import io
import json
from pathlib import Path
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}
TEMPLATE = Path(__file__).resolve().parents[1] / "assets/templates/freeform-application.docx"


def clean(value):
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", str(value or ""))


def tag(name):
    return "{" + W + "}" + name


def property_node(parent, name):
    found = parent.find("w:" + name, NS)
    if found is None:
        found = ET.SubElement(parent, tag(name))
    return found


class Prototype:
    def __init__(self, archive):
        self.raw = archive.read("word/document.xml").decode("utf-8")
        for _, (prefix, uri) in ET.iterparse(io.StringIO(self.raw), events=["start-ns"]):
            ET.register_namespace(prefix, uri)
        self.body = ET.fromstring(self.raw).find("w:body", NS)
        self.source = list(self.body)
        self.slots = {}
        for node in self.source:
            if node.tag == tag("tbl"):
                marker = node.find('w:tblPr/w:tblCaption', NS)
                name = marker.get(tag('val'), '') if marker is not None else ''
            else:
                marker = node.find('w:bookmarkStart', NS)
                name = marker.get(tag('name'), '') if marker is not None else ''
            if name.startswith('findar_'):
                self.slots[name[len('findar_'):]] = node
        required = ['resume.title', 'resume.company', 'resume.role', 'resume.name', 'resume.contact',
                    'education.table', 'work.table', 'credentials.table', 'summary.line',
                    'details.break', 'details.title', 'details.work.title', 'details.project.title',
                    'essay.break', 'essay.title', 'essay.question', 'essay.body']
        if any(key.replace('.', '_') not in self.slots for key in required):
            raise ValueError("지원서 기준 양식의 입력 위치를 찾지 못했습니다.")

    def slot(self, key):
        return self.slots[key.replace('.', '_')]

    def region(self, start, end=None):
        a = self.source.index(self.slot(start))
        b = self.source.index(self.slot(end)) if end else len(self.source) - 1
        return [copy.deepcopy(e) for e in self.source[a:b]]

    def paragraph(self, index, value=None, label=None, keep=False, essay=False):
        p = copy.deepcopy(self.slot(index))
        # Authoring anchors locate source components; cloned output paragraphs
        # must not repeat bookmark IDs/names in Word.
        for child in list(p):
            if child.tag in (tag('bookmarkStart'), tag('bookmarkEnd')):
                p.remove(child)
        if value is None:
            return p
        return self.replace_paragraph(p, value, label, keep, essay)

    def replace_paragraph(self, p, value, label=None, keep=False, essay=False):
        runs = p.findall("w:r", NS)
        first = runs[0].find("w:rPr", NS) if runs else None
        last = runs[-1].find("w:rPr", NS) if runs else None
        for child in list(p):
            if child.tag != tag("pPr"):
                p.remove(child)
        props = property_node(p, "pPr")
        if keep:
            property_node(props, "keepNext")
        if essay:
            # Large placeholder end-spaces are writing aids. Actual prose uses
            # the source normal body rhythm, with no fixed-height response slot.
            spacing = property_node(props, "spacing")
            spacing.set(tag("before"), "0")
            spacing.set(tag("after"), "120")
        if label:
            self.run(p, label + "  ", first)
        self.run(p, value, last if label else first)
        return p

    @staticmethod
    def run(p, value, formatting):
        r = ET.SubElement(p, tag("r"))
        rp = copy.deepcopy(formatting) if formatting is not None else ET.Element(tag("rPr"))
        color = property_node(rp, "color")
        color.attrib.clear()
        color.set(tag("val"), "000000")
        r.append(rp)
        for i, part in enumerate(clean(value).split("\n")):
            if i:
                ET.SubElement(r, tag("br"))
            t = ET.SubElement(r, tag("t"), {"{http://www.w3.org/XML/1998/namespace}space": "preserve"})
            t.text = part

    def table(self, block):
        index = {"학력": "education.table", "경력": "work.table", "자격 및 어학": "credentials.table"}[block["title"]]
        t = copy.deepcopy(self.slot(index))
        source_rows = t.findall("w:tr", NS)
        expected = len(source_rows[0].findall("w:tc", NS))
        if any(len(row) != expected for row in block["rows"]):
            raise ValueError("기준 양식의 표 열 수와 지원 정보가 일치하지 않습니다.")
        for old in source_rows[1:]:
            t.remove(old)
        for values in block["rows"]:
            pattern = source_rows[2] if index == "credentials.table" and values[0] == "어학" else source_rows[1]
            row = copy.deepcopy(pattern)
            if sum(len(v) for v in values) > 600:
                for item in row.findall("w:trPr/w:cantSplit", NS):
                    row.find("w:trPr", NS).remove(item)
            for cell, value in zip(row.findall("w:tc", NS), values):
                if cell is row.findall("w:tc", NS)[0] and index in ("education.table", "work.table") and " - " in value:
                    value = value.replace(" - ", "\n- ", 1)
                paragraph = cell.find("w:p", NS)
                for extra in cell.findall("w:p", NS)[1:]:
                    cell.remove(extra)
                self.replace_paragraph(paragraph, value)
            t.append(row)
        return t

    def serialize(self, nodes):
        body = copy.deepcopy(self.body)
        for old in list(body):
            body.remove(old)
        body.extend(nodes)
        body.append(copy.deepcopy(self.source[-1]))
        serialized = ET.tostring(body, encoding="unicode")
        inner = serialized[serialized.index(">") + 1:serialized.rindex("</")]
        # Preserve ALL document-root namespaces, including prefixes referenced
        # by mc:Ignorable but absent from the edited body.
        return re.sub(r"(?<=<w:body>)[\s\S]*(?=</w:body>)", lambda _: inner, self.raw, count=1).encode("utf-8")


def filled_nodes(proto, payload):
    nodes = []
    for i, page in enumerate(payload["pages"]):
        essay_page = page["title"] == "자기소개서"
        detail_page = page["title"] == "경력 및 경험 상세"
        title = proto.paragraph("essay.title" if essay_page else "details.title" if detail_page else "resume.title", page["title"])
        if i:
            # A standalone page-break paragraph can itself spill onto a new page
            # and create a completely blank sheet after a full details page.
            property_node(property_node(title, "pPr"), "pageBreakBefore")
        nodes.append(title)
        if i == 0:
            nodes.append(proto.paragraph("resume.company", payload.get("company") or "[지원 회사]", keep=True))
            nodes.append(proto.paragraph("resume.role", payload.get("role") or "[지원 팀 또는 직무]", label="지원 팀 및 직무", keep=True))
            nodes.append(proto.paragraph("resume.name", payload.get("name", ""), label="지원자", keep=True))
            nodes.append(proto.paragraph("resume.contact", "  |  ".join(payload.get("contacts", []))))
        else:
            identity = "  ".join(v for v in [payload.get("company"), payload.get("role"), payload.get("name")] if v)
            nodes.append(proto.paragraph("essay.identity" if essay_page else "details.subtitle", identity))
        if essay_page:
            if not any(line["text"].strip() for b in page["blocks"] for e in b.get("entries", []) for line in e["lines"]):
                nodes.extend(proto.region("essay.question"))
                continue
        for block in page["blocks"]:
            if block["title"]:
                index = {"학력": "education.heading", "경력": "work.heading", "자격 및 어학": "credentials.heading", "관련 경험 및 활용 역량": "summary.heading",
                         "업무 경험": "details.work.heading", "프로젝트 및 학습 경험": "details.project.heading", "추가 기재사항": "details.work.title"}.get(block["title"], "summary.heading")
                nodes.append(proto.paragraph(index, block["title"]))
            if block["type"] == "table":
                nodes.append(proto.table(block))
                continue
            for entry_index, entry in enumerate(block["entries"]):
                if entry["title"]:
                    index = "essay.question" if essay_page else "details.work.title" if block["title"] == "업무 경험" else "details.project.title"
                    heading = proto.paragraph(index, entry["title"], keep=True)
                    if entry_index:
                        property_node(property_node(heading, "pPr"), "spacing").set(tag("before"), "160")
                    nodes.append(heading)
                if entry.get("meta"):
                    nodes.append(proto.paragraph("details.meta", entry["meta"], keep=True))
                for line_index, line in enumerate(entry["lines"]):
                    for j, part in enumerate(line["text"].replace("\r\n", "\n").split("\n")):
                        label = line["label"] if j == 0 else ""
                        pattern = "essay.body" if essay_page else "details.work.line" if detail_page else "summary.line"
                        keep = block["title"] == "추가 기재사항" and line_index < len(entry["lines"]) - 1
                        paragraph = proto.paragraph(pattern, part, label=label, essay=essay_page, keep=keep)
                        if not block["title"] and not detail_page and not essay_page and line_index == 0 and j == 0:
                            property_node(property_node(paragraph, "pPr"), "spacing").set(tag("before"), "80")
                        nodes.append(paragraph)
    return nodes


def blank_nodes(proto, payload):
    # Blank output retains the designed template body and its writing guides.
    names = {page["title"] for page in payload["pages"]}
    nodes = proto.region("resume.title", "details.break")
    for block in payload["pages"][0]["blocks"]:
        if block["title"] in ("병역", "추가 인적사항", "추가 기재사항"):
            nodes.append(proto.paragraph("details.work.title", block["title"], keep=True))
            for entry in block["entries"]:
                for line in entry["lines"]:
                    nodes.append(proto.paragraph("summary.line", line["text"], label=line["label"]))
    if "경력 및 경험 상세" in names:
        nodes.extend(proto.region("details.break", "essay.break"))
    if "자기소개서" in names:
        nodes.extend(proto.region("essay.break"))
    for node in nodes:
        for t in node.findall(".//w:t", NS):
            t.text = (t.text or "").replace("[지원 회사]", payload.get("company") or "[지원 회사]").replace("[지원 팀 또는 직무]", payload.get("role") or "[지원 팀 또는 직무]")
    return nodes


def generate(payload):
    blank = payload.get("mode") == "blank"
    output = io.BytesIO()
    with zipfile.ZipFile(TEMPLATE) as source, zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as dest:
        proto = Prototype(source)
        document = proto.serialize(blank_nodes(proto, payload) if blank else filled_nodes(proto, payload))
        for entry in source.infolist():
            data = source.read(entry.filename)
            if entry.filename == "word/document.xml":
                data = document
            elif entry.filename in ("word/header1.xml", "word/footer1.xml"):
                content = data.decode("utf-8")
                for token, key in [("[지원 회사]", "company"), ("[지원 직무]", "role"), ("[성명]", "name")]:
                    content = content.replace(token, escape(clean(payload.get(key))) if not blank or payload.get(key) else token)
                data = content.encode("utf-8")
            elif entry.filename == "word/settings.xml":
                content = data.decode("utf-8")
                update = '<w:updateFields w:val="true"/>'
                if re.search(r"<w:updateFields\b", content):
                    content = re.sub(r"<w:updateFields\b[^>]*(?:/>|>[\s\S]*?</w:updateFields>)", update, content)
                else:
                    content = content.replace("</w:settings>", update + "</w:settings>")
                data = content.encode("utf-8")
            dest.writestr(entry, data)
    return {"document": base64.b64encode(output.getvalue()).decode("ascii")}


if __name__ == "__main__":
    try:
        print(json.dumps(generate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        print(json.dumps({"error": "지원서 문서를 생성하지 못했습니다. 기준 양식 파일을 확인해주세요."}, ensure_ascii=False))
        sys.exit(1)
