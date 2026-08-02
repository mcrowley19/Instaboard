// Runs on DataHub pages. Answers the side panel's context requests with the
// entity URN from the URL, the page title, and any selected text.
//
// The URL → entity mapping lives in entity-from-url.js, which is loaded before
// this file (see manifest.json) and shared with the tests and the upstream
// contribution, so the shipped extension and the thing we published cannot drift.

function getContext() {
  const entity = datahubEntityFromUrl(location.href);
  const selection = String(window.getSelection() || "").trim().slice(0, 2000);

  return {
    url: location.href,
    title: document.title,
    datasetUrn: entity ? entity.urn : undefined,
    entityType: entity ? entity.entityType : undefined,
    selection: selection || undefined,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "GET_CONTEXT") {
    sendResponse(getContext());
  }
});
