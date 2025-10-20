#!/usr/bin/env python3
"""
Flask backend server for LeQture.
Provides endpoints for PDF processing, image serving, and Gemini API proxy.

Requirements:
  brew install tesseract
  pip install -r requirements.txt

Usage:
  python server.py
  Server will run on http://localhost:5000
"""

from flask import Flask, request, jsonify, send_file, Response
from pathlib import Path
from datetime import datetime
from dotenv import load_dotenv
from functools import wraps
from collections import defaultdict
from time import time
import fitz  # PyMuPDF
from PIL import Image
import pytesseract
import os
import shutil
import uuid
import requests
import json
import base64
from urllib.parse import quote
import sys
import re
from youtube_transcript_api import YouTubeTranscriptApi

# Load environment variables from .env file
load_env_path = Path(__file__).parent / ".env"
if not load_env_path.exists():
    print("=" * 70)
    print("ERROR: .env file not found!")
    print("=" * 70)
    print("Please create a .env file based on .env.example:")
    print("  1. Copy .env.example to .env")
    print("  2. Add your Gemini API key to the .env file")
    print("  3. Restart the server")
    print("=" * 70)
    sys.exit(1)

load_dotenv(dotenv_path=load_env_path)

app = Flask(__name__)

PROMPTS_DIR = Path(__file__).parent / "prompts"


def load_prompt(relative_path, required_tokens=None, strip=False):
    """Load prompt/template text from the prompts directory with validation."""
    path = PROMPTS_DIR / relative_path
    try:
        text = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        print("=" * 70)
        print("ERROR: Prompt template file not found!")
        print("=" * 70)
        print(f"Missing file: {path}")
        print("=" * 70)
        sys.exit(1)

    if required_tokens:
        missing = [token for token in required_tokens if token not in text]
        if missing:
            print("=" * 70)
            print("ERROR: Prompt template is missing required placeholder(s)!")
            print("=" * 70)
            print(f"File: {path}")
            print(f"Missing placeholder(s): {', '.join(missing)}")
            print("=" * 70)
            sys.exit(1)

    return text.strip() if strip else text

# CORS Configuration

ALLOWED_ORIGINS = [
    # Development
    r'^http://localhost:\d+$',
    r'^http://127\.0\.0\.1:\d+$',
    # Echo360 and all subdomains
    r'^https://[a-zA-Z0-9-]+\.echo360\.org\.uk$',
    r'^https://echo360\.org\.uk$',
    # Edinburgh University domains
    r'^https://[a-zA-Z0-9-]+\.inf\.ed\.ac\.uk$',
    r'^https://opencourse\.inf\.ed\.ac\.uk$',
    r'^https://[a-zA-Z0-9-]+\.learn\.ed\.ac\.uk$',
    r'^https://www\.learn\.ed\.ac\.uk$',
    # YouTube domains
    r'^https://www\.youtube\.com$',
    r'^https://[a-zA-Z0-9-]+\.youtube\.com$',
    # Extension origins
    r'^moz-extension://[a-zA-Z0-9-]+$',
    r'^chrome-extension://[a-zA-Z0-9]+$',
]

ALLOW_NULL_ORIGIN = False

import re

def is_origin_allowed(origin):
    """
    Validate origin against allowed patterns.
    Returns True if origin matches any allowed pattern.
    """
    if not origin:
        return False

    if origin == "null":
        if ALLOW_NULL_ORIGIN:
            if DEBUG:
                print(f"[CORS] ✓ Allowed null origin (configured)")
            return True
        if DEBUG:
            print(f"[CORS] ✗ REJECTED null origin. Set ALLOW_NULL_ORIGIN=true in .env to permit.")
        return False

    for i, pattern in enumerate(ALLOWED_ORIGINS):
        if re.match(pattern, origin):
            if DEBUG:
                print(f"[CORS] ✓ Allowed origin: {origin} (matched pattern {i}: {pattern})")
            return True

    if DEBUG:
        print(f"[CORS] ✗ REJECTED origin: {origin}")
        print(f"[CORS] DEBUG: Tested {len(ALLOWED_ORIGINS)} patterns")
        # Show YouTube patterns for debugging
        youtube_patterns = [p for p in ALLOWED_ORIGINS if 'youtube' in p.lower()]
        if youtube_patterns:
            print(f"[CORS] YouTube patterns loaded: {youtube_patterns}")
    return False

# Configuration with validation
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY or GEMINI_API_KEY == "your_gemini_api_key_here":
    print("=" * 70)
    print("ERROR: Valid GEMINI_API_KEY not found in .env file!")
    print("=" * 70)
    print("Please add your Gemini API key to the .env file.")
    print("Get your API key at: https://makersuite.google.com/app/apikey")
    print("=" * 70)
    sys.exit(1)

MINERU_API_KEY = os.getenv("MINERU_API_KEY", "")

HOST = os.getenv("HOST", "localhost")
PORT = int(os.getenv("PORT", 5000))
DEBUG = os.getenv("DEBUG", "True").lower() == "true"

EXTRA_ALLOWED_ORIGINS = os.getenv("EXTRA_ALLOWED_ORIGINS", "")
if EXTRA_ALLOWED_ORIGINS:
    extra_patterns = [pattern.strip() for pattern in EXTRA_ALLOWED_ORIGINS.split(",") if pattern.strip()]
    if extra_patterns:
        ALLOWED_ORIGINS.extend(extra_patterns)
        if DEBUG:
            for pattern in extra_patterns:
                print(f"[CORS] ➕ Added extra allowed origin pattern from env: {pattern}")

ALLOW_NULL_ORIGIN = os.getenv(
    "ALLOW_NULL_ORIGIN",
    "true" if DEBUG else "false"
).lower() == "true"
if DEBUG and ALLOW_NULL_ORIGIN:
    print("[CORS] ⚠️  Allowing null origin (intended for local development).")

# Security: Set max request size to 100MB (for large PDF uploads)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# Storage directory for processed PDFs
STORAGE_DIR = Path(__file__).parent / "extraction_storage"
STORAGE_DIR.mkdir(exist_ok=True)

# Store active extraction sessions: {session_id: extraction_path}
active_sessions = {}

# Store upload URLs server-side to avoid exposing Google URLs to client
# Format: {upload_session_id: google_upload_url}
upload_sessions = {}

# AI API base URLs (server-side only - never exposed to client)
GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta"


# ============================================================================
# SECURITY: Helper Functions
# ============================================================================

def strip_api_key_from_url(url):
    """
    Remove API key from Google URLs before sending to frontend.

    This prevents API key leakage in response headers that contain URLs.
    The API key is added back on the backend when making requests to Google.

    Args:
        url: URL string that might contain ?key=API_KEY parameter

    Returns:
        URL with API key parameter removed
    """
    if not url or not isinstance(url, str):
        return url

    from urllib.parse import urlparse, parse_qs, urlencode, urlunparse
    parsed = urlparse(url)
    query_params = parse_qs(parsed.query)

    # Remove 'key' parameter (the API key)
    if 'key' in query_params:
        query_params.pop('key')

        # Reconstruct URL without API key
        clean_query = urlencode(query_params, doseq=True)
        clean_url = urlunparse((
            parsed.scheme,
            parsed.netloc,
            parsed.path,
            parsed.params,
            clean_query,
            parsed.fragment
        ))

        if DEBUG:
            print(f"[SECURITY] Stripped API key from URL in header")

        return clean_url

    return url


# ============================================================================
# SECURITY: Rate Limiting
# ============================================================================

# Simple in-memory rate limiter
rate_limit_store = defaultdict(list)
RATE_LIMIT_WINDOW = 60  # seconds
RATE_LIMIT_MAX_REQUESTS = 100  # max requests per window


def rate_limit(max_requests=RATE_LIMIT_MAX_REQUESTS, window=RATE_LIMIT_WINDOW):
    """
    Rate limiting decorator.

    Args:
        max_requests: Maximum requests allowed per window
        window: Time window in seconds
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            # Use IP address as identifier
            identifier = request.remote_addr
            current_time = time()

            # Clean old requests outside the window
            rate_limit_store[identifier] = [
                req_time for req_time in rate_limit_store[identifier]
                if current_time - req_time < window
            ]

            # Check if rate limit exceeded
            if len(rate_limit_store[identifier]) >= max_requests:
                return jsonify({
                    "error": "Rate limit exceeded",
                    "message": f"Maximum {max_requests} requests per {window} seconds"
                }), 429

            # Add current request
            rate_limit_store[identifier].append(current_time)

            return f(*args, **kwargs)
        return decorated_function
    return decorator


# ============================================================================
# SECURITY: Request Validation
# ============================================================================

def validate_json_request(required_fields=None):
    """
    Validate that request contains valid JSON with required fields.

    Args:
        required_fields: List of required field names
    """
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not request.is_json:
                return jsonify({"error": "Content-Type must be application/json"}), 400

            data = request.get_json()
            if not data:
                return jsonify({"error": "Request body must contain valid JSON"}), 400

            if required_fields:
                missing = [field for field in required_fields if field not in data]
                if missing:
                    return jsonify({
                        "error": "Missing required fields",
                        "missing_fields": missing
                    }), 400

            return f(*args, **kwargs)
        return decorated_function
    return decorator


# ============================================================================
# SECURITY: Add security headers to all responses
# ============================================================================

@app.after_request
def add_security_and_cors_headers(response):
    """Add security headers and CORS headers to all responses."""
    # Get the origin from the request
    origin = request.headers.get('Origin')

    # CORS Headers - Only add if origin is allowed
    if origin:
        if is_origin_allowed(origin):
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Goog-Upload-Protocol, X-Goog-Upload-Command, X-Goog-Upload-Header-Content-Type, X-Goog-Upload-Offset, X-Requested-With'
            response.headers['Access-Control-Expose-Headers'] = 'X-Goog-Upload-URL, X-Goog-Upload-Status, Content-Type'
            response.headers['Access-Control-Max-Age'] = '3600'
        else:
            # Origin not allowed and this is a cross-origin request
            # Log the rejection
            if DEBUG and request.method != 'OPTIONS':  # OPTIONS already logged in before_request
                print(f"[CORS] ❌ BLOCKED {request.method} request from disallowed origin: {origin}")
                print(f"[CORS] 💡 To allow this origin, add a regex pattern to ALLOWED_ORIGINS in server.py")
                print(f"[CORS] 📝 Example patterns:")
                print(f"[CORS]    - Exact match: r'^{origin}$'")
                if origin.startswith('http://'):
                    print(f"[CORS]    - Subdomain match: r'^http://[a-zA-Z0-9-]+\\.yourdomain\\.com$'")
                elif origin.startswith('https://'):
                    print(f"[CORS]    - Subdomain match: r'^https://[a-zA-Z0-9-]+\\.yourdomain\\.com$'")

    # Security Headers
    # Prevent clickjacking
    response.headers['X-Frame-Options'] = 'DENY'
    # Prevent MIME sniffing
    response.headers['X-Content-Type-Options'] = 'nosniff'
    # Enable XSS protection
    response.headers['X-XSS-Protection'] = '1; mode=block'
    # Strict transport security
    if not DEBUG:
        response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'

    return response


# ============================================================================
# CORS & LOGGING: Handle preflight and log requests
# ============================================================================

@app.before_request
def handle_preflight_and_logging():
    """Handle CORS preflight OPTIONS requests and log all requests."""
    origin = request.headers.get('Origin')

    # Log ALL requests with origin information for debugging
    if DEBUG:
        print(f"[{datetime.now().isoformat()}] {request.method} {request.path} from {request.remote_addr}")
        if origin:
            print(f"  Origin: {origin}")
        if request.is_json and request.path.startswith('/api/'):
            print(f"  Content-Type: {request.content_type}, Body size: {request.content_length or 0} bytes")

    # Handle CORS preflight first
    if request.method == 'OPTIONS':
        if origin and is_origin_allowed(origin):
            response = app.make_response('')
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
            response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Goog-Upload-Protocol, X-Goog-Upload-Command, X-Goog-Upload-Header-Content-Type, X-Goog-Upload-Offset, X-Requested-With'
            response.headers['Access-Control-Max-Age'] = '3600'
            return response
        elif origin:
            # Origin not allowed - return 403 with explanation
            print(f"[CORS] ❌ BLOCKED OPTIONS request from disallowed origin: {origin}")
            print(f"[CORS] 💡 To allow this origin, add it to ALLOWED_ORIGINS in server.py")
            return jsonify({
                "error": "CORS: Origin not allowed",
                "origin": origin,
                "message": "This origin is not in the allowed origins list. Check server logs for details."
            }), 403


# ============================================================================
# PDF EXTRACTION UTILITIES (Keep existing functionality)
# ============================================================================

def has_true_images(pdf_path, fullpage_threshold=0.9):
    """
    Return True if the PDF contains any embedded image blocks that are
    not full-page background bitmaps. Uses on-page bbox (page units).
    """
    doc = fitz.open(pdf_path)
    try:
        for page in doc:
            page_area = page.rect.width * page.rect.height
            img_blocks = [b for b in page.get_text("rawdict").get("blocks", []) if b.get("type") == 1]
            for b in img_blocks:
                x0, y0, x1, y1 = b["bbox"]
                w, h = (x1 - x0), (y1 - y0)
                coverage = (w * h) / page_area if page_area else 0.0
                if coverage < fullpage_threshold:
                    return True
        return False
    finally:
        doc.close()


def ensure_rgb_pixmap(doc, xref):
    """Return a fitz.Pixmap in RGB from an image xref (handles alpha/CMYK)."""
    pix = fitz.Pixmap(doc, xref)
    if pix.alpha:
        pix = fitz.Pixmap(pix, 0)
    if pix.n >= 4:
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
    OCR the PIL image and return lines as [(y, x, text), ...].
    """
    config = f"--psm {psm}"
    data = pytesseract.image_to_data(pil_img, output_type=pytesseract.Output.DICT, config=config)

    items = []
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
            if current_key is not None and current_words:
                line_text = " ".join(current_words).strip()
                if line_text:
                    items.append((current_top, current_left, line_text))
            current_key = key
            current_words = [text]
            current_top = data["top"][i]
            current_left = data["left"][i]
        else:
            current_words.append(text)
            current_top = min(current_top, data["top"][i])
            current_left = min(current_left, data["left"][i])

    if current_key is not None and current_words:
        line_text = " ".join(current_words).strip()
        if line_text:
            items.append((current_top, current_left, line_text))

    items.sort(key=lambda t: (t[0], t[1]))
    return items


def extract_pdf_images_and_text(pdf_path):
    """
    Extract images and text from PDF, returning:
    - txt_content: text with [IMAGE_XXXX.png] placeholders
    - images_dir: path to images directory
    - image_list: list of image filenames
    """
    out_dir = pdf_path.parent
    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    txt_lines = []
    doc = fitz.open(pdf_path)

    image_counter = 0
    xref_to_filename = {}
    image_list = []

    for page_index in range(len(doc)):
        page = doc[page_index]
        raw = page.get_text("rawdict")

        content_items = []

        blocks = raw.get("blocks", []) if isinstance(raw, dict) else []
        for block in blocks:
            btype = block.get("type", None)
            bbox = block.get("bbox", [0, 0, 0, 0])
            y0, x0 = bbox[1], bbox[0]

            if btype == 0:
                for line in block.get("lines", []):
                    line_text = "".join(span.get("text", "") for span in line.get("spans", []))
                    line_text = line_text.strip()
                    lbbox = line.get("bbox", bbox)
                    ly, lx = lbbox[1], lbbox[0]
                    if line_text:
                        content_items.append((ly, lx, "text", line_text))

            elif btype == 1:
                xref = block.get("xref", None)

                if xref:
                    if xref in xref_to_filename:
                        img_name = xref_to_filename[xref]
                    else:
                        image_counter += 1
                        img_name = f"IMAGE_{image_counter:04d}.png"
                        out_path = images_dir / img_name
                        pix = ensure_rgb_pixmap(doc, xref)
                        pix.save(out_path)
                        xref_to_filename[xref] = img_name
                        image_list.append(img_name)
                else:
                    image_counter += 1
                    img_name = f"IMAGE_{image_counter:04d}.png"
                    out_path = images_dir / img_name
                    save_clip_as_png(page, bbox, out_path)
                    image_list.append(img_name)

                content_items.append((y0, x0, "image", img_name))

            else:
                if bbox:
                    image_counter += 1
                    img_name = f"IMAGE_{image_counter:04d}.png"
                    out_path = images_dir / img_name
                    save_clip_as_png(page, bbox, out_path)
                    content_items.append((y0, x0, "image", img_name))
                    image_list.append(img_name)

        native_text_found = any(k == "text" for _, _, k, _ in content_items)
        if not native_text_found:
            pil_img = page_image_for_ocr(page, zoom=3.0)
            ocr_lines = ocr_extract_lines_with_positions(pil_img, psm="6", min_conf=60)

            if not ocr_lines:
                ocr_lines = ocr_extract_lines_with_positions(pil_img, psm="11", min_conf=55)

            for (ly, lx, line_text) in ocr_lines:
                content_items.append((ly, lx, "text", line_text))

        content_items.sort(key=lambda t: (t[0], t[1], 0 if t[2] == "text" else 1))

        txt_lines.append(f"=== Slide {page_index + 1} ===")
        for (y, x, kind, payload) in content_items:
            if kind == "text":
                txt_lines.append(payload)
            elif kind == "image":
                txt_lines.append(f"[{payload}]")
        txt_lines.append("")

    doc.close()

    txt_content = "\n".join(txt_lines)
    return txt_content, images_dir, image_list


# ============================================================================
# AI API PROXY ENDPOINTS (Generic naming for privacy)
# ============================================================================

@app.route('/api/ai/generate', methods=['POST'])
@rate_limit(max_requests=60, window=60)  # 60 requests per minute
@validate_json_request(required_fields=['contents'])
def gemini_generate():
    """
    Proxy endpoint for Gemini generateContent API.

    Request body: {
        "model": "models/gemini-2.5-flash" or "gemini-2.5-flash",
        "contents": [...],
        "generationConfig": {...},
        "systemInstruction": {...} (optional)
    }

    Returns the Gemini API response as-is.
    """
    try:
        if not GEMINI_API_KEY:
            return jsonify({"error": "GEMINI_API_KEY not configured"}), 500

        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        # Get model from request
        model = data.get("model", "models/gemini-2.5-flash")

        # Normalize model name (remove "models/" prefix if present for the URL)
        if model.startswith("models/"):
            model_for_url = model
        else:
            model_for_url = f"models/{model}"

        # Build URL
        url = f"{GEMINI_API_BASE}/{model_for_url}:generateContent"

        # Add API key as query parameter
        params = {"key": GEMINI_API_KEY}

        # Remove 'model' from request body (it's in the URL, not the body)
        gemini_data = {k: v for k, v in data.items() if k != 'model'}

        # Forward the request to Gemini
        headers = {
            "Content-Type": "application/json"
        }

        response = requests.post(url, params=params, headers=headers, json=gemini_data, timeout=120)

        # SECURITY: Only forward safe headers
        response_headers = {}
        safe_headers = ['Content-Type', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']

        for header_name in safe_headers:
            if header_name in response.headers:
                response_headers[header_name] = response.headers[header_name]

        # Return response as-is (no encoding needed - frontend will parse JSON directly)
        if DEBUG:
            print(f"[Backend] Response status: {response.status_code}")
            print(f"[Backend] Response length: {len(response.content)} bytes")
            try:
                json_data = json.loads(response.content)
                has_candidates = bool(json_data.get('candidates'))
                print(f"[Backend] Response is valid JSON. Has candidates: {has_candidates}")
                if has_candidates and len(json_data['candidates']) > 0:
                    has_text = bool(json_data['candidates'][0].get('content', {}).get('parts', [{}])[0].get('text'))
                    print(f"[Backend] First candidate has text: {has_text}")
            except Exception as e:
                print(f"[Backend] Response is not valid JSON or error: {e}")

        return Response(
            response.content,
            status=response.status_code,
            headers=response_headers
        )

    except requests.exceptions.Timeout:
        return jsonify({"error": "Request to Gemini API timed out"}), 504
    except requests.exceptions.RequestException as e:
        print(f"[Backend] Gemini API request failed: {e}")
        return jsonify({"error": f"Gemini API request failed: {str(e)}"}), 502
    except Exception as e:
        print(f"[Backend] Error in gemini_generate: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/ai/generate-with-header', methods=['POST'])
@rate_limit(max_requests=60, window=60)  # 60 requests per minute
@validate_json_request(required_fields=['contents'])
def gemini_generate_with_header():
    """
    Proxy endpoint for Gemini generateContent API with x-goog-api-key header.
    Used for TTS and other endpoints that require header-based auth.

    Request body: {
        "model": "models/gemini-2.5-flash-preview-tts",
        "contents": [...],
        "generationConfig": {...}
    }

    Returns the Gemini API response as-is.
    """
    try:
        if not GEMINI_API_KEY:
            return jsonify({"error": "GEMINI_API_KEY not configured"}), 500

        data = request.get_json()
        if not data:
            return jsonify({"error": "No JSON data provided"}), 400

        # Get model from request
        model = data.get("model", "models/gemini-2.5-flash-preview-tts")

        # Normalize model name
        if model.startswith("models/"):
            model_for_url = model
        else:
            model_for_url = f"models/{model}"

        # Build URL (no query params for header auth)
        url = f"{GEMINI_API_BASE}/{model_for_url}:generateContent"

        # Remove 'model' from request body (it's in the URL, not the body)
        gemini_data = {k: v for k, v in data.items() if k != 'model'}

        # Use header authentication
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
        }

        response = requests.post(url, headers=headers, json=gemini_data, timeout=120)

        # SECURITY: Only forward safe headers
        response_headers = {}
        safe_headers = ['Content-Type', 'Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset']

        for header_name in safe_headers:
            if header_name in response.headers:
                response_headers[header_name] = response.headers[header_name]

        # Return response as-is (no encoding)
        if DEBUG:
            print(f"[Backend Header Auth] Response status: {response.status_code}")
            print(f"[Backend Header Auth] Response length: {len(response.content)} bytes")

        return Response(
            response.content,
            status=response.status_code,
            headers=response_headers
        )

    except requests.exceptions.Timeout:
        return jsonify({"error": "Request to Gemini API timed out"}), 504
    except requests.exceptions.RequestException as e:
        print(f"[Backend] Gemini API request failed: {e}")
        return jsonify({"error": f"Gemini API request failed: {str(e)}"}), 502
    except Exception as e:
        print(f"[Backend] Error in gemini_generate_with_header: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/ai/upload', methods=['POST'])
@rate_limit(max_requests=20, window=60)  # 20 uploads per minute (lower limit for uploads)
def gemini_upload():
    """
    Proxy endpoint for Gemini resumable upload API.
    Handles both init and finalize steps.

    SECURITY: Google URLs are NEVER exposed to client.
    Upload URLs are stored server-side and referenced by session ID only.

    INIT step:
        Request body (JSON): {"file": {"display_name": "filename"}}
        Headers: X-Goog-Upload-Protocol, X-Goog-Upload-Command: start
        Response: X-Goog-Upload-URL header with backend URL + session_id (NO Google URL)

    FINALIZE step:
        Request body: Binary file data
        Headers: X-Goog-Upload-Command: upload, finalize
        Query param: session_id=<id_from_init_response>
    """
    try:
        if not GEMINI_API_KEY:
            return jsonify({"error": "GEMINI_API_KEY not configured"}), 500

        # Check if this is a finalize request (has session_id param)
        upload_session_id = request.args.get('session_id')

        if upload_session_id:
            # This is a FINALIZE request
            print(f"[Backend] Handling upload finalize for session: {upload_session_id}")

            # SECURITY: Retrieve the Google upload URL from server-side storage
            # Client never sees the Google URL
            if upload_session_id not in upload_sessions:
                return jsonify({"error": "Invalid or expired upload session"}), 404

            google_upload_url = upload_sessions[upload_session_id]

            if DEBUG:
                print(f"[SECURITY] Retrieved Google upload URL from server-side storage")

            # Forward the binary body to the Google upload URL
            finalize_headers = {}
            for header_name, header_value in request.headers:
                if header_name.lower().startswith('x-goog-upload'):
                    finalize_headers[header_name] = header_value

            finalize_response = requests.post(
                google_upload_url,  # Use Google URL from server-side storage
                headers=finalize_headers,
                data=request.get_data(),  # Binary file data
                timeout=60
            )

            # Clean up session after successful upload
            if finalize_response.status_code < 400:
                del upload_sessions[upload_session_id]
                if DEBUG:
                    print(f"[Backend] Cleaned up upload session: {upload_session_id}")

            # SECURITY: Return ONLY safe headers - NO Google URLs
            # Only forward content-type and status headers, nothing that could expose Google
            clean_headers = {}
            if 'Content-Type' in finalize_response.headers:
                clean_headers['Content-Type'] = finalize_response.headers['Content-Type']

            return Response(
                finalize_response.content,
                status=finalize_response.status_code,
                headers=clean_headers
            )

        else:
            # This is an INIT request
            print(f"[Backend] Handling upload init")

            # Get request data
            data = request.get_json()
            if not data:
                return jsonify({"error": "No JSON data provided"}), 400

            # Forward request to Google to get upload URL
            init_url = f"{GEMINI_UPLOAD_BASE}/files"
            init_params = {"key": GEMINI_API_KEY}

            # Copy relevant upload headers from request
            init_headers = {
                "Content-Type": "application/json"
            }

            # Copy X-Goog-Upload-* headers if present
            for header_name, header_value in request.headers:
                if header_name.lower().startswith('x-goog-upload'):
                    init_headers[header_name] = header_value

            init_response = requests.post(
                init_url,
                params=init_params,
                headers=init_headers,
                json=data,
                timeout=30
            )

            # SECURITY: Store Google upload URL server-side, return only session ID to client
            # Extract the upload URL from Google's response
            google_upload_url = init_response.headers.get('X-Goog-Upload-URL')

            if google_upload_url:
                # Create a session ID to reference this upload
                session_id = str(uuid.uuid4())

                # Store Google URL server-side
                upload_sessions[session_id] = google_upload_url

                if DEBUG:
                    print(f"[SECURITY] Stored Google upload URL server-side with session: {session_id}")
                    print(f"[SECURITY] Client will NEVER see Google URLs")

                # Return backend URL with session ID
                backend_upload_url = f"http://{HOST}:{PORT}/api/ai/upload?session_id={session_id}"

                # Build response headers
                response_headers = {
                    'X-Goog-Upload-URL': backend_upload_url,
                    'Content-Type': init_response.headers.get('Content-Type', 'application/json')
                }

                # Forward upload status if present
                if 'X-Goog-Upload-Status' in init_response.headers:
                    response_headers['X-Goog-Upload-Status'] = init_response.headers['X-Goog-Upload-Status']

                if DEBUG:
                    print(f"[Backend] Returning backend URL to client: {backend_upload_url}")

                return Response(
                    init_response.content,
                    status=init_response.status_code,
                    headers=response_headers
                )
            else:
                # No upload URL in response - return error
                return Response(
                    init_response.content,
                    status=init_response.status_code,
                    headers={'Content-Type': init_response.headers.get('Content-Type', 'application/json')}
                )

    except requests.exceptions.Timeout:
        return jsonify({"error": "Upload request timed out"}), 504
    except requests.exceptions.RequestException as e:
        print(f"[Backend] Gemini upload failed: {e}")
        return jsonify({"error": f"Gemini upload failed: {str(e)}"}), 502
    except Exception as e:
        print(f"[Backend] Error in gemini_upload: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/ai/file/<file_name>', methods=['GET'])
@rate_limit(max_requests=60, window=60)
def gemini_get_file(file_name):
    """
    Proxy endpoint for getting file metadata from Gemini.

    SECURITY: Removes 'uri' field from response to prevent Google URL exposure.

    GET /api/gemini/file/{file_name}
    """
    try:
        if not GEMINI_API_KEY:
            return jsonify({"error": "GEMINI_API_KEY not configured"}), 500

        url = f"{GEMINI_API_BASE}/files/{file_name}"
        params = {"key": GEMINI_API_KEY}

        response = requests.get(url, params=params, timeout=30)

        # SECURITY: Sanitize response body to remove Google URLs
        # File metadata may contain 'uri' field with Google URL
        if response.status_code == 200 and 'application/json' in response.headers.get('Content-Type', ''):
            try:
                data = response.json()
                # Remove 'uri' field if present (contains Google URL)
                if 'uri' in data:
                    del data['uri']
                    if DEBUG:
                        print(f"[SECURITY] Removed 'uri' field from file metadata response")
                return jsonify(data), response.status_code
            except Exception as e:
                # If JSON parsing fails, return original response
                if DEBUG:
                    print(f"[Backend] Failed to parse file metadata JSON: {e}")
                return Response(
                    response.content,
                    status=response.status_code,
                    content_type=response.headers.get('Content-Type', 'application/json')
                )
        else:
            # Non-200 or non-JSON response
            return Response(
                response.content,
                status=response.status_code,
                content_type=response.headers.get('Content-Type', 'application/json')
            )

    except requests.exceptions.Timeout:
        return jsonify({"error": "Request timed out"}), 504
    except requests.exceptions.RequestException as e:
        print(f"[Backend] Gemini get file failed: {e}")
        return jsonify({"error": f"Gemini get file failed: {str(e)}"}), 502
    except Exception as e:
        print(f"[Backend] Error in gemini_get_file: {e}")
        return jsonify({"error": str(e)}), 500


# ============================================================================
# MINERU API PROXY ENDPOINT
# ============================================================================

@app.route('/api/mineru/extract', methods=['POST'])
@rate_limit(max_requests=10, window=60)  # 10 extractions per minute (MinerU is expensive)
@validate_json_request(required_fields=['pdfUrl'])
def mineru_extract():
    """
    Proxy endpoint for MinerU PDF extraction API.

    SECURITY: MinerU API key stored server-side only, never exposed to client.

    Request body: {
        "pdfUrl": "https://example.com/file.pdf"
    }

    Response: {
        "success": true,
        "markdown": "extracted content...",
        "taskId": "task_id_from_mineru"
    }
    """
    try:
        if not MINERU_API_KEY:
            return jsonify({
                "error": "MinerU API key not configured",
                "message": "MINERU_API_KEY is missing in .env file"
            }), 500

        data = request.get_json()
        pdf_url = data.get('pdfUrl')

        if not pdf_url:
            return jsonify({"error": "pdfUrl is required"}), 400

        if DEBUG:
            print(f"[MinerU] Creating extraction task for PDF: {pdf_url[:100]}...")

        # Step 1: Create extraction task
        create_task_url = "https://mineru.net/api/v4/extract/task"
        create_headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {MINERU_API_KEY}"
        }
        create_payload = {
            "url": pdf_url,
            "is_ocr": True,
            "enable_table": True
        }

        create_response = requests.post(
            create_task_url,
            headers=create_headers,
            json=create_payload,
            timeout=30
        )

        if create_response.status_code != 200:
            error_detail = create_response.text
            print(f"[MinerU] Task creation failed: {error_detail}")
            return jsonify({
                "error": "MinerU task creation failed",
                "details": error_detail,
                "status_code": create_response.status_code
            }), 502

        create_result = create_response.json()
        task_id = create_result.get('data', {}).get('task_id')

        if not task_id:
            print(f"[MinerU] No task_id in response: {create_result}")
            return jsonify({
                "error": "MinerU did not return a task_id",
                "response": create_result
            }), 502

        if DEBUG:
            print(f"[MinerU] Task created: {task_id}")

        # Step 2: Poll for task completion (max 60 attempts = 5 minutes)
        import time
        max_attempts = 60
        poll_interval = 5  # seconds

        status_url = f"https://mineru.net/api/v4/extract/task/{task_id}"
        status_headers = {
            "Authorization": f"Bearer {MINERU_API_KEY}"
        }

        for attempt in range(max_attempts):
            if DEBUG and attempt % 5 == 0:  # Log every 5th attempt
                print(f"[MinerU] Polling task status (attempt {attempt + 1}/{max_attempts})...")

            time.sleep(poll_interval)

            status_response = requests.get(
                status_url,
                headers=status_headers,
                timeout=30
            )

            if status_response.status_code != 200:
                print(f"[MinerU] Status check failed: {status_response.text}")
                continue

            status_result = status_response.json()

            # IMPORTANT: MinerU API uses 'state' field, not 'status'
            # Check both data.state and state
            task_data = status_result.get('data', {})
            state = task_data.get('state') or status_result.get('state') or ''

            if DEBUG:
                print(f"[MinerU] Task state: '{state}'")
                if not state:
                    # Debug: show full response if state is empty
                    print(f"[MinerU] DEBUG - Full response: {json.dumps(status_result, indent=2)[:500]}")

            # Check if state starts with 'done' (case-insensitive)
            if state.lower().startswith('done'):
                # Task completed successfully
                if DEBUG:
                    print(f"[MinerU] ✓ Extraction DONE!")

                # Get markdown URL - check both data.full_md_link and full_md_link
                markdown_url = task_data.get('full_md_link') or status_result.get('full_md_link')

                if not markdown_url:
                    print(f"[MinerU] No full_md_link in response: {status_result}")
                    return jsonify({
                        "error": "MinerU task completed but no full_md_link provided",
                        "task_data": task_data
                    }), 502

                # Step 3: Fetch the markdown content
                if DEBUG:
                    print(f"[MinerU] Fetching markdown from: {markdown_url}")

                markdown_response = requests.get(markdown_url, timeout=30)

                if markdown_response.status_code != 200:
                    return jsonify({
                        "error": "Failed to fetch markdown content",
                        "markdown_url": markdown_url,
                        "status_code": markdown_response.status_code
                    }), 502

                markdown_content = markdown_response.text

                if DEBUG:
                    print(f"[MinerU] Extraction complete. Markdown length: {len(markdown_content)} chars")

                return jsonify({
                    "success": True,
                    "markdown": markdown_content,
                    "taskId": task_id
                })

            # Check if state contains 'fail' or 'error' (case-insensitive)
            # Original frontend: if (state.toLowerCase().includes('fail') || state.toLowerCase().includes('error'))
            elif 'fail' in state.lower() or 'error' in state.lower():
                # Extract error message
                error_msg = task_data.get('error') or task_data.get('msg') or status_result.get('error') or status_result.get('msg') or 'Unknown error'
                print(f"[MinerU] ✗ Extraction FAILED with state: {state}, error: {error_msg}")
                return jsonify({
                    "error": "MinerU extraction task failed",
                    "message": error_msg,
                    "state": state,
                    "taskId": task_id
                }), 502

            # Task still in progress, continue polling

        # Timeout after max_attempts
        return jsonify({
            "error": "MinerU extraction timeout",
            "message": f"Task did not complete after {max_attempts * poll_interval} seconds",
            "taskId": task_id
        }), 504

    except requests.exceptions.Timeout:
        return jsonify({"error": "Request to MinerU API timed out"}), 504
    except requests.exceptions.RequestException as e:
        print(f"[Backend] MinerU API request failed: {e}")
        return jsonify({"error": f"MinerU API request failed: {str(e)}"}), 502
    except Exception as e:
        print(f"[Backend] Error in mineru_extract: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


QUIZ_PROMPT = load_prompt("quiz/quiz_main.txt")

FLASHCARD_PROMPT_TEMPLATE = load_prompt(
    "flashcards/flashcard_generation.txt",
    required_tokens=["${flashcardCount}"]
)

SUMMARY_PROMPT_LEQTURE_BASE64 = load_prompt("summary/summary_leqture (base64).txt", strip=True)
SUMMARY_PROMPT_PLAIN_BASE64 = load_prompt("summary/summary_plain (base64).txt", strip=True)
SUMMARY_PROMPT_HTML_BASE64 = load_prompt("summary/summary_html (base64).txt", strip=True)

SUMMARY_EXTRA_CHECKLIST_HTML_BASE64 = load_prompt(
    "summary/extras_checklist_html (base64).txt",
    strip=True
)
SUMMARY_EXTRA_CHECKLIST_LATEX_BASE64 = load_prompt(
    "summary/extras_checklist_latex (base64).txt",
    strip=True
)

SUMMARY_EXTRAS_HTML = {
      'Additional Worked Examples': 'Include additional worked examples throughout the summary to illustrate key concepts.',
      'ChecklistHTML': SUMMARY_EXTRA_CHECKLIST_HTML_BASE64,
      'Detailed': 'Provide detailed explanations with in-depth coverage of all topics.',
      'Concise': 'Keep explanations concise and focused on essential information only.',
      'Reference Timestamps': 'Reference timestamps from the lecture transcript when explaining concepts to help students locate relevant sections.'
    }

SUMMARY_EXTRAS_LATEX = {
      'LeQture Theme': '',  # No additional prompt, it's in the base prompt
      'Additional Worked Examples': 'Include additional worked examples throughout the summary to illustrate key concepts.',
      'ChecklistLATEX': SUMMARY_EXTRA_CHECKLIST_LATEX_BASE64,
      'Detailed': 'Provide detailed explanations with in-depth coverage of all topics.',
      'Concise': 'Keep explanations concise and focused on essential information only.',
      'Reference Timestamps': 'Reference timestamps from the lecture transcript when explaining concepts to help students locate relevant sections.',
      'New Page Per Subtopic': 'Start each major subtopic on a new page for better organization and readability. Number subtopics starting from 0.1 (e.g., 0.1, 0.2, 0.3), not from 0 or 1.'
    }

# ============================================================================
# AUXILIARY PROMPTS (Checklist, Coverage Analysis, LaTeX Repair)
# ============================================================================

CHECKLIST_PROMPT = load_prompt("checklist/checklist_generation.txt")

COVERAGE_PROMPT = load_prompt("checklist/checklist_coverage.txt", required_tokens=["${item}"])

REPAIR_PROMPT = load_prompt("misc/latex_repair_prompt.txt", required_tokens=["${latexContent}"])

LATEX_FIX_PROMPT = load_prompt("checklist/latex_repair_checklist.txt", required_tokens=["${checklistLatex}"])

QUIZ_FROM_FLASHCARDS_PROMPT = load_prompt("quiz/quiz_from_flashcards.txt", required_tokens=["${flashcardsText}"])

FLASHCARD_LATEX_REPAIR_PROMPT = load_prompt(
    "flashcards/latex_repair_flashcards.txt",
    required_tokens=["${flashcardLatex}"]
)

SUMMARY_EXPLAINER_PROMPT = load_prompt("misc/summary_explainer.txt", required_tokens=["${selectedText}", "${question}", "${fullContext}"])


# ============================================================================
# SYSTEM GUARDRAILS FUNCTION (Dynamic chat system instructions)
# ============================================================================

def build_system_guardrails(answer_mode, colorblind_mode=False, custom_instruction=None):
    """
    Build system guardrails for AI chat responses.

    Args:
        answer_mode: "detailed", "concise", or "custom"
        colorblind_mode: Boolean, whether to add colorblind accessibility instructions
        custom_instruction: Custom instruction string when answer_mode is "custom"

    Returns:
        String with all system guardrails joined by newlines
    """
    rules = []

    # Add answer type as the very first critical instruction
    if answer_mode == "detailed":
        rules.append("CRITICAL INSTRUCTION: Respond in detail with comprehensive explanations, providing thorough analysis and context.")
    elif answer_mode == "custom" and custom_instruction:
        rules.append(f"CRITICAL INSTRUCTION: {custom_instruction}")
    else:  # concise mode (default)
        rules.extend([
            "═══════════════════════════════════════════════════════════",
            "⚠️  CRITICAL INSTRUCTION - HIGHEST PRIORITY ⚠️",
            "═══════════════════════════════════════════════════════════",
            "",
            "CONCISE MODE ACTIVATED - STRICT ENFORCEMENT:",
            "",
            "1. Keep responses SHORT - Maximum 2-3 sentences unless absolutely necessary",
            "2. Get straight to the point - NO unnecessary introductions or preambles",
            "3. Use simple, direct language - NO verbose explanations",
            "4. Answer ONLY what was asked - NO additional elaboration",
            "5. Prioritize brevity over completeness - Give the essential answer",
            "",
            "BAD (verbose): 'This is an excellent question. To understand this concept, we need to first consider the background. The topic you're asking about relates to...'",
            "GOOD (concise): 'This is X because Y.'",
            "",
            "If the question can be answered in 1 sentence, use 1 sentence.",
            "If it needs 2 sentences, use 2 sentences. Never more than 4 sentences unless complex technical explanation is required.",
            "",
            "═══════════════════════════════════════════════════════════",
        ])

    rules.extend(["", "═══ SYSTEM RULES (STRICT ENFORCEMENT) ═══", ""])

    # Add colorblind mode instruction as priority
    if colorblind_mode:
        rules.extend([
            "🔴 CRITICAL ACCESSIBILITY REQUIREMENT:",
            "   The user is colorblind. NEVER refer to items by color alone.",
            "   Always describe by: position (top-left, center, bottom), shape, pattern, label, texture, or other distinguishing features.",
            "   Example: Instead of 'the red box', say 'the box in the top-left corner' or 'the dashed-outline box'.",
            "",
        ])

    rules.extend([
        "📋 CONTEXT HIERARCHY (Priority Order):",
        "   1. CURRENT VIDEO FRAME (attached image) - This is what the user sees RIGHT NOW",
        "   2. NEAR-FRAME TRANSCRIPT - Audio spoken within ~30 seconds of current timestamp",
        "   3. CURRENT USER QUESTION - The immediate question being asked",
        "   4. CONVERSATION HISTORY - Previous exchanges (use only if directly relevant)",
        "   5. FULL RESOURCES - Complete PDF slides and full transcript (background context only)",
        "",
        "🎯 GROUNDING REQUIREMENTS:",
        "   • The user CANNOT see the PDF slides directly - they only see the current video frame",
        "   • Only reference what is VISIBLE in the image or SPOKEN in the near-frame transcript",
        "   • When citing transcript content, always include timestamps (e.g., 'At 3:45, the professor states...')",
        "   • Do NOT infer or extrapolate from the full PDF unless it directly explains what's visible/audible",
        "   • Distinguish clearly between: (a) what you see in the frame, (b) what's said in audio, (c) additional context from materials",
        "",
        "💬 CONVERSATION HANDLING:",
        "   • The CURRENT message has absolute priority - answer what is being asked NOW",
        "   • Previous conversation turns provide context only - use them if the current message clearly continues that topic",
        "   • If the message is an acknowledgement ('thanks', 'ok', 'got it'), respond briefly without re-analyzing",
        "   • Multi-part questions: Address each part systematically",
        "",
        "✏️ FORMATTING & ACCURACY:",
        "   • LaTeX math is fully supported - use $ for inline and $$ for display equations",
        "   • Be precise with technical terminology from the lecture",
        "   • If uncertain about something not clearly visible/audible, acknowledge the limitation",
    ])

    if answer_mode == "detailed":
        rules.append("   • Structure longer answers with clear paragraphs or bullet points for readability")
    elif answer_mode == "concise":
        rules.append("   • Keep formatting minimal - avoid unnecessary bullet points or paragraphs")

    rules.append("")

    rules.extend([
        "🚫 STRICT PROHIBITIONS:",
        "   • Do NOT hallucinate content not present in the image or near-frame audio",
        "   • Do NOT over-generalize from the full PDF when the question is about the current frame",
        "   • Do NOT assume the user can see things in the PDF that aren't in their video frame",
        "   • Do NOT ignore the image in favor of PDF content - the image is what they're seeing",
    ])

    # Add final reminder for concise mode
    if answer_mode == "concise":
        rules.extend([
            "",
            "═══════════════════════════════════════════════════════════",
            "⚠️  FINAL REMINDER: CONCISE MODE IS ACTIVE ⚠️",
            "═══════════════════════════════════════════════════════════",
            "Before responding, ask yourself:",
            "• Can I answer this in 1-2 sentences? → Do it.",
            "• Am I about to write a preamble? → Skip it.",
            "• Am I explaining more than asked? → Cut it.",
            "═══════════════════════════════════════════════════════════",
        ])

    return "\n".join(rules)


# ============================================================================
# SUMMARY PROMPT BUILDER (Handles image instructions dynamically)
# ============================================================================

def build_summary_prompt_with_images(summary_format, selected_extras, custom_instructions=None,
                                      has_extracted_images=False, used_local_extraction=False):
    """
    Build complete summary prompt with base prompt, extras, and image instructions.

    Args:
        summary_format: "html" or "latex"
        selected_extras: List of extra option keys (e.g., ["Additional Worked Examples", "Detailed"])
        custom_instructions: Optional custom instructions string
        has_extracted_images: Boolean, whether images were extracted
        used_local_extraction: Boolean, whether local backend extraction was used (vs MinerU)

    Returns:
        Complete prompt string ready to send to AI
    """
    import base64

    # Select base prompt based on format and theme
    if summary_format == 'html':
        base_prompt = base64.b64decode(SUMMARY_PROMPT_HTML_BASE64).decode('utf-8')
        extras_dict = SUMMARY_EXTRAS_HTML
    else:  # latex
        # Check if LeQture Theme is selected
        use_leqture_theme = 'LeQture Theme' in selected_extras
        if use_leqture_theme:
            base_prompt = base64.b64decode(SUMMARY_PROMPT_LEQTURE_BASE64).decode('utf-8')
        else:
            base_prompt = base64.b64decode(SUMMARY_PROMPT_PLAIN_BASE64).decode('utf-8')
        extras_dict = SUMMARY_EXTRAS_LATEX

    # Build extras (excluding LeQture Theme as it's in the base prompt)
    extra_prompts = []
    for extra_key in selected_extras:
        if extra_key != 'LeQture Theme' and extra_key in extras_dict:
            extra_value = extras_dict[extra_key]
            # Decode base64 if it's a Checklist extra
            if extra_key in ['ChecklistHTML', 'ChecklistLATEX'] and extra_value:
                try:
                    extra_value = base64.b64decode(extra_value).decode('utf-8')
                except:
                    pass  # Use as-is if decode fails
            if extra_value:
                extra_prompts.append(extra_value)

    # Combine base prompt with extras
    if extra_prompts:
        summary_prompt = base_prompt + "\n\n" + " ".join(extra_prompts)
    else:
        summary_prompt = base_prompt

    # Append custom instructions if provided
    if custom_instructions:
        summary_prompt += f"\n\nAdditional custom instructions: {custom_instructions}"

    # Add image instructions based on extraction method and format
    if has_extracted_images:
        if summary_format == 'latex':
            if used_local_extraction:
                # Local extraction: IMAGE_XXXX.png placeholders
                summary_prompt += """\n\n**LOCAL IMAGE EXTRACTION INSTRUCTIONS:** I have extracted text and images from the lecture slides PDF using local processing. The extracted content is organized by slides (e.g., "=== Slide 1 ===") and contains image placeholders in the format [IMAGE_XXXX.png] placed in reading order where they appear on each slide.

IMPORTANT NOTES:
- These images may include university logos, decorative elements, or other non-essential graphics
- You must INTELLIGENTLY analyze the PDF slides and the extracted text to determine which images are actually relevant
- Compare the slide number and text context to understand where each image appears
- Only include images that add value to the summary (e.g., diagrams, charts, important figures)
- SKIP logos, headers, footers, decorative elements, or redundant images

Make sure to include \\usepackage{caption} in the preamble.

For each relevant image you want to include, use this EXACT format:

\\begin{center}
% IMAGE_XXXX.png
\\captionof{figure}{Descriptive caption based on content and context}
\\end{center}

For example, if [IMAGE_0003.png] shows a neural network diagram on Slide 5:
\\begin{center}
% IMAGE_0003.png
\\captionof{figure}{Neural network architecture diagram from Slide 5}
\\end{center}

CRITICAL:
- Keep the placeholder EXACTLY as shown in the extracted content (e.g., IMAGE_0001.png, IMAGE_0002.png)
- Use the slide context and text placement to determine relevance
- Do NOT include every image - be selective and intelligent
The extracted content with placeholders is attached as a text file."""
            else:
                # MinerU extraction: IMAGE_N placeholders
                summary_prompt += """\n\n**IMAGE INSTRUCTIONS:** I have extracted a markdown file from the lecture slides PDF. This markdown contains image placeholders (IMAGE_1, IMAGE_2, etc.) that you can use to embed relevant images in the LaTeX summary. You do NOT need to use all images - only include those that are useful and relevant to the summary content.

IMPORTANT: Make sure to include \\usepackage{caption} in the preamble.

For each image you want to include, use this EXACT format (put IMAGE_N directly after the % comment):

\\begin{center}
% IMAGE_N
\\captionof{figure}{Description of the image here}
\\end{center}

For example, if you want to include IMAGE_1:
\\begin{center}
% IMAGE_1
\\captionof{figure}{Diagram showing the relationship between X and Y}
\\end{center}

CRITICAL: Put the placeholder (IMAGE_1, IMAGE_2, etc.) DIRECTLY after the % symbol. Do NOT change, expand, or modify these placeholders. Keep them EXACTLY as IMAGE_1, IMAGE_2, IMAGE_3, etc. I will replace these placeholders with base64-encoded images after you generate the LaTeX. The extracted markdown content with image placeholders is attached as a text file."""
        else:  # HTML format
            if used_local_extraction:
                # Local extraction: IMAGE_XXXX.png placeholders
                summary_prompt += """\n\n**LOCAL IMAGE EXTRACTION INSTRUCTIONS:** I have extracted text and images from the lecture slides PDF using local processing. The extracted content is organized by slides (e.g., "=== Slide 1 ===") and contains image placeholders in the format [IMAGE_XXXX.png] placed in reading order where they appear on each slide.

IMPORTANT NOTES:
- These images may include university logos, decorative elements, or other non-essential graphics
- You must INTELLIGENTLY analyze the PDF slides and the extracted text to determine which images are actually relevant
- Compare the slide number and text context to understand where each image appears
- Only include images that add value to the summary (e.g., diagrams, charts, important figures)
- SKIP logos, headers, footers, decorative elements, or redundant images

For each relevant image you want to include, use this EXACT format:

<figure style="margin: 20px 0; text-align: center;">
  <!-- IMAGE_XXXX.png -->
  <figcaption style="margin-top: 8px; font-style: italic; color: #666; font-size: 0.9em;">Descriptive caption based on content and context</figcaption>
</figure>

For example, if [IMAGE_0003.png] shows a neural network diagram on Slide 5:
<figure style="margin: 20px 0; text-align: center;">
  <!-- IMAGE_0003.png -->
  <figcaption style="margin-top: 8px; font-style: italic; color: #666; font-size: 0.9em;">Neural network architecture diagram from Slide 5</figcaption>
</figure>

CRITICAL:
- Keep the placeholder EXACTLY as shown in the extracted content (e.g., IMAGE_0001.png, IMAGE_0002.png)
- Use HTML comment syntax: <!-- IMAGE_XXXX.png -->
- Use the slide context and text placement to determine relevance
- Do NOT include every image - be selective and intelligent
The extracted content with placeholders is attached as a text file."""
            else:
                # MinerU extraction: IMAGE_N placeholders
                summary_prompt += """\n\n**IMAGE INSTRUCTIONS:** I have extracted a markdown file from the lecture slides PDF. This markdown contains image placeholders (IMAGE_1, IMAGE_2, etc.) that you can use to embed relevant images in the HTML summary. You do NOT need to use all images - only include those that are useful and relevant to the summary content.

For each image you want to include, use this EXACT format using HTML comments:

<figure style="margin: 20px 0; text-align: center;">
  <!-- IMAGE_N -->
  <figcaption style="margin-top: 8px; font-style: italic; color: #666; font-size: 0.9em;">Description of the image here</figcaption>
</figure>

For example, if you want to include IMAGE_1:
<figure style="margin: 20px 0; text-align: center;">
  <!-- IMAGE_1 -->
  <figcaption style="margin-top: 8px; font-style: italic; color: #666; font-size: 0.9em;">Diagram showing the relationship between X and Y</figcaption>
</figure>

CRITICAL: Put the placeholder (IMAGE_1, IMAGE_2, etc.) INSIDE an HTML comment (<!-- IMAGE_N -->). Do NOT change, expand, or modify these placeholders. Keep them EXACTLY as IMAGE_1, IMAGE_2, IMAGE_3, etc. I will replace these comment placeholders with actual <img> tags after you generate the HTML. The extracted markdown content with image placeholders is attached as a text file."""
    else:
        # No images - add no-images instruction
        summary_prompt += """\n\n**CRITICAL INSTRUCTION:** Do NOT include any images, graphics, figures, or references to image files. Do not use \\includegraphics, <img> tags, or assume any image files exist. The output must be text-only with no image dependencies."""

    return summary_prompt

# ============================================================================
# AI PROMPT ENDPOINTS (Prompts are constructed server-side, never exposed to client)
# ============================================================================

@app.route('/api/prompts/ai-marking', methods=['POST'])
@rate_limit(max_requests=100, window=60)  # High limit for quiz interactions
@validate_json_request(required_fields=['userAnswer', 'correctAnswer', 'questionType'])
def prompt_ai_marking():
    """
    Construct AI marking prompt based on question type.

    SECURITY: All prompts are constructed server-side and never exposed to frontend.

    Request body: {
        "userAnswer": "student's answer text",
        "correctAnswer": "expected answer text",
        "questionType": "Debate Question" or "Fill in the Blank"
    }

    Response: {
        "prompt": "constructed prompt",
        "model": "gemini-2.5-flash"
    }
    """
    try:
        data = request.get_json()
        user_answer = data.get('userAnswer', '')
        correct_answer = data.get('correctAnswer', '')
        question_type = data.get('questionType', 'Fill in the Blank')

        if question_type == 'Debate Question':
            prompt = f"""You are evaluating a student's answer to a debate-style question. You must be STRICT and THOROUGH.

MODEL ANSWER: "{correct_answer}"
STUDENT ANSWER: "{user_answer}"

=== EVALUATION CRITERIA ===

TASK 1: Check if the student identified the correct person (Person A or Person B)
- Look for explicit mention of "Person A" or "Person B" in the student's answer
- Variations like "person a", "A", "the first person", etc. count as identification
- Mark PERSON as "yes" ONLY if they identified the correct person
- Mark PERSON as "no" if they identified the wrong person OR didn't identify anyone

TASK 2: Check if the student provided a SUBSTANTIAL, LOGICAL argument
This is where you must be VERY STRICT. The student MUST demonstrate understanding by:

MINIMUM REQUIREMENTS (ALL must be met for ARGUMENT: yes):
1. The answer must contain AT LEAST 20 words AFTER identifying the person
2. The student must explain WHY that person is correct using concepts/reasoning
3. The explanation must reference specific technical concepts, principles, or logic from the domain
4. The student must demonstrate understanding of the underlying concept, not just state a conclusion

AUTOMATIC FAIL CRITERIA (mark ARGUMENT as "no" if ANY apply):
❌ Student just wrote "Person X" or "Person X is right" with no explanation
❌ Student wrote "Person X because..." followed by less than 15 words
❌ Student gave a vague reason like "because they're correct" or "because it makes sense"
❌ Student only restated what Person X said without explaining WHY it's correct
❌ Student didn't reference any technical concepts, principles, or specific reasoning
❌ Student wrote a generic statement that could apply to anything
❌ The explanation is circular (e.g., "Person B is right because Person A is wrong")

WHAT COUNTS AS A VALID ARGUMENT (examples):
✅ Explains the technical concept: "Person B is correct because red-black trees maintain balance by ensuring no path is more than twice as long as another, which guarantees O(log n) operations even in worst case scenarios"
✅ Contrasts the options: "Person A is wrong because linear search has O(n) worst case, but Person B is correct that binary search provides O(log n) which is essential for scalability"
✅ References lecture concepts: "Person B is right - the lecturer emphasized that worst-case guarantees are critical for production systems where adversarial input could exploit O(n²) behavior"

EXAMPLES OF INVALID ARGUMENTS:
❌ "Person B because they mentioned logarithmic complexity" (just restating, not explaining WHY)
❌ "Person A is wrong, Person B is correct" (no reasoning)
❌ "Person B because of better performance" (too vague, no technical detail)
❌ "Person B, they have the right idea about the algorithm" (no explanation of what makes it right)

GRADING PHILOSOPHY:
- If unsure, mark ARGUMENT as "no" - we want to encourage thorough explanations
- A partial explanation that shows SOME understanding but lacks depth should be marked "no"
- Only award "yes" for ARGUMENT if the student clearly demonstrates they understand the concept
- The student does NOT need to match the model answer word-for-word
- The student CAN use different terminology or explanations as long as they're technically sound
- But the explanation MUST be substantial, specific, and demonstrate real understanding

=== OUTPUT FORMAT ===
You MUST reply in this EXACT format with ONLY these two lines:
PERSON: yes/no
ARGUMENT: yes/no

NO OTHER TEXT. NO EXPLANATION. JUST THOSE TWO LINES."""
        else:
            # Fill in the Blank - original behavior
            prompt = f"""Compare these two answers and determine if they mean essentially the same thing:

User's answer: "{user_answer}"
Correct answer: "{correct_answer}"

Reply with ONLY "yes" if they are equivalent (same meaning), or "no" if they are different. Ignore unnecessary text and allow different notation if it means the same thing logically. No explanation needed."""

        if DEBUG:
            print(f"[AI Marking] Generated prompt for type: {question_type}")

        return jsonify({
            "prompt": prompt,
            "model": "gemini-2.5-flash"
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_ai_marking: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/ai-marking-batch', methods=['POST'])
@rate_limit(max_requests=100, window=60)
@validate_json_request(required_fields=['items'])
def prompt_ai_marking_batch():
    """
    Construct AI marking prompt for batch fill-in-the-blank evaluation.

    SECURITY: All prompts are constructed server-side and never exposed to frontend.

    Request body: {
        "items": [
            {"userAnswer": "...", "correctAnswer": "..."},
            {"userAnswer": "...", "correctAnswer": "..."},
            ...
        ]
    }

    Response: {
        "prompt": "constructed prompt that returns JSON array"
    }
    """
    try:
        data = request.get_json()
        items = data.get('items', [])

        if not items:
            return jsonify({"error": "No items provided"}), 400

        # Build numbered list of comparisons
        comparisons = []
        for idx, item in enumerate(items, start=1):
            user_ans = item.get('userAnswer', '')
            correct_ans = item.get('correctAnswer', '')
            comparisons.append(f"{idx}. User: \"{user_ans}\" | Correct: \"{correct_ans}\"")

        comparisons_text = "\n".join(comparisons)

        prompt = f"""You are evaluating {len(items)} fill-in-the-blank answers. For each pair, determine if the user's answer means essentially the same thing as the correct answer.

{comparisons_text}

EVALUATION RULES:
- Ignore minor spelling/capitalization differences
- Allow different notation if it means the same thing logically
- Accept synonyms and equivalent expressions
- Ignore unnecessary filler words

OUTPUT FORMAT:
Return a JSON array with {len(items)} objects. Each object must have:
- "index": the question number (1 to {len(items)})
- "correct": true if equivalent, false if different

Example output format:
[
  {{"index": 1, "correct": true}},
  {{"index": 2, "correct": false}},
  {{"index": 3, "correct": true}}
]

IMPORTANT: Return ONLY the JSON array, no other text."""

        if DEBUG:
            print(f"[AI Marking Batch] Generated prompt for {len(items)} items")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_ai_marking_batch: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/quiz-generate', methods=['POST'])
@rate_limit(max_requests=50, window=60)
def prompt_quiz_generate():
    """
    Return quiz generation prompt.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {} (no parameters needed)

    Response: {
        "prompt": "complete quiz prompt"
    }
    """
    try:
        if DEBUG:
            print(f"[Quiz Prompt] Returning quiz generation prompt")

        return jsonify({
            "prompt": QUIZ_PROMPT
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_quiz_generate: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/quiz-from-flashcards', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['flashcardsText'])
def prompt_quiz_from_flashcards():
    """
    Return quiz-from-flashcards prompt with flashcards text substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "flashcardsText": "Flashcard 1:\nQuestion: ...\nAnswer: ...\n\nFlashcard 2:..."
    }

    Response: {
        "prompt": "complete quiz prompt with flashcards text substituted"
    }
    """
    try:
        data = request.get_json()
        flashcards_text = data.get('flashcardsText', '')

        # Substitute the flashcards text into the prompt
        prompt = QUIZ_FROM_FLASHCARDS_PROMPT.replace("${flashcardsText}", flashcards_text)

        if DEBUG:
            print(f"[Quiz From Flashcards] Returning quiz-from-flashcards prompt")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_quiz_from_flashcards: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/flashcard-generate', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['flashcardCount'])
def prompt_flashcard_generate():
    """
    Return flashcard generation prompt with count variable substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "flashcardCount": 20  // number of flashcards to generate
    }

    Response: {
        "prompt": "complete flashcard prompt with count substituted"
    }
    """
    try:
        data = request.get_json()
        flashcard_count = data.get('flashcardCount', 20)

        # Substitute the flashcard count into the prompt template
        prompt = FLASHCARD_PROMPT_TEMPLATE.replace("${flashcardCount}", str(flashcard_count))

        if DEBUG:
            print(f"[Flashcard Prompt] Returning flashcard prompt for {flashcard_count} cards")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_flashcard_generate: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/summary-generate', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['summaryTheme', 'summaryExtras'])
def prompt_summary_generate():
    """
    Return summary generation prompt based on theme and extras.

    SECURITY: All prompts are stored as base64 server-side and decoded here.

    Request body: {
        "summaryTheme": "LeQture Theme" | "Plain" | "HTML",
        "summaryExtras": ["Additional Worked Examples", "Detailed", ...]  // array of extra option keys
    }

    Response: {
        "prompt": "complete summary prompt with extras applied"
    }
    """
    try:
        import base64

        data = request.get_json()
        summary_theme = data.get('summaryTheme', 'LeQture Theme')
        summary_extras = data.get('summaryExtras', [])  # Array of extra keys

        # Decode the base64 prompt based on theme
        if summary_theme == 'Plain':
            base_prompt = base64.b64decode(SUMMARY_PROMPT_PLAIN_BASE64).decode('utf-8')
            extras_dict = SUMMARY_EXTRAS_LATEX  # Plain uses LaTeX extras
        elif summary_theme == 'HTML':
            base_prompt = base64.b64decode(SUMMARY_PROMPT_HTML_BASE64).decode('utf-8')
            extras_dict = SUMMARY_EXTRAS_HTML
        else:  # 'LeQture Theme' or default
            base_prompt = base64.b64decode(SUMMARY_PROMPT_LEQTURE_BASE64).decode('utf-8')
            extras_dict = SUMMARY_EXTRAS_LATEX

        # Apply extras by appending them to the prompt
        if summary_extras and len(summary_extras) > 0:
            extras_text = "\n\n=== ADDITIONAL INSTRUCTIONS ===\n"
            for extra_key in summary_extras:
                if extra_key in extras_dict:
                    extra_value = extras_dict[extra_key]
                    # Decode base64 if it's a ChecklistHTML or ChecklistLATEX
                    if extra_key in ['ChecklistHTML', 'ChecklistLATEX'] and extra_value:
                        try:
                            extra_value = base64.b64decode(extra_value).decode('utf-8')
                        except:
                            pass  # If decode fails, use as-is

                    if extra_value:  # Only add non-empty extras
                        extras_text += f"\n- {extra_value}"

            final_prompt = base_prompt + extras_text
        else:
            final_prompt = base_prompt

        if DEBUG:
            print(f"[Summary Prompt] Returning summary prompt for theme: {summary_theme}, extras: {summary_extras}")

        return jsonify({
            "prompt": final_prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_summary_generate: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/checklist-generate', methods=['POST'])
@rate_limit(max_requests=50, window=60)
def prompt_checklist_generate():
    """
    Return checklist generation prompt.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {} (no parameters needed)

    Response: {
        "prompt": "complete checklist prompt"
    }
    """
    try:
        if DEBUG:
            print(f"[Checklist Prompt] Returning checklist generation prompt")

        return jsonify({
            "prompt": CHECKLIST_PROMPT
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_checklist_generate: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/coverage-analyze', methods=['POST'])
@rate_limit(max_requests=100, window=60)
@validate_json_request(required_fields=['item'])
def prompt_coverage_analyze():
    """
    Return coverage analysis prompt with item substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "item": "Understand binary search trees"  // checklist item to analyze
    }

    Response: {
        "prompt": "complete coverage prompt with item substituted"
    }
    """
    try:
        data = request.get_json()
        item = data.get('item', '')

        # Substitute the item into the prompt
        prompt = COVERAGE_PROMPT.replace("${item}", item)

        if DEBUG:
            print(f"[Coverage Prompt] Returning coverage analysis prompt for item: {item[:50]}...")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_coverage_analyze: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/flashcard-latex-repair', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['flashcardLatex'])
def prompt_flashcard_latex_repair():
    """
    Return flashcard LaTeX repair prompt with content substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "flashcardLatex": "\\section{Flashcard 1}..."  // Flashcard LaTeX document to fix
    }

    Response: {
        "prompt": "complete flashcard repair prompt with LaTeX content substituted"
    }
    """
    try:
        data = request.get_json()
        flashcard_latex = data.get('flashcardLatex', '')

        if not flashcard_latex or not flashcard_latex.strip():
            if DEBUG:
                print("[Flashcard LaTeX Repair Prompt] Received empty flashcardLatex payload")
            return jsonify({
                "error": "flashcardLatex must not be empty",
                "hint": "Send the flashcard LaTeX you want repaired in the flashcardLatex field."
            }), 400

        prompt = FLASHCARD_LATEX_REPAIR_PROMPT.replace("${flashcardLatex}", flashcard_latex)

        if DEBUG:
            print(f"[Flashcard LaTeX Repair Prompt] Returning prompt for flashcard LaTeX ({len(flashcard_latex)} chars)")

        return jsonify({"prompt": prompt})

    except Exception as e:
        print(f"[Backend] Error in prompt_flashcard_latex_repair: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/latex-repair', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['latexContent'])
def prompt_latex_repair():
    """
    Return LaTeX repair prompt with content substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "latexContent": "\\section{Test}..."  // LaTeX document to repair
    }

    Response: {
        "prompt": "complete repair prompt with LaTeX content substituted"
    }
    """
    try:
        data = request.get_json()
        latex_content = data.get('latexContent', '')

        if not latex_content or not latex_content.strip():
            if DEBUG:
                print("[LaTeX Repair Prompt] Received empty latexContent payload")
            return jsonify({
                "error": "latexContent must not be empty",
                "hint": "Send the LaTeX source you want repaired in the latexContent field."
            }), 400

        # Substitute the LaTeX content into the prompt
        prompt = REPAIR_PROMPT.replace("${latexContent}", latex_content)

        if DEBUG:
            print(f"[LaTeX Repair Prompt] Returning repair prompt for LaTeX ({len(latex_content)} chars)")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_latex_repair: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/latex-fix', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['latexContent'])
def prompt_latex_fix():
    """
    Return LaTeX fix prompt with content substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "latexContent": "\\section{Test}..."  // LaTeX document to fix
    }

    Response: {
        "prompt": "complete fix prompt with LaTeX content substituted"
    }
    """
    try:
        data = request.get_json()
        latex_content = data.get('latexContent', '')

        if not latex_content or not latex_content.strip():
            if DEBUG:
                print("[LaTeX Fix Prompt] Received empty latexContent payload")
            return jsonify({
                "error": "latexContent must not be empty",
                "hint": "Send the LaTeX source you want fixed in the latexContent field."
            }), 400

        # Substitute the LaTeX content into the prompt
        prompt = LATEX_FIX_PROMPT.replace("${checklistLatex}", latex_content)

        if DEBUG:
            print(f"[LaTeX Fix Prompt] Returning fix prompt for LaTeX ({len(latex_content)} chars)")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_latex_fix: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/summary-explainer', methods=['POST'])
@rate_limit(max_requests=100, window=60)
@validate_json_request(required_fields=['selectedText', 'question', 'fullContext'])
def prompt_summary_explainer():
    """
    Return summary explainer prompt with variables substituted.

    SECURITY: Prompt is constructed server-side and never exposed to frontend code.

    Request body: {
        "selectedText": "Text student selected from summary",
        "question": "What they want to understand",
        "fullContext": "Full lecture summary for context"
    }

    Response: {
        "prompt": "complete explainer prompt with variables substituted"
    }
    """
    try:
        data = request.get_json()
        selected_text = data.get('selectedText', '')
        question = data.get('question', '')
        full_context = data.get('fullContext', '')

        # Substitute variables into the prompt
        prompt = (SUMMARY_EXPLAINER_PROMPT
            .replace("${selectedText}", selected_text)
            .replace("${question}", question)
            .replace("${fullContext}", full_context)
        )

        if DEBUG:
            print(f"[Summary Explainer Prompt] Returning explainer prompt for question: {question[:50]}...")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_summary_explainer: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/system-guardrails', methods=['POST'])
@rate_limit(max_requests=200, window=60)  # High limit for chat system
@validate_json_request(required_fields=['answerMode'])
def prompt_system_guardrails():
    """
    Build and return system guardrails for AI chat.

    SECURITY: All guardrails logic is server-side, never exposed to frontend.

    Request body: {
        "answerMode": "concise" | "detailed" | "custom",
        "colorblindMode": false,  // optional
        "customInstruction": "..."  // required if answerMode is "custom"
    }

    Response: {
        "guardrails": "complete system guardrails text"
    }
    """
    try:
        data = request.get_json()
        answer_mode = data.get('answerMode', 'concise')
        colorblind_mode = data.get('colorblindMode', False)
        custom_instruction = data.get('customInstruction', None)

        # Build guardrails using the Python function
        guardrails = build_system_guardrails(
            answer_mode=answer_mode,
            colorblind_mode=colorblind_mode,
            custom_instruction=custom_instruction
        )

        if DEBUG:
            print(f"[System Guardrails] Built guardrails for mode: {answer_mode}, colorblind: {colorblind_mode}")

        return jsonify({
            "guardrails": guardrails
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_system_guardrails: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/api/prompts/summary-with-images', methods=['POST'])
@rate_limit(max_requests=50, window=60)
@validate_json_request(required_fields=['summaryFormat', 'selectedExtras'])
def prompt_summary_with_images():
    """
    Build and return complete summary prompt with image instructions.

    SECURITY: All prompts and image instructions logic is server-side.

    Request body: {
        "summaryFormat": "html" | "latex",
        "selectedExtras": ["Additional Worked Examples", "Detailed", ...],
        "customInstructions": "...",  // optional
        "hasExtractedImages": false,  // optional
        "usedLocalExtraction": false  // optional
    }

    Response: {
        "prompt": "complete summary prompt with all extras and image instructions"
    }
    """
    try:
        data = request.get_json()
        summary_format = data.get('summaryFormat', 'latex')
        selected_extras = data.get('selectedExtras', [])
        custom_instructions = data.get('customInstructions', None)
        has_extracted_images = data.get('hasExtractedImages', False)
        used_local_extraction = data.get('usedLocalExtraction', False)

        # Build complete prompt using the Python function
        prompt = build_summary_prompt_with_images(
            summary_format=summary_format,
            selected_extras=selected_extras,
            custom_instructions=custom_instructions,
            has_extracted_images=has_extracted_images,
            used_local_extraction=used_local_extraction
        )

        if DEBUG:
            print(f"[Summary Prompt] Built summary prompt for format: {summary_format}, extras: {selected_extras}")

        return jsonify({
            "prompt": prompt
        })

    except Exception as e:
        print(f"[Backend] Error in prompt_summary_with_images: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


# ============================================================================
# PDF EXTRACTION ENDPOINTS (Keep existing functionality)
# ============================================================================

@app.route('/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        "status": "ok",
        "message": "LeQture backend is running",
        "gemini_api_configured": bool(GEMINI_API_KEY)
    })


@app.route('/check-flattening', methods=['POST'])
def check_flattening():
    """
    Check if a PDF is flattened (only contains full-page bitmap images).

    Request: multipart/form-data with 'pdf' file
    Response: {
        "is_flattened": true/false,
        "has_true_images": true/false,
        "recommendation": "backend" or "mineru",
        "reason": "explanation"
    }
    """
    try:
        if 'pdf' not in request.files:
            return jsonify({"error": "No PDF file provided"}), 400

        pdf_file = request.files['pdf']
        if pdf_file.filename == '':
            return jsonify({"error": "Empty filename"}), 400

        # Save PDF temporarily for analysis
        temp_dir = STORAGE_DIR / "temp_check"
        temp_dir.mkdir(exist_ok=True)
        temp_pdf_path = temp_dir / f"check_{uuid.uuid4()}.pdf"

        pdf_file.save(temp_pdf_path)

        print(f"[Backend] Checking if PDF is flattened: {temp_pdf_path}")

        # Check for true images
        has_images = has_true_images(temp_pdf_path)

        # Clean up temp file
        temp_pdf_path.unlink()

        # Determine recommendation
        if has_images:
            recommendation = "backend"
            reason = "PDF contains true embedded images - can be extracted locally"
            is_flattened = False
        else:
            recommendation = "mineru"
            reason = "PDF is flattened (only full-page bitmaps) - requires OCR/cloud processing"
            is_flattened = True

        print(f"[Backend] Flattening check result: is_flattened={is_flattened}, recommendation={recommendation}")

        return jsonify({
            "is_flattened": is_flattened,
            "has_true_images": has_images,
            "recommendation": recommendation,
            "reason": reason
        })

    except Exception as e:
        print(f"[Backend] Flattening check failed: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/extract', methods=['POST'])
def extract():
    """
    Extract images and text from uploaded PDF.

    Request: multipart/form-data with 'pdf' file
    Response: {
        "session_id": "uuid",
        "txt_content": "text with [IMAGE_XXXX.png] placeholders",
        "image_count": 5,
        "images": ["IMAGE_0001.png", ...]
    }
    """
    try:
        if 'pdf' not in request.files:
            return jsonify({"error": "No PDF file provided"}), 400

        pdf_file = request.files['pdf']
        if pdf_file.filename == '':
            return jsonify({"error": "Empty filename"}), 400

        # Create session directory
        session_id = str(uuid.uuid4())
        session_dir = STORAGE_DIR / session_id
        session_dir.mkdir(parents=True, exist_ok=True)

        # Save uploaded PDF
        pdf_path = session_dir / "input.pdf"
        pdf_file.save(pdf_path)

        print(f"[Backend] Extracting PDF: {pdf_path}")

        # Extract images and text
        txt_content, images_dir, image_list = extract_pdf_images_and_text(pdf_path)

        # Save txt file
        txt_path = session_dir / "slides_with_placeholders.txt"
        txt_path.write_text(txt_content, encoding="utf-8")

        # Store session
        active_sessions[session_id] = session_dir

        print(f"[Backend] Extraction complete. Session: {session_id}, Images: {len(image_list)}")

        return jsonify({
            "session_id": session_id,
            "txt_content": txt_content,
            "image_count": len(image_list),
            "images": image_list
        })

    except Exception as e:
        print(f"[Backend] Extraction failed: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route('/image/<session_id>/<image_name>', methods=['GET'])
def get_image(session_id, image_name):
    """
    Serve an extracted image.

    GET /image/{session_id}/{image_name}
    Returns: PNG image file
    """
    try:
        if session_id not in active_sessions:
            return jsonify({"error": "Invalid session ID"}), 404

        session_dir = active_sessions[session_id]
        image_path = session_dir / "images" / image_name

        if not image_path.exists():
            return jsonify({"error": "Image not found"}), 404

        return send_file(image_path, mimetype='image/png')

    except Exception as e:
        print(f"[Backend] Image serving failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route('/cleanup/<session_id>', methods=['DELETE'])
def cleanup(session_id):
    """
    Clean up a session's extracted files.

    DELETE /cleanup/{session_id}
    """
    try:
        if session_id not in active_sessions:
            return jsonify({"error": "Invalid session ID"}), 404

        session_dir = active_sessions[session_id]
        shutil.rmtree(session_dir)
        del active_sessions[session_id]

        print(f"[Backend] Cleaned up session: {session_id}")
        return jsonify({"message": "Session cleaned up successfully"})

    except Exception as e:
        print(f"[Backend] Cleanup failed: {e}")
        return jsonify({"error": str(e)}), 500


# ================== YouTube Integration Endpoints ==================

# Storage for YouTube transcripts (UUID -> transcript data)
youtube_transcripts = {}

def seconds_to_hms(seconds):
    """Convert seconds to HH:MM:SS or MM:SS format."""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)

    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    else:
        return f"{minutes:02d}:{secs:02d}"

@app.route('/api/youtube/transcript/complete', methods=['POST'])
@rate_limit(max_requests=30, window=60)
@validate_json_request(required_fields=['videoId'])
def youtube_complete_transcript():
    """
    Step 2: Fetch complete YouTube transcript and store with UUID.

    Request: { "videoId": "tTuWmcikE0Q" }
    Response: { "uuid": "...", "transcript": "formatted transcript text" }
    """
    try:
        video_id = request.json['videoId']

        # Try multiple approaches to fetch transcript
        print(f"[YouTube] Fetching transcript for video {video_id}...")
        transcript_data = None

        try:
            # Attempt 1: Auto-detect language (most permissive)
            ytt_api = YouTubeTranscriptApi()
            transcript_data = ytt_api.fetch(video_id)
            print(f"[YouTube] Successfully fetched transcript using auto-detect ({len(transcript_data)} segments)")
        except Exception as e1:
            print(f"[YouTube] Auto-detect failed: {e1}")

            try:
                # Attempt 2: Try common language codes
                from youtube_transcript_api import TranscriptList
                transcript_list = TranscriptList.list_transcripts(video_id)

                # Try to find any manually created or generated transcript
                for transcript in transcript_list:
                    try:
                        transcript_data = transcript.fetch()
                        print(f"[YouTube] Successfully fetched transcript in language: {transcript.language_code}")
                        break
                    except:
                        continue

            except Exception as e2:
                print(f"[YouTube] All transcript fetch attempts failed: {e2}")
                # Return special response indicating no transcript available
                return jsonify({
                    "uuid": None,
                    "transcript": "",
                    "lineCount": 0,
                    "available": False,
                    "message": "No transcript available for this video"
                }), 200

        if not transcript_data:
            return jsonify({
                "uuid": None,
                "transcript": "",
                "lineCount": 0,
                "available": False,
                "message": "No transcript available for this video"
            }), 200

        # Format transcript as text
        transcript_lines = []
        for snippet in transcript_data:
            start_time = seconds_to_hms(snippet.start)
            end_time = seconds_to_hms(snippet.start + snippet.duration)
            transcript_lines.append(f"{start_time} --> {end_time}: {snippet.text}")

        transcript_text = "\n".join(transcript_lines)

        # Generate UUID and store
        transcript_uuid = str(uuid.uuid4())
        youtube_transcripts[transcript_uuid] = {
            'video_id': video_id,
            'text': transcript_text,
            'data': transcript_data,  # Store raw data for nearframe extraction
            'timestamp': time()
        }

        print(f"[YouTube] Stored complete transcript for video {video_id} with UUID {transcript_uuid}")

        return jsonify({
            "uuid": transcript_uuid,
            "transcript": transcript_text,
            "lineCount": len(transcript_lines),
            "available": True
        })

    except Exception as e:
        print(f"[YouTube] Complete transcript error: {e}")
        # Return success with no transcript instead of error
        return jsonify({
            "uuid": None,
            "transcript": "",
            "lineCount": 0,
            "available": False,
            "message": "No transcript available for this video"
        }), 200

@app.route('/api/youtube/transcript/nearframe', methods=['POST'])
@rate_limit(max_requests=60, window=60)
@validate_json_request(required_fields=['uuid', 'timestamp'])
def youtube_nearframe_transcript():
    """
    Step 3: Extract nearframe transcript (±15 seconds) from stored transcript.

    Request: { "uuid": "...", "timestamp": "4:16" or 256 }
    Response: { "nearframe": "formatted nearframe transcript" }
    """
    try:
        transcript_uuid = request.json['uuid']
        timestamp_input = request.json['timestamp']

        # Check if UUID exists
        if transcript_uuid not in youtube_transcripts:
            return jsonify({"error": "Transcript UUID not found. Please fetch complete transcript first."}), 404

        stored = youtube_transcripts[transcript_uuid]
        transcript_data = stored['data']

        # Parse timestamp (can be "4:16" or 256)
        if isinstance(timestamp_input, str):
            # Parse M:SS, MM:SS, or H:MM:SS
            parts = [int(p) for p in timestamp_input.split(":")]
            if len(parts) == 2:
                center_seconds = parts[0] * 60 + parts[1]
            elif len(parts) == 3:
                center_seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
            else:
                return jsonify({"error": "Invalid timestamp format"}), 400
        else:
            center_seconds = float(timestamp_input)

        # Extract ±15 second window
        start_target = max(0, center_seconds - 15)
        end_target = center_seconds + 15

        # Find all snippets that overlap with the window
        nearframe_lines = []
        for snippet in transcript_data:
            snippet_start = snippet.start
            snippet_end = snippet.start + snippet.duration

            # Check if snippet overlaps with window
            if not (snippet_end <= start_target or snippet_start >= end_target):
                start_time = seconds_to_hms(snippet_start)
                end_time = seconds_to_hms(snippet_end)
                nearframe_lines.append(f"{start_time} --> {end_time}: {snippet.text}")

        nearframe_text = "\n".join(nearframe_lines)

        print(f"[YouTube] Extracted nearframe for UUID {transcript_uuid} at {timestamp_input} ({len(nearframe_lines)} snippets)")

        return jsonify({
            "nearframe": nearframe_text,
            "snippetCount": len(nearframe_lines),
            "windowStart": seconds_to_hms(start_target),
            "windowEnd": seconds_to_hms(end_target)
        })

    except Exception as e:
        print(f"[YouTube] Nearframe transcript error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/youtube/summary', methods=['POST'])
@rate_limit(max_requests=10, window=60)
@validate_json_request(required_fields=['videoId'])
def youtube_video_summary():
    """
    Step 4: Generate detailed video summary via Gemini (replaces lecture slides).

    Request: { "videoId": "tTuWmcikE0Q" }
    Response: { "summary": "markdown summary text" }
    """
    try:
        video_id = request.json['videoId']
        youtube_url = f"https://www.youtube.com/watch?v={video_id}"

        # System instructions for video summary (from demo3.py)
        system_instructions = """You are a world-class video analyst and technical note-taker.
Your job is to watch the ENTIRE video and produce an EXTREMELY DETAILED full summary.
Be meticulous, neutral, and complete. Do not hallucinate—if something is unclear, say so.

Format the output as Markdown with clear section headings and dense bullet points.

Required sections:
1) Title & Metadata
   - Title (if available), creator/channel, published date (if discernible), overall topic.
2) Executive Summary
   - 4–8 sentences capturing the essence and conclusions.
3) Chapterized Timeline (MM:SS → section title)
   - Break into logical chapters; for each, provide 5–12 bullets covering ALL substantive points.
   - Include on-screen text, diagrams, examples, anecdotes, demos, code, equations—anything material.
4) Key Arguments, Evidence, and Numbers
   - Claims with supporting evidence/data; include quantities, ranges, and units.
5) Definitions & Concepts
   - Explain jargon/terms and any formulas or algorithms referenced.
6) Step-by-Step Procedures (if any)
   - Carefully enumerate tasks with prerequisites and pitfalls.
7) Quotes & Notable Lines
   - Short verbatim quotes with timestamps (MM:SS); attribute speakers if identifiable.
8) Comparisons & Trade-offs (if relevant)
   - Alternatives, pros/cons, performance/complexity/cost comparisons.
9) Caveats, Assumptions, and Uncertainties
   - Limitations, missing information, and hedges by the presenter.
10) Action Items or Practical Takeaways
    - Concrete next steps; include visible links (as plain text) if shown on screen.

General rules:
- Use MM:SS timestamps whenever referencing specific moments.
- If multiple speakers are present, identify them by role when names aren't visible.
- Include key equations/code snippets in fenced blocks (```).
- Keep the tone professional and grounded strictly in the video content."""

        user_prompt = f"""Analyze this YouTube video and produce the EXTREMELY DETAILED full summary as specified in the system instructions.
Include comprehensive coverage with timestamps for important moments.

Video URL: {youtube_url}"""

        # Build Gemini API request
        payload = {
            "systemInstruction": {
                "parts": [{"text": system_instructions}]
            },
            "contents": [{
                "parts": [
                    {"file_data": {"file_uri": youtube_url}},
                    {"text": user_prompt}
                ]
            }],
            "generationConfig": {
                "temperature": 0.2,
                "topP": 0.9,
                "maxOutputTokens": 8192,
                "responseMimeType": "text/plain"
            }
        }

        # Call Gemini API
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent"
        headers = {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_API_KEY
        }

        print(f"[YouTube] Generating summary for video {video_id}...")
        response = requests.post(gemini_url, headers=headers, json=payload, timeout=300)

        if response.status_code >= 400:
            error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
            error_msg = error_data.get("error", {}).get("message") if isinstance(error_data, dict) else str(error_data)
            raise Exception(f"Gemini API error {response.status_code}: {error_msg}")

        result = response.json()

        # Extract text from response
        summary_text = ""
        candidates = result.get("candidates", [])
        if candidates:
            for candidate in candidates:
                content = candidate.get("content", {})
                parts = content.get("parts", [])
                for part in parts:
                    if "text" in part:
                        summary_text += part["text"]

        if not summary_text:
            summary_text = "No summary generated. The model may have blocked the request."

        print(f"[YouTube] Summary generated for video {video_id} ({len(summary_text)} characters)")

        return jsonify({
            "summary": summary_text,
            "videoId": video_id,
            "characterCount": len(summary_text)
        })

    except Exception as e:
        print(f"[YouTube] Video summary error: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    print("=" * 60)
    print("LeQture Backend Server")
    print("=" * 60)
    print(f"Server running on: http://{HOST}:{PORT}")
    print()
    print("PDF Extraction Endpoints:")
    print("  GET    /health")
    print("  POST   /check-flattening")
    print("  POST   /extract")
    print("  GET    /image/<session_id>/<image_name>")
    print("  DELETE /cleanup/<session_id>")
    print()
    print("AI API Proxy Endpoints:")
    print("  POST   /api/ai/generate")
    print("  POST   /api/ai/generate-with-header")
    print("  POST   /api/ai/upload")
    print("  GET    /api/ai/file/<file_name>")
    print()
    print("AI Prompt Endpoints (Server-side prompt construction):")
    print("  POST   /api/prompts/ai-marking")
    print()
    print("MinerU API Proxy Endpoint:")
    print("  POST   /api/mineru/extract")
    print()
    print("YouTube Integration Endpoints:")
    print("  POST   /api/youtube/transcript/complete")
    print("  POST   /api/youtube/transcript/nearframe")
    print("  POST   /api/youtube/summary")
    print()
    print(f"Gemini API Key configured: {bool(GEMINI_API_KEY)}")
    print(f"MinerU API Key configured: {bool(MINERU_API_KEY)}")
    print("=" * 60)
    app.run(host=HOST, port=PORT, debug=DEBUG)
