// CORS helper to be injected alongside main.js
// Provides fetchCORS function that uses background script for cross-origin requests

(function() {
  let messageId = 0;
  const pendingRequests = new Map();

  // Listen for responses from content script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data.type === 'FETCH_CORS_RESPONSE') {
      const { id, response } = event.data;
      const resolver = pendingRequests.get(id);
      if (resolver) {
        resolver(response);
        pendingRequests.delete(id);
      }
    }
  });

  window.fetchCORS = async function(url, options = {}) {
    const method = options.method || 'GET';
    const responseType = options.responseType || 'blob'; // 'blob', 'text', 'json', or 'headers'

    try {
      // Send message to content script via postMessage
      const id = messageId++;
      const responsePromise = new Promise(resolve => {
        pendingRequests.set(id, resolve);
      });

      // Serialize ArrayBuffer for postMessage
      let bodyToSend = options.body;
      if (options.body instanceof ArrayBuffer) {
        bodyToSend = {
          type: 'ArrayBuffer',
          data: Array.from(new Uint8Array(options.body))
        };
      }

      window.postMessage({
        type: 'FETCH_CORS_REQUEST',
        id: id,
        payload: {
          type: 'FETCH_CORS',
          url: url,
          options: {
            method: method,
            headers: options.headers,
            body: bodyToSend
          },
          responseType: responseType
        }
      }, '*');

      const response = await responsePromise;

      if (response.error) {
        throw new Error(response.error);
      }

      // Reconstruct response based on type
      if (responseType === 'blob' && response.data) {
        const uint8Array = new Uint8Array(response.data);
        const blob = new Blob([uint8Array], { type: response.contentType || 'application/octet-stream' });
        return {
          ok: response.ok,
          status: response.status,
          headers: new Map(Object.entries(response.headers)),
          blob: async () => blob,
          arrayBuffer: async () => uint8Array.buffer
        };
      } else if (responseType === 'text') {
        return {
          ok: response.ok,
          status: response.status,
          headers: new Map(Object.entries(response.headers)),
          text: async () => response.data
        };
      } else if (responseType === 'json') {
        return {
          ok: response.ok,
          status: response.status,
          headers: new Map(Object.entries(response.headers)),
          json: async () => response.data
        };
      } else {
        return {
          ok: response.ok,
          status: response.status,
          headers: new Map(Object.entries(response.headers))
        };
      }
    } catch (error) {
      console.error('[CORS Helper] Error:', error);
      throw error;
    }
  };

  console.log('[CORS Helper] fetchCORS function injected');
})();
