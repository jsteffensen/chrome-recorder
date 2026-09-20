const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// recording_<host of the first page>_<DD Mmm YYYY - HHMM of the recording start>.json
// e.g. "recording_demo.graphnote.io_20 Sep 2026 - 1435.json"
function fileName(events) {
  const first = events[0] || {};
  let host = 'unknown';
  try {
    const u = new URL(first.url);
    host = u.host || u.protocol.replace(':', ''); // file:// pages have no host
  } catch (_) { /* no usable URL */ }
  host = host.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'; // "localhost:3000" -> "localhost-3000"

  const d = new Date(first.t || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${pad(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()} - ${pad(d.getHours())}${pad(d.getMinutes())}`;
  return `recording_${host}_${stamp}.json`;
}

function download(events) {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName(events);
  a.click();
}

async function refresh() {
  const { recording, count } = await ask({ kind: 'status' });
  $('status').textContent = recording
    ? `Recording… ${count} events so far.`
    : count
      ? `Not recording. Last recording has ${count} events.`
      : 'Not recording.';
  $('start').hidden = recording;
  $('stop').hidden = !recording;
  $('download').hidden = recording || !count;
}

$('start').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const res = await ask({ kind: 'start', tabId: tab.id });
  if (res.ok) window.close(); // popup closes so it doesn't get in the way; the badge shows REC
  else {
    $('msg').textContent = res.error;
    refresh();
  }
};

$('stop').onclick = async () => {
  const { events } = await ask({ kind: 'stop' });
  download(events);
  refresh();
};

$('download').onclick = async () => {
  const { events } = await ask({ kind: 'get' });
  download(events);
};

refresh();
