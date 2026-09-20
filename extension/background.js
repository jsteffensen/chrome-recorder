// Service worker: keeps the recording state and collects events from the content script.
// State lives in chrome.storage so it survives the worker being shut down.

const EMPTY = { recording: false, tabId: null, events: [] };

// Handle messages one at a time so concurrent events can't overwrite each other.
let queue = Promise.resolve();
const enqueue = (fn) => {
  queue = queue.then(fn).catch((err) => console.error(err));
  return queue;
};

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || { ...EMPTY };
}
const setState = (state) => chrome.storage.local.set({ state });

function setBadge(recording) {
  chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  enqueue(async () => {
    const state = await getState();
    const fromRecordedTab =
      state.recording && sender.tab && sender.tab.id === state.tabId && sender.frameId === 0;

    switch (msg.kind) {
      // ----- from the popup -----
      case 'start': {
        await setState({ recording: true, tabId: msg.tabId, events: [] });
        setBadge(true);
        try {
          await chrome.tabs.sendMessage(msg.tabId, { kind: 'start' });
          sendResponse({ ok: true });
        } catch (_) {
          await setState({ ...EMPTY });
          setBadge(false);
          sendResponse({
            ok: false,
            error: 'Could not attach to this page. Reload the page and try again (chrome:// pages are not supported).',
          });
        }
        break;
      }
      case 'stop': {
        if (state.tabId != null) chrome.tabs.sendMessage(state.tabId, { kind: 'stop' }).catch(() => {});
        await setState({ ...EMPTY, events: state.events }); // keep events so they can be downloaded again
        setBadge(false);
        sendResponse({ events: state.events });
        break;
      }
      case 'status':
        sendResponse({ recording: state.recording, count: state.events.length });
        break;
      case 'get':
        sendResponse({ events: state.events });
        break;

      // ----- from content scripts -----
      case 'content-status':
        sendResponse({ recording: !!fromRecordedTab });
        break;
      case 'event':
        if (fromRecordedTab) {
          state.events.push(msg.evt);
          await setState(state);
        }
        sendResponse({});
        break;

      default:
        sendResponse({});
    }
  });
  return true; // keep the message channel open for the async response
});
