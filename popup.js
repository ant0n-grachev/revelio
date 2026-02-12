async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id;
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function closePopupSoon() {
  setTimeout(() => window.close(), 120);
}

function getTolerance() {
  const sel = document.getElementById("tolerance");
  return sel?.value || "default";
}

function loadTolerance() {
  const sel = document.getElementById("tolerance");
  if (!sel) return;
  const rawSaved = localStorage.getItem("revelio_tolerance");
  const migrated =
    rawSaved === "all" ? "everything" :
    rawSaved === "strict" ? "sweep" :
    rawSaved === "balanced" ? "default" :
    rawSaved;

  if (migrated && ["everything", "sweep", "default", "precise"].includes(migrated)) {
    sel.value = migrated;
  }
}

function bindTolerancePersistence() {
  const sel = document.getElementById("tolerance");
  if (!sel) return;
  sel.addEventListener("change", () => {
    localStorage.setItem("revelio_tolerance", sel.value);
  });
}

function friendlyErrorMessage(raw) {
  const msg = String(raw || "Unknown error");

  if (/Cannot access contents of url/i.test(msg) || /Cannot access a chrome:\/\/ URL/i.test(msg)) {
    return "This page is restricted. For local files, enable 'Allow access to file URLs' in chrome://extensions -> Revelio.";
  }
  if (/Receiving end does not exist/i.test(msg)) {
    return "Scanner is not loaded on this tab yet. Reload the page and try again.";
  }
  return msg;
}

function isNoReceiverError(raw) {
  const msg = String(raw || "");
  return /Receiving end does not exist/i.test(msg) ||
    /Could not establish connection/i.test(msg) ||
    /The message port closed before a response was received/i.test(msg);
}

async function sendWithEnsure(tabId, message) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, message);
    if (resp !== undefined) return resp;
    throw new Error("No response from scanner.");
  } catch (e) {
    if (!isNoReceiverError(e?.message || String(e))) throw e;

    await ensureContentScript(tabId);
    const resp = await chrome.tabs.sendMessage(tabId, message);
    if (resp !== undefined) return resp;
    throw new Error("No response after scanner injection. Reload the tab and try again.");
  }
}

document.getElementById("scan").addEventListener("click", async () => {
  try {
    const tabId = await getActiveTabId();
    if (!tabId) return setStatus("No active tab found.");

    const tolerance = getTolerance();
    setStatus(`Scanning (${tolerance})…`);
    const resp = await sendWithEnsure(tabId, { type: "SCAN", tolerance });
    if (resp?.ok) {
      setStatus(`Done. Found ${resp.count} suspicious element(s) (${tolerance}).`);
      closePopupSoon();
    } else if (resp?.error) {
      setStatus("Scan failed: " + friendlyErrorMessage(resp.error));
    } else {
      setStatus("Scan failed (no response). Try reloading the page.");
    }
  } catch (e) {
    setStatus("Error: " + friendlyErrorMessage(e?.message || String(e)));
  }
});

document.getElementById("clear").addEventListener("click", async () => {
  try {
    const tabId = await getActiveTabId();
    if (!tabId) return setStatus("No active tab found.");

    const resp = await sendWithEnsure(tabId, { type: "CLEAR" });
    if (resp?.ok) {
      setStatus("Cleared highlights.");
    } else if (resp?.error) {
      setStatus("Clear failed: " + friendlyErrorMessage(resp.error));
    } else {
      setStatus("Clear failed (no response). Reload and try again.");
    }
  } catch (e) {
    setStatus("Error: " + friendlyErrorMessage(e?.message || String(e)));
  }
});

loadTolerance();
bindTolerancePersistence();
