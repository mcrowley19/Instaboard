// Runs on DataHub pages. Answers the side panel's context requests with the
// entity URN from the URL, the page title, and any selected text.

const URN_ROUTE_RE =
  /\/(dataset|chart|dashboard|dataFlow|dataJob|glossaryTerm|glossaryNode|domain|container|mlModels?|user|group)\/(urn:li:[^/?#]+)/;

function getContext() {
  let datasetUrn;
  let entityType;
  try {
    const decoded = decodeURIComponent(location.href);
    const match = decoded.match(URN_ROUTE_RE);
    if (match) {
      entityType = match[1];
      datasetUrn = match[2];
    }
  } catch {
    // malformed URL encoding — leave URN undefined
  }

  const selection = String(window.getSelection() || "").trim().slice(0, 2000);

  return {
    url: location.href,
    title: document.title,
    datasetUrn: datasetUrn || undefined,
    entityType: entityType || undefined,
    selection: selection || undefined,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "GET_CONTEXT") {
    sendResponse(getContext());
  }
});
