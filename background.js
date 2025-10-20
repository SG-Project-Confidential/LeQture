// Background script to handle cross-origin requests
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_CORS') {
    // Handle async fetch and send response
    handleFetchRequest(message)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));

    // Return true to indicate we'll respond asynchronously
    return true;
  }
});

async function handleFetchRequest(message) {
  const { url, options = {} } = message;

  try {
    // If body is an ArrayBuffer (sent as array), convert it back
    if (options.body && typeof options.body === 'object' && options.body.type === 'ArrayBuffer') {
      options.body = new Uint8Array(options.body.data).buffer;
    }

    const response = await fetch(url, options);

    if (message.responseType === 'blob') {
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const contentType = response.headers.get('content-type');

      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: Array.from(new Uint8Array(arrayBuffer)),
        contentType: contentType
      };
    } else if (message.responseType === 'text') {
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: text
      };
    } else if (message.responseType === 'json') {
      const json = await response.json();
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        data: json
      };
    } else {
      // Default: just return response info
      return {
        ok: response.ok,
        status: response.status,
        headers: Object.fromEntries(response.headers.entries())
      };
    }
  } catch (error) {
    return { error: error.message };
  }
}
