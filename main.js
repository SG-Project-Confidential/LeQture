// Firefox Extension - LeQture
// @version      2025-10-02
// @author       Shlok Gupta

/* ================== SUPER CHAT UI (Fixed panel positioning) ==================
   Fixed: Panel position/size properly resets on close/reopen to prevent stuck resizing
=======================================================================================================================================*/

// ---------- Global Configuration (accessible everywhere)
// IMPORTANT: API keys are now stored securely in the backend server's .env file
// No API keys are exposed in the frontend code
var BACKEND_URL = "http://localhost:5000"; // Local backend server for ALL API calls (MUST match server.py PORT)

(function setupAIUIAndInterceptor() {
    // ---------- Configuration
    const USERSCRIPT_MODE = 0; // Extension mode - uses native fetch with manifest permissions

    // ---------- Constants
    const WRAPPER_XPATH = "/html/body/div/div[2]/div[2]/div/div/div[2]/div[1]/div/div/div[1]/div/div/div";
    const DEICTIC_NOTE = 'When I say "this", "that", "here", or "current slide", I mean the attached screenshot image (the current frame I am viewing).';
    // Load libraries from extension instead of CDN to bypass CSP
    const EXTENSION_URL = window.__LEQTURE_EXTENSION_URL__ || '';
    console.log('[LeQture] Extension URL:', EXTENSION_URL);
    const TESSERACT_SRC = EXTENSION_URL + "vendor/tesseract.min.js";
    const MATHJAX_SRC   = EXTENSION_URL + "vendor/mathjax.js";
    const JSPDF_SRC     = EXTENSION_URL + "vendor/jspdf.js";
    console.log('[LeQture] Library URLs:', { TESSERACT_SRC, MATHJAX_SRC, JSPDF_SRC });
    const SIM_THRESHOLD = 50;
    const PANEL_MIN_W = 420;
    const PANEL_MIN_H = 360;
    const PANEL_DEFAULT_W = 620;
    const PANEL_DEFAULT_H = 500;


    const MODEL_PRO       = "models/gemini-2.5-pro";
    const MODEL_FLASH     = "models/gemini-2.5-flash";
    const MODEL_FLASHLITE = "models/gemini-2.5-flash-lite";
    const ALL_MODELS = [MODEL_PRO, MODEL_FLASH, MODEL_FLASHLITE];

    // ---------- PDF URL Management
    const PDF_URL_STORAGE_KEY = 'leqture_pdf_urls'; // Store mapping of page URLs to PDF URLs
    let SLIDES_PDF_URL = null;
    let cachedPdfBlob = null; // Cache the validated PDF blob to avoid re-downloading
    let pdfUrlStatus = 'not_initialized'; // not_initialized, url_stored, url_valid, url_invalid, file_uploaded, no_pdf

    // ---------- Image Size Management
    const A4_WIDTH_PX = 794; // A4 paper width in pixels at 96 DPI (210mm = 8.27in * 96)
    let imageSizeMultiplier = 1.0; // Size multiplier for images in LaTeX (0.5 to 2.0)
    let summaryHasImages = false; // Track if current summary includes images

    // Get current page URL (normalized)
    function getCurrentPageUrl() {
      return window.location.href;
    }

    // Get stored PDF URLs mapping
    function getStoredPdfUrls() {
      try {
        const stored = localStorage.getItem(PDF_URL_STORAGE_KEY);
        return stored ? JSON.parse(stored) : {};
      } catch (e) {
        return {};
      }
    }

    // Save PDF URL for current page
    function savePdfUrlForCurrentPage(pdfUrl) {
      const pageUrl = getCurrentPageUrl();
      const stored = getStoredPdfUrls();
      stored[pageUrl] = pdfUrl;
      localStorage.setItem(PDF_URL_STORAGE_KEY, JSON.stringify(stored));
      console.log('[PDF STATUS] Saved PDF URL for page:', pageUrl, '→', pdfUrl);
    }

    // Get PDF URL for current page
    function getPdfUrlForCurrentPage() {
      const pageUrl = getCurrentPageUrl();
      const stored = getStoredPdfUrls();
      return stored[pageUrl] || null;
    }

    // Clear PDF URL for current page
    function clearPdfUrlForCurrentPage() {
      const pageUrl = getCurrentPageUrl();
      const stored = getStoredPdfUrls();
      delete stored[pageUrl];
      localStorage.setItem(PDF_URL_STORAGE_KEY, JSON.stringify(stored));
      console.log('[PDF STATUS] Cleared PDF URL for page:', pageUrl);
    }

    // Check if we're on an Echo360 lesson page
    function isEcho360LessonPage() {
      return /echo360\.org\.uk\/lesson\//.test(window.location.href);
    }

    // Check if we're on a YouTube video page
    function isYouTubePage() {
      return /youtube\.com\/watch\?v=/.test(window.location.href);
    }

    // Extract YouTube video ID from URL
    function getYouTubeVideoId() {
      const match = window.location.href.match(/[?&]v=([^&]+)/);
      return match ? match[1] : null;
    }

    // Get current video timestamp in seconds for YouTube
    function getYouTubeCurrentTime() {
      const video = document.querySelector('.video-stream.html5-main-video');
      return video ? video.currentTime : 0;
    }

    // Make YouTube detection function globally accessible for HTML event handlers
    window.__isYouTubePage = isYouTubePage;

    // YouTube state management
    let youtubeTranscriptUUID = null;
    let youtubeTranscriptPromise = null; // Track ongoing fetch to avoid duplicates

    // Step 2: Fetch complete YouTube transcript from backend
    async function fetchYouTubeCompleteTranscript(videoId) {
      try {
        console.log('[YouTube] Fetching complete transcript for video:', videoId);
        const response = await fetch(`${BACKEND_URL}/api/youtube/transcript/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId })
        });

        const data = await response.json();

        // Backend now returns 200 even when transcript unavailable
        if (data.available === false) {
          console.log('[YouTube] Transcript not available for this video');
          return { available: false, uuid: null, transcript: "", lineCount: 0 };
        }

        console.log('[YouTube] Complete transcript fetched. UUID:', data.uuid, 'Lines:', data.lineCount);
        return data;
      } catch (error) {
        console.warn('[YouTube] Failed to fetch complete transcript - continuing without it:', error);
        // Return "not available" instead of throwing
        return { available: false, uuid: null, transcript: "", lineCount: 0 };
      }
    }

    // Step 3: Fetch nearframe YouTube transcript from backend
    async function fetchYouTubeNearframeTranscript(uuid, timestamp) {
      try {
        console.log('[YouTube] Fetching nearframe transcript. UUID:', uuid, 'Timestamp:', timestamp);
        const response = await fetch(`${BACKEND_URL}/api/youtube/transcript/nearframe`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uuid, timestamp })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        console.log('[YouTube] Nearframe transcript fetched. Snippets:', data.snippetCount);
        return data;
      } catch (error) {
        console.error('[YouTube] Failed to fetch nearframe transcript:', error);
        throw error;
      }
    }

    // Step 4: Fetch YouTube video summary from backend (replaces lecture slides)
    async function fetchYouTubeVideoSummary(videoId) {
      try {
        console.log('[YouTube] Fetching video summary for:', videoId);
        const response = await fetch(`${BACKEND_URL}/api/youtube/summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId })
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        console.log('[YouTube] Video summary fetched. Characters:', data.characterCount);
        return data;
      } catch (error) {
        console.error('[YouTube] Failed to fetch video summary:', error);
        throw error;
      }
    }


    // Validate PDF URL by actually fetching it and caching the blob
    async function validatePdfUrl(url) {
      try {
        console.log('[PDF Validation] Fetching PDF from:', url);

        // Fetch the PDF as a blob (not HEAD, but actual GET request)
        const blob = await fetchAsBlob(url, "application/pdf");

        if (!blob) {
          console.log('[PDF Validation] Failed to fetch blob');
          return false;
        }

        // Check if it's a valid PDF (has content and correct type)
        if (blob.size === 0) {
          console.log('[PDF Validation] Blob is empty');
          return false;
        }

        // Verify content type
        if (!blob.type.includes('application/pdf') && !blob.type.includes('pdf')) {
          console.log('[PDF Validation] Wrong content type:', blob.type);
          return false;
        }

        console.log('[PDF Validation] Valid PDF blob cached, size:', blob.size);

        // Cache the blob for later use
        cachedPdfBlob = blob;
        return true;
      } catch (e) {
        console.error('[PDF Validation] Error:', e);
        return false;
      }
    }

    // Prompt user for PDF URL
    function promptForPdfUrl(message = "Please enter the URL for the lecture slides PDF:") {
      const url = prompt(message);
      if (url && url.trim()) {
        savePdfUrlForCurrentPage(url.trim());
        return url.trim();
      }
      return null;
    }

    // Initialize PDF URL
    async function initializePdfUrl() {
      console.log('[PDF STATUS] Initializing PDF URL...');
      console.log('[PDF STATUS] Current page:', getCurrentPageUrl());
      console.log('[PDF STATUS] Mode:', 'Extension (native fetch with permissions)');

      // YouTube: We'll use video summary instead of PDF, mark as valid
      if (isYouTubePage()) {
        console.log('[PDF STATUS] YouTube page detected - will use video summary instead of PDF');
        pdfUrlStatus = 'url_valid'; // Mark as valid so UI doesn't show warnings
        SLIDES_PDF_URL = null; // No actual PDF URL
        return true;
      }

      // Check if URL is stored for this specific page
      const storedUrl = getPdfUrlForCurrentPage();

      if (storedUrl) {
        console.log('[PDF STATUS] Found stored URL for this page, validating...');
        pdfUrlStatus = 'url_stored';

        const isValid = await validatePdfUrl(storedUrl);
        if (isValid) {
          SLIDES_PDF_URL = storedUrl;
          pdfUrlStatus = 'url_valid';
          console.log('[PDF STATUS] ✓ Stored URL is valid:', storedUrl);
          console.log('[PDF STATUS] ✓ SLIDES_PDF_URL has been set to:', SLIDES_PDF_URL);
          return true;
        } else {
          console.log('[PDF STATUS] Stored URL is invalid or expired');
          pdfUrlStatus = 'url_invalid';

          const newUrl = promptForPdfUrl("The stored PDF URL is invalid or expired. Please enter a new URL:");
          if (newUrl) {
            window.location.reload();
            return false;
          } else {
            pdfUrlStatus = 'no_pdf';
            console.log('[PDF STATUS] User cancelled PDF URL prompt');
            return false;
          }
        }
      } else if (isEcho360LessonPage()) {
        console.log('[PDF STATUS] Echo360 lesson page detected, no stored URL for this page, prompting...');
        const newUrl = promptForPdfUrl();
        if (newUrl) {
          window.location.reload();
          return false;
        } else {
          pdfUrlStatus = 'no_pdf';
          console.log('[PDF STATUS] User cancelled PDF URL prompt');
          return false;
        }
      } else {
        // Not an Echo360 page and no stored URL
        pdfUrlStatus = 'no_pdf';
        console.log('[PDF STATUS] Not an Echo360 lesson page and no stored URL for this page');
        return false;
      }
    }

    // Fetch file as Blob using fetchCORS (bypasses CORS restrictions)
    async function fetchAsBlob(url, mime) {
      try {
        const res = await fetchCORS(url, { responseType: 'blob' });
        if (!res.ok) throw new Error("HTTP " + res.status);
        let blob = await res.blob();
        if (mime && blob.type !== mime) {
          blob = new Blob([await blob.arrayBuffer()], { type: mime });
        }
        return blob;
      } catch (e) {
        console.warn("Failed to fetch blob:", url, e);
        return null;
      }
    }

    // Handle file upload for PDF
    async function handlePdfFileUpload() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/pdf';
        input.onchange = async (e) => {
          const file = e.target.files[0];
          if (file && file.type === 'application/pdf') {
            pdfUrlStatus = 'file_uploaded';
            console.log('[PDF STATUS] PDF file uploaded successfully');
            resolve(file);
          } else {
            alert('Please select a valid PDF file');
            resolve(null);
          }
        };
        input.oncancel = () => {
          console.log('[PDF STATUS] User cancelled file upload');
          resolve(null);
        };
        input.click();
      });
    }

    // ---------- State
    let lastUrl = null;
    let lastHeaders = { "Content-Type": "application/json" };
    let partsTail = null;
    let initialAutoHandled = false;
    let suppressIntercept = false;

    let inFlightAbort = null;
    let retryTimeoutId = null;
    let retryIntervalId = null;
    let retryEndsAt = 0;
    let lastUserMsgForRetry = "";

    const history = [];
    const slideGroups = [];
    let currentGroupId = null;

    let answerMode = "concise";
    let slideContextEnabled = true;
    let currentModel = MODEL_FLASH;
    let isThinking = false;

    let lastPendingBubble = null;
    let savedW = PANEL_DEFAULT_W;
    let savedH = PANEL_DEFAULT_H;

    const pendingAttachments = [];

    // Quiz state
    let quizMode = false;
    let isRateLimited = false; // Global rate limit tracking
    let rateLimitClearTimer = null; // Track the timer to clear rate limit notice

    // Helper functions to manage rate limit notice
    function setRateLimitNotice(retryAfterSeconds) {
      isRateLimited = true;
      const headerSubtitle = panel.querySelector('#gemini-header-subtitle');
      if (headerSubtitle && !headerSubtitle.innerHTML.includes('[Rate Limited')) {
        headerSubtitle.innerHTML += ' <b>[Rate Limited, using Lower Quality Model]</b>';
      }

      // Clear any existing timer
      if (rateLimitClearTimer) {
        clearTimeout(rateLimitClearTimer);
      }

      // Set new timer based on latest retry-after
      if (retryAfterSeconds) {
        const retryDelay = parseInt(retryAfterSeconds) * 1000;
        rateLimitClearTimer = setTimeout(() => {
          clearRateLimitNotice();
        }, retryDelay);
      }
    }

    function clearRateLimitNotice() {
      isRateLimited = false;
      const headerSubtitle = panel.querySelector('#gemini-header-subtitle');
      if (headerSubtitle) {
        headerSubtitle.innerHTML = headerSubtitle.innerHTML.replace(/ <b>\[Rate Limited, using Lower Quality Model\]<\/b>/g, '');
      }

      // Clear timer
      if (rateLimitClearTimer) {
        clearTimeout(rateLimitClearTimer);
        rateLimitClearTimer = null;
      }
    }

    // Clear rate limit notice when Pro or Flash return 200
    function checkAndClearRateLimitOn200(statusCode, model) {
      if (statusCode === 200 && (model === MODEL_PRO || model === MODEL_FLASH)) {
        clearRateLimitNotice();
      }
    }

    function updateHeaderSubtitle(text) {
      const headerSubtitle = panel.querySelector('#gemini-header-subtitle');
      if (headerSubtitle) {
        const rateLimitNotice = isRateLimited ? ' <b>[Rate Limited, using Lower Quality Model]</b>' : '';
        // Don't show NO SLIDE FOUND on YouTube (uses video summary instead)
        const noSlideNotice = (pdfUrlStatus === 'no_pdf' && !uploadedPdfUri && !isYouTubePage()) ? ' <b style="color: maroon;">[NO SLIDE FOUND]</b>' : '';
        headerSubtitle.innerHTML = text + rateLimitNotice + noSlideNotice;
      }
    }
    let quizData = [];
    let quizCurrent = 0;
    let quizAnswers = [];
    let quizGenerating = false;
    let quizCompleted = false;
    let aiMarkingCompleted = false; // Track if AI marking has been done
    let cachedQuizData = null;
    let quizGeneratingInBackground = false;
    let quizRateLimited = false; // Track if quiz generation was rate limited in background
    let quizCountdownInterval = null;
    let quizCountdownStartTime = null;
    let quizCountdownPhase = 1;

    // Save chat content when entering special modes (quiz/flashcard/checklist/summary)
    let savedChatContent = '';

    // Helper function to save chat content before clearing
    function saveChatBeforeClearing() {
      if (savedChatContent) return;
      if (!chatEl || !chatEl.innerHTML) return;

      const hasConversation = chatEl.querySelector('.gemini-msg, .gemini-bubble, .bot-message, .user-message');
      const singleSpecialChild =
        !hasConversation &&
        chatEl.childElementCount === 1 &&
        chatEl.firstElementChild?.matches('.quiz-generating, .flashcard-container, .quiz-container, .checklist-container, .test-me-container, .overleaf-options-container');

      if (!singleSpecialChild) {
        savedChatContent = chatEl.innerHTML;
        console.log('[Chat] Saved chat content before clearing');
      }
    }

    function findActivePendingBubble() {
      if (!chatEl) return null;
      const pendingList = chatEl.querySelectorAll('.gemini-bubble[data-pending="1"]');
      if (!pendingList || pendingList.length === 0) return null;
      return pendingList[pendingList.length - 1];
    }

    function restoreSavedChatContent() {
      if (!chatEl) return;
      chatEl.innerHTML = savedChatContent || '';
      if (savedChatContent) {
        console.log('[Chat] Restored chat content after mode exit');
      }
      savedChatContent = '';
      const pending = findActivePendingBubble();
      if (pending) {
        lastPendingBubble = pending;
        console.log('[Chat] Reattached pending bubble after restore');
      }
    }

    // File upload state
    let filesInitialized = false;
    let filesInitializing = false;
    let uploadedPdfUri = null;
    let uploadedVttUri = null;
    let extractedMarkdownBackend = null; // Cache extracted markdown from Object Detection (backend)
    let extractedMarkdownMineru = null; // Cache extracted markdown from Machine Learning (MinerU)
    let extractedMarkdownUri = null; // Cache uploaded markdown URI

    // ---------- Utilities
    function rewriteUrlWithModel(url, modelPath) {
      return url.replace(/(\/v1beta\/)([^:]+)(:generateContent)/, `$1${modelPath}$3`);
    }
    function modelLabel(m){
      if (m===MODEL_PRO) return "Pro";
      if (m===MODEL_FLASH) return "Flash";
      if (m===MODEL_FLASHLITE) return "Flash Lite";
      return m;
    }
    function logModelUsage(context, model, details = '') {
      const label = modelLabel(model) || model;
      const suffix = details ? ` (${details})` : '';
      console.log(`[Model][${context}] Using ${label}${suffix}`);
    }

    // Legacy function - now a no-op since API key is in backend
    async function waitForApiKey(maxMs=12000){
      // API key is now handled by backend, no need to wait
      return Promise.resolve();
    }

    /**
     * Call AI API via backend proxy
     * @param {string} model - Model name
     * @param {object} requestBody - Request body to send to AI
     * @param {boolean} useHeaderAuth - Whether to use header-based auth (for TTS)
     * @returns {Promise<Response>} - Fetch response
     */
    async function callAIViaBackend(model, requestBody, useHeaderAuth = false) {
      const endpoint = useHeaderAuth ? '/api/ai/generate-with-header' : '/api/ai/generate';
      const url = `${BACKEND_URL}${endpoint}`;

      // Add model to request body
      const bodyWithModel = {
        ...requestBody,
        model: model
      };

      logModelUsage('BackendProxy', model, useHeaderAuth ? 'header auth' : 'body auth');

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(bodyWithModel)
      });

      // Backend returns JSON directly (no encoding)
      return resp;
    }

    // ---------- Markdown renderer
    function escapeHtml(s) { return s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function renderMarkdown(md) {
      if (!md) return "";
      let html = escapeHtml(md);

      // Process code blocks and inline code first (to protect them)
      html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
      html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);

      // Process headers
      html = html.replace(/^###### (.*)$/gm, "<h6>$1</h6>")
                 .replace(/^##### (.*)$/gm, "<h5>$1</h5>")
                 .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
                 .replace(/^### (.*)$/gm, "<h3>$1</h3>")
                 .replace(/^## (.*)$/gm, "<h2>$1</h2>")
                 .replace(/^# (.*)$/gm, "<h1>$1</h1>");

      // Process lists BEFORE bold/italic (to avoid * being treated as emphasis)
      html = html.replace(/^((?:\s*[-*+]\s+.+(?:\n|$))+)/gm, block => {
        const items = block.trim().split(/\n/).filter(l => l.trim());
        return `<ul>${items.map(l => `<li>${l.replace(/^\s*[-*+]\s+/, "").trim()}</li>`).join("")}</ul>`;
      });
      html = html.replace(/^(?:\s*\d+\.\s+.+\n?)+/gm, b => `<ol>${b.trim().split(/\n/).map(l=>`<li>${l.replace(/^\s*\d+\.\s+/, "")}</li>`).join("")}</ol>`);

      // Now process bold and italic (after lists)
      html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");

      // Process links
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`);

      // Wrap remaining lines in paragraphs
      html = html.replace(/^(?!<(?:h\d|ul|ol|li|pre|code|blockquote)|<\/)(.+)$/gm, "<p>$1</p>");

      return html;
    }

    // ---------- MathJax
    function ensureMathJax() {
      return new Promise((resolve) => {
        if (window.MathJax && window.MathJax.typesetPromise) return resolve();
        window.MathJax = window.MathJax || { tex: { inlineMath: [['$', '$'], ['\\(', '\\)']] }, svg: { fontCache: 'global' } };
        const s = document.createElement("script");
        s.src = MATHJAX_SRC; s.async = true; s.onload = () => resolve();
        s.onerror = () => {
          console.warn('[MathJax] Failed to load from CDN (likely CSP blocked)');
          resolve(); // Resolve anyway to not block execution
        };
        document.head.appendChild(s);
      });
    }
    async function typesetEl(el) {
      try { await ensureMathJax(); if (window.MathJax?.typesetPromise) await window.MathJax.typesetPromise([el]); }
      catch (e) { console.warn("MathJax typeset failed:", e); }
    }

    // ---------- jsPDF
    function ensureJsPDF() {
      return new Promise((resolve, reject) => {
        if (window.jspdf?.jsPDF) return resolve();
        const s = document.createElement("script");
        s.src = JSPDF_SRC;
        s.async = true;
        s.onload = () => resolve();
        s.onerror = () => {
          console.warn('[jsPDF] Failed to load from CDN (likely CSP blocked)');
          reject(new Error('Failed to load jsPDF'));
        };
        document.head.appendChild(s);
      });
    }

    // ---------- OCR + Similarity
    async function ensureTesseract() {
      if (window.Tesseract) return;
      await new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = TESSERACT_SRC;
        s.onload = () => resolve();
        s.onerror = () => {
          console.warn('[Tesseract] Failed to load from CDN (likely CSP blocked)');
          resolve(); // Resolve anyway to not block execution
        };
        document.head.appendChild(s);
      });
    }
    async function ocrFromBase64(b64) {
      await ensureTesseract();
      const url = "data:image/png;base64," + b64;
      const { data: { text } } = await Tesseract.recognize(url, "eng");
      return (text || "").trim();
    }
    function subsetSimilarity(a, b) {
      a = (a || "").toLowerCase(); b = (b || "").toLowerCase();
      const aWords = new Set(a.split(/\s+/)); const bWords = new Set(b.split(/\s+/));
      const overlap = [...aWords].filter(w => bWords.has(w)).length;
      const smaller = Math.min(aWords.size, bWords.size);
      return smaller === 0 ? 0 : (overlap / smaller) * 100;
    }
    function hashText(s) { s = s || ""; let h=5381; for (let i=0;i<s.length;i++) h=((h<<5)+h)+s.charCodeAt(i); return "sg_" + (h>>>0).toString(16); }
    function findBestGroupByText(currText) {
      if (!slideGroups.length) return { group: null, sim: NaN };
      let best=null, bestSim=-1; for (const g of slideGroups){ const sim=subsetSimilarity(currText,g.ocrText||""); if (sim>bestSim){bestSim=sim; best=g;} }
      return { group: best, sim: bestSim };
    }
    function getGroupById(id){ return slideGroups.find(g=>g.id===id) || null; }
    function createGroup(currText){ const id=hashText(currText||Math.random().toString(36).slice(2)); const g={id,ocrText:currText||"",messages:[]}; slideGroups.push(g); return g; }
    function showSlideChangedBadge(){ slideBadge.style.display="inline-block"; slideBadge.classList.remove("fade"); slideBadge.textContent="Slide changed"; setTimeout(()=> slideBadge.classList.add("fade"),1050); setTimeout(()=> { slideBadge.style.display="none"; slideBadge.classList.remove("fade"); },2400); }
    function storeMessageInGroup(groupId, role, text){ const g = groupId ? getGroupById(groupId) : null; if (g) g.messages.push({role,text}); }
    function getAllHistoryExcludingCurrent(){
      if (!history.length) return [];
      const copy = history.slice();
      if (copy[copy.length-1]?.role === "user") copy.pop();
      return copy;
    }

    // ---------- UI styles
    const style = document.createElement("style");
    style.textContent = `
      #gemini-ui-toggle {
        position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
        width: 60px; height: 60px; padding: 6px; border-radius: 12px; border: 1px solid #000;
        background: transparent;
        cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.2);
        overflow: hidden;
      }
      #gemini-ui-toggle.dark-mode {
        background: transparent;
        border-color: #fff;
      }
      #gemini-ui-toggle img {
        width: 170%; height: 170%;
        object-fit: cover;
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }
      #gemini-ui-panel, #gemini-ui-panel * { box-sizing: border-box; }
      #gemini-ui-panel {
        position: fixed; z-index: 2147483647;
        background: #fff; color: #111; border-radius: 12px; border: 1px solid rgba(0,0,0,.08);
        box-shadow: 0 12px 30px rgba(0,0,0,.18); padding: 12px; display: none;
        font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        display: flex; flex-direction: column; overflow: hidden; contain: layout paint;
        opacity: 0;
        transform: scale(0.95) translateY(10px);
        transition: opacity 0.2s ease-out, transform 0.2s ease-out;
      }
      #gemini-ui-panel.panel-visible {
        opacity: 1;
        transform: scale(1) translateY(0);
      }
      #gemini-ui-panel.dark-mode {
        background: #000000; color: #fff; border-color: rgba(255,255,255,.1);
      }
      #gemini-ui-panel.default-theme {
        color: #111;
      }
      #gemini-ui-panel.default-theme #gemini-ui-settings,
      #gemini-ui-panel.default-theme #gemini-ui-settings * {
        color: #fff;
      }
      #gemini-ui-panel.default-theme #gemini-ui-settings input[type="text"],
      #gemini-ui-panel.default-theme #gemini-ui-settings textarea,
      #gemini-ui-panel.default-theme #gemini-ui-settings select {
        color: #111;
      }
      #gemini-ui-panel.default-theme #gemini-header-title,
      #gemini-ui-panel.default-theme #gemini-header-subtitle {
        color: #fff;
      }
      #gemini-model-label {
        color: #666;
      }
      #gemini-ui-panel.dark-mode #gemini-model-label {
        color: #aaa;
      }
      #gemini-ui-panel.default-theme #gemini-model-label {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode #gemini-ui-chat {
        background: #1a1a1a; border-color: rgba(255,255,255,.1);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-text {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-text::placeholder {
        color: rgba(255,255,255,.5);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-clear {
        background: transparent !important; color: #fff; border: none !important;
      }
      #gemini-ui-panel.dark-mode #gemini-ui-model {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-custom-answer-type {
        background: #1a1a1a !important; color: #fff !important; border-color: rgba(255,255,255,.2) !important;
      }
      #gemini-ui-panel.dark-mode #gemini-custom-answer-type::placeholder {
        color: rgba(255,255,255,.5) !important;
      }
      #gemini-ui-panel.dark-mode .gemini-bubble {
        background: #2a2a2a; color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .gemini-bubble.me {
        background: #333; color: #fff;
      }
      #gemini-ui-panel.dark-mode #gemini-ui-spinner {
        border-color: #444; border-top-color: #fff;
      }
      #gemini-ui-panel.dark-mode .gemini-inline-spinner {
        border-color: #444; border-top-color: #fff;
      }
      #gemini-ui-panel.dark-mode #gemini-ui-settings-close,
      #gemini-ui-panel.dark-mode #gemini-ui-settings-reset {
        background: #1a1a1a !important; color: #fff !important; border-color: rgba(255,255,255,.2) !important;
      }
      #gemini-ui-panel.dark-mode #gemini-ui-quiz-btn {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-flashcard-btn {
        background: #222; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-checklist-btn {
        background: #222; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-summary-btn {
        background: #222; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode #gemini-ui-send,
      #gemini-ui-panel.dark-mode #gemini-ui-stop {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-container button {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-question-text,
      #gemini-ui-panel.dark-mode .quiz-option label,
      #gemini-ui-panel.dark-mode .quiz-summary-text {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode input[type="text"],
      #gemini-ui-panel.dark-mode textarea,
      #gemini-ui-panel.dark-mode select {
        background: #1a1a1a !important; color: #fff !important; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode select option {
        background: #1a1a1a !important; color: #fff !important;
      }
      body.dark-mode select,
      body.dark-mode select option {
        background: #1a1a1a !important; color: #fff !important;
      }
      #gemini-ui-panel.dark-mode .quiz-generating-ui {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-gen-text {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-gen-subtext {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .quiz-gen-spinner {
        border-color: #444; border-top-color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-meta,
      #gemini-ui-panel.dark-mode .quiz-kicker {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .quiz-question {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-option {
        background: #1a1a1a; border-color: rgba(255,255,255,.2); color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-option:hover {
        background: #252525;
      }
      #gemini-ui-panel.dark-mode .quiz-textbox {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-btn {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-btn-secondary {
        background: #252525; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-chip {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-dropzone {
        background: #1a1a1a; outline-color: rgba(255,255,255,.3);
      }
      #gemini-ui-panel.dark-mode .quiz-dropzone.hover {
        background: #252525; outline-color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-select {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-sequence-item {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-step-item {
        background: #1a1a1a; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-step-item:hover {
        background: rgba(102, 126, 234, 0.1); border-color: rgba(102, 126, 234, 0.5);
      }
      #gemini-ui-panel.dark-mode .quiz-step-item.selected {
        background: rgba(244, 67, 54, 0.15); border-color: #f44336;
      }
      #gemini-ui-panel.dark-mode .quiz-step-content {
        color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-step-instruction {
        background: rgba(102, 126, 234, 0.15); border-left-color: #667eea; color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-debate-scenario {
        background: rgba(255, 193, 7, 0.15); border-left-color: #ffc107; color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-debate-person {
        background: #1a1a1a; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-debate-statement {
        color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-debate-instruction {
        background: rgba(76, 175, 80, 0.15); border-left-color: #4caf50; color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-debate-textarea {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-debate-textarea:focus {
        border-color: #4caf50;
      }
      #gemini-ui-panel.dark-mode .quiz-mixed-container {
        background: rgba(255,255,255,.02); border-color: rgba(255,255,255,.1); color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .quiz-mixed-input,
      #gemini-ui-panel.dark-mode .quiz-mixed-dropdown {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-mixed-input:focus,
      #gemini-ui-panel.dark-mode .quiz-mixed-dropdown:focus {
        border-color: #667eea;
      }
      #gemini-ui-panel.dark-mode .quiz-result {
        background: #1a1a1a; color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-review-item {
        background: #1a1a1a; border-color: rgba(255,255,255,.2); color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-review-line {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .quiz-badge {
        background: #333; color: #aaa;
      }
      #gemini-ui-panel.dark-mode .quiz-progress {
        background: #333;
      }
      #gemini-ui-panel.dark-mode .quiz-progress > div {
        background: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-hint-btn {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .quiz-hint-text {
        background: rgba(255, 193, 7, 0.2); color: #ffc107;
      }
      #gemini-ui-panel.dark-mode .overleaf-options-subtitle {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .checklist-subtitle {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .checklist-header {
        border-bottom-color: rgba(255,255,255,.1);
      }
      #gemini-ui-panel.dark-mode .checklist-actions {
        border-top-color: rgba(255,255,255,.1);
      }
      #gemini-ui-panel.dark-mode .checklist-item {
        background: #1a1a1a; color: #fff;
      }
      #gemini-ui-panel.dark-mode .checklist-item:hover {
        background: #252525;
      }
      #gemini-ui-panel.dark-mode .checklist-help-icon {
        background: rgba(66, 133, 244, 0.2); color: #6ab7ff;
      }
      #gemini-ui-panel.dark-mode .checklist-help-icon:hover {
        background: rgba(66, 133, 244, 0.3);
      }
      #gemini-ui-panel.dark-mode .coverage-info {
        background: rgba(66, 133, 244, 0.1); border-left-color: rgba(106, 183, 255, 0.4);
      }
      #gemini-ui-panel.dark-mode .coverage-label {
        color: #e0e0e0;
      }
      #gemini-ui-panel.dark-mode .coverage-desc {
        color: #aaa;
      }
      #gemini-ui-panel.dark-mode .flashcard-btn {
        background: #1a1a1a; color: #fff; border-color: rgba(255,255,255,.2);
      }
      #gemini-ui-panel.dark-mode .flashcard-btn-primary {
        background: #6a1b9a; color: #fff; border-color: #6a1b9a;
      }
      #gemini-ui-panel.dark-mode .flashcard-btn-overleaf {
        background: #228B22; color: #fff; border-color: #228B22;
      }

      /* Accessibility: Increased Font Size */
      #gemini-ui-panel.large-font {
        font-size: 16px;
      }
      #gemini-ui-panel.large-font * {
        font-size: inherit !important;
      }
      #gemini-ui-panel.large-font .gemini-bubble {
        font-size: 18px !important;
      }
      #gemini-ui-panel.large-font #gemini-ui-text {
        font-size: 18px !important;
      }
      #gemini-ui-panel.large-font .quiz-question {
        font-size: 20px !important;
      }
      #gemini-ui-panel.large-font .quiz-gen-text {
        font-size: 20px !important;
      }
      #gemini-ui-panel.large-font .quiz-gen-subtext {
        font-size: 16px !important;
      }
      #gemini-ui-panel.large-font .quiz-gen-eta {
        font-size: 15px !important;
      }
      #gemini-ui-panel.large-font .flashcard-face {
        font-size: 20px !important;
      }
      #gemini-ui-panel.large-font .flashcard-counter {
        font-size: 16px !important;
      }
      #gemini-ui-panel.large-font .checklist-item {
        font-size: 18px !important;
      }
      #gemini-ui-panel.large-font .checklist-help-icon {
        width: 24px; height: 24px; min-width: 24px; font-size: 18px;
      }
      #gemini-ui-panel.large-font .coverage-info {
        font-size: 16px !important;
      }
      #gemini-ui-panel.large-font .coverage-label {
        font-size: 16px !important;
      }
      #gemini-ui-panel.large-font .coverage-desc {
        font-size: 15px !important;
      }
      #gemini-ui-panel.large-font button,
      #gemini-ui-panel.large-font .flashcard-btn,
      #gemini-ui-panel.large-font .quiz-answer {
        font-size: 16px !important;
        padding: 10px 18px !important;
      }
      #gemini-ui-panel.large-font #gemini-ui-settings-btn {
        font-size: 24px !important;
      }
      #gemini-ui-panel.large-font input[type="text"],
      #gemini-ui-panel.large-font input[type="checkbox"],
      #gemini-ui-panel.large-font textarea {
        font-size: 18px !important;
      }
      #gemini-ui-panel.large-font label {
        font-size: 16px !important;
      }
      /* Settings panel text */
      #gemini-ui-panel.large-font .settings-panel label,
      #gemini-ui-panel.large-font .settings-panel div,
      #gemini-ui-panel.large-font .settings-panel span {
        font-size: 16px !important;
      }
      /* Model label and dropdown */
      #gemini-ui-panel.large-font #gemini-ui-left > div,
      #gemini-ui-panel.large-font #gemini-ui-model,
      #gemini-ui-panel.large-font select,
      #gemini-ui-panel.large-font option {
        font-size: 16px !important;
      }
      /* Summary content */
      #gemini-ui-panel.large-font .summary-content-wrapper,
      #gemini-ui-panel.large-font .summary-content-wrapper p,
      #gemini-ui-panel.large-font .summary-content-wrapper div,
      #gemini-ui-panel.large-font .summary-content-wrapper span,
      #gemini-ui-panel.large-font .summary-content-wrapper li {
        font-size: 18px !important;
      }
      #gemini-ui-panel.large-font .summary-content-wrapper h1 {
        font-size: 32px !important;
      }
      #gemini-ui-panel.large-font .summary-content-wrapper h2 {
        font-size: 28px !important;
      }
      #gemini-ui-panel.large-font .summary-content-wrapper h3 {
        font-size: 24px !important;
      }
      #gemini-ui-panel.large-font .summary-content-wrapper h4 {
        font-size: 20px !important;
      }
      #gemini-ui-panel.large-font .summary-content-wrapper code,
      #gemini-ui-panel.large-font .summary-content-wrapper pre {
        font-size: 16px !important;
      }
      /* Pro tip box */
      #gemini-ui-panel.large-font .pro-tip-title,
      #gemini-ui-panel.large-font .pro-tip-text {
        font-size: 15px !important;
      }
      /* Ensure layout doesn't break */
      #gemini-ui-panel.large-font .flashcard-container,
      #gemini-ui-panel.large-font .checklist-container,
      #gemini-ui-panel.large-font .quiz-container {
        overflow-y: auto !important;
        box-sizing: border-box !important;
      }
      #gemini-ui-panel.large-font .flashcard-scene {
        min-height: 340px !important;
      }

      /* Accessibility: High Contrast Mode */
      #gemini-ui-panel.high-contrast {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast #gemini-ui-chat {
        background: #000 !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .gemini-bubble {
        background: #000 !important;
        color: #ffff00 !important;
        border: 2px solid #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .gemini-bubble.me {
        background: #000 !important;
        color: #00ff00 !important;
        border: 2px solid #00ff00 !important;
      }
      #gemini-ui-panel.high-contrast button {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast input,
      #gemini-ui-panel.high-contrast textarea,
      #gemini-ui-panel.high-contrast select {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }

      /* Accessibility: Reduced Motion */
      #gemini-ui-panel.reduced-motion *,
      #gemini-ui-panel.reduced-motion *::before,
      #gemini-ui-panel.reduced-motion *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }

      /* Accessibility: Keyboard Navigation Highlight */
      .keyboard-focus {
        outline: 3px solid #4a63ff !important;
        outline-offset: 2px !important;
      }

      /* High Contrast: Additional fixes */
      #gemini-ui-panel.high-contrast .quiz-hint-btn {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-hint-text {
        background: #000 !important;
        color: #ffff00 !important;
        border: 2px solid #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .quiz-chip {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-dropzone {
        background: #000 !important;
        border: 2px dashed #fff !important;
        outline: none !important;
      }
      #gemini-ui-panel.high-contrast .quiz-select {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-sequence-item {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-chip.kb-selected,
      #gemini-ui-panel.high-contrast .quiz-sequence-item.kb-selected {
        background: #000 !important;
        color: #ffff00 !important;
        border: 3px solid #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .quiz-dropzone.highlight-for-drop {
        background: #000 !important;
        border: 3px dashed #ffff00 !important;
        outline: none !important;
      }
      #gemini-ui-panel.high-contrast #gemini-ui-settings {
        background: #000 !important;
      }

      /* High Contrast: Quiz Generation UI */
      #gemini-ui-panel.high-contrast .quiz-gen-spinner {
        border-color: rgba(255,255,255,0.2) !important;
        border-top-color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-gen-text {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-gen-subtext {
        color: #ffff00 !important;
      }

      /* High Contrast: Progress Bar */
      #gemini-ui-panel.high-contrast .quiz-progress {
        background: rgba(255,255,255,0.2) !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-progress > div {
        background: #fff !important;
      }

      /* High Contrast: Quiz Summary Page */
      #gemini-ui-panel.high-contrast .quiz-result {
        background: #000 !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-score {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-review-item {
        background: #000 !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-review-item h4 {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-review-line {
        color: #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .quiz-badge {
        background: #000 !important;
        color: #fff !important;
        border: 1px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-card {
        background: #000 !important;
        border: none !important;
        min-height: 300px !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-front,
      #gemini-ui-panel.high-contrast .flashcard-back {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
        box-shadow: none !important;
        min-height: 300px !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-progress {
        background: #000 !important;
        border: 1px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-progress-bar {
        background: #fff !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-btn {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-btn-primary {
        background: #000 !important;
        color: #ffff00 !important;
        border: 2px solid #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .flashcard-btn-overleaf {
        background: #000 !important;
        color: #00ff00 !important;
        border: 2px solid #00ff00 !important;
      }
      #gemini-ui-panel.high-contrast .summary-cancel-btn {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.high-contrast .summary-repair-btn {
        background: #000 !important;
        color: #00ff00 !important;
        border: 2px solid #00ff00 !important;
      }
      #gemini-ui-header { display:flex; align-items:center; gap:8px; font-weight:600; margin-bottom:8px; cursor: move; user-select: none; }
      #gemini-ui-spinner {
        width: 16px; height: 16px; border: 2px solid #ddd; border-top-color: #111; border-radius: 50%;
        animation: gemini-spin 1s linear infinite; display: none;
      }
      @keyframes gemini-spin { to { transform: rotate(360deg); } }
      #gemini-slide-badge {
        display:none; font-size:12px; color:#666; opacity:1; transition: opacity 1.2s ease; margin-right:6px;
      }
      #gemini-slide-badge.fade { opacity: 0; }
      #gemini-ui-panel.dark-mode #gemini-slide-badge {
        color: #fff;
      }
      #gemini-ui-panel.default-theme #gemini-slide-badge {
        color: #fff;
      }
      #gemini-ui-controls { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; flex-wrap: wrap; }
      #gemini-ui-controls > div:last-child { justify-content: right; flex: 1 1 auto; }
      #gemini-ui-left { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
      #gemini-ui-at { display:flex; gap:6px; align-items:center; }
      #gemini-ui-at label { display:flex; gap:4px; align-items:center; font-size:12px; color:#333; padding:4px 6px; border:1px solid rgba(0,0,0,.08); border-radius:8px; cursor:pointer; }
      #gemini-ui-slidectx { display:flex; gap:6px; align-items:center; font-size:12px; color:#333; padding:4px 6px; border:1px solid rgba(0,0,0,.08); border-radius:8px; cursor:pointer; }
      #gemini-ui-clear { padding: 0; border: none; background: transparent; cursor: pointer; font-size: 24px; }
      #gemini-ui-panel.high-contrast #gemini-ui-clear {
        border: none !important;
        background: transparent !important;
      }
      #gemini-ui-model { font-size:12px; padding:4px 6px; border-radius:6px; border:1px solid rgba(0,0,0,.08); }
      #gemini-ui-quiz-btn { padding: 8px 10px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#111; color:#fff; cursor:pointer; font-weight:600; }
      #gemini-ui-flashcard-btn { padding: 8px 10px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#111; color:#fff; cursor:pointer; font-weight:600; }
      #gemini-ui-checklist-btn { padding: 8px 10px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#111; color:#fff; cursor:pointer; font-weight:600; }
      #gemini-ui-summary-btn { padding: 8px 10px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#111; color:#fff; cursor:pointer; font-weight:600; }
      #gemini-ui-panel.default-theme #gemini-ui-quiz-btn { background: #f7f7f7; color: #000000; border-color: #e0e0e0; }
      #gemini-ui-panel.default-theme #gemini-ui-flashcard-btn { background: #000000; color: #ffffff; border-color: #333333; }
      #gemini-ui-panel.default-theme #gemini-ui-checklist-btn { background: #f7f7f7; color: #000000; border-color: #e0e0e0; }
      #gemini-ui-panel.default-theme #gemini-ui-summary-btn { background: #000000; color: #ffffff; border-color: #333333; }
      #gemini-ui-panel.default-theme #gemini-ui-clear .clear-emoji { filter: invert(1) hue-rotate(180deg) brightness(2) contrast(1.5); font-size: 24px; }
      #gemini-ui-panel.default-theme .summary-cancel-btn { background: #000000; color: #ffffff; border-color: #333333; }
      #gemini-ui-panel.default-theme #gemini-ui-error { color: #ffffff; }
      .settings-credit-link { font-size: 13px; font-weight: 900; font-style: italic; transition: color 0.2s; }
      .settings-credit-link:hover { color: #eeeeee !important; }
      #gemini-ui-panel.default-theme .settings-credit-link { color: #ffffff; }
      #gemini-ui-panel.dark-mode .settings-credit-link { color: #ffffff; }
      #gemini-ui-panel.light-mode .settings-credit-link { color: #000000; }
      #gemini-ui-settings-btn {
        padding: 0;
        background: transparent; cursor: pointer; font-size: 38px; line-height: 1;
        color: #bcb6e4; border: none;
      }
      #gemini-ui-panel.high-contrast #gemini-ui-settings-btn {
        border: none !important;
      }

      #gemini-ui-chat {
        flex: 1 1 auto;
        min-height: 120px; overflow: auto; border: 1px solid rgba(0,0,0,.08);
        border-radius: 10px; padding: 8px; background: #fafafa; margin-bottom: 8px; position: relative;
      }

      .gemini-msg { margin: 8px 0; max-width: 90%; }
      .gemini-me { text-align: right; margin-left: auto; }
      .gemini-bubble {
        display: inline-block; padding: 8px 10px; border-radius: 12px;
        background: #e9f0ff; color: #0b3aa7; max-width: 100%; overflow-wrap: anywhere;
      }
      .gemini-bubble.me { background: #111; color: #fff; }
      .gemini-bubble.initialising { background: #fff3e0; color: #e65100; }
      .gemini-bubble :where(p, ul, ol, h1, h2, h3, h4, h5, h6, pre, code){ margin: 6px 0; }
      .gemini-bubble pre { background: #111; color: #fff; padding: 8px; border-radius: 8px; overflow:auto; }
      .gemini-bubble code { background: rgba(0,0,0,.06); padding: 2px 4px; border-radius: 4px; }
      .gemini-inline-spinner {
        width: 14px; height: 14px; border: 2px solid #ddd; border-top-color: #111; border-radius: 50%;
        animation: gemini-spin 1s linear infinite; display:inline-block; vertical-align:middle;
      }

      #gemini-attachments {
        display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px;
        max-height: 72px; overflow:auto;
      }
      .gem-chip {
        display:flex; align-items:center; gap:6px; border:1px solid rgba(0,0,0,.1); border-radius:8px; padding:4px 6px; background:#f1f4ff;
        font-size:12px;
      }
      .gem-chip img { width:18px; height:18px; object-fit:cover; border-radius:4px; }
      .gem-chip button { border:0; background:transparent; cursor:pointer; font-size:12px; color:#b00020; }
      .chip-status { font-size:11px; color:#555; }
      .chip-ok { color:#05610d; font-weight:600; }
      .chip-fail { color:#b00020; font-weight:600; }

      #gemini-ui-inputrow { flex: 0 0 auto; display:flex; gap:8px; align-items:center; }
      #gemini-ui-text {
        flex:1; height: 40px; resize: vertical; max-height: 160px;
        border: 1px solid rgba(0,0,0,.12); border-radius: 8px; padding: 8px;
        font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      }
      #gemini-ui-send, #gemini-ui-close, #gemini-ui-stop {
        padding: 10px 12px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12);
        background: #111; color: #fff; cursor: pointer; min-width: 72px;
      }
      #gemini-ui-attach {
        width: 40px; height: 40px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12);
        background: #ca1873; color: #fff; cursor: pointer; display: flex; align-items: center;
        justify-content: center; font-size: 18px; flex-shrink: 0;
      }
      #gemini-ui-send[disabled] { opacity: .5; cursor: not-allowed; }
      #gemini-ui-close { background: #f3f3f3; color: #111; }
      #gemini-ui-stop { background: #b00020; display: none; }
      #gemini-ui-error { color: #b00020; font-size: 12px; display:none; margin-top:6px; align-items: center; justify-content: space-between; }

      .gemini-resizer { position: absolute; z-index: 10; }
      .resize-top    { top:-5px; left:0; right:0; height:10px; cursor: ns-resize; z-index: 10; }
      .resize-bottom { bottom:-5px; left:0; right:0; height:10px; cursor: ns-resize; z-index: 10; }
      .resize-left   { left:-5px; top:0; bottom:0; width:10px; cursor: ew-resize; z-index: 10; }
      .resize-right  { right:-5px; top:0; bottom:0; width:10px; cursor: ew-resize; z-index: 10; }
      .resize-nw { top:-6px; left:-6px; width:14px; height:14px; cursor: nwse-resize; z-index: 11; }
      .resize-ne { top:-6px; right:-6px; width:14px; height:14px; cursor: nesw-resize; z-index: 11; }
      .resize-sw { bottom:-6px; left:-6px; width:14px; height:14px; cursor: nesw-resize; z-index: 11; }
      .resize-se { bottom:-6px; right:-6px; width:14px; height:14px; cursor: nwse-resize; z-index: 11; }
      .gemini-tiny-btn {
        background: transparent; border: 1px solid rgba(0,0,0,.2); border-radius: 6px; padding: 2px 6px;
        font-size: 12px; cursor: pointer; margin-left: 6px;
      }

      /* Quiz Styles */
      .quiz-container { padding: 8px; }
      .quiz-progress { height: 8px; width: 100%; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden; margin: 10px 0; }
      .quiz-progress > div { height: 100%; background: #111; transition: width .25s ease; }
      .quiz-meta { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 12px; color: #666; }
      .quiz-question { font-size: 16px; font-weight: 600; margin: 12px 0; line-height: 1.4; }
      .quiz-options { display: grid; gap: 8px; margin: 12px 0; }
      .quiz-option { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: rgba(0,0,0,.02); border: 1px solid rgba(0,0,0,.08); border-radius: 8px; transition: background .15s ease; }
      .quiz-option:hover { background: rgba(0,0,0,.04); }
      .quiz-option input { flex-shrink: 0; }
      .quiz-option span { flex: 1; }
      .quiz-textbox { width: 100%; padding: 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); font: 14px/1.4 system-ui, sans-serif; }
      .quiz-nav { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; gap: 8px; }
      .quiz-btn { padding: 8px 12px; border-radius: 16px; border: 1px solid rgba(0,0,0,.12); background: #111; color: #fff; cursor: pointer; font-weight: 600; }
      .quiz-btn-secondary { background: #f5f5f5; color: #111; }
      .quiz-btn:disabled { opacity: .5; cursor: not-allowed; }
      .quiz-word-bank, .quiz-dropzone-list { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
      .quiz-chip { user-select: none; padding: 8px 10px; border-radius: 8px; background: #f1f4ff; border: 1px solid rgba(0,0,0,.12); cursor: grab; }
      .quiz-chip:active { cursor: grabbing; }
      .quiz-chip.dragging { opacity: .5; }
      .quiz-dropzone { min-width: 120px; min-height: 38px; display: inline-flex; align-items: center; justify-content: center; padding: 8px 10px; border-radius: 8px; background: rgba(0,0,0,.02); outline: 1px dashed rgba(0,0,0,.15); }
      .quiz-dropzone.hover { outline-color: #111; background: rgba(0,0,0,.06); }
      .quiz-pair { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 10px; margin: 8px 0; }
      .quiz-select { background: rgba(0,0,0,.02); padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); font: 14px/1.4 system-ui, sans-serif; max-width: 200px; width: 100%; }
      .quiz-sequence-list { display: grid; gap: 8px; margin: 10px 0; }
      .quiz-sequence-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: rgba(0,0,0,.02); border: 1px solid rgba(0,0,0,.1); border-radius: 8px; cursor: grab; }
      .quiz-sequence-item.dragging { opacity: .5; }
      .quiz-steps-list { display: flex; flex-direction: column; gap: 0; margin: 12px 0; position: relative; }
      .quiz-step-flow-container { position: relative; }
      .quiz-step-item { display: block; position: relative; padding: 16px 20px 16px 60px; background: #fff; border: 2px solid rgba(0,0,0,.12); border-radius: 12px; cursor: pointer; transition: all .25s; margin-bottom: 16px; box-shadow: 0 2px 4px rgba(0,0,0,.05); }
      .quiz-step-item::before { content: attr(data-step-num); position: absolute; left: 16px; top: 50%; transform: translateY(-50%); width: 32px; height: 32px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 14px; box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3); }
      .quiz-step-item::after { content: ''; position: absolute; left: 31px; top: calc(100% + 2px); width: 2px; height: 14px; background: linear-gradient(to bottom, #667eea, rgba(102, 126, 234, 0.3)); }
      .quiz-step-item:last-child::after { display: none; }
      .quiz-step-item:hover { background: rgba(102, 126, 234, 0.03); border-color: rgba(102, 126, 234, 0.3); transform: translateX(4px); box-shadow: 0 4px 12px rgba(0,0,0,.08); }
      .quiz-step-item.selected { background: rgba(244, 67, 54, 0.05); border: 3px solid #f44336; box-shadow: 0 4px 16px rgba(244, 67, 54, 0.25); }
      .quiz-step-item.selected::before { background: linear-gradient(135deg, #f44336 0%, #d32f2f 100%); box-shadow: 0 2px 12px rgba(244, 67, 54, 0.5); }
      .quiz-step-item.selected::after { background: linear-gradient(to bottom, #f44336, rgba(244, 67, 54, 0.3)); }
      .quiz-step-item input[type="radio"] { display: none; }
      .quiz-step-content { line-height: 1.6; color: #333; padding-right: 40px; }
      .quiz-step-content p { margin: 0; }
      .quiz-step-icon { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); font-size: 20px; opacity: 0; transition: opacity .2s; }
      .quiz-step-item.selected .quiz-step-icon { opacity: 1; }
      .quiz-step-instruction { margin: 12px 0; padding: 12px 16px; background: rgba(102, 126, 234, 0.08); border-left: 4px solid #667eea; border-radius: 6px; font-size: 14px; color: #555; }
      .quiz-debate-scenario { margin: 12px 0 20px 0; padding: 14px 18px; background: rgba(255, 193, 7, 0.08); border-left: 4px solid #ffc107; border-radius: 8px; font-size: 14px; line-height: 1.6; }
      .quiz-debate-person { margin: 12px 0; padding: 14px 18px; background: #fff; border: 2px solid rgba(0,0,0,.1); border-radius: 10px; box-shadow: 0 2px 6px rgba(0,0,0,.05); }
      .quiz-debate-person-a { border-left: 4px solid #2196f3; }
      .quiz-debate-person-b { border-left: 4px solid #9c27b0; }
      .quiz-debate-label { font-weight: 700; font-size: 13px; margin-bottom: 8px; color: #555; }
      .quiz-debate-person-a .quiz-debate-label { color: #2196f3; }
      .quiz-debate-person-b .quiz-debate-label { color: #9c27b0; }
      .quiz-debate-statement { font-size: 14px; line-height: 1.6; color: #333; }
      .quiz-debate-instruction { margin: 20px 0 10px 0; padding: 12px 16px; background: rgba(76, 175, 80, 0.08); border-left: 4px solid #4caf50; border-radius: 6px; font-size: 14px; color: #555; }
      .quiz-debate-textarea { width: 100%; padding: 12px 14px; border: 2px solid rgba(0,0,0,.12); border-radius: 8px; font: 14px/1.6 system-ui, sans-serif; resize: vertical; min-height: 100px; box-sizing: border-box; transition: border-color .2s; }
      .quiz-debate-textarea:focus { outline: none; border-color: #4caf50; box-shadow: 0 0 0 3px rgba(76, 175, 80, 0.1); }
      .quiz-mixed-container { font-size: 15px; line-height: 2; padding: 16px 20px; background: rgba(0,0,0,.01); border-radius: 10px; border: 1px solid rgba(0,0,0,.06); }
      .quiz-mixed-blank { display: inline-flex; align-items: center; gap: 4px; margin: 0 2px; position: relative; }
      .quiz-mixed-input { padding: 4px 10px; border: 2px solid rgba(0,0,0,.15); border-radius: 6px; font: 14px system-ui, sans-serif; min-width: 120px; transition: all .2s; background: #fff; }
      .quiz-mixed-input:focus { outline: none; border-color: #4a63ff; box-shadow: 0 0 0 3px rgba(74, 99, 255, 0.1); }
      .quiz-mixed-dropdown { padding: 4px 8px; border: 2px solid rgba(0,0,0,.15); border-radius: 6px; font: 14px system-ui, sans-serif; background: #fff; cursor: pointer; transition: all .2s; }
      .quiz-mixed-dropdown:focus { outline: none; border-color: #4a63ff; box-shadow: 0 0 0 3px rgba(74, 99, 255, 0.1); }
      .quiz-mixed-hint-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; border-radius: 50%; background: rgba(74, 99, 255, 0.1); color: #4a63ff; font-size: 11px; font-weight: 700; cursor: help; transition: all .2s; user-select: none; }
      .quiz-mixed-hint-icon:hover { background: #4a63ff; color: #fff; transform: scale(1.1); }
      .quiz-mixed-hint-tooltip { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); background: #2c3e50; color: #fff; padding: 8px 12px; border-radius: 6px; font-size: 12px; line-height: 1.4; white-space: nowrap; max-width: 250px; white-space: normal; box-shadow: 0 4px 12px rgba(0,0,0,.2); z-index: 1000; opacity: 0; pointer-events: none; transition: opacity .2s; }
      .quiz-mixed-hint-tooltip::after { content: ''; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 6px solid transparent; border-top-color: #2c3e50; }
      .quiz-mixed-hint-icon:hover .quiz-mixed-hint-tooltip { opacity: 1; }
      .quiz-chip.kb-selected,
      .quiz-sequence-item.kb-selected,
      .quiz-step-item.kb-selected {
        background: #e3f2fd !important;
        border: 3px solid #4a63ff !important;
        box-shadow: 0 0 8px rgba(74, 99, 255, 0.4);
      }
      .quiz-dropzone.highlight-for-drop {
        background: rgba(74, 99, 255, 0.1) !important;
        border: 3px dashed #4a63ff !important;
        outline: none !important;
        box-shadow: 0 0 8px rgba(74, 99, 255, 0.3);
      }
      .quiz-result { padding: 12px; background: rgba(0,0,0,.02); border-radius: 10px; margin: 10px 0; }
      .quiz-score { font-size: 24px; font-weight: 700; margin: 8px 0; }
      .quiz-review-item { padding: 10px; border: 1px solid rgba(0,0,0,.08); border-radius: 8px; margin: 8px 0; background: rgba(0,0,0,.01); position: relative; padding-bottom: 50px; }
      .quiz-review-item h4 { margin: 0 0 6px 0; font-size: 14px; }
      .quiz-review-view-btn { position: absolute; bottom: 10px; right: 10px; padding: 6px 12px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #4a63ff; color: #fff; cursor: pointer; font-weight: 600; font-size: 12px; }
      .quiz-review-view-btn:hover { background: #3a53ef; }
      .quiz-comparison-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
      .quiz-comparison-column { padding: 12px; border-radius: 8px; background: rgba(0,0,0,.02); border: 1px solid rgba(0,0,0,.08); }
      #gemini-ui-panel.dark-mode .quiz-comparison-column { background: rgba(255,255,255,.05); border-color: rgba(255,255,255,.1); }
      .quiz-comparison-column h3 { margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #4a63ff; }
      .quiz-comparison-column.correct h3 { color: #2e7d32; }
      .quiz-review-line { font-size: 12px; color: #666; margin: 4px 0; }
      .quiz-badge { font-size: 11px; padding: 3px 6px; border-radius: 6px; background: rgba(0,0,0,.06); color: #666; margin-right: 4px; }
      .quiz-kicker { font-size: 11px; color: #999; margin-bottom: 4px; }

      /* Flashcard Styles */
      .flashcard-container { display: flex; flex-direction: column; height: 100%; padding: 16px; box-sizing: border-box; overflow-y: auto; }
      .flashcard-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-shrink: 0; }
      .flashcard-counter { font-size: 14px; font-weight: 600; color: #6a1b9a; }
      .flashcard-scene { perspective: 1000px; flex: 0 0 auto; display: flex; align-items: flex-start; justify-content: center; margin: 20px 0; min-height: 320px; }
      .flashcard-card { position: relative; width: 100%; max-width: 500px; min-height: 300px; height: auto; transition: transform 0.6s; transform-style: preserve-3d; cursor: pointer; outline: none; }
      .flashcard-card.flipped { transform: rotateY(180deg); }
      .flashcard-face { position: absolute; top: 0; left: 0; width: 100%; min-height: 300px; backface-visibility: hidden; border-radius: 12px; padding: 24px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 18px; line-height: 1.6; box-shadow: 0 4px 12px rgba(0,0,0,0.1); box-sizing: border-box; }
      .flashcard-face > div { width: 100%; }
      .flashcard-front { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: #fff; }
      .flashcard-back { background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); color: #fff; transform: rotateY(180deg); }
      .flashcard-nav { display: flex; gap: 12px; justify-content: center; margin-top: 20px; flex-wrap: wrap; flex-shrink: 0; }
      .flashcard-btn { padding: 10px 20px; border-radius: 16px; border: 1px solid rgba(0,0,0,.12); background: #fff; color: #333; cursor: pointer; font-weight: 600; font-size: 14px; }
      .flashcard-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .flashcard-btn-primary { background: #6a1b9a; color: #fff; border-color: #6a1b9a; }
      .flashcard-btn-overleaf { background: #228B22; color: #fff; border-color: #228B22; }
      .flashcard-progress { width: 100%; height: 6px; background: rgba(0,0,0,0.08); border-radius: 999px; overflow: hidden; margin-bottom: 16px; flex-shrink: 0; }
      .flashcard-progress-bar { height: 100%; background: #6a1b9a; transition: width .3s ease; }
      .flashcard-exit { text-align: center; margin-top: 20px; flex-shrink: 0; }

      /* Checklist Styles */
      .checklist-container { display: flex; flex-direction: column; height: 100%; padding: 16px; box-sizing: border-box; overflow-y: auto; }
      .checklist-header { margin-bottom: 20px; padding-bottom: 12px; border-bottom: 2px solid rgba(0,0,0,.08); }
      .checklist-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
      .checklist-subtitle { font-size: 14px; color: #666; }
      .checklist-items { flex: 1; }
      .checklist-item { display: flex; align-items: center; gap: 12px; padding: 12px; margin-bottom: 8px; border-radius: 8px; background: rgba(0,0,0,.02); transition: background .2s; }
      .checklist-item:hover { background: rgba(0,0,0,.04); }
      .checklist-item.checked { opacity: 0.6; text-decoration: line-through; }
      .checklist-checkbox { width: 20px; height: 20px; min-width: 20px; cursor: pointer; flex-shrink: 0; }
      .checklist-text { flex: 1; line-height: 1.6; cursor: pointer; }
      .checklist-help-icon { width: 20px; height: 20px; min-width: 20px; cursor: pointer; flex-shrink: 0; font-size: 16px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(66, 133, 244, 0.1); color: #4285f4; transition: all .2s; user-select: none; }
      .checklist-help-icon:hover { background: rgba(66, 133, 244, 0.2); transform: scale(1.1); }
      .checklist-help-icon:active { transform: scale(0.95); }
      .checklist-help-icon.loading { opacity: 0.5; cursor: wait; animation: pulse 1.5s ease-in-out infinite; }
      @keyframes pulse { 0%, 100% { opacity: 0.5; } 50% { opacity: 0.8; } }
      .coverage-info { margin: -4px 0 8px 44px; padding: 12px; background: rgba(66, 133, 244, 0.05); border-left: 3px solid rgba(66, 133, 244, 0.3); border-radius: 4px; font-size: 13px; line-height: 1.5; }
      .coverage-section { margin-bottom: 8px; }
      .coverage-section:last-child { margin-bottom: 0; }
      .coverage-label { font-weight: 600; color: #333; margin-bottom: 4px; }
      .coverage-desc { color: #666; font-size: 12px; }
      .checklist-actions { display: flex; gap: 12px; justify-content: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid rgba(0,0,0,.08); flex-shrink: 0; }

      /* Overleaf Options Page */
      .overleaf-options-container { display: flex; flex-direction: column; height: 100%; padding: 16px; box-sizing: border-box; justify-content: center; align-items: center; }
      .overleaf-options-header { text-align: center; margin-bottom: 40px; }
      .overleaf-options-title { font-size: 20px; font-weight: 700; margin-bottom: 8px; }
      .overleaf-options-subtitle { font-size: 14px; color: #666; }
      .overleaf-options-buttons { display: flex; flex-direction: column; gap: 15px; align-items: center; }
      .overleaf-options-back { margin-top: 40px; }

      /* Summary Extras Drag and Drop */
      .summary-extra-item {
        padding: 8px 12px;
        margin-bottom: 8px;
        background: #fff;
        border: 1px solid rgba(0,0,0,0.1);
        border-radius: 6px;
        cursor: move;
        font-size: 13px;
      }
      #gemini-ui-panel.dark-mode .summary-extra-item {
        background: #1a1a1a !important;
        color: #fff !important;
        border: 1px solid rgba(255,255,255,0.2) !important;
      }
      #gemini-ui-panel.high-contrast .summary-extra-item {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }
      #gemini-ui-panel.dark-mode #summary-selected-extras {
        border: 2px dashed #4a63ff !important;
        background: rgba(74, 99, 255, 0.1) !important;
      }
      #gemini-ui-panel.dark-mode #summary-available-extras {
        border: 2px dashed rgba(255,255,255,0.3) !important;
        background: rgba(255,255,255,0.02) !important;
      }
      #gemini-ui-panel.high-contrast #summary-selected-extras {
        border: 2px dashed #ffff00 !important;
        background: rgba(255, 255, 0, 0.1) !important;
      }
      #gemini-ui-panel.high-contrast #summary-available-extras {
        border: 2px dashed #fff !important;
        background: rgba(255,255,255,0.05) !important;
      }
      #gemini-ui-panel.dark-mode #summary-custom-instructions {
        background: #1a1a1a !important;
        color: #fff !important;
        border: 1px solid rgba(255,255,255,0.2) !important;
      }
      #gemini-ui-panel.high-contrast #summary-custom-instructions {
        background: #000 !important;
        color: #fff !important;
        border: 2px solid #fff !important;
      }

      /* Quiz Generation UI */
      .quiz-generating { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; text-align: center; height: 100%; min-height: 300px; }
      .quiz-gen-spinner { width: 48px; height: 48px; border: 4px solid rgba(0,0,0,.08); border-top-color: #111; border-radius: 50%; animation: gemini-spin 1s linear infinite; margin-bottom: 16px; }
      .quiz-gen-text { font-size: 16px; font-weight: 600; color: #111; margin-bottom: 8px; }
      .quiz-gen-subtext { font-size: 13px; color: #666; }
      #gemini-ui-panel.dark-mode .quiz-gen-text {
        color: #fff;
      }
      #gemini-ui-panel.dark-mode .quiz-gen-subtext {
        color: #aaa;
      }
      #gemini-ui-panel.high-contrast .quiz-gen-text {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .quiz-gen-subtext {
        color: #ffff00 !important;
      }
      #gemini-ui-panel.dark-mode .quiz-generating h3 {
        color: #fff;
      }
      #gemini-ui-panel.high-contrast .quiz-generating h3 {
        color: #ffff00 !important;
      }
      #gemini-ui-panel.dark-mode .quiz-generating div[style*="color: #666"] {
        color: #aaa !important;
      }
      #gemini-ui-panel.high-contrast .quiz-generating div[style*="color: #666"] {
        color: #fff !important;
      }
      #gemini-ui-panel.dark-mode .quiz-generating div[style*="border-top: 1px solid rgba(0,0,0,0.1)"] {
        border-top-color: rgba(255,255,255,0.2) !important;
      }
      #gemini-ui-panel.high-contrast .quiz-generating div[style*="border-top: 1px solid rgba(0,0,0,0.1)"] {
        border-top-color: #fff !important;
      }
      .quiz-generating-status, .flashcard-generating-status, .checklist-generating-status { margin-top: 16px; padding: 12px 20px; border-radius: 8px; background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); font-size: 13px; color: #e65100; max-width: 400px; opacity: 1; transition: opacity 0.5s ease-out; min-height: 44px; }
      .quiz-generating-status.fade-out, .flashcard-generating-status.fade-out, .checklist-generating-status.fade-out { opacity: 0; }
      .quiz-generating-status:empty, .flashcard-generating-status:empty, .checklist-generating-status:empty { display: none; min-height: 0; }
      #gemini-ui-panel.dark-mode .quiz-generating-status, #gemini-ui-panel.dark-mode .flashcard-generating-status, #gemini-ui-panel.dark-mode .checklist-generating-status { background: rgba(255, 152, 0, 0.15); color: #ffb74d; }
      .quiz-gen-stop { margin-top: 24px; padding: 8px 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #b00020; color: #fff; cursor: pointer; font-weight: 600; font-size: 14px; }
      .quiz-hint-btn { padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); background: #f1f4ff; color: #111; cursor: pointer; font-size: 13px; margin-bottom: 12px; }
      .quiz-hint-text { padding: 10px 12px; background: rgba(255, 193, 7, 0.1); border-left: 3px solid #ffc107; border-radius: 6px; margin: 10px 0; font-size: 13px; color: #856404; }

      /* Pro Tip Box */
      .pro-tip-box {
        background: #e3f2fd;
        border-left: 4px solid #2196f3;
      }
      .pro-tip-title {
        color: #1976d2;
      }
      .pro-tip-text {
        color: #1565c0;
      }
      #gemini-ui-panel.dark-mode .pro-tip-box {
        background: rgba(33, 150, 243, 0.15) !important;
        border-left-color: #2196f3 !important;
      }
      #gemini-ui-panel.dark-mode .pro-tip-title {
        color: #64b5f6 !important;
      }
      #gemini-ui-panel.dark-mode .pro-tip-text {
        color: #90caf9 !important;
      }
      #gemini-ui-panel.dark-mode .pro-tip-text strong {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .pro-tip-box {
        background: #000 !important;
        border: 2px solid #ffff00 !important;
        border-left: 4px solid #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .pro-tip-title {
        color: #ffff00 !important;
      }
      #gemini-ui-panel.high-contrast .pro-tip-text {
        color: #fff !important;
      }
      #gemini-ui-panel.high-contrast .pro-tip-text strong {
        color: #ffff00 !important;
      }
      #gemini-ui-panel.dark-mode .quiz-gen-eta {
        color: #aaa !important;
      }
      #gemini-ui-panel.high-contrast .quiz-gen-eta {
        color: #fff !important;
      }
    `;
    document.head.appendChild(style);

    // --- DOM creation
    const toggleBtn = document.createElement("button");
    toggleBtn.id = "gemini-ui-toggle";
    const toggleImg = document.createElement("img");
    toggleImg.src = "https://images2.imgbox.com/fd/6f/pVrle5qi_o.png";
    toggleImg.alt = "LeQture";
    toggleBtn.appendChild(toggleImg);
    document.body.appendChild(toggleBtn);

    // Make toggle button draggable, reset to default position on page load
    let isDragging = false;
    let hasDragged = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    const DRAG_THRESHOLD = 5; // pixels

    // Reset to default position
    toggleBtn.style.right = '20px';
    toggleBtn.style.bottom = '20px';
    toggleBtn.style.left = 'auto';
    toggleBtn.style.top = 'auto';

    toggleBtn.addEventListener('mousedown', (e) => {
      isDragging = true;
      hasDragged = false;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = toggleBtn.getBoundingClientRect();
      dragOffsetX = e.clientX - rect.left;
      dragOffsetY = e.clientY - rect.top;
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;

      const deltaX = Math.abs(e.clientX - dragStartX);
      const deltaY = Math.abs(e.clientY - dragStartY);

      // Only count as drag if moved more than threshold
      if (deltaX > DRAG_THRESHOLD || deltaY > DRAG_THRESHOLD) {
        hasDragged = true;
        toggleBtn.style.cursor = 'grabbing';

        const x = e.clientX - dragOffsetX;
        const y = e.clientY - dragOffsetY;

        // Update position using left/top instead of right/bottom
        toggleBtn.style.left = x + 'px';
        toggleBtn.style.top = y + 'px';
        toggleBtn.style.right = 'auto';
        toggleBtn.style.bottom = 'auto';
      }
    });

    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        toggleBtn.style.cursor = 'pointer';
      }
    });

    const panel = document.createElement("div");
    panel.id = "gemini-ui-panel";
    panel.innerHTML = `
      <div id="gemini-ui-header" title="Drag to move">
        <div id="gemini-slide-badge" class="slide-badge"></div>
        <div id="gemini-ui-header-text" style="display:flex; align-items:center; gap:8px;">
          <img id="gemini-header-logo" src="https://images2.imgbox.com/55/a7/JHxAEuWE_o.png" alt="LeQture" style="height:16px; object-fit:contain;">
          <span id="gemini-header-subtitle">Ask about this slide</span>
        </div>
      </div>

      <div id="gemini-ui-controls">
        <div id="gemini-ui-left">
          <div id="gemini-model-label" style="font-size:12px;">Model:</div>
          <select id="gemini-ui-model">
            <option value="${MODEL_PRO}">Pro</option>
            <option value="${MODEL_FLASH}" selected>Flash</option>
            <option value="${MODEL_FLASHLITE}">Flash Lite</option>
          </select>
        </div>
        <div style="display:flex;gap:8px;">
          <button id="gemini-ui-settings-btn" type="button" title="Settings">⚙</button>
          <button id="gemini-ui-quiz-btn" type="button">Quiz</button>
          <button id="gemini-ui-flashcard-btn" type="button">Flashcards</button>
          <button id="gemini-ui-checklist-btn" type="button">Checklist</button>
          <button id="gemini-ui-summary-btn" type="button">Summary</button>
          <button id="gemini-ui-clear" type="button" title="Clear messages & context"><span class="clear-emoji">🗑️</span></button>
        </div>
      </div>

      <div id="gemini-ui-chat"></div>
      <div id="gemini-attachments"></div>

      <div id="gemini-ui-settings" style="display:none; padding: 20px; overflow-y: auto; flex: 1 1 auto;">
        <div style="margin-bottom: 20px;">
          <div style="font-size:13px; font-weight:600; margin-bottom:8px;">Answer Type:</div>
          <div style="display:flex; gap:12px; margin-bottom:8px;">
            <label style="display:flex; gap:6px; align-items:center; font-size:13px;">
              <input type="radio" name="gemini-at-settings" value="concise" checked> Concise
            </label>
            <label style="display:flex; gap:6px; align-items:center; font-size:13px;">
              <input type="radio" name="gemini-at-settings" value="detailed"> Detailed
            </label>
            <label style="display:flex; gap:6px; align-items:center; font-size:13px;">
              <input type="radio" name="gemini-at-settings" value="custom"> Custom
            </label>
          </div>
          <input type="text" id="gemini-custom-answer-type" placeholder="e.g., bullet points only" style="width:100%; padding:8px; border-radius:6px; border:1px solid rgba(0,0,0,.2); background:#f5f5f5; color:#111; display:none; font-size:13px;">
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:flex; gap:8px; align-items:center; font-size:13px;">
            <input type="checkbox" id="gemini-slidectx-settings" checked>
            <span>Slide-Context</span>
          </label>
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="AI will cite specific timestamps from the audio transcript when answering questions, helping verify information and reduce hallucinations">
            <input type="checkbox" id="gemini-timestamps-settings">
            <span>Timestamp-Linked Citations</span>
          </label>
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:flex; gap:8px; align-items:center; font-size:13px;">
            <span>Theme</span>
            <select id="gemini-theme-select" style="flex:1; padding:4px 8px; border-radius:6px; border:1px solid rgba(0,0,0,.12); background:#fff; font-size:13px;">
              <option value="light">Light</option>
              <option value="default" selected>Default</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="Use AI to intelligently mark text-based quiz answers">
            <input type="checkbox" id="gemini-aimarking-settings" checked>
            <span><b>[Advanced]</b> AI Marking - QUIZ</span>
          </label>
        </div>

        <div style="margin-bottom: 12px;">
          <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="When enabled, automatically determines the best extraction method (Object Detection vs Machine Learning). When disabled, always uses Machine Learning (MinerU).">
            <input type="checkbox" id="gemini-localextraction-settings" checked>
            <span><b>[Advanced]</b> Prefer Object Detection for Image Extraction - Summary</span>
          </label>
        </div>

        <div style="border-top:1px solid rgba(0,0,0,.1); padding-top:20px;">
          <div style="font-size:14px; font-weight:700; margin-bottom:12px;">Accessibility</div>

          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px;">
            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="Increases text size throughout the interface for better readability">
              <input type="checkbox" id="gemini-fontsize-settings">
              <span>Increased Font Size</span>
            </label>

            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="High contrast colors with bold borders for improved visibility">
              <input type="checkbox" id="gemini-highcontrast-settings">
              <span>High Contrast Mode</span>
            </label>

            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" id="translucency-container" title="Adds blur effect to panel background for visual transparency">
              <input type="checkbox" id="gemini-translucency-checkbox" checked>
              <span>Panel Translucency</span>
            </label>

            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="Instructs AI to avoid color-only descriptions, using position and shape instead">
              <input type="checkbox" id="gemini-colorblind-settings">
              <span>Colorblind Mode</span>
            </label>

            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="Disables animations and transitions for motion sensitivity">
              <input type="checkbox" id="gemini-reducedmotion-settings">
              <span>Reduced Motion</span>
            </label>

            <label style="display:flex; gap:8px; align-items:center; font-size:13px;" title="Use arrow keys to navigate through buttons and interactive elements">
              <input type="checkbox" id="gemini-keynav-settings">
              <span>Keyboard Navigation</span>
            </label>
          </div>
        </div>


        <div style="display:flex; gap:8px; margin-top:16px;">
          <button id="gemini-ui-settings-close" style="padding:8px 16px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#111; color:#fff; cursor:pointer;">
            Close Settings
          </button>
          <button id="gemini-ui-settings-reset" style="padding:8px 16px; border-radius:16px; border:1px solid rgba(0,0,0,.12); background:#333; color:#fff; cursor:pointer;">
            Reset to Default
          </button>
        </div>

        <div style="position: absolute; bottom: 20px; right: 20px;">
          <a href="https://www.linkedin.com/in/shlokg" target="_blank" rel="noopener noreferrer" class="settings-credit-link" style="text-decoration: none;">By Shlok G.</a>
        </div>
      </div>

      <div id="gemini-ui-inputrow">
        <button id="gemini-ui-attach" type="button" title="Attach files">+</button>
        <textarea id="gemini-ui-text" placeholder="Type your message…"></textarea>
        <button id="gemini-ui-send"   type="button">Send</button>
        <button id="gemini-ui-stop"   type="button">Stop</button>
        <input id="gemini-file-input" type="file" multiple style="display:none">
      </div>

      <div id="gemini-ui-error"></div>
    `;
    document.body.appendChild(panel);

    // Resize handles
    [
      ["resize-top", "top"], ["resize-bottom", "bottom"],
      ["resize-left", "left"], ["resize-right", "right"],
      ["resize-nw", "nw"], ["resize-ne", "ne"], ["resize-sw", "sw"], ["resize-se", "se"]
    ].forEach(([cls, dir]) => {
      const h = document.createElement("div");
      h.className = `gemini-resizer resize-${dir} ${cls}`;
      h.dataset.dir = dir;
      panel.appendChild(h);
    });

    const chatEl   = panel.querySelector("#gemini-ui-chat");
    const attEl    = panel.querySelector("#gemini-attachments");
    const textEl   = panel.querySelector("#gemini-ui-text");
    const sendEl   = panel.querySelector("#gemini-ui-send");
    const stopEl   = panel.querySelector("#gemini-ui-stop");
    const attachEl = panel.querySelector("#gemini-ui-attach");
    const fileIn   = panel.querySelector("#gemini-file-input");
    const clearEl  = panel.querySelector("#gemini-ui-clear");
    const errEl    = panel.querySelector("#gemini-ui-error");
    const slideBadge = panel.querySelector("#gemini-slide-badge");
    const headerEl = panel.querySelector("#gemini-ui-header");
    const headerTextEl = panel.querySelector("#gemini-ui-header-text");
    const headerLogo = panel.querySelector("#gemini-header-logo");
    const headerSubtitle = panel.querySelector("#gemini-header-subtitle");
    const modelSel = panel.querySelector("#gemini-ui-model");
    const quizBtn = panel.querySelector("#gemini-ui-quiz-btn");
    const flashcardBtn = panel.querySelector("#gemini-ui-flashcard-btn");
    const checklistBtn = panel.querySelector("#gemini-ui-checklist-btn");
    const summaryBtn = panel.querySelector("#gemini-ui-summary-btn");
    const controlsEl = panel.querySelector("#gemini-ui-controls");
    const inputRowEl = panel.querySelector("#gemini-ui-inputrow");
    const settingsBtn = panel.querySelector("#gemini-ui-settings-btn");
    const settingsPanel = panel.querySelector("#gemini-ui-settings");
    const settingsCloseBtn = panel.querySelector("#gemini-ui-settings-close");
    const slideCtxCb = panel.querySelector("#gemini-slidectx-settings");
    const translucencyCb = panel.querySelector("#gemini-translucency-checkbox");
    const themeSelect = panel.querySelector("#gemini-theme-select");
    const settingsResetBtn = panel.querySelector("#gemini-ui-settings-reset");
    const customAnswerInput = panel.querySelector("#gemini-custom-answer-type");
    const timestampsCb = panel.querySelector("#gemini-timestamps-settings");
    const fontSizeCb = panel.querySelector("#gemini-fontsize-settings");
    const highContrastCb = panel.querySelector("#gemini-highcontrast-settings");
    const colorblindCb = panel.querySelector("#gemini-colorblind-settings");
    const reducedMotionCb = panel.querySelector("#gemini-reducedmotion-settings");
    const keyNavCb = panel.querySelector("#gemini-keynav-settings");
    const aiMarkingCb = panel.querySelector("#gemini-aimarking-settings");
    const localExtractionCb = panel.querySelector("#gemini-localextraction-settings");
    const translucencyContainer = panel.querySelector("#translucency-container");

    // Load settings from localStorage
    function loadSettings() {
      try {
        const saved = localStorage.getItem('leqture-settings');
        if (saved) {
          const settings = JSON.parse(saved);

          // Apply general settings
          if (settings.model) { modelSel.value = settings.model; currentModel = settings.model; }
          if (settings.answerMode) {
            answerMode = settings.answerMode;
            const radio = panel.querySelector(`input[name="gemini-at-settings"][value="${settings.answerMode}"]`);
            if (radio) radio.checked = true;
          }
          if (settings.customAnswerType) { customAnswerInput.value = settings.customAnswerType; }
          if (settings.customAnswerType && settings.answerMode === 'custom') { customAnswerInput.style.display = 'block'; }

          slideCtxCb.checked = settings.slideContext !== false;
          slideContextEnabled = slideCtxCb.checked;

          timestampsCb.checked = settings.timestamps || false;
          translucencyCb.checked = settings.translucency !== false;
          themeSelect.value = settings.theme || 'default';

          // Apply accessibility settings
          fontSizeCb.checked = settings.largeFont || false;
          highContrastCb.checked = settings.highContrast || false;
          colorblindCb.checked = settings.colorblind || false;
          reducedMotionCb.checked = settings.reducedMotion || false;
          keyNavCb.checked = settings.keyboardNav || false;

          // Apply quiz settings
          aiMarkingCb.checked = settings.aiMarking !== false;

          // Apply extraction settings (default to true for AUTO MODE)
          localExtractionCb.checked = settings.localExtraction !== false;

          // Trigger effects - use dispatchEvent to ensure all listeners fire
          themeSelect.dispatchEvent(new Event('change'));
          if (translucencyCb.checked) translucencyCb.dispatchEvent(new Event('change'));
          if (fontSizeCb.checked) fontSizeCb.dispatchEvent(new Event('change'));
          if (highContrastCb.checked) highContrastCb.dispatchEvent(new Event('change'));
          if (colorblindCb.checked) colorblindCb.dispatchEvent(new Event('change'));
          if (reducedMotionCb.checked) reducedMotionCb.dispatchEvent(new Event('change'));
          if (keyNavCb.checked) keyNavCb.dispatchEvent(new Event('change'));
        }
      } catch (e) {
        console.warn('Failed to load settings:', e);
      }
    }

    function saveSettings() {
      try {
        const settings = {
          model: currentModel,
          answerMode: answerMode,
          customAnswerType: customAnswerInput.value,
          slideContext: slideCtxCb.checked,
          theme: themeSelect.value,
          timestamps: timestampsCb.checked,
          translucency: translucencyCb.checked,
          largeFont: fontSizeCb.checked,
          highContrast: highContrastCb.checked,
          colorblind: colorblindCb.checked,
          reducedMotion: reducedMotionCb.checked,
          keyboardNav: keyNavCb.checked,
          aiMarking: aiMarkingCb.checked,
          localExtraction: localExtractionCb.checked
        };
        localStorage.setItem('leqture-settings', JSON.stringify(settings));
      } catch (e) {
        console.warn('Failed to save settings:', e);
      }
    }

    // Listeners (set up before loadSettings so they can be triggered)
    modelSel.addEventListener("change", ()=> { currentModel = modelSel.value; saveSettings(); });
    panel.querySelectorAll('input[name="gemini-at-settings"]').forEach(r =>
      r.addEventListener("change", (e) => {
        answerMode = e.target.value;
        customAnswerInput.style.display = e.target.value === "custom" ? "block" : "none";
        saveSettings();
      })
    );
    customAnswerInput.addEventListener("input", saveSettings);
    slideCtxCb.addEventListener("change", () => { slideContextEnabled = !!slideCtxCb.checked; saveSettings(); });
    timestampsCb.addEventListener("change", saveSettings);

    // Accessibility listeners
    fontSizeCb.addEventListener("change", () => {
      if (fontSizeCb.checked) {
        panel.classList.add('large-font');
      } else {
        panel.classList.remove('large-font');
      }
      saveSettings();
    });

    highContrastCb.addEventListener("change", () => {
      if (highContrastCb.checked) {
        panel.classList.add('high-contrast');
        headerLogo.style.filter = "brightness(1.85)";
        // Disable and grey out translucency
        translucencyCb.disabled = true;
        translucencyContainer.style.opacity = '0.5';
        translucencyContainer.style.pointerEvents = 'none';
      } else {
        panel.classList.remove('high-contrast');
        // Reset logo filter based on current theme
        const theme = themeSelect.value;
        if (theme === 'dark') {
          headerLogo.style.filter = "brightness(1.85)";
        } else {
          headerLogo.style.filter = "";
        }
        // Re-enable translucency
        translucencyCb.disabled = false;
        translucencyContainer.style.opacity = '1';
        translucencyContainer.style.pointerEvents = '';
      }
      saveSettings();
    });

    colorblindCb.addEventListener("change", saveSettings);

    reducedMotionCb.addEventListener("change", () => {
      if (reducedMotionCb.checked) {
        panel.classList.add('reduced-motion');
      } else {
        panel.classList.remove('reduced-motion');
      }
      saveSettings();
    });

    // AI Marking checkbox listener
    aiMarkingCb.addEventListener("change", saveSettings);

    // Local Extraction checkbox listener
    localExtractionCb.addEventListener("change", saveSettings);

    // Translucency checkbox toggle
    translucencyCb.addEventListener("change", () => {
      applyThemeAndTranslucency();
      saveSettings();
    });

    // Theme select toggle
    themeSelect.addEventListener("change", () => {
      applyThemeAndTranslucency();
      saveSettings();
    });

    // Function to apply theme and translucency together
    function applyThemeAndTranslucency() {
      const theme = themeSelect.value;
      const translucent = translucencyCb.checked;
      const isHighContrast = highContrastCb.checked;

      // Remove all theme classes first
      panel.classList.remove('dark-mode', 'default-theme');
      toggleBtn.classList.remove('dark-mode');

      if (theme === 'dark' || isHighContrast) {
        headerLogo.style.filter = "brightness(1.85)";
      } else {
        headerLogo.style.filter = "";
      }

      if (theme === 'dark') {
        panel.classList.add('dark-mode');
        toggleBtn.classList.add('dark-mode');
        if (translucent) {
          panel.style.backdropFilter = "blur(7px)";
          panel.style.backgroundColor = "rgba(0, 0, 0, 0.65)";
        } else {
          panel.style.backdropFilter = "none";
          panel.style.backgroundColor = "#000000";
        }
      } else if (theme === 'light') {
        if (translucent) {
          panel.style.backdropFilter = "blur(8px)";
          panel.style.backgroundColor = "rgba(255, 255, 255, 0.59)";
        } else {
          panel.style.backdropFilter = "none";
          panel.style.backgroundColor = "#fff";
        }
      } else if (theme === 'default') {
        panel.classList.add('default-theme');
        if (translucent) {
          panel.style.backdropFilter = "blur(8px)";
          panel.style.backgroundColor = "rgba(213, 0, 108, 0.7)";
        } else {
          panel.style.backdropFilter = "none";
          panel.style.backgroundColor = "rgb(213, 0, 108)";
        }
      }
    }

    // Settings panel toggle
    settingsBtn.addEventListener("click", () => {
      chatEl.style.display = "none";
      attEl.style.display = "none";
      controlsEl.style.display = "none";
      inputRowEl.style.display = "none";
      settingsPanel.style.display = "block";
      updateHeaderSubtitle('Settings');
    });

    settingsCloseBtn.addEventListener("click", () => {
      settingsPanel.style.display = "none";
      chatEl.style.display = "";
      attEl.style.display = "";
      controlsEl.style.display = "";
      inputRowEl.style.display = "";
      updateHeaderSubtitle('Ask about this slide');
    });


    // Reset to default settings
    settingsResetBtn.addEventListener("click", () => {
      // Reset answer type
      panel.querySelector('input[name="gemini-at-settings"][value="concise"]').checked = true;
      answerMode = "concise";
      customAnswerInput.style.display = "none";
      customAnswerInput.value = "";

      // Reset slide context
      slideCtxCb.checked = true;
      slideContextEnabled = true;

      // Reset theme and translucency
      themeSelect.value = 'default';
      translucencyCb.checked = true;
      applyThemeAndTranslucency();

      // Reset accessibility
      fontSizeCb.checked = false;
      panel.classList.remove('large-font');
      highContrastCb.checked = false;
      panel.classList.remove('high-contrast');
      colorblindCb.checked = false;
      reducedMotionCb.checked = false;
      panel.classList.remove('reduced-motion');
      keyNavCb.checked = false;
      keyNavEnabled = false;
      clearKeyboardFocus();
      currentFocusIndex = -1;

      // Reset model
      modelSel.value = MODEL_FLASH;
      currentModel = MODEL_FLASH;

      saveSettings();
    });

    // Apply initial theme and translucency (default pink mode)
    applyThemeAndTranslucency();

    // Keyboard navigation support
    let keyNavEnabled = false;
    let currentFocusIndex = -1;
    let focusableElements = [];

    function updateFocusableElements() {
      focusableElements = Array.from(panel.querySelectorAll(
        'button:not([disabled]), input:not([tabindex="-1"]), textarea, select, [tabindex="0"]'
      )).filter(el => el.offsetParent !== null); // Only visible elements
    }

    function clearKeyboardFocus() {
      focusableElements.forEach(el => {
        el.classList.remove('keyboard-focus');
        // Also remove dropzone highlight when moving away
        if (el.classList.contains('quiz-dropzone')) {
          el.classList.remove('highlight-for-drop');
        }
      });
    }

    function setKeyboardFocus(index) {
      clearKeyboardFocus();
      if (index >= 0 && index < focusableElements.length) {
        currentFocusIndex = index;
        const targetElement = focusableElements[index];

        // Blur any active input/textarea to prevent Enter from submitting
        if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
          console.log('[Keyboard Nav] Blurring input/textarea:', document.activeElement.tagName);
          document.activeElement.blur();
        }

        targetElement.classList.add('keyboard-focus');

        // If navigating to a dropzone and a chip is selected, highlight this dropzone
        if (targetElement.classList.contains('quiz-dropzone') && selectedChipForKeyboard) {
          targetElement.classList.add('highlight-for-drop');
        }

        targetElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    keyNavCb.addEventListener("change", () => {
      keyNavEnabled = keyNavCb.checked;
      if (!keyNavEnabled) {
        clearKeyboardFocus();
        currentFocusIndex = -1;
      }
      saveSettings();
    });

    // Make all interactive elements keyboard accessible
    [sendEl, stopEl, attachEl, clearEl, quizBtn, settingsBtn, settingsCloseBtn, settingsResetBtn].forEach((btn) => {
      if (btn) {
        btn.setAttribute('tabindex', '0');
        btn.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            btn.click();
          }
        });
      }
    });

    // Preserve keyboard navigation when clicking on non-button areas
    panel.addEventListener('mousedown', (e) => {
      // Don't interfere with resize handles or header drag
      const isResizer = e.target.classList.contains('gemini-resizer') ||
                        e.target.closest('.gemini-resizer');
      const isHeader = e.target.closest('#gemini-ui-header');

      if (isResizer || isHeader) {
        console.log('[Mousedown] Allowing:', isResizer ? 'resizer' : 'header');
        return;
      }

      if (keyNavEnabled) {
        const target = e.target;
        const isFocusable = target.matches('button:not([disabled]), input, textarea, select, [tabindex="0"]');

        // If clicking on a non-focusable area, prevent default focus behavior
        // and maintain keyboard navigation state
        if (!isFocusable) {
          e.preventDefault();
          // Keep current keyboard focus if there is one
          if (currentFocusIndex >= 0 && focusableElements[currentFocusIndex]) {
            focusableElements[currentFocusIndex].classList.add('keyboard-focus');
          }
        }
      }
    }); // Bubble phase is fine since resize handlers use capture

    // Load settings after all listeners are set up
    loadSettings();

    // Global keyboard shortcuts and arrow navigation
    document.addEventListener('keydown', (e) => {
      console.log('[Keyboard Nav] Key pressed:', e.key, 'keyNavEnabled:', keyNavEnabled, 'activeElement:', document.activeElement?.tagName);

      // Panel-specific shortcuts (only when panel is open)
      if (panel.style.display !== 'none') {
        // Escape to close settings or quiz
        if (e.key === 'Escape') {
          if (settingsPanel.style.display === 'block') {
            settingsCloseBtn.click();
          } else if (quizMode) {
            const exitBtn = panel.querySelector('.quiz-btn-secondary');
            if (exitBtn) exitBtn.click();
          }
          return;
        }

        // Arrow key navigation (only if enabled)
        if (keyNavEnabled) {
          const activeEl = document.activeElement;
          const isTyping = ['INPUT', 'TEXTAREA'].includes(activeEl?.tagName);
          const isSelect = activeEl?.tagName === 'SELECT';
          const isQuizElement = activeEl?.classList.contains('quiz-chip') ||
                                activeEl?.classList.contains('quiz-dropzone') ||
                                activeEl?.classList.contains('quiz-sequence-item') ||
                                isSelect;

          console.log('[Keyboard Nav] Key:', e.key, 'Shift:', e.shiftKey, 'isTyping:', isTyping, 'isQuizElement:', isQuizElement, 'currentFocusIndex:', currentFocusIndex);

          // Special handling for selected ordering item
          if (selectedOrderItemForKeyboard && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            e.stopPropagation();
            console.log('[Quiz Keyboard] Moving sequence item:', e.key);

            const ul = selectedOrderItemForKeyboard.parentElement;
            const items = Array.from(ul.children);
            const currentIndex = items.indexOf(selectedOrderItemForKeyboard);

            if (e.key === 'ArrowUp' && currentIndex > 0) {
              ul.insertBefore(selectedOrderItemForKeyboard, items[currentIndex - 1]);
            } else if (e.key === 'ArrowDown' && currentIndex < items.length - 1) {
              ul.insertBefore(items[currentIndex + 1], selectedOrderItemForKeyboard);
            }
            return;
          }

          // Skip global navigation if focused on quiz elements that need arrow keys
          if (isQuizElement && ['ArrowUp', 'ArrowDown', 'Enter'].includes(e.key)) {
            console.log('[Keyboard Nav] Skipping - quiz element needs this key');
            return;
          }

          // Allow Shift + Arrow to force navigation even when typing
          const forceNavigation = e.shiftKey && ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key);

          // Navigate if: (1) NOT typing, OR (2) Shift + Arrow key pressed
          if (!isTyping || forceNavigation) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
              e.preventDefault();
              updateFocusableElements();
              console.log('[Keyboard Nav] Moving DOWN/RIGHT. Total focusable elements:', focusableElements.length);
              const newIndex = currentFocusIndex < 0 ? 0 : (currentFocusIndex + 1) % focusableElements.length;
              setKeyboardFocus(newIndex);
              console.log('[Keyboard Nav] New focus index:', newIndex, 'Element:', focusableElements[newIndex]?.tagName);
            } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
              e.preventDefault();
              updateFocusableElements();
              console.log('[Keyboard Nav] Moving UP/LEFT. Total focusable elements:', focusableElements.length);
              const newIndex = currentFocusIndex < 0 ? focusableElements.length - 1 : (currentFocusIndex - 1 + focusableElements.length) % focusableElements.length;
              setKeyboardFocus(newIndex);
              console.log('[Keyboard Nav] New focus index:', newIndex, 'Element:', focusableElements[newIndex]?.tagName);
            } else if (e.key === 'Enter' && currentFocusIndex >= 0) {
              const el = focusableElements[currentFocusIndex];
              console.log('[Keyboard Nav] Enter pressed on element:', el?.tagName, el?.className);

              // Check if this is a quiz element that needs special handling
              if (el.classList.contains('quiz-chip')) {
                e.preventDefault();
                console.log('[Keyboard Nav] Triggering chip selection');
                // Manually trigger chip selection
                if (selectedChipForKeyboard) {
                  selectedChipForKeyboard.classList.remove('kb-selected');
                }
                selectedChipForKeyboard = el;
                el.classList.add('kb-selected');
                return;
              } else if (el.classList.contains('quiz-dropzone')) {
                e.preventDefault();
                console.log('[Keyboard Nav] Triggering dropzone action');
                // If there's a selected chip, place it
                if (selectedChipForKeyboard) {
                  const bank = document.querySelector('#quiz-word-bank');
                  if (el.firstElementChild) {
                    bank.appendChild(el.firstElementChild);
                  }
                  el.appendChild(selectedChipForKeyboard);
                  selectedChipForKeyboard.dataset.src = 'dz';
                  selectedChipForKeyboard.classList.remove('kb-selected');
                  selectedChipForKeyboard = null;
                  // Highlight will be removed automatically when navigating away
                }
                return;
              } else if (el.classList.contains('quiz-sequence-item')) {
                e.preventDefault();
                console.log('[Keyboard Nav] Triggering sequence item selection');
                // Toggle selection for ordering
                if (selectedOrderItemForKeyboard === el) {
                  console.log('[Quiz Keyboard] Releasing sequence item');
                  el.classList.remove('kb-selected');
                  selectedOrderItemForKeyboard = null;
                } else {
                  console.log('[Quiz Keyboard] Selecting sequence item for reordering');
                  if (selectedOrderItemForKeyboard) {
                    selectedOrderItemForKeyboard.classList.remove('kb-selected');
                  }
                  selectedOrderItemForKeyboard = el;
                  el.classList.add('kb-selected');
                }
                return;
              } else if (el.tagName === 'SELECT') {
                console.log('[Keyboard Nav] Focusing select element');
                el.focus();
                return;
              }

              e.preventDefault();
              if (el.tagName === 'BUTTON') {
                el.click();
              } else if (el.tagName === 'LABEL' && el.classList.contains('quiz-option')) {
                // Handle quiz option labels (radio/checkbox)
                const input = el.querySelector('input[type="radio"], input[type="checkbox"]');
                if (input) {
                  if (input.type === 'radio') {
                    input.checked = true;
                  } else if (input.type === 'checkbox') {
                    input.checked = !input.checked;
                  }
                  input.dispatchEvent(new Event('change', { bubbles: true }));
                }
              } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                el.focus();
              }
            }
          } else {
            console.log('[Keyboard Nav] Skipping arrow key handling - user is typing in input/textarea');
          }
        }
      }
    });

    // ===== FIXED: Panel show/hide with proper CSS reset =====
    function showPanel(open = true) {
      if (open) {
        // Calculate viewport-constrained dimensions
        const vpW = document.documentElement.clientWidth;
        const vpH = document.documentElement.clientHeight;
        const w = Math.min(savedW, vpW - 40);
        const h = Math.min(savedH, vpH - 100);

        // CRITICAL: Clear ALL positioning properties first
        panel.style.left = "";
        panel.style.top = "";
        panel.style.right = "";
        panel.style.bottom = "";
        panel.style.width = "";
        panel.style.height = "";
        panel.style.minWidth = "";
        panel.style.maxWidth = "";
        panel.style.minHeight = "";
        panel.style.maxHeight = "";

        // Now set fresh anchor-based positioning
        panel.style.display = "flex";
        panel.style.right = "20px";
        panel.style.bottom = "90px";
        panel.style.width = w + "px";
        panel.style.height = h + "px";

        // Trigger animation
        setTimeout(() => panel.classList.add('panel-visible'), 10);
        panel.style.minWidth = PANEL_MIN_W + "px";
        panel.style.maxWidth = "calc(100vw - 40px)";
        panel.style.minHeight = PANEL_MIN_H + "px";
        panel.style.maxHeight = "calc(100vh - 100px)";

        setTimeout(() => {
          textEl.focus();
          keepScrolledToBottom();
        }, 50);
      } else {
        // Save current dimensions before hiding
        const rect = panel.getBoundingClientRect();
        savedW = Math.max(PANEL_MIN_W, rect.width);
        savedH = Math.max(PANEL_MIN_H, rect.height);
        panel.classList.remove('panel-visible');
        setTimeout(() => panel.style.display = "none", 200);
      }
    }

    function showHeaderSpinner(on){ /* Spinner removed */ }
    function setError(msg){
      if (!msg) {
        errEl.innerHTML = "";
        errEl.style.display = "none";
        return;
      }

      // Check if error contains HTTP 503 and customize message
      if (msg.includes('HTTP 503') || msg.includes('503')) {
        msg = "⚠️ Model is currently overloaded. Please try again in a few moments.";
      }

      // Create error message with X button
      errEl.innerHTML = `
        <span style="flex: 1;">${msg}</span>
        <button onclick="this.parentElement.style.display='none'" style="
          background: none;
          border: none;
          color: inherit;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
          padding: 0 4px;
          margin-left: 8px;
          opacity: 0.7;
          transition: opacity 0.2s;
        " onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">✕</button>
      `;
      errEl.style.display = "flex";
      errEl.style.alignItems = "center";
      errEl.style.justifyContent = "space-between";
    }
    function setThinkingState(on){
      isThinking = !!on;
      sendEl.disabled = !!on;
      stopEl.style.display = on ? "inline-block" : "none";
      if (!on) { showHeaderSpinner(false); }
    }
    function keepScrolledToBottom(){ chatEl.scrollTop = chatEl.scrollHeight; }
    new ResizeObserver(() => keepScrolledToBottom()).observe(panel);

    function appendMessage(role, text) {
      const wrap = document.createElement("div");
      wrap.className = "gemini-msg" + (role === "me" ? " gemini-me" : "");
      const bubble = document.createElement("div");
      bubble.className = "gemini-bubble" + (role === "me" ? " me" : "");
      if (role === "me") {
        bubble.textContent = text;
      } else {
        bubble.innerHTML = renderMarkdown(text);
        typesetEl(bubble);
      }
      wrap.appendChild(bubble);
      chatEl.appendChild(wrap);
      keepScrolledToBottom();
      return bubble;
    }
    function appendPendingBubble(isInitializing = false) {
      const wrap = document.createElement("div");
      wrap.className = "gemini-msg";
      const bubble = document.createElement("div");
      bubble.className = "gemini-bubble" + (isInitializing ? " initialising" : "");
      bubble.setAttribute("data-pending", "1");
      const text = isInitializing ? "Initialising…" : "Thinking…";
      bubble.innerHTML = `<span class="gemini-inline-spinner"></span><span style="margin-left:6px;">${text}</span>`;
      wrap.appendChild(bubble);
      chatEl.appendChild(wrap);
      keepScrolledToBottom();
      return bubble;
    }

    function updatePendingBubbleText(bubble, text) {
      let target = bubble;
      if (!target || !target.isConnected || !target.getAttribute("data-pending")) {
        target = findActivePendingBubble();
        if (target) lastPendingBubble = target;
      }
      if (target && target.isConnected && target.getAttribute("data-pending")) {
        if (text === "Thinking…") {
          target.classList.remove("initialising");
        }
        target.innerHTML = `<span class="gemini-inline-spinner"></span><span style="margin-left:6px;">${text}</span>`;
      }
    }
    function resolvePendingBubble(bubble, textHtml) {
      let target = bubble;
      if (!target || !target.isConnected) {
        target = findActivePendingBubble();
        if (target) lastPendingBubble = target;
      }

      if (target && target.isConnected) {
        target.removeAttribute("data-pending");
        target.classList.remove("initialising"); // Remove yellow/orange styling
        target.innerHTML = textHtml;
        typesetEl(target);
        lastPendingBubble = null;
      } else if (chatEl) {
        const wrapper = document.createElement("div");
        wrapper.className = "gemini-msg";
        const newBubble = document.createElement("div");
        newBubble.className = "gemini-bubble";
        newBubble.innerHTML = textHtml;
        wrapper.appendChild(newBubble);
        chatEl.appendChild(wrapper);
        typesetEl(newBubble);
      }

      keepScrolledToBottom();
    }
    function cancelThinkingUI(bubble, reason){
      if (retryTimeoutId){ clearTimeout(retryTimeoutId); retryTimeoutId = null; }
      if (retryIntervalId){ clearInterval(retryIntervalId); retryIntervalId = null; }
      if (inFlightAbort){ try { inFlightAbort.abort(); } catch {} inFlightAbort = null; }
      if (bubble?.getAttribute("data-pending")) {
        bubble.removeAttribute("data-pending");
        bubble.innerHTML = renderMarkdown(`_Cancelled${reason?": "+escapeHtml(reason):""}._`);
      }
      setThinkingState(false);
    }

    // ===== REBUILT: Toggle handler with Shift+Triple-click to clear PDF URL =====
    let toggleClickCount = 0;
    let toggleClickTimer = null;
    let uploadPromptAttempts = 0; // Track how many times we've asked about upload

    toggleBtn.addEventListener("click", async (e) => {
      // Don't toggle if user was dragging
      if (hasDragged) {
        hasDragged = false;
        return;
      }

      // Check for Shift+Triple-click to clear PDF URL
      if (e.shiftKey) {
        toggleClickCount++;

        if (toggleClickCount === 1) {
          // Start timer for triple-click detection (1 second window)
          toggleClickTimer = setTimeout(() => {
            toggleClickCount = 0;
          }, 1000);
        } else if (toggleClickCount === 3) {
          // Triple-click with Shift detected
          clearTimeout(toggleClickTimer);
          toggleClickCount = 0;

          const currentPdfUrl = getPdfUrlForCurrentPage();
          const urlDisplay = currentPdfUrl ? `\nCurrent URL: ${currentPdfUrl}\n` : "\nNo URL stored for this page.\n";

          const confirmed = confirm(
            "Clear PDF URL for this page and reload?\n" +
            urlDisplay +
            "\nYou will be prompted to enter a new PDF URL."
          );

          if (confirmed) {
            clearPdfUrlForCurrentPage();
            console.log('[PDF STATUS] PDF URL cleared by user (Shift+Triple-click)');
            window.location.reload();
          }
          return;
        }
      } else {
        // Reset click count if shift not held
        toggleClickCount = 0;
        if (toggleClickTimer) clearTimeout(toggleClickTimer);
      }

      // Check if PDF is available - only prompt twice (skip for YouTube)
      if (pdfUrlStatus === 'no_pdf' && uploadPromptAttempts < 2 && !isYouTubePage()) {
        uploadPromptAttempts++;
        console.log(`[PDF STATUS] Upload prompt attempt ${uploadPromptAttempts}/2`);

        const userChoice = confirm(
          "No PDF slides URL was provided.\n\n" +
          "Would you like to upload a PDF file instead? (Note: Images for Summary Generation requires a URL.)\n\n" +
          "Click OK to upload a file, or Cancel to continue without slides.\n\n" +
          "(To enter a URL instead, reload the page)"
        );

        if (userChoice) {
          const pdfFile = await handlePdfFileUpload();
          if (pdfFile) {
            // Upload the file to Gemini immediately
            try {
              await waitForApiKey();
              uploadedPdfUri = await uploadFileToGemini(pdfFile, "lecture-slides.pdf");
              console.log('[PDF STATUS] File uploaded to AI:', uploadedPdfUri);
              // Reset attempt counter on successful upload
              uploadPromptAttempts = 0;
              // Update header to remove NO SLIDE FOUND warning
              updateHeaderSubtitle('Ask about this slide');
            } catch (e) {
              console.error('[PDF STATUS] Failed to upload file:', e);
              alert('Failed to upload PDF file. Please try again.');
              return;
            }
          } else {
            // User cancelled file upload, update header to show NO SLIDE FOUND
            updateHeaderSubtitle('Ask about this slide');
          }
        } else {
          // User cancelled the confirm dialog, update header to show NO SLIDE FOUND
          updateHeaderSubtitle('Ask about this slide');
        }
      }

      const isCurrentlyOpen = panel.style.display === "flex" || panel.style.display === "block";

      // For YouTube: Initialize files on first toggle click (lazy loading) - non-blocking
      if (isYouTubePage() && !isCurrentlyOpen && !filesInitialized && !filesInitializing) {
        console.log("[YouTube] First toggle click - initializing files in background");
        // Start initialization in background (don't await - let panel open immediately)
        (async () => {
          try {
            await waitForApiKey();
            await initializeFiles(null);
            console.log("[YouTube] Files initialized successfully");
          } catch (e) {
            console.error("[YouTube] Failed to initialize files:", e);
          }
        })();
      }

      // Open panel immediately (don't wait for file initialization)
      showPanel(!isCurrentlyOpen);
    });

    clearEl.addEventListener("click", () => {
      chatEl.innerHTML = "";
      history.length = 0;
      slideGroups.length = 0;
      currentGroupId = null;
      setError(""); lastPendingBubble = null;
      savedChatContent = '';
      resetAttachmentsUI();

      // Exit quiz/flashcard/checklist modes if active, but keep the data
      if (quizMode) {
        quizMode = false;
        quizBtn.style.display = '';
      }
      if (flashcardMode) {
        flashcardMode = false;
        flashcardBtn.style.display = '';
      }
      if (checklistMode) {
        checklistMode = false;
        checklistBtn.style.display = '';
      }

      // Show normal UI
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
    });

    // ===== Attachments =====
    function resetAttachmentsUI(){ pendingAttachments.length = 0; renderAttachmentChips(); }
    attachEl.addEventListener("click", () => fileIn.click());
    fileIn.addEventListener("change", (e) => { handleFiles([...e.target.files]); fileIn.value = ""; });

    textEl.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const files = items.map(it=> it.getAsFile?.()).filter(Boolean);
      if (files.length) { e.preventDefault(); handleFiles(files); }
    });

    ["dragenter","dragover"].forEach(evt =>
      panel.addEventListener(evt, (e)=>{ e.preventDefault(); e.dataTransfer.dropEffect="copy"; })
    );
    panel.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) handleFiles(files);
    });

    function handleFiles(files){
      files.forEach(file=>{
        if (!file) return;
        const att = {
          kind: file.type.startsWith("image/") ? "image" : "file",
          name: file.name || (file.type.startsWith("image/") ? "image" : "file"),
          blob: file,
          mime: file.type || (file.type.startsWith("image/") ? "image/png" : "application/octet-stream"),
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : "",
          status: "pending", fileUri: null
        };
        pendingAttachments.push(att);
        renderAttachmentChips();
        processAttachmentUpload(att);
      });
    }

    async function processAttachmentUpload(att){
      try{
        att.status = "uploading"; renderAttachmentChips();
        await waitForApiKey();
        const uri = await uploadFileToGemini(att.blob, att.name || "attachment");
        if (uri) { att.fileUri = uri; att.status = "uploaded"; }
        else { att.status = "failed"; }
      } catch(e){ att.status = "failed"; console.warn("Attachment upload failed:", e); }
      renderAttachmentChips();
    }

    function renderAttachmentChips(){
      attEl.innerHTML = "";
      for (let i=0;i<pendingAttachments.length;i++){
        const a = pendingAttachments[i];
        const chip = document.createElement("div");
        chip.className = "gem-chip";
        if (a.kind === "image" && a.previewUrl) {
          const img = document.createElement("img");
          img.src = a.previewUrl; chip.appendChild(img);
        }
        const span = document.createElement("span");
        span.textContent = a.name;
        chip.appendChild(span);

        const st = document.createElement("span");
        st.className = "chip-status";
        if (a.status === "pending") st.textContent = " • waiting";
        else if (a.status === "uploading") st.innerHTML = ' • <span class="gemini-inline-spinner"></span> uploading…';
        else if (a.status === "uploaded") { st.innerHTML = ' • <span class="chip-ok">uploaded ✓</span>'; }
        else if (a.status === "failed") { st.innerHTML = ' • <span class="chip-fail">failed</span>'; }
        chip.appendChild(st);

        const x = document.createElement("button");
        x.textContent = "×";
        x.onclick = ()=>{ pendingAttachments.splice(i,1); renderAttachmentChips(); };
        chip.appendChild(x);
        attEl.appendChild(chip);
      }
    }

    // ===== Sending =====
    function submitFromUI() {
      if (isThinking) return;
      const q = textEl.value.trim();
      if (!q) return;
      setError("");
      appendMessage("me", q);
      history.push({ role: "user", text: q });

      lastUserMsgForRetry = q;
      // Show "Initialising" if files not ready, otherwise "Thinking"
      lastPendingBubble = appendPendingBubble(!filesInitialized);

      textEl.value = "";
      setThinkingState(true);
      sendFollowUp(q, lastPendingBubble).catch(e => {
        setError("Failed to send: " + (e?.message || e));
        resolvePendingBubble(lastPendingBubble, renderMarkdown("_Failed to send._"));
        setThinkingState(false);
      });
    }
    sendEl.addEventListener("click", submitFromUI);
    textEl.addEventListener("keydown", (e) => {
      if (e.altKey) return;
      if (e.key.toLowerCase() === "enter" && !e.shiftKey) {
        if (!isThinking) submitFromUI();
        e.preventDefault();
      }
    });

    function extractExplanation(data) {
      try {
        const c = data && data.candidates && data.candidates[0];
        if (!c || !c.content || !Array.isArray(c.content.parts)) return null;
        const parts = c.content.parts;
        // Prefer the first text part
        const textPart = parts.find(p => typeof p.text === 'string');
        if (textPart && textPart.text) return textPart.text;
        // Fallback: concatenate any string fragments
        const joined = parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('\n').trim();
        return joined || null;
      } catch (e) {
        console.warn('[extractExplanation] Failed to extract text:', e);
        return null;
      }
    }
    function parseRetryMsFromErrorMessage(msg){
      const m = /retry in ([\d.]+)s/i.exec(msg || "");
      if (m) {
        const ms = Math.max(5000, Math.round(parseFloat(m[1]) * 1000));
        return Number.isFinite(ms) ? ms : 5000;
      }
      return 5000;
    }

    async function selectSlideGroupUsingOCR(freshB64) {
      if (!freshB64) return { group: null, simPct: NaN, changed: false };
      await ensureTesseract();
      const currText = await ocrFromBase64(freshB64);

      console.log("[Slide Context] OCR extracted text:", currText.substring(0, 100) + "...");

      let matched = null, simPct = NaN;
      if (slideGroups.length) {
        const found = findBestGroupByText(currText);
        matched = (found.sim >= SIM_THRESHOLD) ? found.group : null;
        simPct = found.sim;
        console.log(`[Slide Context] Matching against ${slideGroups.length} existing groups. Best match similarity: ${simPct.toFixed(2)}%, threshold: ${SIM_THRESHOLD}%`);
        if (matched) {
          console.log("[Slide Context] Match found! Using existing group:", matched.id);
        } else {
          console.log("[Slide Context] No match above threshold. Creating new group.");
        }
      } else {
        console.log("[Slide Context] No existing groups. Creating first group.");
      }

      const group = matched || createGroup(currText);
      const changed = currentGroupId && group.id !== currentGroupId;
      if (changed) {
        console.group("[Slide Context] Slide Changed");
        console.log("Previous group ID:", currentGroupId);
        console.log("New group ID:", group.id);
        console.log("Action:", matched ? "Matched existing group" : "Created new group");
        console.log("Group details:", {
          id: group.id,
          ocrText: group.ocrText?.substring(0, 100) + (group.ocrText?.length > 100 ? "..." : ""),
          messageCount: group.messages?.length || 0
        });
        console.log("Total groups:", slideGroups.length);
        console.groupEnd();
        showSlideChangedBadge();
      }

      currentGroupId = group.id;
      console.log(`[Slide Context] Current group: ${group.id}, Total groups: ${slideGroups.length}`);
      return { group, simPct, changed };
    }

    function answerDirective() {
      if (answerMode === "detailed") return "Respond in detail with comprehensive explanations.";
      if (answerMode === "custom") return customAnswerInput.value.trim() || "Keep answers short and direct.";
      return "Keep answers SHORT and DIRECT. Maximum 2-3 sentences unless complex explanation required.";
    }
    // buildSystemGuardrails function removed - now fetched from backend via buildSystemGuardrailsFromBackend()
    function messagesToContents(messages) {
      return (messages || []).map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.text }]
      }));
    }
    async function getNearFrameTranscript() {
      // YouTube implementation (Step 3)
      if (isYouTubePage()) {
        try {
          const videoId = getYouTubeVideoId();
          if (!videoId) {
            console.error('[YouTube] Could not extract video ID');
            return "";
          }

          // Ensure we have the complete transcript UUID
          if (!youtubeTranscriptUUID) {
            // Fetch complete transcript if not already fetched
            if (!youtubeTranscriptPromise) {
              youtubeTranscriptPromise = fetchYouTubeCompleteTranscript(videoId);
            }
            const completeData = await youtubeTranscriptPromise;

            // Check if transcript is available
            if (!completeData.available || !completeData.uuid) {
              console.log('[YouTube] No transcript available - skipping nearframe transcript');
              return "";
            }

            youtubeTranscriptUUID = completeData.uuid;
          }

          // Only fetch nearframe if we have a UUID
          if (!youtubeTranscriptUUID) {
            return "";
          }

          // Get current timestamp
          const currentTime = getYouTubeCurrentTime();

          // Fetch nearframe transcript
          const nearframeData = await fetchYouTubeNearframeTranscript(youtubeTranscriptUUID, currentTime);
          return nearframeData.nearframe || "";

        } catch (e) {
          console.warn("[YouTube] Failed to get nearframe transcript - continuing without it:", e);
          return "";
        }
      }

      // Echo360 implementation (original)
      try {
        const container = document.querySelector('.ReactVirtualized__Grid__innerScrollContainer');
        if (!container) return "";

        const transcriptText = container.innerText;
        if (!transcriptText) return "";

        return transcriptText.trim();
      } catch (e) {
        console.error("Failed to extract near-frame transcript:", e);
        return "";
      }
    }
    async function buildSystemGuardrailsFromBackend() {
      // Fetch system guardrails from backend
      const response = await fetch('http://localhost:5000/api/prompts/system-guardrails', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answerMode: answerMode,
          colorblindMode: colorblindCb.checked,
          customInstruction: answerMode === "custom" ? customAnswerInput.value.trim() : null
        })
      });
      const data = await response.json();
      return data.guardrails;
    }

    async function buildChatBody({ userMsg, freshB64, contextMessages, slideDirective }) {
      const timestampInstruction = timestampsCb.checked
        ? "IMPORTANT: When citing information from the lecture audio transcript, you MUST reference specific timestamps (e.g., 'At 3:45, the professor states...' or 'Around 12:30, it was mentioned that...'). This helps verify claims and reduces hallucinations. Always cite timestamps when possible."
        : "";

      // Fetch guardrails from backend
      const guardrails = await buildSystemGuardrailsFromBackend();

      const systemText = [
        guardrails,
        "",
        answerDirective(),
        DEICTIC_NOTE,
        timestampInstruction,
        slideDirective || "",
        "Attachments included in THIS user turn are PRIORITY for answering the CURRENT question."
      ].filter(s => s).join("\n");

      // Extract near-frame transcript context
      const nearFrameTranscript = await getNearFrameTranscript();

      // Build the current user message with context
      let currentQuestionText = `CURRENT QUESTION (PRIORITY): ${userMsg}`;

      if (nearFrameTranscript) {
        currentQuestionText += `\n\n───── NEAR-FRAME TRANSCRIPT (Audio around current timestamp) ─────\n${nearFrameTranscript}\n────────────────────────────────────────────────────────────────────`;
      }

      const currentUserParts = [
        { text: currentQuestionText }
      ];

      if (freshB64) currentUserParts.push({ inlineData: { mimeType: "image/png", data: freshB64 } });

      // Add uploaded PDF/summary and VTT files
      if (uploadedPdfUri) {
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        currentUserParts.push({ fileData: { mimeType: pdfMimeType, fileUri: uploadedPdfUri } });
      }
      if (uploadedVttUri) {
        currentUserParts.push({ fileData: { mimeType: "text/plain", fileUri: uploadedVttUri } });
      }

      pendingAttachments.forEach(a=>{
        if (a.fileUri) currentUserParts.push({ fileData: { mimeType: a.mime || "application/octet-stream", fileUri: a.fileUri } });
      });

      (partsTail || []).forEach(p => { if (p.fileData) currentUserParts.push({ fileData: p.fileData }); });

      // Build proper conversation history with alternating turns
      const contents = [];
      const contextContents = messagesToContents(contextMessages || []);

      // Merge consecutive user turns
      for (let i = 0; i < contextContents.length; i++) {
        const current = contextContents[i];

        if (current.role === "user" && contents.length > 0 && contents[contents.length - 1].role === "user") {
          // Merge with previous user turn
          contents[contents.length - 1].parts.push(...current.parts);
        } else {
          contents.push(current);
        }
      }

      // Add current user message
      if (contents.length > 0 && contents[contents.length - 1].role === "user") {
        // Merge with last user turn
        contents[contents.length - 1].parts.push(...currentUserParts);
      } else {
        contents.push({ role: "user", parts: currentUserParts });
      }

      return {
        systemInstruction: {
          parts: [{ text: systemText }]
        },
        contents
      };
    }

    async function initializeFiles(pendingBubbleEl) {
      if (filesInitialized) return;
      if (filesInitializing) {
        // Wait for initialization to complete
        while (filesInitializing) {
          await new Promise(r => setTimeout(r, 100));
        }
        return;
      }

      filesInitializing = true;
      console.log("Initializing files - uploading PDF and VTT");

      try {
        await waitForApiKey();

        // YouTube implementation
        if (isYouTubePage()) {
          const videoId = getYouTubeVideoId();
          if (!videoId) {
            throw new Error('[YouTube] Could not extract video ID');
          }

          // Upload complete transcript (Step 2) if not already uploaded - OPTIONAL
          if (!uploadedVttUri) {
            try {
              console.log('[YouTube] Fetching and uploading complete transcript');
              if (!youtubeTranscriptPromise) {
                youtubeTranscriptPromise = fetchYouTubeCompleteTranscript(videoId);
              }
              const transcriptData = await youtubeTranscriptPromise;

              // Check if transcript is available
              if (transcriptData.available && transcriptData.uuid && transcriptData.transcript) {
                youtubeTranscriptUUID = transcriptData.uuid;

                // Convert transcript text to blob and upload
                const transcriptBlob = new Blob([transcriptData.transcript], { type: 'text/plain' });
                uploadedVttUri = await uploadFileToGemini(transcriptBlob, "youtube-transcript.txt");
                console.log('[YouTube] Complete transcript uploaded:', uploadedVttUri);
              } else {
                console.log('[YouTube] No transcript available for this video - continuing without it');
              }
            } catch (e) {
              console.warn('[YouTube] Failed to fetch transcript - continuing without it:', e);
              // Don't throw - transcript is optional
            }
          }

          // Upload video summary (Step 4) if not already uploaded
          if (!uploadedPdfUri) {
            console.log('[YouTube] Fetching and uploading video summary');
            const summaryData = await fetchYouTubeVideoSummary(videoId);

            // Convert summary to blob and upload
            const summaryBlob = new Blob([summaryData.summary], { type: 'text/plain' });
            uploadedPdfUri = await uploadFileToGemini(summaryBlob, "youtube-summary.txt");
            console.log('[YouTube] Video summary uploaded:', uploadedPdfUri);
          }
        } else {
          // Echo360 implementation (original)

          // Upload VTT if not already uploaded
          if (!uploadedVttUri) {
            const vttUrl = getVttUrl();
            if (vttUrl) {
              const vttBlob = await fetchVttWithAuth(vttUrl);
              if (vttBlob) {
                console.log("Uploading VTT transcript");
                uploadedVttUri = await uploadFileToGemini(vttBlob, "transcript.vtt");
                console.log("VTT uploaded:", uploadedVttUri);
              }
            }
          }

          // Upload PDF if not already uploaded and URL is available
          if (!uploadedPdfUri && SLIDES_PDF_URL) {
            // Use cached blob if available, otherwise fetch it
            let pdfBlob = cachedPdfBlob;
            if (!pdfBlob) {
              console.log("Cached PDF blob not found, fetching from URL");
              pdfBlob = await fetchAsBlob(SLIDES_PDF_URL, "application/pdf");
            } else {
              console.log("Using cached PDF blob, size:", pdfBlob.size);
            }

            if (pdfBlob) {
              console.log("Uploading PDF slides to AI");
              uploadedPdfUri = await uploadFileToGemini(pdfBlob, "lecture-slides.pdf");
              console.log("PDF uploaded:", uploadedPdfUri);
            } else {
              console.warn('[PDF STATUS] Failed to fetch PDF from URL');
            }
          } else if (!uploadedPdfUri && !SLIDES_PDF_URL) {
            console.log('[PDF STATUS] No PDF URL available, skipping PDF upload');
          }
        }

        filesInitialized = true;
        console.log("Files initialized successfully");

        // Update pending bubble to show "Thinking"
        if (pendingBubbleEl) {
          updatePendingBubbleText(pendingBubbleEl, "Thinking…");
        }
      } catch (e) {
        console.error("File initialization failed:", e);
        throw e;
      } finally {
        filesInitializing = false;
      }
    }

    async function sendFollowUp(userMsg, pendingBubbleEl) {
      // Initialize lastUrl if not set yet
      if (!lastUrl) {
        await waitForApiKey();
        lastUrl = `https://generativelanguage.googleapis.com/v1beta/${currentModel}:generateContent`;
      }

      // Initialize files if needed
      await initializeFiles(pendingBubbleEl);

      if (!pendingBubbleEl || !pendingBubbleEl.isConnected) {
        pendingBubbleEl = findActivePendingBubble();
        if (!pendingBubbleEl) {
          pendingBubbleEl = appendPendingBubble();
        }
        lastPendingBubble = pendingBubbleEl;
      }

      const freshB64 = await captureVideoFrame(WRAPPER_XPATH);

      let group = null, simPct = NaN;
      let contextMsgs = [];

      // Skip OCR on YouTube - no slides to match against, just use full history
      if (slideContextEnabled && freshB64 && !isYouTubePage()) {
        const sel = await selectSlideGroupUsingOCR(freshB64);
        group = sel.group; simPct = sel.simPct;
        if (group) contextMsgs = group.messages.slice(-10);
      } else {
        contextMsgs = getAllHistoryExcludingCurrent().slice(-20);
      }

      const slideDirective = slideContextEnabled
        ? `Slide-Context: ON. ${group ? "Using ONLY this slide's prior turns ("+group.messages.length+" msgs)." : "No group matched; no prior turns attached."} Similarity: ${isFinite(simPct) ? simPct.toFixed(2)+"%" : "N/A"}.`
        : "Slide-Context: OFF. Full conversation history is attached LAST; use ONLY if it obviously continues the CURRENT message.";

      const body = await buildChatBody({ userMsg, freshB64, contextMessages: contextMsgs, slideDirective });

      showHeaderSpinner(true); setError("");
      inFlightAbort = new AbortController();

      let resp, data, explanation;
      try {
        suppressIntercept = true;
        const url = rewriteUrlWithModel(lastUrl, currentModel);
        logModelUsage('Chat', currentModel);
        resp = await proxiedFetchForAI(url, { method: "POST", headers: lastHeaders, body: JSON.stringify(body), signal: inFlightAbort.signal });
      } catch (e) {
        if (e.name === "AbortError") return;
        setThinkingState(false);
        resolvePendingBubble(pendingBubbleEl, renderMarkdown("_Network error._"));
        return;
      } finally {
        suppressIntercept = false;
        inFlightAbort = null;
      }

      try { data = await resp.clone().json(); explanation = extractExplanation(data); } catch {}

      if (!resp.ok) {
        const err = data?.error;
        if (err?.code === 429 || err?.status === "RESOURCE_EXHAUSTED") {
          const waitMs = parseRetryMsFromErrorMessage(err.message || "");
          retryEndsAt = Date.now() + waitMs;

          const others = ALL_MODELS.filter(m => m !== currentModel);
          const btns = others.map(m => `<button class="gemini-tiny-btn" data-switch="${m}">Switch to ${modelLabel(m)}</button>`).join("");

          if (!pendingBubbleEl || !pendingBubbleEl.isConnected) {
            pendingBubbleEl = findActivePendingBubble() || appendPendingBubble();
            lastPendingBubble = pendingBubbleEl;
          }

          pendingBubbleEl.innerHTML =
            `<span class="gemini-inline-spinner"></span>
             <span style="margin-left:6px;">
               Rate limit reached (model: ${currentModel.split("/").pop()}). Retrying in <span id="gemini-countdown">${Math.ceil(waitMs/1000)}s</span>…
             </span>
             ${btns}
             <button class="gemini-tiny-btn" data-cancel="1">Cancel</button>`;

          const cd = pendingBubbleEl.querySelector("#gemini-countdown");
          if (retryIntervalId) { clearInterval(retryIntervalId); retryIntervalId = null; }
          retryIntervalId = setInterval(() => {
            const left = Math.max(0, retryEndsAt - Date.now());
            if (cd) cd.textContent = Math.ceil(left/1000) + "s";
            if (left <= 0 && retryIntervalId) { clearInterval(retryIntervalId); retryIntervalId = null; }
          }, 250);

          const onClick = (ev)=>{
            const t = ev.target;
            if (t.dataset.switch) {
              currentModel = t.dataset.switch; modelSel.value = currentModel;
              logModelUsage('Chat', currentModel, 'switched after rate limit');
              if (retryTimeoutId){ clearTimeout(retryTimeoutId); retryTimeoutId = null; }
              if (retryIntervalId){ clearInterval(retryIntervalId); retryIntervalId = null; }
              sendFollowUp(userMsg, pendingBubbleEl);
            } else if (t.dataset.cancel) {
              cancelThinkingUI(pendingBubbleEl, "by user");
              if (lastUserMsgForRetry) { textEl.value = lastUserMsgForRetry; textEl.focus(); }
            }
          };
          pendingBubbleEl.addEventListener("click", onClick, { once:false });

          retryTimeoutId = setTimeout(()=> {
            retryTimeoutId = null;
            if (retryIntervalId){ clearInterval(retryIntervalId); retryIntervalId = null; }
            // If no smaller model available, just stop retrying and inform user
            const altModel = others?.[0];
            if (altModel) {
              currentModel = altModel; modelSel.value = currentModel;
              logModelUsage('Chat', currentModel, 'auto-switched after rate limit');
              sendFollowUp(userMsg, pendingBubbleEl);
            } else {
              resolvePendingBubble(pendingBubbleEl, renderMarkdown('_Rate limited. Try again later._'));
              setThinkingState(false);
            }
          }, waitMs);
          return;
        }

        setError("Gemini error: " + (err?.status || resp.status) + " – " + (err?.message || resp.statusText));
        resolvePendingBubble(pendingBubbleEl, renderMarkdown("_Request failed._"));
        setThinkingState(false);
        return;
      }

      const html = renderMarkdown(explanation || "_No explanation text found._");
      resolvePendingBubble(pendingBubbleEl, html);
      logModelUsage('Chat', currentModel, 'response received');
      setThinkingState(false);

      if (explanation) {
        history.push({ role: "model", text: explanation });
        if (slideContextEnabled && currentGroupId) {
          storeMessageInGroup(currentGroupId, "user", userMsg);
          storeMessageInGroup(currentGroupId, "model", explanation);
        }
      }
    }

    // ===== Dragging =====
    (function enableDragging() {
      let dragging = false, startX=0, startY=0, startLeft=0, startTop=0;
      function onMouseDown(e) {
        if (e.button !== 0) return;
        dragging = true;
        const rect = panel.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;

        // Convert to left/top positioning if currently using right/bottom
        if (panel.style.right) {
          panel.style.left = rect.left + "px";
          panel.style.top  = rect.top + "px";
          panel.style.right = "";
          panel.style.bottom = "";
        }

        startLeft = parseFloat(panel.style.left || rect.left);
        startTop  = parseFloat(panel.style.top  || rect.top);
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        e.preventDefault();
      }
      function onMouseMove(e) {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        let newLeft = startLeft + dx;
        let newTop  = startTop + dy;
        const vpW = document.documentElement.clientWidth;
        const vpH = document.documentElement.clientHeight;
        const rect = panel.getBoundingClientRect();
        newLeft = Math.min(Math.max(0, newLeft), vpW - rect.width);
        newTop  = Math.min(Math.max(0, newTop),  vpH - rect.height);
        panel.style.left = newLeft + "px";
        panel.style.top  = newTop  + "px";
      }
      function onMouseUp() {
        dragging = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      }
      headerEl.addEventListener("mousedown", onMouseDown);
    })();

    // ===== Resizing (Recreated from scratch) =====
    (function enableResizing() {
      let isResizing = false;
      let resizeDirection = "";
      let startMouseX = 0, startMouseY = 0;
      let startPanelWidth = 0, startPanelHeight = 0;
      let startPanelLeft = 0, startPanelTop = 0;

      function startResize(e) {
        // Only respond to left mouse button
        if (e.button !== 0) return;

        // Stop event from propagating
        e.stopPropagation();
        e.preventDefault();

        console.log('[Resize] Starting resize on:', e.target.className);

        const handle = e.target;
        resizeDirection = handle.dataset.dir || "";
        isResizing = true;

        // Get current panel dimensions
        const rect = panel.getBoundingClientRect();

        // Convert right/bottom positioning to left/top for easier calculation
        if (panel.style.right) {
          panel.style.left = rect.left + "px";
          panel.style.top = rect.top + "px";
          panel.style.right = "";
          panel.style.bottom = "";
        }

        // Store starting values
        startMouseX = e.clientX;
        startMouseY = e.clientY;
        startPanelWidth = rect.width;
        startPanelHeight = rect.height;
        startPanelLeft = rect.left;
        startPanelTop = rect.top;

        // Add global listeners
        document.addEventListener("mousemove", performResize, true);
        document.addEventListener("mouseup", stopResize, true);

        console.log('[Resize] Direction:', resizeDirection, 'Start size:', startPanelWidth, 'x', startPanelHeight);
      }

      function performResize(e) {
        if (!isResizing) return;

        e.preventDefault();
        e.stopPropagation();

        const dx = e.clientX - startMouseX;
        const dy = e.clientY - startMouseY;

        let newWidth = startPanelWidth;
        let newHeight = startPanelHeight;
        let newLeft = startPanelLeft;
        let newTop = startPanelTop;

        const viewportWidth = document.documentElement.clientWidth;
        const viewportHeight = document.documentElement.clientHeight;

        // Handle horizontal resizing
        if (resizeDirection.includes("e") || resizeDirection === "right") {
          newWidth = Math.max(PANEL_MIN_W, Math.min(viewportWidth - startPanelLeft, startPanelWidth + dx));
        }
        if (resizeDirection.includes("w") || resizeDirection === "left") {
          newWidth = Math.max(PANEL_MIN_W, startPanelWidth - dx);
          newLeft = startPanelLeft + (startPanelWidth - newWidth);
          if (newLeft < 0) {
            newLeft = 0;
            newWidth = startPanelWidth + startPanelLeft;
          }
        }

        // Handle vertical resizing
        if (resizeDirection.includes("s") || resizeDirection === "bottom") {
          newHeight = Math.max(PANEL_MIN_H, Math.min(viewportHeight - startPanelTop, startPanelHeight + dy));
        }
        if (resizeDirection.includes("n") || resizeDirection === "top") {
          newHeight = Math.max(PANEL_MIN_H, startPanelHeight - dy);
          newTop = startPanelTop + (startPanelHeight - newHeight);
          if (newTop < 0) {
            newTop = 0;
            newHeight = startPanelHeight + startPanelTop;
          }
        }

        // Apply new dimensions
        panel.style.width = newWidth + "px";
        panel.style.height = newHeight + "px";
        panel.style.left = newLeft + "px";
        panel.style.top = newTop + "px";

        // Save dimensions
        savedW = newWidth;
        savedH = newHeight;
      }

      function stopResize(e) {
        if (!isResizing) return;

        console.log('[Resize] Stopped');
        isResizing = false;
        resizeDirection = "";

        document.removeEventListener("mousemove", performResize, true);
        document.removeEventListener("mouseup", stopResize, true);

        e.preventDefault();
        e.stopPropagation();
      }

      // Attach resize handlers to all resize handles
      const resizeHandles = panel.querySelectorAll(".gemini-resizer");
      console.log('[Resize] Found resize handles:', resizeHandles.length);

      resizeHandles.forEach(handle => {
        handle.addEventListener("mousedown", startResize, true);
        console.log('[Resize] Attached to:', handle.className, 'Direction:', handle.dataset.dir);
      });
    })();

    // ===== QUIZ FUNCTIONALITY =====

    // Quiz utilities
    const canon = (s) => (s ?? '')
      .toString()
      .replace(/#.*$/,'')
      .replace(/\*\*|`|\(|\)|\[|\]|\$/g, '')
      .replace(/\s+/g,' ')
      .trim()
      .toLowerCase();

    function shuffleArray(array) {
      const arr = [...array];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
      return arr;
    }

    function shuffleArrayUntilDifferent(array) {
      // Keep shuffling until the order is different from the original
      // This ensures rearrange questions are not already in correct order
      const original = [...array];
      let shuffled;
      let attempts = 0;
      const maxAttempts = 100; // Prevent infinite loop

      do {
        shuffled = shuffleArray(array);
        attempts++;
      } while (
        attempts < maxAttempts &&
        array.length > 1 && // Only check if array has more than 1 element
        shuffled.every((item, idx) => item === original[idx])
      );

      return shuffled;
    }

    function exitQuizMode() {
      quizMode = false;
      // Don't clear quiz data - allow continuing

      // Restore saved chat content if available, otherwise clear
      restoreSavedChatContent();

      // Show normal chat UI
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      updateHeaderSubtitle('Ask about this slide');

      // Update quiz button based on completion state
      if (quizData.length > 0) {
        quizBtn.textContent = quizCompleted ? 'Quiz Summary' : 'Continue Quiz';
        quizBtn.style.display = '';
      }
    }

    function enterQuizMode(quiz) {
      quizMode = true;
      if (quiz) {
        quizData = quiz;
        quizCurrent = 0;
        quizAnswers = new Array(quiz.length);
        quizCompleted = false; // Reset completion state for new quiz
        aiMarkingCompleted = false; // Reset marking state for new quiz
      }

      // Clear countdown interval if it exists
      const genContainer = chatEl.querySelector('.quiz-generating');
      if (genContainer && genContainer.dataset.countdownInterval) {
        clearInterval(parseInt(genContainer.dataset.countdownInterval));
      }

      // Hide controls and input
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      updateHeaderSubtitle('Quiz Mode');

      // If quiz is completed, show summary instead
      if (quizCompleted) {
        showQuizResults();
      } else {
        renderQuizQuestion();
      }
    }

    function showQuizGenerating() {
      // Don't update UI if generating in background
      if (quizGeneratingInBackground) return;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      // Hide any pending bubbles or thinking indicators
      if (lastPendingBubble && lastPendingBubble.isConnected) {
        lastPendingBubble.remove();
      }

      // Hide all UI controls during generation
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'quiz-generating';

      // Calculate current countdown value if timer is already running
      let currentCountdown = 70;
      if (quizCountdownStartTime) {
        const elapsed = Math.floor((Date.now() - quizCountdownStartTime) / 1000);
        if (quizCountdownPhase === 1) {
          currentCountdown = Math.max(0, 70 - elapsed);
        } else if (quizCountdownPhase === 2) {
          currentCountdown = Math.max(0, 19 - (elapsed - 70));
        }
      }

      // Format countdown as minutes and seconds
      const formatTime = (secs) => {
        const mins = Math.floor(secs / 60);
        const remainingSecs = secs % 60;
        if (mins > 0) {
          return `${mins} minute${mins > 1 ? 's' : ''} ${remainingSecs} second${remainingSecs !== 1 ? 's' : ''}`;
        }
        return `${secs} second${secs !== 1 ? 's' : ''}`;
      };

      container.innerHTML = `
        <div class="quiz-gen-spinner"></div>
        <div class="quiz-gen-text">Generating Your Quiz...</div>
        <div class="quiz-gen-subtext">Analyzing what was covered in this lecture</div>
        <div class="quiz-gen-eta quiz-eta" style="font-size: 13px; color: #666; margin-top: 8px;">ETA: ${formatTime(currentCountdown)}</div>
        <div class="quiz-generating-status"></div>
        <button class="quiz-gen-stop" id="quiz-gen-stop-btn">Exit</button>
      `;
      chatEl.appendChild(container);

      const etaEl = container.querySelector('.quiz-eta');

      // Only start countdown timer if not already running
      if (!quizCountdownInterval) {
        quizCountdownStartTime = Date.now();
        quizCountdownPhase = 1;

        quizCountdownInterval = setInterval(() => {
          const etaElement = document.querySelector('.quiz-eta');
          if (!etaElement) return;

          const elapsed = Math.floor((Date.now() - quizCountdownStartTime) / 1000);

          const formatTime = (secs) => {
            const mins = Math.floor(secs / 60);
            const remainingSecs = secs % 60;
            if (mins > 0) {
              return `${mins} minute${mins > 1 ? 's' : ''} ${remainingSecs} second${remainingSecs !== 1 ? 's' : ''}`;
            }
            return `${secs} second${secs !== 1 ? 's' : ''}`;
          };

          if (quizCountdownPhase === 1) {
            const remaining = Math.max(0, 70 - elapsed);
            if (remaining > 0) {
              etaElement.textContent = `ETA: ${formatTime(remaining)}`;
            } else {
              quizCountdownPhase = 2;
            }
          } else if (quizCountdownPhase === 2) {
            const remaining = Math.max(0, 19 - (elapsed - 70));
            if (remaining > 0) {
              etaElement.textContent = `Hold tight, it's almost done: ${formatTime(remaining)}`;
            } else {
              quizCountdownPhase = 3;
              etaElement.textContent = "Sorry, this is taking longer than expected...";
              clearInterval(quizCountdownInterval);
              quizCountdownInterval = null;
            }
          } else if (quizCountdownPhase === 3) {
            etaElement.textContent = "Sorry, this is taking longer than expected...";
          }
        }, 1000);
      }

      // Add stop button handler
      const stopBtn = container.querySelector('#quiz-gen-stop-btn');
      stopBtn.addEventListener('click', () => {
        console.log("User stopped watching quiz generation - continuing in background");

        // Don't abort - let it continue in background
        quizGenerating = false;
        quizGeneratingInBackground = true;
        restoreSavedChatContent();
        controlsEl.style.display = '';
        inputRowEl.style.display = '';
        attEl.style.display = '';
        updateHeaderSubtitle('Ask about this slide');
        quizBtn.style.display = '';

        // Update button text to show it's generating
        quizBtn.textContent = 'Quiz (Generating...)';
      });
    }

    function captureQuizAnswer() {
      const q = quizData[quizCurrent];
      let data = null;
      const container = chatEl.querySelector('.quiz-container');
      if (!container) return;

      switch(q.question_type) {
        case 'Fill in the Blank': {
          const input = container.querySelector('.quiz-textbox');
          data = { value: input?.value || '' };
          break;
        }
        case 'Multiple Choice': {
          const sel = container.querySelector('input[type="radio"]:checked');
          data = { value: sel?.value || '' };
          break;
        }
        case 'True or False': {
          const sel = container.querySelector('input[type="radio"]:checked');
          data = { value: sel?.value || '' };
          break;
        }
        case 'Check All That Apply (or Multiple Select)': {
          const values = [...container.querySelectorAll('input[type="checkbox"]:checked')].map(cb=>cb.value);
          data = { values };
          break;
        }
        case 'Drag and Drop': {
          const assigns = [];
          [...container.querySelectorAll('.quiz-dropzone')].forEach(dz=>{
            const chip = dz.firstElementChild;
            assigns[Number(dz.dataset.idx)] = chip ? chip.dataset.value : '';
          });
          data = { assignments: assigns };
          break;
        }
        case 'Matching': {
          const choices = [...container.querySelectorAll('.quiz-select')].map(sel=>sel.value);
          data = { choices };
          break;
        }
        case 'Ordering (or Sequencing)': {
          // Get the original text values, not the rendered HTML
          const order = [...container.querySelectorAll('.quiz-sequence-item')].map(li=>{
            // Store original values in data attribute during render
            return li.dataset.originalText || li.textContent;
          });
          data = { order };
          break;
        }
        case 'Identify Incorrect Step': {
          const sel = container.querySelector('input[type="radio"]:checked');
          data = { value: sel ? parseInt(sel.value) : null };
          break;
        }
        case 'Debate Question': {
          const textarea = container.querySelector('.quiz-debate-textarea');
          data = { value: textarea?.value || '' };
          break;
        }
        case 'Mixed Fill-in': {
          const blanks = {};
          container.querySelectorAll('[data-blank-id]').forEach(input => {
            const blankId = input.getAttribute('data-blank-id');
            blanks[blankId] = input.value || '';
          });
          data = { blanks };
          break;
        }
      }
      quizAnswers[quizCurrent] = data;
    }

    function renderQuizQuestion() {
      // Clear countdown interval when quiz is ready
      if (quizCountdownInterval) {
        clearInterval(quizCountdownInterval);
        quizCountdownInterval = null;
        quizCountdownStartTime = null;
        quizCountdownPhase = 1;
      }

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      const q = quizData[quizCurrent];

      const container = document.createElement('div');
      container.className = 'quiz-container';

      // Progress
      const meta = document.createElement('div');
      meta.className = 'quiz-meta';
      meta.innerHTML = `<div class="quiz-kicker">Question ${quizCurrent+1} of ${quizData.length}</div><div class="quiz-kicker">${q.question_type}</div>`;
      container.appendChild(meta);

      const progress = document.createElement('div');
      progress.className = 'quiz-progress';
      const bar = document.createElement('div');
      bar.style.width = ((quizCurrent/quizData.length)*100) + '%';
      progress.appendChild(bar);
      container.appendChild(progress);

      // Question (with markdown/LaTeX support)
      // Skip rendering question_text for Debate Question and Mixed Fill-in (they're rendered in custom layouts)
      if (q.question_type !== 'Debate Question' && q.question_type !== 'Mixed Fill-in') {
        const qText = document.createElement('div');
        qText.className = 'quiz-question';
        qText.innerHTML = renderMarkdown(q.question_text);
        typesetEl(qText);
        container.appendChild(qText);
      }

      // Hint button (skip for Mixed Fill-in since each blank has its own hint)
      if (q.hint && q.question_type !== 'Mixed Fill-in') {
        const hintBtn = document.createElement('button');
        hintBtn.className = 'quiz-hint-btn';
        hintBtn.textContent = '💡 Show Hint';
        hintBtn.setAttribute('tabindex', '0');
        hintBtn.onclick = () => {
          if (hintBtn.nextElementSibling?.classList.contains('quiz-hint-text')) {
            hintBtn.nextElementSibling.remove();
            hintBtn.textContent = '💡 Show Hint';
          } else {
            const hintDiv = document.createElement('div');
            hintDiv.className = 'quiz-hint-text';
            hintDiv.innerHTML = renderMarkdown(q.hint);
            typesetEl(hintDiv);
            hintBtn.after(hintDiv);
            hintBtn.textContent = '💡 Hide Hint';
          }
        };
        container.appendChild(hintBtn);
      }

      // Question body
      const qBody = document.createElement('div');

      switch(q.question_type) {
        case 'Fill in the Blank': {
          const input = document.createElement('input');
          input.className = 'quiz-textbox';
          input.type = 'text';
          input.placeholder = 'Type your answer';
          input.setAttribute('tabindex', '0');
          if (quizAnswers[quizCurrent]?.value) input.value = quizAnswers[quizCurrent].value;
          qBody.appendChild(input);
          break;
        }
        case 'Multiple Choice': {
          const opts = q.options || [];
          const wrap = document.createElement('div');
          wrap.className = 'quiz-options';
          opts.forEach((opt, i)=>{
            const label = document.createElement('label');
            label.className='quiz-option';
            label.setAttribute('tabindex', '0');
            const radio = document.createElement('input');
            radio.type='radio';
            radio.name='mcq';
            radio.value=opt;
            radio.checked = quizAnswers[quizCurrent]?.value === opt;
            radio.setAttribute('tabindex', '-1'); // Label handles focus
            const span = document.createElement('span');
            span.innerHTML = renderMarkdown(opt);
            typesetEl(span);
            label.appendChild(radio); label.appendChild(span); wrap.appendChild(label);
            // Keyboard support for radio options
            label.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          });
          qBody.appendChild(wrap);
          break;
        }
        case 'True or False': {
          const opts = q.options || ['True','False'];
          const wrap = document.createElement('div');
          wrap.className = 'quiz-options';
          opts.forEach(opt=>{
            const label = document.createElement('label');
            label.className='quiz-option';
            label.setAttribute('tabindex', '0');
            const radio = document.createElement('input');
            radio.type='radio'; radio.name='tf'; radio.value=opt;
            radio.checked = quizAnswers[quizCurrent]?.value === opt;
            radio.setAttribute('tabindex', '-1'); // Label handles focus
            const span = document.createElement('span');
            span.innerHTML = renderMarkdown(opt);
            typesetEl(span);
            label.appendChild(radio); label.appendChild(span);
            wrap.appendChild(label);
            // Keyboard support for radio options
            label.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          });
          qBody.appendChild(wrap);
          break;
        }
        case 'Check All That Apply (or Multiple Select)': {
          const wrap = document.createElement('div');
          wrap.className = 'quiz-options';
          const prev = new Set(quizAnswers[quizCurrent]?.values || []);
          q.options.forEach(opt=>{
            const label = document.createElement('label'); label.className='quiz-option';
            label.setAttribute('tabindex', '0');
            const cb = document.createElement('input'); cb.type='checkbox'; cb.value=opt; cb.checked = prev.has(opt);
            cb.setAttribute('tabindex', '-1'); // Label handles focus
            const span = document.createElement('span');
            span.innerHTML = renderMarkdown(opt);
            typesetEl(span);
            label.appendChild(cb); label.appendChild(span);
            wrap.appendChild(label);
            // Keyboard support for checkbox options
            label.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                cb.checked = !cb.checked;
                cb.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          });
          qBody.appendChild(wrap);
          break;
        }
        case 'Drag and Drop': {
          const bankLabel = document.createElement('div');
          bankLabel.className='quiz-kicker';
          bankLabel.textContent='Word Bank';
          qBody.appendChild(bankLabel);

          const bank = document.createElement('div');
          bank.className='quiz-word-bank';
          bank.id='quiz-word-bank';

          // Randomize word bank order on each render
          const shuffledWordBank = shuffleArray(q.word_bank);

          shuffledWordBank.forEach((word, idx)=>{
            const chip = document.createElement('div');
            chip.className='quiz-chip';
            chip.innerHTML = renderMarkdown(word);
            typesetEl(chip);
            chip.draggable=true;
            chip.dataset.value=word;
            chip.dataset.src='bank';
            chip.setAttribute('tabindex', '0');
            attachQuizChipDnD(chip);
            bank.appendChild(chip);
          });
          qBody.appendChild(bank);

          const list = document.createElement('div');
          list.className='quiz-dropzone-list';
          q.items_to_match.forEach((item, i)=>{
            const row = document.createElement('div');
            row.className='quiz-pair';
            const left = document.createElement('div');
            left.innerHTML = renderMarkdown(item.description);
            typesetEl(left);
            const dz = document.createElement('div');
            dz.className='quiz-dropzone';
            dz.dataset.idx = i;
            dz.setAttribute('tabindex', '0');
            attachQuizDropzone(dz, bank);

            const stored = quizAnswers[quizCurrent]?.assignments?.[i];
            if (stored){
              const chip = [...bank.children].find(c=>c.dataset.value===stored) || createQuizChip(stored);
              chip.dataset.src = 'dz';
              attachQuizChipDnD(chip);
              dz.appendChild(chip);
            }
            row.appendChild(left); row.appendChild(dz); list.appendChild(row);
          });
          qBody.appendChild(list);
          break;
        }
        case 'Matching': {
          const list = document.createElement('div');
          q.pairs.forEach((pair, i)=>{
            const row = document.createElement('div');
            row.className='quiz-pair';
            const left = document.createElement('div');
            left.innerHTML = renderMarkdown(pair.left);
            typesetEl(left);
            const sel = document.createElement('select');
            sel.className = 'quiz-select';
            sel.setAttribute('tabindex', '0');

            // Add placeholder option
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Choose option';
            placeholder.disabled = true;
            sel.appendChild(placeholder);

            // Scramble options
            const opts = Array.from(new Set(q.pairs.map(p=>p.right)));
            const scrambledOpts = shuffleArray(opts);
            scrambledOpts.forEach(v=>{
              const o=document.createElement('option');
              o.value=v;
              o.innerHTML=renderMarkdown(v);
              sel.appendChild(o);
            });
            sel.value = quizAnswers[quizCurrent]?.choices?.[i] ?? '';

            // Keyboard support for dropdown
            // Native select behavior works: Space to open, arrows to navigate
            sel.addEventListener('focus', () => {
              console.log('[Quiz Keyboard] Dropdown focused, current value:', sel.value);
            });

            // Prevent global keyboard navigation from interfering with dropdown navigation
            sel.addEventListener('keydown', (e) => {
              console.log('[Quiz Keyboard] Dropdown key:', e.key);
              if (['ArrowUp', 'ArrowDown', ' '].includes(e.key)) {
                e.stopPropagation(); // Prevent global keyboard nav
                // Let browser handle the dropdown
              }
            });

            sel.addEventListener('change', () => {
              console.log('[Quiz Keyboard] Dropdown changed to:', sel.value);
            });

            row.appendChild(left); row.appendChild(sel); list.appendChild(row);
          });
          qBody.appendChild(list);
          break;
        }
        case 'Ordering (or Sequencing)': {
          const ul = document.createElement('div');
          ul.className='quiz-sequence-list';
          ul.id='quiz-seq-list';
          // If user has answered before, use their order; otherwise scramble ensuring it's different from correct order
          let items;
          if (quizAnswers[quizCurrent]?.order?.length) {
            items = quizAnswers[quizCurrent].order;
          } else {
            items = shuffleArrayUntilDifferent(q.sequence_items);
          }
          items.forEach((text, i)=>{
            const li = document.createElement('div');
            li.className='quiz-sequence-item';
            li.innerHTML = renderMarkdown(text);
            li.dataset.originalText = text; // Store original for comparison
            typesetEl(li);
            li.draggable = true;
            li.setAttribute('tabindex', '0');
            attachQuizReorderDnD(li, ul);
            ul.appendChild(li);
          });
          ul.addEventListener('dragover', (e)=>{
            e.preventDefault();
            const after = getQuizDragAfterElement(ul, e.clientY);
            const dragging = document.querySelector('.quiz-sequence-item.dragging');
            if (!dragging) return;
            if (after == null) ul.appendChild(dragging);
            else ul.insertBefore(dragging, after);
          });
          qBody.appendChild(ul);
          break;
        }
        case 'Identify Incorrect Step': {
          // Add instruction text
          const instruction = document.createElement('div');
          instruction.className = 'quiz-step-instruction';
          instruction.innerHTML = '<strong>💡 Click on the step that contains an error</strong>';
          qBody.appendChild(instruction);

          const stepsList = document.createElement('div');
          stepsList.className = 'quiz-steps-list';

          q.steps.forEach((step, idx) => {
            const stepItem = document.createElement('label');
            stepItem.className = 'quiz-step-item';
            stepItem.setAttribute('tabindex', '0');
            stepItem.setAttribute('data-step-num', idx + 1);

            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'incorrect-step';
            radio.value = idx + 1; // Step number (1-indexed)
            radio.checked = quizAnswers[quizCurrent]?.value === (idx + 1);
            radio.setAttribute('tabindex', '-1');

            // Add selected class if this step is chosen
            if (quizAnswers[quizCurrent]?.value === (idx + 1)) {
              stepItem.classList.add('selected');
            }

            const stepContent = document.createElement('span');
            stepContent.className = 'quiz-step-content';
            stepContent.innerHTML = renderMarkdown(step);
            typesetEl(stepContent);

            // Add selection icon
            const icon = document.createElement('span');
            icon.className = 'quiz-step-icon';
            icon.textContent = '❌';

            stepItem.appendChild(radio);
            stepItem.appendChild(stepContent);
            stepItem.appendChild(icon);
            stepsList.appendChild(stepItem);

            // Click handler to toggle selection
            stepItem.addEventListener('click', () => {
              // Remove selected class from all steps
              stepsList.querySelectorAll('.quiz-step-item').forEach(item => {
                item.classList.remove('selected');
              });
              // Add selected class to clicked step
              stepItem.classList.add('selected');
              radio.checked = true;
            });

            // Keyboard support
            stepItem.addEventListener('keydown', (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                // Remove selected class from all steps
                stepsList.querySelectorAll('.quiz-step-item').forEach(item => {
                  item.classList.remove('selected');
                });
                // Add selected class to this step
                stepItem.classList.add('selected');
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          });

          qBody.appendChild(stepsList);
          break;
        }
        case 'Debate Question': {
          // Display the scenario
          const scenarioBox = document.createElement('div');
          scenarioBox.className = 'quiz-debate-scenario';
          scenarioBox.innerHTML = renderMarkdown(q.question_text);
          typesetEl(scenarioBox);
          qBody.appendChild(scenarioBox);

          // Display Person A statement
          const personABox = document.createElement('div');
          personABox.className = 'quiz-debate-person quiz-debate-person-a';
          personABox.innerHTML = `
            <div class="quiz-debate-label">👤 Person A says:</div>
            <div class="quiz-debate-statement">${renderMarkdown(q.person_a_statement)}</div>
          `;
          typesetEl(personABox);
          qBody.appendChild(personABox);

          // Display Person B statement
          const personBBox = document.createElement('div');
          personBBox.className = 'quiz-debate-person quiz-debate-person-b';
          personBBox.innerHTML = `
            <div class="quiz-debate-label">👤 Person B says:</div>
            <div class="quiz-debate-statement">${renderMarkdown(q.person_b_statement)}</div>
          `;
          typesetEl(personBBox);
          qBody.appendChild(personBBox);

          // Add instruction
          const instruction = document.createElement('div');
          instruction.className = 'quiz-debate-instruction';
          instruction.innerHTML = '<strong>📝 Who is correct and why?</strong> Explain your reasoning:';
          qBody.appendChild(instruction);

          // Text area for answer
          const textarea = document.createElement('textarea');
          textarea.className = 'quiz-debate-textarea';
          textarea.placeholder = 'Type your answer here...';
          textarea.rows = 5;
          textarea.setAttribute('tabindex', '0');
          if (quizAnswers[quizCurrent]?.value) textarea.value = quizAnswers[quizCurrent].value;
          qBody.appendChild(textarea);
          break;
        }
        case 'Mixed Fill-in': {
          const mixedContainer = document.createElement('div');
          mixedContainer.className = 'quiz-mixed-container';

          // Create a map of blank IDs to their data
          const blanksMap = {};
          (q.blanks || []).forEach(blank => {
            blanksMap[blank.id] = blank;
          });

          // Replace {blankX} with safe markers that won't interfere with LaTeX
          let processedText = q.question_text;
          const markers = {};
          Object.keys(blanksMap).forEach(blankId => {
            const marker = `___BLANK_MARKER_${blankId}___`;
            markers[marker] = blankId;
            processedText = processedText.replace(`{${blankId}}`, marker);
          });

          // Render markdown and LaTeX
          mixedContainer.innerHTML = renderMarkdown(processedText);
          typesetEl(mixedContainer);

          // Now replace markers with actual input elements using DOM manipulation
          Object.keys(markers).forEach(marker => {
            const blankId = markers[marker];
            const blank = blanksMap[blankId];
            const savedValue = quizAnswers[quizCurrent]?.blanks?.[blankId] || '';

            // Find the text node containing the marker
            const walker = document.createTreeWalker(
              mixedContainer,
              NodeFilter.SHOW_TEXT,
              null,
              false
            );

            let node;
            while (node = walker.nextNode()) {
              if (node.nodeValue && node.nodeValue.includes(marker)) {
                // Create the input element
                const span = document.createElement('span');
                span.className = 'quiz-mixed-blank';

                if (blank.type === 'text') {
                  const input = document.createElement('input');
                  input.type = 'text';
                  input.className = 'quiz-mixed-input';
                  input.setAttribute('data-blank-id', blankId);
                  input.value = savedValue;
                  input.placeholder = '...';
                  input.setAttribute('tabindex', '0');
                  span.appendChild(input);
                } else if (blank.type === 'dropdown') {
                  const select = document.createElement('select');
                  select.className = 'quiz-mixed-dropdown';
                  select.setAttribute('data-blank-id', blankId);
                  select.setAttribute('tabindex', '0');

                  const defaultOpt = document.createElement('option');
                  defaultOpt.value = '';
                  defaultOpt.textContent = '-- Select --';
                  select.appendChild(defaultOpt);

                  (blank.options || []).forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    if (savedValue === opt) option.selected = true;
                    select.appendChild(option);
                  });
                  span.appendChild(select);
                }

                // Add hint icon
                const hintIcon = document.createElement('span');
                hintIcon.className = 'quiz-mixed-hint-icon';
                hintIcon.textContent = '?';
                const tooltip = document.createElement('span');
                tooltip.className = 'quiz-mixed-hint-tooltip';
                tooltip.textContent = blank.hint;
                hintIcon.appendChild(tooltip);
                span.appendChild(hintIcon);

                // Split the text node and insert the element
                const parts = node.nodeValue.split(marker);
                const beforeText = document.createTextNode(parts[0]);
                const afterText = document.createTextNode(parts.slice(1).join(marker));

                node.parentNode.insertBefore(beforeText, node);
                node.parentNode.insertBefore(span, node);
                node.parentNode.insertBefore(afterText, node);
                node.parentNode.removeChild(node);
                break; // Exit walker loop after replacement
              }
            }
          });

          qBody.appendChild(mixedContainer);
          break;
        }
      }

      container.appendChild(qBody);

      // Navigation
      const nav = document.createElement('div');
      nav.className = 'quiz-nav';

      const leftBtns = document.createElement('div');
      leftBtns.style.display = 'flex';
      leftBtns.style.gap = '8px';

      const exitBtn = document.createElement('button');
      exitBtn.className = 'quiz-btn quiz-btn-secondary';
      exitBtn.textContent = 'Exit Quiz';
      exitBtn.onclick = () => {
        captureQuizAnswer(); // Save current answer before exiting
        exitQuizMode();
      };

      const prevBtn = document.createElement('button');
      prevBtn.className = 'quiz-btn quiz-btn-secondary';
      prevBtn.textContent = '← Back';
      prevBtn.disabled = quizCurrent === 0;
      prevBtn.onclick = () => {
        captureQuizAnswer();
        if (quizCurrent > 0) {
          quizCurrent--;
          renderQuizQuestion();
          chatEl.scrollTop = 0;
        }
      };

      leftBtns.appendChild(exitBtn);
      leftBtns.appendChild(prevBtn);

      const rightSide = document.createElement('div');
      rightSide.style.display = 'flex';
      rightSide.style.gap = '8px';

      const resetBtn = document.createElement('button');
      resetBtn.className = 'quiz-btn quiz-btn-secondary';
      resetBtn.textContent = 'Reset';
      resetBtn.onclick = () => {
        quizAnswers[quizCurrent] = undefined;
        renderQuizQuestion();
        chatEl.scrollTop = 0;
      };

      const nextBtn = document.createElement('button');
      nextBtn.className = 'quiz-btn';
      nextBtn.textContent = quizCurrent === quizData.length - 1 ? 'Submit →' : 'Next →';
      nextBtn.onclick = () => {
        captureQuizAnswer();
        if (quizCurrent < quizData.length - 1) {
          quizCurrent++;
          renderQuizQuestion();
          chatEl.scrollTop = 0;
        } else {
          quizCompleted = true; // Mark quiz as completed
          showQuizResults();
          chatEl.scrollTop = 0;
        }
      };

      rightSide.appendChild(resetBtn);
      rightSide.appendChild(nextBtn);
      nav.appendChild(leftBtns);
      nav.appendChild(rightSide);
      container.appendChild(nav);

      chatEl.appendChild(container);
      keepScrolledToBottom();
    }

    function createQuizChip(text){
      const c=document.createElement('div');
      c.className='quiz-chip';
      c.innerHTML = renderMarkdown(text);
      typesetEl(c);
      c.draggable=true;
      c.dataset.value=text;
      c.setAttribute('tabindex', '0');
      attachQuizChipDnD(c);
      return c;
    }

    function attachQuizDropzone(dz, bank){
      dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('hover'); });
      dz.addEventListener('dragleave', ()=> dz.classList.remove('hover'));
      dz.addEventListener('drop', e=>{
        e.preventDefault(); dz.classList.remove('hover');
        const dragging = document.querySelector('.quiz-chip.dragging');
        if (!dragging) return;
        if (dz.firstElementChild) { bank.appendChild(dz.firstElementChild); }
        dz.appendChild(dragging);
        dragging.dataset.src = 'dz';
      });

      bank.addEventListener('dragover', e=>{ e.preventDefault(); bank.classList.add('hover'); });
      bank.addEventListener('dragleave', ()=> bank.classList.remove('hover'));
      bank.addEventListener('drop', e=>{
        e.preventDefault(); bank.classList.remove('hover');
        const dragging = document.querySelector('.quiz-chip.dragging');
        if (!dragging) return;
        bank.appendChild(dragging);
        dragging.dataset.src = 'bank';
      });

      // Keyboard support: Enter on dropzone to place selected chip
      dz.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && selectedChipForKeyboard) {
          e.preventDefault();
          e.stopPropagation();
          console.log('[Quiz Keyboard] Placing chip in dropzone');
          // Move existing chip back to bank if there is one
          if (dz.firstElementChild) {
            bank.appendChild(dz.firstElementChild);
          }
          // Place selected chip in this dropzone
          dz.appendChild(selectedChipForKeyboard);
          selectedChipForKeyboard.dataset.src = 'dz';
          selectedChipForKeyboard.classList.remove('kb-selected');
          selectedChipForKeyboard = null;
        } else if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          console.log('[Quiz Keyboard] Removing chip from dropzone');
          // Move chip back to bank
          if (dz.firstElementChild) {
            bank.appendChild(dz.firstElementChild);
            dz.firstElementChild.dataset.src = 'bank';
          }
        }
      });

      // Also handle focus event
      dz.addEventListener('focus', () => {
        console.log('[Quiz Keyboard] Dropzone focused');
      });
    }

    function attachQuizChipDnD(chip){
      chip.addEventListener('dragstart', ()=> chip.classList.add('dragging'));
      chip.addEventListener('dragend',   ()=> chip.classList.remove('dragging'));

      // Keyboard support: Enter to select/pick chip
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          console.log('[Quiz Keyboard] Chip selected:', chip.dataset.value);
          // Select this chip for keyboard movement
          if (selectedChipForKeyboard) {
            selectedChipForKeyboard.classList.remove('kb-selected');
          }
          selectedChipForKeyboard = chip;
          chip.classList.add('kb-selected');
        }
      });

      // Also handle focus event to add visual highlight
      chip.addEventListener('focus', () => {
        console.log('[Quiz Keyboard] Chip focused:', chip.dataset.value);
      });
    }

    // Global state for drag and drop
    let selectedChipForKeyboard = null;

    // Global state for ordering
    let selectedOrderItemForKeyboard = null;

    function attachQuizReorderDnD(item, ul){
      item.addEventListener('dragstart', ()=> item.classList.add('dragging'));
      item.addEventListener('dragend',   ()=> item.classList.remove('dragging'));

      // Keyboard support: Enter to pick/release, Arrow Up/Down to move while selected
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation(); // Prevent global keyboard nav

          if (selectedOrderItemForKeyboard === item) {
            // Release item
            console.log('[Quiz Keyboard] Releasing sequence item');
            item.classList.remove('kb-selected');
            selectedOrderItemForKeyboard = null;
          } else {
            // Pick item
            console.log('[Quiz Keyboard] Selecting sequence item for reordering');
            if (selectedOrderItemForKeyboard) {
              selectedOrderItemForKeyboard.classList.remove('kb-selected');
            }
            selectedOrderItemForKeyboard = item;
            item.classList.add('kb-selected');
          }
        } else if (selectedOrderItemForKeyboard === item && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          // Move selected item up/down
          e.preventDefault();
          e.stopPropagation(); // Prevent global keyboard nav
          console.log('[Quiz Keyboard] Moving sequence item:', e.key);

          const items = Array.from(ul.children);
          const currentIndex = items.indexOf(item);

          if (e.key === 'ArrowUp' && currentIndex > 0) {
            // Move up (swap with previous)
            ul.insertBefore(item, items[currentIndex - 1]);
            item.focus();
          } else if (e.key === 'ArrowDown' && currentIndex < items.length - 1) {
            // Move down (swap with next)
            ul.insertBefore(items[currentIndex + 1], item);
            item.focus();
          }
        }
      });
    }

    function getQuizDragAfterElement(container, y){
      const els = [...container.querySelectorAll('.quiz-sequence-item:not(.dragging)')];
      return els.reduce((closest, child)=>{
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height/2;
        if (offset < 0 && offset > closest.offset) return { offset, element: child };
        else return closest;
      }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
    }

    // Store original fetch before it gets intercepted
    const originalFetchForAI = window.fetch.bind(window);

    /**
     * Intelligent fetch wrapper that redirects AI API calls to backend
     * All other fetch calls pass through unchanged
     */
    const proxiedFetchForAI = async function(url, options = {}) {
      // Check if this is an AI API call
      if (typeof url === 'string' && url.includes('generativelanguage.googleapis.com')) {
        console.log('[Proxied Fetch] Redirecting AI API call to backend:', url);

        // Parse the URL to extract model and endpoint type
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;

        // Handle file upload endpoint
        if (pathname.includes('/upload/')) {
          // This is a file upload - redirect to backend upload endpoint
          console.log('[Proxied Fetch] Detected file upload, using backend upload endpoint');

          // For file uploads, we need to forward to the backend upload endpoint
          const backendUrl = `${BACKEND_URL}/api/ai/upload`;

          // Forward all headers except API key related ones
          const filteredHeaders = {};
          if (options.headers) {
            for (const [key, value] of Object.entries(options.headers)) {
              if (!key.toLowerCase().includes('api') && !key.toLowerCase().includes('key')) {
                filteredHeaders[key] = value;
              }
            }
          }

          return originalFetchForAI(backendUrl, {
            ...options,
            headers: filteredHeaders
          });
        }

        // Handle file metadata endpoint
        if (pathname.includes('/files/') && !pathname.includes(':generateContent')) {
          const fileName = pathname.split('/files/')[1];
          const backendUrl = `${BACKEND_URL}/api/ai/file/${fileName}`;
          return originalFetchForAI(backendUrl, {
            ...options,
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Handle generateContent endpoint
        if (pathname.includes(':generateContent')) {
          // Extract model name from URL
          // URL format: /v1beta/models/MODEL_NAME:generateContent or /v1beta/MODEL_NAME:generateContent
          let model = '';
          if (pathname.includes('/models/')) {
            model = pathname.split('/models/')[1].split(':')[0];
          } else {
            const parts = pathname.split('/v1beta/')[1].split(':')[0];
            model = parts.startsWith('models/') ? parts : `models/${parts}`;
          }

          // Check if this is TTS (uses header auth)
          const useHeaderAuth = model.includes('tts') ||
                               (options.headers && options.headers['x-goog-api-key']);

          // Parse request body
          let requestBody = {};
          if (options.body) {
            try {
              requestBody = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
            } catch (e) {
              console.error('[Proxied Fetch] Failed to parse request body:', e);
            }
          }

          // Call backend
          const endpoint = useHeaderAuth ? '/api/ai/generate-with-header' : '/api/ai/generate';
          const backendUrl = `${BACKEND_URL}${endpoint}`;

          const bodyWithModel = {
            ...requestBody,
            model: model
          };

          const backendResp = await originalFetchForAI(backendUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(bodyWithModel),
            signal: options.signal // Preserve abort signal
          });

          // Log response for debugging (always enabled for troubleshooting)
          console.log('[AI Proxy] Response status:', backendResp.status);
          console.log('[AI Proxy] Response headers:', Object.fromEntries([...backendResp.headers.entries()]));

          // Clone the response to peek at the data without consuming it
          const clonedResp = backendResp.clone();
          try {
            const data = await clonedResp.json();
            console.log('[AI Proxy] Response has candidates:', !!data.candidates);
            if (data.candidates && data.candidates.length > 0) {
              console.log('[AI Proxy] First candidate has content:', !!data.candidates[0]?.content);
              console.log('[AI Proxy] First candidate has text:', !!data.candidates[0]?.content?.parts?.[0]?.text);
              if (data.candidates[0]?.content?.parts?.[0]?.text) {
                console.log('[AI Proxy] First 100 chars of text:', data.candidates[0].content.parts[0].text.substring(0, 100));
              }
            }
            if (data.error) {
              console.error('[AI Proxy] Response contains error:', data.error);
            }
          } catch (e) {
            console.error('[AI Proxy] Failed to parse response as JSON:', e);
          }

          return backendResp;
        }
      }

      // Not a Gemini API call, pass through unchanged
      return originalFetchForAI(url, options);
    };

    // AI marking cache to avoid re-checking same answers
    const aiMarkingCache = new Map();

    async function batchCheckFillInMarking(items) {
      // items: [{ questionIndex, blankId, userAnswer, correctAnswer }, ...]
      if (items.length === 0) return [];

      try {
        console.log(`[AI Marking] Batch marking ${items.length} fill-in-the-blank answers`);

        // Get prompt from backend
        const promptResponse = await fetch(`${BACKEND_URL}/api/prompts/ai-marking-batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: items.map(item => ({
              userAnswer: item.userAnswer,
              correctAnswer: item.correctAnswer
            }))
          })
        });

        if (!promptResponse.ok) {
          throw new Error(`Batch prompt construction failed`);
        }

        const promptData = await promptResponse.json();
        const prompt = promptData.prompt;

        // Send batch request to Gemini
        const response = await proxiedFetchForAI(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: 2048,
              responseMimeType: "application/json"
            }
          })
        });

        if (!response.ok) {
          throw new Error(`Batch AI marking request failed`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';

        // Parse JSON response
        const results = JSON.parse(text);

        // Convert to boolean array
        return results.map(r => r.correct === true);

      } catch (error) {
        console.warn('[AI Marking] Batch marking failed:', error);
        // Return all false on error
        return items.map(() => false);
      }
    }

    async function checkAIMarking(userAnswer, correctAnswer, questionType = 'Fill in the Blank') {
      const cacheKey = `${questionType}|||${userAnswer}|||${correctAnswer}`;
      if (aiMarkingCache.has(cacheKey)) {
        return aiMarkingCache.get(cacheKey);
      }

      try {
        // Get prompt from backend (prompt is constructed server-side, never exposed to frontend)
        const promptResponse = await fetch(`${BACKEND_URL}/api/prompts/ai-marking`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userAnswer: userAnswer,
            correctAnswer: correctAnswer,
            questionType: questionType
          })
        });

        if (!promptResponse.ok) {
          const errorText = await promptResponse.text();
          throw new Error(`Prompt construction failed: ${errorText}`);
        }

        const promptData = await promptResponse.json();
        const prompt = promptData.prompt;
        const maxTokens = promptData.maxTokens;

        console.log('[AI Marking] Using backend-constructed prompt for:', questionType);

        // Use original fetch to bypass the interceptor
        const response = await proxiedFetchForAI(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              maxOutputTokens: maxTokens
            }
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`AI marking request failed: ${errorText}`);
        }

        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        let result;
        if (questionType === 'Debate Question') {
          // Parse the response for debate questions
          const personMatch = text.match(/PERSON:\s*(yes|no)/i);
          const argumentMatch = text.match(/ARGUMENT:\s*(yes|no)/i);

          const correctPerson = personMatch ? personMatch[1].toLowerCase() === 'yes' : false;
          const correctArgument = argumentMatch ? argumentMatch[1].toLowerCase() === 'yes' : false;

          // Calculate score: 0.25 for correct person only, 1.0 for both correct
          let score = 0;
          if (correctPerson && correctArgument) {
            score = 1.0;
          } else if (correctPerson && !correctArgument) {
            score = 0.25;
          }

          result = {
            score,
            correctPerson,
            correctArgument
          };
        } else {
          // Fill in the Blank - simple true/false
          const isCorrect = text.toLowerCase().includes('yes');
          result = isCorrect;
        }

        aiMarkingCache.set(cacheKey, result);
        return result;
      } catch (error) {
        console.warn('AI marking failed:', error);
        return questionType === 'Debate Question' ? { score: 0, correctPerson: false, correctArgument: false } : false;
      }
    }

    function getQuizScore(index){
      const q = quizData[index];
      const a = quizAnswers[index];
      if (!q || !a) return 0;

      // Check if we have a cached AI marking result
      if (a.aiMarkingResult !== undefined) {
        // For Debate Question, aiMarkingResult is an object with score
        if (typeof a.aiMarkingResult === 'object' && 'score' in a.aiMarkingResult) {
          return a.aiMarkingResult.score;
        }
        // For Fill in the Blank, aiMarkingResult is boolean
        return a.aiMarkingResult ? 1 : 0;
      }

      switch(q.question_type){
        case 'Fill in the Blank': {
          const target = Array.isArray(q.correct_answer) ? q.correct_answer : [q.correct_answer];
          return target.some(t => canon(a.value) === canon(t)) ? 1 : 0;
        }
        case 'Multiple Choice': {
          return canon(a.value) === canon(q.correct_option) ? 1 : 0;
        }
        case 'True or False': {
          const expected = q.correct_answer ?? q.correct_option;
          return canon(a.value) === canon(expected) ? 1 : 0;
        }
        case 'Check All That Apply (or Multiple Select)': {
          const expected = new Set((q.correct_options || []).map(canon));
          const got = new Set((a.values || []).map(canon));

          if (expected.size === 0) return 0;

          // Count correct selections and incorrect selections
          let correctCount = 0;
          let incorrectCount = 0;

          // Check which of user's selections are correct
          for (const v of got) {
            if (expected.has(v)) {
              correctCount++;
            } else {
              incorrectCount++;
            }
          }

          // Check how many correct options were missed
          const missedCount = expected.size - correctCount;

          // Award partial points: (correct - incorrect - missed) / total_correct
          // This prevents guessing all options
          const score = Math.max(0, (correctCount - incorrectCount - missedCount)) / expected.size;
          return Math.max(0, Math.min(1, score));
        }
        case 'Drag and Drop': {
          const assigns = a.assignments || [];
          return (q.items_to_match || []).every((item, i)=> canon(assigns[i]) === canon(item.correct_option)) ? 1 : 0;
        }
        case 'Matching': {
          return (q.pairs || []).every((pair, i)=> canon(a.choices?.[i]) === canon(pair.right)) ? 1 : 0;
        }
        case 'Ordering (or Sequencing)': {
          const expected = (q.correct_sequence || []).map(canon);
          const got = (a.order || []).map(canon);
          if (expected.length !== got.length) return 0;
          for (let i=0;i<expected.length;i++){ if (expected[i] !== got[i]) return 0; }
          return 1;
        }
        case 'Identify Incorrect Step': {
          return a.value === q.correct_answer ? 1 : 0;
        }
        case 'Debate Question': {
          // Will be handled by AI marking
          return 0;
        }
        case 'Mixed Fill-in': {
          const blanks = q.blanks || [];
          const userBlanks = a.blanks || {};
          const aiResults = a.aiMarkingResults || {};

          let totalScore = 0;
          blanks.forEach(blank => {
            const userAnswer = userBlanks[blank.id] || '';
            const correctAnswer = blank.correct_answer || '';
            const aiResult = aiResults[blank.id];

            // Use AI marking result if available
            if (aiResult !== undefined) {
              if (typeof aiResult === 'boolean') {
                totalScore += aiResult ? 1 : 0;
              } else if (typeof aiResult === 'object' && aiResult.score !== undefined) {
                totalScore += aiResult.score;
              }
            } else {
              // Fallback to exact match
              if (canon(userAnswer) === canon(correctAnswer)) {
                totalScore++;
              }
            }
          });

          // Return fractional score based on correct blanks
          return blanks.length > 0 ? totalScore / blanks.length : 0;
        }
        default: return 0;
      }
    }

    function isQuizCorrect(index){
      return getQuizScore(index) === 1;
    }

    async function processAIMarking() {
      if (!aiMarkingCb.checked) return;

      // Collect all Fill-in-the-Blank answers to batch mark
      const fillInBatchItems = [];

      for (let i = 0; i < quizData.length; i++) {
        const q = quizData[i];
        const a = quizAnswers[i];
        if (!a) continue;

        // Collect standalone Fill in the Blank questions
        if (q.question_type === 'Fill in the Blank') {
          const target = Array.isArray(q.correct_answer) ? q.correct_answer : [q.correct_answer];
          const userAnswer = a.value || '';
          const exactMatch = target.some(t => canon(userAnswer) === canon(t));

          if (!exactMatch && userAnswer.trim() !== '') {
            fillInBatchItems.push({
              questionIndex: i,
              blankId: null, // null means standalone question
              userAnswer: userAnswer,
              correctAnswer: target[0]
            });
          } else {
            a.aiMarkingResult = exactMatch;
          }
        }

        // Collect Mixed Fill-in blanks
        if (q.question_type === 'Mixed Fill-in') {
          const blanks = q.blanks || [];
          const userBlanks = a.blanks || {};

          if (!a.aiMarkingResults) {
            a.aiMarkingResults = {};
          }

          for (const blank of blanks) {
            const userAnswer = userBlanks[blank.id] || '';
            const correctAnswer = blank.correct_answer || '';
            const exactMatch = canon(userAnswer) === canon(correctAnswer);

            if (!exactMatch && userAnswer.trim() !== '') {
              fillInBatchItems.push({
                questionIndex: i,
                blankId: blank.id,
                userAnswer: userAnswer,
                correctAnswer: correctAnswer
              });
            } else {
              a.aiMarkingResults[blank.id] = exactMatch;
            }
          }
        }
      }

      // Batch mark all Fill-in-the-Blank answers in one request
      if (fillInBatchItems.length > 0) {
        const batchResults = await batchCheckFillInMarking(fillInBatchItems);

        // Apply results back to answers
        batchResults.forEach((result, idx) => {
          const item = fillInBatchItems[idx];
          const a = quizAnswers[item.questionIndex];

          if (item.blankId === null) {
            // Standalone Fill in the Blank question
            a.aiMarkingResult = result;
          } else {
            // Mixed Fill-in blank
            a.aiMarkingResults[item.blankId] = result;
          }
        });
      }

      // Process Debate Questions separately (different marking logic)
      for (let i = 0; i < quizData.length; i++) {
        const q = quizData[i];
        const a = quizAnswers[i];
        if (!a) continue;

        if (q.question_type === 'Debate Question') {
          const target = Array.isArray(q.correct_answer) ? q.correct_answer : [q.correct_answer];
          const userAnswer = a.value || '';
          const exactMatch = target.some(t => canon(userAnswer) === canon(t));

          if (!exactMatch && userAnswer.trim() !== '') {
            const aiResult = await checkAIMarking(userAnswer, target[0], 'Debate Question');
            a.aiMarkingResult = aiResult;
          } else {
            a.aiMarkingResult = exactMatch ? { score: 1.0, correctPerson: true, correctArgument: true } : { score: 0, correctPerson: false, correctArgument: false };
          }
        }
      }
    }

    function correctQuizAnswerText(q){
      switch(q.question_type){
        case 'Fill in the Blank': return Array.isArray(q.correct_answer) ? q.correct_answer.join(', ') : q.correct_answer;
        case 'Multiple Choice': return q.correct_option;
        case 'True or False': {
          const val = q.correct_answer ?? q.correct_option;
          return val && val.toLowerCase() === 'true' ? 'True' : 'False';
        }
        case 'Check All That Apply (or Multiple Select)': return (q.correct_options||[]).join(' • ');
        case 'Drag and Drop': return q.items_to_match.map(it=>`${it.description} → ${it.correct_option}`).join(' | ');
        case 'Matching': return q.pairs.map(p=>`${p.left} → ${p.right}`).join(' | ');
        case 'Ordering (or Sequencing)': return (q.correct_sequence||[]).join('  →  ');
        case 'Identify Incorrect Step': {
          const stepNum = q.correct_answer;
          return `Step ${stepNum}${q.explanation ? ` (${q.explanation})` : ''}`;
        }
        case 'Debate Question': {
          return q.correct_answer || '';
        }
        case 'Mixed Fill-in': {
          return (q.blanks || []).map(b => `${b.id}: ${b.correct_answer}`).join(' | ');
        }
        default: return '';
      }
    }

    function formatQuizUserAnswer(q, a){
      if (!a) return '<em>—</em>';
      switch(q.question_type){
        case 'Fill in the Blank': return a.value ? a.value : '<em>—</em>';
        case 'Multiple Choice': return a.value || '<em>—</em>';
        case 'True or False': {
          if (!a.value) return '<em>—</em>';
          return a.value.toLowerCase() === 'true' ? 'True' : 'False';
        }
        case 'Check All That Apply (or Multiple Select)': return (a.values||[]).join(' • ') || '<em>—</em>';
        case 'Drag and Drop': {
          return (q.items_to_match||[]).map((it, i)=> `${it.description} → ${a.assignments?.[i] || '—'}`).join(' | ');
        }
        case 'Matching': {
          return (q.pairs||[]).map((p, i)=> `${p.left} → ${a.choices?.[i] || '—'}`).join(' | ');
        }
        case 'Ordering (or Sequencing)': return (a.order||[]).join('  →  ') || '<em>—</em>';
        case 'Identify Incorrect Step': return a.value ? `Step ${a.value}` : '<em>—</em>';
        case 'Debate Question': return a.value ? a.value : '<em>—</em>';
        case 'Mixed Fill-in': {
          const blanks = a.blanks || {};
          return Object.keys(blanks).map(id => `${id}: ${blanks[id] || '<em>—</em>'}`).join(' | ') || '<em>—</em>';
        }
        default: return '<em>—</em>';
      }
    }

    let quizSummaryExpandedView = true; // Default to expanded view
    let quizSummaryScrollPosition = 0;

    async function showQuizResults() {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';

      // Only run AI marking if it hasn't been done yet
      if (!aiMarkingCompleted) {
        // Display marking in progress message
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'quiz-container';
        loadingDiv.style.textAlign = 'center';
        loadingDiv.style.padding = '60px 20px';
        loadingDiv.innerHTML = `
          <div class="gemini-inline-spinner" style="display: inline-block; margin-bottom: 20px;"></div>
          <h3 style="margin: 0 0 12px 0; color: #1976d2;">Marking Quiz...</h3>
          <p style="color: #666; margin: 0;">Estimated time: ~10 seconds</p>
        `;
        chatEl.appendChild(loadingDiv);

        // Process AI marking before showing results
        await processAIMarking();
        aiMarkingCompleted = true; // Mark as completed

        // Clear loading screen
        chatEl.innerHTML = '';
      }
      const container = document.createElement('div');
      container.className = 'quiz-container';

      let score = 0;
      const total = quizData.length;

      quizData.forEach((q, i) => {
        score += getQuizScore(i);
      });

      // Round score to 2 decimal places for display
      score = Math.round(score * 100) / 100;
      const pct = total ? Math.round((score/total)*100) : 0;

      // Score display with View All button
      const result = document.createElement('div');
      result.className = 'quiz-result';
      result.style.display = 'flex';
      result.style.justifyContent = 'space-between';
      result.style.alignItems = 'flex-start';
      result.style.flexWrap = 'wrap';

      const scoreSection = document.createElement('div');
      scoreSection.style.flex = '1';
      scoreSection.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <div class="quiz-score">${score} / ${total}</div>
        </div>
        <div class="quiz-kicker">${pct >= 80 ? 'Great job!' : (pct >= 50 ? 'Nice effort — review the misses.' : 'Keep practicing!')}</div>
        <div class="quiz-progress"><div style="width:${pct}%"></div></div>
        <div class="quiz-kicker" style="text-align:right">${pct}%</div>
      `;

      const viewAllBtn = document.createElement('button');
      viewAllBtn.className = 'quiz-btn';
      viewAllBtn.textContent = quizSummaryExpandedView ? 'Hide Details' : 'View All';
      viewAllBtn.style.marginLeft = '12px';
      viewAllBtn.style.minWidth = '120px'; // Fixed width to prevent layout shift
      viewAllBtn.onclick = () => {
        quizSummaryScrollPosition = chatEl.scrollTop;
        quizSummaryExpandedView = !quizSummaryExpandedView;
        showQuizResults();
        chatEl.scrollTop = quizSummaryScrollPosition;
      };

      result.appendChild(scoreSection);
      result.appendChild(viewAllBtn);
      container.appendChild(result);

      // Review items
      quizData.forEach((q, i) => {
        const item = document.createElement('div');
        item.className = 'quiz-review-item';
        const score = getQuizScore(i);
        const ok = score === 1;
        const partial = score > 0 && score < 1;

        // Determine status label
        let statusLabel;
        if (ok) {
          statusLabel = '<span style="color: #2e7d32;">✔️ Correct</span>';
        } else if (partial) {
          statusLabel = `<span style="color: #e65100;">⚠️ Partial (${score.toFixed(2)})</span>`;
        } else {
          statusLabel = '<span style="color: #c62828;">✖️</span> <span style="color: #e57373;">Incorrect</span>';
        }

        if (quizSummaryExpandedView) {
          // Expanded view - show side-by-side comparison
          item.style.paddingBottom = '10px'; // Remove extra padding for view button
          item.innerHTML = `<h4>${statusLabel} - Q${i+1}: <span class="quiz-review-question-text"></span></h4>`;

          const questionSpan = item.querySelector('.quiz-review-question-text');
          questionSpan.textContent = q.question_text;

          // Add comparison content
          const comparisonBody = document.createElement('div');
          comparisonBody.innerHTML = generateComparisonHTML(q, quizAnswers[i], i);
          item.appendChild(comparisonBody);
        } else {
          // Compact view - show summary with View button
          item.innerHTML = `
            <h4>${statusLabel} - Q${i+1}: <span class="quiz-review-question-text"></span></h4>
            <div class="quiz-review-line"><span class="quiz-badge">Your answer</span> <span class="quiz-review-user-answer"></span></div>
            <div class="quiz-review-line"><span class="quiz-badge">Correct</span> <span class="quiz-review-correct-answer"></span></div>
            <button class="quiz-review-view-btn" onclick="showQuizComparison(${i})">View</button>
          `;

          // Render LaTeX in the review item
          const questionSpan = item.querySelector('.quiz-review-question-text');
          questionSpan.textContent = q.question_text;

          const userAnswerSpan = item.querySelector('.quiz-review-user-answer');
          userAnswerSpan.innerHTML = formatQuizUserAnswer(q, quizAnswers[i]);

          const correctAnswerSpan = item.querySelector('.quiz-review-correct-answer');
          correctAnswerSpan.innerHTML = correctQuizAnswerText(q);
        }

        container.appendChild(item);

        // Typeset LaTeX for this item
        typesetEl(item);
      });

      // Buttons
      const nav = document.createElement('div');
      nav.className = 'quiz-nav';
      nav.style.justifyContent = 'space-between';

      const exitBtn = document.createElement('button');
      exitBtn.className = 'quiz-btn quiz-btn-secondary';
      exitBtn.textContent = 'Exit Quiz';
      exitBtn.onclick = () => {
        exitQuizMode();
      };

      const rightBtns = document.createElement('div');
      rightBtns.style.display = 'flex';
      rightBtns.style.gap = '8px';

      const newQuizBtn = document.createElement('button');
      newQuizBtn.className = 'quiz-btn quiz-btn-secondary';
      newQuizBtn.textContent = 'Generate Another Quiz';
      newQuizBtn.onclick = () => {
        // Reset quiz state
        quizData = [];
        quizCurrent = 0;
        quizAnswers = [];
        quizMode = false;
        quizCompleted = false;
        aiMarkingCompleted = false; // Reset marking state
        cachedQuizData = null; // Clear cache for fresh generation
        quizBtn.textContent = 'Quiz';

        // Trigger new quiz generation
        quizBtn.click();
      };

      const retakeBtn = document.createElement('button');
      retakeBtn.className = 'quiz-btn';
      retakeBtn.textContent = 'Retake Quiz';
      retakeBtn.onclick = () => {
        quizAnswers = new Array(quizData.length);
        quizCurrent = 0;
        quizCompleted = false; // Reset completion state for retake
        aiMarkingCompleted = false; // Reset marking state for retake
        renderQuizQuestion();
        chatEl.scrollTop = 0;
      };

      rightBtns.appendChild(newQuizBtn);
      rightBtns.appendChild(retakeBtn);
      nav.appendChild(exitBtn);
      nav.appendChild(rightBtns);
      container.appendChild(nav);

      chatEl.appendChild(container);

      // Scroll to top after appending content
      chatEl.scrollTop = 0;
    }

    // Generate comparison HTML for a question
    function generateComparisonHTML(q, userAnswer, questionIndex) {
      switch(q.question_type) {
        case 'Fill in the Blank':
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Answer</h3>
                <div>${userAnswer?.value || '<em>(No answer)</em>'}</div>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Answer</h3>
                <div>${q.correct_answer}</div>
              </div>
            </div>
          `;

        case 'Multiple Choice':
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Answer</h3>
                <div>${userAnswer?.value || '<em>(No answer)</em>'}</div>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Answer</h3>
                <div>${q.correct_option}</div>
              </div>
            </div>
            <div style="margin-top: 16px; padding: 12px; background: rgba(0,0,0,.02); border-radius: 8px;">
              <h3 style="margin: 0 0 8px 0; font-size: 14px;">All Options:</h3>
              <ul style="margin: 0; padding-left: 20px;">
                ${q.options.map(opt => `<li>${opt}</li>`).join('')}
              </ul>
            </div>
          `;

        case 'True or False': {
          const userVal = userAnswer?.value;
          const correctVal = q.correct_answer === 'true' ? 'True' : 'False';
          const userDisplay = userVal ? (userVal.toLowerCase() === 'true' ? 'True' : 'False') : '<em>(No answer)</em>';
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Answer</h3>
                <div>${userDisplay}</div>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Answer</h3>
                <div>${correctVal}</div>
              </div>
            </div>
          `;
        }

        case 'Check All That Apply (or Multiple Select)': {
          const userSelections = new Set((userAnswer?.values || []).map(canon));
          const correctSelections = new Set((q.correct_options || []).map(canon));

          // Build detailed feedback for each option
          const optionsFeedback = q.options.map(opt => {
            const optCanon = canon(opt);
            const userSelected = userSelections.has(optCanon);
            const shouldBeSelected = correctSelections.has(optCanon);

            let icon, color, status;
            if (userSelected && shouldBeSelected) {
              icon = '✅';
              color = '#2e7d32';
              status = 'Correct - Selected';
            } else if (!userSelected && !shouldBeSelected) {
              icon = '✓';
              color = '#666';
              status = 'Correct - Not selected';
            } else if (userSelected && !shouldBeSelected) {
              icon = '❌';
              color = '#c62828';
              status = 'Incorrect - Should not be selected';
            } else {
              icon = '⚠️';
              color = '#e65100';
              status = 'Missed - Should be selected';
            }

            return `<li style="margin: 6px 0; color: ${color};"><strong>${icon}</strong> ${opt} <em style="font-size: 12px; color: #999;">(${status})</em></li>`;
          }).join('');

          return `
            <div style="margin-bottom: 16px; padding: 12px; background: rgba(0,0,0,.02); border-radius: 8px;">
              <h3 style="margin: 0 0 12px 0; font-size: 14px;">Detailed Breakdown:</h3>
              <ul style="margin: 0; padding-left: 20px; list-style: none;">
                ${optionsFeedback}
              </ul>
            </div>
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Selections</h3>
                ${userAnswer?.values?.length > 0 ?
                  `<ul style="margin: 0; padding-left: 20px;">${userAnswer.values.map(s => `<li>${s}</li>`).join('')}</ul>` :
                  '<em>(No selections)</em>'
                }
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Selections</h3>
                <ul style="margin: 0; padding-left: 20px;">
                  ${q.correct_options.map(s => `<li>${s}</li>`).join('')}
                </ul>
              </div>
            </div>
          `;
        }

        case 'Drag and Drop': {
          const userDnD = userAnswer?.assignments || [];
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Placements</h3>
                ${q.items_to_match.map((item, idx) => {
                  const userChoice = userDnD[idx] || '<em>(Not placed)</em>';
                  return `<div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,.03); border-radius: 4px;">
                    <strong>${item.description}:</strong><br>
                    <span style="margin-left: 8px;">${userChoice}</span>
                  </div>`;
                }).join('')}
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Placements</h3>
                ${q.items_to_match.map(item => {
                  return `<div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,.03); border-radius: 4px;">
                    <strong>${item.description}:</strong><br>
                    <span style="margin-left: 8px;">${item.correct_option}</span>
                  </div>`;
                }).join('')}
              </div>
            </div>
            <div style="margin-top: 16px; padding: 12px; background: rgba(0,0,0,.02); border-radius: 8px;">
              <h3 style="margin: 0 0 8px 0; font-size: 14px;">Available Items:</h3>
              <div style="display: flex; flex-wrap: wrap; gap: 8px;">
                ${q.word_bank.map(word => `<span style="padding: 4px 8px; background: rgba(74,99,255,0.1); border-radius: 4px; font-size: 13px;">${word}</span>`).join('')}
              </div>
            </div>
          `;
        }

        case 'Matching': {
          const userMatching = userAnswer?.choices || [];
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Matches</h3>
                ${q.pairs.map((pair, idx) => {
                  const userMatch = userMatching[idx] || '<em>(Not matched)</em>';
                  return `<div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,.03); border-radius: 4px;">
                    <strong>${pair.left}</strong> → ${userMatch}
                  </div>`;
                }).join('')}
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Matches</h3>
                ${q.pairs.map(pair => {
                  return `<div style="margin: 8px 0; padding: 8px; background: rgba(0,0,0,.03); border-radius: 4px;">
                    <strong>${pair.left}</strong> → ${pair.right}
                  </div>`;
                }).join('')}
              </div>
            </div>
          `;
        }

        case 'Ordering (or Sequencing)': {
          const userSequence = userAnswer?.order || q.sequence_items || [];
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Sequence</h3>
                <ol style="margin: 0; padding-left: 20px;">
                  ${userSequence.map(item => `<li style="margin: 4px 0;">${item}</li>`).join('')}
                </ol>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Sequence</h3>
                <ol style="margin: 0; padding-left: 20px;">
                  ${q.correct_sequence.map(item => `<li style="margin: 4px 0;">${item}</li>`).join('')}
                </ol>
              </div>
            </div>
          `;
        }

        case 'Identify Incorrect Step': {
          const userStepNum = userAnswer?.value;
          const correctStepNum = q.correct_answer;
          return `
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Answer</h3>
                <div>${userStepNum ? `Step ${userStepNum}` : '<em>(No answer)</em>'}</div>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Correct Answer</h3>
                <div>Step ${correctStepNum}</div>
                ${q.explanation ? `<div style="margin-top: 8px; padding: 8px; background: rgba(46, 125, 50, 0.1); border-radius: 4px; font-size: 13px;">${q.explanation}</div>` : ''}
              </div>
            </div>
            <div style="margin-top: 16px; padding: 12px; background: rgba(0,0,0,.02); border-radius: 8px;">
              <h3 style="margin: 0 0 8px 0; font-size: 14px;">All Steps:</h3>
              <ol style="margin: 0; padding-left: 20px;">
                ${q.steps.map((step, idx) => {
                  const isCorrectStep = (idx + 1) === correctStepNum;
                  const stepStyle = isCorrectStep ? 'color: #c62828; font-weight: 600;' : '';
                  return `<li style="margin: 4px 0; ${stepStyle}">${step}${isCorrectStep ? ' ❌' : ''}</li>`;
                }).join('')}
              </ol>
            </div>
          `;
        }

        case 'Debate Question': {
          const userAnswerText = userAnswer?.value || '';
          const aiResult = userAnswer?.aiMarkingResult;
          const score = aiResult?.score || 0;
          const correctPerson = aiResult?.correctPerson || false;
          const correctArgument = aiResult?.correctArgument || false;

          // Determine score feedback
          let scoreFeedback = '';
          if (score === 1) {
            scoreFeedback = '<div style="padding: 10px; background: rgba(76, 175, 80, 0.1); border-left: 4px solid #4caf50; border-radius: 6px; margin-bottom: 12px; font-size: 13px;">✅ <strong>Full marks!</strong> Correct person and sound argument.</div>';
          } else if (score === 0.25) {
            scoreFeedback = '<div style="padding: 10px; background: rgba(255, 152, 0, 0.1); border-left: 4px solid #ff9800; border-radius: 6px; margin-bottom: 12px; font-size: 13px;">⚠️ <strong>Partial marks (0.25)</strong> - Correct person identified, but argument needs improvement.</div>';
          } else {
            scoreFeedback = '<div style="padding: 10px; background: rgba(244, 67, 54, 0.1); border-left: 4px solid #f44336; border-radius: 6px; margin-bottom: 12px; font-size: 13px;">❌ <strong>Incorrect</strong> - Review the model answer below.</div>';
          }

          return `
            ${scoreFeedback}
            <div style="margin-bottom: 16px; padding: 14px 18px; background: rgba(255, 193, 7, 0.08); border-left: 4px solid #ffc107; border-radius: 8px;">
              <h3 style="margin: 0 0 12px 0; font-size: 14px;">Scenario:</h3>
              <div>${q.question_text}</div>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
              <div style="padding: 12px; background: rgba(33, 150, 243, 0.08); border-left: 4px solid #2196f3; border-radius: 8px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; color: #2196f3;">👤 Person A:</h4>
                <div style="font-size: 13px;">${q.person_a_statement}</div>
              </div>
              <div style="padding: 12px; background: rgba(156, 39, 176, 0.08); border-left: 4px solid #9c27b0; border-radius: 8px;">
                <h4 style="margin: 0 0 8px 0; font-size: 13px; color: #9c27b0;">👤 Person B:</h4>
                <div style="font-size: 13px;">${q.person_b_statement}</div>
              </div>
            </div>
            <div class="quiz-comparison-columns">
              <div class="quiz-comparison-column incorrect">
                <h3>Your Answer</h3>
                <div style="white-space: pre-wrap; line-height: 1.6;">${userAnswerText || '<em>(No answer)</em>'}</div>
              </div>
              <div class="quiz-comparison-column correct">
                <h3>Model Answer</h3>
                <div style="white-space: pre-wrap; line-height: 1.6;">${q.correct_answer}</div>
              </div>
            </div>
          `;
        }

        case 'Mixed Fill-in': {
          const blanks = q.blanks || [];
          const userBlanks = userAnswer?.blanks || {};
          const aiResults = userAnswer?.aiMarkingResults || {};

          // Build detailed breakdown for each blank
          const blanksBreakdown = blanks.map((blank, idx) => {
            const userAns = userBlanks[blank.id] || '';
            const correctAnswer = blank.correct_answer || '';
            const aiResult = aiResults[blank.id];

            // Determine if correct using AI marking or exact match
            let isCorrect;
            let aiScore = null;
            if (aiResult !== undefined) {
              if (typeof aiResult === 'boolean') {
                isCorrect = aiResult;
              } else if (typeof aiResult === 'object' && aiResult.score !== undefined) {
                aiScore = aiResult.score;
                isCorrect = aiScore >= 0.5; // Partial credit threshold
              } else {
                isCorrect = canon(userAns) === canon(correctAnswer);
              }
            } else {
              isCorrect = canon(userAns) === canon(correctAnswer);
            }

            const statusIcon = aiScore !== null && aiScore > 0 && aiScore < 1 ? '⚠️' : (isCorrect ? '✅' : '❌');
            const statusColor = aiScore !== null && aiScore > 0 && aiScore < 1 ? '#e65100' : (isCorrect ? '#2e7d32' : '#c62828');
            const bgColor = aiScore !== null && aiScore > 0 && aiScore < 1 ? 'rgba(255, 152, 0, 0.05)' : (isCorrect ? 'rgba(46, 125, 50, 0.05)' : 'rgba(244, 67, 54, 0.05)');
            const borderColor = aiScore !== null && aiScore > 0 && aiScore < 1 ? '#ff9800' : (isCorrect ? '#2e7d32' : '#f44336');

            return `
              <div style="margin: 12px 0; padding: 12px; background: ${bgColor}; border-left: 4px solid ${borderColor}; border-radius: 6px;">
                <div style="font-weight: 600; margin-bottom: 6px; color: ${statusColor};">
                  ${statusIcon} ${blank.id} (${blank.type === 'text' ? 'Fill-in' : 'Dropdown'})${aiScore !== null ? ` - Score: ${aiScore.toFixed(2)}` : ''}
                </div>
                <div style="font-size: 13px; margin: 4px 0;">
                  <strong>Your answer:</strong> ${userAns || '<em>(blank)</em>'}
                </div>
                <div style="font-size: 13px; margin: 4px 0; color: #2e7d32;">
                  <strong>Correct answer:</strong> ${correctAnswer}
                </div>
                <div style="font-size: 12px; margin-top: 6px; padding: 6px 8px; background: rgba(74, 99, 255, 0.08); border-radius: 4px; color: #666;">
                  💡 Hint: ${blank.hint}
                </div>
              </div>
            `;
          }).join('');

          // Reconstruct the full sentence with answers
          let reconstructedText = q.question_text;
          blanks.forEach(blank => {
            const userAnswer = userBlanks[blank.id] || '_____';
            reconstructedText = reconstructedText.replace(`{${blank.id}}`, `<strong style="color: #4a63ff;">${userAnswer}</strong>`);
          });

          return `
            <div style="margin-bottom: 16px; padding: 14px 18px; background: rgba(74, 99, 255, 0.05); border-left: 4px solid #4a63ff; border-radius: 8px;">
              <h3 style="margin: 0 0 8px 0; font-size: 14px;">Your Complete Answer:</h3>
              <div style="font-size: 14px; line-height: 1.8;">${reconstructedText}</div>
            </div>
            <h3 style="margin: 16px 0 8px 0; font-size: 15px;">Breakdown by Blank:</h3>
            ${blanksBreakdown}
          `;
        }

        default:
          return '<em>Unknown question type</em>';
      }
    }

    // Show quiz comparison inline
    window.showQuizComparison = function(questionIndex) {
      quizSummaryScrollPosition = chatEl.scrollTop;

      const q = quizData[questionIndex];
      const userAnswer = quizAnswers[questionIndex];
      const isCorrect = isQuizCorrect(questionIndex);

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      const container = document.createElement('div');
      container.className = 'quiz-container';

      // Header with correct/incorrect status
      const header = document.createElement('div');
      header.style.textAlign = 'center';
      header.style.marginBottom = '20px';

      const statusBadge = document.createElement('div');
      statusBadge.style.fontSize = '20px';
      statusBadge.style.fontWeight = '700';
      statusBadge.style.padding = '12px 20px';
      statusBadge.style.borderRadius = '8px';
      statusBadge.style.display = 'inline-block';
      statusBadge.style.marginBottom = '12px';
      statusBadge.textContent = isCorrect ? '✔️ Correct' : '✖️ Incorrect';
      statusBadge.style.background = isCorrect ? 'rgba(46, 125, 50, 0.1)' : 'rgba(198, 40, 40, 0.1)';
      statusBadge.style.color = isCorrect ? '#2e7d32' : '#c62828';

      const questionTitle = document.createElement('h3');
      questionTitle.style.margin = '0 0 8px 0';
      questionTitle.textContent = `Question ${questionIndex + 1}`;

      const questionText = document.createElement('p');
      questionText.style.margin = '0';
      questionText.textContent = q.question_text;

      header.appendChild(statusBadge);
      header.appendChild(questionTitle);
      header.appendChild(questionText);
      container.appendChild(header);

      // Generate comparison
      const comparisonBody = document.createElement('div');
      comparisonBody.innerHTML = generateComparisonHTML(q, userAnswer, questionIndex);
      container.appendChild(comparisonBody);

      // Back button
      const nav = document.createElement('div');
      nav.className = 'quiz-nav';
      nav.style.marginTop = '20px';
      const backBtn = document.createElement('button');
      backBtn.className = 'quiz-btn';
      backBtn.textContent = '← Back to Summary';
      backBtn.onclick = () => {
        showQuizResults();
        chatEl.scrollTop = quizSummaryScrollPosition;
      };
      nav.appendChild(backBtn);
      container.appendChild(nav);

      chatEl.appendChild(container);

      // Typeset LaTeX in the comparison
      typesetEl(container);
      chatEl.scrollTop = 0;
    };

    // Quiz button handler
    quizBtn.addEventListener("click", async () => {
      // If quiz was rate limited in background, show rate limit dialog
      if (quizRateLimited) {
        console.log('[Quiz] Showing rate limit dialog after background rate limit');
        quizRateLimited = false;
        quizBtn.textContent = 'Quiz';

        // Show rate limit dialog
        const useFlash = await new Promise((resolve) => {
          saveChatBeforeClearing();
          chatEl.innerHTML = '';
          controlsEl.style.display = 'none';
          inputRowEl.style.display = 'none';
          attEl.style.display = 'none';
          quizBtn.style.display = 'none';

          const container = document.createElement('div');
          container.className = 'quiz-generating';
          container.innerHTML = `
            <div class="quiz-gen-text">⚠️ Rate Limited</div>
            <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model was rate limited during quiz generation. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the quiz.</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn" id="quiz-rate-limit-cancel">Try Again Later</button>
              <button class="flashcard-btn flashcard-btn-primary" id="quiz-rate-limit-flash">Use Flash Model</button>
            </div>
          `;
          chatEl.appendChild(container);

          document.getElementById('quiz-rate-limit-cancel').onclick = () => resolve(false);
          document.getElementById('quiz-rate-limit-flash').onclick = () => resolve(true);
        });

        if (!useFlash) {
          // User chose to try again later - restore UI
          restoreSavedChatContent();
          controlsEl.style.display = '';
          inputRowEl.style.display = '';
          attEl.style.display = '';
          quizBtn.style.display = '';
          updateHeaderSubtitle('Ask about this slide');
          return;
        }

        // User chose to use Flash model - restart quiz generation with Flash
        console.log('[Quiz] User chose to use Flash model after background rate limit');
        quizGenerating = true;
        quizGeneratingInBackground = false;
        // Generate quiz will use Flash model since Pro was rate limited
        // The function will be called below
      }

      // If quiz already exists, continue it or show summary
      if (quizData.length > 0 && (quizBtn.textContent === 'Continue Quiz' || quizBtn.textContent === 'Quiz Summary')) {
        console.log(quizCompleted ? "Showing quiz summary" : "Continuing existing quiz");
        enterQuizMode(null); // Pass null to not reset the quiz data
        return;
      }

      // If cached quiz exists, use it immediately
      if (cachedQuizData && quizBtn.textContent === 'Quiz (Ready)') {
        console.log("Using cached quiz data");
        quizData = cachedQuizData;
        cachedQuizData = null; // Clear cache after using
        quizGeneratingInBackground = false;
        quizBtn.textContent = 'Quiz';
        enterQuizMode(quizData);
        return;
      }

      // If quiz is generating in background, show the generating UI
      if (quizGeneratingInBackground || quizGenerating) {
        console.log("Quiz still generating in background - showing UI");
        quizGenerating = true;
        quizGeneratingInBackground = false;
        quizBtn.style.display = 'none';

        // Show quiz generation UI
        showQuizGenerating();
        updateHeaderSubtitle('Generating Quiz...');
        return;
      }

      console.log("Quiz button clicked - starting quiz generation");
      setError("");
      quizGenerating = true;
      quizBtn.style.display = 'none'; // Hide quiz button during generation

      // Prevent thinking state UI and clear any existing bubbles
      lastPendingBubble = null;
      setThinkingState(false);

      // Show quiz generation UI (this clears chat and prevents thinking bubble)
      showQuizGenerating();
      updateHeaderSubtitle('Generating Quiz...');

      // Retry logic for handling JSON parse errors
      let malformedRetryCount = 0;
      const maxMalformedRetries = 5;
      let quiz = null;
      let modelToUse = MODEL_PRO; // Track which model to use across retries
      let finalUsedModel = null;

      while (!quiz) {
        try {
          if (malformedRetryCount > 0) {
            console.log(`Retry attempt ${malformedRetryCount}/${maxMalformedRetries} due to malformed JSON`);
            const genStatus = chatEl.querySelector('.quiz-generating-status');
            if (genStatus) {
              genStatus.classList.remove('fade-out');
              genStatus.innerHTML = `
                <div style="margin-bottom: 8px;">⚠️ Malformed response detected</div>
                <div style="font-size: 12px;">Retrying (${malformedRetryCount}/${maxMalformedRetries})...</div>
              `;
              // Fade out after 3 seconds, then clear content
              setTimeout(() => {
                genStatus.classList.add('fade-out');
                setTimeout(() => {
                  genStatus.innerHTML = '';
                }, 500); // Wait for fade transition to complete
              }, 3000);
            }
            // Add delay before retry to prevent spam
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

        // Suppress the fetch interceptor during quiz generation
        suppressIntercept = true;

        // Fetch quiz generation prompt from backend
        console.log('[Quiz] Fetching quiz generation prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/quiz-generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const promptData = await promptResponse.json();
        let promptText = promptData.prompt;

        // Append YouTube-specific instructions if on YouTube
        if (isYouTubePage()) {
          promptText += "\n\nIMPORTANT: For this YouTube video, the attached text files represent: (1) the video summary as 'lecture slides', and (2) the audio transcript if available. Generate the quiz based on these attached documents only. Treat the video summary text as if it were lecture slides content.";
        }

        console.log("Prompt loaded from backend:", promptText.substring(0, 100) + "...");

        // Initialize files if not already done
        if (!filesInitialized && !filesInitializing) {
          await initializeFiles(null);
        } else if (filesInitializing) {
          // Wait for initialization to complete
          while (filesInitializing) {
            await new Promise(r => setTimeout(r, 100));
          }
        }

        // Use the already uploaded files
        const vttUri = uploadedVttUri;
        const pdfUri = uploadedPdfUri;

        console.log("Using uploaded files - VTT:", vttUri, "PDF:", pdfUri);

        // Build request
        const parts = [{ text: promptText }];
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        if (pdfUri) parts.push({ fileData: { mimeType: pdfMimeType, fileUri: pdfUri } });
        if (vttUri) parts.push({ fileData: { mimeType: "text/plain", fileUri: vttUri } });

        const body = {
          contents: [{ parts }]
        };

        logModelUsage('Quiz', modelToUse, `attempt ${malformedRetryCount + 1}`);
        await waitForApiKey();

        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 120000); // 120 seconds

        let resp;
        let usedModel = modelToUse;

        try {
          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${modelToUse}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: controller.signal
            }
          );
          clearTimeout(timeoutId);

          // Check for 429 rate limit error
          if (resp.status === 429) {
            const errorData = await resp.json();
            console.log(`${modelToUse} model rate limited`);

            // Cascade through models: Pro -> Flash -> Flash Lite
            if (modelToUse === MODEL_PRO) {
              console.log("Pro model rate limited for quiz");

              // If generating in background, mark as rate limited and exit
              if (quizGeneratingInBackground) {
                console.log('[Quiz] Rate limited in background - will show dialog when user returns');
                quizRateLimited = true;
                quizGeneratingInBackground = false;
                quizGenerating = false;
                quizBtn.textContent = 'Quiz (Rate Limited)';
                throw new Error('Rate limited - user needs to decide');
              }

              // Show rate limit dialog with option to use Flash model
              const useFlash = await new Promise((resolve) => {
                saveChatBeforeClearing();
                chatEl.innerHTML = '';
                controlsEl.style.display = 'none';
                inputRowEl.style.display = 'none';
                attEl.style.display = 'none';

                const container = document.createElement('div');
                container.className = 'quiz-generating';
                container.innerHTML = `
                  <div class="quiz-gen-text">⚠️ Rate Limited</div>
                  <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model has been rate limited. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the quiz.</div>
                  <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
                    <button class="flashcard-btn" id="quiz-rate-limit-cancel">Try Again Later</button>
                    <button class="flashcard-btn flashcard-btn-primary" id="quiz-rate-limit-flash">Use Flash Model</button>
                  </div>
                `;
                chatEl.appendChild(container);

                document.getElementById('quiz-rate-limit-cancel').onclick = () => resolve(false);
                document.getElementById('quiz-rate-limit-flash').onclick = () => resolve(true);
              });

              if (!useFlash) {
                // User chose to try again later - restore UI and exit
                restoreSavedChatContent();
                controlsEl.style.display = '';
                inputRowEl.style.display = '';
                attEl.style.display = '';
                quizBtn.style.display = '';
                quizGenerating = false;
                updateHeaderSubtitle('Ask about this slide');
                throw new Error('User chose to try again later');
              }

              // User chose to use Flash model - continue with Flash
              console.log('[Quiz] User chose to use Flash model');
              modelToUse = MODEL_FLASH;
              logModelUsage('Quiz', modelToUse, 'retry after rate limit');

              // Show continuing with Flash message
              showQuizGenerating();
              const genStatus = chatEl.querySelector('.quiz-generating-status');
              if (genStatus) {
                genStatus.classList.remove('fade-out');
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">⚠️ Using Flash model</div>
                  <div style="font-size: 12px;">Quality may be degraded...</div>
                `;
                setTimeout(() => {
                  genStatus.classList.add('fade-out');
                  setTimeout(() => { genStatus.innerHTML = ''; }, 500);
                }, 4000);
              }

              // Retry with Flash
              const flashController = new AbortController();
              const flashTimeoutId = setTimeout(() => flashController.abort(), 120000);
              resp = await proxiedFetchForAI(
                `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                  signal: flashController.signal
                }
              );
              clearTimeout(flashTimeoutId);
              usedModel = MODEL_FLASH;

              // Check if Flash is also rate limited
              if (resp.status === 429) {
                modelToUse = MODEL_FLASHLITE; // Update persistent model tracker
                console.log("Flash also rate limited, switching to Flash Lite");
                logModelUsage('Quiz', modelToUse, 'retry after second rate limit');

                const retryAfter = resp.headers.get('retry-after');
                setRateLimitNotice(retryAfter);

                const genStatus2 = chatEl.querySelector('.quiz-generating-status');
                if (genStatus2) {
                  genStatus2.classList.remove('fade-out');
                  genStatus2.innerHTML = `
                    <div style="margin-bottom: 8px;">⚠️ Flash model also rate limited</div>
                    <div style="font-size: 12px;">Switching to Flash Lite...</div>
                  `;
                  setTimeout(() => {
                    genStatus2.classList.add('fade-out');
                    setTimeout(() => { genStatus2.innerHTML = ''; }, 500);
                  }, 4000);
                }

                const liteController = new AbortController();
                const liteTimeoutId = setTimeout(() => liteController.abort(), 120000);
                resp = await proxiedFetchForAI(
                  `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: liteController.signal
                  }
                );
                clearTimeout(liteTimeoutId);
                usedModel = MODEL_FLASHLITE;
              }
            } else if (modelToUse === MODEL_FLASH) {
              console.log("Flash rate limited, switching to Flash Lite");
              modelToUse = MODEL_FLASHLITE; // Update persistent model tracker
              logModelUsage('Quiz', modelToUse, 'retry after rate limit');

              const retryAfter = resp.headers.get('retry-after');
              setRateLimitNotice(retryAfter);

              const genStatus = chatEl.querySelector('.quiz-generating-status');
              if (genStatus) {
                genStatus.classList.remove('fade-out');
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">⚠️ Flash model rate limited</div>
                  <div style="font-size: 12px;">Switching to Flash Lite...</div>
                `;
                setTimeout(() => {
                  genStatus.classList.add('fade-out');
                  setTimeout(() => { genStatus.innerHTML = ''; }, 500);
                }, 4000);
              }

              const liteController = new AbortController();
              const liteTimeoutId = setTimeout(() => liteController.abort(), 120000);
              resp = await proxiedFetchForAI(
                `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`,
                {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                  signal: liteController.signal
                }
              );
              clearTimeout(liteTimeoutId);
              usedModel = MODEL_FLASHLITE;
            }
            // If Flash Lite is rate limited, just continue with the 429 response and let it fail/retry
          }
        } catch (err) {
          clearTimeout(timeoutId);
          if (err.name === 'AbortError') {
            throw new Error("Request timed out after 120 seconds");
          }
          throw err;
        }

        console.log(`Response status: ${resp.status} (using ${usedModel})`);

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(resp.status, usedModel);

        const data = await resp.json();
        console.log("Raw response:", data);

        const explanation = extractExplanation(data);
        console.log("Extracted text:", explanation);

        if (!explanation) {
          throw new Error("No response text from Gemini");
        }

        // Parse JSON from response
        let quizJson = explanation;

        // Try to extract JSON if wrapped in markdown code blocks
        const jsonMatch = explanation.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          quizJson = jsonMatch[1];
        } else {
          // Try to find array directly
          const arrayMatch = explanation.match(/\[\s*\{[\s\S]*\}\s*\]/);
          if (arrayMatch) {
            quizJson = arrayMatch[0];
          }
        }

        console.log("Parsing quiz JSON:", quizJson.substring(0, 200) + "...");

        try {
          quiz = JSON.parse(quizJson.trim());
        } catch (parseError) {
          console.error("JSON parse error:", parseError.message);
          malformedRetryCount++;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error(`Failed to parse quiz JSON after ${maxMalformedRetries} retries: ${parseError.message}`);
          }
          // Continue to next retry iteration
          continue;
        }

        if (!Array.isArray(quiz) || quiz.length === 0) {
          console.error("Invalid quiz format - not an array or empty");
          malformedRetryCount++;
          quiz = null; // Reset quiz to retry
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error("Invalid quiz format - expected array of questions");
          }
          continue;
        }

        console.log("Quiz parsed successfully:", quiz.length, "questions");
        finalUsedModel = usedModel;
        logModelUsage('Quiz', finalUsedModel, 'response received');
        break; // Success, exit retry loop

      } catch (e) {
        console.error("Quiz generation attempt failed:", e);

        const errMsg = (e?.message || e)?.toString() || '';
        if (errMsg.includes('user needs to decide') || errMsg.includes('User chose to try again later')) {
          suppressIntercept = false;
          quizGenerating = false;
          quizGeneratingInBackground = false;
          return;
        }

        // Check if this is a malformed JSON error (already counted above)
        // or a network/timeout error (not counted, should retry indefinitely)
        const isMalformedError = e.message && e.message.includes('Failed to parse quiz JSON');

        if (isMalformedError) {
          // This is a malformed JSON error that already incremented the counter
          // Check if we've exceeded max retries
          if (malformedRetryCount > maxMalformedRetries) {
            // Final failure after all retries
            console.error("Quiz generation failed after all retries:", e);

            // If it was running in background, just update button
            if (quizGeneratingInBackground) {
              quizGeneratingInBackground = false;
              quizBtn.textContent = 'Quiz';
              console.log("Background generation failed");
              return;
            }

            setError("Quiz generation failed: " + (e?.message || e));
            restoreSavedChatContent();
            appendMessage("bot", "Failed to generate quiz. Please try again.");
            quizBtn.style.display = ''; // Show quiz button again on error
            updateHeaderSubtitle('Ask about this slide');

            // Restore UI on error
            controlsEl.style.display = '';
            inputRowEl.style.display = '';
            attEl.style.display = '';
            suppressIntercept = false;
            quizGenerating = false;
            return;
          }
        }
        // For network/timeout errors, add delay before retry (don't count against limit)
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } // End of retry while loop

    // Check if we have a valid quiz after retries
    if (quiz) {
      try {
        // Clear countdown interval
        if (quizCountdownInterval) {
          clearInterval(quizCountdownInterval);
          quizCountdownInterval = null;
          quizCountdownStartTime = null;
          quizCountdownPhase = 1;
        }

        // Check if generation was moved to background
        if (!quizGenerating && quizGeneratingInBackground) {
          // User stopped watching, cache the quiz for later use
          console.log("Generation completed in background, caching quiz data");
          cachedQuizData = quiz;
          quizGeneratingInBackground = false;

          // Update button text to show quiz is ready
          quizBtn.textContent = 'Quiz (Ready)';
          return;
        }

        // Check if user is watching the generation
        if (!quizGenerating) {
          // Shouldn't happen, but cache it just in case
          console.log("Unexpected state, caching quiz data");
          cachedQuizData = quiz;
          quizGeneratingInBackground = false;
          return;
        }

        // Enter quiz mode
        enterQuizMode(quiz);

      } catch (e) {
        console.error("Quiz mode entry failed:", e);

        // If it was running in background, just update button
        if (quizGeneratingInBackground) {
          quizGeneratingInBackground = false;
          quizBtn.textContent = 'Quiz';
          console.log("Background generation failed");
          return;
        }

        setError("Quiz generation failed: " + (e?.message || e));
        restoreSavedChatContent();
        appendMessage("bot", "Failed to generate quiz. Please try again.");
        quizBtn.style.display = ''; // Show quiz button again on error
        updateHeaderSubtitle('Ask about this slide');

        // Restore UI on error
        controlsEl.style.display = '';
        inputRowEl.style.display = '';
        attEl.style.display = '';
        suppressIntercept = false;
        quizGenerating = false;
      }
    } else {
      // No valid quiz after retries
      console.error("Failed to generate valid quiz after all retries");

      if (quizGeneratingInBackground) {
        quizGeneratingInBackground = false;
        quizBtn.textContent = 'Quiz';
        console.log("Background generation failed");
        return;
      }

      setError("Quiz generation failed: Unable to generate valid quiz format");
      restoreSavedChatContent();
      appendMessage("bot", "Failed to generate quiz. Please try again.");
      quizBtn.style.display = ''; // Show quiz button again on error
      updateHeaderSubtitle('Ask about this slide');

      // Restore UI on error
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      suppressIntercept = false;
      quizGenerating = false;
    }
    });

    // ===== FLASHCARD FUNCTIONALITY =====
    let flashcardData = [];
    let cachedFlashcardData = null;
    let flashcardCurrent = 0;
    let flashcardMode = false;
    let flashcardGenerating = false;
    let flashcardGeneratingInBackground = false;
    let flashcardRateLimited = false; // Track if flashcard generation was rate limited in background
    let flashcardRequestedCount = 15; // Store the requested flashcard count for ETA calculation
    let flashcardCountdownInterval = null;
    let flashcardCountdownStartTime = null;
    let flashcardCountdownPhase = 1;

    // Test Me mode variables
    let testMeMode = false;
    let testMeData = []; // Array of {question, correctAnswer, options: [5 strings]}
    let testMeCurrent = 0;
    let testMeScore = 0;
    let testMeGenerating = false;
    let testMeGeneratingInBackground = false;
    let testMeAnswers = []; // Track user's answers for each question: {selectedIndex: number, isCorrect: boolean}
    let testMeReviewMode = false; // True when reviewing answers after completion

    flashcardBtn.addEventListener("click", async () => {
      // If flashcard was rate limited in background, show rate limit dialog
      if (flashcardRateLimited) {
        console.log('[Flashcards] Showing rate limit dialog after background rate limit');
        flashcardRateLimited = false;
        flashcardBtn.textContent = 'Flashcards';

        // Show rate limit dialog
        const useFlash = await new Promise((resolve) => {
          saveChatBeforeClearing();
          chatEl.innerHTML = '';
          controlsEl.style.display = 'none';
          inputRowEl.style.display = 'none';
          attEl.style.display = 'none';
          flashcardBtn.style.display = 'none';

          const container = document.createElement('div');
          container.className = 'quiz-generating';
          container.innerHTML = `
            <div class="quiz-gen-text">⚠️ Rate Limited</div>
            <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model was rate limited during flashcard generation. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the flashcards.</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn" id="flashcard-rate-limit-cancel">Try Again Later</button>
              <button class="flashcard-btn flashcard-btn-primary" id="flashcard-rate-limit-flash">Use Flash Model</button>
            </div>
          `;
          chatEl.appendChild(container);

          document.getElementById('flashcard-rate-limit-cancel').onclick = () => resolve(false);
          document.getElementById('flashcard-rate-limit-flash').onclick = () => resolve(true);
        });

        if (!useFlash) {
          // User chose to try again later - restore UI
          restoreSavedChatContent();
          controlsEl.style.display = '';
          inputRowEl.style.display = '';
          attEl.style.display = '';
          flashcardBtn.style.display = '';
          updateHeaderSubtitle('Ask about this slide');
          return;
        }

        // User chose to use Flash model - restart flashcard generation with Flash
        console.log('[Flashcards] User chose to use Flash model after background rate limit');
        flashcardGenerating = true;
        flashcardGeneratingInBackground = false;
      }

      // If cached flashcards exist, use them immediately
      if (cachedFlashcardData && flashcardBtn.textContent === 'Flashcards (Ready)') {
        console.log("Using cached flashcard data");
        flashcardData = cachedFlashcardData;
        cachedFlashcardData = null;
        flashcardGeneratingInBackground = false;
        flashcardBtn.textContent = 'Flashcards';
        enterFlashcardMode();
        return;
      }

      // If flashcards are generating in background, show the generating UI
      if (flashcardGeneratingInBackground || flashcardGenerating) {
        console.log("Flashcards still generating in background - showing UI");
        flashcardGenerating = true;
        flashcardGeneratingInBackground = false;
        flashcardBtn.style.display = 'none';
        showFlashcardGenerating(flashcardRequestedCount);
        updateHeaderSubtitle('Generating Flashcards...');
        return;
      }

      // If flashcards already exist, show option to view or regenerate
      if (flashcardData.length > 0) {
        saveChatBeforeClearing();
        chatEl.innerHTML = '';
        controlsEl.style.display = 'none';
        inputRowEl.style.display = 'none';
        attEl.style.display = 'none';
        flashcardBtn.style.display = 'none';

        chatEl.innerHTML = `
          <div class="quiz-generating">
            <div class="quiz-gen-text">Flashcards Available</div>
            <div class="quiz-gen-subtext">You have ${flashcardData.length} flashcards from a previous generation</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn flashcard-btn-primary" onclick="viewPreviousFlashcards()">View Previous Flashcards</button>
              <button class="flashcard-btn" onclick="generateNewFlashcards()">Generate New</button>
            </div>
          </div>
        `;
        return;
      }

      // Otherwise, ask how many flashcards to generate
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      flashcardBtn.style.display = 'none';

      chatEl.innerHTML = `
        <div class="quiz-generating">
          <div class="quiz-gen-text">Generate Flashcards</div>
          <div class="quiz-gen-subtext">How many flashcards would you like to generate?</div>
          <div style="margin-top: 24px;">
            <input type="number" id="flashcard-count-input" min="5" max="50" value="15" style="padding: 10px; font-size: 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); width: 100px; text-align: center; margin-bottom: 16px;">
            <div style="display: flex; gap: 12px; justify-content: center;">
              <button class="flashcard-btn flashcard-btn-primary" onclick="startFlashcardGeneration()">Generate</button>
              <button class="flashcard-btn" onclick="exitFlashcardMode()">Cancel</button>
            </div>
          </div>
        </div>
      `;
    });

    function showFlashcardGenerating(flashcardCount) {
      // Don't update UI if generating in background
      if (flashcardGeneratingInBackground) return;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      // Calculate ETA: 8.998 + 7.713 * sqrt(x) seconds
      const initialEta = Math.round(8.998 + 7.713 * Math.sqrt(flashcardCount || 15));

      // Calculate current countdown value if timer is already running
      let currentCountdown = initialEta;
      if (flashcardCountdownStartTime) {
        const elapsed = Math.floor((Date.now() - flashcardCountdownStartTime) / 1000);
        if (flashcardCountdownPhase === 1) {
          currentCountdown = Math.max(0, initialEta - elapsed);
        } else if (flashcardCountdownPhase === 2) {
          currentCountdown = Math.max(0, 19 - (elapsed - initialEta));
        }
      }

      const container = document.createElement('div');
      container.className = 'quiz-generating flashcard-generating-container';
      container.innerHTML = `
        <div class="quiz-gen-spinner"></div>
        <div class="quiz-gen-text">Generating Your Flashcards...</div>
        <div class="quiz-gen-subtext">Creating study cards from lecture content</div>
        <div class="quiz-gen-eta flashcard-eta" style="font-size: 13px; color: #666; margin-top: 8px;">ETA: ${currentCountdown} seconds</div>
        <div class="flashcard-generating-status"></div>
        <button class="quiz-gen-stop" id="flashcard-gen-stop-btn">Exit</button>
      `;
      chatEl.appendChild(container);

      // Only start countdown timer if not already running
      if (!flashcardCountdownInterval) {
        flashcardCountdownStartTime = Date.now();
        flashcardCountdownPhase = 1;

        flashcardCountdownInterval = setInterval(() => {
          const etaElement = document.querySelector('.flashcard-eta');
          if (!etaElement) return;

          const elapsed = Math.floor((Date.now() - flashcardCountdownStartTime) / 1000);

          if (flashcardCountdownPhase === 1) {
            const remaining = Math.max(0, initialEta - elapsed);
            if (remaining > 0) {
              etaElement.textContent = `ETA: ${remaining} seconds`;
            } else {
              flashcardCountdownPhase = 2;
            }
          } else if (flashcardCountdownPhase === 2) {
            const remaining = Math.max(0, 19 - (elapsed - initialEta));
            if (remaining > 0) {
              etaElement.textContent = `Hold tight, it's almost done: ${remaining} seconds`;
            } else {
              flashcardCountdownPhase = 3;
              etaElement.textContent = "Sorry, this is taking longer than expected...";
              clearInterval(flashcardCountdownInterval);
              flashcardCountdownInterval = null;
            }
          } else if (flashcardCountdownPhase === 3) {
            etaElement.textContent = "Sorry, this is taking longer than expected...";
          }
        }, 1000);
      }

      const stopBtn = container.querySelector('#flashcard-gen-stop-btn');
      stopBtn.addEventListener('click', () => {
        console.log("User stopped watching flashcard generation - continuing in background");

        flashcardGenerating = false;
        flashcardGeneratingInBackground = true;
        restoreSavedChatContent();
        controlsEl.style.display = '';
        inputRowEl.style.display = '';
        attEl.style.display = '';
        flashcardBtn.style.display = '';
        flashcardBtn.textContent = 'Flashcards (Generating...)';
        updateHeaderSubtitle('Ask about this slide');
      });
    }

    window.generateNewFlashcards = () => {
      saveChatBeforeClearing();
      chatEl.innerHTML = `
        <div class="quiz-generating">
          <div class="quiz-gen-text">Generate Flashcards</div>
          <div class="quiz-gen-subtext">How many flashcards would you like to generate?</div>
          <div style="margin-top: 24px;">
            <input type="number" id="flashcard-count-input" min="5" max="50" value="15" style="padding: 10px; font-size: 16px; border-radius: 8px; border: 1px solid rgba(0,0,0,.12); width: 100px; text-align: center; margin-bottom: 16px;">
            <div style="display: flex; gap: 12px; justify-content: center;">
              <button class="flashcard-btn flashcard-btn-primary" onclick="startFlashcardGeneration()">Generate</button>
              <button class="flashcard-btn" onclick="exitFlashcardMode()">Cancel</button>
            </div>
          </div>
        </div>
      `;
    };

    window.startFlashcardGeneration = async () => {
      const countInput = document.getElementById('flashcard-count-input');
      const flashcardCount = parseInt(countInput?.value || '15');

      if (flashcardCount < 5 || flashcardCount > 50) {
        alert('Please enter a number between 5 and 50');
        return;
      }

      console.log("Starting flashcard generation, count:", flashcardCount);
      setError("");
      flashcardGenerating = true;
      flashcardBtn.style.display = 'none';
      flashcardRequestedCount = flashcardCount; // Store for ETA calculation

      showFlashcardGenerating(flashcardCount);
      updateHeaderSubtitle('Generating Flashcards...');

      // Retry logic for handling JSON parse errors
      let malformedRetryCount = 0;
      const maxMalformedRetries = 5;
      let generatedFlashcards = null;
      let finalFlashcardModel = null;

      while (!generatedFlashcards) {
        try {
          if (malformedRetryCount > 0) {
            console.log(`Retry attempt ${malformedRetryCount}/${maxMalformedRetries} due to malformed JSON`);
            const genStatus = chatEl.querySelector('.flashcard-generating-status');
            if (genStatus) {
              genStatus.innerHTML = `
                <div style="margin-bottom: 8px;">⚠️ Malformed response detected</div>
                <div style="font-size: 12px; color: #999;">Retrying (${malformedRetryCount}/${maxMalformedRetries})...</div>
              `;
            }
            // Add delay before retry to prevent spam
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

        suppressIntercept = true;

        // Initialize files if not already done
        if (!filesInitialized && !filesInitializing) {
          await initializeFiles(null);
        } else if (filesInitializing) {
          // Wait for initialization to complete
          while (filesInitializing) {
            await new Promise(r => setTimeout(r, 100));
          }
        }

        // Use the already uploaded files
        const vttUri = uploadedVttUri;
        const pdfUri = uploadedPdfUri;

        console.log("Using uploaded files for flashcards - VTT:", vttUri, "PDF:", pdfUri);

        // Fetch flashcard prompt from backend
        console.log('[Flashcards] Fetching flashcard generation prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/flashcard-generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flashcardCount: flashcardCount })
        });
        const promptData = await promptResponse.json();
        let flashcardPrompt = promptData.prompt;

        // Append YouTube-specific instructions if on YouTube
        if (isYouTubePage()) {
          flashcardPrompt += "\n\nIMPORTANT: For this YouTube video, the attached text files represent: (1) the video summary as 'lecture slides', and (2) the audio transcript if available. Generate the flashcards based on these attached documents only. Treat the video summary text as if it were lecture slides content.";
        }

        // Build request with uploaded file URIs
        const parts = [{ text: flashcardPrompt }];
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        if (pdfUri) parts.push({ fileData: { mimeType: pdfMimeType, fileUri: pdfUri } });
        if (vttUri) parts.push({ fileData: { mimeType: "text/plain", fileUri: vttUri } });

        const body = {
          contents: [{ parts }]
        };

        await waitForApiKey();

        // Create abort controller for timeout (flashcards)
        const flashcardController = new AbortController();
        const flashcardTimeoutId = setTimeout(() => flashcardController.abort(), 120000); // 120 seconds

        let resp;
        let usedModel = MODEL_PRO;
        let retryWithFlash = false;

        try {
          logModelUsage('Flashcards', usedModel, 'attempt');
          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: flashcardController.signal
            }
          );
          clearTimeout(flashcardTimeoutId);

          // Check for 429 rate limit error
          if (resp.status === 429) {
            const errorData = await resp.json();
            console.log("Pro model rate limited for flashcards");

            // If generating in background, mark as rate limited and exit
            if (flashcardGeneratingInBackground) {
              console.log('[Flashcards] Rate limited in background - will show dialog when user returns');
              flashcardRateLimited = true;
              flashcardGeneratingInBackground = false;
              flashcardGenerating = false;
              flashcardBtn.textContent = 'Flashcards (Rate Limited)';
              throw new Error('Rate limited - user needs to decide');
            }

            // Show rate limit dialog with option to use Flash model
            const useFlash = await new Promise((resolve) => {
              saveChatBeforeClearing();
              chatEl.innerHTML = '';
              controlsEl.style.display = 'none';
              inputRowEl.style.display = 'none';
              attEl.style.display = 'none';

              const container = document.createElement('div');
              container.className = 'quiz-generating';
              container.innerHTML = `
                <div class="quiz-gen-text">⚠️ Rate Limited</div>
                <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model has been rate limited. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the flashcards.</div>
                <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
                  <button class="flashcard-btn" id="flashcard-rate-limit-cancel">Try Again Later</button>
                  <button class="flashcard-btn flashcard-btn-primary" id="flashcard-rate-limit-flash">Use Flash Model</button>
                </div>
              `;
              chatEl.appendChild(container);

              document.getElementById('flashcard-rate-limit-cancel').onclick = () => resolve(false);
              document.getElementById('flashcard-rate-limit-flash').onclick = () => resolve(true);
            });

        if (!useFlash) {
          // User chose to try again later - restore UI and exit
          restoreSavedChatContent();
          controlsEl.style.display = '';
          inputRowEl.style.display = '';
          attEl.style.display = '';
          flashcardBtn.style.display = '';
          flashcardGenerating = false;
          updateHeaderSubtitle('Ask about this slide');
          throw new Error('User chose to try again later');
        }

            // User chose to use Flash model - continue with Flash
            console.log('[Flashcards] User chose to use Flash model');

            // Show continuing with Flash message
            showFlashcardGenerating(flashcardCount);
            const genStatus = chatEl.querySelector('.flashcard-generating-status');
            if (genStatus) {
              genStatus.classList.remove('fade-out');
              genStatus.innerHTML = `
                <div style="margin-bottom: 8px;">⚠️ Using Flash model</div>
                <div style="font-size: 12px;">Quality may be degraded...</div>
              `;
              setTimeout(() => {
                genStatus.classList.add('fade-out');
                setTimeout(() => { genStatus.innerHTML = ''; }, 500);
              }, 4000);
            }

            retryWithFlash = true;
            logModelUsage('Flashcards', MODEL_FLASH, 'retry after rate limit');
          }
        } catch (err) {
          clearTimeout(flashcardTimeoutId);
          if (err.name === 'AbortError') {
            throw new Error("Request timed out after 120 seconds");
          }
          throw err;
        }

        // Retry with Flash if Pro was rate limited
        if (retryWithFlash) {
          console.log("Retrying flashcard generation with Flash model");
          const flashController = new AbortController();
          const flashTimeoutId = setTimeout(() => flashController.abort(), 120000);

          try {
            resp = await proxiedFetchForAI(
              `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: flashController.signal
              }
            );
            clearTimeout(flashTimeoutId);
            usedModel = MODEL_FLASH;
            logModelUsage('Flashcards', usedModel, 'retry response');

            // Check if Flash is also rate limited
            if (resp.status === 429) {
              console.log("Flash model also rate limited for flashcards, switching to Flash Lite");
              logModelUsage('Flashcards', MODEL_FLASHLITE, 'retry after second rate limit');

              // Set rate limit notice globally with retry-after
              const retryAfter = resp.headers.get('retry-after');
              setRateLimitNotice(retryAfter);

              // Update UI to show we're switching to Flash Lite
              const genStatus = chatEl.querySelector('.flashcard-generating-status');
              if (genStatus) {
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">⚠️ Flash model also rate limited</div>
                  <div style="font-size: 12px; color: #999;">Switching to Flash Lite...</div>
                `;
              }

              // Retry with Flash Lite
              const liteController = new AbortController();
              const liteTimeoutId = setTimeout(() => liteController.abort(), 120000);

              try {
                resp = await proxiedFetchForAI(
                  `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: liteController.signal
                  }
                );
                clearTimeout(liteTimeoutId);
                usedModel = MODEL_FLASHLITE;
                logModelUsage('Flashcards', usedModel, 'retry response');
              } catch (err) {
                clearTimeout(liteTimeoutId);
                if (err.name === 'AbortError') {
                  throw new Error("Request timed out after 120 seconds");
                }
                throw err;
              }
            } else {
              // Update UI to show we're using Flash
              const genStatus = chatEl.querySelector('.flashcard-generating-status');
              if (genStatus) {
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">✨ Generating with Flash model...</div>
                `;
              }
            }
          } catch (err) {
            clearTimeout(flashTimeoutId);
            if (err.name === 'AbortError') {
              throw new Error("Request timed out after 120 seconds");
            }
            throw err;
          }
        }

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(resp.status, usedModel);

        const data = await resp.json();
        let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        // Extract JSON from markdown code blocks
        const jsonMatch = rawText.match(/```json\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          rawText = jsonMatch[1];
        }
        rawText = rawText.trim();

        // Try to parse, and if it fails due to backslash issues, try to fix them
        try {
          generatedFlashcards = JSON.parse(rawText);
        } catch (e) {
          console.warn("Initial JSON parse failed, attempting to fix LaTeX escaping:", e.message);
          try {
            // Fix unescaped backslashes in LaTeX (common in math notation)
            // This handles cases like \Theta, \lg, etc. in JSON strings
            const fixedText = rawText.replace(/"([^"]*?)"/g, (match, content) => {
              // Within each string, escape single backslashes that aren't already escaped
              const fixed = content.replace(/\\(?![\\"])/g, '\\\\');
              return `"${fixed}"`;
            });
            generatedFlashcards = JSON.parse(fixedText);
          } catch (parseError) {
            console.error("JSON parse error:", parseError.message);
            malformedRetryCount++;
            if (malformedRetryCount > maxMalformedRetries) {
              throw new Error(`Failed to parse flashcard JSON after ${maxMalformedRetries} retries: ${parseError.message}`);
            }
            // Continue to next retry iteration
            continue;
          }
        }

        if (!Array.isArray(generatedFlashcards) || generatedFlashcards.length === 0) {
          console.error("Invalid flashcard format - not an array or empty");
          malformedRetryCount++;
          generatedFlashcards = null; // Reset to retry
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error("Invalid flashcard format - expected array of flashcards");
          }
          continue;
        }

        console.log(`Generated ${generatedFlashcards.length} flashcards`);
        finalFlashcardModel = usedModel;
        logModelUsage('Flashcards', finalFlashcardModel, 'response received');
        break; // Success, exit retry loop

      } catch (e) {
        console.error("Flashcard generation attempt failed:", e);

        const errMsg = (e?.message || e)?.toString() || '';
        if (errMsg.includes('user needs to decide') || errMsg.includes('User chose to try again later')) {
          suppressIntercept = false;
          flashcardGenerating = false;
          flashcardGeneratingInBackground = false;
          return;
        }

        // Check if this is a malformed JSON error or a network/timeout error
        const isMalformedError = e.message && e.message.includes('Failed to parse flashcard JSON');

        if (isMalformedError) {
          // This is a malformed JSON error that already incremented the counter
          if (malformedRetryCount > maxMalformedRetries) {
            // Final failure after all retries
            console.error("Flashcard generation failed after all retries:", e);

            // If it was running in background, just update button
            if (flashcardGeneratingInBackground) {
              flashcardGeneratingInBackground = false;
              flashcardBtn.textContent = 'Flashcards';
              console.log("Background generation failed");
              return;
            }

            setError("Flashcard generation failed: " + (e?.message || e));
            restoreSavedChatContent();
            controlsEl.style.display = '';
            inputRowEl.style.display = '';
            attEl.style.display = '';
            flashcardBtn.style.display = '';
            updateHeaderSubtitle('Ask about this slide');
            suppressIntercept = false;
            flashcardGenerating = false;
            return;
          }
        }
        // For network/timeout errors, add delay before retry
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } // End of retry while loop

    // If we got here, we have valid flashcards
    if (generatedFlashcards) {
      // Clear countdown interval
      if (flashcardCountdownInterval) {
        clearInterval(flashcardCountdownInterval);
        flashcardCountdownInterval = null;
        flashcardCountdownStartTime = null;
        flashcardCountdownPhase = 1;
      }

      // If it was running in background, cache it
      if (flashcardGeneratingInBackground) {
        cachedFlashcardData = generatedFlashcards;
        flashcardGeneratingInBackground = false;
        flashcardBtn.textContent = 'Flashcards (Ready)';
        console.log("Background generation complete - flashcards cached");
        suppressIntercept = false;
        flashcardGenerating = false;
        return;
      }

      flashcardData = generatedFlashcards;
      // Reset overleaf options state for new flashcards
      flashcardOptionsShown = false;
      flashcardLatex = null;
      repairedFlashcardLatex = null;
      suppressIntercept = false;
      flashcardGenerating = false;
      enterFlashcardMode();
    } else {
      // Shouldn't happen, but handle it
      console.error("Flashcard generation failed: No flashcards generated");

      // If it was running in background, just update button
      if (flashcardGeneratingInBackground) {
        flashcardGeneratingInBackground = false;
        flashcardBtn.textContent = 'Flashcards';
        console.log("Background generation failed");
        suppressIntercept = false;
        flashcardGenerating = false;
        return;
      }

      setError("Flashcard generation failed: No flashcards generated");
      restoreSavedChatContent();
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      flashcardBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
      suppressIntercept = false;
      flashcardGenerating = false;
    }
  };

    function enterFlashcardMode() {
      flashcardMode = true;
      flashcardCurrent = 0;

      // Clear countdown interval if it exists
      const genContainer = chatEl.querySelector('.quiz-generating');
      if (genContainer && genContainer.dataset.countdownInterval) {
        clearInterval(parseInt(genContainer.dataset.countdownInterval));
      }

      updateHeaderSubtitle('Flashcard Mode');

      // Clear any error messages
      setError('');

      // Hide controls
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      flashcardBtn.style.display = 'none';

      // Check if we should show overleaf options instead
      if (flashcardOptionsShown && flashcardLatex) {
        showFlashcardOverleafOptions();
      } else {
        renderFlashcard();
      }
    }

    function exitFlashcardMode() {
      flashcardMode = false;
      // Don't clear flashcardData - keep it for next time
      flashcardCurrent = 0;

      // Restore saved chat content if available, otherwise clear
      restoreSavedChatContent();

      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      flashcardBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
    }

    function renderFlashcard() {
      const card = flashcardData[flashcardCurrent];
      saveChatBeforeClearing();
      chatEl.innerHTML = `
        <div class="flashcard-container">
          <div class="flashcard-progress">
            <div class="flashcard-progress-bar" style="width: ${((flashcardCurrent + 1) / flashcardData.length) * 100}%"></div>
          </div>
          <div class="flashcard-header">
            <div class="flashcard-counter">Card ${flashcardCurrent + 1} of ${flashcardData.length}</div>
            <button class="flashcard-btn" onclick="flipCurrentCard()">
              Flip Card (Enter)
            </button>
          </div>
          <div class="flashcard-scene">
            <div class="flashcard-card" id="current-flashcard" tabindex="0" onclick="flipCurrentCard()">
              <div class="flashcard-face flashcard-front">
                <div>${renderMarkdown(card.question)}</div>
              </div>
              <div class="flashcard-face flashcard-back">
                <div>${renderMarkdown(card.answer)}</div>
              </div>
            </div>
          </div>
          <div class="flashcard-nav">
            <button class="flashcard-btn" ${flashcardCurrent === 0 ? 'disabled' : ''} onclick="prevFlashcard()">←</button>
            <button class="flashcard-btn flashcard-btn-primary" onclick="shuffleFlashcards()">🔀 Shuffle</button>
            <button class="flashcard-btn flashcard-btn-primary" onclick="startTestMeMode()">🎯 Test Me</button>
            ${flashcardLatex ?
              '<button class="flashcard-btn flashcard-btn-overleaf" onclick="showFlashcardOverleafOptions()">🌱 Overleaf Options</button>' :
              '<button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf()">🌱 Open in Overleaf</button>'
            }
            <button class="flashcard-btn" ${flashcardCurrent === flashcardData.length - 1 ? 'disabled' : ''} onclick="nextFlashcard()">→</button>
          </div>
          <div class="flashcard-exit">
            <button class="flashcard-btn" onclick="exitFlashcardMode()">Exit Flashcards</button>
          </div>
        </div>
      `;
      chatEl.scrollTop = 0;

      // Add keyboard event listener
      const flashcardEl = document.getElementById('current-flashcard');
      if (flashcardEl) {
        flashcardEl.addEventListener('keydown', handleFlashcardKeydown);
        flashcardEl.focus();
      }

      // Typeset LaTeX in flashcard content, then adjust height
      typesetEl(chatEl).then(() => {
        adjustFlashcardHeight();
      });

      // Also adjust height immediately in case LaTeX isn't present
      setTimeout(adjustFlashcardHeight, 100);
    }

    function adjustFlashcardHeight() {
      const flashcardEl = document.getElementById('current-flashcard');
      if (!flashcardEl) return;

      const front = flashcardEl.querySelector('.flashcard-front > div');
      const back = flashcardEl.querySelector('.flashcard-back > div');

      if (!front || !back) return;

      // Get the natural height of both sides
      const frontHeight = front.scrollHeight;
      const backHeight = back.scrollHeight;

      // Use the taller of the two, with minimum of 300px
      const maxHeight = Math.max(300, frontHeight + 48, backHeight + 48); // +48 for padding

      flashcardEl.style.height = maxHeight + 'px';
    }

    window.flipCurrentCard = () => {
      const cardEl = document.getElementById('current-flashcard');
      if (cardEl) {
        cardEl.classList.toggle('flipped');
      }
    };

    function handleFlashcardKeydown(e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        flipCurrentCard();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevFlashcard();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextFlashcard();
      }
    }

    window.prevFlashcard = () => {
      if (flashcardCurrent > 0) {
        flashcardCurrent--;
        renderFlashcard();
      }
    };

    window.nextFlashcard = () => {
      if (flashcardCurrent < flashcardData.length - 1) {
        flashcardCurrent++;
        renderFlashcard();
      }
    };

    window.shuffleFlashcards = () => {
      for (let i = flashcardData.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [flashcardData[i], flashcardData[j]] = [flashcardData[j], flashcardData[i]];
      }
      flashcardCurrent = 0;
      renderFlashcard();
    };

    // ===== TEST ME MODE FUNCTIONALITY =====
    window.startTestMeMode = async () => {
      if (!flashcardData || flashcardData.length === 0) {
        alert('No flashcards available for Test Me mode');
        return;
      }

      // If quiz is generating in background, show the generating UI
      if (testMeGenerating || testMeGeneratingInBackground) {
        console.log('[Test Me] Quiz still generating in background - showing UI');
        testMeGenerating = true;
        testMeGeneratingInBackground = false;
        showTestMeGenerating();
        return;
      }

      // If we have cached quiz data, offer to view it or generate new
      if (testMeData && testMeData.length > 0 && !testMeReviewMode) {
        console.log('[Test Me] Found cached quiz, showing options');
        showTestMeCachedOptions();
        return;
      }

      // Start new quiz generation
      startNewTestMeQuiz();
    };

    function showTestMeCachedOptions() {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      container.innerHTML = `
        <div class="quiz-gen-text">Test Me Quiz Available</div>
        <div class="quiz-gen-subtext">You have a ${testMeData.length}-question quiz from a previous session</div>
        <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center; flex-wrap: wrap;">
          <button class="flashcard-btn flashcard-btn-primary" onclick="viewPreviousTestMeQuiz()">View Previous Quiz</button>
          <button class="flashcard-btn" onclick="generateNewTestMeQuiz()">Generate New Quiz</button>
        </div>
      `;
      chatEl.appendChild(container);
    }

    window.viewPreviousTestMeQuiz = () => {
      console.log('[Test Me] Viewing previous quiz');
      testMeMode = true;
      testMeCurrent = 0;
      testMeScore = 0;
      testMeReviewMode = false;
      testMeAnswers = []; // Reset answers for new attempt
      renderTestMeQuestion();
    };

    window.generateNewTestMeQuiz = () => {
      console.log('[Test Me] Generating new quiz');
      testMeData = []; // Clear cached quiz
      startNewTestMeQuiz();
    };

    async function startNewTestMeQuiz() {
      console.log('[Test Me] Starting new Test Me quiz with', flashcardData.length, 'flashcards');

      testMeMode = true;
      testMeCurrent = 0;
      testMeScore = 0;
      testMeAnswers = [];
      testMeReviewMode = false;
      testMeGenerating = true;

      // Show generating UI
      showTestMeGenerating();

      // Suppress chat intercepts to prevent gemini bubble from appearing
      suppressIntercept = true;

      try {
        // Generate quiz options for all flashcards using Gemini
        testMeData = await generateTestMeOptions(flashcardData);

        console.log('[Test Me] Generated options for all flashcards');
        testMeGenerating = false;

        // If completed in background, update button
        if (testMeGeneratingInBackground) {
          testMeGeneratingInBackground = false;
          flashcardBtn.textContent = 'Flashcards (Quiz Ready)';
          console.log('[Test Me] Generation completed in background');
          return;
        }

        // Start the quiz
        renderTestMeQuestion();

      } catch (error) {
        console.error('[Test Me] Failed to generate quiz options:', error);
        alert(`Failed to generate quiz: ${error.message}`);
        testMeMode = false;
        testMeGenerating = false;
        testMeGeneratingInBackground = false;
        renderFlashcard(); // Return to flashcard mode
      } finally {
        suppressIntercept = false;
      }
    }

    function showTestMeGenerating() {
      // Don't update UI if generating in background
      if (testMeGeneratingInBackground) return;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      // Remove any gemini bubbles from DOM
      document.querySelectorAll('.gemini-bubble').forEach(el => el.remove());
      document.querySelectorAll('.gemini-msg').forEach(el => el.remove());

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      container.innerHTML = `
        <div class="quiz-gen-spinner"></div>
        <div class="quiz-gen-text">Generating Test Me Quiz...</div>
        <div class="quiz-gen-subtext">Creating ${flashcardData.length} multiple-choice questions from your flashcards</div>
        <div class="quiz-gen-eta" style="font-size: 13px; color: #666; margin-top: 8px;">Please wait...</div>
        <button class="quiz-gen-stop" onclick="exitTestMeGeneration()" style="margin-top: 24px;">Exit</button>
      `;
      chatEl.appendChild(container);
    }

    window.exitTestMeGeneration = () => {
      console.log('[Test Me] User exited generation - continuing in background');

      // Don't abort - let it continue in background
      testMeGenerating = false;
      testMeGeneratingInBackground = true;

      // Update flashcard button to show quiz is generating
      flashcardBtn.textContent = 'Flashcards (Quiz Generating...)';

      // Return to flashcard mode (this will properly hide UI elements)
      enterFlashcardMode();
    };

    async function generateTestMeOptions(flashcards) {
      console.log('[Test Me] Generating options for', flashcards.length, 'flashcards');

      // Prepare the flashcard data for Gemini
      const flashcardsText = flashcards.map((card, idx) => `
Flashcard ${idx + 1}:
Question: ${card.question}
Answer: ${card.answer}
`).join('\n');

      // Fetch prompt from backend
      console.log('[Test Me] Fetching quiz-from-flashcards prompt from backend');
      const promptResponse = await fetch('http://localhost:5000/api/prompts/quiz-from-flashcards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flashcardsText })
      });
      const promptData = await promptResponse.json();
      const prompt = promptData.prompt;

      // Call Gemini API directly
      const parts = [{ text: prompt }];
      const body = { contents: [{ parts }] };

      logModelUsage('TestMe', MODEL_FLASH, 'attempt');
      await waitForApiKey();

      const resp = await proxiedFetchForAI(
        `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );

      const data = await resp.json();
      logModelUsage('TestMe', MODEL_FLASH, 'response received');

      // Extract text from response
      const result = data && data.candidates && data.candidates[0] &&
        data.candidates[0].content && data.candidates[0].content.parts &&
        data.candidates[0].content.parts.find(p => typeof p.text === "string")?.text;

      if (!result) {
        console.error('[Test Me] No text found in AI response:', data);
        throw new Error('AI returned no text response');
      }

      console.log('[Test Me] Got response text, length:', result.length);
      // Parse the response
      return parseTestMeResponse(result, flashcards);
    }

    function parseTestMeResponse(response, flashcards) {
      console.log('[Test Me] Parsing AI response');

      const quizData = [];
      const flashcardBlocks = response.split(/FLASHCARD \d+:/);

      for (let i = 1; i < flashcardBlocks.length && i - 1 < flashcards.length; i++) {
        const block = flashcardBlocks[i];
        const flashcard = flashcards[i - 1];

        // Extract correct and incorrect answers
        const correctMatch = block.match(/CORRECT:\s*(.+?)(?=\nINCORRECT_|$)/is);
        const incorrect1Match = block.match(/INCORRECT_1:\s*(.+?)(?=\nINCORRECT_|$)/is);
        const incorrect2Match = block.match(/INCORRECT_2:\s*(.+?)(?=\nINCORRECT_|$)/is);
        const incorrect3Match = block.match(/INCORRECT_3:\s*(.+?)(?=\nINCORRECT_|$)/is);
        const incorrect4Match = block.match(/INCORRECT_4:\s*(.+?)(?=\nFLASHCARD|$)/is);

        if (correctMatch && incorrect1Match && incorrect2Match && incorrect3Match && incorrect4Match) {
          const correctAnswer = correctMatch[1].trim();
          const incorrectAnswers = [
            incorrect1Match[1].trim(),
            incorrect2Match[1].trim(),
            incorrect3Match[1].trim(),
            incorrect4Match[1].trim()
          ];

          // Combine and shuffle options
          const allOptions = [correctAnswer, ...incorrectAnswers];
          for (let j = allOptions.length - 1; j > 0; j--) {
            const k = Math.floor(Math.random() * (j + 1));
            [allOptions[j], allOptions[k]] = [allOptions[k], allOptions[j]];
          }

          quizData.push({
            question: flashcard.question,
            correctAnswer: correctAnswer,
            options: allOptions,
            correctIndex: allOptions.indexOf(correctAnswer)
          });
        } else {
          console.warn('[Test Me] Failed to parse flashcard', i, '- skipping');
        }
      }

      console.log('[Test Me] Successfully parsed', quizData.length, 'quiz questions');
      return quizData;
    }

    function renderTestMeQuestion() {
      if (testMeCurrent >= testMeData.length) {
        // Quiz complete
        showTestMeResults();
        return;
      }

      const quizItem = testMeData[testMeCurrent];
      const previousAnswer = testMeAnswers[testMeCurrent];
      const hasAnswered = previousAnswer !== undefined;
      const isReviewingThisQuestion = testMeReviewMode || hasAnswered;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'test-me-container';
      container.innerHTML = `
        <style>
          .test-me-container {
            display: flex;
            flex-direction: column;
            height: 100%;
            padding: 20px;
            box-sizing: border-box;
            max-width: 1200px;
            margin: 0 auto;
            width: 100%;
          }
          .test-me-header {
            text-align: center;
            margin-bottom: 30px;
          }
          .test-me-progress {
            font-size: 14px;
            color: #666;
            margin-bottom: 10px;
          }
          .test-me-score {
            font-size: 16px;
            font-weight: 600;
            color: #2196f3;
          }
          .test-me-question-section {
            display: flex;
            align-items: center;
            justify-content: center;
            margin-bottom: 30px;
          }
          .test-me-question-card {
            background: #fff;
            border: 2px solid #2196f3;
            border-radius: 12px;
            padding: 30px;
            max-width: 900px;
            width: 100%;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          }
          .test-me-question-text {
            font-size: 20px;
            font-weight: 600;
            text-align: center;
            color: #1a1a1a;
          }
          .test-me-options-section {
            padding: 20px 0;
          }
          .test-me-options-container {
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 12px;
            max-width: 1100px;
            margin: 0 auto;
          }
          .test-me-option {
            background: #f5f5f5;
            border: 2px solid #ddd;
            border-radius: 10px;
            padding: 16px 20px;
            font-size: 16px;
            text-align: center;
            cursor: pointer;
            transition: all 0.2s;
            flex: 0 1 calc(50% - 6px);
            min-width: 250px;
            max-width: 450px;
          }
          .test-me-option:hover:not(.correct):not(.incorrect):not(.disabled) {
            background: #e3f2fd;
            border-color: #2196f3;
            transform: translateY(-2px);
          }
          .test-me-option.correct {
            background: #4caf50;
            border-color: #4caf50;
            color: white;
          }
          .test-me-option.incorrect {
            background: #f44336;
            border-color: #f44336;
            color: white;
          }
          .test-me-option.disabled {
            cursor: not-allowed;
            opacity: 0.7;
          }
          .test-me-navigation {
            display: flex;
            gap: 12px;
            justify-content: center;
            align-items: center;
            margin-top: 20px;
            flex-wrap: wrap;
          }
          .test-me-nav-btn {
            padding: 10px 24px;
            font-size: 16px;
            font-weight: 600;
            border-radius: 8px;
            border: 2px solid #2196f3;
            background: #2196f3;
            color: white;
            cursor: pointer;
            transition: all 0.2s;
          }
          .test-me-nav-btn:hover:not(:disabled) {
            background: #1976d2;
            border-color: #1976d2;
            transform: translateY(-2px);
          }
          .test-me-nav-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }
          .test-me-nav-btn.secondary {
            background: white;
            color: #2196f3;
          }
          .test-me-nav-btn.secondary:hover:not(:disabled) {
            background: #e3f2fd;
          }
        </style>

        <div class="test-me-header">
          <div class="test-me-progress">Question ${testMeCurrent + 1} of ${testMeData.length}</div>
          <div class="test-me-score">${testMeReviewMode ? 'Review Mode' : `Score: ${testMeScore} / ${Math.max(testMeCurrent, testMeAnswers.length)}`}</div>
        </div>

        <div class="test-me-question-section">
          <div class="test-me-question-card">
            <div class="test-me-question-text">${renderMarkdown(quizItem.question)}</div>
          </div>
        </div>

        <div class="test-me-options-section">
          <div class="test-me-options-container">
            ${quizItem.options.map((option, idx) => {
              let classes = 'test-me-option';
              if (isReviewingThisQuestion) {
                classes += ' disabled';
                if (previousAnswer && idx === previousAnswer.selectedIndex) {
                  classes += previousAnswer.isCorrect ? ' correct' : ' incorrect';
                }
                if (idx === quizItem.correctIndex && (!previousAnswer || !previousAnswer.isCorrect)) {
                  classes += ' correct';
                }
              }
              return `
                <div class="${classes}" onclick="selectTestMeAnswer(${idx})" id="test-me-option-${idx}">
                  ${renderMarkdown(option)}
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <div class="test-me-navigation">
          <button class="test-me-nav-btn secondary" onclick="previousTestMeQuestion()" ${testMeCurrent === 0 ? 'disabled' : ''}>
            ← Previous
          </button>
          ${testMeReviewMode ? `
            <button class="test-me-nav-btn secondary" onclick="showTestMeResults()">Back to Score</button>
          ` : `
            <button class="test-me-nav-btn secondary" onclick="exitTestMeMode()">Exit Test</button>
          `}
          <button class="test-me-nav-btn" onclick="nextTestMeQuestion()" ${!hasAnswered && !testMeReviewMode ? 'disabled' : ''} id="test-me-next-btn">
            ${testMeCurrent === testMeData.length - 1 ? (testMeReviewMode ? 'Back to Score' : 'Finish') : 'Next'} →
          </button>
        </div>
      `;

      chatEl.appendChild(container);
      chatEl.scrollTop = 0;

      // Typeset LaTeX if present
      typesetEl(chatEl);
    }

    window.selectTestMeAnswer = (selectedIndex) => {
      // Don't allow answering if already answered or in review mode
      if (testMeAnswers[testMeCurrent] !== undefined || testMeReviewMode) {
        return;
      }

      const quizItem = testMeData[testMeCurrent];
      const isCorrect = selectedIndex === quizItem.correctIndex;

      console.log('[Test Me] Answer selected:', selectedIndex, 'Correct:', quizItem.correctIndex, 'Result:', isCorrect ? 'CORRECT' : 'WRONG');

      // Store answer
      testMeAnswers[testMeCurrent] = {
        selectedIndex: selectedIndex,
        isCorrect: isCorrect
      };

      // Update score
      if (isCorrect) {
        testMeScore++;
      }

      // Visual feedback
      const selectedOption = document.getElementById(`test-me-option-${selectedIndex}`);
      const correctOption = document.getElementById(`test-me-option-${quizItem.correctIndex}`);

      if (isCorrect) {
        selectedOption.classList.add('correct');
      } else {
        selectedOption.classList.add('incorrect');
        correctOption.classList.add('correct');
      }

      // Disable all options
      document.querySelectorAll('.test-me-option').forEach(opt => {
        opt.classList.add('disabled');
        opt.style.pointerEvents = 'none';
      });

      // Enable next button
      const nextBtn = document.getElementById('test-me-next-btn');
      if (nextBtn) {
        nextBtn.disabled = false;
      }
    };

    window.nextTestMeQuestion = () => {
      if (testMeCurrent < testMeData.length - 1) {
        testMeCurrent++;
        renderTestMeQuestion();
      } else {
        // Last question - show results
        if (testMeReviewMode) {
          // In review mode, go back to score screen
          showTestMeResults();
        } else {
          // In quiz mode, show results for first time
          showTestMeResults();
        }
      }
    };

    window.previousTestMeQuestion = () => {
      if (testMeCurrent > 0) {
        testMeCurrent--;
        renderTestMeQuestion();
      }
    };

    window.showTestMeResults = function() {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const percentage = Math.round((testMeScore / testMeData.length) * 100);
      let message = '';
      let emoji = '';

      if (percentage >= 90) {
        message = 'Outstanding! You really know your stuff!';
        emoji = '🏆';
      } else if (percentage >= 70) {
        message = 'Great job! Keep up the good work!';
        emoji = '🎉';
      } else if (percentage >= 50) {
        message = 'Good effort! Review and try again!';
        emoji = '👍';
      } else {
        message = 'Keep studying! You\'ll get better!';
        emoji = '📚';
      }

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      container.innerHTML = `
        <div style="font-size: 60px; margin-bottom: 20px;">${emoji}</div>
        <div class="quiz-gen-text">Test Complete!</div>
        <div class="quiz-gen-subtext">${message}</div>
        <div style="font-size: 48px; font-weight: 700; color: #2196f3; margin: 30px 0;">
          ${testMeScore} / ${testMeData.length}
        </div>
        <div style="font-size: 24px; color: #666; margin-bottom: 30px;">
          ${percentage}% Correct
        </div>
        <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
          <button class="flashcard-btn flashcard-btn-primary" onclick="reviewTestMeAnswers()">📝 Review Answers</button>
          <button class="flashcard-btn" onclick="startTestMeMode()">🔄 Try Again</button>
          <button class="flashcard-btn" onclick="exitTestMeMode()">Back to Flashcards</button>
        </div>
      `;
      chatEl.appendChild(container);
      chatEl.scrollTop = 0;
    };

    window.reviewTestMeAnswers = () => {
      console.log('[Test Me] Entering review mode');
      testMeMode = true;
      testMeReviewMode = true;
      testMeCurrent = 0;
      renderTestMeQuestion();
    };

    window.exitTestMeMode = () => {
      console.log('[Test Me] Exiting Test Me mode');
      testMeMode = false;
      testMeReviewMode = false;
      testMeCurrent = 0;
      testMeScore = 0;
      // Don't clear testMeData or testMeAnswers - keep them cached for replay

      // Reset flashcard button text back to "Flashcards"
      flashcardBtn.textContent = 'Flashcards';

      renderFlashcard();
    };

    window.saveFlashcardsPDF = async () => {
      try {
        await ensureJsPDF();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const margin = 20;
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const contentWidth = pageWidth - 2 * margin;

        // Helper to strip HTML/markdown and convert LaTeX to plain text
        function cleanText(text) {
          return text
            // Remove HTML tags
            .replace(/<[^>]*>/g, '')
            // Convert display math to readable format
            .replace(/\$\$([^$]+)\$\$/g, (match, p1) => `[Math: ${p1}]`)
            // Convert inline math to readable format
            .replace(/\$([^$]+)\$/g, (match, p1) => p1)
            // Bold markdown
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            // Italic markdown
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            // Code markdown
            .replace(/`([^`]+)`/g, '"$1"')
            // Headers
            .replace(/^#{1,6}\s+/gm, '')
            // Lists
            .replace(/^\s*[-*+]\s+/gm, '• ')
            .replace(/^\s*\d+\.\s+/gm, '')
            // Links
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Line breaks
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        doc.setFontSize(18);
        doc.text('Flashcards', margin, margin);
        doc.setFontSize(10);
        doc.text(`Generated: ${new Date().toLocaleDateString()}`, margin, margin + 7);
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text('Powered by LeQture', pageWidth - margin, margin, { align: 'right' });
        doc.setTextColor(0, 0, 0);

        let y = margin + 20;

        flashcardData.forEach((card, idx) => {
          if (y > pageHeight - 40) {
            doc.addPage();
            y = margin;
          }

          doc.setFontSize(12);
          doc.setFont(undefined, 'bold');
          doc.text(`${idx + 1}. Q:`, margin, y);
          doc.setFont(undefined, 'normal');
          const qLines = doc.splitTextToSize(cleanText(card.question), contentWidth - 10);
          doc.text(qLines, margin + 10, y);
          y += qLines.length * 6 + 3;

          doc.setFont(undefined, 'bold');
          doc.text(`   A:`, margin, y);
          doc.setFont(undefined, 'normal');
          const aLines = doc.splitTextToSize(cleanText(card.answer), contentWidth - 10);
          doc.text(aLines, margin + 10, y);
          y += aLines.length * 6 + 8;
        });

        doc.save('flashcards.pdf');
      } catch (err) {
        console.error('PDF generation failed:', err);
        alert('PDF generation failed. Please ensure jsPDF library is available.');
      }
    };

    let flashcardLatex = null;
    let repairedFlashcardLatex = null;
    let flashcardRepairing = false;

    window.openFlashcardsInOverleaf = async (useRepaired = false) => {
      try {
        // Helper function to convert markdown to LaTeX
        function convertMarkdownToLatex(text) {
          return text
            // Convert **bold** to \textbf{bold}
            .replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
            // Convert *italic* to \textit{italic}
            .replace(/\*(.+?)\*/g, '\\textit{$1}')
            // Convert `code` to \texttt{code}
            .replace(/`(.+?)`/g, '\\texttt{$1}');
        }

        // Build LaTeX document if not already built
        if (!flashcardLatex) {
          let latex = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Flashcards}
\\author{Generated by LeQture}
\\date{${new Date().toLocaleDateString()}}

\\begin{document}
\\maketitle

`;

          flashcardData.forEach((card, idx) => {
            latex += `\\section*{Flashcard ${idx + 1}}

\\textbf{Question:} ${convertMarkdownToLatex(card.question)}

\\vspace{0.5em}

\\textbf{Answer:} ${convertMarkdownToLatex(card.answer)}

\\vspace{1em}
\\hrule
\\vspace{1em}

`;
          });

          latex += `\\end{document}`;
          flashcardLatex = latex;
        }

        const latexToUse = useRepaired && repairedFlashcardLatex ? repairedFlashcardLatex : flashcardLatex;

        // Create form and submit to Overleaf
        const form = document.createElement('form');
        form.method = 'post';
        form.action = 'https://www.overleaf.com/docs';
        form.target = '_blank';

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'encoded_snip';
        input.value = encodeURIComponent(latexToUse);

        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);

        // Update button to show "Overleaf Options" on first open
        if (!useRepaired) {
          updateFlashcardOverleafButton();
        }
      } catch (err) {
        console.error('Overleaf export failed:', err);
        alert('Failed to open in Overleaf.');
      }
    };

    window.repairFlashcardLatex = async () => {
      const btn = document.querySelector('.flashcard-repair-btn');
      if (!btn || !flashcardLatex) return;

      try {
        flashcardRepairing = true;
        btn.disabled = true;
        btn.innerHTML = '⏳ Repairing...';

        await waitForApiKey();

        // Suppress interceptor to prevent "thinking" messages
        suppressIntercept = true;

        // Fetch flashcard repair prompt from backend
        console.log('[Flashcard Repair] Fetching flashcard repair prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/flashcard-latex-repair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ flashcardLatex })
        });
        const promptData = await promptResponse.json();
        if (!promptResponse.ok || !promptData.prompt) {
          throw new Error(promptData.error || 'Failed to retrieve flashcard repair prompt');
        }
        const repairPrompt = promptData.prompt;

        let usedModel = MODEL_PRO;
        let url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`;

        logModelUsage('FlashcardRepair', usedModel, 'attempt');

        const requestBody = {
          contents: [{
            parts: [{
              text: repairPrompt
            }]
          }],
          generationConfig: {
            temperature: 0.1,
          }
        };

        let response = await proxiedFetchForAI(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        // Handle 429 rate limit
        if (response.status === 429) {
          console.log("Pro model rate limited for repair, switching to Flash");

          // Show status message in chat
          const statusMsg = document.createElement('div');
          statusMsg.className = 'bot-message';
          statusMsg.innerHTML = `<div style="padding: 12px 20px; border-radius: 8px; background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); font-size: 13px; color: #e65100;">
            <div style="margin-bottom: 8px;">⚠️ Pro model rate limited</div>
            <div style="font-size: 12px;">Retrying with Flash model...</div>
          </div>`;
          chatEl.appendChild(statusMsg);
          typesetEl(statusMsg);
          keepScrolledToBottom();

          // Fade out after 4 seconds
          setTimeout(() => {
            statusMsg.style.transition = 'opacity 0.5s ease-out';
            statusMsg.style.opacity = '0';
            setTimeout(() => statusMsg.remove(), 500);
          }, 4000);

          // Retry with Flash
          usedModel = MODEL_FLASH;
          url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`;
          logModelUsage('FlashcardRepair', MODEL_FLASH, 'retry after rate limit');
          response = await proxiedFetchForAI(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });

          // Check if Flash is also rate limited
          if (response.status === 429) {
            console.log("Flash model also rate limited, switching to Flash Lite");

            // Set global rate limit notice with retry-after
            const retryAfter = response.headers.get('retry-after');
            setRateLimitNotice(retryAfter);

            // Show status message
            const statusMsg2 = document.createElement('div');
            statusMsg2.className = 'bot-message';
            statusMsg2.innerHTML = `<div style="padding: 12px 20px; border-radius: 8px; background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); font-size: 13px; color: #e65100;">
              <div style="margin-bottom: 8px;">⚠️ Flash model also rate limited</div>
              <div style="font-size: 12px;">Switching to Flash Lite...</div>
            </div>`;
            chatEl.appendChild(statusMsg2);
            typesetEl(statusMsg2);
            keepScrolledToBottom();

            // Fade out after 4 seconds
            setTimeout(() => {
              statusMsg2.style.transition = 'opacity 0.5s ease-out';
              statusMsg2.style.opacity = '0';
              setTimeout(() => statusMsg2.remove(), 500);
            }, 4000);

            // Retry with Flash Lite
            usedModel = MODEL_FLASHLITE;
            url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`;
            logModelUsage('FlashcardRepair', MODEL_FLASHLITE, 'retry after second rate limit');
            response = await proxiedFetchForAI(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            });
          }
        }

        suppressIntercept = false;

        logModelUsage('FlashcardRepair', usedModel, 'response received');

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(response.status, usedModel);

        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
          throw new Error("No response from Gemini");
        }

        let fixed = data.candidates[0].content.parts[0].text;
        // Remove markdown code blocks if present
        fixed = fixed.replace(/^```latex\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();

        repairedFlashcardLatex = fixed;

        // Check if auto-open is enabled
        const autoOpenCheckbox = document.getElementById('flashcard-auto-open');
        if (autoOpenCheckbox && autoOpenCheckbox.checked) {
          await openFlashcardsInOverleaf(true);
        }

        // Update button state and show all 3 options
        flashcardRepairing = false;
        updateFlashcardOptionsAfterRepair();

      } catch (err) {
        console.error('Repairment failed:', err);
        suppressIntercept = false;
        flashcardRepairing = false;
        btn.disabled = false;
        btn.innerHTML = '🛠️ Repair';
        alert('Failed to repair LaTeX. Please try again.');
      }
    };

    function updateFlashcardOptionsAfterRepair() {
      // Update the options page to show all 3 buttons
      const buttonsContainer = document.querySelector('.overleaf-options-buttons');
      if (buttonsContainer) {
        buttonsContainer.innerHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(false); hideFlashcardOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf flashcard-repair-btn" onclick="repairFlashcardLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(true); hideFlashcardOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      }
    }

    let flashcardOptionsShown = false;

    function updateFlashcardOverleafButton() {
      const navDiv = document.querySelector('.flashcard-nav');
      if (!navDiv) return;

      const existingContainer = navDiv.querySelector('.flashcard-overleaf-container');
      const overleafBtn = navDiv.querySelector('[onclick*="openFlashcardsInOverleaf"]');

      if (!overleafBtn && !existingContainer) return;

      // First update: Replace button with "Overleaf Options" button
      if (!existingContainer) {
        const optionsBtn = document.createElement('button');
        optionsBtn.className = 'flashcard-btn flashcard-btn-overleaf';
        optionsBtn.innerHTML = '🌱 Overleaf Options';
        optionsBtn.onclick = showFlashcardOverleafOptions;
        overleafBtn.replaceWith(optionsBtn);
      }
    }

    window.showFlashcardOverleafOptions = function() {
      let buttonHTML;
      if (flashcardRepairing) {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(false); hideFlashcardOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf flashcard-repair-btn" disabled style="width: 200px;">⏳ Repairing...</button>
        `;
      } else if (repairedFlashcardLatex) {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(false); hideFlashcardOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf flashcard-repair-btn" onclick="repairFlashcardLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(true); hideFlashcardOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      } else {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openFlashcardsInOverleaf(false); hideFlashcardOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf flashcard-repair-btn" onclick="repairFlashcardLatex();" style="width: 200px;">🛠️ Repair</button>
        `;
      }

      chatEl.innerHTML = `
        <div class="overleaf-options-container">
          <div class="overleaf-options-header">
            <div class="overleaf-options-title">Overleaf Export Options</div>
            <div class="overleaf-options-subtitle">Choose how to export your flashcards to Overleaf</div>
          </div>
          <div class="overleaf-options-buttons">
            ${buttonHTML}
          </div>
          <div class="overleaf-auto-open" style="margin-top: 20px; display: flex; align-items: center; gap: 8px; justify-content: center;">
            <input type="checkbox" id="flashcard-auto-open" checked style="cursor: pointer;">
            <label for="flashcard-auto-open" style="cursor: pointer; font-size: 14px;">Automatically open in Overleaf after repair</label>
          </div>
          <div class="overleaf-options-back">
            <button class="flashcard-btn" onclick="hideFlashcardOverleafOptions()">← Back to Flashcards</button>
          </div>
        </div>
      `;
      chatEl.scrollTop = 0;
      flashcardOptionsShown = true;
    };

    window.hideFlashcardOverleafOptions = function() {
      renderFlashcard();
    };

    window.viewPreviousFlashcards = function() {
      // Don't reset options state - just view flashcards
      flashcardMode = true;
      flashcardCurrent = 0;
      updateHeaderSubtitle('Flashcard Mode');
      setError('');
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      flashcardBtn.style.display = 'none';
      renderFlashcard();
    };

    window.enterFlashcardMode = enterFlashcardMode;
    window.exitFlashcardMode = exitFlashcardMode;

    // ===== CHECKLIST GENERATION =====
    let checklistData = [];
    let cachedChecklistData = null;
    let checklistCoverageCache = {}; // Cache for checklist item coverage results
    let checklistMode = false;
    let checklistGenerating = false;
    let checklistGeneratingInBackground = false;
    let checklistRateLimited = false; // Track if checklist generation was rate limited in background
    let checklistCountdownInterval = null;
    let checklistCountdownStartTime = null;
    let checklistCountdownPhase = 1;

    checklistBtn.addEventListener("click", async () => {
      // If checklist was rate limited in background, show rate limit dialog
      if (checklistRateLimited) {
        console.log('[Checklist] Showing rate limit dialog after background rate limit');
        checklistRateLimited = false;
        checklistBtn.textContent = 'Checklist';

        // Show rate limit dialog
        const useFlash = await new Promise((resolve) => {
          saveChatBeforeClearing();
          chatEl.innerHTML = '';
          controlsEl.style.display = 'none';
          inputRowEl.style.display = 'none';
          attEl.style.display = 'none';
          checklistBtn.style.display = 'none';

          const container = document.createElement('div');
          container.className = 'quiz-generating';
          container.innerHTML = `
            <div class="quiz-gen-text">⚠️ Rate Limited</div>
            <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model was rate limited during checklist generation. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the checklist.</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn" id="checklist-rate-limit-cancel">Try Again Later</button>
              <button class="flashcard-btn flashcard-btn-primary" id="checklist-rate-limit-flash">Use Flash Model</button>
            </div>
          `;
          chatEl.appendChild(container);

          document.getElementById('checklist-rate-limit-cancel').onclick = () => resolve(false);
          document.getElementById('checklist-rate-limit-flash').onclick = () => resolve(true);
        });

        if (!useFlash) {
          // User chose to try again later - restore UI
          restoreSavedChatContent();
          controlsEl.style.display = '';
          inputRowEl.style.display = '';
          attEl.style.display = '';
          checklistBtn.style.display = '';
          updateHeaderSubtitle('Ask about this slide');
          return;
        }

        // User chose to use Flash model - restart checklist generation with Flash
        console.log('[Checklist] User chose to use Flash model after background rate limit');
        checklistGenerating = true;
        checklistGeneratingInBackground = false;
      }

      // If cached checklist exists, use it immediately
      if (cachedChecklistData && checklistBtn.textContent === 'Checklist (Ready)') {
        console.log("Using cached checklist data");
        checklistData = cachedChecklistData;
        cachedChecklistData = null;
        checklistGeneratingInBackground = false;
        checklistBtn.textContent = 'Checklist';
        enterChecklistMode();
        return;
      }

      // If checklist is generating in background, show the generating UI
      if (checklistGeneratingInBackground || checklistGenerating) {
        console.log("Checklist still generating in background - showing UI");
        checklistGenerating = true;
        checklistGeneratingInBackground = false;
        checklistBtn.style.display = 'none';
        showChecklistGenerating();
        updateHeaderSubtitle('Generating Checklist...');
        return;
      }

      // If checklist already exists, show option to view or regenerate
      if (checklistData.length > 0) {
        controlsEl.style.display = 'none';
        inputRowEl.style.display = 'none';
        attEl.style.display = 'none';
        checklistBtn.style.display = 'none';

        chatEl.innerHTML = `
          <div class="quiz-generating">
            <div class="quiz-gen-text">Checklist Available</div>
            <div class="quiz-gen-subtext">You have a checklist with ${checklistData.length} items from a previous generation</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn flashcard-btn-primary" onclick="viewPreviousChecklist()">View Checklist</button>
              <button class="flashcard-btn" onclick="generateNewChecklist()">Generate New</button>
            </div>
          </div>
        `;
        return;
      }

      generateNewChecklist();
    });

    function showChecklistGenerating() {
      // Don't update UI if generating in background
      if (checklistGeneratingInBackground) return;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      // Calculate current countdown value if timer is already running
      let currentCountdown = 40;
      if (checklistCountdownStartTime) {
        const elapsed = Math.floor((Date.now() - checklistCountdownStartTime) / 1000);
        if (checklistCountdownPhase === 1) {
          currentCountdown = Math.max(0, 40 - elapsed);
        } else if (checklistCountdownPhase === 2) {
          currentCountdown = Math.max(0, 19 - (elapsed - 40));
        }
      }

      const container = document.createElement('div');
      container.className = 'quiz-generating checklist-generating-container';
      container.innerHTML = `
        <div class="quiz-gen-spinner"></div>
        <div class="quiz-gen-text">Generating Lecture Checklist...</div>
        <div class="quiz-gen-subtext">Analyzing what was covered in this lecture</div>
        <div class="quiz-gen-eta checklist-eta" style="font-size: 13px; color: #666; margin-top: 8px;">ETA: ${currentCountdown} seconds</div>
        <div class="checklist-generating-status"></div>
        <button class="quiz-gen-stop" id="checklist-gen-stop-btn">Exit</button>
      `;
      chatEl.appendChild(container);

      // Only start countdown timer if not already running
      if (!checklistCountdownInterval) {
        checklistCountdownStartTime = Date.now();
        checklistCountdownPhase = 1;

        checklistCountdownInterval = setInterval(() => {
          const etaElement = document.querySelector('.checklist-eta');
          if (!etaElement) return;

          const elapsed = Math.floor((Date.now() - checklistCountdownStartTime) / 1000);

          if (checklistCountdownPhase === 1) {
            const remaining = Math.max(0, 40 - elapsed);
            if (remaining > 0) {
              etaElement.textContent = `ETA: ${remaining} seconds`;
            } else {
              checklistCountdownPhase = 2;
            }
          } else if (checklistCountdownPhase === 2) {
            const remaining = Math.max(0, 19 - (elapsed - 40));
            if (remaining > 0) {
              etaElement.textContent = `Hold tight, it's almost done: ${remaining} seconds`;
            } else {
              checklistCountdownPhase = 3;
              etaElement.textContent = "Sorry, this is taking longer than expected...";
              clearInterval(checklistCountdownInterval);
              checklistCountdownInterval = null;
            }
          } else if (checklistCountdownPhase === 3) {
            etaElement.textContent = "Sorry, this is taking longer than expected...";
          }
        }, 1000);
      }

      const stopBtn = container.querySelector('#checklist-gen-stop-btn');
      stopBtn.addEventListener('click', () => {
        console.log("User stopped watching checklist generation - continuing in background");

        checklistGenerating = false;
        checklistGeneratingInBackground = true;
        restoreSavedChatContent();
        controlsEl.style.display = '';
        inputRowEl.style.display = '';
        attEl.style.display = '';
        checklistBtn.style.display = '';
        checklistBtn.textContent = 'Checklist (Generating...)';
        updateHeaderSubtitle('Ask about this slide');
      });
    }

    window.generateNewChecklist = async () => {
      console.log("Starting checklist generation");
      setError("");

      // Clear previous checklist's checked items from localStorage
      localStorage.removeItem('checklist_checked');

      checklistGenerating = true;
      checklistBtn.style.display = 'none';

      showChecklistGenerating();
      updateHeaderSubtitle('Generating Checklist...');

      // Retry logic for handling JSON parse errors
      let malformedRetryCount = 0;
      const maxMalformedRetries = 5;
      let generatedChecklist = null;
      let finalChecklistModel = null;

      while (!generatedChecklist) {
        try {
          if (malformedRetryCount > 0) {
            console.log(`Retry attempt ${malformedRetryCount}/${maxMalformedRetries} due to malformed JSON`);
            const genStatus = chatEl.querySelector('.checklist-generating-status');
            if (genStatus) {
              genStatus.innerHTML = `
                <div style="margin-bottom: 8px;">⚠️ Malformed response detected</div>
                <div style="font-size: 12px; color: #999;">Retrying (${malformedRetryCount}/${maxMalformedRetries})...</div>
              `;
            }
            // Add delay before retry to prevent spam
            await new Promise(resolve => setTimeout(resolve, 2000));
          }

        suppressIntercept = true;

        // Initialize files if not already done
        if (!filesInitialized && !filesInitializing) {
          await initializeFiles(null);
        } else if (filesInitializing) {
          while (filesInitializing) {
            await new Promise(r => setTimeout(r, 100));
          }
        }

        const vttUri = uploadedVttUri;
        const pdfUri = uploadedPdfUri;

        console.log("Using uploaded files for checklist - VTT:", vttUri, "PDF:", pdfUri);

        // Fetch checklist prompt from backend
        console.log('[Checklist] Fetching checklist generation prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/checklist-generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        const promptData = await promptResponse.json();
        let checklistPrompt = promptData.prompt;

        // Append YouTube-specific instructions if on YouTube
        if (isYouTubePage()) {
          checklistPrompt += "\n\nIMPORTANT: For this YouTube video, the attached text files represent: (1) the video summary as 'lecture slides', and (2) the audio transcript if available. Generate the checklist based on these attached documents only. Treat the video summary text as if it were lecture slides content.";
        }

        const parts = [{ text: checklistPrompt }];
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        if (pdfUri) parts.push({ fileData: { mimeType: pdfMimeType, fileUri: pdfUri } });
        if (vttUri) parts.push({ fileData: { mimeType: "text/plain", fileUri: vttUri } });

        const body = {
          contents: [{ parts }]
        };

        await waitForApiKey();

        // Create abort controller for timeout (checklist)
        const checklistController = new AbortController();
        const checklistTimeoutId = setTimeout(() => checklistController.abort(), 120000); // 120 seconds

        let resp;
        let usedModel = MODEL_PRO;
        let retryWithFlash = false;

        try {
          logModelUsage('Checklist', usedModel, 'attempt');
          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: checklistController.signal
            }
          );
          clearTimeout(checklistTimeoutId);

          // Check for 429 rate limit error
          if (resp.status === 429) {
            const errorData = await resp.json();
            console.log("Pro model rate limited for checklist");

            // If generating in background, mark as rate limited and exit
            if (checklistGeneratingInBackground) {
              console.log('[Checklist] Rate limited in background - will show dialog when user returns');
              checklistRateLimited = true;
              checklistGeneratingInBackground = false;
              checklistGenerating = false;
              checklistBtn.textContent = 'Checklist (Rate Limited)';
              throw new Error('Rate limited - user needs to decide');
            }

            // Show rate limit dialog with option to use Flash model
            const useFlash = await new Promise((resolve) => {
              saveChatBeforeClearing();
              chatEl.innerHTML = '';
              controlsEl.style.display = 'none';
              inputRowEl.style.display = 'none';
              attEl.style.display = 'none';

              const container = document.createElement('div');
              container.className = 'quiz-generating';
              container.innerHTML = `
                <div class="quiz-gen-text">⚠️ Rate Limited</div>
                <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">The Pro model has been rate limited. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the checklist.</div>
                <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
                  <button class="flashcard-btn" id="checklist-rate-limit-cancel">Try Again Later</button>
                  <button class="flashcard-btn flashcard-btn-primary" id="checklist-rate-limit-flash">Use Flash Model</button>
                </div>
              `;
              chatEl.appendChild(container);

              document.getElementById('checklist-rate-limit-cancel').onclick = () => resolve(false);
              document.getElementById('checklist-rate-limit-flash').onclick = () => resolve(true);
            });

            if (!useFlash) {
              // User chose to try again later - restore UI and exit
              restoreSavedChatContent();
              controlsEl.style.display = '';
              inputRowEl.style.display = '';
              attEl.style.display = '';
              checklistBtn.style.display = '';
              checklistGenerating = false;
              updateHeaderSubtitle('Ask about this slide');
              throw new Error('User chose to try again later');
            }

            // User chose to use Flash model - continue with Flash
            console.log('[Checklist] User chose to use Flash model');
            logModelUsage('Checklist', MODEL_FLASH, 'retry after rate limit');

            // Show continuing with Flash message
            showChecklistGenerating();
            const genStatus = chatEl.querySelector('.checklist-generating-status');
            if (genStatus) {
              genStatus.classList.remove('fade-out');
              genStatus.innerHTML = `
                <div style="margin-bottom: 8px;">⚠️ Using Flash model</div>
                <div style="font-size: 12px;">Quality may be degraded...</div>
              `;
              setTimeout(() => {
                genStatus.classList.add('fade-out');
                setTimeout(() => { genStatus.innerHTML = ''; }, 500);
              }, 4000);
            }

            retryWithFlash = true;
          }
        } catch (err) {
          clearTimeout(checklistTimeoutId);
          if (err.name === 'AbortError') {
            throw new Error("Request timed out after 120 seconds");
          }
          throw err;
        }

        // Retry with Flash if Pro was rate limited
        if (retryWithFlash) {
          console.log("Retrying checklist generation with Flash model");
          const flashController = new AbortController();
          const flashTimeoutId = setTimeout(() => flashController.abort(), 120000);

          try {
            resp = await proxiedFetchForAI(
              `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: flashController.signal
              }
            );
            clearTimeout(flashTimeoutId);
            usedModel = MODEL_FLASH;
            logModelUsage('Checklist', usedModel, 'retry response');

            // Check if Flash is also rate limited
            if (resp.status === 429) {
              console.log("Flash model also rate limited for checklist, switching to Flash Lite");
              logModelUsage('Checklist', MODEL_FLASHLITE, 'retry after second rate limit');

              // Set rate limit notice globally with retry-after
              const retryAfter = resp.headers.get('retry-after');
              setRateLimitNotice(retryAfter);

              // Update UI to show we're switching to Flash Lite
              const genStatus = chatEl.querySelector('.checklist-generating-status');
              if (genStatus) {
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">⚠️ Flash model also rate limited</div>
                  <div style="font-size: 12px; color: #999;">Switching to Flash Lite...</div>
                `;
              }

              // Retry with Flash Lite
              const liteController = new AbortController();
              const liteTimeoutId = setTimeout(() => liteController.abort(), 120000);

              try {
                resp = await proxiedFetchForAI(
                  `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                    signal: liteController.signal
                  }
                );
                clearTimeout(liteTimeoutId);
                usedModel = MODEL_FLASHLITE;
                logModelUsage('Checklist', usedModel, 'retry response');
              } catch (err) {
                clearTimeout(liteTimeoutId);
                if (err.name === 'AbortError') {
                  throw new Error("Request timed out after 120 seconds");
                }
                throw err;
              }
            } else {
              // Update UI to show we're using Flash
              const genStatus = chatEl.querySelector('.checklist-generating-status');
              if (genStatus) {
                genStatus.innerHTML = `
                  <div style="margin-bottom: 8px;">✨ Generating with Flash model...</div>
                `;
              }
            }
          } catch (err) {
            clearTimeout(flashTimeoutId);
            if (err.name === 'AbortError') {
              throw new Error("Request timed out after 120 seconds");
            }
            throw err;
          }
        }

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(resp.status, usedModel);

        const data = await resp.json();
        let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        console.log("[Checklist] Raw response:", rawText.substring(0, 200) + "...");

        // Clean up the response text to extract JSON
        let cleanedText = rawText.trim();

        // Remove any text before the opening bracket
        const firstBracket = cleanedText.indexOf('[');
        if (firstBracket > 0) {
          console.log("[Checklist] Removing text before JSON array");
          cleanedText = cleanedText.substring(firstBracket);
        }

        // Remove any text after the closing bracket
        const lastBracket = cleanedText.lastIndexOf(']');
        if (lastBracket > 0 && lastBracket < cleanedText.length - 1) {
          console.log("[Checklist] Removing text after JSON array");
          cleanedText = cleanedText.substring(0, lastBracket + 1);
        }

        // Extract JSON from markdown code blocks if still wrapped
        const jsonMatch = cleanedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (jsonMatch) {
          console.log("[Checklist] Extracted JSON from code block");
          cleanedText = jsonMatch[1].trim();
        }

        // Try to parse with progressive fixes
        let parseAttempts = [
          // Attempt 1: Parse as-is
        () => JSON.parse(cleanedText),

          // Attempt 2: Fix unescaped backslashes in LaTeX
          () => {
            console.log("[Checklist] Attempt 2: Fixing LaTeX backslashes");
            const fixedText = cleanedText.replace(/"([^"]*?)"/g, (match, content) => {
              const fixed = content.replace(/\\(?![\\"])/g, '\\\\');
              return `"${fixed}"`;
            });
            return JSON.parse(fixedText);
          },

          // Attempt 3: Fix single quotes to double quotes
          () => {
            console.log("[Checklist] Attempt 3: Fixing single quotes");
            const fixedText = cleanedText.replace(/'/g, '"');
            return JSON.parse(fixedText);
          },

          // Attempt 4: Remove trailing commas
          () => {
            console.log("[Checklist] Attempt 4: Removing trailing commas");
            const fixedText = cleanedText.replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
            return JSON.parse(fixedText);
          }
        ];

        let parseError = null;
        for (let i = 0; i < parseAttempts.length; i++) {
          try {
            generatedChecklist = parseAttempts[i]();
            console.log(`[Checklist] Successfully parsed on attempt ${i + 1}`);
            break;
          } catch (e) {
            parseError = e;
            console.warn(`[Checklist] Parse attempt ${i + 1} failed:`, e.message);
          }
        }

        if (!generatedChecklist) {
          console.error("[Checklist] All parse attempts failed:", parseError.message);
          console.error("[Checklist] Cleaned text was:", cleanedText.substring(0, 500));
          malformedRetryCount++;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error(`Failed to parse checklist JSON after ${maxMalformedRetries} retries. Last error: ${parseError.message}`);
          }
          continue;
        }

        // Validate the parsed result
        if (!Array.isArray(generatedChecklist)) {
          console.error("[Checklist] Response is not an array:", typeof generatedChecklist);
          malformedRetryCount++;
          generatedChecklist = null;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error("Invalid checklist format - expected array of items, got " + typeof generatedChecklist);
          }
          continue;
        }

        if (generatedChecklist.length === 0) {
          console.error("[Checklist] Array is empty");
          malformedRetryCount++;
          generatedChecklist = null;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error("Invalid checklist format - array is empty");
          }
          continue;
        }

        if (generatedChecklist.length < 5) {
          console.error("[Checklist] Array has less than 5 items:", generatedChecklist.length);
          malformedRetryCount++;
          generatedChecklist = null;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error(`Invalid checklist format - expected at least 5 items, got ${generatedChecklist.length}`);
          }
          continue;
        }

        // Validate all items are strings
        const invalidItems = generatedChecklist.filter(item => typeof item !== 'string');
        if (invalidItems.length > 0) {
          console.error("[Checklist] Array contains non-string items:", invalidItems);
          malformedRetryCount++;
          generatedChecklist = null;
          if (malformedRetryCount > maxMalformedRetries) {
            throw new Error("Invalid checklist format - all items must be strings");
          }
          continue;
        }

        console.log(`[Checklist] ✓ Valid checklist with ${generatedChecklist.length} items`);
        finalChecklistModel = usedModel;
        logModelUsage('Checklist', finalChecklistModel, 'response received');
        break; // Success, exit retry loop

      } catch (e) {
        console.error("Checklist generation attempt failed:", e);

        const errMsg = (e?.message || e)?.toString() || '';
        if (errMsg.includes('user needs to decide') || errMsg.includes('User chose to try again later')) {
          suppressIntercept = false;
          checklistGenerating = false;
          checklistGeneratingInBackground = false;
          return;
        }

        // Check if this is a malformed JSON error or a network/timeout error
        const isMalformedError = e.message && e.message.includes('Failed to parse checklist JSON');

        if (isMalformedError) {
          // This is a malformed JSON error that already incremented the counter
          if (malformedRetryCount > maxMalformedRetries) {
            // Final failure after all retries
            console.error("Checklist generation failed after all retries:", e);

            // If it was running in background, just update button
            if (checklistGeneratingInBackground) {
              checklistGeneratingInBackground = false;
              checklistBtn.textContent = 'Checklist';
              console.log("Background generation failed");
              return;
            }

            setError("Checklist generation failed: " + (e?.message || e));
            restoreSavedChatContent();
            controlsEl.style.display = '';
            inputRowEl.style.display = '';
            attEl.style.display = '';
            checklistBtn.style.display = '';
            updateHeaderSubtitle('Ask about this slide');
            suppressIntercept = false;
            checklistGenerating = false;
            return;
          }
        }
        // For network/timeout errors, add delay before retry
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } // End of retry while loop

    // If we got here, we have valid checklist
    if (generatedChecklist) {
      // Clear countdown interval
      if (checklistCountdownInterval) {
        clearInterval(checklistCountdownInterval);
        checklistCountdownInterval = null;
        checklistCountdownStartTime = null;
        checklistCountdownPhase = 1;
      }

      // If it was running in background, cache it
      if (checklistGeneratingInBackground) {
        cachedChecklistData = generatedChecklist;
        checklistGeneratingInBackground = false;
        checklistBtn.textContent = 'Checklist (Ready)';
        console.log("Background generation complete - checklist cached");
        suppressIntercept = false;
        checklistGenerating = false;
        return;
      }

      checklistData = generatedChecklist;
      // Clear coverage cache for new checklist
      checklistCoverageCache = {};
      // Reset overleaf options state for new checklist
      checklistOptionsShown = false;
      checklistLatex = null;
      repairedChecklistLatex = null;
      suppressIntercept = false;
      checklistGenerating = false;
      enterChecklistMode();
    } else {
      // Shouldn't happen, but handle it
      console.error("Checklist generation failed: No checklist generated");

      // If it was running in background, just update button
      if (checklistGeneratingInBackground) {
        checklistGeneratingInBackground = false;
        checklistBtn.textContent = 'Checklist';
        console.log("Background generation failed");
        suppressIntercept = false;
        checklistGenerating = false;
        return;
      }

      setError("Checklist generation failed: No checklist generated");
      restoreSavedChatContent();
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      checklistBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
      suppressIntercept = false;
      checklistGenerating = false;
    }
  };

    function enterChecklistMode() {
      checklistMode = true;

      // Clear countdown interval if it exists
      const genContainer = chatEl.querySelector('.quiz-generating');
      if (genContainer && genContainer.dataset.countdownInterval) {
        clearInterval(parseInt(genContainer.dataset.countdownInterval));
      }

      updateHeaderSubtitle('Checklist Mode');

      // Clear any error messages
      setError('');

      // Hide controls
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      checklistBtn.style.display = 'none';

      // Check if we should show overleaf options instead
      if (checklistOptionsShown && checklistLatex) {
        showChecklistOverleafOptions();
      } else {
        renderChecklist();
      }
    }

    function exitChecklistMode() {
      checklistMode = false;
      // Don't clear checklistData - keep it for next time

      // Restore saved chat content if available, otherwise clear
      restoreSavedChatContent();

      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      checklistBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
    }

    function renderChecklist() {
      const checkedItems = JSON.parse(localStorage.getItem('checklist_checked') || '{}');

      saveChatBeforeClearing();
      chatEl.innerHTML = `
        <div class="checklist-container">
          <div class="checklist-header">
            <div class="checklist-title">Lecture Checklist</div>
            <div class="checklist-subtitle">Topics covered in this lecture - check off as you study</div>
          </div>
          <div class="checklist-items">
            ${checklistData.map((item, idx) => `
              <div class="checklist-item ${checkedItems[idx] ? 'checked' : ''}" id="checklist-item-${idx}">
                <input
                  type="checkbox"
                  class="checklist-checkbox"
                  ${checkedItems[idx] ? 'checked' : ''}
                  onchange="toggleChecklistItem(${idx})"
                  id="checkbox-${idx}"
                />
                <label for="checkbox-${idx}" class="checklist-text">${renderMarkdown(item)}</label>
                <div class="checklist-help-icon" id="help-icon-${idx}" onclick="findChecklistItemCoverage(${idx})" title="Find where this topic was covered">?</div>
              </div>
            `).join('')}
          </div>
          <div class="checklist-actions">
            ${checklistLatex ?
              '<button class="flashcard-btn flashcard-btn-overleaf" onclick="showChecklistOverleafOptions()">🌱 Overleaf Options</button>' :
              '<button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf()">🌱 Open in Overleaf</button>'
            }
            <button class="flashcard-btn" onclick="exitChecklistMode()">Exit Checklist</button>
          </div>
        </div>
      `;
      chatEl.scrollTop = 0;

      // Typeset LaTeX in checklist content
      typesetEl(chatEl).then(() => {
        console.log('[Checklist] LaTeX typesetting completed');
      }).catch((err) => {
        console.error('[Checklist] LaTeX typesetting error:', err);
      });
    }

    window.toggleChecklistItem = (idx) => {
      const checkedItems = JSON.parse(localStorage.getItem('checklist_checked') || '{}');
      const checkbox = document.getElementById(`checkbox-${idx}`);
      const item = document.getElementById(`checklist-item-${idx}`);

      if (checkbox.checked) {
        checkedItems[idx] = true;
        item.classList.add('checked');
      } else {
        delete checkedItems[idx];
        item.classList.remove('checked');
      }

      localStorage.setItem('checklist_checked', JSON.stringify(checkedItems));
    };

    window.findChecklistItemCoverage = async (idx) => {
      const item = checklistData[idx];
      const helpIcon = document.getElementById(`help-icon-${idx}`);
      const checklistItemEl = document.getElementById(`checklist-item-${idx}`);

      if (!helpIcon || !checklistItemEl) return;

      // Remove any existing coverage info (toggle off)
      const existingCoverage = checklistItemEl.nextSibling;
      if (existingCoverage && existingCoverage.classList && existingCoverage.classList.contains('coverage-info')) {
        existingCoverage.remove();
        helpIcon.classList.remove('loading');
        helpIcon.textContent = '?';
        helpIcon.style.background = '';
        helpIcon.style.color = '';
        return;
      }

      // Check if we have cached coverage for this item
      if (checklistCoverageCache[idx]) {
        console.log(`[Checklist Coverage] Using cached coverage for item ${idx}`);
        const coverage = checklistCoverageCache[idx];

        // Display cached results
        const slidesText = coverage.slides_coverage.slide_numbers.length > 0
          ? `Slides: ${coverage.slides_coverage.slide_numbers.join(', ')}`
          : 'Slides: Not found';

        const timestampsText = coverage.recording_coverage.timestamps.length > 0
          ? `Timestamps: ${coverage.recording_coverage.timestamps.join(', ')}`
          : 'Timestamps: Not found';

        const coverageInfoEl = document.createElement('div');
        coverageInfoEl.className = 'coverage-info';
        coverageInfoEl.innerHTML = `
          <div class="coverage-section">
            <div class="coverage-label">📊 ${slidesText}</div>
            <div class="coverage-desc">${coverage.slides_coverage.description}</div>
          </div>
          <div class="coverage-section">
            <div class="coverage-label">⏱️ ${timestampsText}</div>
            <div class="coverage-desc">${coverage.recording_coverage.description}</div>
          </div>
        `;

        // Insert after the checklist item
        checklistItemEl.parentNode.insertBefore(coverageInfoEl, checklistItemEl.nextSibling);

        // Change icon to indicate it's expanded
        helpIcon.textContent = '✓';
        helpIcon.style.background = 'rgba(76, 175, 80, 0.2)';
        helpIcon.style.color = '#4caf50';

        return;
      }

      // Show loading state (only if not using cache)
      helpIcon.classList.add('loading');
      helpIcon.textContent = '⏳';

      // Suppress normal chat interception
      const previousSuppressState = suppressIntercept;
      suppressIntercept = true;

      try {
        console.log(`[Checklist Coverage] Finding coverage for item ${idx}: ${item}`);

        // Ensure files are initialized
        if (!filesInitialized && !filesInitializing) {
          await initializeFiles(null);
        } else if (filesInitializing) {
          while (filesInitializing) {
            await new Promise(r => setTimeout(r, 100));
          }
        }

        const vttUri = uploadedVttUri;
        const pdfUri = uploadedPdfUri;

        if (!vttUri && !pdfUri) {
          throw new Error('No transcript or slides available');
        }

        // Fetch coverage analysis prompt from backend
        console.log('[Coverage] Fetching coverage analysis prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/coverage-analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item: item })
        });
        const promptData = await promptResponse.json();
        const coveragePrompt = promptData.prompt;

        await waitForApiKey();

        const parts = [{ text: coveragePrompt }];
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        if (pdfUri) parts.push({ fileData: { mimeType: pdfMimeType, fileUri: pdfUri } });
        if (vttUri) parts.push({ fileData: { mimeType: "text/plain", fileUri: vttUri } });

        const body = {
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.0,
            responseMimeType: "application/json"
          }
        };

        console.log('[Checklist Coverage] Sending request to AI Flash model...');

        const resp = await proxiedFetchForAI(
          `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
          }
        );

        if (!resp.ok) {
          const errorData = await resp.json();
          throw new Error(`API Error: ${errorData.error?.message || resp.statusText}`);
        }

        const data = await resp.json();
        console.log('[Checklist Coverage] Received response:', data);

        // Extract text from response
        let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        console.log('[Checklist Coverage] Raw response text:', rawText);

        // Aggressive cleaning of response text
        rawText = rawText
          .replace(/```json\s*/gi, '')  // Remove ```json
          .replace(/```\s*/g, '')        // Remove ```
          .replace(/^[\s\n]+/, '')       // Remove leading whitespace
          .replace(/[\s\n]+$/, '')       // Remove trailing whitespace
          .trim();

        console.log('[Checklist Coverage] Cleaned response text:', rawText);

        // Parse JSON
        let coverage;
        try {
          coverage = JSON.parse(rawText);
        } catch (parseError) {
          console.error('[Checklist Coverage] JSON parse error:', parseError);
          console.error('[Checklist Coverage] Failed to parse:', rawText);
          throw new Error(`Malformed response: ${parseError.message}`);
        }

        // Validate structure
        if (!coverage.slides_coverage || !coverage.recording_coverage) {
          console.error('[Checklist Coverage] Invalid structure:', coverage);
          throw new Error('Response missing required fields (slides_coverage or recording_coverage)');
        }

        if (!Array.isArray(coverage.slides_coverage.slide_numbers)) {
          throw new Error('slides_coverage.slide_numbers must be an array');
        }

        if (!Array.isArray(coverage.recording_coverage.timestamps)) {
          throw new Error('recording_coverage.timestamps must be an array');
        }

        console.log('[Checklist Coverage] Parsed coverage:', coverage);

        // Cache the coverage for future use
        checklistCoverageCache[idx] = coverage;
        console.log(`[Checklist Coverage] Cached coverage for item ${idx}`);

        // Display results under the checklist item
        const slidesText = coverage.slides_coverage.slide_numbers.length > 0
          ? `Slides: ${coverage.slides_coverage.slide_numbers.join(', ')}`
          : 'Slides: Not found';

        const timestampsText = coverage.recording_coverage.timestamps.length > 0
          ? `Timestamps: ${coverage.recording_coverage.timestamps.join(', ')}`
          : 'Timestamps: Not found';

        const coverageInfoEl = document.createElement('div');
        coverageInfoEl.className = 'coverage-info';
        coverageInfoEl.innerHTML = `
          <div class="coverage-section">
            <div class="coverage-label">📊 ${slidesText}</div>
            <div class="coverage-desc">${coverage.slides_coverage.description}</div>
          </div>
          <div class="coverage-section">
            <div class="coverage-label">⏱️ ${timestampsText}</div>
            <div class="coverage-desc">${coverage.recording_coverage.description}</div>
          </div>
        `;

        // Insert after the checklist item
        checklistItemEl.parentNode.insertBefore(coverageInfoEl, checklistItemEl.nextSibling);

        // Change icon to indicate it's expanded
        helpIcon.textContent = '✓';
        helpIcon.style.background = 'rgba(76, 175, 80, 0.2)';
        helpIcon.style.color = '#4caf50';

      } catch (error) {
        console.error('[Checklist Coverage] Error:', error);
        alert(`Failed to find coverage information:\n${error.message}`);
      } finally {
        // Restore suppress state
        suppressIntercept = previousSuppressState;

        // Restore icon (only if not showing results)
        if (!checklistItemEl.nextSibling || !checklistItemEl.nextSibling.classList?.contains('coverage-info')) {
          helpIcon.classList.remove('loading');
          helpIcon.textContent = '?';
        }
      }
    };

    window.saveChecklistPDF = async () => {
      try {
        await ensureJsPDF();
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        const margin = 20;
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        const contentWidth = pageWidth - 2 * margin;

        function cleanText(text) {
          return text
            // Remove HTML tags
            .replace(/<[^>]*>/g, '')
            // Convert display math to readable format
            .replace(/\$\$([^$]+)\$\$/g, (match, p1) => `[Math: ${p1}]`)
            // Convert inline math to readable format
            .replace(/\$([^$]+)\$/g, (match, p1) => p1)
            // Bold markdown
            .replace(/\*\*([^*]+)\*\*/g, '$1')
            .replace(/__([^_]+)__/g, '$1')
            // Italic markdown
            .replace(/\*([^*]+)\*/g, '$1')
            .replace(/_([^_]+)_/g, '$1')
            // Code markdown
            .replace(/`([^`]+)`/g, '"$1"')
            // Headers
            .replace(/^#{1,6}\s+/gm, '')
            // Lists
            .replace(/^\s*[-*+]\s+/gm, '• ')
            .replace(/^\s*\d+\.\s+/gm, '')
            // Links
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            // Line breaks
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        }

        const checkedItems = JSON.parse(localStorage.getItem('checklist_checked') || '{}');

        doc.setFontSize(18);
        doc.text('Lecture Checklist', margin, margin);
        doc.setFontSize(10);
        doc.text(`Generated: ${new Date().toLocaleDateString()}`, margin, margin + 7);
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text('Powered by LeQture', pageWidth - margin, margin, { align: 'right' });
        doc.setTextColor(0, 0, 0);

        let y = margin + 20;

        checklistData.forEach((item, idx) => {
          if (y > pageHeight - 30) {
            doc.addPage();
            y = margin;
          }

          const checkbox = checkedItems[idx] ? '☑' : '☐';
          doc.setFontSize(11);
          doc.text(checkbox, margin, y);

          const lines = doc.splitTextToSize(cleanText(item), contentWidth - 15);
          doc.text(lines, margin + 8, y);
          y += lines.length * 6 + 4;
        });

        doc.save('lecture-checklist.pdf');
      } catch (err) {
        console.error('PDF generation failed:', err);
        alert('PDF generation failed. Please ensure jsPDF library is available.');
      }
    };

    let checklistLatex = null;
    let repairedChecklistLatex = null;
    let checklistRepairing = false;

    window.openChecklistInOverleaf = async (useRepaired = false) => {
      try {
        // Helper function to convert markdown to LaTeX
        function convertMarkdownToLatex(text) {
          return text
            // Convert **bold** to \textbf{bold}
            .replace(/\*\*(.+?)\*\*/g, '\\textbf{$1}')
            // Convert *italic* to \textit{italic}
            .replace(/\*(.+?)\*/g, '\\textit{$1}')
            // Convert `code` to \texttt{code}
            .replace(/`(.+?)`/g, '\\texttt{$1}');
        }

        // Build LaTeX document if not already built
        if (!checklistLatex) {
          let latex = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amssymb}
\\usepackage{enumitem}
\\usepackage{geometry}
\\geometry{margin=1in}

\\title{Lecture Checklist}
\\author{Generated by LeQture}
\\date{${new Date().toLocaleDateString()}}

\\begin{document}
\\maketitle

\\section*{Checklist Items}

\\begin{itemize}[label=\\(\\square\\)]
`;

          checklistData.forEach((item) => {
            latex += `  \\item ${convertMarkdownToLatex(item)}\n`;
          });

          latex += `\\end{itemize}

\\end{document}`;
          checklistLatex = latex;
        }

        const latexToUse = useRepaired && repairedChecklistLatex ? repairedChecklistLatex : checklistLatex;

        // Create form and submit to Overleaf
        const form = document.createElement('form');
        form.method = 'post';
        form.action = 'https://www.overleaf.com/docs';
        form.target = '_blank';

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'encoded_snip';
        input.value = encodeURIComponent(latexToUse);

        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);

        // Update button to show "Overleaf Options" on first open
        if (!useRepaired) {
          updateChecklistOverleafButton();
        }
      } catch (err) {
        console.error('Overleaf export failed:', err);
        alert('Failed to open in Overleaf.');
      }
    };

    window.repairChecklistLatex = async () => {
      const btn = document.querySelector('.checklist-repair-btn');
      if (!btn || !checklistLatex) return;

      try {
        checklistRepairing = true;
        btn.disabled = true;
        btn.innerHTML = '⏳ Repairing...';

        await waitForApiKey();

        // Suppress interceptor to prevent "thinking" messages
        suppressIntercept = true;

        let usedModel = MODEL_PRO;
        let url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`;

        // Fetch LaTeX fix prompt from backend
        console.log('[Checklist Repair] Fetching LaTeX fix prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/latex-fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latexContent: checklistLatex })
        });
        const promptData = await promptResponse.json();
        const promptText = promptData.prompt;

        const requestBody = {
          contents: [{
            parts: [{
              text: promptText
            }]
          }],
          generationConfig: {
            temperature: 0.1,
          }
        };

        let response = await proxiedFetchForAI(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        // Handle 429 rate limit
        if (response.status === 429) {
          console.log("Pro model rate limited for repair, switching to Flash");

          // Show status message in chat
          const statusMsg = document.createElement('div');
          statusMsg.className = 'bot-message';
          statusMsg.innerHTML = `<div style="padding: 12px 20px; border-radius: 8px; background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); font-size: 13px; color: #e65100;">
            <div style="margin-bottom: 8px;">⚠️ Pro model rate limited</div>
            <div style="font-size: 12px;">Retrying with Flash model...</div>
          </div>`;
          chatEl.appendChild(statusMsg);
          typesetEl(statusMsg);
          keepScrolledToBottom();

          // Fade out after 4 seconds
          setTimeout(() => {
            statusMsg.style.transition = 'opacity 0.5s ease-out';
            statusMsg.style.opacity = '0';
            setTimeout(() => statusMsg.remove(), 500);
          }, 4000);

          // Retry with Flash
          usedModel = MODEL_FLASH;
          url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`;
          response = await proxiedFetchForAI(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });

          // Check if Flash is also rate limited
          if (response.status === 429) {
            console.log("Flash model also rate limited, switching to Flash Lite");

            // Set global rate limit notice with retry-after
            const retryAfter = response.headers.get('retry-after');
            setRateLimitNotice(retryAfter);

            // Show status message
            const statusMsg2 = document.createElement('div');
            statusMsg2.className = 'bot-message';
            statusMsg2.innerHTML = `<div style="padding: 12px 20px; border-radius: 8px; background: rgba(255, 152, 0, 0.1); border: 1px solid rgba(255, 152, 0, 0.3); font-size: 13px; color: #e65100;">
              <div style="margin-bottom: 8px;">⚠️ Flash model also rate limited</div>
              <div style="font-size: 12px;">Switching to Flash Lite...</div>
            </div>`;
            chatEl.appendChild(statusMsg2);
            typesetEl(statusMsg2);
            keepScrolledToBottom();

            // Fade out after 4 seconds
            setTimeout(() => {
              statusMsg2.style.transition = 'opacity 0.5s ease-out';
              statusMsg2.style.opacity = '0';
              setTimeout(() => statusMsg2.remove(), 500);
            }, 4000);

            // Retry with Flash Lite
            usedModel = MODEL_FLASHLITE;
            url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`;
            response = await proxiedFetchForAI(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            });
          }
        }

        suppressIntercept = false;

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(response.status, usedModel);

        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
          throw new Error("No response from Gemini");
        }

        let fixed = data.candidates[0].content.parts[0].text;
        // Remove markdown code blocks if present
        fixed = fixed.replace(/^```latex\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();

        repairedChecklistLatex = fixed;

        // Check if auto-open is enabled
        const autoOpenCheckbox = document.getElementById('checklist-auto-open');
        if (autoOpenCheckbox && autoOpenCheckbox.checked) {
          await openChecklistInOverleaf(true);
        }

        // Update button state and show all 3 options
        checklistRepairing = false;
        updateChecklistOptionsAfterRepair();

      } catch (err) {
        console.error('Repairment failed:', err);
        suppressIntercept = false;
        checklistRepairing = false;
        btn.disabled = false;
        btn.innerHTML = '🛠️ Repair';
        alert('Failed to repair LaTeX. Please try again.');
      }
    };

    function updateChecklistOptionsAfterRepair() {
      // Update the options page to show all 3 buttons
      const buttonsContainer = document.querySelector('.overleaf-options-buttons');
      if (buttonsContainer) {
        buttonsContainer.innerHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(false); hideChecklistOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf checklist-repair-btn" onclick="repairChecklistLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(true); hideChecklistOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      }
    }

    let checklistOptionsShown = false;

    function updateChecklistOverleafButton() {
      const actionsDiv = document.querySelector('.checklist-actions');
      if (!actionsDiv) return;

      const existingContainer = actionsDiv.querySelector('.checklist-overleaf-container');
      const overleafBtn = actionsDiv.querySelector('[onclick*="openChecklistInOverleaf"]');

      if (!overleafBtn && !existingContainer) return;

      // First update: Replace button with "Overleaf Options" button
      if (!existingContainer) {
        const optionsBtn = document.createElement('button');
        optionsBtn.className = 'flashcard-btn flashcard-btn-overleaf';
        optionsBtn.innerHTML = '🌱 Overleaf Options';
        optionsBtn.onclick = showChecklistOverleafOptions;
        overleafBtn.replaceWith(optionsBtn);
      }
    }

    window.showChecklistOverleafOptions = function() {
      let buttonHTML;
      if (checklistRepairing) {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(false); hideChecklistOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf checklist-repair-btn" disabled style="width: 200px;">⏳ Repairing...</button>
        `;
      } else if (repairedChecklistLatex) {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(false); hideChecklistOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf checklist-repair-btn" onclick="repairChecklistLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(true); hideChecklistOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      } else {
        buttonHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openChecklistInOverleaf(false); hideChecklistOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf checklist-repair-btn" onclick="repairChecklistLatex();" style="width: 200px;">🛠️ Repair</button>
        `;
      }

      chatEl.innerHTML = `
        <div class="overleaf-options-container">
          <div class="overleaf-options-header">
            <div class="overleaf-options-title">Overleaf Export Options</div>
            <div class="overleaf-options-subtitle">Choose how to export your checklist to Overleaf</div>
          </div>
          <div class="overleaf-options-buttons">
            ${buttonHTML}
          </div>
          <div class="overleaf-auto-open" style="margin-top: 20px; display: flex; align-items: center; gap: 8px; justify-content: center;">
            <input type="checkbox" id="checklist-auto-open" checked style="cursor: pointer;">
            <label for="checklist-auto-open" style="cursor: pointer; font-size: 14px;">Automatically open in Overleaf after repair</label>
          </div>
          <div class="overleaf-options-back">
            <button class="flashcard-btn" onclick="hideChecklistOverleafOptions()">← Back to Checklist</button>
          </div>
        </div>
      `;
      chatEl.scrollTop = 0;
      checklistOptionsShown = true;
    };

    window.hideChecklistOverleafOptions = function() {
      renderChecklist();
    };

    window.viewPreviousChecklist = function() {
      // Don't reset options state - just view checklist
      checklistMode = true;
      updateHeaderSubtitle('Checklist Mode');
      setError('');
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      checklistBtn.style.display = 'none';
      renderChecklist();
    };

    window.enterChecklistMode = enterChecklistMode;
    window.exitChecklistMode = exitChecklistMode;

    // ===== SUMMARY GENERATION =====
    let summaryLatex = null;
    let summaryLatexOriginal = null; // LaTeX with IMAGE_N placeholders (from Gemini)
    let summaryLatexWithUrls = null; // LaTeX with URL placeholders (before base64 replacement)
    let summaryHtml = null;
    let summaryHtmlOriginal = null; // HTML with IMAGE_N placeholders (from Gemini)
    let summaryHtmlWithUrls = null; // HTML with <img> URL placeholders
    let repairedSummaryLatex = null;
    let summaryGenerating = false;
    let summaryGeneratingInBackground = false;
    let summaryRateLimited = false; // Track if summary generation was rate limited in background
    let forceFlashModel = false; // Force using Flash model instead of Pro (for rate limit recovery)
    let alternativeExtractionCompleted = false; // Track if alternative extraction was successfully completed
    let summaryOptionsShown = false;

    // TTS Audio state
    let summaryAudioBlob = null; // Stored audio blob for replay
    let summaryAudioUrl = null; // Stored audio URL
    let currentAudio = null; // Current Audio object
    let audioControlsContainer = null; // Container for audio controls

    // Storage for BOTH extraction method versions
    let summaryVersions = {
      backend: {
        latex: null,
        latexOriginal: null,
        latexWithUrls: null,
        html: null,
        htmlOriginal: null,
        htmlWithUrls: null,
        extractedMarkdown: null
      },
      mineru: {
        latex: null,
        latexOriginal: null,
        latexWithUrls: null,
        html: null,
        htmlOriginal: null,
        htmlWithUrls: null,
        extractedMarkdown: null
      }
    };
    let currentlyDisplayedVersion = null; // 'backend' or 'mineru' - tracks which version is currently shown
    let imageUrlMap = {}; // Maps IMAGE_1, IMAGE_2, etc. to actual URLs
    let summaryRepairing = false;
    let selectedExtrasHTML = []; // Separate selections for HTML
    let selectedExtrasLATEX = ['LeQture Theme']; // Separate selections for LaTeX, initially only LeQture Theme
    let customInstructions = '';
    let summaryFormat = 'latex'; // 'latex' or 'html'
    let savedIncludeImages = false; // Save includeImages choice for rate limit recovery

    // Local extraction session management
    let localExtractionSession = null; // Stores {session_id, images: [...], txt_content: "..."}

    // Helper function to get the appropriate selected extras based on format
    function getSelectedExtras() {
      return summaryFormat === 'html' ? selectedExtrasHTML : selectedExtrasLATEX;
    }

    // Helper function to set selected extras based on format
    function setSelectedExtras(newExtras) {
      if (summaryFormat === 'html') {
        selectedExtrasHTML = newExtras;
      } else {
        selectedExtrasLATEX = newExtras;
      }
    }
    let summaryCountdownInterval = null;
    let summaryCountdownStartTime = null;
    let summaryCountdownPhase = 1;
    let summaryCountdownInitialEta = 60;
    let lastUsedExtractionMethod = null; // Track which extraction method was used: 'backend' or 'mineru'
    let currentSummaryPhase = 'generating'; // Track current generation phase for countdown persistence
    let isAlternativeExtraction = false; // Track if currently doing alternative extraction (don't show full screen again)

    // Summary prompt constants removed - now handled by backend
    // But we keep the list of extra names for UI display
    const AVAILABLE_EXTRAS_HTML = {
      'Additional Worked Examples': true,
      'ChecklistHTML': true,
      'Detailed': true,
      'Concise': true,
      'Reference Timestamps': true
    };

    const AVAILABLE_EXTRAS_LATEX = {
      'LeQture Theme': true,
      'Additional Worked Examples': true,
      'ChecklistLATEX': true,
      'Detailed': true,
      'Concise': true,
      'Reference Timestamps': true,
      'New Page Per Subtopic': true
    };

    function getAvailableExtras() {
      return summaryFormat === 'html' ? AVAILABLE_EXTRAS_HTML : AVAILABLE_EXTRAS_LATEX;
    }

    summaryBtn.addEventListener("click", async () => {
      // If summary was rate limited in background, show the rate limit dialog
      if (summaryRateLimited) {
        console.log('[Summary] Showing rate limit dialog after background rate limit');
        summaryRateLimited = false;
        summaryBtn.textContent = 'Summary';

        // Show rate limit dialog
        const useFlash = await new Promise((resolve) => {
          chatEl.innerHTML = '';
          controlsEl.style.display = 'none';
          inputRowEl.style.display = 'none';
          attEl.style.display = 'none';
          summaryBtn.style.display = 'none';

          const container = document.createElement('div');
          container.className = 'quiz-generating';
          container.innerHTML = `
            <div class="quiz-gen-text">⚠️ Rate Limited</div>
            <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">You have been rate limited by the API. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the summary.</div>
            <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
              <button class="flashcard-btn" id="summary-rate-limit-cancel">Try Again Later</button>
              <button class="flashcard-btn flashcard-btn-primary" id="summary-rate-limit-flash">Use Flash Model</button>
            </div>
          `;
          chatEl.appendChild(container);

          document.getElementById('summary-rate-limit-cancel').onclick = () => resolve(false);
          document.getElementById('summary-rate-limit-flash').onclick = () => resolve(true);
        });

        if (!useFlash) {
          // User chose to try again later - restore UI
          chatEl.innerHTML = '';
          controlsEl.style.display = '';
          inputRowEl.style.display = '';
          attEl.style.display = '';
          summaryBtn.style.display = '';
          updateHeaderSubtitle('Ask about this slide');
          return;
        }

        // User chose to use Flash model - continue generation with Flash
        console.log('[Summary] User chose to use Flash model after background rate limit');
        summaryFormat = summaryFormat || 'latex'; // Use last format or default to latex
        forceFlashModel = true; // Force using Flash model
        summaryGenerating = true;
        summaryGeneratingInBackground = false;
        startSummaryGeneration();
        return;
      }

      // If summary is generating in background, show the generating UI with current phase
      if (summaryGeneratingInBackground || summaryGenerating) {
        console.log("Summary still generating in background - showing UI (preserving countdown)");
        summaryGenerating = true;
        summaryGeneratingInBackground = false;
        summaryBtn.style.display = 'none';
        // Show current phase without resetting countdown
        showSummaryGenerating(currentSummaryPhase, lastUsedExtractionMethod, true); // true = don't reset countdown
        updateHeaderSubtitle('Generating Summary...');
        return;
      }

      // Check if there's a previously generated summary
      if (summaryLatex || summaryHtml) {
        showSummaryFormatChoice(true); // true = has previous summary
      } else {
        showSummaryFormatChoice(false); // false = new summary
      }
    });

    function showSummaryFormatChoice(hasPrevious) {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      summaryBtn.style.display = 'none';

      // Scroll to top
      chatEl.scrollTop = 0;

      const container = document.createElement('div');
      container.className = 'quiz-generating';

      // Build previous summary buttons HTML
      let previousSummaryButtons = '';
      if (hasPrevious) {
        const buttons = [];
        if (summaryLatex) {
          buttons.push('<button class="flashcard-btn" onclick="openPreviousSummaryByFormat(\'latex\')">📄 View Previous LaTeX</button>');
        }
        if (summaryHtml) {
          buttons.push('<button class="flashcard-btn" onclick="openPreviousSummaryByFormat(\'html\')">🌐 View Previous HTML</button>');
        }

        if (buttons.length > 0) {
          previousSummaryButtons = `
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.1);">
              <div style="font-size: 13px; color: #666; margin-bottom: 12px;">Or use previously generated summary:</div>
              <div style="display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
                ${buttons.join('\n')}
              </div>
            </div>
          `;
        }
      }

      container.innerHTML = `
        <div class="quiz-gen-text">Summary Format</div>
        <div class="quiz-gen-subtext">Choose your output format</div>

        <div style="display: flex; gap: 12px; justify-content: center; margin: 24px 0;">
          <button class="flashcard-btn flashcard-btn-primary" onclick="selectSummaryFormat('latex')">📄 LaTeX</button>
          <button class="flashcard-btn flashcard-btn-primary" onclick="selectSummaryFormat('html')">🌐 HTML</button>
        </div>

        ${previousSummaryButtons}

        <div style="margin-top: 16px;">
          <button class="flashcard-btn summary-cancel-btn" onclick="cancelSummaryOptions()">Cancel</button>
        </div>
      `;
      chatEl.appendChild(container);

      // Ensure scroll to top after render
      setTimeout(() => {
        chatEl.scrollTop = 0;
      }, 0);
    }

    window.selectSummaryFormat = function(format) {
      summaryFormat = format;
      showSummaryOptions();
    };

    window.openPreviousSummary = function() {
      // Check if both HTML and LaTeX summaries exist
      if (summaryLatex && summaryHtml) {
        // Show selection UI for both formats
        showPreviousSummarySelection();
      } else if (summaryLatex) {
        showSummaryOverleafOptions();
      } else if (summaryHtml) {
        showSummaryHtmlResult();
      }
    };

    function showPreviousSummarySelection() {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      summaryBtn.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      container.innerHTML = `
        <div class="quiz-gen-text">Select Summary Format</div>
        <div class="quiz-gen-subtext">You have previously generated summaries in both formats</div>

        <div style="display: flex; gap: 12px; justify-content: center; margin: 24px 0;">
          <button class="flashcard-btn flashcard-btn-primary" onclick="openPreviousSummaryByFormat('latex')">📄 View LaTeX Summary</button>
          <button class="flashcard-btn flashcard-btn-primary" onclick="openPreviousSummaryByFormat('html')">🌐 View HTML Summary</button>
        </div>

        <div style="margin-top: 16px;">
          <button class="flashcard-btn summary-cancel-btn" onclick="cancelSummaryOptions()">Cancel</button>
        </div>
      `;
      chatEl.appendChild(container);
      chatEl.scrollTop = 0;
    }

    window.openPreviousSummaryByFormat = function(format) {
      if (format === 'latex') {
        showSummaryOverleafOptions();
      } else if (format === 'html') {
        showSummaryHtmlResult();
      }
    };

    function showSummaryOptions() {
      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';
      summaryBtn.style.display = 'none';

      // Scroll to top
      chatEl.scrollTop = 0;

      // Evaluate YouTube check before template literal
      const isYouTube = isYouTubePage();
      const showImagesCheckbox = !isYouTube;

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      container.style.justifyContent = 'flex-start';
      container.innerHTML = `
        <div class="quiz-gen-text" style="margin-bottom: 8px;">Summary Options</div>
        <div class="quiz-gen-subtext" style="margin-bottom: 20px;">Customize your ${summaryFormat.toUpperCase()} summary</div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 24px 0; max-width: 600px;">
          <div>
            <h3 style="font-size: 14px; font-weight: 600; margin: 0 0 12px 0;">Selected Extras</h3>
            <div id="summary-selected-extras" style="min-height: 200px; padding: 12px; border: 2px dashed #4a63ff; border-radius: 8px; background: rgba(74, 99, 255, 0.05);">
            </div>
          </div>
          <div>
            <h3 style="font-size: 14px; font-weight: 600; margin: 0 0 12px 0;">Available Extras</h3>
            <div id="summary-available-extras" style="min-height: 200px; padding: 12px; border: 2px dashed #ccc; border-radius: 8px; background: rgba(0,0,0,0.02);">
            </div>
          </div>
        </div>

        <div style="margin: 16px 0;">
          <h3 style="font-size: 14px; font-weight: 600; margin: 0 0 8px 0;">Custom Instructions (Optional)</h3>
          <textarea id="summary-custom-instructions" placeholder="Add any custom instructions for the summary..." style="width: 100%; max-width: 600px; min-height: 80px; padding: 12px; border: 1px solid rgba(0,0,0,0.2); border-radius: 12px; font-family: inherit; font-size: 13px; resize: vertical;">${customInstructions}</textarea>
        </div>

        <div style="margin: 16px 0; ${showImagesCheckbox ? '' : 'display: none;'}">
          <label id="summary-include-images-label" style="display: flex; align-items: center; gap: 8px; cursor: ${pdfUrlStatus === 'url_valid' && SLIDES_PDF_URL ? 'pointer' : 'not-allowed'}; font-size: 13px; opacity: ${pdfUrlStatus === 'url_valid' && SLIDES_PDF_URL ? '1' : '0.5'};">
            <input type="checkbox" id="summary-include-images" ${pdfUrlStatus === 'url_valid' && SLIDES_PDF_URL ? 'checked' : ''} ${pdfUrlStatus !== 'url_valid' || !SLIDES_PDF_URL ? 'disabled' : ''} style="width: 16px; height: 16px;">
            <span id="summary-include-images-text">Include images from lecture slides ${
              pdfUrlStatus === 'not_initialized' ? '(Checking for PDF...)' :
              pdfUrlStatus === 'url_stored' ? '(Validating PDF URL...)' :
              (pdfUrlStatus === 'url_valid' && SLIDES_PDF_URL) ? '' :
              pdfUrlStatus === 'file_uploaded' ? '(Only available with PDF URL)' :
              '(No PDF available)'
            }</span>
          </label>
        </div>

        <div style="display: flex; gap: 12px; justify-content: center; padding-bottom: 20px;">
          <button class="flashcard-btn flashcard-btn-primary" onclick="startSummaryGeneration()">Generate Summary</button>
          <button class="flashcard-btn summary-cancel-btn" onclick="cancelSummaryOptions()">Cancel</button>
        </div>
      `;

      console.log('[Summary Options] SLIDES_PDF_URL:', SLIDES_PDF_URL);
      console.log('[Summary Options] pdfUrlStatus:', pdfUrlStatus);
      console.log('[Summary Options] Images checkbox enabled:', pdfUrlStatus === 'url_valid');

      chatEl.appendChild(container);

      // If PDF is being validated, poll for completion and update UI
      if (pdfUrlStatus === 'url_stored' || pdfUrlStatus === 'not_initialized') {
        console.log('[Summary Options] PDF validation in progress, starting UI update poller...');
        const pollInterval = setInterval(() => {
          console.log('[Summary Options Poller] Checking pdfUrlStatus:', pdfUrlStatus);

          // Check if summary options are still showing
          const labelElement = document.getElementById('summary-include-images-label');
          if (!labelElement) {
            console.log('[Summary Options Poller] Summary options closed, stopping poller');
            clearInterval(pollInterval);
            return;
          }

          // Update UI if status changed
          if (pdfUrlStatus === 'url_valid') {
            console.log('[Summary Options Poller] ✓ PDF validated! Updating UI...');
            const checkbox = document.getElementById('summary-include-images');
            const label = labelElement;
            const text = document.getElementById('summary-include-images-text');

            if (checkbox && label && text) {
              checkbox.disabled = false;
              checkbox.checked = true;
              label.style.cursor = 'pointer';
              label.style.opacity = '1';
              text.textContent = 'Include images from lecture slides';
              console.log('[Summary Options Poller] ✓ UI updated successfully');
            }
            clearInterval(pollInterval);
          } else if (pdfUrlStatus !== 'url_stored' && pdfUrlStatus !== 'not_initialized') {
            console.log('[Summary Options Poller] Validation completed with status:', pdfUrlStatus);
            clearInterval(pollInterval);
          }
        }, 500); // Poll every 500ms
      }

      renderSummaryExtras();

      // Ensure scroll to top after render
      setTimeout(() => {
        chatEl.scrollTop = 0;
      }, 0);
    }

    function renderSummaryExtras() {
      const selectedContainer = document.getElementById('summary-selected-extras');
      const availableContainer = document.getElementById('summary-available-extras');

      if (!selectedContainer || !availableContainer) return;

      // Get appropriate extras for current format
      const AVAILABLE_EXTRAS = getAvailableExtras();

      // Display text mapping for visual consistency
      const displayTextMap = {
        'ChecklistHTML': 'Checklist at the End',
        'ChecklistLATEX': 'Checklist at the End'
      };

      // Render selected extras with display text
      const selectedExtras = getSelectedExtras();
      selectedContainer.innerHTML = selectedExtras.map(extra => {
        const displayText = displayTextMap[extra] || extra;
        return `
          <div class="summary-extra-item" draggable="true" data-extra="${extra}" style="padding: 8px 12px; margin-bottom: 8px; background: #fff; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; cursor: move; font-size: 13px;">
            ${displayText}
          </div>
        `;
      }).join('');

      // Render available extras (excluding selected ones)
      let available = Object.keys(AVAILABLE_EXTRAS).filter(e => !selectedExtras.includes(e));
      availableContainer.innerHTML = available.map(extra => {
        const displayText = displayTextMap[extra] || extra;
        return `
          <div class="summary-extra-item" draggable="true" data-extra="${extra}" style="padding: 8px 12px; margin-bottom: 8px; background: #fff; border: 1px solid rgba(0,0,0,0.1); border-radius: 6px; cursor: move; font-size: 13px;">
            ${displayText}
          </div>
        `;
      }).join('');

      // Add drag and drop handlers
      const items = document.querySelectorAll('.summary-extra-item');
      items.forEach(item => {
        item.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', e.target.dataset.extra);
          e.target.style.opacity = '0.5';
        });

        item.addEventListener('dragend', (e) => {
          e.target.style.opacity = '1';
        });
      });

      // Setup drop zones
      [selectedContainer, availableContainer].forEach(container => {
        container.addEventListener('dragover', (e) => {
          e.preventDefault();
          container.style.background = container === selectedContainer ? 'rgba(74, 99, 255, 0.1)' : 'rgba(0,0,0,0.05)';
        });

        container.addEventListener('dragleave', (e) => {
          container.style.background = container === selectedContainer ? 'rgba(74, 99, 255, 0.05)' : 'rgba(0,0,0,0.02)';
        });

        container.addEventListener('drop', (e) => {
          e.preventDefault();
          container.style.background = container === selectedContainer ? 'rgba(74, 99, 255, 0.05)' : 'rgba(0,0,0,0.02)';

          const extra = e.dataTransfer.getData('text/plain');
          const selectedExtras = getSelectedExtras();

          if (container === selectedContainer && !selectedExtras.includes(extra)) {
            setSelectedExtras([...selectedExtras, extra]);
            renderSummaryExtras();
          } else if (container === availableContainer && selectedExtras.includes(extra)) {
            setSelectedExtras(selectedExtras.filter(e => e !== extra));
            renderSummaryExtras();
          }
        });
      });
    }

    window.cancelSummaryOptions = function() {
      restoreSavedChatContent();
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      summaryBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
    };

    // Check if PDF is flattened
    async function checkPdfFlattening(pdfBlob) {
      console.log('[Flattening Detection] ========== CHECKING IF PDF IS FLATTENED ==========');
      console.log('[Flattening Detection] PDF Blob size:', pdfBlob.size, 'bytes');

      try {
        // Check if backend is running using fetchCORS
        console.log('[Flattening Detection] Step 1: Checking if backend is running...');
        try {
          const healthResponse = await fetchCORS(`${BACKEND_URL}/health`, {
            method: 'GET',
            responseType: 'json'
          });

          if (!healthResponse.ok) {
            throw new Error('Backend health check failed');
          }

          console.log('[Flattening Detection] ✓ Backend is running');
        } catch (healthError) {
          console.error('[Flattening Detection] ✗ Backend is not running!');
          console.error('[Flattening Detection] Error:', healthError.message);
          console.error('[Flattening Detection] DECISION: Cannot check flattening, will default to MinerU');
          return {
            is_flattened: null,
            recommendation: 'mineru',
            reason: 'Backend not available for flattening detection'
          };
        }

        // Send PDF to backend for flattening check
        // Note: FormData with blob needs to be sent via background script
        console.log('[Flattening Detection] Step 2: Sending PDF to backend for analysis...');

        // Convert blob to array buffer for transmission
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Create a boundary for multipart/form-data
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

        // Build multipart body manually
        const encoder = new TextEncoder();
        const parts = [];

        // Add form field
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="pdf"; filename="lecture-slides.pdf"\r\n`));
        parts.push(encoder.encode(`Content-Type: application/pdf\r\n\r\n`));
        parts.push(uint8Array);
        parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

        // Combine all parts
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.length;
        }

        // Send via fetchCORS with custom content-type
        const response = await fetchCORS(`${BACKEND_URL}/check-flattening`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: body.buffer,
          responseType: 'json'
        });

        if (!response.ok) {
          throw new Error(`Backend check failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Flattening Detection] ✓ Analysis complete');
        console.log('[Flattening Detection] Is Flattened:', result.is_flattened);
        console.log('[Flattening Detection] Has True Images:', result.has_true_images);
        console.log('[Flattening Detection] Recommendation:', result.recommendation);
        console.log('[Flattening Detection] Reason:', result.reason);

        return result;

      } catch (error) {
        console.error('[Flattening Detection] ✗ Check failed:', error);
        console.error('[Flattening Detection] Error message:', error.message);
        console.error('[Flattening Detection] DECISION: Error occurred, will default to MinerU');
        return {
          is_flattened: null,
          recommendation: 'mineru',
          reason: 'Flattening detection failed, defaulting to cloud processing'
        };
      }
    }

    // Local backend image extraction function
    async function extractImagesLocally(pdfBlob) {
      console.log('[Local Extraction] ========== STARTING LOCAL PDF EXTRACTION ==========');
      console.log('[Local Extraction] PDF Blob size:', pdfBlob.size, 'bytes');

      try {
        // Skip health check since we already checked in flattening detection
        console.log('[Local Extraction] Step 1: Preparing PDF for upload...');

        // Convert blob to array buffer for transmission
        const arrayBuffer = await pdfBlob.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        // Create a boundary for multipart/form-data
        const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);

        // Build multipart body manually
        const encoder = new TextEncoder();
        const parts = [];

        // Add form field
        parts.push(encoder.encode(`--${boundary}\r\n`));
        parts.push(encoder.encode(`Content-Disposition: form-data; name="pdf"; filename="lecture-slides.pdf"\r\n`));
        parts.push(encoder.encode(`Content-Type: application/pdf\r\n\r\n`));
        parts.push(uint8Array);
        parts.push(encoder.encode(`\r\n--${boundary}--\r\n`));

        // Combine all parts
        const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
        const body = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.length;
        }

        console.log('[Local Extraction] Step 2: Uploading PDF to backend via background script...');

        // Upload to backend using fetchCORS
        const response = await fetchCORS(`${BACKEND_URL}/extract`, {
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`
          },
          body: body.buffer,
          responseType: 'json'
        });

        if (!response.ok) {
          throw new Error(`Backend extraction failed: ${response.status}`);
        }

        const result = await response.json();
        console.log('[Local Extraction] ✓ Extraction successful');
        console.log('[Local Extraction] Session ID:', result.session_id);
        console.log('[Local Extraction] Image count:', result.image_count);
        console.log('[Local Extraction] Text content length:', result.txt_content.length);

        // Store session info
        localExtractionSession = {
          session_id: result.session_id,
          images: result.images,
          txt_content: result.txt_content
        };

        // Return the text content as "markdown" (it's actually formatted text with placeholders)
        return result.txt_content;

      } catch (error) {
        console.error('[Local Extraction] ✗ Extraction failed:', error);
        console.error('[Local Extraction] Error details:', error.message);

        // Provide helpful error message
        if (error.message.includes('NetworkError') || error.message.includes('Failed to fetch')) {
          throw new Error('Cannot connect to backend server. Make sure it is running on http://localhost:5000 (run: python server.py)');
        }

        throw error;
      }
    }

    // MinerU image extraction functions
    async function extractImagesFromPdf(pdfUrl) {
      console.log('[MinerU] ========== STARTING PDF EXTRACTION ==========');
      console.log('[MinerU] PDF URL:', pdfUrl);
      console.log('[MinerU] Sending extraction request to backend...');

      try {
        // Call backend endpoint - backend handles all MinerU API calls
        const response = await fetch(`${BACKEND_URL}/api/mineru/extract`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            pdfUrl: pdfUrl
          })
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          console.error('[MinerU] Backend extraction failed:', response.status, errorData);
          throw new Error(errorData.error || `Backend extraction failed with status ${response.status}`);
        }

        const result = await response.json();

        if (!result.success || !result.markdown) {
          console.error('[MinerU] Backend returned invalid response:', result);
          throw new Error(result.error || 'Backend did not return markdown content');
        }

        console.log('[MinerU] ✓ Extraction complete via backend');
        console.log('[MinerU] Task ID:', result.taskId);
        console.log('[MinerU] Markdown length:', result.markdown.length, 'characters');
        console.log('[MinerU] ========== EXTRACTION COMPLETE ==========');

        return result.markdown;

      } catch (error) {
        console.error('[MinerU] ✗ Extraction failed:', error.message);
        throw error;
      }
    }

    function replaceImageUrlsWithPlaceholders(markdown) {
      console.log('[Image Preprocessing] Replacing image URLs with placeholders...');
      imageUrlMap = {}; // Reset the map

      // Match markdown images: ![alt](url) or ![](url)
      const imageRegex = /!\[[^\]]*\]\((https?:\/\/[^\)]+)\)/g;
      const matches = [...markdown.matchAll(imageRegex)];

      if (matches.length === 0) {
        console.log('[Image Preprocessing] No images found in markdown');
        return markdown;
      }

      let processedMarkdown = markdown;
      let imageCounter = 1;

      for (const match of matches) {
        const fullMatch = match[0];
        const imageUrl = match[1];
        const placeholder = `IMAGE_${imageCounter}`;

        // Store the mapping
        imageUrlMap[placeholder] = imageUrl;

        // Replace the URL in the markdown with placeholder
        const replacedMatch = fullMatch.replace(imageUrl, placeholder);
        processedMarkdown = processedMarkdown.replace(fullMatch, replacedMatch);

        imageCounter++;
      }

      console.log('[Image Preprocessing] Extracted URLs and placeholders:');
      console.log(JSON.stringify(imageUrlMap, null, 2));
      console.log(`[Image Preprocessing] Total images replaced: ${Object.keys(imageUrlMap).length}`);

      return processedMarkdown;
    }

    function replaceImagePlaceholdersWithUrls(latexContent) {
      console.log('[Image URL Replacement] Replacing image placeholders with actual URLs...');

      // Check if using local extraction (IMAGE_XXXX.png format)
      const localExtractionPattern = /%\s+(IMAGE_\d{4}\.png)/g;
      const mineruPattern = /%\s+(IMAGE_\d+)(?!\.png)/g;

      const localMatches = [...latexContent.matchAll(localExtractionPattern)];
      const mineruMatches = [...latexContent.matchAll(mineruPattern)];

      let replacedContent = latexContent;
      const usedPlaceholders = new Set();

      // Handle local extraction format (IMAGE_XXXX.png)
      if (localMatches.length > 0 && localExtractionSession) {
        console.log(`[Image URL Replacement] Found ${localMatches.length} local extraction placeholders`);

        for (const match of localMatches) {
          const imageName = match[1]; // e.g., IMAGE_0001.png
          usedPlaceholders.add(imageName);

          // Build backend URL
          const backendUrl = `${BACKEND_URL}/image/${localExtractionSession.session_id}/${imageName}`;

          // Replace IMAGE_XXXX.png with backend URL
          const searchPattern = new RegExp(`%\\s+${imageName.replace('.', '\\.')}`, 'g');
          replacedContent = replacedContent.replace(searchPattern, `% ${backendUrl}`);

          console.log(`[Image URL Replacement] ${imageName} → ${backendUrl}`);
        }
      }
      // Handle MinerU format (IMAGE_N)
      else if (mineruMatches.length > 0) {
        console.log(`[Image URL Replacement] Found ${mineruMatches.length} MinerU placeholders`);

        for (const match of mineruMatches) {
          const placeholder = match[1]; // e.g., IMAGE_1
          usedPlaceholders.add(placeholder);

          const actualUrl = imageUrlMap[placeholder];
          if (actualUrl) {
            // Replace IMAGE_N with actual URL
            const searchPattern = new RegExp(`%\\s+${placeholder}\\b`, 'g');
            replacedContent = replacedContent.replace(searchPattern, `% ${actualUrl}`);
          } else {
            console.warn(`[Image URL Replacement] No URL found for ${placeholder}`);
          }
        }
      } else {
        console.log('[Image URL Replacement] No image placeholders found in LaTeX');
      }

      console.log('[Image URL Replacement] Placeholders used by AI:');
      console.log(Array.from(usedPlaceholders));

      return replacedContent;
    }

    function replaceImagePlaceholdersWithImgTags(htmlContent) {
      console.log('[Image URL Replacement - HTML] Replacing image placeholders with <img> tags...');

      // Check if using local extraction (IMAGE_XXXX.png format)
      const localExtractionPattern = /<!--\s*(IMAGE_\d{4}\.png)\s*-->/g;
      const mineruPattern = /<!--\s*(IMAGE_\d+)\s*-->/g;

      const localMatches = [...htmlContent.matchAll(localExtractionPattern)];
      const mineruMatches = [...htmlContent.matchAll(mineruPattern)];

      let replacedContent = htmlContent;
      const usedPlaceholders = new Set();

      // Handle local extraction format (IMAGE_XXXX.png)
      if (localMatches.length > 0 && localExtractionSession) {
        console.log(`[Image URL Replacement - HTML] Found ${localMatches.length} local extraction placeholders`);

        for (const match of localMatches) {
          const fullImageName = match[1]; // e.g., IMAGE_0001.png (full name with IMAGE_ prefix)
          usedPlaceholders.add(fullImageName);

          // Build backend URL
          const backendUrl = `${BACKEND_URL}/image/${localExtractionSession.session_id}/${fullImageName}`;

          // Replace <!-- IMAGE_XXXX.png --> with <img> tag
          const searchPattern = new RegExp(`<!--\\s*${fullImageName.replace('.', '\\.')}\\s*-->`, 'g');
          const imgTag = `<img src="${backendUrl}" alt="${fullImageName}" style="max-width: 100%; height: auto; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">`;
          replacedContent = replacedContent.replace(searchPattern, imgTag);

          console.log(`[Image URL Replacement - HTML] ${fullImageName} → <img> tag with ${backendUrl}`);
        }
      }
      // Handle MinerU format (IMAGE_N)
      else if (mineruMatches.length > 0) {
        console.log(`[Image URL Replacement - HTML] Found ${mineruMatches.length} MinerU placeholders`);

        for (const match of mineruMatches) {
          const fullPlaceholder = match[1]; // e.g., IMAGE_1 (full placeholder)
          usedPlaceholders.add(fullPlaceholder);

          const actualUrl = imageUrlMap[fullPlaceholder];
          if (actualUrl) {
            // Replace <!-- IMAGE_N --> with <img> tag
            const searchPattern = new RegExp(`<!--\\s*${fullPlaceholder}\\s*-->`, 'g');
            const imgTag = `<img src="${actualUrl}" alt="${fullPlaceholder}" style="max-width: 100%; height: auto; margin: 20px 0; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">`;
            replacedContent = replacedContent.replace(searchPattern, imgTag);

            console.log(`[Image URL Replacement - HTML] ${fullPlaceholder} → <img> tag with ${actualUrl}`);
          } else {
            console.warn(`[Image URL Replacement - HTML] No URL found for ${fullPlaceholder}`);
          }
        }
      } else {
        console.log('[Image URL Replacement - HTML] No image placeholders found in HTML');
      }

      console.log('[Image URL Replacement - HTML] Placeholders used by AI:');
      console.log(Array.from(usedPlaceholders));

      return replacedContent;
    }

    // Helper function to convert arrayBuffer to base64 (handles large files)
    function arrayBufferToBase64(buffer) {
      const bytes = new Uint8Array(buffer);
      const chunkSize = 32768; // Process in 32KB chunks
      let binary = '';

      for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, chunk);
      }

      return btoa(binary);
    }

    // Helper function to resize image to A4 width if needed
    async function resizeImageIfNeeded(blob) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        const url = URL.createObjectURL(blob);

        img.onload = async () => {
          URL.revokeObjectURL(url);

          const originalWidth = img.width;
          const originalHeight = img.height;

          console.log(`[Image Resize] Original dimensions: ${originalWidth}x${originalHeight}`);

          // Check if resizing is needed
          if (originalWidth <= A4_WIDTH_PX) {
            console.log('[Image Resize] Image width within A4 limits, no resize needed');
            resolve(blob);
            return;
          }

          // Calculate new dimensions maintaining aspect ratio
          const scale = A4_WIDTH_PX / originalWidth;
          const newWidth = A4_WIDTH_PX;
          const newHeight = Math.round(originalHeight * scale);

          console.log(`[Image Resize] Resizing to ${newWidth}x${newHeight} (scale: ${scale.toFixed(2)})`);

          // Create canvas and resize
          const canvas = document.createElement('canvas');
          canvas.width = newWidth;
          canvas.height = newHeight;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, newWidth, newHeight);

          // Convert canvas to blob (JPEG with 0.85 quality for smaller file size)
          canvas.toBlob((resizedBlob) => {
            if (resizedBlob) {
              console.log(`[Image Resize] Resized blob size: ${resizedBlob.size} bytes (original: ${blob.size} bytes)`);
              resolve(resizedBlob);
            } else {
              console.error('[Image Resize] Failed to create resized blob, using original');
              resolve(blob);
            }
          }, 'image/jpeg', 0.99);
        };

        img.onerror = () => {
          URL.revokeObjectURL(url);
          console.error('[Image Resize] Failed to load image, using original blob');
          resolve(blob);
        };

        img.src = url;
      });
    }

    async function replaceImagePlaceholdersWithBase64(latexContent) {
      console.log('[Image Embedding] Scanning for image placeholders...');

      // Find all image placeholder comments: % {url} (within begin{center}...end{center})
      const placeholderRegex = /%\s+(https?:\/\/[^\s]+)/g;
      const matches = [...latexContent.matchAll(placeholderRegex)];

      if (matches.length === 0) {
        console.log('[Image Embedding] No image placeholders found');
        summaryHasImages = false;
        return latexContent;
      }

      console.log('[Image Embedding] Found', matches.length, 'image placeholders');

      // Prepare filecontents sections at the start
      let filecontentsSections = '';
      const replacements = [];
      let successfulImageCount = 0;

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const imageUrl = match[1];
        const placeholder = match[0];
        const imageVarName = `image${i + 1}`;

        console.log(`[Image Embedding] Processing image ${i + 1}:`, imageUrl);

        try {
          // Fetch image as blob
          let blob;
          if (imageUrl.includes('localhost:5000/image/')) {
            // Local backend image - use direct fetch (no CORS issues with localhost)
            console.log(`[Image Embedding] Fetching from local backend: ${imageUrl}`);
            const response = await fetch(imageUrl);
            if (!response.ok) {
              throw new Error(`Backend image fetch failed: ${response.status}`);
            }
            blob = await response.blob();
          } else {
            // External URL (MinerU) - use fetchCORS
            const response = await fetchCORS(imageUrl, { responseType: 'blob' });
            blob = await response.blob();
          }

          // Resize image if needed (if width > A4_WIDTH_PX)
          blob = await resizeImageIfNeeded(blob);

          // Convert to base64 using chunked method
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = arrayBufferToBase64(arrayBuffer);

          console.log(`[Image Embedding] Image ${i + 1} processed, base64 size:`, base64.length);

          // Add filecontents section
          filecontentsSections += `\\begin{filecontents*}{${imageVarName}.64}\n${base64}\n\\end{filecontents*}\n\n`;

          // Calculate width in cm based on multiplier (default 10cm)
          const baseWidthCm = 10;
          const finalWidthCm = baseWidthCm * imageSizeMultiplier;

          // Store replacement: replace placeholder with image inclusion
          replacements.push({
            placeholder: placeholder,
            replacement: `\\immediate\\write18{base64 -d ${imageVarName}.64 > ${imageVarName}-tmp.pdf}\n\\includegraphics[width=${finalWidthCm}cm]{${imageVarName}-tmp.pdf}`
          });

          successfulImageCount++;
        } catch (error) {
          console.error(`[Image Embedding] Failed to fetch image ${i + 1}:`, error);
          // Keep placeholder as comment if fetch fails
          replacements.push({
            placeholder: placeholder,
            replacement: `% Failed to embed image: ${imageUrl}`
          });
        }
      }

      // Track if we successfully embedded any images
      summaryHasImages = successfulImageCount > 0;
      console.log(`[Image Embedding] Successfully embedded ${successfulImageCount}/${matches.length} images`);

      // Insert filecontents after \documentclass
      const documentclassRegex = /(\\documentclass(?:\[.*?\])?\{.*?\})/;
      let modifiedContent = latexContent;

      if (documentclassRegex.test(modifiedContent)) {
        modifiedContent = modifiedContent.replace(documentclassRegex, `$1\n\n${filecontentsSections}`);
      } else {
        // If no \documentclass, add at the beginning
        modifiedContent = filecontentsSections + modifiedContent;
      }

      // Ensure graphicx and caption packages are loaded
      if (!modifiedContent.includes('\\usepackage{graphicx}')) {
        if (documentclassRegex.test(modifiedContent)) {
          modifiedContent = modifiedContent.replace(documentclassRegex, `$1\n\\usepackage{graphicx}`);
        } else {
          modifiedContent = '\\usepackage{graphicx}\n' + modifiedContent;
        }
      }

      if (!modifiedContent.includes('\\usepackage{caption}')) {
        if (documentclassRegex.test(modifiedContent)) {
          modifiedContent = modifiedContent.replace(/(\\usepackage\{graphicx\})/, `$1\n\\usepackage{caption}`);
        } else {
          modifiedContent = '\\usepackage{caption}\n' + modifiedContent;
        }
      }

      // Replace all placeholders with image inclusions
      for (const { placeholder, replacement } of replacements) {
        modifiedContent = modifiedContent.replace(placeholder, replacement);
      }

      console.log('[Image Embedding] Image embedding complete');
      return modifiedContent;
    }

    async function replaceImagePlaceholdersInHtml(htmlContent) {
      console.log('[Image Embedding HTML] Scanning for image placeholders...');

      // Find all src="IMAGE_N" patterns
      const placeholderRegex = /src="(IMAGE_\d+)"/g;
      const matches = [...htmlContent.matchAll(placeholderRegex)];

      if (matches.length === 0) {
        console.log('[Image Embedding HTML] No IMAGE_N placeholders found');
        return htmlContent;
      }

      console.log('[Image Embedding HTML] Found', matches.length, 'IMAGE_N placeholders');

      let modifiedContent = htmlContent;
      const usedPlaceholders = new Set();

      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        const placeholder = match[1]; // e.g., IMAGE_1
        const imageUrl = imageUrlMap[placeholder];

        if (!imageUrl) {
          console.warn(`[Image Embedding HTML] No URL found for ${placeholder}`);
          continue;
        }

        usedPlaceholders.add(placeholder);
        const fullMatch = match[0]; // e.g., src="IMAGE_1"

        console.log(`[Image Embedding HTML] Processing image ${i + 1}:`, imageUrl);

        try {
          // Fetch image as blob
          const response = await fetchCORS(imageUrl, { responseType: 'blob' });
          const blob = await response.blob();
          const arrayBuffer = await blob.arrayBuffer();
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

          // Determine MIME type
          const contentType = response.headers.get('content-type') || blob.type || 'image/png';

          console.log(`[Image Embedding HTML] Image ${i + 1} fetched, size:`, base64.length, 'type:', contentType);

          // Create data URI
          const dataUri = `data:${contentType};base64,${base64}`;

          // Replace src="IMAGE_N" with data URI
          const replacement = `src="${dataUri}"`;
          modifiedContent = modifiedContent.replace(fullMatch, replacement);
        } catch (error) {
          console.error(`[Image Embedding HTML] Failed to fetch image ${i + 1}:`, error);
          // Keep placeholder as is if fetch fails, or replace with error message
          const errorReplacement = `src="" style="display:none;" data-error="Failed to load: ${imageUrl}"`;
          modifiedContent = modifiedContent.replace(fullMatch, errorReplacement);
        }
      }

      console.log('[Image Embedding HTML] Placeholders used by AI in HTML:');
      console.log(JSON.stringify(Array.from(usedPlaceholders).map(p => ({
        placeholder: p,
        url: imageUrlMap[p]
      })), null, 2));

      console.log('[Image Embedding HTML] Image embedding complete');
      return modifiedContent;
    }

    window.startSummaryGeneration = async function() {
      summaryGenerating = true;

      // Reset image-related variables for new generation
      imageSizeMultiplier = 1.0;
      summaryHasImages = false;
      summaryLatexWithUrls = null;

      // Reset alternative extraction flag AND version storage ONLY if not doing alternative extraction
      // (we want to keep it true during alternative extraction flow)
      if (!isAlternativeExtraction) {
        alternativeExtractionCompleted = false;
        currentlyDisplayedVersion = null;
        // Clear version storage for new summary
        summaryVersions = {
          backend: {
            latex: null, latexOriginal: null, latexWithUrls: null,
            html: null, htmlOriginal: null, htmlWithUrls: null,
            extractedMarkdown: null
          },
          mineru: {
            latex: null, latexOriginal: null, latexWithUrls: null,
            html: null, htmlOriginal: null, htmlWithUrls: null,
            extractedMarkdown: null
          }
        };
        console.log('[Summary] Reset version storage for new summary generation');
      }

      // Save custom instructions
      const customTextarea = document.getElementById('summary-custom-instructions');
      if (customTextarea) {
        customInstructions = customTextarea.value.trim();
      }

      // Check if image inclusion is enabled
      const includeImagesCheckbox = document.getElementById('summary-include-images');
      let includeImages;

      if (includeImagesCheckbox) {
        // Checkbox exists (normal flow) - read and save its value
        includeImages = includeImagesCheckbox.checked;
        savedIncludeImages = includeImages;
      } else {
        // Checkbox doesn't exist (rate limit recovery or alternative extraction) - use saved value
        includeImages = savedIncludeImages;
      }

      // If doing alternative extraction, force includeImages to true
      // (checkbox doesn't exist because we're on result screen, not options screen)
      if (isAlternativeExtraction) {
        includeImages = true;
        console.log('[Summary] Alternative extraction mode - forcing includeImages = true');
      }

      console.log('[Summary] Starting generation...');
      console.log('[Summary] includeImages:', includeImages);
      console.log('[Summary] isAlternativeExtraction:', isAlternativeExtraction);
      console.log('[Summary] SLIDES_PDF_URL:', SLIDES_PDF_URL);
      console.log('[Summary] pdfUrlStatus:', pdfUrlStatus);

      try {
        suppressIntercept = true;

        // Extract images from PDF if enabled (use cached version if available)
        let extractedMarkdown = null;
        if (includeImages && (SLIDES_PDF_URL || cachedPdfBlob)) {
          console.log('[Summary - AUTO MODE] ========== AUTOMATIC EXTRACTION METHOD SELECTION ==========');
          console.log('[Summary - AUTO MODE] Images option enabled');
          console.log('[Summary - AUTO MODE] PDF URL:', SLIDES_PDF_URL || 'None (manual upload)');
          console.log('[Summary - AUTO MODE] Cached PDF Blob:', cachedPdfBlob ? `${cachedPdfBlob.size} bytes` : 'None');

          // Determine which method will be used based on user preference
          const preferObjectDetection = localExtractionCb?.checked !== false;

          // Check appropriate cache based on preference
          let cachedMarkdown = null;
          let cacheSource = null;

          if (!preferObjectDetection) {
            // Force MinerU mode - check MinerU cache only
            cachedMarkdown = extractedMarkdownMineru;
            cacheSource = 'MinerU';
          } else {
            // AUTO MODE - we'll check cache after determining the method
            // For now, set to null (will check later after flattening detection)
            cachedMarkdown = null;
            cacheSource = 'AUTO';
          }

          // If we have cache for the forced method (MinerU), use it
          if (cachedMarkdown) {
            console.log(`[Summary - CACHE] ✓ Using cached ${cacheSource} extracted markdown`);
            console.log('[Summary - CACHE] Cached markdown length:', cachedMarkdown.length, 'characters');
            console.log('[Summary - CACHE] Skipping extraction (already cached)');
            extractedMarkdown = cachedMarkdown;
            lastUsedExtractionMethod = 'mineru'; // Set method for forced mode
          } else {
            console.log('[Summary - CACHE] ✗ No cached markdown found for current mode');

            try {
              if (!preferObjectDetection) {
                // User disabled AUTO MODE - force MinerU
                console.log('[Summary - FORCED MODE] ========== FORCING MACHINE LEARNING (MinerU) ==========');
                console.log('[Summary - FORCED MODE] User preference: Always use Machine Learning');
                console.log('[Summary - FORCED MODE] Skipping flattening detection');

                if (!SLIDES_PDF_URL) {
                  throw new Error('MinerU requires a PDF URL but none was provided');
                }

                // Phase 1: Skip checking, go straight to extracting
                showSummaryGenerating('extracting', 'mineru');
                if (!summaryGeneratingInBackground) updateHeaderSubtitle('Extracting images via MinerU...');

                lastUsedExtractionMethod = 'mineru';
                extractedMarkdown = await extractImagesFromPdf(SLIDES_PDF_URL);

                // Cache the MinerU result
                extractedMarkdownMineru = extractedMarkdown;
                console.log('[Summary - FORCED MODE] ✓ Extraction complete and cached to MinerU cache');
              } else {
                // User enabled AUTO MODE - analyze and decide
                console.log('[Summary - AUTO MODE] Will analyze PDF to determine extraction method...');

                // Phase 1: Checking PDF structure
                showSummaryGenerating('checking');
                if (!summaryGeneratingInBackground) updateHeaderSubtitle('Analyzing PDF structure...');

                // Get the PDF blob
                let pdfBlob = cachedPdfBlob;
                if (!pdfBlob && SLIDES_PDF_URL) {
                  console.log('[Summary - AUTO MODE] Fetching PDF from URL for analysis...');
                  pdfBlob = await fetchAsBlob(SLIDES_PDF_URL, "application/pdf");
                }

                if (!pdfBlob) {
                  throw new Error('No PDF available for extraction');
                }

                // Check if PDF is flattened
                console.log('[Summary - AUTO MODE] Checking PDF flattening status...');
                const flatteningResult = await checkPdfFlattening(pdfBlob);

                // Make automatic decision
                console.log('[Summary - AUTO MODE] ==================== DECISION ====================');
                console.log('[Summary - AUTO MODE] Recommended Method:', flatteningResult.recommendation.toUpperCase());
                console.log('[Summary - AUTO MODE] Reason:', flatteningResult.reason);

                // Store the extraction method for display purposes
                lastUsedExtractionMethod = flatteningResult.recommendation;

                // NOW check the appropriate cache based on the detected method
                if (flatteningResult.recommendation === 'backend' && extractedMarkdownBackend) {
                  console.log('[Summary - AUTO MODE] ✓ Using cached Backend extracted markdown');
                  console.log('[Summary - AUTO MODE] Cached markdown length:', extractedMarkdownBackend.length, 'characters');
                  extractedMarkdown = extractedMarkdownBackend;
                } else if (flatteningResult.recommendation === 'mineru' && extractedMarkdownMineru) {
                  console.log('[Summary - AUTO MODE] ✓ Using cached MinerU extracted markdown');
                  console.log('[Summary - AUTO MODE] Cached markdown length:', extractedMarkdownMineru.length, 'characters');
                  extractedMarkdown = extractedMarkdownMineru;
                } else {
                  // No cache for this method - proceed with extraction
                  console.log('[Summary - AUTO MODE] ✗ No cache for', flatteningResult.recommendation, 'method');

                  // Edge case: Manual upload (no URL) + flattened PDF
                  if (!SLIDES_PDF_URL && flatteningResult.is_flattened === true) {
                    console.error('[Summary - AUTO MODE] ⚠️  EDGE CASE DETECTED!');
                    console.error('[Summary - AUTO MODE] PDF was uploaded manually (no URL)');
                    console.error('[Summary - AUTO MODE] PDF is flattened (requires MinerU)');
                    console.error('[Summary - AUTO MODE] MinerU requires a hosted PDF URL');
                    console.error('[Summary - AUTO MODE] Cannot proceed with extraction');

                    throw new Error(
                      'Your PDF is flattened and requires cloud processing (MinerU).\n\n' +
                      'However, you uploaded the PDF manually without providing a URL.\n\n' +
                      'Please provide a direct link to your PDF instead of uploading it manually.\n' +
                      '(Use the "PDF Slides URL" field in the toggle UI)'
                    );
                  }

                  // Phase 2: Extracting images with the chosen method
                  showSummaryGenerating('extracting', flatteningResult.recommendation);

                  // Execute extraction based on decision
                  if (flatteningResult.recommendation === 'backend') {
                    console.log('[Summary - AUTO MODE] ✓ Using LOCAL BACKEND extraction');
                    console.log('[Summary - AUTO MODE] PDF has true embedded images');
                    if (!summaryGeneratingInBackground) updateHeaderSubtitle('Extracting images locally...');
                    extractedMarkdown = await extractImagesLocally(pdfBlob);

                    // Cache the backend result
                    extractedMarkdownBackend = extractedMarkdown;
                    console.log('[Summary - AUTO MODE] ✓ Extraction complete and cached to Backend cache');
                  } else {
                    console.log('[Summary - AUTO MODE] ✓ Using MINERU CLOUD extraction');
                    console.log('[Summary - AUTO MODE] PDF is flattened, requires OCR/cloud processing');

                    if (!SLIDES_PDF_URL) {
                      throw new Error('MinerU requires a PDF URL but none was provided');
                    }

                    if (!summaryGeneratingInBackground) updateHeaderSubtitle('Extracting images via MinerU...');
                    extractedMarkdown = await extractImagesFromPdf(SLIDES_PDF_URL);

                    // Cache the MinerU result
                    extractedMarkdownMineru = extractedMarkdown;
                    console.log('[Summary - AUTO MODE] ✓ Extraction complete and cached to MinerU cache');
                  }
                }
              }

              console.log('[Summary] Extracted markdown length:', extractedMarkdown?.length || 0, 'characters');
            } catch (error) {
              console.error('[Summary - AUTO MODE] ✗ Extraction failed:', error);
              console.error('[Summary - AUTO MODE] Error message:', error.message);
              console.error('[Summary - AUTO MODE] Error stack:', error.stack);
              alert(`Failed to extract images: ${error.message}\nContinuing without images...`);
            }
          }
        } else {
          if (includeImages && !SLIDES_PDF_URL && !cachedPdfBlob) {
            console.log('[Summary - AUTO MODE] Images option enabled but no PDF available');
          } else if (!includeImages) {
            console.log('[Summary - AUTO MODE] Images option disabled, skipping extraction');
          }
        }

        // Phase 3: Generating summary
        showSummaryGenerating('generating');
        if (!summaryGeneratingInBackground) updateHeaderSubtitle('Generating Summary...');

        // Fetch summary prompt from backend
        console.log('[Summary] Fetching summary prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/summary-with-images', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summaryFormat: summaryFormat,
            selectedExtras: getSelectedExtras(),
            customInstructions: customInstructions || null,
            hasExtractedImages: extractedMarkdown ? true : false,
            usedLocalExtraction: localExtractionSession !== null
          })
        });
        const promptData = await promptResponse.json();
        let summaryPrompt = promptData.prompt;

        // Append YouTube-specific instructions if on YouTube
        if (isYouTubePage()) {
          summaryPrompt += "\n\nIMPORTANT: For this YouTube video, the attached text files represent: (1) the video summary as 'lecture slides', and (2) the audio transcript if available. Your summary must be based on these attached documents only. Treat the video summary text as if it were lecture slides content. NOTE: Any title examples in the prompt (like 'IADS Lecture 7 Summary') are just format examples - generate an appropriate title based on the actual content of the attached files.";
        }

        console.log("Starting summary generation with format:", summaryFormat, "extras:", getSelectedExtras());

        // Initialize files if not already done
        if (!filesInitialized && !filesInitializing) {
          await initializeFiles(null);
        } else if (filesInitializing) {
          // Wait for initialization to complete
          await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
              if (filesInitialized) {
                clearInterval(checkInterval);
                resolve();
              }
            }, 100);
          });
        }

        const vttUri = uploadedVttUri;
        const pdfUri = uploadedPdfUri;

        console.log("Using uploaded files for summary - VTT:", vttUri, "PDF:", pdfUri);

        // Require at least ONE file (YouTube may not have transcript, Echo360 may not have PDF)
        if (!vttUri && !pdfUri) {
          throw new Error("Required files (PDF or VTT) not available");
        }

        // Build parts array - only include files that are available
        // YouTube uses text/plain for video summary, Echo360 uses application/pdf for slides
        const pdfMimeType = isYouTubePage() ? "text/plain" : "application/pdf";
        const parts = [{ text: summaryPrompt }];
        if (pdfUri) parts.push({ fileData: { mimeType: pdfMimeType, fileUri: pdfUri } });
        if (vttUri) parts.push({ fileData: { mimeType: "text/plain", fileUri: vttUri } });

        // Add extracted markdown if available (use cached URI if available)
        if (extractedMarkdown) {
          // Replace image URLs with placeholders before sending to Gemini
          const processedMarkdown = replaceImageUrlsWithPlaceholders(extractedMarkdown);

          let markdownUri = extractedMarkdownUri;

          // Only upload if we don't have a cached URI
          if (!markdownUri) {
            updateHeaderSubtitle('Uploading extracted markdown...');
            const markdownBlob = new Blob([processedMarkdown], { type: 'text/plain' });
            markdownUri = await uploadFileToGemini(markdownBlob, 'extracted-slides.md');
            extractedMarkdownUri = markdownUri; // Cache the URI
            console.log('[Summary] Uploaded and cached markdown URI with placeholders');
          } else {
            console.log('[Summary] Using cached markdown URI');
          }

          parts.push({ fileData: { mimeType: "text/plain", fileUri: markdownUri } });
          console.log('[Summary] Added extracted markdown to request');
        }

        const body = {
          contents: [{
            parts: parts
          }],
          generationConfig: {
            temperature: 2.0,
            topK: 64,
            topP: 0.95
          }
        };

        if (!summaryGeneratingInBackground) updateHeaderSubtitle('Generating summary...');

        await waitForApiKey();

        let resp;
        let summaryModelUsed = forceFlashModel ? MODEL_FLASH : MODEL_PRO;

        // If forceFlashModel is set, skip PRO model and go directly to Flash
        if (forceFlashModel) {
          console.log('[Summary] Forcing Flash model (rate limit recovery)');
          forceFlashModel = false; // Reset flag

          showSummaryGenerating('generating');
          if (!summaryGeneratingInBackground) updateHeaderSubtitle('Generating summary with Flash model...');

          const flashController = new AbortController();
          const flashTimeoutId = setTimeout(() => flashController.abort(), 180000);

          logModelUsage('Summary', summaryModelUsed, 'attempt');
          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: flashController.signal
            }
          );
          clearTimeout(flashTimeoutId);
        } else {
          // Use Pro model for summary
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 180000); // 3 minutes timeout

          logModelUsage('Summary', summaryModelUsed, 'attempt');
          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: controller.signal
            }
          );
          clearTimeout(timeoutId);
        }

        // Handle 429 rate limit specially for summary
        if (resp.status === 429) {
          // If generating in background, just mark as rate limited and exit
          if (summaryGeneratingInBackground) {
            console.log('[Summary] Rate limited in background - will show dialog when user returns');
            summaryRateLimited = true;
            summaryGeneratingInBackground = false;
            summaryGenerating = false;
            summaryBtn.textContent = 'Summary (Rate Limited)';
            throw new Error('Rate limited - user needs to decide');
          }

          // Show rate limit dialog with option to use Flash model
          const useFlash = await new Promise((resolve) => {
            chatEl.innerHTML = '';
            controlsEl.style.display = 'none';
            inputRowEl.style.display = 'none';
            attEl.style.display = 'none';

            const container = document.createElement('div');
            container.className = 'quiz-generating';
            container.innerHTML = `
              <div class="quiz-gen-text">⚠️ Rate Limited</div>
              <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">You have been rate limited by the API. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the summary.</div>
              <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
                <button class="flashcard-btn" id="summary-rate-limit-cancel">Try Again Later</button>
                <button class="flashcard-btn flashcard-btn-primary" id="summary-rate-limit-flash">Use Flash Model</button>
              </div>
            `;
            chatEl.appendChild(container);

            document.getElementById('summary-rate-limit-cancel').onclick = () => resolve(false);
            document.getElementById('summary-rate-limit-flash').onclick = () => resolve(true);
          });

          if (!useFlash) {
            // User chose to try again later - restore UI
            chatEl.innerHTML = '';
            controlsEl.style.display = '';
            inputRowEl.style.display = '';
            attEl.style.display = '';
            summaryBtn.style.display = '';
            updateHeaderSubtitle('Ask about this slide');
            throw new Error('Rate limited - try again later');
          }

          // User chose to use Flash model, retry with Flash
          console.log('Rate limited on Pro model, retrying with Flash model for summary');
          summaryModelUsed = MODEL_FLASH;
          logModelUsage('Summary', summaryModelUsed, 'retry after rate limit');

          // Reset countdown timer to start fresh
          if (summaryCountdownInterval) {
            clearInterval(summaryCountdownInterval);
            summaryCountdownInterval = null;
          }
          summaryCountdownStartTime = null;
          summaryCountdownPhase = 1;

          showSummaryGenerating('generating');
          if (!summaryGeneratingInBackground) updateHeaderSubtitle('Generating summary with Flash model...');

          const flashController = new AbortController();
          const flashTimeoutId = setTimeout(() => flashController.abort(), 180000);

          resp = await proxiedFetchForAI(
            `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              signal: flashController.signal
            }
          );
          clearTimeout(flashTimeoutId);
        }

        logModelUsage('Summary', summaryModelUsed, 'response received');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const data = await resp.json();
        let rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

        if (!rawText) {
          throw new Error("No summary generated");
        }

        if (summaryFormat === 'html') {
          // Process HTML output
          // Check if it starts with <!DOCTYPE html> and ends with </html>
          if (rawText.trim().startsWith('<!DOCTYPE html>') && rawText.trim().endsWith('</html>')) {
            summaryHtml = rawText.trim();
          } else {
            // Extract HTML between <!DOCTYPE html> and </html>
            const doctypeIndex = rawText.indexOf('<!DOCTYPE html>');
            const htmlEndIndex = rawText.lastIndexOf('</html>');

            if (doctypeIndex !== -1 && htmlEndIndex !== -1) {
              summaryHtml = rawText.substring(doctypeIndex, htmlEndIndex + '</html>'.length).trim();
            } else {
            summaryHtml = rawText.trim();
          }
          }

          // Store the original HTML with IMAGE_N placeholders
          summaryHtmlOriginal = summaryHtml.trim();
          console.log("Summary HTML generated (with IMAGE_N placeholders), length:", summaryHtmlOriginal.length);

          // Replace <!-- IMAGE_N --> placeholders with <img> tags if images were extracted
          if (extractedMarkdown && summaryHtmlOriginal.includes('<!-- IMAGE_')) {
            // Replace comment placeholders with actual <img> tags
            summaryHtmlWithUrls = replaceImagePlaceholdersWithImgTags(summaryHtmlOriginal);
            console.log("Summary HTML with <img> tags replaced, length:", summaryHtmlWithUrls.length);

            summaryHtml = summaryHtmlWithUrls;
            summaryHasImages = true;
            if (!summaryGeneratingInBackground) updateHeaderSubtitle('Summary complete!');
          } else {
            summaryHtml = summaryHtmlOriginal;
            summaryHtmlWithUrls = null;
            if (!summaryGeneratingInBackground) updateHeaderSubtitle('Summary complete!');
          }

          // Save to version storage if extraction method is known
          if (lastUsedExtractionMethod) {
            saveCurrentSummaryToVersion(lastUsedExtractionMethod);
          }

          // Only show result if not generating in background
          if (!summaryGeneratingInBackground) {
            showSummaryHtmlResult();
          }
        } else {
          // Process LaTeX output
          // If output contains ```latex, extract text between first ```latex and last ```
          if (rawText.includes('```latex')) {
            const firstLatexIndex = rawText.indexOf('```latex');
            const lastBackticksIndex = rawText.lastIndexOf('```');

            if (firstLatexIndex !== -1 && lastBackticksIndex !== -1 && lastBackticksIndex > firstLatexIndex) {
              // Extract content between ```latex and the last ```
              const startIndex = firstLatexIndex + '```latex'.length;
              rawText = rawText.substring(startIndex, lastBackticksIndex).trim();
            }
          }

          // Store the original LaTeX with IMAGE_N placeholders
          summaryLatexOriginal = rawText.trim();
          console.log("Summary LaTeX generated (with IMAGE_N placeholders), length:", summaryLatexOriginal.length);

          // Replace IMAGE_N placeholders with actual URLs if images were extracted
          if (extractedMarkdown && summaryLatexOriginal.includes('% IMAGE_')) {
            // Store version with URL placeholders for later re-processing with different image sizes
            summaryLatexWithUrls = replaceImagePlaceholdersWithUrls(summaryLatexOriginal);
            console.log("Summary LaTeX with URLs replaced, length:", summaryLatexWithUrls.length);

            // Now replace URLs with base64
            if (!summaryGeneratingInBackground) updateHeaderSubtitle('Embedding images in LaTeX...');
            try {
              summaryLatex = await replaceImagePlaceholdersWithBase64(summaryLatexWithUrls);
              console.log("Summary LaTeX with embedded images, length:", summaryLatex.length);
              if (!summaryGeneratingInBackground) updateHeaderSubtitle('Summary complete!');
            } catch (error) {
              console.error('[Summary] Failed to embed images:', error);
              alert(`Failed to embed images: ${error.message}\nLaTeX will contain image URL placeholders.`);
              if (!summaryGeneratingInBackground) updateHeaderSubtitle('Summary complete (with errors)');
            }
          } else {
            summaryLatex = summaryLatexOriginal;
            summaryLatexWithUrls = null;
            if (!summaryGeneratingInBackground) updateHeaderSubtitle('Summary complete!');
          }

          // Save to version storage if extraction method is known
          if (lastUsedExtractionMethod) {
            saveCurrentSummaryToVersion(lastUsedExtractionMethod);
          }

          // Only show Overleaf options if not generating in background
          if (!summaryGeneratingInBackground) {
            showSummaryOverleafOptions();
          }
        }

      } catch (err) {
        console.error("Summary generation failed:", err);
        setError("Summary generation failed: " + err.message);
        restoreSavedChatContent();
        controlsEl.style.display = '';
        inputRowEl.style.display = '';
        attEl.style.display = '';
        summaryBtn.style.display = '';
        updateHeaderSubtitle('Ask about this slide');
      } finally {
        suppressIntercept = false;
        summaryGenerating = false;

        // If completed in background, update button
        if (summaryGeneratingInBackground) {
          summaryGeneratingInBackground = false;
          summaryBtn.textContent = 'Summary (Ready)';
          console.log("Summary generation completed in background");
        }
      }
    };

    window.exitSummaryGeneration = function() {
      console.log("User exited summary generation - continuing in background");

      // Don't abort - let it continue in background
      summaryGenerating = false;
      summaryGeneratingInBackground = true;
      restoreSavedChatContent();

      // Restore UI
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      summaryBtn.style.display = '';
      summaryBtn.textContent = 'Summary (Generating...)';
      updateHeaderSubtitle('Ask about this slide');
    };

    function showSummaryGenerating(phase = 'generating', extractionMethod = null, preserveCountdown = false) {
      // Don't update UI if generating in background
      if (summaryGeneratingInBackground) return;

      // Track current phase
      currentSummaryPhase = phase;

      saveChatBeforeClearing();
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'quiz-generating';
      const formatText = summaryFormat === 'html' ? 'HTML page' : 'LaTeX document';

      let title, subtitle, eta;

      if (phase === 'checking') {
        console.log('[Summary Phase] Checking PDF structure...');
        title = 'Analyzing PDF Structure...';
        subtitle = 'Determining optimal extraction method for your slides';
        eta = 10;
        // Only reset timer if not preserving
        if (!preserveCountdown) {
          summaryCountdownStartTime = null;
          summaryCountdownPhase = 1;
          summaryCountdownInitialEta = eta;
        }
      } else if (phase === 'extracting') {
        console.log('[Summary Phase] Extracting images... Method:', extractionMethod || lastUsedExtractionMethod);
        title = 'Extracting Images from PDF...';
        // Dynamic subtitle based on extraction method
        const method = extractionMethod || lastUsedExtractionMethod;
        if (method === 'backend') {
          subtitle = 'Using Object Detection to extract slide images and structure';
        } else {
          subtitle = 'Using Machine Learning to extract slide images and structure';
        }
        eta = 30;
        // Only reset timer if not preserving
        if (!preserveCountdown) {
          summaryCountdownStartTime = null;
          summaryCountdownPhase = 1;
          summaryCountdownInitialEta = eta;
        }
      } else if (phase === 'generating') {
        console.log('[Summary Phase] Generating summary...');
        title = 'Generating Lecture Summary...';
        subtitle = `Analyzing lecture content and creating ${formatText}`;
        // Use 80 seconds if images were extracted, otherwise 60
        eta = (extractedMarkdownBackend || extractedMarkdownMineru) ? 80 : 60;
        // Only reset timer if not preserving
        if (!preserveCountdown) {
          summaryCountdownStartTime = null;
          summaryCountdownPhase = 1;
          summaryCountdownInitialEta = eta;
        }
      } else {
        title = 'Processing...';
        subtitle = 'Working on your request';
        eta = 30;
        if (!preserveCountdown) {
          summaryCountdownStartTime = null;
          summaryCountdownPhase = 1;
          summaryCountdownInitialEta = eta;
        }
      }

      // Clear existing countdown interval only if not preserving
      if (!preserveCountdown && summaryCountdownInterval) {
        clearInterval(summaryCountdownInterval);
        summaryCountdownInterval = null;
      }

      // Calculate initial countdown display
      let initialTimeStr;
      if (preserveCountdown && summaryCountdownStartTime) {
        // Calculate actual remaining time based on elapsed time
        const elapsed = Math.floor((Date.now() - summaryCountdownStartTime) / 1000);
        const remaining = Math.max(0, summaryCountdownInitialEta - elapsed);
        const mins = Math.floor(remaining / 60);
        const secs = remaining % 60;
        initialTimeStr = mins > 0 ? `${mins} min ${secs} seconds` : `${remaining} seconds`;
      } else {
        // Use full ETA for new countdown
        const mins = Math.floor(eta / 60);
        const secs = eta % 60;
        initialTimeStr = mins > 0 ? `${mins} min ${secs} seconds` : `${eta} seconds`;
      }

      container.innerHTML = `
        <div class="quiz-gen-spinner"></div>
        <div class="quiz-gen-text">${title}</div>
        <div class="quiz-gen-subtext">${subtitle}</div>
        <div class="quiz-gen-eta summary-eta" style="font-size: 13px; color: #666; margin-top: 8px;">ETA: ${initialTimeStr}</div>
        ${summaryFormat === 'html' ? `
          <div class="pro-tip-box" style="background: #e3f2fd; border-left: 4px solid #2196f3; padding: 12px 16px; border-radius: 8px; margin-top: 24px; max-width: 500px;">
            <div class="pro-tip-title" style="font-weight: 600; color: #1976d2; margin-bottom: 4px; font-size: 13px;">💡 Pro Tip</div>
            <div class="pro-tip-text" style="color: #1565c0; font-size: 13px;">Select text or Hold <strong>Shift</strong> and hover over elements in the HTML summary, then click to ask for clarification!</div>
          </div>
        ` : ''}
        <button class="quiz-gen-stop" onclick="exitSummaryGeneration()" style="margin-top: 24px;">Exit</button>
      `;
      chatEl.appendChild(container);

      const etaEl = container.querySelector('.summary-eta');

      // Only start new countdown if not preserving existing one
      if (!preserveCountdown) {
        summaryCountdownStartTime = Date.now();
        summaryCountdownPhase = 1;
      }

      // Only create interval if it doesn't exist
      if (!summaryCountdownInterval) {
        summaryCountdownInterval = setInterval(() => {
        const etaElement = document.querySelector('.summary-eta');
        if (!etaElement) return;

        const elapsed = Math.floor((Date.now() - summaryCountdownStartTime) / 1000);

        if (summaryCountdownPhase === 1) {
          const remaining = Math.max(0, summaryCountdownInitialEta - elapsed);
          if (remaining > 0) {
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            const timeStr = mins > 0 ? `${mins} min ${secs} seconds` : `${remaining} seconds`;
            etaElement.textContent = `ETA: ${timeStr}`;
          } else {
            summaryCountdownPhase = 2;
          }
        } else if (summaryCountdownPhase === 2) {
          const remaining = Math.max(0, 19 - (elapsed - summaryCountdownInitialEta));
          if (remaining > 0) {
            etaElement.textContent = `Hold tight, it's almost done: ${remaining} seconds`;
          } else {
            summaryCountdownPhase = 3;
            etaElement.textContent = "Sorry, this is taking longer than expected...";
            clearInterval(summaryCountdownInterval);
            summaryCountdownInterval = null;
          }
        } else if (summaryCountdownPhase === 3) {
          etaElement.textContent = "Sorry, this is taking longer than expected...";
        }
      }, 1000);
      }
    }

    // ========== TTS FUNCTIONALITY ==========

    window.handleTTSButtonClick = function(event) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      if (summaryAudioBlob) {
        // Audio already exists, play it
        playStoredAudio();
      } else {
        // Generate new audio
        generateSummaryTTS(event);
      }

      return false;
    };

    function playStoredAudio() {
      console.log('[TTS] Playing stored audio');

      const ttsBtn = document.getElementById('tts-btn');
      if (!ttsBtn) {
        console.error('[TTS] TTS button not found');
        return;
      }

      // Stop any currently playing audio
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
      }

      // Create new audio from stored blob
      if (!summaryAudioUrl) {
        summaryAudioUrl = URL.createObjectURL(summaryAudioBlob);
      }

      currentAudio = new Audio(summaryAudioUrl);

      ttsBtn.textContent = '🔊 Playing...';
      ttsBtn.disabled = true;

      currentAudio.onended = () => {
        console.log('[TTS] Audio playback finished');
        ttsBtn.disabled = false;
        ttsBtn.textContent = '🔊 Play TTS';
        removeAudioControls();
      };

      currentAudio.onerror = (e) => {
        console.error('[TTS] Audio playback error:', e);
        ttsBtn.disabled = false;
        ttsBtn.textContent = '🔊 Play TTS';
        alert('Error playing audio. Please try again.');
        removeAudioControls();
      };

      currentAudio.play();
      showAudioControls();
    }

    function showAudioControls() {
      // Remove existing controls if present
      removeAudioControls();

      // Create controls container
      audioControlsContainer = document.createElement('div');
      audioControlsContainer.id = 'audio-controls';
      audioControlsContainer.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 100px;
        background: linear-gradient(135deg, #4a63ff 0%, #3a53ef 100%);
        color: white;
        padding: 16px 20px;
        border-radius: 16px;
        box-shadow: 0 8px 24px rgba(74, 99, 255, 0.5);
        z-index: 2147483646;
        display: flex;
        gap: 12px;
        align-items: center;
        font-family: system-ui, sans-serif;
      `;

      // Pause/Resume button
      const pauseBtn = document.createElement('button');
      pauseBtn.id = 'audio-pause-btn';
      pauseBtn.textContent = '⏸️ Pause';
      pauseBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        transition: all 0.2s;
      `;
      pauseBtn.onmouseenter = () => pauseBtn.style.background = 'rgba(255, 255, 255, 0.3)';
      pauseBtn.onmouseleave = () => pauseBtn.style.background = 'rgba(255, 255, 255, 0.2)';
      pauseBtn.onclick = () => {
        if (currentAudio) {
          if (currentAudio.paused) {
            currentAudio.play();
            pauseBtn.textContent = '⏸️ Pause';
          } else {
            currentAudio.pause();
            pauseBtn.textContent = '▶️ Resume';
          }
        }
      };

      // Restart button
      const restartBtn = document.createElement('button');
      restartBtn.textContent = '🔄 Restart';
      restartBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        transition: all 0.2s;
      `;
      restartBtn.onmouseenter = () => restartBtn.style.background = 'rgba(255, 255, 255, 0.3)';
      restartBtn.onmouseleave = () => restartBtn.style.background = 'rgba(255, 255, 255, 0.2)';
      restartBtn.onclick = () => {
        if (currentAudio) {
          currentAudio.currentTime = 0;
          currentAudio.play();
          pauseBtn.textContent = '⏸️ Pause';
        }
      };

      // Stop button
      const stopBtn = document.createElement('button');
      stopBtn.textContent = '⏹️ Stop';
      stopBtn.style.cssText = `
        background: rgba(255, 255, 255, 0.2);
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        transition: all 0.2s;
      `;
      stopBtn.onmouseenter = () => stopBtn.style.background = 'rgba(255, 255, 255, 0.3)';
      stopBtn.onmouseleave = () => stopBtn.style.background = 'rgba(255, 255, 255, 0.2)';
      stopBtn.onclick = () => {
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.currentTime = 0;
          currentAudio = null;
        }
        const ttsBtn = document.getElementById('tts-btn');
        if (ttsBtn) {
          ttsBtn.disabled = false;
          ttsBtn.textContent = '🔊 Play TTS';
        }
        removeAudioControls();
      };

      audioControlsContainer.appendChild(pauseBtn);
      audioControlsContainer.appendChild(restartBtn);
      audioControlsContainer.appendChild(stopBtn);

      document.body.appendChild(audioControlsContainer);
    }

    function removeAudioControls() {
      if (audioControlsContainer) {
        audioControlsContainer.remove();
        audioControlsContainer = null;
      }
    }

    function extractReadableTextFromSummary() {
      console.log('[TTS] Extracting readable text from summary');

      // Get the summary content wrapper
      const summaryWrapper = document.querySelector('.summary-content-wrapper');
      if (!summaryWrapper) {
        console.error('[TTS] Summary content wrapper not found');
        return '';
      }

      // Clone the content to avoid modifying the original
      const clone = summaryWrapper.cloneNode(true);

      // Remove script and style elements
      clone.querySelectorAll('script, style').forEach(el => el.remove());

      // Remove buttons and controls
      clone.querySelectorAll('button, .summary-buttons-container').forEach(el => el.remove());

      // Get text content
      let text = clone.textContent || '';

      // Clean up the text
      text = text
        // Remove excessive whitespace
        .replace(/\s+/g, ' ')
        // Remove multiple spaces
        .replace(/ +/g, ' ')
        // Trim
        .trim();

      // Convert common LaTeX symbols to readable text
      text = text
        // Greek letters
        .replace(/\\alpha/g, 'alpha')
        .replace(/\\beta/g, 'beta')
        .replace(/\\gamma/g, 'gamma')
        .replace(/\\delta/g, 'delta')
        .replace(/\\epsilon/g, 'epsilon')
        .replace(/\\theta/g, 'theta')
        .replace(/\\lambda/g, 'lambda')
        .replace(/\\mu/g, 'mu')
        .replace(/\\pi/g, 'pi')
        .replace(/\\sigma/g, 'sigma')
        .replace(/\\tau/g, 'tau')
        .replace(/\\phi/g, 'phi')
        .replace(/\\omega/g, 'omega')
        .replace(/\\Omega/g, 'Omega')
        .replace(/\\Theta/g, 'Theta')
        .replace(/\\Sigma/g, 'Sigma')
        // Math operators
        .replace(/\\times/g, 'times')
        .replace(/\\div/g, 'divided by')
        .replace(/\\pm/g, 'plus or minus')
        .replace(/\\leq/g, 'less than or equal to')
        .replace(/\\geq/g, 'greater than or equal to')
        .replace(/\\neq/g, 'not equal to')
        .replace(/\\approx/g, 'approximately equal to')
        .replace(/\\infty/g, 'infinity')
        .replace(/\\sum/g, 'sum')
        .replace(/\\prod/g, 'product')
        .replace(/\\int/g, 'integral')
        .replace(/\\sqrt/g, 'square root of')
        .replace(/\\frac/g, 'fraction')
        .replace(/\\log/g, 'logarithm')
        .replace(/\\ln/g, 'natural logarithm')
        .replace(/\\sin/g, 'sine')
        .replace(/\\cos/g, 'cosine')
        .replace(/\\tan/g, 'tangent')
        // Remove LaTeX delimiters
        .replace(/\$\$/g, ' ')
        .replace(/\$/g, ' ')
        .replace(/\\[\[\]()]/g, ' ')
        // Remove remaining LaTeX commands
        .replace(/\\[a-zA-Z]+/g, ' ')
        // Remove curly braces
        .replace(/[{}]/g, ' ')
        // Clean up again
        .replace(/\s+/g, ' ')
        .trim();

      console.log('[TTS] Extracted text length:', text.length);
      console.log('[TTS] First 200 chars:', text.substring(0, 200));

      return text;
    }

    function pcmToWav(pcmData, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
      // Calculate sizes
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const dataSize = pcmData.length;
      const chunkSize = 36 + dataSize;

      // Create WAV file buffer
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);

      // Write WAV header
      // "RIFF" chunk descriptor
      writeString(view, 0, 'RIFF');
      view.setUint32(4, chunkSize, true);
      writeString(view, 8, 'WAVE');

      // "fmt " sub-chunk
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
      view.setUint16(20, 1, true); // AudioFormat (1 for PCM)
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitsPerSample, true);

      // "data" sub-chunk
      writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);

      // Write PCM data
      const pcmArray = new Uint8Array(pcmData);
      const wavArray = new Uint8Array(buffer);
      wavArray.set(pcmArray, 44);

      return buffer;
    }

    function writeString(view, offset, string) {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    }

    window.generateSummaryTTS = async function(event) {
      // Prevent event bubbling to avoid triggering other handlers
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }

      console.log('[TTS] === Starting TTS Generation ===');

      const ttsBtn = document.getElementById('tts-btn');
      if (!ttsBtn) {
        console.error('[TTS] TTS button not found');
        return;
      }

      // Disable button and show loading state
      ttsBtn.disabled = true;
      ttsBtn.textContent = '⏳ Generating audio...';

      try {
        // Extract readable text from summary
        const text = extractReadableTextFromSummary();

        if (!text || text.length < 10) {
          throw new Error('No readable text found in summary');
        }

        console.log('[TTS] Text length:', text.length, 'chars');

        // Prepare API request
        await waitForApiKey();

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`;

        const requestBody = {
          contents: [{
            parts: [{ text: text }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Kore"
                }
              }
            }
          }
        };

        console.log('[TTS] Sending request to AI TTS API');
        ttsBtn.textContent = '⏳ Generating speech...';

        const response = await proxiedFetchForAI(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': 'BACKEND_HANDLED' // Marker for proxy to use header auth
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`TTS API request failed: ${response.status} ${response.statusText}\n${errorText}`);
        }

        const data = await response.json();
        console.log('[TTS] Received response from AI TTS API');

        // Extract audio data - per docs: candidates[0].content.parts[0].inlineData.data
        const base64Audio = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (!base64Audio) {
          console.error('[TTS] Full response:', JSON.stringify(data, null, 2));
          throw new Error('No audio data found in response');
        }

        console.log('[TTS] Converting PCM to WAV');
        ttsBtn.textContent = '⏳ Processing audio...';

        // Decode base64 PCM data
        const pcmBinary = atob(base64Audio);
        const pcmBytes = new Uint8Array(pcmBinary.length);
        for (let i = 0; i < pcmBinary.length; i++) {
          pcmBytes[i] = pcmBinary.charCodeAt(i);
        }

        // Convert PCM to WAV
        const wavBuffer = pcmToWav(pcmBytes, 24000, 1, 16);
        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });

        // Store the blob for replay
        summaryAudioBlob = wavBlob;
        summaryAudioUrl = URL.createObjectURL(wavBlob);

        console.log('[TTS] Playing audio');
        ttsBtn.textContent = '🔊 Playing...';

        // Create and play audio
        currentAudio = new Audio(summaryAudioUrl);

        currentAudio.onended = () => {
          console.log('[TTS] Audio playback finished');
          ttsBtn.disabled = false;
          ttsBtn.textContent = '🔊 Play TTS'; // Changed from "Generate" to "Play"
          removeAudioControls();
        };

        currentAudio.onerror = (e) => {
          console.error('[TTS] Audio playback error:', e);
          ttsBtn.disabled = false;
          ttsBtn.textContent = '🔊 Play TTS';
          alert('Error playing audio. Please try again.');
          removeAudioControls();
        };

        await currentAudio.play();
        showAudioControls(); // Show pause/restart controls
        console.log('[TTS] === TTS Generation Complete ===');

      } catch (error) {
        console.error('[TTS] Error:', error);
        ttsBtn.disabled = false;
        // Keep current text if audio was already generated, otherwise show Generate
        if (!summaryAudioBlob) {
          ttsBtn.textContent = '🔊 Generate TTS';
        } else {
          ttsBtn.textContent = '🔊 Play TTS';
        }
        alert(`TTS Error: ${error.message}`);
      }

      return false; // Prevent any default action
    };

    async function generateSelectedTextTTS(selectedText) {
      console.log('[TTS Selected] === Starting TTS Generation for Selected Text ===');
      console.log('[TTS Selected] Text:', selectedText);

      if (!selectedText || selectedText.length < 2) {
        alert('Selected text is too short for TTS generation.');
        return;
      }

      // Create a temporary status element to show progress
      const statusEl = document.createElement('div');
      statusEl.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: linear-gradient(135deg, #4a63ff 0%, #3a53ef 100%);
        color: white;
        padding: 12px 20px;
        border-radius: 12px;
        font-size: 14px;
        font-weight: 600;
        box-shadow: 0 4px 16px rgba(74, 99, 255, 0.5);
        z-index: 2147483647;
        transition: all 0.3s;
      `;
      statusEl.textContent = '⏳ Generating speech...';
      document.body.appendChild(statusEl);

      try {
        // Clean the text (remove excessive whitespace, handle LaTeX)
        let cleanedText = selectedText
          .replace(/\s+/g, ' ')
          .trim();

        // Convert common LaTeX symbols to readable text
        cleanedText = cleanedText
          // Greek letters
          .replace(/\\alpha/g, 'alpha')
          .replace(/\\beta/g, 'beta')
          .replace(/\\gamma/g, 'gamma')
          .replace(/\\delta/g, 'delta')
          .replace(/\\epsilon/g, 'epsilon')
          .replace(/\\theta/g, 'theta')
          .replace(/\\lambda/g, 'lambda')
          .replace(/\\mu/g, 'mu')
          .replace(/\\pi/g, 'pi')
          .replace(/\\sigma/g, 'sigma')
          .replace(/\\tau/g, 'tau')
          .replace(/\\phi/g, 'phi')
          .replace(/\\omega/g, 'omega')
          .replace(/\\Omega/g, 'Omega')
          .replace(/\\Theta/g, 'Theta')
          .replace(/\\Sigma/g, 'Sigma')
          // Math operators
          .replace(/\\times/g, 'times')
          .replace(/\\div/g, 'divided by')
          .replace(/\\pm/g, 'plus or minus')
          .replace(/\\leq/g, 'less than or equal to')
          .replace(/\\geq/g, 'greater than or equal to')
          .replace(/\\neq/g, 'not equal to')
          .replace(/\\approx/g, 'approximately equal to')
          .replace(/\\infty/g, 'infinity')
          .replace(/\\sum/g, 'sum')
          .replace(/\\prod/g, 'product')
          .replace(/\\int/g, 'integral')
          .replace(/\\sqrt/g, 'square root of')
          .replace(/\\frac/g, 'fraction')
          .replace(/\\log/g, 'logarithm')
          .replace(/\\ln/g, 'natural logarithm')
          .replace(/\\sin/g, 'sine')
          .replace(/\\cos/g, 'cosine')
          .replace(/\\tan/g, 'tangent')
          // Remove LaTeX delimiters
          .replace(/\$\$/g, ' ')
          .replace(/\$/g, ' ')
          .replace(/\\[\[\]()]/g, ' ')
          // Remove remaining LaTeX commands
          .replace(/\\[a-zA-Z]+/g, ' ')
          // Remove curly braces
          .replace(/[{}]/g, ' ')
          // Clean up again
          .replace(/\s+/g, ' ')
          .trim();

        console.log('[TTS Selected] Cleaned text:', cleanedText);

        // Prepare API request
        await waitForApiKey();

        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent`;

        const requestBody = {
          contents: [{
            parts: [{ text: cleanedText }]
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: "Kore"
                }
              }
            }
          }
        };

        console.log('[TTS Selected] Sending request to AI TTS API');

        const response = await proxiedFetchForAI(apiUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': 'BACKEND_HANDLED' // Marker for proxy to use header auth
          },
          body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`TTS API request failed: ${response.status} ${response.statusText}\n${errorText}`);
        }

        const data = await response.json();
        console.log('[TTS Selected] Received response from AI TTS API');

        // Extract audio data
        const base64Audio = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

        if (!base64Audio) {
          console.error('[TTS Selected] Full response:', JSON.stringify(data, null, 2));
          throw new Error('No audio data found in response');
        }

        statusEl.textContent = '⏳ Processing audio...';

        // Decode base64 PCM data
        const pcmBinary = atob(base64Audio);
        const pcmBytes = new Uint8Array(pcmBinary.length);
        for (let i = 0; i < pcmBinary.length; i++) {
          pcmBytes[i] = pcmBinary.charCodeAt(i);
        }

        // Convert PCM to WAV
        const wavBuffer = pcmToWav(pcmBytes, 24000, 1, 16);
        const wavBlob = new Blob([wavBuffer], { type: 'audio/wav' });
        const audioUrl = URL.createObjectURL(wavBlob);

        statusEl.textContent = '🔊 Playing...';

        // Stop any currently playing audio
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.currentTime = 0;
        }

        // Create and play audio using global variable
        currentAudio = new Audio(audioUrl);

        currentAudio.onended = () => {
          console.log('[TTS Selected] Audio playback finished');
          statusEl.textContent = '✓ Complete';
          setTimeout(() => {
            statusEl.style.opacity = '0';
            setTimeout(() => statusEl.remove(), 300);
          }, 1000);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          removeAudioControls();
        };

        currentAudio.onerror = (e) => {
          console.error('[TTS Selected] Audio playback error:', e);
          statusEl.textContent = '✗ Error';
          statusEl.style.background = 'linear-gradient(135deg, #f44336 0%, #d32f2f 100%)';
          setTimeout(() => {
            statusEl.style.opacity = '0';
            setTimeout(() => statusEl.remove(), 300);
          }, 2000);
          URL.revokeObjectURL(audioUrl);
          currentAudio = null;
          removeAudioControls();
          alert('Error playing audio. Please try again.');
        };

        await currentAudio.play();
        showAudioControls(); // Show pause/restart/stop controls
        console.log('[TTS Selected] === TTS Generation Complete ===');

      } catch (error) {
        console.error('[TTS Selected] Error:', error);
        statusEl.textContent = '✗ Error';
        statusEl.style.background = 'linear-gradient(135deg, #f44336 0%, #d32f2f 100%)';
        setTimeout(() => {
          statusEl.style.opacity = '0';
          setTimeout(() => statusEl.remove(), 300);
        }, 2000);
        currentAudio = null;
        removeAudioControls();
        alert(`TTS Error: ${error.message}`);
      }
    }

    // ========== END TTS FUNCTIONALITY ==========

    function showSummaryHtmlResult() {
      console.log('[Summary HTML] === Starting HTML Summary Processing ===');

      // Clear countdown interval
      if (summaryCountdownInterval) {
        clearInterval(summaryCountdownInterval);
        summaryCountdownInterval = null;
        summaryCountdownStartTime = null;
        summaryCountdownPhase = 1;
      }

      saveChatBeforeClearing();
      // Reset button text
      summaryBtn.textContent = 'Summary';

      summaryOptionsShown = true;

      // Hide controls and input
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      console.log('[Summary HTML] Step 1: Original HTML length:', summaryHtml.length);
      console.log('[Summary HTML] Step 1: First 500 chars:', summaryHtml.substring(0, 500));

      // Extract <link> tags (for Font Awesome, etc.)
      let links = '';
      const linkMatches = summaryHtml.match(/<link[^>]*>/gi);
      if (linkMatches) {
        links = linkMatches.join('\n');
      }
      console.log('[Summary HTML] Step 2a: Extracted links:', links);

      // Extract <script> tags from head (for MathJax config, etc.)
      let headScripts = '';
      const headMatch = summaryHtml.match(/<head[^>]*>([\s\S]*?)<\/head>/i);
      if (headMatch) {
        const headContent = headMatch[1];
        const scriptMatches = headContent.match(/<script[^>]*>[\s\S]*?<\/script>/gi);
        if (scriptMatches) {
          headScripts = scriptMatches.join('\n');
        }
      }
      console.log('[Summary HTML] Step 2b: Extracted head scripts length:', headScripts.length);

      // Extract styles from <style> tags
      let styles = '';
      const styleMatches = summaryHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (styleMatches) {
        styleMatches.forEach(styleTag => {
          const content = styleTag.replace(/<\/?style[^>]*>/gi, '');
          styles += content + '\n';
        });
      }
      console.log('[Summary HTML] Step 2c: Extracted styles length:', styles.length);

      // Extract body content ONLY
      let bodyContent = '';
      const bodyMatch = summaryHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      if (bodyMatch) {
        bodyContent = bodyMatch[1];
        console.log('[Summary HTML] Step 3: Extracted body content (length:', bodyContent.length, ')');
      } else {
        console.log('[Summary HTML] Step 3: No body tag found, extracting all non-tag content');
        bodyContent = summaryHtml.replace(/<\/?(!DOCTYPE|html|head|body)[^>]*>/gi, '');
        bodyContent = bodyContent.replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '');
      }
      console.log('[Summary HTML] Step 3: Body content first 500 chars:', bodyContent.substring(0, 500));

      // Process markdown syntax in body content
      console.log('[Summary HTML] Step 3.5: Processing markdown and LaTeX syntax');
      bodyContent = bodyContent
        // Convert **bold** to <strong>bold</strong> (avoid matching inside HTML tags)
        .replace(/\*\*([^*<>]+?)\*\*/g, '<strong>$1</strong>')
        // Convert *italic* to <em>italic</em> (but not if it's between $ signs or inside HTML tags)
        .replace(/(?<!\$)\*([^*<>$\n]+?)\*(?!\$)/g, '<em>$1</em>')
        // Convert `code` to <code>code</code> if not already in code tags
        .replace(/(?<!<code[^>]*>)`([^`<>]+?)`(?!<\/code>)/g, '<code>$1</code>');

      console.log('[Summary HTML] Step 3.5: Processed body content first 500 chars:', bodyContent.substring(0, 500));

      console.log('[Summary HTML] Step 4: Scoping all CSS to prevent conflicts');

      // Scope ALL CSS rules to .summary-content-wrapper to prevent page-wide conflicts
      let scopedStyles = styles;

      // Replace :root with .summary-content-wrapper for CSS variables
      scopedStyles = scopedStyles.replace(/:root\s*\{/g, '.summary-content-wrapper {');

      // Scope all other selectors
      scopedStyles = scopedStyles.replace(/([^{}@]+)\{/g, (match, selector) => {
        // Skip @-rules (media, keyframes, etc.)
        if (selector.trim().startsWith('@')) {
          return match;
        }

        // Already scoped by :root replacement
        if (selector.includes('.summary-content-wrapper')) {
          return match;
        }

        // Split by comma for multiple selectors
        const scopedSelectors = selector.split(',').map(sel => {
          const trimmed = sel.trim();
          // Skip if already a descendant selector or pseudo
          if (trimmed === '' || trimmed.startsWith('.summary-content-wrapper')) {
            return trimmed;
          }
          // Scope it
          return `.summary-content-wrapper ${trimmed}`;
        }).join(', ');

        return scopedSelectors + ' {';
      });

      console.log('[Summary HTML] Step 4: Scoped styles length:', scopedStyles.length);
      console.log('[Summary HTML] Step 4: Scoped styles preview:', scopedStyles.substring(0, 500));

      // Add alternative extraction button if images were extracted
      const alternativeExtractionButton = (summaryHasImages && lastUsedExtractionMethod) ? `
        <div style="margin-bottom: 16px; padding: 12px; background: #fff3e0; border: 1px solid #ffb74d; border-radius: 8px; display: inline-block;">
          <div style="font-size: 13px; color: #666; margin-bottom: 8px;">
            ${lastUsedExtractionMethod === 'backend'
              ? 'Extracted using Object Detection'
              : 'Extracted using Machine Learning'}
          </div>
          <button class="flashcard-btn flashcard-btn-primary" onclick="extractWithAlternativeMethod()" style="padding: 8px 20px;">
            ${lastUsedExtractionMethod === 'backend'
              ? '☁️ Use Machine Learning Instead (not recommended)'
              : '⚡ Use Object Detection Instead (not recommended)'}
          </button>
        </div>
        <br>
      ` : '';

      // Add buttons - check if TTS audio already exists
      const ttsButtonText = summaryAudioBlob ? '🔊 Play TTS' : '🔊 Generate TTS';
      const buttons = `
        <div class="summary-buttons-container" style="margin-top: 40px; padding: 20px; text-align: center; border-top: 2px solid rgba(0,0,0,0.1);">
          ${alternativeExtractionButton}
          <button class="flashcard-btn" onclick="handleTTSButtonClick()" style="padding: 10px 24px; margin-right: 12px;" id="tts-btn">${ttsButtonText}</button>
          <button class="flashcard-btn flashcard-btn-primary" onclick="saveSummaryAsPdf()" style="padding: 10px 24px; margin-right: 12px;">Open in a new tab</button>
          <button class="flashcard-btn" onclick="exitSummaryMode()" style="padding: 10px 24px;">✓ Done</button>
        </div>
      `;

      // Build final HTML with all resources - use scoped styles
      const finalHTML = `
        ${links}
        ${headScripts}
        <style>
        #gemini-ui-chat .summary-content-wrapper {
          max-width: 100%;
          overflow-x: hidden;
          overflow-y: visible;
          isolation: isolate;
          box-sizing: border-box;
          padding-top: 20px;
          font-size: 16px;
        }
        #gemini-ui-chat .summary-content-wrapper * {
          max-width: 100%;
          box-sizing: border-box;
        }
        #gemini-ui-chat .summary-content-wrapper p,
        #gemini-ui-chat .summary-content-wrapper li,
        #gemini-ui-chat .summary-content-wrapper div:not(.tbox):not([class*="box"]) {
          font-size: 16px;
        }

        /* Annotation hover styles */
        .summary-content-wrapper .annotation-target {
          transition: outline 0.15s ease, background-color 0.15s ease;
          cursor: default;
        }
        .summary-content-wrapper .annotation-target:hover {
          outline: 2px solid #ff0000;
          outline-offset: 2px;
          background-color: rgba(255, 0, 0, 0.03);
        }
        .summary-content-wrapper .annotation-target.selected {
          outline: 3px solid #ff0000;
          outline-offset: 2px;
          background-color: rgba(255, 0, 0, 0.08);
        }

        /* Dark mode for summary content */
        #gemini-ui-panel.dark-mode .summary-content-wrapper {
          background: #1a1a1a;
          color: #e0e0e0;
        }
        #gemini-ui-panel.dark-mode .summary-content-wrapper h1,
        #gemini-ui-panel.dark-mode .summary-content-wrapper h2,
        #gemini-ui-panel.dark-mode .summary-content-wrapper h3,
        #gemini-ui-panel.dark-mode .summary-content-wrapper h4,
        #gemini-ui-panel.dark-mode .summary-content-wrapper h5,
        #gemini-ui-panel.dark-mode .summary-content-wrapper h6 {
          color: #fff;
        }
        #gemini-ui-panel.dark-mode .summary-content-wrapper a {
          color: #4a63ff;
        }
        #gemini-ui-panel.dark-mode .summary-content-wrapper code,
        #gemini-ui-panel.dark-mode .summary-content-wrapper pre {
          background: #000;
          color: #e0e0e0;
          border-color: rgba(255,255,255,0.2);
        }
        #gemini-ui-panel.dark-mode .summary-buttons-container {
          border-top-color: rgba(255,255,255,0.2) !important;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay {
          background: #1a1a1a;
          border-color: rgba(255,255,255,0.2);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-header {
          color: #fff;
          border-bottom-color: rgba(255,255,255,0.1);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-close {
          color: #aaa;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-close:hover {
          background: #2a2a2a;
          color: #fff;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-context {
          background: #0a0a0a;
          color: #e0e0e0;
          border-bottom-color: rgba(255,255,255,0.1);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-context strong {
          color: #fff;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-input {
          background: #0a0a0a;
          color: #fff;
          border-color: rgba(255,255,255,0.2);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-input:focus {
          border-color: #4a63ff;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-send {
          background: linear-gradient(135deg, #4a63ff 0%, #3a53ef 100%);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-response {
          background: #0a0a0a;
          border-top-color: rgba(255,255,255,0.1);
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-response > div {
          color: #e0e0e0;
        }
        #gemini-ui-panel.dark-mode .annotation-overlay-loading {
          color: #aaa;
        }

        /* High contrast mode for summary content */
        #gemini-ui-panel.high-contrast .summary-content-wrapper {
          background: #000 !important;
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper * {
          color: #fff !important;
          border-color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper h1,
        #gemini-ui-panel.high-contrast .summary-content-wrapper h2,
        #gemini-ui-panel.high-contrast .summary-content-wrapper h3,
        #gemini-ui-panel.high-contrast .summary-content-wrapper h4,
        #gemini-ui-panel.high-contrast .summary-content-wrapper h5,
        #gemini-ui-panel.high-contrast .summary-content-wrapper h6 {
          color: #ffff00 !important;
          border-color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper a {
          color: #00ff00 !important;
          border-color: #00ff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper code,
        #gemini-ui-panel.high-contrast .summary-content-wrapper pre {
          background: #000 !important;
          color: #ffff00 !important;
          border: 2px solid #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-buttons-container {
          border-top: 2px solid #fff !important;
          background: #000 !important;
        }
        #gemini-ui-panel.high-contrast .annotation-target:hover {
          outline: 2px solid #ffff00 !important;
          background-color: rgba(255, 255, 0, 0.1) !important;
        }
        #gemini-ui-panel.high-contrast .annotation-target.selected {
          outline: 3px solid #ffff00 !important;
          background-color: rgba(255, 255, 0, 0.2) !important;
        }

        /* High contrast mode for tbox elements */
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox {
          background: #000 !important;
          border: 2px solid #fff !important;
          color: #fff !important;
          box-shadow: none !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox::before {
          background: #fff !important;
          border: none !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox-title {
          background: #000 !important;
          color: #fff !important;
          border: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.key-idea .tbox-title {
          background: #000 !important;
          color: #00ffff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.key-idea::before {
          background: #00ffff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.definition .tbox-title {
          background: #000 !important;
          color: #4a63ff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.definition::before {
          background: #4a63ff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.tip .tbox-title {
          background: #000 !important;
          color: #00ff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.tip::before {
          background: #00ff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.example .tbox-title {
          background: #000 !important;
          color: #ffaa00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.example::before {
          background: #ffaa00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.note .tbox-title {
          background: #000 !important;
          color: #ff00ff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.note::before {
          background: #ff00ff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.caution .tbox-title {
          background: #000 !important;
          color: #ff0000 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .tbox.caution::before {
          background: #ff0000 !important;
        }

        /* High contrast mode for tables */
        #gemini-ui-panel.high-contrast .summary-content-wrapper table {
          border: 2px solid #fff !important;
          background: #000 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper th,
        #gemini-ui-panel.high-contrast .summary-content-wrapper td {
          border: 2px solid #fff !important;
          background: #000 !important;
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper th {
          background: #000 !important;
          color: #ffff00 !important;
          font-weight: bold !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper tbody tr:nth-child(odd) td {
          background: #000 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper tbody tr:nth-child(even) td {
          background: #000 !important;
        }

        /* High contrast mode for lecture header */
        #gemini-ui-panel.high-contrast .summary-content-wrapper .lecture-header {
          border-bottom: 2px solid #fff !important;
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .lecture-header .title {
          color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .lecture-header .subtitle {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper .sub-header {
          color: #ffff00 !important;
          border-bottom: 2px solid #fff !important;
        }

        /* High contrast mode for lists */
        #gemini-ui-panel.high-contrast .summary-content-wrapper ul,
        #gemini-ui-panel.high-contrast .summary-content-wrapper ol {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper li {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper li strong,
        #gemini-ui-panel.high-contrast .summary-content-wrapper li b {
          color: #ffff00 !important;
        }

        /* High contrast mode for paragraphs and text */
        #gemini-ui-panel.high-contrast .summary-content-wrapper p {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper p strong,
        #gemini-ui-panel.high-contrast .summary-content-wrapper p b {
          color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper strong,
        #gemini-ui-panel.high-contrast .summary-content-wrapper b {
          color: #ffff00 !important;
        }

        /* High contrast mode for MathJax elements */
        #gemini-ui-panel.high-contrast .summary-content-wrapper mjx-container,
        #gemini-ui-panel.high-contrast .summary-content-wrapper mjx-math,
        #gemini-ui-panel.high-contrast .summary-content-wrapper .MathJax {
          color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .summary-content-wrapper mjx-container svg {
          filter: invert(1) hue-rotate(180deg) brightness(1.5) !important;
        }

        /* Annotation overlay */
        .annotation-overlay {
          position: fixed;
          background: #ffffff;
          border: 1px solid #e0e0e0;
          border-radius: 16px;
          box-shadow: 0 12px 48px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.05);
          padding: 0;
          z-index: 2147483648;
          min-width: 420px;
          max-width: 520px;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          cursor: move;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay {
          background: #000 !important;
          border: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-header {
          color: #fff !important;
          border-bottom: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-close {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-close:hover {
          background: #333 !important;
          color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-context {
          background: #000 !important;
          color: #fff !important;
          border-bottom: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-context strong {
          color: #ffff00 !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-input {
          background: #000 !important;
          color: #fff !important;
          border: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-input:focus {
          border-color: #ffff00 !important;
          box-shadow: 0 0 0 3px rgba(255, 255, 0, 0.3) !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-send {
          background: #000 !important;
          color: #ffff00 !important;
          border: 2px solid #ffff00 !important;
          box-shadow: none !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-send:hover {
          background: #000 !important;
          color: #ffff00 !important;
          border: 3px solid #ffff00 !important;
          transform: none !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-send:disabled {
          background: #000 !important;
          color: #666 !important;
          border: 2px solid #666 !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-response {
          background: #000 !important;
          border-top: 2px solid #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-response > div {
          color: #fff !important;
        }
        #gemini-ui-panel.high-contrast .annotation-overlay-loading {
          color: #fff !important;
        }
        .annotation-overlay-header {
          font-weight: 600;
          font-size: 15px;
          padding: 18px 20px 16px 20px;
          color: #1a1a1a;
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-bottom: 1px solid #f0f0f0;
        }
        .annotation-overlay-close {
          cursor: pointer;
          font-size: 24px;
          color: #999;
          padding: 0;
          border: none;
          background: none;
          line-height: 1;
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 6px;
          transition: all 0.2s;
        }
        .annotation-overlay-close:hover {
          background: #f5f5f5;
          color: #333;
        }
        .annotation-overlay-context {
          background: #f8fafb;
          padding: 14px 20px;
          font-size: 13px;
          color: #444;
          line-height: 1.6;
          border-bottom: 1px solid #f0f0f0;
        }
        .annotation-overlay-context strong {
          display: block;
          margin-bottom: 6px;
          color: #1a1a1a;
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .annotation-overlay-input-group {
          padding: 20px;
        }
        .annotation-overlay-input {
          width: 100%;
          padding: 12px 16px;
          border: 1.5px solid #e0e0e0;
          border-radius: 10px;
          font-size: 14px;
          font-family: inherit;
          margin-bottom: 12px;
          transition: border-color 0.2s;
          box-sizing: border-box;
        }
        .annotation-overlay-input:focus {
          outline: none;
          border-color: #4a63ff;
          box-shadow: 0 0 0 3px rgba(74, 99, 255, 0.1);
        }
        .annotation-overlay-send {
          width: 100%;
          padding: 12px 20px;
          background: linear-gradient(135deg, #4a63ff 0%, #3a53ef 100%);
          color: white;
          border: none;
          border-radius: 10px;
          cursor: pointer;
          font-weight: 600;
          font-size: 14px;
          transition: all 0.2s;
          box-shadow: 0 2px 8px rgba(74, 99, 255, 0.3);
        }
        .annotation-overlay-send:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(74, 99, 255, 0.4);
        }
        .annotation-overlay-send:active {
          transform: translateY(0);
        }
        .annotation-overlay-send:disabled {
          background: #d0d0d0;
          cursor: not-allowed;
          box-shadow: none;
          transform: none;
        }
        .annotation-overlay-response {
          padding: 20px;
          border-top: 1px solid #f0f0f0;
          background: #fafbfc;
          border-radius: 0 0 16px 16px;
        }
        .annotation-overlay-response > div {
          font-size: 14px;
          color: #2c2c2c;
          line-height: 1.7;
          max-height: 280px;
          overflow-y: auto;
        }
        .annotation-overlay-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
          color: #666;
          font-size: 14px;
        }
        .annotation-overlay-loading::before {
          content: '';
          display: inline-block;
          width: 18px;
          height: 18px;
          border: 2.5px solid #e0e0e0;
          border-top-color: #4a63ff;
          border-radius: 50%;
          animation: gemini-spin 0.7s linear infinite;
          margin-right: 10px;
        }

        ${scopedStyles}
        </style>
        <div class="summary-content-wrapper">
          ${bodyContent}
        </div>
        ${buttons}
      `;

      console.log('[Summary HTML] Step 5: Final HTML length:', finalHTML.length);
      console.log('[Summary HTML] Step 5: Final HTML first 800 chars:', finalHTML.substring(0, 800));

      // Inject into chatEl with Base64 decode step
      chatEl.innerHTML = finalHTML;
      chatEl.scrollTop = 0;
      console.log('[Summary HTML] Step 6: HTML injected into chatEl');

      // Update header subtitle to show completion
      updateHeaderSubtitle('HTML Summary Generated');
      console.log('[Summary HTML] Step 6b: Updated header subtitle');

      // Apply custom styling to .tbox elements
      const tboxElements = chatEl.querySelectorAll('.tbox');
      tboxElements.forEach(el => {
        el.style.marginTop = '1.75em';
      });
      console.log('[Summary HTML] Step 6b-2: Applied marginTop to .tbox elements');

      // Initialize annotation system
      initializeAnnotationSystem();
      console.log('[Summary HTML] Step 6c: Initialized annotation system');

      // Load MathJax
      if (!window.MathJax) {
        console.log('[Summary HTML] Step 7: Loading MathJax for first time');
        window.MathJax = {
          tex: {
            inlineMath: [['$', '$'], ['\\(', '\\)']],
            displayMath: [['$$', '$$'], ['\\[', '\\]']]
          },
          startup: {
            ready: () => {
              console.log('[Summary HTML] MathJax ready callback triggered');
              MathJax.startup.defaultReady();
              MathJax.typesetPromise([chatEl]).then(() => {
                console.log('[Summary HTML] MathJax typesetting completed successfully');
              }).catch((err) => console.error('[Summary HTML] MathJax error:', err));
            }
          }
        };

        const script1 = document.createElement('script');
        script1.src = 'https://polyfill.io/v3/polyfill.min.js?features=es6';
        script1.onerror = () => console.warn('[Summary HTML] Polyfill failed to load (CSP blocked)');
        document.head.appendChild(script1);

        const script2 = document.createElement('script');
        script2.src = 'https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js';
        script2.async = true;
        script2.onerror = () => console.warn('[Summary HTML] MathJax failed to load (CSP blocked)');
        document.head.appendChild(script2);
      } else if (window.MathJax.typesetPromise) {
        console.log('[Summary HTML] Step 7: MathJax already loaded, typesetting');
        window.MathJax.typesetPromise([chatEl]).then(() => {
          console.log('[Summary HTML] MathJax typesetting completed');
        }).catch((err) => console.error('[Summary HTML] MathJax error:', err));
      }

      console.log('[Summary HTML] === Processing Complete ===');

      // Add alternative extraction button if it was previously completed
      addAlternativeExtractionButtonIfNeeded();
    }

    function initializeAnnotationSystem() {
      console.log('[Annotation] Initializing annotation system');

      let isShiftPressed = false;
      let currentOverlay = null;
      let selectedElement = null;

      // Track Shift key state
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Shift' && !isShiftPressed) {
          isShiftPressed = true;
          console.log('[Annotation] Shift pressed');
        }
      });

      document.addEventListener('keyup', (e) => {
        if (e.key === 'Shift' && isShiftPressed) {
          isShiftPressed = false;
          console.log('[Annotation] Shift released');
          // Remove all annotation targets when Shift is released
          document.querySelectorAll('.annotation-target').forEach(el => {
            el.classList.remove('annotation-target');
          });
        }
      });

      // Use event delegation on the summary wrapper
      const wrapper = chatEl.querySelector('.summary-content-wrapper');
      if (!wrapper) {
        console.error('[Annotation] Could not find .summary-content-wrapper');
        return;
      }

      // Handle mouseover with event delegation
      wrapper.addEventListener('mouseover', (e) => {
        if (!isShiftPressed) return;

        // Find the closest annotatable element
        let target = e.target;

        // Check if target or any parent is an annotatable element
        while (target && target !== wrapper) {
          const tagName = target.tagName ? target.tagName.toLowerCase() : '';

          // Skip button elements and inputs
          const isNonAnnotatable =
            tagName === 'button' ||
            tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select';

          if (isNonAnnotatable) {
            target = target.parentElement;
            continue;
          }

          // Make any element with text content annotatable
          const hasTextContent = target.textContent && target.textContent.trim().length > 0;
          const isAnnotatable = hasTextContent && tagName !== 'style' && tagName !== 'script';

          if (isAnnotatable) {
            // Remove annotation-target from all other elements
            wrapper.querySelectorAll('.annotation-target').forEach(el => {
              if (el !== target) {
                el.classList.remove('annotation-target');
              }
            });

            // Add to current target
            if (!target.classList.contains('annotation-target')) {
              target.classList.add('annotation-target');
            }
            return;
          }

          target = target.parentElement;
        }
      });

      // Handle mouseout to remove highlight when leaving
      wrapper.addEventListener('mouseout', (e) => {
        if (!isShiftPressed) return;

        // Only remove if we're actually leaving the element
        let target = e.target;
        if (target.classList.contains('annotation-target')) {
          // Check if relatedTarget is not a child
          if (!target.contains(e.relatedTarget)) {
            target.classList.remove('annotation-target');
          }
        }
      });

      // Handle click on annotatable elements
      wrapper.addEventListener('click', (e) => {
        if (!isShiftPressed) return;

        // Find the annotation target
        let target = e.target;
        while (target && target !== wrapper) {
          if (target.classList.contains('annotation-target')) {
            e.preventDefault();
            e.stopPropagation();

            // Mark as selected
            if (selectedElement) {
              selectedElement.classList.remove('selected');
            }
            selectedElement = target;
            target.classList.add('selected');

            // Show overlay
            showAnnotationOverlay(target);
            return;
          }
          target = target.parentElement;
        }
      });

      function showAnnotationOverlay(element) {
        console.log('[Annotation] Showing overlay for element:', element);

        // Remove existing overlay if any
        if (currentOverlay) {
          currentOverlay.remove();
        }

        // Get element context (text content)
        const selectedText = element.textContent.trim();
        const selectedPreview = selectedText.length > 180 ? selectedText.substring(0, 180) + '...' : selectedText;

        // Get full summary context
        const fullContext = wrapper.textContent.trim();

        // Create overlay
        const overlay = document.createElement('div');
        overlay.className = 'annotation-overlay';
        overlay.innerHTML = `
          <div class="annotation-overlay-header">
            <span>Ask a question</span>
            <button class="annotation-overlay-close">&times;</button>
          </div>
          <div class="annotation-overlay-context">
            <strong>Selected text:</strong>
            ${selectedPreview}
          </div>
          <div class="annotation-overlay-input-group">
            <input type="text" class="annotation-overlay-input" placeholder="What would you like to know about this?">
            <button class="annotation-overlay-send">Ask</button>
          </div>
          <div class="annotation-overlay-response"></div>
        `;

        // Store context on overlay element for use in handleQuestion
        overlay.dataset.selectedText = selectedText;
        overlay.dataset.fullContext = fullContext;

        document.body.appendChild(overlay);
        currentOverlay = overlay;

        // Position overlay near the element but ensure it stays on screen
        const rect = element.getBoundingClientRect();
        const overlayRect = overlay.getBoundingClientRect();

        let top = rect.bottom + window.scrollY + 10;
        let left = rect.left + window.scrollX;

        // Keep overlay on screen
        if (left + overlayRect.width > window.innerWidth) {
          left = window.innerWidth - overlayRect.width - 20;
        }
        if (left < 20) {
          left = 20;
        }
        if (top + overlayRect.height > window.innerHeight + window.scrollY) {
          top = rect.top + window.scrollY - overlayRect.height - 10;
        }

        overlay.style.top = top + 'px';
        overlay.style.left = left + 'px';

        // Make overlay draggable from anywhere
        let isDragging = false;
        let dragOffsetX = 0;
        let dragOffsetY = 0;

        overlay.addEventListener('mousedown', (e) => {
          // Don't drag if clicking on input, button, or close button
          if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.annotation-overlay-close')) {
            return;
          }

          isDragging = true;
          dragOffsetX = e.clientX - overlay.offsetLeft;
          dragOffsetY = e.clientY - overlay.offsetTop;
          overlay.style.cursor = 'grabbing';
          e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
          if (!isDragging) return;

          const newLeft = e.clientX - dragOffsetX;
          const newTop = e.clientY - dragOffsetY;

          // Keep within viewport bounds
          const maxLeft = window.innerWidth - overlay.offsetWidth;
          const maxTop = window.innerHeight - overlay.offsetHeight;

          overlay.style.left = Math.max(0, Math.min(newLeft, maxLeft)) + 'px';
          overlay.style.top = Math.max(0, Math.min(newTop, maxTop)) + 'px';
        });

        document.addEventListener('mouseup', () => {
          if (isDragging) {
            isDragging = false;
            overlay.style.cursor = 'move';
          }
        });

        // Focus input
        const input = overlay.querySelector('.annotation-overlay-input');
        input.focus();

        // Handle close button
        overlay.querySelector('.annotation-overlay-close').addEventListener('click', () => {
          closeOverlay();
        });

        // Handle send button
        const sendBtn = overlay.querySelector('.annotation-overlay-send');
        sendBtn.addEventListener('click', () => {
          handleQuestion(input.value, overlay);
        });

        // Handle Enter key
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleQuestion(input.value, overlay);
          }
        });

        // Close on Escape
        document.addEventListener('keydown', handleEscapeKey);
      }

      function handleEscapeKey(e) {
        if (e.key === 'Escape') {
          closeOverlay();
        }
      }

      function closeOverlay() {
        if (currentOverlay) {
          currentOverlay.remove();
          currentOverlay = null;
        }
        if (selectedElement) {
          selectedElement.classList.remove('selected');
          selectedElement = null;
        }
        document.removeEventListener('keydown', handleEscapeKey);
      }

      async function handleQuestion(question, overlay) {
        if (!question || !question.trim()) {
          return;
        }

        console.log('[Annotation] Handling question:', question);

        const responseArea = overlay.querySelector('.annotation-overlay-response');
        const input = overlay.querySelector('.annotation-overlay-input');
        const sendBtn = overlay.querySelector('.annotation-overlay-send');

        // Get context from overlay dataset
        const selectedText = overlay.dataset.selectedText;
        const fullContext = overlay.dataset.fullContext;

        // Hide input group and show loading
        const inputGroup = overlay.querySelector('.annotation-overlay-input-group');
        inputGroup.style.display = 'none';
        responseArea.innerHTML = '<div class="annotation-overlay-loading">Thinking...</div>';

        // Set suppressIntercept to prevent chat UI from showing "thinking"
        const prevSuppress = suppressIntercept;
        suppressIntercept = true;

        try {
          // Prepare the prompt - selected text first, then full context

          // Call Gemini API using originalFetchForAI to bypass interceptor
          const response = await proxiedFetchForAI(`https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.7
              }
            })
          });

          if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
          }

          const data = await response.json();
          const answer = data.candidates[0].content.parts[0].text;

          // Display response with markdown and LaTeX formatting
          const formattedAnswer = renderMarkdown(answer);
          responseArea.innerHTML = `<div>${formattedAnswer}</div>`;

          // Typeset LaTeX if present
          await typesetEl(responseArea);

          console.log('[Annotation] Response received and displayed');

        } catch (error) {
          console.error('[Annotation] Error calling Gemini API:', error);
          responseArea.innerHTML = `<div style="color: #e53935; padding: 16px; text-align: center;">Error: ${error.message}</div>`;
          // Show input group again on error
          inputGroup.style.display = 'block';
        } finally {
          suppressIntercept = prevSuppress;
        }
      }

      // Text selection popup functionality
      let clarifyPopup = null;

      wrapper.addEventListener('mouseup', (e) => {
        // Small delay to ensure selection is complete
        setTimeout(() => {
          const selection = window.getSelection();
          const selectedText = selection.toString().trim();

          // Remove existing popup
          if (clarifyPopup) {
            clarifyPopup.remove();
            clarifyPopup = null;
          }

          // Only show popup if text is selected and it's within the wrapper
          if (selectedText.length > 0 && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const container = range.commonAncestorContainer;

            // Check if selection is within wrapper
            let node = container.nodeType === 3 ? container.parentNode : container;
            let isWithinWrapper = false;
            while (node) {
              if (node === wrapper) {
                isWithinWrapper = true;
                break;
              }
              node = node.parentNode;
            }

            if (!isWithinWrapper) return;

            // Create clarify popup with both buttons
            const popup = document.createElement('div');
            popup.className = 'clarify-popup';
            popup.style.cssText = `
              position: absolute;
              z-index: 2147483647;
              display: flex;
              gap: 8px;
            `;

            // Create Clarify button
            const clarifyBtn = document.createElement('button');
            clarifyBtn.className = 'clarify-btn';
            clarifyBtn.innerHTML = '✨ Clarify';
            clarifyBtn.style.cssText = `
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 8px 16px;
              border: none;
              border-radius: 12px;
              font-size: 13px;
              font-weight: 700;
              cursor: pointer;
              box-shadow: 0 4px 16px rgba(102, 126, 234, 0.5), 0 2px 8px rgba(0, 0, 0, 0.2);
              transition: all 0.2s;
              letter-spacing: 0.3px;
            `;

            // Create Speak button
            const speakBtn = document.createElement('button');
            speakBtn.className = 'speak-btn';
            speakBtn.innerHTML = '🔊 Speak';
            speakBtn.style.cssText = `
              background: linear-gradient(135deg, #4a63ff 0%, #3a53ef 100%);
              color: white;
              padding: 8px 16px;
              border: none;
              border-radius: 12px;
              font-size: 13px;
              font-weight: 700;
              cursor: pointer;
              box-shadow: 0 4px 16px rgba(74, 99, 255, 0.5), 0 2px 8px rgba(0, 0, 0, 0.2);
              transition: all 0.2s;
              letter-spacing: 0.3px;
            `;

            popup.appendChild(clarifyBtn);
            popup.appendChild(speakBtn);

            // Position popup above selection
            const rect = range.getBoundingClientRect();
            const popupTop = rect.top + window.scrollY - 40;
            const popupLeft = rect.left + window.scrollX + (rect.width / 2) - 90; // Adjusted for two buttons

            popup.style.top = popupTop + 'px';
            popup.style.left = popupLeft + 'px';

            document.body.appendChild(popup);
            clarifyPopup = popup;

            // Handle hover effect for Clarify button
            clarifyBtn.addEventListener('mouseenter', () => {
              clarifyBtn.style.transform = 'translateY(-2px) scale(1.05)';
              clarifyBtn.style.boxShadow = '0 6px 20px rgba(102, 126, 234, 0.6), 0 3px 10px rgba(0, 0, 0, 0.25)';
            });

            clarifyBtn.addEventListener('mouseleave', () => {
              clarifyBtn.style.transform = 'translateY(0) scale(1)';
              clarifyBtn.style.boxShadow = '0 4px 16px rgba(102, 126, 234, 0.5), 0 2px 8px rgba(0, 0, 0, 0.2)';
            });

            // Handle hover effect for Speak button
            speakBtn.addEventListener('mouseenter', () => {
              speakBtn.style.transform = 'translateY(-2px) scale(1.05)';
              speakBtn.style.boxShadow = '0 6px 20px rgba(74, 99, 255, 0.6), 0 3px 10px rgba(0, 0, 0, 0.25)';
            });

            speakBtn.addEventListener('mouseleave', () => {
              speakBtn.style.transform = 'translateY(0) scale(1)';
              speakBtn.style.boxShadow = '0 4px 16px rgba(74, 99, 255, 0.5), 0 2px 8px rgba(0, 0, 0, 0.2)';
            });

            // Handle Speak button click
            speakBtn.addEventListener('click', async (e) => {
              e.preventDefault();
              e.stopPropagation();

              // Remove the popup
              popup.remove();
              clarifyPopup = null;

              // Generate TTS for selected text
              await generateSelectedTextTTS(selectedText);
            });

            // Handle Clarify button click
            clarifyBtn.addEventListener('click', () => {
              // Remove the popup
              popup.remove();
              clarifyPopup = null;

              // Get full context
              const fullContext = wrapper.textContent.trim();

              // Create and show overlay with the selected text
              const overlay = document.createElement('div');
              overlay.className = 'annotation-overlay';
              overlay.innerHTML = `
                <div class="annotation-overlay-header">
                  <span>Ask a question</span>
                  <button class="annotation-overlay-close">&times;</button>
                </div>
                <div class="annotation-overlay-context">
                  <strong>Selected text:</strong>
                  ${selectedText.length > 180 ? selectedText.substring(0, 180) + '...' : selectedText}
                </div>
                <div class="annotation-overlay-input-group">
                  <input type="text" class="annotation-overlay-input" placeholder="What would you like to know about this?">
                  <button class="annotation-overlay-send">Ask</button>
                </div>
                <div class="annotation-overlay-response"></div>
              `;

              // Store context
              overlay.dataset.selectedText = selectedText;
              overlay.dataset.fullContext = fullContext;

              document.body.appendChild(overlay);

              // Remove old overlay if exists
              if (currentOverlay) {
                currentOverlay.remove();
              }
              currentOverlay = overlay;

              // Position overlay - ensure it stays within viewport
              const overlayRect = overlay.getBoundingClientRect();
              let top = rect.bottom + window.scrollY + 10;
              let left = rect.left + window.scrollX;

              // Adjust horizontal position
              if (left + overlayRect.width > window.innerWidth) {
                left = window.innerWidth - overlayRect.width - 20;
              }
              if (left < 20) {
                left = 20;
              }

              // Adjust vertical position - prefer below, but go above if not enough space
              const spaceBelow = window.innerHeight - rect.bottom;
              const spaceAbove = rect.top;

              if (spaceBelow < overlayRect.height + 20 && spaceAbove > overlayRect.height + 20) {
                // Not enough space below but enough above - position above
                top = rect.top + window.scrollY - overlayRect.height - 10;
              } else if (spaceBelow < overlayRect.height + 20) {
                // Not enough space below or above - position at top of viewport with some padding
                top = window.scrollY + 20;
              }

              // Ensure overlay doesn't go above viewport
              if (top < window.scrollY + 20) {
                top = window.scrollY + 20;
              }

              overlay.style.top = top + 'px';
              overlay.style.left = left + 'px';

              // Make draggable
              let isDragging = false;
              let dragOffsetX = 0;
              let dragOffsetY = 0;

              overlay.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('.annotation-overlay-close')) {
                  return;
                }
                isDragging = true;
                dragOffsetX = e.clientX - overlay.getBoundingClientRect().left;
                dragOffsetY = e.clientY - overlay.getBoundingClientRect().top;
                e.preventDefault();
              });

              document.addEventListener('mousemove', (e) => {
                if (isDragging && currentOverlay === overlay) {
                  overlay.style.left = (e.clientX - dragOffsetX) + 'px';
                  overlay.style.top = (e.clientY - dragOffsetY) + 'px';
                }
              });

              document.addEventListener('mouseup', () => {
                isDragging = false;
              });

              // Setup close button
              overlay.querySelector('.annotation-overlay-close').addEventListener('click', () => {
                overlay.remove();
                if (currentOverlay === overlay) {
                  currentOverlay = null;
                }
                if (selectedElement) {
                  selectedElement.classList.remove('selected');
                  selectedElement = null;
                }
              });

              // Setup send button and input
              const input = overlay.querySelector('.annotation-overlay-input');
              const sendBtn = overlay.querySelector('.annotation-overlay-send');

              const handleQuestion = async () => {
                const question = input.value.trim();
                if (!question) return;

                sendBtn.disabled = true;
                const responseArea = overlay.querySelector('.annotation-overlay-response');
                const inputGroup = overlay.querySelector('.annotation-overlay-input-group');
                inputGroup.style.display = 'none';
                responseArea.innerHTML = '<div class="annotation-overlay-loading">Thinking...</div>';

                const prevSuppress = suppressIntercept;
                suppressIntercept = true;

                try {
                  // Fetch summary explainer prompt from backend
                  const selectedText = overlay.dataset.selectedText;
                  const fullContext = overlay.dataset.fullContext;

                  console.log('[Summary Explainer] Fetching prompt from backend');
                  const promptResponse = await fetch('http://localhost:5000/api/prompts/summary-explainer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      selectedText: selectedText,
                      question: question,
                      fullContext: fullContext
                    })
                  });
                  const promptData = await promptResponse.json();
                  const prompt = promptData.prompt;

                  const response = await proxiedFetchForAI(`https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      contents: [{ parts: [{ text: prompt }] }],
                      generationConfig: { temperature: 0.7 }
                    })
                  });

                  if (!response.ok) {
                    throw new Error(`API request failed: ${response.status}`);
                  }

                  const data = await response.json();
                  const answer = data.candidates[0].content.parts[0].text;
                  const formattedAnswer = renderMarkdown(answer);
                  responseArea.innerHTML = `<div>${formattedAnswer}</div>`;
                  await typesetEl(responseArea);
                } catch (error) {
                  console.error('[Annotation] Error:', error);
                  responseArea.innerHTML = `<div style="color: #e53935; padding: 16px; text-align: center;">Error: ${error.message}</div>`;
                  inputGroup.style.display = 'block';
                } finally {
                  suppressIntercept = prevSuppress;
                }
              };

              sendBtn.addEventListener('click', handleQuestion);
              input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleQuestion();
                }
              });

              input.focus();

              // Clear selection
              window.getSelection().removeAllRanges();
            });
          }
        }, 10);
      });

      // Remove popup when clicking elsewhere
      document.addEventListener('mousedown', (e) => {
        if (clarifyPopup && !clarifyPopup.contains(e.target)) {
          clarifyPopup.remove();
          clarifyPopup = null;
        }
      });

      console.log('[Annotation] System initialized successfully');
    }

    window.saveSummaryAsPdf = async function() {
      console.log('[Save PDF] Opening new tab');
      const newTab = window.open('', '_blank');

      const wrapper = chatEl.querySelector('.summary-content-wrapper');
      let htmlContent = wrapper ? wrapper.innerHTML : '';

      // Remove any toggle icons or UI elements that shouldn't be in the view
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = htmlContent;

      // Remove common UI elements that shouldn't be shown
      const elementsToRemove = tempDiv.querySelectorAll('#gemini-toggle, .gemini-toggle, [id*="toggle"], [class*="toggle"]');
      elementsToRemove.forEach(el => el.remove());

      htmlContent = tempDiv.innerHTML;
      console.log('[Save PDF] Cleaned HTML content');

      // Extract original styles and Font Awesome link
      let styles = '';
      const styleMatches = summaryHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
      if (styleMatches) {
        styleMatches.forEach(styleTag => {
          styles += styleTag.replace(/<\/?style[^>]*>/gi, '') + '\n';
        });
      }

      // Extract Font Awesome link
      let fontAwesomeLink = '';
      const linkMatch = summaryHtml.match(/<link[^>]*fontawesome[^>]*>/i);
      if (linkMatch) {
        fontAwesomeLink = linkMatch[0];
      }

      newTab.document.write(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Lecture Summary</title>

          ${fontAwesomeLink}

          <script src="https://polyfill.io/v3/polyfill.min.js?features=es6"></script>
          <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
          <script>
            window.MathJax = {
              tex: {
                inlineMath: [['$', '$'], ['\\\\(', '\\\\)']],
                displayMath: [['$$', '$$'], ['\\\\[', '\\\\]']]
              },
              startup: {
                ready: () => {
                  MathJax.startup.defaultReady();
                  MathJax.typesetPromise();
                }
              }
            };
          </script>
          <style>
            * {
              box-sizing: border-box;
            }

            html {
              margin: 0;
              padding: 0;
              background: #e0e0e0;
            }

            body {
              margin: 0;
              padding: 0;
              background: #e0e0e0;
            }

            .page-wrapper {
              background: white;
              max-width: 210mm;
              min-height: calc(100vh - 60px);
              margin: 30px auto;
              padding: 30mm 20mm 25mm 20mm;
              box-shadow: 0 0 20px rgba(0,0,0,0.2);
            }

            /* A4 page dimensions for printing */
            @page {
              size: A4 portrait;
              margin: 20mm 15mm;
            }

            /* Print styles */
            @media print {
              html {
                background: white;
              }

              body {
                background: white;
              }

              .page-wrapper {
                max-width: 100%;
                margin: 0;
                padding: 0;
                box-shadow: none;
                min-height: auto;
              }

              /* Prevent page breaks inside boxes */
              .tbox {
                page-break-inside: avoid;
                break-inside: avoid;
              }

              /* Hide any remaining UI elements */
              #gemini-toggle,
              .gemini-toggle,
              [id*="toggle"],
              [class*="toggle"] {
                display: none !important;
              }
            }

            /* Content styles */
            ${styles}
          </style>
        </head>
        <body>
          <div class="page-wrapper">
            ${htmlContent}
          </div>
        </body>
        </html>
      `);
      newTab.document.close();
      console.log('[Save PDF] New tab populated');
    };

    function showSummaryOverleafOptions() {
      // Clear countdown interval
      if (summaryCountdownInterval) {
        clearInterval(summaryCountdownInterval);
        summaryCountdownInterval = null;
        summaryCountdownStartTime = null;
        summaryCountdownPhase = 1;
      }

      saveChatBeforeClearing();
      // Reset button text
      summaryBtn.textContent = 'Summary';

      summaryOptionsShown = true;
      chatEl.innerHTML = '';
      controlsEl.style.display = 'none';
      inputRowEl.style.display = 'none';
      attEl.style.display = 'none';

      const container = document.createElement('div');
      container.className = 'quiz-generating';

      // Check if repair is in progress or repaired version exists and show appropriate buttons
      let buttonsHtml;
      if (summaryRepairing) {
        // Repair is in progress
        buttonsHtml = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(false); hideSummaryOverleafOptions();" style="width: 200px;">🌱 Open in Overleaf</button>
          <button class="flashcard-btn flashcard-btn-overleaf summary-repair-btn" disabled style="width: 200px;">⏳ Repairing...</button>
        `;
      } else if (repairedSummaryLatex) {
        // Repair is complete
        buttonsHtml = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(false); hideSummaryOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf summary-repair-btn" onclick="repairSummaryLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(true); hideSummaryOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      } else {
        // No repair yet
        buttonsHtml = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(false); hideSummaryOverleafOptions();" style="width: 200px;">🌱 Open in Overleaf</button>
          <button class="flashcard-btn flashcard-btn-overleaf summary-repair-btn" onclick="repairSummaryLatex();" style="width: 200px;">🛠️ Repair LaTeX</button>
        `;
      }

      // Image controls (only show if images were included) - both boxes side by side
      const imageControlsHtml = summaryHasImages ? `
        <div style="margin-top: 20px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
          ${lastUsedExtractionMethod ? `
            <div style="flex: 1; min-width: 250px; max-width: 400px; padding: 12px; background: #fff3e0; border: 1px solid #ffb74d; border-radius: 8px;">
              <div style="font-size: 13px; color: #666; margin-bottom: 8px; text-align: center;">
                ${lastUsedExtractionMethod === 'backend'
                  ? 'Extracted using Object Detection'
                  : 'Extracted using Machine Learning'}
              </div>
              <button class="flashcard-btn flashcard-btn-primary" onclick="extractWithAlternativeMethod()" style="width: 100%;">
                ${lastUsedExtractionMethod === 'backend'
                  ? '☁️ Use Machine Learning Instead (not recommended)'
                  : '⚡ Use Object Detection Instead (not recommended)'}
              </button>
            </div>
          ` : ''}
          <div style="flex: 1; min-width: 200px; max-width: 300px; padding: 12px; background: #f5f5f5; border-radius: 8px;">
            <div style="font-size: 13px; color: #666; margin-bottom: 8px; text-align: center;">Image Size</div>
            <div style="display: flex; align-items: center; justify-content: center; gap: 12px;">
              <button class="flashcard-btn" onclick="adjustImageSize(-0.1)" style="width: 40px; padding: 8px;">−</button>
              <span id="image-size-display" style="font-size: 14px; font-weight: 600; min-width: 60px; text-align: center;">${Math.round(imageSizeMultiplier * 100)}%</span>
              <button class="flashcard-btn" onclick="adjustImageSize(0.1)" style="width: 40px; padding: 8px;">+</button>
            </div>
          </div>
        </div>
      ` : '';

      container.innerHTML = `
        <div class="quiz-gen-text">✅ Summary Generated!</div>
        <div class="quiz-gen-subtext">Your LaTeX summary is ready</div>
        <div class="overleaf-options-buttons" style="display: flex; flex-direction: column; gap: 12px; margin-top: 24px; align-items: center;">
          ${buttonsHtml}
        </div>
        ${imageControlsHtml}
        <div style="margin-top: 16px;">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; color: #666;">
            <input type="checkbox" id="summary-auto-open" ${summaryOptionsShown ? '' : 'checked'}>
            <span>Auto-open in Overleaf next time</span>
          </label>
        </div>
        <button class="flashcard-btn" onclick="exitSummaryMode()" style="margin-top: 16px;">Done</button>
      `;
      chatEl.appendChild(container);

      // Add alternative extraction button if it was previously completed
      addAlternativeExtractionButtonIfNeeded();
    }

    // Function to save current summary to version storage
    function saveCurrentSummaryToVersion(method) {
      console.log(`[Summary Versions] ========== SAVING TO ${method.toUpperCase()} VERSION ==========`);
      console.log(`[Summary Versions] summaryLatex:`, !!summaryLatex, summaryLatex ? `${summaryLatex.length} chars` : 'null');
      console.log(`[Summary Versions] summaryHtml:`, !!summaryHtml, summaryHtml ? `${summaryHtml.length} chars` : 'null');

      // Get extracted markdown from the appropriate cache based on method
      const extractedMarkdown = method === 'backend' ? extractedMarkdownBackend : extractedMarkdownMineru;
      console.log(`[Summary Versions] extractedMarkdown (${method}):`, !!extractedMarkdown);

      summaryVersions[method] = {
        latex: summaryLatex,
        latexOriginal: summaryLatexOriginal,
        latexWithUrls: summaryLatexWithUrls,
        html: summaryHtml,
        htmlOriginal: summaryHtmlOriginal,
        htmlWithUrls: summaryHtmlWithUrls,
        extractedMarkdown: extractedMarkdown
      };

      currentlyDisplayedVersion = method;
      console.log(`[Summary Versions] ✓ Saved to ${method}`);
      console.log(`[Summary Versions] ✓ currentlyDisplayedVersion is now: ${currentlyDisplayedVersion}`);
      console.log(`[Summary Versions] ✓ Verification - ${method} has latex:`, !!summaryVersions[method].latex);
      console.log(`[Summary Versions] ✓ Verification - ${method} has html:`, !!summaryVersions[method].html);
    }

    // Function to load summary from version storage
    function loadSummaryFromVersion(method) {
      console.log(`[Summary Versions] Loading summary from ${method} version`);

      const version = summaryVersions[method];

      // Debug logging
      console.log(`[Summary Versions] version exists:`, !!version);
      if (version) {
        console.log(`[Summary Versions] version.latex:`, !!version.latex, version.latex ? `${version.latex.length} chars` : 'null');
        console.log(`[Summary Versions] version.html:`, !!version.html, version.html ? `${version.html.length} chars` : 'null');
        console.log(`[Summary Versions] version.extractedMarkdown:`, !!version.extractedMarkdown);
      }

      if (!version || (!version.latex && !version.html)) {
        console.error(`[Summary Versions] ✗ No ${method} version available`);
        console.error(`[Summary Versions] version:`, version);
        console.error(`[Summary Versions] All versions:`, {
          backend: {
            hasLatex: !!summaryVersions.backend.latex,
            hasHtml: !!summaryVersions.backend.html
          },
          mineru: {
            hasLatex: !!summaryVersions.mineru.latex,
            hasHtml: !!summaryVersions.mineru.html
          }
        });
        return false;
      }

      summaryLatex = version.latex;
      summaryLatexOriginal = version.latexOriginal;
      summaryLatexWithUrls = version.latexWithUrls;
      summaryHtml = version.html;
      summaryHtmlOriginal = version.htmlOriginal;
      summaryHtmlWithUrls = version.htmlWithUrls;

      // Restore extracted markdown to the appropriate cache based on method
      if (method === 'backend') {
        extractedMarkdownBackend = version.extractedMarkdown;
      } else {
        extractedMarkdownMineru = version.extractedMarkdown;
      }

      currentlyDisplayedVersion = method;
      console.log(`[Summary Versions] ✓ Loaded from ${method}, currently displaying: ${currentlyDisplayedVersion}`);
      return true;
    }

    // Function to switch to the other extraction method's summary
    window.switchToAlternativeVersion = function() {
      console.log('========== SWITCHING TO ALTERNATIVE VERSION ==========');
      console.log('[Summary Versions] Currently displaying:', currentlyDisplayedVersion);
      console.log('[Summary Versions] lastUsedExtractionMethod:', lastUsedExtractionMethod);
      console.log('[Summary Versions] summaryFormat:', summaryFormat);

      // Determine which version to switch to
      const targetVersion = currentlyDisplayedVersion === 'backend' ? 'mineru' : 'backend';

      console.log('[Summary Versions] Target version to switch to:', targetVersion);
      console.log('[Summary Versions] Available versions:', {
        backend: {
          latex: !!summaryVersions.backend.latex,
          html: !!summaryVersions.backend.html,
          extractedMarkdown: !!summaryVersions.backend.extractedMarkdown
        },
        mineru: {
          latex: !!summaryVersions.mineru.latex,
          html: !!summaryVersions.mineru.html,
          extractedMarkdown: !!summaryVersions.mineru.extractedMarkdown
        }
      });

      // Load the other version
      if (loadSummaryFromVersion(targetVersion)) {
        console.log('[Summary Versions] ✓ Version loaded successfully');

        // Update lastUsedExtractionMethod to match the loaded version
        lastUsedExtractionMethod = targetVersion;
        console.log('[Summary Versions] Updated lastUsedExtractionMethod to:', lastUsedExtractionMethod);

        // Re-display the summary
        if (summaryFormat === 'latex') {
          console.log('[Summary Versions] Re-displaying LaTeX summary');
          showSummaryOverleafOptions();
        } else {
          console.log('[Summary Versions] Re-displaying HTML summary');
          showSummaryHtmlResult();
        }

        console.log('[Summary Versions] ✓ Successfully switched to', targetVersion);
      } else {
        console.error('[Summary Versions] ✗ Failed to load alternative version');
        alert('Alternative version not available. Check console for details.');
      }
    };

    // Helper function to add alternative extraction button dynamically
    function addAlternativeExtractionButtonIfNeeded() {
      console.log('[Alternative Extraction Button] ========== ADD BUTTON CHECK ==========');
      console.log('[Alternative Extraction Button] alternativeExtractionCompleted:', alternativeExtractionCompleted);
      console.log('[Alternative Extraction Button] Button already exists:', !!document.querySelector('.alt-extraction-btn'));

      // Only add button if alternative extraction was completed and button doesn't already exist
      if (!alternativeExtractionCompleted || document.querySelector('.alt-extraction-btn')) {
        console.log('[Alternative Extraction Button] Skipping button addition');
        return;
      }

      setTimeout(() => {
        console.log('[Alternative Extraction Button] ========== ADDING BUTTON ==========');
        console.log('[Alternative Extraction Button] currentlyDisplayedVersion:', currentlyDisplayedVersion);
        console.log('[Alternative Extraction Button] summaryFormat:', summaryFormat);

        // Determine which method to show button for (the opposite of currently displayed)
        const otherMethod = currentlyDisplayedVersion === 'backend' ? 'mineru' : 'backend';
        const buttonText = otherMethod === 'backend'
          ? '⚡ Switch to Object Detection Version'
          : '☁️ Switch to Machine Learning Version';

        console.log('[Alternative Extraction Button] Other method (to switch TO):', otherMethod);
        console.log('[Alternative Extraction Button] Button text:', buttonText);

        if (summaryFormat === 'latex') {
          // For LaTeX: look for repair button using class name
          const repairBtn = document.querySelector('.summary-repair-btn');

          if (repairBtn && !document.querySelector('.alt-extraction-btn')) {
            const newBtn = document.createElement('button');
            newBtn.className = 'flashcard-btn flashcard-btn-overleaf alt-extraction-btn';
            newBtn.style.cssText = 'width: 200px;';
            newBtn.textContent = buttonText;
            newBtn.onclick = () => switchToAlternativeVersion();

            // Insert after the repair button
            repairBtn.insertAdjacentElement('afterend', newBtn);

            console.log('[Alternative Extraction Button] ✓ Added button to LaTeX summary screen');
          }
        } else {
          // For HTML: look for the "Open in a new tab" button
          const openTabBtn = document.querySelector('button[onclick="saveSummaryAsPdf()"]');

          if (openTabBtn && !document.querySelector('.alt-extraction-btn')) {
            const newBtn = document.createElement('button');
            newBtn.className = 'flashcard-btn flashcard-btn-primary alt-extraction-btn';
            newBtn.style.cssText = 'padding: 10px 24px; margin-right: 12px;';
            newBtn.textContent = buttonText;
            newBtn.onclick = () => switchToAlternativeVersion();

            // Insert before the "Open in a new tab" button
            openTabBtn.insertAdjacentElement('beforebegin', newBtn);

            console.log('[Alternative Extraction Button] ✓ Added button to HTML summary screen');
          }
        }
      }, 100);
    }

    window.hideSummaryOverleafOptions = function() {
      summaryOptionsShown = false;
      restoreSavedChatContent();
      controlsEl.style.display = '';
      inputRowEl.style.display = '';
      attEl.style.display = '';
      summaryBtn.style.display = '';
      updateHeaderSubtitle('Ask about this slide');
    };

    window.exitSummaryMode = function() {
      // Stop any playing audio
      if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
      }

      // Remove audio controls if present
      if (audioControlsContainer) {
        audioControlsContainer.remove();
        audioControlsContainer = null;
      }

      hideSummaryOverleafOptions();
    };

    window.extractWithAlternativeMethod = async function() {
      // Determine which method to use (opposite of the one used last time)
      const newMethod = lastUsedExtractionMethod === 'backend' ? 'mineru' : 'backend';

      console.log(`[Alternative Extraction] User requested alternative extraction method: ${newMethod}`);
      console.log(`[Alternative Extraction] Previous method was: ${lastUsedExtractionMethod}`);

      // Validate requirements
      if (newMethod === 'mineru' && !SLIDES_PDF_URL) {
        alert('Cannot use Machine Learning extraction: No PDF URL available.\n\nMachine Learning extraction requires a hosted PDF URL. Please provide a PDF URL instead of manually uploading the file.');
        return;
      }

      // Confirm with user
      const methodName = newMethod === 'backend' ? 'Object Detection' : 'Machine Learning';
      const confirmMessage = `Extract images using ${methodName} instead?\n\nThis will re-extract the images and regenerate the summary.`;

      if (!confirm(confirmMessage)) {
        return;
      }

      try {
        // FIRST: Save the current summary to version storage BEFORE we overwrite it
        console.log('[Alternative Extraction] Saving current summary before starting alternative extraction');
        if (lastUsedExtractionMethod) {
          saveCurrentSummaryToVersion(lastUsedExtractionMethod);
          console.log('[Alternative Extraction] ✓ Saved current version:', lastUsedExtractionMethod);
        }

        // Mark that we're doing alternative extraction
        // Note: includeImages will be automatically set to true in startSummaryGeneration()
        // because we set isAlternativeExtraction flag
        isAlternativeExtraction = true;

        // Disable buttons on current screen to prevent interaction during processing
        const allButtons = document.querySelectorAll('.flashcard-btn, .quiz-gen-stop');
        allButtons.forEach(btn => {
          btn.disabled = true;
          btn.style.opacity = '0.5';
        });

        // Show loading message on current screen
        const subtitle = document.querySelector('.quiz-gen-subtext');
        const originalSubtitle = subtitle ? subtitle.textContent : '';
        if (subtitle) {
          subtitle.textContent = `Extracting with ${methodName}... Please wait.`;
        }

        console.log('[Alternative Extraction] Starting extraction with', methodName);

        let extractedMarkdown;

        // Get PDF blob for backend extraction
        let pdfBlob = cachedPdfBlob;
        if (!pdfBlob && SLIDES_PDF_URL) {
          console.log('[Alternative Extraction] Fetching PDF for extraction...');
          pdfBlob = await fetchAsBlob(SLIDES_PDF_URL, "application/pdf");
        }

        // Execute extraction based on selected method
        if (newMethod === 'backend') {
          console.log('[Alternative Extraction] Using OBJECT DETECTION extraction');

          if (!pdfBlob) {
            throw new Error('No PDF available for backend extraction');
          }

          extractedMarkdown = await extractImagesLocally(pdfBlob);
        } else {
          console.log('[Alternative Extraction] Using MACHINE LEARNING extraction');

          if (!SLIDES_PDF_URL) {
            throw new Error('Machine Learning extraction requires a PDF URL but none was provided');
          }

          extractedMarkdown = await extractImagesFromPdf(SLIDES_PDF_URL);
        }

        // Update cached content and method
        if (newMethod === 'backend') {
          extractedMarkdownBackend = extractedMarkdown;
        } else {
          extractedMarkdownMineru = extractedMarkdown;
        }
        lastUsedExtractionMethod = newMethod;

        console.log('[Alternative Extraction] ✓ Extraction complete, generating summary...');
        if (subtitle) {
          subtitle.textContent = 'Generating summary with new images... Please wait.';
        }

        // Generate the summary silently in background (don't show generating UI)
        suppressIntercept = true;
        summaryGeneratingInBackground = true;
        summaryGenerating = true;

        try {
          // Call the full summary generation but it won't show UI because of background flag
          await startSummaryGeneration();

          console.log('[Alternative Extraction] ✓ Summary generation complete');
          console.log('[Alternative Extraction] lastUsedExtractionMethod:', lastUsedExtractionMethod);
          console.log('[Alternative Extraction] currentlyDisplayedVersion:', currentlyDisplayedVersion);

          // CRITICAL: Ensure the new version is saved and currentlyDisplayedVersion is set
          // This is a safety net in case startSummaryGeneration didn't do it
          if (lastUsedExtractionMethod && currentlyDisplayedVersion !== lastUsedExtractionMethod) {
            console.warn('[Alternative Extraction] currentlyDisplayedVersion mismatch, forcing save');
            saveCurrentSummaryToVersion(lastUsedExtractionMethod);
          }

          console.log('[Alternative Extraction] After safety save - currentlyDisplayedVersion:', currentlyDisplayedVersion);
          console.log('[Alternative Extraction] summaryVersions.backend exists:', !!summaryVersions.backend.latex || !!summaryVersions.backend.html);
          console.log('[Alternative Extraction] summaryVersions.mineru exists:', !!summaryVersions.mineru.latex || !!summaryVersions.mineru.html);

          // Re-enable buttons
          allButtons.forEach(btn => {
            btn.disabled = false;
            btn.style.opacity = '1';
          });

          // Restore subtitle
          if (subtitle) {
            subtitle.textContent = originalSubtitle;
          }

          // Reset background flag
          summaryGeneratingInBackground = false;

          // Check if we're already showing the summary screen
          const alreadyShowingSummary = chatEl.querySelector('.overleaf-options-buttons') !== null;

          if (!alreadyShowingSummary) {
            // Not currently showing summary, so display it
            if (summaryFormat === 'latex') {
              showSummaryOverleafOptions();
            } else {
              showSummaryHtmlResult();
            }
          }

          // Update subtitle
          updateHeaderSubtitle('Alternative extraction complete!');

          // Mark alternative extraction as completed and add button
          alternativeExtractionCompleted = true;
          addAlternativeExtractionButtonIfNeeded();

        } finally {
          suppressIntercept = false;
          summaryGenerating = false;
          summaryGeneratingInBackground = false;
          isAlternativeExtraction = false;
        }

      } catch (error) {
        console.error('[Alternative Extraction] ✗ Extraction failed:', error);

        // Check if this is a rate limit error from background generation
        if (error.message === 'Rate limited - user needs to decide') {
          console.log('[Alternative Extraction] Rate limit detected - showing dialog');

          // Reset flags so we can show UI
          summaryRateLimited = false;
          summaryGeneratingInBackground = false;
          summaryGenerating = false;
          isAlternativeExtraction = false;
          suppressIntercept = false;

          // Re-enable buttons first
          const allButtons = document.querySelectorAll('.flashcard-btn, .quiz-gen-stop');
          allButtons.forEach(btn => {
            btn.disabled = false;
            btn.style.opacity = '1';
          });

          // Show rate limit dialog
          const useFlash = await new Promise((resolve) => {
            chatEl.innerHTML = '';
            controlsEl.style.display = 'none';
            inputRowEl.style.display = 'none';
            attEl.style.display = 'none';

            const container = document.createElement('div');
            container.className = 'quiz-generating';
            container.innerHTML = `
              <div class="quiz-gen-text">⚠️ Rate Limited</div>
              <div class="quiz-gen-subtext" style="max-width: 500px; margin: 0 auto;">You have been rate limited by the API. You can either try again later or proceed with the Flash model, which may result in <strong>significantly degraded quality</strong> for the summary.</div>
              <div style="display: flex; gap: 12px; margin-top: 24px; justify-content: center;">
                <button class="flashcard-btn" id="alt-rate-limit-cancel">Try Again Later</button>
                <button class="flashcard-btn flashcard-btn-primary" id="alt-rate-limit-flash">Use Flash Model</button>
              </div>
            `;
            chatEl.appendChild(container);

            document.getElementById('alt-rate-limit-cancel').onclick = () => resolve(false);
            document.getElementById('alt-rate-limit-flash').onclick = () => resolve(true);
          });

          if (!useFlash) {
            // User chose to try again later - restore UI to previous summary view
            console.log('[Alternative Extraction] User chose to try again later');
            chatEl.innerHTML = '';
            controlsEl.style.display = '';
            inputRowEl.style.display = '';
            attEl.style.display = '';

            // Return to previous view
            if (summaryLatex) {
              showSummaryOverleafOptions();
            } else if (summaryHtml) {
              showSummaryHtmlResult();
            } else {
              exitSummaryMode();
            }
            return;
          }

          // User chose to use Flash model - retry with flash
          console.log('[Alternative Extraction] User chose to use Flash model - retrying');

          try {
            // Set flags for retry
            isAlternativeExtraction = true;
            suppressIntercept = true;
            summaryGeneratingInBackground = true;
            forceFlashModel = true; // Force using Flash model

            // Disable buttons again
            allButtons.forEach(btn => {
              btn.disabled = true;
              btn.style.opacity = '0.5';
            });

            // Update subtitle
            const subtitle = document.querySelector('.header-subtitle');
            if (subtitle) {
              subtitle.textContent = 'Generating summary with Flash model... Please wait.';
            }

            // Retry summary generation (will use flash model due to forceFlashModel flag)
            await startSummaryGeneration();

            console.log('[Alternative Extraction - Flash] ✓ Summary generation complete with Flash model');
            console.log('[Alternative Extraction - Flash] lastUsedExtractionMethod:', lastUsedExtractionMethod);
            console.log('[Alternative Extraction - Flash] currentlyDisplayedVersion:', currentlyDisplayedVersion);

            // CRITICAL: Ensure the new version is saved and currentlyDisplayedVersion is set
            // This is a safety net in case startSummaryGeneration didn't do it
            if (lastUsedExtractionMethod && currentlyDisplayedVersion !== lastUsedExtractionMethod) {
              console.warn('[Alternative Extraction - Flash] currentlyDisplayedVersion mismatch, forcing save');
              saveCurrentSummaryToVersion(lastUsedExtractionMethod);
            }

            console.log('[Alternative Extraction - Flash] After safety save - currentlyDisplayedVersion:', currentlyDisplayedVersion);

            // Re-enable buttons
            allButtons.forEach(btn => {
              btn.disabled = false;
              btn.style.opacity = '1';
            });

            // Show the result
            setTimeout(() => {
              // Check if we're already showing the summary screen
              const alreadyShowingSummary = chatEl.querySelector('.overleaf-options-buttons') !== null ||
                                            chatEl.querySelector('.summary-buttons-container') !== null;

              if (!alreadyShowingSummary) {
                // Not currently showing summary, so display it
                if (summaryFormat === 'latex') {
                  showSummaryOverleafOptions();
                } else {
                  showSummaryHtmlResult();
                }
              }

              // Update subtitle
              updateHeaderSubtitle('Alternative extraction complete!');

              // Mark alternative extraction as completed and add button
              alternativeExtractionCompleted = true;
              addAlternativeExtractionButtonIfNeeded();
            }, 100);

          } finally {
            suppressIntercept = false;
            summaryGenerating = false;
            summaryGeneratingInBackground = false;
            isAlternativeExtraction = false;
          }

          return; // Exit successfully after handling rate limit
        }

        // Not a rate limit error - show generic error
        alert(`Failed to extract images with alternative method: ${error.message}`);

        // Reset flag and suppress
        isAlternativeExtraction = false;
        suppressIntercept = false;

        // Re-enable buttons
        const allButtons = document.querySelectorAll('.flashcard-btn, .quiz-gen-stop');
        allButtons.forEach(btn => {
          btn.disabled = false;
          btn.style.opacity = '1';
        });

        // Return to previous view
        if (summaryLatex) {
          showSummaryOverleafOptions();
        } else if (summaryHtml) {
          showSummaryHtmlResult();
        } else {
          exitSummaryMode();
        }
      }
    };

    window.adjustImageSize = function(delta) {
      // Adjust multiplier (clamp between 0.5 and 2.0)
      imageSizeMultiplier = Math.max(0.5, Math.min(2.0, imageSizeMultiplier + delta));

      // Update display
      const displayEl = document.getElementById('image-size-display');
      if (displayEl) {
        displayEl.textContent = `${Math.round(imageSizeMultiplier * 100)}%`;
      }

      console.log(`[Image Size] Adjusted to ${imageSizeMultiplier.toFixed(1)}x (${Math.round(imageSizeMultiplier * 100)}%)`);
    };

    window.openSummaryInOverleaf = async function(useRepaired = false) {
      try {
        let latexToOpen = useRepaired && repairedSummaryLatex ? repairedSummaryLatex : summaryLatex;

        if (!latexToOpen) {
          alert('No LaTeX content available');
          return;
        }

        // If images are present, re-process from URL version to apply current image size multiplier
        if (!useRepaired && summaryHasImages && summaryLatexWithUrls) {
          console.log(`[Overleaf] Re-processing images with size multiplier: ${imageSizeMultiplier.toFixed(1)}x`);
          latexToOpen = await replaceImagePlaceholdersWithBase64(summaryLatexWithUrls);
          console.log('[Overleaf] LaTeX with resized images ready for Overleaf');
        }
        // If using repaired LaTeX and it has IMAGE_N placeholders, replace them with base64
        else if (useRepaired && repairedSummaryLatex && repairedSummaryLatex.includes('% IMAGE_')) {
          console.log('[Overleaf] Repaired LaTeX has IMAGE_N placeholders, replacing with base64...');
          // First replace IMAGE_N with URLs
          latexToOpen = replaceImagePlaceholdersWithUrls(repairedSummaryLatex);
          // Then replace URLs with base64
          latexToOpen = await replaceImagePlaceholdersWithBase64(latexToOpen);
          console.log('[Overleaf] Repaired LaTeX with base64 ready for Overleaf');
        }

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = 'https://www.overleaf.com/docs';
        form.target = '_blank';

        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'snip';
        input.value = latexToOpen;

        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        document.body.removeChild(form);

        console.log('Opened summary in Overleaf');
      } catch (err) {
        console.error('Failed to open in Overleaf:', err);
        alert('Failed to open in Overleaf. Please try again.');
      }
    };

    window.repairSummaryLatex = async function() {
      const btn = document.querySelector('.summary-repair-btn');
      if (!btn || summaryRepairing) return;

      btn.disabled = true;
      btn.innerHTML = '⏳ Repairing...';
      summaryRepairing = true;

      try {
        suppressIntercept = true;

        // Use the original LaTeX (with IMAGE_N placeholders, not base64)
        const latexToRepair = summaryLatexOriginal || summaryLatex;

        // Fetch LaTeX repair prompt from backend
        console.log('[LaTeX Repair] Fetching LaTeX repair prompt from backend');
        const promptResponse = await fetch('http://localhost:5000/api/prompts/latex-repair', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ latexContent: latexToRepair })
        });
        const promptData = await promptResponse.json();
        if (!promptResponse.ok || !promptData.prompt) {
          throw new Error(promptData.error || 'Failed to retrieve LaTeX repair prompt');
        }
        const repairPrompt = promptData.prompt;

        await waitForApiKey();

        let usedModel = MODEL_PRO;
        let url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_PRO}:generateContent`;

        logModelUsage('SummaryRepair', usedModel, 'attempt');

        const requestBody = {
          contents: [{ parts: [{ text: repairPrompt }] }],
          generationConfig: {
            temperature: 0.3,
            topK: 40,
            topP: 0.95,
          }
        };

        let response = await proxiedFetchForAI(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        });

        // Handle 429 rate limit
        if (response.status === 429) {
          console.log("Pro model rate limited, switching to Flash");
          usedModel = MODEL_FLASH;
          url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASH}:generateContent`;
          logModelUsage('SummaryRepair', usedModel, 'retry after rate limit');
          response = await proxiedFetchForAI(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
          });

          // Check if Flash is also rate limited
          if (response.status === 429) {
            console.log("Flash model also rate limited, switching to Flash Lite");

            const retryAfter = response.headers.get('retry-after');
            setRateLimitNotice(retryAfter);

            usedModel = MODEL_FLASHLITE;
            url = `https://generativelanguage.googleapis.com/v1beta/${MODEL_FLASHLITE}:generateContent`;
            logModelUsage('SummaryRepair', usedModel, 'retry after second rate limit');
            response = await proxiedFetchForAI(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(requestBody)
            });
          }
        }

        suppressIntercept = false;

        // Clear rate limit notice if Pro or Flash returned 200
        checkAndClearRateLimitOn200(response.status, usedModel);

        logModelUsage('SummaryRepair', usedModel, 'response received');

        const data = await response.json();
        if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
          throw new Error("No response from Gemini");
        }

        let fixed = data.candidates[0].content.parts[0].text;
        // Remove markdown code blocks if present
        fixed = fixed.replace(/^```latex\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/g, '').trim();

        repairedSummaryLatex = fixed;

        // Update button state and show all 3 options
        summaryRepairing = false;
        updateSummaryOptionsAfterRepair();

      } catch (err) {
        console.error('Repairment failed:', err);
        suppressIntercept = false;
        summaryRepairing = false;

        // Re-query for button in case user left and came back
        const currentBtn = document.querySelector('.summary-repair-btn');
        if (currentBtn) {
          currentBtn.disabled = false;
          currentBtn.innerHTML = '🛠️ Repair';
        }

        alert('Failed to repair LaTeX. Please try again.');
      }
    };

    function updateSummaryOptionsAfterRepair() {
      // Update the options page to show all 3 buttons
      const buttonsContainer = document.querySelector('.overleaf-options-buttons');
      if (buttonsContainer) {
        buttonsContainer.innerHTML = `
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(false); hideSummaryOverleafOptions();" style="width: 200px;">🌱 Open Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf summary-repair-btn" onclick="repairSummaryLatex();" style="width: 200px;">🔄 Repair Again</button>
          <button class="flashcard-btn flashcard-btn-overleaf" onclick="openSummaryInOverleaf(true); hideSummaryOverleafOptions();" style="width: 200px;">🛠️ Open Repaired</button>
        `;
      }
    }

    // ===== Interceptor =====
    // IMPORTANT: Capture the native fetch before intercepting
    const originalFetch = window.fetch.bind(window);

    window.fetch = async function(input, init) {
      const urlOrig = typeof input === "string" ? input : (input && input.url) || "";
      const method = (init && (init.method || "GET")) || "GET";
      const isGeminiGenerate = /generativelanguage\.googleapis\.com\/v1beta\/.+:generateContent/.test(urlOrig);

      if (suppressIntercept) return originalFetch(input, init);

      if (!isGeminiGenerate || method.toUpperCase() !== "POST") {
        // Non-Gemini calls pass through unchanged
        return originalFetch(input, init);
      }

      let bodyText = init && init.body;
      if (typeof bodyText !== "string" && bodyText && typeof bodyText.text === "function") {
        bodyText = await bodyText.text();
      }

      let isInitialPageAutoCall = false;
      try {
        if (typeof bodyText === "string" && bodyText.trim().startsWith("{")) {
          const payload = JSON.parse(bodyText);
          const content = payload?.contents?.[0];
          const parts = content?.parts;

          if (Array.isArray(parts) && typeof parts[0]?.text === "string") {
            const firstText = parts[0].text || "";
            if (!initialAutoHandled && firstText.includes("My question is {}.")) {
              isInitialPageAutoCall = true;
              initialAutoHandled = true;
              if (!partsTail) partsTail = parts.slice(1);
            } else {
              if (!partsTail) partsTail = parts.slice(1);
            }
          }
        }
      } catch (e) {
        console.warn("Gemini request body parse failed:", e);
      }

      const newUrl = rewriteUrlWithModel(urlOrig, currentModel);
      input = newUrl;

      lastUrl = newUrl;
      if (init && init.headers) lastHeaders = init.headers;

      if (isInitialPageAutoCall) {
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: ""}] } }] }), {
          status: 200, headers: { "Content-Type": "application/json" }
        });
      }

      if (!isInitialPageAutoCall) {
        if (!lastPendingBubble || !lastPendingBubble.isConnected) lastPendingBubble = appendPendingBubble();
        showHeaderSpinner(true); setError("");
        setThinkingState(true);
      }

      // Route Gemini calls through the backend proxy with Base64 decode handling
      const response = await proxiedFetchForAI(urlOrig, init || {});

      try {
        const clone = response.clone();
        const data = await clone.json();
        const explanation = extractExplanation(data);
        const html = explanation ? renderMarkdown(explanation) : renderMarkdown("_No explanation text found._");
        resolvePendingBubble(lastPendingBubble, html);
        if (explanation) {
          history.push({ role: "model", text: explanation });
        }
        setThinkingState(false);
      } catch (e) {
        setError("Could not parse Gemini response.");
        resolvePendingBubble(lastPendingBubble, renderMarkdown("_Could not parse Gemini response._"));
        setThinkingState(false);
      }

      return response;
    };

    stopEl.addEventListener("click", () => {
      cancelThinkingUI(lastPendingBubble, "by user");
      if (lastUserMsgForRetry) { textEl.value = lastUserMsgForRetry; textEl.focus(); }
    });

    // Auto-click Transcripts panel button on page load
    (function autoOpenTranscripts() {
      const interval = setInterval(() => {
        const btn = document.querySelector('button[aria-label="Transcripts panel"]');
        if (btn) {
          btn.click();
          console.log('✅ Clicked the "Transcripts panel" button.');
          clearInterval(interval);
        }
      }, 100);
    })();

    // Initialize PDF URL and files on page load
    (async function initOnLoad() {
      try {
        // First initialize PDF URL (may prompt user and reload)
        const pdfInitialized = await initializePdfUrl();

        // If PDF initialization returned false, it means we're about to reload
        // Don't continue with file initialization
        if (pdfInitialized === false) {
          console.log('[PDF STATUS] Page will reload, skipping file initialization');
          return;
        }

        // For YouTube: Don't pre-fetch video summary on page load - wait for toggle click
        // For Echo360: Pre-initialize files as before
        if (!isYouTubePage()) {
          await waitForApiKey();
          await initializeFiles(null);
          console.log("Files pre-initialized on script load");
        } else {
          console.log("[YouTube] Skipping pre-initialization - will fetch on toggle click");
        }
      } catch (e) {
        console.error("Failed to pre-initialize on load:", e);
      }
    })();

    // YouTube URL monitoring - show/hide toggle button based on URL
    if (window.location.hostname.includes('youtube.com')) {
      let lastUrl = window.location.href;
      let lastVideoId = getYouTubeVideoId();

      const updateToggleVisibility = () => {
        const currentUrl = window.location.href;
        const currentVideoId = getYouTubeVideoId();

        // Detect URL change
        if (currentUrl !== lastUrl) {
          console.log('[YouTube] URL changed:', currentUrl);
          lastUrl = currentUrl;

          // Detect if we switched to a different video
          if (currentVideoId !== lastVideoId) {
            lastVideoId = currentVideoId;

            if (currentVideoId) {
              console.log('[YouTube] New video detected:', currentVideoId);

              // Reset file upload state for new video
              filesInitialized = false;
              filesInitializing = false;
              uploadedPdfUri = null;
              uploadedVttUri = null;
              youtubeTranscriptUUID = null;
              youtubeTranscriptPromise = null;

              // Clear chat history and context
              chatEl.innerHTML = "";
              history.length = 0;
              slideGroups.length = 0;
              currentGroupId = null;
              setError("");
              lastPendingBubble = null;
              savedChatContent = '';
              resetAttachmentsUI();

              // Exit special modes (quiz/flashcard/checklist)
              if (quizMode) {
                quizMode = false;
                quizBtn.style.display = '';
              }
              if (flashcardMode) {
                flashcardMode = false;
                flashcardBtn.style.display = '';
              }
              if (checklistMode) {
                checklistMode = false;
                checklistBtn.style.display = '';
              }

              // Clear checklist data and coverage cache for new video
              checklistData = [];
              checklistCoverageCache = {};

              // Reset UI to normal state
              if (controlsEl) controlsEl.style.display = '';
              if (inputRowEl) inputRowEl.style.display = '';
              if (attEl) attEl.style.display = '';
              updateHeaderSubtitle('Ask about this slide');

              console.log('[YouTube] Chat history and context cleared for new video');

              // Reinitialize PDF URL status
              initializePdfUrl().catch(e => {
                console.error('[YouTube] Failed to initialize PDF URL:', e);
              });
            }
          }
        }

        // Show toggle button only on watch pages (URL contains /watch?v=)
        if (toggleBtn) {
          if (isYouTubePage()) {
            if (toggleBtn.style.display !== 'block') {
              toggleBtn.style.display = 'block';
              console.log('[YouTube] Toggle button shown');
            }
          } else {
            if (toggleBtn.style.display !== 'none') {
              toggleBtn.style.display = 'none';
              console.log('[YouTube] Toggle button hidden (not on watch page)');
            }
          }
        }
      };

      // Check URL every 300ms
      setInterval(updateToggleVisibility, 300);

      // Initial check
      updateToggleVisibility();
    }

    // Expose proxiedFetchForAI globally for legacy code outside IIFE
    window.proxiedFetchForAI = proxiedFetchForAI;

    // Expose YouTube helper functions globally for captureVideoFrame outside IIFE
    window.isYouTubePage = isYouTubePage;
    window.getYouTubeVideoId = getYouTubeVideoId;
    window.getYouTubeCurrentTime = getYouTubeCurrentTime;
  })();

  /* ================== ORIGINAL SCRIPT (UNCHANGED) ================== */

  // GEMINI_API_KEY is now defined at the top of the main IIFE above
  var GEMINI_MODEL   = "models/gemini-2.5-flash";
  // SLIDES_PDF_URL is now dynamically managed in the main IIFE above

  function getByXPath(path) {
    return document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  }
  function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

  async function captureVideoFrame(wrapperXPath) {
    // YouTube implementation (Step 1)
    if (window.isYouTubePage && window.isYouTubePage()) {
      const video = document.querySelector('.video-stream.html5-main-video');
      if (!video || !video.videoWidth || !video.videoHeight) {
        console.error('[YouTube] Video element not found!');
        return null;
      }

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;

      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Return base64 without data URI prefix (same format as Echo360)
      return canvas.toDataURL('image/png').split(',')[1];
    }

    // Echo360 implementation (original)
    var wrapper = getByXPath(wrapperXPath);
    if (!wrapper) return null;
    var videoEl = wrapper.querySelector("video");
    if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;

    var canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth;
    canvas.height = videoEl.videoHeight;
    var ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png").split(",")[1];
  }

  function getVttUrl() {
    var pageSource = document.documentElement.innerHTML;
    var regex = /captions\\":\\"(.*?)\\"/g;
    var match;
    while ((match = regex.exec(pageSource)) !== null) {
      if (match[1].indexOf("vtt") !== -1) {
        return match[1].replace(/\\\//g, "/");
      }
    }
    return null;
  }

  async function fetchAsBlob(url, mime) {
    try {
      var res = await fetch(url, { mode: "cors" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var blob = await res.blob();
      if (mime && blob.type !== mime) {
        blob = new Blob([await blob.arrayBuffer()], { type: mime });
      }
      return blob;
    } catch (e) {
      console.warn("Failed to fetch blob (cors):", url, e);
      return null;
    }
  }

  async function fetchVttWithAuth(vttUrl) {
    if (!vttUrl) return null;

    try {
      var resAuth = await fetch(vttUrl, { credentials: "include" });
      if (!resAuth.ok) throw new Error("HTTP " + resAuth.status);
      var text = await resAuth.text();
      return new Blob([text], { type: "text/plain" });
    } catch (e) {
      console.warn("VTT fetch with credentials failed:", e.message);
    }

    try {
      var resCors = await fetch(vttUrl, { mode: "cors" });
      if (!resCors.ok) throw new Error("HTTP " + resCors.status);
      var blob = await resCors.blob();
      if (blob.type !== "text/plain") {
        blob = new Blob([await blob.arrayBuffer()], { type: "text/plain" });
      }
      return blob;
    } catch (e2) {
      console.warn("VTT fetch (cors) failed:", e2.message);
    }

    console.warn("Could not fetch VTT directly. Opening in new tab instead...");
    try { window.open(vttUrl, "_blank"); } catch {}
    return null;
  }

  async function uploadFileToGemini(blob, displayName) {
    if (!blob) return null;

    const RATE_LIMIT_COOLDOWN_MS = 30000;
    const waitForRateLimitCooldown = async (status, errorPayload, stage) => {
      let message = '';
      if (typeof errorPayload === 'string' && errorPayload.length) {
        message = errorPayload;
        try {
          const parsed = JSON.parse(errorPayload);
          if (parsed && typeof parsed === 'object') {
            const extracted =
              typeof parsed.message === 'string' ? parsed.message :
              typeof parsed.error === 'string' ? parsed.error :
              (parsed.error && typeof parsed.error.message === 'string' ? parsed.error.message : '');
            if (extracted) {
              message = extracted;
            }
          }
        } catch (_) {
          // ignore JSON parse failures, keep original string
        }
      } else if (errorPayload && typeof errorPayload === 'object') {
        const extracted =
          typeof errorPayload.message === 'string' ? errorPayload.message :
          typeof errorPayload.error === 'string' ? errorPayload.error :
          '';
        if (extracted) {
          message = extracted;
        }
      }

      const lowerMessage = (message || '').toLowerCase();
      const hitRateLimit = status === 429 || lowerMessage.includes('rate limit');

      if (hitRateLimit) {
        const snippet = message ? message.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        console.warn(
          `[Upload] Rate limit hit during ${stage}. Waiting 30 seconds before retry...` +
          (snippet ? ` (server message: ${snippet})` : '')
        );
        await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_COOLDOWN_MS));
      }
    };

    const maxRetries = 2;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      try {
        if (retryCount > 0) {
          console.log(`Retrying file upload for ${displayName} (attempt ${retryCount + 1}/${maxRetries + 1})`);
        }

        // Create abort controller for 25 second timeout on init
        const initController = new AbortController();
        const initTimeoutId = setTimeout(() => initController.abort(), 25000);

        let initResp;
        try {
          // Use proxied fetch which will redirect to backend
          initResp = await window.proxiedFetchForAI("https://generativelanguage.googleapis.com/upload/v1beta/files", {
            method: "POST",
            headers: {
              "X-Goog-Upload-Protocol": "resumable",
              "X-Goog-Upload-Command": "start",
              "X-Goog-Upload-Header-Content-Type": blob.type || "application/octet-stream",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ file: { display_name: displayName || "upload" } }),
            signal: initController.signal
          });
          clearTimeout(initTimeoutId);
        } catch (err) {
          clearTimeout(initTimeoutId);
          if (err.name === 'AbortError') {
            throw new Error(`Upload init timed out after 25 seconds for ${displayName}`);
          }
          throw err;
        }

        if (!initResp.ok) {
          const errorText = await initResp.text();
          console.error("Files API init failed", errorText);
          await waitForRateLimitCooldown(initResp.status, errorText, 'initialization');
          retryCount++;
          if (retryCount > maxRetries) return null;
          continue;
        }

        var uploadUrl = initResp.headers.get("x-goog-upload-url");
        if (!uploadUrl) {
          console.error("No x-goog-upload-url header on init response");
          retryCount++;
          if (retryCount > maxRetries) return null;
          continue;
        }

        // Create abort controller for 25 second timeout on finalize
        const finalizeController = new AbortController();
        const finalizeTimeoutId = setTimeout(() => finalizeController.abort(), 25000);

        let finalizeResp;
        try {
          finalizeResp = await fetch(uploadUrl, {
            method: "POST",
            headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" },
            body: blob,
            signal: finalizeController.signal
          });
          clearTimeout(finalizeTimeoutId);
        } catch (err) {
          clearTimeout(finalizeTimeoutId);
          if (err.name === 'AbortError') {
            throw new Error(`Upload finalize timed out after 25 seconds for ${displayName}`);
          }
          throw err;
        }

        if (!finalizeResp.ok) {
          const errorText = await finalizeResp.text();
          console.error("Files API finalize failed", errorText);
          await waitForRateLimitCooldown(finalizeResp.status, errorText, 'finalization');
          retryCount++;
          if (retryCount > maxRetries) return null;
          continue;
        }

        var info = await finalizeResp.json();
        var fileUri = info && info.file && info.file.uri;
        if (!fileUri) {
          console.warn("Upload completed but no file.uri found", info);
          retryCount++;
          if (retryCount > maxRetries) return null;
          continue;
        }

        // Success!
        if (retryCount > 0) {
          console.log(`Upload succeeded for ${displayName} after ${retryCount} retries`);
        }
        return fileUri;

      } catch (error) {
        console.error(`Upload attempt ${retryCount + 1} failed for ${displayName}:`, error.message);
        retryCount++;
        if (retryCount > maxRetries) {
          console.error(`All upload attempts failed for ${displayName}`);
          return null;
        }
        if (typeof error.message === 'string' && error.message.toLowerCase().includes('rate limit')) {
          console.warn('[Upload] Rate limit error caught in catch block. Waiting 30 seconds before retry...');
          await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_COOLDOWN_MS));
        } else {
          // Wait 1 second before retrying for other errors
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    return null;
  }

  async function sendToGemini(plaintext, base64img, vttFileUri, pdfFileUri) {
    var parts = [
      {
        text:
          "I will be giving you the lecture slides, a screenshot of my lecture recording with one slide present. The lecturer is also talking, I am attaching the entire audio transcript for context. The audio transcript around the current frame is given below. Use all the resources attached to understand the context and situation and clarify what is going on in the current slide the lecturer is talking about (as seen in attached image) as I don't understand. Only answer on based on what you see in the image attached which is what I am currently viewing. My question is {}. The audio transcript around the current frame: " + (plaintext || "(none)")
      }
    ];

    if (base64img) {
      parts.push({ inlineData: { mimeType: "image/png", data: base64img } });
    }
    if (vttFileUri) {
      parts.push({ fileData: { mimeType: "text/plain",        fileUri: vttFileUri } });
    }
    if (pdfFileUri) {
      parts.push({ fileData: { mimeType: "application/pdf", fileUri: pdfFileUri } });
    }

    var body = { contents: [{ parts: parts }] };

    var resp = await window.proxiedFetchForAI(
      "https://generativelanguage.googleapis.com/v1beta/" + GEMINI_MODEL + ":generateContent",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );

    var data = await resp.json();
    var explanation =
      data && data.candidates && data.candidates[0] &&
      data.candidates[0].content && data.candidates[0].content.parts &&
      data.candidates[0].content.parts.find(function(p){ return typeof p.text === "string"; })?.text;

    if (explanation) {
      console.log("\n=== AI explanation ===\n\n" + explanation);
    } else {
      console.log("No explanation text found. Raw response:", data);
    }
  }

  // OLD MAIN FUNCTION - DISABLED (Files now initialized in UI IIFE above)
  // This was causing duplicate file uploads
  /*
  (async function main() {
    var btn2 = getByXPath("/html/body/div/div[2]/div[3]/div[1]/button[2]"); if (btn2) btn2.click();
    await sleep(200);
    var btn3 = getByXPath("/html/body/div/div[2]/div[3]/div[1]/button[3]"); if (btn3) btn3.click();
    await sleep(300);

    var element2 = getByXPath("/html/body/div/div[2]/div[3]/div[2]/div[2]/div[1]/div");
    var plaintext = element2 ? element2.innerText.trim() : "";

    var base64img = await captureVideoFrame("/html/body/div/div[2]/div[2]/div/div/div[2]/div[1]/div/div/div[1]/div/div/div");

    var vttUri = null;
    var vttUrl = getVttUrl();
    if (vttUrl) {
      var vttBlob = await fetchVttWithAuth(vttUrl);
      if (vttBlob) {
        vttUri = await uploadFileToGemini(vttBlob, "transcript.vtt");
      } else {
        console.warn("Skipping VTT upload (fetch failed).");
      }
    } else {
      console.warn("No VTT URL found on page.");
    }

    var pdfBlob = await fetchAsBlob(SLIDES_PDF_URL, "application/pdf");
    var pdfUri = await uploadFileToGemini(pdfBlob, "lecture-slides.pdf");

    if (plaintext || base64img || vttUri || pdfUri) {
      await sendToGemini(plaintext, base64img, vttUri, pdfUri);
    } else {
      console.log("Nothing to send to AI (no excerpt, frame, or files).");
    }
  })();
  */
