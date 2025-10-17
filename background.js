// This script will contain the main logic for the extension.

const BATCH_SIZE = 10;

// Wait for a specific tab to reach status "complete" (loaded) or time out.
async function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
    };

    const onTimeout = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };

    const timeout = setTimeout(onTimeout, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve(true);
      }
    };

    chrome.tabs.onUpdated.addListener(listener);

    // Immediate fast-path: if already complete and not discarded, resolve.
    chrome.tabs.get(tabId).then((tab) => {
      if (!settled && tab && tab.status === 'complete' && !tab.discarded) {
        settled = true;
        clearTimeout(timeout);
        cleanup();
        resolve(true);
      }
    }).catch(() => {
      // If we can't get the tab, just rely on timeout.
    });
  });
}

// Refresh a tab and wait for it to fully load with updated content.
async function ensureTabLoaded(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);

    // Always reload PR tabs to ensure we have the latest merge status.
    // This handles cases where tabs were loaded before the PR was merged.
    try {
      await chrome.tabs.reload(tabId);
    } catch (e) {
      // Reload can fail for some URLs; continue to wait regardless.
    }

    const loaded = await waitForTabComplete(tabId);
    return loaded;
  } catch (e) {
    return false;
  }
}

async function processTabsInBatches(tabs, batchSize) {
  for (let i = 0; i < tabs.length; i += batchSize) {
    const batch = tabs.slice(i, i + batchSize);
    await Promise.all(batch.map(processTab));
  }
}

async function processTab(tab) {
  try {
    // Make sure sleeping/unloaded tabs are fully loaded before injecting.
    const loaded = await ensureTabLoaded(tab.id);
    if (!loaded) {
      return; // Skip on timeout or failure per FR-010
    }

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    if (results && results[0] && results[0].result) {
      await chrome.tabs.remove(tab.id);
    }
  } catch (error) {
    console.warn(`Could not process tab ${tab.id}: ${error}`);
  }
}

chrome.action.onClicked.addListener(async () => {
  const tabs = await chrome.tabs.query({
    currentWindow: true,
    url: "https://github.com/*",
  });

  const prTabs = tabs.filter(tab => tab.url.includes("/pull/") && !tab.pinned);

  if (prTabs.length > 0) {
    await processTabsInBatches(prTabs, BATCH_SIZE);
  }
});
