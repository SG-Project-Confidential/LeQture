#!/usr/bin/env python3
"""
Hardcoded image + text extractor with OCR fallback for:
  /Users/ace/Downloads/compressed(2).pdf

Creates output folder beside the PDF:
  /Users/ace/Downloads/YYYYMMDD-HHMMSS_compressed(2)/
    - images/IMAGE_0001.png, ...
    - slides_with_placeholders.txt (text + [IMAGE_xxxx.png] in reading order)

Requirements:
  brew install tesseract
  pip install pymupdf pillow pytesseract
"""

import os
from pathlib import Path
from datetime import datetime
import fitz  # PyMuPDF
from PIL import Image
import pytesseract

# -------------------- CONFIG (hardcoded as requested) --------------------
PDF_PATH = Path("/Users/ace/Downloads/compressed(2).pdf")
# ------------------------------------------------------------------------


def ensure_rgb_pixmap(doc, xref):
    """Return a fitz.Pixmap in RGB from an image xref (handles alpha/CMYK)."""
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)  # drop alpha
    if pix.n >= 4:                 # CMYK or similar -> convert to RGB
        pix = fitz.Pixmap(fitz.csRGB, pix)
    return pix


def save_clip_as_png(page, bbox, out_path, zoom=2.0):
    """Rasterize a clipped rectangle region from the page and save as PNG."""
    rect = fitz.Rect(bbox)
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, clip=rect, alpha=False)
    pix.save(out_path)


def page_image_for_ocr(page, zoom=3.0):
    """Render full page to PIL.Image for OCR."""
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    mode = "RGB" if pix.n == 3 else "L"
    img = Image.frombytes(mode, (pix.width, pix.height), pix.samples)
    if mode != "RGB":
        img = img.convert("RGB")
    return img


def ocr_extract_lines_with_positions(pil_img, psm="6", min_conf=60):
    """
    OCR the PIL image and return lines as [(y, x, text), ...] approximated by top-left.
    Uses pytesseract.image_to_data to keep positional info; groups words into lines.
    psm '6' assumes a single block of text; for cluttered slides, try '11'.
    """
    config = f"--psm {psm}"
    data = pytesseract.image_to_data(pil_img, output_type=pytesseract.Output.DICT, config=config)

    items = []
    # Group by (block_num, par_num, line_num)
    current_key = None
    current_words = []
    current_top = None
    current_left = None

    n = len(data["text"])
    for i in range(n):
        text = (data["text"][i] or "").strip()
        conf_str = data["conf"][i]
        try:
            conf = float(conf_str)
        except Exception:
            conf = -1.0

        if text == "" or conf < min_conf:
            continue

        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        if key != current_key:
            # flush previous line
            if current_key is not None and current_words:
                line_text = " ".join(current_words).strip()
                if line_text:
                    items.append((current_top, current_left, line_text))
            # start new line
            current_key = key
            current_words = [text]
            current_top = data["top"][i]
            current_left = data["left"][i]
        else:
            current_words.append(text)
            # keep min top/left
            current_top = min(current_top, data["top"][i])
            current_left = min(current_left, data["left"][i])

    # flush last
    if current_key is not None and current_words:
        line_text = " ".join(current_words).strip()
        if line_text:
            items.append((current_top, current_left, line_text))

    # sort roughly top-to-bottom, left-to-right
    items.sort(key=lambda t: (t[0], t[1]))
    return items


def main():
    if not PDF_PATH.exists():
        raise FileNotFoundError(f"PDF not found: {PDF_PATH}")

    base_dir = PDF_PATH.parent
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    folder_name = f"{timestamp}_{PDF_PATH.stem}"  # e.g., 20251014-103012_compressed(2)
    out_dir = base_dir / folder_name
    images_dir = out_dir / "images"

    out_dir.mkdir(parents=True, exist_ok=True)
    images_dir.mkdir(parents=True, exist_ok=True)

    txt_path = out_dir / "slides_with_placeholders.txt"

    doc = fitz.open(PDF_PATH)

    image_counter = 0
    # If an embedded image xref repeats, reuse the same filename
    xref_to_filename = {}

    with txt_path.open("w", encoding="utf-8") as txt:
        for page_index in range(len(doc)):
            page = doc[page_index]
            raw = page.get_text("rawdict")

            # Build a combined list of content items in reading order:
            # items are (y, x, kind, payload)
            #   kind == "text" => payload is str
            #   kind == "image" => payload is img_name
            content_items = []

            # ---- 1) Native text & images from PyMuPDF ----
            blocks = raw.get("blocks", []) if isinstance(raw, dict) else []
            for block in blocks:
                btype = block.get("type", None)
                bbox = block.get("bbox", [0, 0, 0, 0])
                y0, x0 = bbox[1], bbox[0]

                if btype == 0:
                    # text block -> add each line as separate content item
                    for line in block.get("lines", []):
                        line_text = "".join(span.get("text", "") for span in line.get("spans", []))
                        line_text = line_text.strip()
                        lbbox = line.get("bbox", bbox)
                        ly, lx = lbbox[1], lbbox[0]
                        if line_text:
                            content_items.append((ly, lx, "text", line_text))

                elif btype == 1:
                    # image block (embedded raster or placeholder for figure)
                    xref = block.get("xref", None)

                    if xref:
                        # Reuse existing file if we've seen this xref before
                        if xref in xref_to_filename:
                            img_name = xref_to_filename[xref]
                        else:
                            image_counter += 1
                            img_name = f"IMAGE_{image_counter:04d}.png"
                            out_path = images_dir / img_name
                            pix = ensure_rgb_pixmap(doc, xref)
                            pix.save(out_path)
                            xref_to_filename[xref] = img_name
                    else:
                        # No xref -> crop region into an image
                        image_counter += 1
                        img_name = f"IMAGE_{image_counter:04d}.png"
                        out_path = images_dir / img_name
                        save_clip_as_png(page, bbox, out_path)

                    content_items.append((y0, x0, "image", img_name))

                else:
                    # vector drawings, lines, etc. -> crop region as image to preserve flow
                    if bbox:
                        image_counter += 1
                        img_name = f"IMAGE_{image_counter:04d}.png"
                        out_path = images_dir / img_name
                        save_clip_as_png(page, bbox, out_path)
                        content_items.append((y0, x0, "image", img_name))

            # ---- 2) If NO native text found, OCR the page and insert OCR text ----
            native_text_found = any(k == "text" for _, _, k, _ in content_items)
            if not native_text_found:
                pil_img = page_image_for_ocr(page, zoom=3.0)
                ocr_lines = ocr_extract_lines_with_positions(pil_img, psm="6", min_conf=60)

                # If still empty, try sparse mode
                if not ocr_lines:
                    ocr_lines = ocr_extract_lines_with_positions(pil_img, psm="11", min_conf=55)

                for (ly, lx, line_text) in ocr_lines:
                    content_items.append((ly, lx, "text", line_text))

            # Sort everything by y, then x to approximate reading order
            content_items.sort(key=lambda t: (t[0], t[1], 0 if t[2] == "text" else 1))

            # ---- Write slide header and content ----
            txt.write(f"=== Slide {page_index + 1} ===\n")
            last_y = None
            for (y, x, kind, payload) in content_items:
                if kind == "text":
                    txt.write(payload + "\n")
                elif kind == "image":
                    txt.write(f"[{payload}]\n")
            txt.write("\n")  # blank line between slides

    doc.close()

    print("Done.")
    print(f"Output folder: {out_dir}")
    print(f"Text file:     {txt_path}")
    print(f"Images:        {images_dir}")


if __name__ == "__main__":
    main()
