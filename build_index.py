#!/usr/bin/env python3
"""
Build the search index (data/slides.json) for the DB Slide Finder web app.

Reads the 7 source lecture PDFs in VL order (so each global page is tagged with
its lecture) and extracts per-page text. The page order matches the merged
"DSCB140 - Alle Vorlesungen (VL1-VL7).pdf" exactly, so global page numbers line
up 1:1 with the PDF shown in the viewer.

Uses PyMuPDF (fitz) if available (better extraction), otherwise pypdf.
"""
import json
import re
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SRC_DIR = Path(__file__).resolve().parent.parent          # ...\Vorlesung
OUT_JSON = Path(__file__).resolve().parent / "data" / "slides.json"

# ---- pick an extraction backend -------------------------------------------
backend = None
try:
    import fitz  # PyMuPDF
    backend = "pymupdf"
except Exception:
    try:
        from pypdf import PdfReader
        backend = "pypdf"
    except Exception:
        print("No PDF library found (need pymupdf or pypdf).")
        sys.exit(1)
print(f"Extraction backend: {backend}")


def vl_num(p: Path) -> int:
    m = re.search(r"VL\s*(\d+)", p.name, re.IGNORECASE)
    return int(m.group(1)) if m else 9999


def lecture_label(p: Path) -> str:
    # "DSCB140 - VL3 - Relationale Modellierung.pdf" -> "VL3 · Relationale Modellierung"
    stem = p.stem
    m = re.search(r"(VL\s*\d+)\s*-\s*(.+)$", stem, re.IGNORECASE)
    if m:
        return f"{m.group(1).replace(' ', '')} · {m.group(2).strip()}"
    return stem


def clean_text(t: str) -> str:
    if not t:
        return ""
    t = t.replace("­", "")          # soft hyphen
    t = re.sub(r"[ \t ]+", " ", t)   # collapse spaces/nbsp
    t = re.sub("[▪◾●○■►▸‣]", "•", t)  # bullets -> •
    t = re.sub(r"\n{2,}", "\n", t)        # collapse blank lines
    lines = [ln.strip() for ln in t.splitlines()]
    lines = [ln for ln in lines if ln]
    return "\n".join(lines).strip()


def guess_title(text: str, fallback: str) -> str:
    for ln in text.splitlines():
        s = ln.strip()
        s = re.sub(r"^[•\-\*–—\s]+", "", s)   # leading bullets/dashes
        s = re.sub(r"^\d{1,3}\s+(?=[A-Za-zÄÖÜäöü])", "", s)  # leading slide no.
        s = s.strip()
        if len(s) < 3:
            continue
        if re.fullmatch(r"[\d\W_]+", s):           # pure numbers/symbols
            continue
        if re.search(r"DSCB140|Folie|Prof\.|Seite\s*\d", s, re.IGNORECASE):
            continue
        return s[:90]
    return fallback


def extract_pages(path: Path):
    """Yield cleaned text per page, in order."""
    if backend == "pymupdf":
        doc = fitz.open(str(path))
        for page in doc:
            yield clean_text(page.get_text("text"))
        doc.close()
    else:
        reader = PdfReader(str(path))
        for page in reader.pages:
            try:
                raw = page.extract_text() or ""
            except Exception:
                raw = ""
            yield clean_text(raw)


def main():
    pdfs = sorted(SRC_DIR.glob("DSCB140 - VL*.pdf"), key=vl_num)
    if not pdfs:
        print("No source VL PDFs found in", SRC_DIR)
        sys.exit(1)

    slides = []
    lectures = []
    g = 0  # running global page number (1-based)
    for p in pdfs:
        label = lecture_label(p)
        start = g + 1
        local = 0
        for text in extract_pages(p):
            g += 1
            local += 1
            slides.append({
                "page": g,                       # global page == viewer page
                "lecture": label,
                "lectureNum": vl_num(p),
                "localPage": local,
                "title": guess_title(text, f"{label} — Folie {local}"),
                "text": text,
                "chars": len(text),
            })
        lectures.append({
            "num": vl_num(p),
            "name": label,
            "file": p.name,
            "startPage": start,
            "endPage": g,
            "pages": g - start + 1,
        })
        print(f"  VL{vl_num(p):<2} {label:<48} pages {start}-{g}")

    data = {
        "source": "DSCB140 - Alle Vorlesungen (VL1-VL7).pdf",
        "totalPages": g,
        "lectures": lectures,
        "slides": slides,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    empty = sum(1 for s in slides if s["chars"] < 5)
    avg = sum(s["chars"] for s in slides) / max(len(slides), 1)
    print(f"\nWrote {OUT_JSON}")
    print(f"  {len(slides)} pages, {len(lectures)} lectures")
    print(f"  avg {avg:.0f} chars/page, {empty} near-empty pages")
    print(f"  JSON size: {OUT_JSON.stat().st_size/1024:.0f} KB")

    print("\n--- sample: page 1 title ---")
    print(" ", slides[0]["title"])
    mid = slides[len(slides)//2]
    print(f"--- sample: page {mid['page']} ({mid['lecture']}) ---")
    print("  title:", mid["title"])
    print("  text :", mid["text"][:300].replace("\n", " / "))


if __name__ == "__main__":
    main()
