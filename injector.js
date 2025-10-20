// Content script that injects CORS helper and main.js into the page context
(function() {
  const extensionUrl = browser.runtime.getURL('');
  console.log('[Injector] Extension URL:', extensionUrl);

  // First inject CORS helper
  const corsHelper = document.createElement('script');
  corsHelper.src = browser.runtime.getURL('cors-helper.js');
  corsHelper.onload = function() {
    console.log('[Injector] CORS helper loaded');

    // Fetch main.js and inject extension URL directly into the code
    fetch(browser.runtime.getURL('main.js'))
      .then(response => response.text())
      .then(code => {
        console.log('[Injector] Fetched main.js, injecting extension URL...');

        // Replace the extension URL placeholder with actual URL
        const modifiedCode = code.replace(
          "const EXTENSION_URL = window.__LEQTURE_EXTENSION_URL__ || '';",
          `const EXTENSION_URL = "${extensionUrl}";`
        );

        // Inject the modified code
        const mainScript = document.createElement('script');
        mainScript.textContent = modifiedCode;
        (document.head || document.documentElement).appendChild(mainScript);
        console.log('[Injector] Main script injected with extension URL:', extensionUrl);
      })
      .catch(e => {
        console.error('[Injector] Failed to fetch/inject main.js:', e);
      });

    this.remove();
  };
  corsHelper.onerror = function(e) {
    console.error('[Injector] CORS helper failed to load:', e);
  };
  (document.head || document.documentElement).appendChild(corsHelper);

  // Expose browser.runtime to page context for CORS helper
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data.type === 'FETCH_CORS_REQUEST') {
      browser.runtime.sendMessage(event.data.payload).then(response => {
        window.postMessage({
          type: 'FETCH_CORS_RESPONSE',
          id: event.data.id,
          response: response
        }, '*');
      });
    }
  });
})();
