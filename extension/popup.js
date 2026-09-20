const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

function download(events) {
  const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recording.json';
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
