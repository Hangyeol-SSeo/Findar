"""Generate editable freeform job applications using Python 3's standard library.

stdin: FreeformDocument JSON built from saved facts by lib/freeform-application.ts.
stdout: {document: base64}. No applicant files or payloads are written to disk.
"""
import base64
import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
XML = "http://www.w3.org/XML/1998/namespace"
ET.register_namespace("w", W)
ET.register_namespace("r", R)
FONT = "Nanum Gothic"
WIDTH = 10166


def el(tag, attrs=None, parent=None):
    node = ET.Element(f"{{{W}}}{tag}", {f"{{{W}}}{k}": str(v) for k, v in (attrs or {}).items()})
    if parent is not None:
        parent.append(node)
    return node


def clean(value):
    # XML 1.0 controls are invalid; retain all printable text, including emoji.
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]", "", str(value or ""))


def run(parent, value, bold=False, size=None):
    r = el("r", parent=parent)
    if bold or size:
        props = el("rPr", parent=r)
        if bold:
            el("b", parent=props)
        if size:
            el("sz", {"val": size}, props)
    for i, part in enumerate(clean(value).split("\n")):
        if i:
            el("br", parent=r)
        t = el("t", parent=r)
        t.set(f"{{{XML}}}space", "preserve")
        t.text = part
    return r


def paragraph(parent, value="", style=None, label="", page_break=False, center=False):
    p = el("p", parent=parent)
    props = el("pPr", parent=p)
    if style:
        el("pStyle", {"val": style}, props)
    if page_break:
        el("pageBreakBefore", parent=props)
    if center:
        el("jc", {"val": "center"}, props)
    if label:
        run(p, label + "  ", bold=True)
    run(p, value)
    return p


def table(parent, block):
    t = el("tbl", parent=parent)
    props = el("tblPr", parent=t)
    el("tblW", {"w": WIDTH, "type": "dxa"}, props)
    el("tblLayout", {"type": "fixed"}, props)
    borders = el("tblBorders", parent=props)
    for edge in ["top", "left", "bottom", "right", "insideH", "insideV"]:
        el(edge, {"val": "single", "sz": 4, "color": "D9D9D9"}, borders)
    margins = el("tblCellMar", parent=props)
    for edge, width in [("top", 100), ("bottom", 100), ("left", 110), ("right", 110)]:
        el(edge, {"w": width, "type": "dxa"}, margins)
    widths = [round(WIDTH * w / sum(block["widths"])) for w in block["widths"]]
    widths[-1] += WIDTH - sum(widths)
    grid = el("tblGrid", parent=t)
    for width in widths:
        el("gridCol", {"w": width}, grid)
    for index, values in enumerate([block["headers"]] + block["rows"]):
        row = el("tr", parent=t)
        if index == 0:
            el("tblHeader", parent=el("trPr", parent=row))
        # No fixed heights or cantSplit: long fact/essay text can flow to next page.
        for width, value in zip(widths, values):
            cell = el("tc", parent=row)
            cp = el("tcPr", parent=cell)
            el("tcW", {"w": width, "type": "dxa"}, cp)
            el("vAlign", {"val": "center"}, cp)
            if index == 0:
                el("shd", {"fill": "F1F2F3", "val": "clear"}, cp)
            p = paragraph(cell, style="TableText", center=index == 0 or width < 1400)
            run(p, value, bold=index == 0)
    paragraph(parent, style="TableGap")


def styles():
    root = el("styles")
    defaults = el("docDefaults", parent=root)
    rp = el("rPr", parent=el("rPrDefault", parent=defaults))
    el("rFonts", {"ascii": FONT, "hAnsi": FONT, "eastAsia": FONT, "cs": FONT}, rp)
    el("sz", {"val": 22}, rp)
    el("color", {"val": "000000"}, rp)
    el("lang", {"val": "ko-KR", "eastAsia": "ko-KR"}, rp)
    pp = el("pPr", parent=el("pPrDefault", parent=defaults))
    el("spacing", {"after": 120, "line": 300, "lineRule": "auto"}, pp)
    el("widowControl", parent=pp)
    for sid, name, size, bold, before, after, keep in [
        ("Normal", "Normal", 22, False, 0, 120, False),
        ("Title", "Title", 48, True, 0, 160, True),
        ("Name", "Applicant Name", 36, True, 80, 100, True),
        ("Heading1", "heading 1", 26, True, 300, 160, True),
        ("Heading2", "heading 2", 22, True, 180, 100, True),
        ("TableText", "Table Text", 20, False, 0, 0, False),
        ("TableGap", "Table Gap", 4, False, 0, 0, False),
        ("Header", "Header", 18, False, 0, 0, False),
    ]:
        s = el("style", {"type": "paragraph", "styleId": sid}, root)
        if sid == "Normal":
            s.set(f"{{{W}}}default", "1")
        el("name", {"val": name}, s)
        if sid != "Normal":
            el("basedOn", {"val": "Normal"}, s)
        p = el("pPr", parent=s)
        el("spacing", {"before": before, "after": after}, p)
        if keep:
            el("keepNext", parent=p)
        if sid in ("Heading1", "Heading2"):
            el("outlineLvl", {"val": 0 if sid == "Heading1" else 1}, p)
        r = el("rPr", parent=s)
        el("sz", {"val": size}, r)
        if bold:
            el("b", parent=r)
    return root


def generate(payload):
    document = el("document")
    body = el("body", parent=document)
    for i, page in enumerate(payload["pages"]):
        paragraph(body, page["title"], "Title", page_break=i > 0)
        if i == 0:
            paragraph(body, payload.get("name", ""), "Name")
            paragraph(body, "  |  ".join(payload.get("contacts", [])))
        for block in page["blocks"]:
            if block["title"]:
                paragraph(body, block["title"], "Heading1")
            if block["type"] == "table":
                table(body, block)
            else:
                for entry in block["entries"]:
                    if entry["title"]:
                        paragraph(body, entry["title"], "Heading2")
                    if entry.get("meta"):
                        paragraph(body, entry["meta"])
                    for line in entry["lines"]:
                        # Each essay paragraph remains independently editable; no truncation.
                        for index, part in enumerate(line["text"].replace("\r\n", "\n").split("\n")):
                            paragraph(body, part, label=line["label"] if index == 0 else "")
    sect = el("sectPr", parent=body)
    for tag, rid in [("headerReference", "rIdHeader"), ("footerReference", "rIdFooter")]:
        ref = el(tag, {"type": "default"}, sect)
        ref.set(f"{{{R}}}id", rid)
    el("pgSz", {"w": 12240, "h": 15840}, sect)
    el("pgMar", {"top": 907, "right": 1037, "bottom": 864, "left": 1037, "header": 403, "footer": 403, "gutter": 0}, sect)
    header = el("hdr")
    paragraph(header, "  /  ".join(v for v in [payload.get("company"), payload.get("role")] if v), "Header")
    footer = el("ftr")
    p = paragraph(footer, (payload.get("name", "") + "  |  ") if payload.get("name") else "", "Header")
    el("jc", {"val": "right"}, p.find(f"{{{W}}}pPr"))
    field = el("fldSimple", {"instr": "PAGE"}, p)
    run(field, "1")
    settings = el("settings")
    el("defaultTabStop", {"val": 720}, settings)
    relationships = ET.Element(f"{{{REL}}}Relationships")
    for rid, kind, target in [("rIdStyles", "styles", "styles.xml"), ("rIdSettings", "settings", "settings.xml"), ("rIdHeader", "header", "header1.xml"), ("rIdFooter", "footer", "footer1.xml")]:
        ET.SubElement(relationships, f"{{{REL}}}Relationship", {"Id": rid, "Type": R + "/" + kind, "Target": target})
    root_rels = ET.Element(f"{{{REL}}}Relationships")
    ET.SubElement(root_rels, f"{{{REL}}}Relationship", {"Id": "rIdDocument", "Type": R + "/officeDocument", "Target": "word/document.xml"})
    content = ET.Element(f"{{{CT}}}Types")
    for ext, mime in [("rels", "application/vnd.openxmlformats-package.relationships+xml"), ("xml", "application/xml")]:
        ET.SubElement(content, f"{{{CT}}}Default", {"Extension": ext, "ContentType": mime})
    for part, kind in [("document", "document.main"), ("styles", "styles"), ("settings", "settings"), ("header1", "header"), ("footer1", "footer")]:
        ET.SubElement(content, f"{{{CT}}}Override", {"PartName": f"/word/{part}.xml", "ContentType": f"application/vnd.openxmlformats-officedocument.wordprocessingml.{kind}+xml"})
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for filename, node in {
            "[Content_Types].xml": content, "_rels/.rels": root_rels,
            "word/document.xml": document, "word/styles.xml": styles(),
            "word/settings.xml": settings, "word/header1.xml": header, "word/footer1.xml": footer,
            "word/_rels/document.xml.rels": relationships,
        }.items():
            # OPC readers (including LibreOffice) expect the package namespaces
            # as defaults in content types and relationship parts.
            if node.tag.startswith("{" + CT + "}"):
                ET.register_namespace("", CT)
            elif node.tag.startswith("{" + REL + "}"):
                ET.register_namespace("", REL)
            # xml_declaration is unavailable in ElementTree.tostring on Python 3.7.
            archive.writestr(filename, b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + ET.tostring(node, encoding="utf-8"))
    return {"document": base64.b64encode(buffer.getvalue()).decode("ascii")}


if __name__ == "__main__":
    try:
        print(json.dumps(generate(json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        # Do not echo applicant payloads or XML into logs or task errors.
        print(json.dumps({"error": "지원서 문서를 생성하지 못했습니다."}, ensure_ascii=False))
        sys.exit(1)
