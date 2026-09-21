#!/usr/bin/env node
// Replays a recording made by the Chrome Recorder extension with Puppeteer,
// keeping the original pauses between actions.
//
//   node player.js recording.json
//
// Optional environment variables:
//   SPEED=2       replay at twice the recorded speed (0.5 = half speed)
//   PASSWORD=...  text typed into password fields (passwords are never stored in a recording)
//   RECORD_VIDEO=on|off|file.mp4   answer the "record a video?" question up front (see README)

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn, spawnSync, execFile } = require('child_process');

// ---------- input ----------
if (process.argv.length !== 3) {
  console.error('Usage: node player.js <recording.json>');
  process.exit(1);
}
const file = process.argv[2];

let events;
try {
  events = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  process.exit(1);
}
if (!Array.isArray(events) || events.length === 0) {
  console.error(`${file} does not contain a list of recorded events.`);
  process.exit(1);
}

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.error('Puppeteer is not installed. Run:  npm i puppeteer');
  process.exit(1);
}

// ---------- settings ----------
const SPEED = Number(process.env.SPEED) || 1;
const FIND_TIMEOUT = 10000; // how long to wait for an element to show up
const SHOW_CLICKS = process.env.CLICK_INDICATOR !== 'off'; // amber circle at every click
const SIZE_WINDOW = process.env.WINDOW_SIZE !== 'off';     // resize the window to the size it was recorded in
const SHOW_CURSOR = process.env.VIRTUAL_CURSOR !== 'off';  // a mouse cursor that glides to every click
const CURSOR_TRAVEL = 1000; // ms before a click at which the cursor starts moving towards it (scaled by SPEED)
const NAV_TIMEOUT = 30000;  // how long to wait for a page load
const START_DELAY = 200;    // ms between the key press and the first action (fixed, not affected by SPEED)

const ACTIONS = new Set(['click', 'fill', 'select', 'key']);
const isAction = (e) => ACTIONS.has(e.type);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- click indicator and virtual cursor ----------
// These two functions run inside the page (Puppeteer serializes them and sends them to the browser),
// so they must not use anything from this file.

// Every mouse press draws an amber circle that grows from nothing to 75 px and fades out, 500 ms in
// total. It ignores the mouse, so it never gets in the way of a click.
function installClickIndicator() {
  window.addEventListener('mousedown', (e) => {
    const size = 75;
    const dot = document.createElement('div');
    Object.assign(dot.style, {
      position: 'fixed',
      left: e.clientX - size / 2 + 'px',
      top: e.clientY - size / 2 + 'px',
      width: size + 'px',
      height: size + 'px',
      boxSizing: 'border-box',
      borderRadius: '50%',
      background: 'rgba(255, 170, 0, 0.85)',
      border: '2px solid rgba(214, 110, 0, 0.95)',
      pointerEvents: 'none',
      zIndex: '2147483646', // just below the cursor
    });
    document.documentElement.appendChild(dot);
    const remove = () => dot.remove();
    const animation = dot.animate(
      [
        { transform: 'scale(0)', opacity: 1, offset: 0 },
        { transform: 'scale(1)', opacity: 0.85, offset: 0.4 }, // quick growth
        { transform: 'scale(1)', opacity: 0, offset: 1 },      // then fade away
      ],
      { duration: 500, easing: 'ease-out' }
    );
    animation.onfinish = remove;
    setTimeout(remove, 800); // safety net
  }, true);
}

// The virtual cursor: an arrow that stays where it is until it is told to glide somewhere else.
// It is created on first use at `from` (the middle of the window if that is null), then glides to `to`
// over `ms` milliseconds. With ms = 0 it jumps.
function moveCursorInPage(from, to, ms) {
  const at = (p) => 'translate(' + (p.x - 4) + 'px, ' + (p.y - 2) + 'px)'; // the arrow's tip is at (4, 2) in its image
  let cursor = document.getElementById('__replay_cursor');
  if (!cursor) {
    from = from || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    cursor = document.createElement('div');
    cursor.id = '__replay_cursor';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '24px',
      height: '24px',
      pointerEvents: 'none',
      zIndex: '2147483647',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.45))',
      transform: at(from),
    });
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    const arrow = document.createElementNS(ns, 'path');
    arrow.setAttribute('d', 'M4 2 L4 20 L8.6 15.6 L11.6 22 L14.4 20.8 L11.5 14.6 L17.8 14.4 Z');
    arrow.setAttribute('fill', '#111');
    arrow.setAttribute('stroke', '#fff');
    arrow.setAttribute('stroke-width', '1.5');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    cursor.appendChild(svg);
    document.documentElement.appendChild(cursor);
  }
  cursor.style.transition = 'none';
  cursor.getBoundingClientRect(); // make the current position final before animating away from it
  if (ms > 0) cursor.style.transition = 'transform ' + ms + 'ms cubic-bezier(0.4, 0, 0.2, 1)';
  cursor.style.transform = at(to);
}

let cursorPoint = null; // where the virtual cursor sits (null until the first click)

// A full page load throws the cursor away, so put it back where it was
async function placeCursor(page) {
  if (!SHOW_CURSOR || !cursorPoint) return;
  try { await page.evaluate(moveCursorInPage, cursorPoint, cursorPoint, 0); } catch { /* decoration only */ }
}

// Glide the cursor to the middle of `el` and wait until it has arrived
async function glideCursor(page, el, ms) {
  if (!SHOW_CURSOR) return;
  try {
    await el.scrollIntoView();
    const box = await el.boundingBox();
    if (!box) return;
    const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.evaluate(moveCursorInPage, cursorPoint, to, ms);
    cursorPoint = to;
    if (ms > 0) await sleep(ms);
  } catch { /* the cursor is decoration; never fail a replay because of it */ }
}

// ---------- helpers ----------

// Text-based selectors (chips, menu items, ...) are evaluated inside the page by the same code the
// extension used while recording. It lives in extension/selector-engine.js.
let engine = null;
function engineSource() {
  if (!engine) {
    const file = path.join(__dirname, 'extension', 'selector-engine.js');
    try {
      engine = fs.readFileSync(file, 'utf8');
    } catch {
      throw new Error(`This recording uses text-based selectors, which need ${file}. Run the player from a full copy of the repository.`);
    }
  }
  return engine;
}

const describe = (sel) => (typeof sel === 'string' ? sel : JSON.stringify(sel));

// Look up one selector: a CSS string, or a text-based object
async function query(page, sel) {
  if (typeof sel === 'string') return page.$(sel);
  const handle = await page.evaluateHandle(`${engineSource()}\nctrFind(${JSON.stringify(sel)})`);
  const el = handle.asElement();
  if (!el) await handle.dispose();
  return el;
}

// Try every recorded selector (best first) until one matches a visible element.
async function find(page, selectors) {
  if (selectors.some((sel) => typeof sel !== 'string')) engineSource(); // fail early if the engine file is missing
  const deadline = Date.now() + FIND_TIMEOUT;
  for (;;) {
    for (const sel of selectors) {
      let el = null;
      try { el = await query(page, sel); } catch { /* invalid selector or page is navigating: skip it */ }
      if (!el) continue;
      let box = null;
      try { box = await el.boundingBox(); } catch { /* element vanished */ }
      if (box && box.width > 0 && box.height > 0) return el;
      await el.dispose();
    }
    if (Date.now() > deadline) throw new Error('Element not found: ' + selectors.map(describe).join('  |  '));
    await sleep(100);
  }
}

// Run an action and, if it triggers a full page load, wait for that load to finish.
async function withNavigation(page, nav, action) {
  if (nav) {
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: NAV_TIMEOUT }), action()]);
    await placeCursor(page);
  } else {
    await action();
  }
}

async function click(page, selectors, nav, travelMs) {
  let el = await find(page, selectors);
  if (SHOW_CURSOR) {
    await glideCursor(page, el, travelMs);
    el = await find(page, selectors); // the page may have re-rendered while the cursor was gliding
  }
  await withNavigation(page, nav, () => el.click());
}

// Types the value one character at a time, spread over the time the user originally took.
async function fill(page, selectors, value, durationMs) {
  const el = await find(page, selectors);
  await el.focus();
  await el.evaluate((n) => { try { n.select(); } catch { /* not a text field */ } }); // typing replaces old text
  if (value === '') {
    await page.keyboard.press('Backspace');
    return;
  }
  const chars = [...value];
  const step = chars.length > 1 ? (durationMs || 0) / (chars.length - 1) : 0;
  if (step === 0) {
    await page.keyboard.type(value); // it was pasted, not typed
    return;
  }
  for (let i = 0; i < chars.length; i++) {
    await page.keyboard.type(chars[i]);
    if (i < chars.length - 1) await sleep(step / SPEED);
  }
}

async function selectOption(page, selectors, value) {
  const el = await find(page, selectors);
  await el.select(value);
}

async function pressKey(page, key, nav) {
  await withNavigation(page, nav, () => page.keyboard.press(key));
}

// ---------- replay ----------

// Waits for any key press in the terminal. Ctrl+C cancels the replay.
function waitForKey(message) {
  return new Promise((resolve, reject) => {
    console.log(message);
    if (!process.stdin.isTTY) return resolve(); // input is piped, nobody to press a key
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once('data', (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (data[0] === 3) {
        // raw mode swallows Ctrl+C, so handle it here
        const err = new Error('Cancelled with Ctrl+C');
        err.cancelled = true;
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Does a full page load happen after events[i] and before the next action?
function causesNavigation(i) {
  for (let j = i + 1; j < events.length; j++) {
    if (events[j].type === 'navigate') return true;
    if (isAction(events[j])) return false;
  }
  return false;
}

async function replay(page) {
  const total = events.filter(isAction).length;
  let step = 0;
  let base = null;             // moment the next pause is measured from
  let started = false;         // has the first page been opened?
  let actionSinceLoad = true;  // was there an action since the last page load?
  let navExpected = false;     // an earlier action is already waiting for the next page load
  let justStarted = false;     // the user just pressed a key; the recorded pause is meaningless

  // Waits before an action. The last `lead` ms of the pause are not slept but left to the caller
  // (the cursor gliding to the click). Returns the whole pause and the part that was left over.
  const pause = async (t, lead = 0) => {
    let total;
    if (justStarted) {
      // The recorded pause includes time the player spent waiting for the key press, so use a fixed delay
      justStarted = false;
      total = START_DELAY;
    } else {
      total = base == null ? 0 : Math.max(0, t - base) / SPEED;
    }
    const travel = Math.min(lead, total);
    if (total >= 50 / SPEED && total > travel) await sleep(total - travel);
    return { total, travel };
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.type === 'navigate') {
      if (!started) {
        console.log(`Opening ${e.url}`);
        await page.goto(e.url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        started = true;
        await waitForKey('Page loaded. Press any key to start the replay...');
        await page.bringToFront(); // the terminal may be covering the browser now
        justStarted = true;
      } else if (actionSinceLoad && !navExpected) {
        // A page load that no click caused (typed URL or reload)
        await pause(e.t);
        console.log(`Opening ${e.url}`);
        await page.goto(e.url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        await placeCursor(page);
      }
      navExpected = false;
      base = e.t;
      actionSinceLoad = false;
      continue;
    }

    if (e.type === 'window') {
      // The first one was applied at launch; a later one means the window was resized while recording
      if (SIZE_WINDOW && e !== firstWindowEvent) await fitWindow(page, e);
      continue;
    }

    if (e.type === 'loaded') {
      // Think-time is measured from when the page finished loading
      if (!actionSinceLoad) base = e.t;
      continue;
    }

    if (!isAction(e)) continue;

    const lead = e.type === 'click' && SHOW_CURSOR ? CURSOR_TRAVEL / SPEED : 0;
    const { total: waited, travel } = await pause(e.t, lead);
    const nav = causesNavigation(i);
    const selectors = e.selectors || [];
    const isPassword = e.type === 'fill' && e.value === '__PASSWORD__';
    const shown = e.type === 'fill' ? (isPassword ? '••••' : JSON.stringify(e.value))
      : e.type === 'select' ? JSON.stringify(e.value)
      : e.type === 'key' ? e.key
      : e.text || '';
    console.log(`[${++step}/${total}] ${e.type} ${shown}`.trimEnd() + `  (after ${Math.round(waited)} ms)`);

    switch (e.type) {
      case 'click':
        await click(page, selectors, nav, travel);
        break;
      case 'fill': {
        let value = e.value;
        if (isPassword) {
          if (process.env.PASSWORD === undefined) console.warn('  PASSWORD is not set; typing nothing into the password field.');
          value = process.env.PASSWORD || '';
        }
        await fill(page, selectors, value, e.durationMs);
        break;
      }
      case 'select':
        await selectOption(page, selectors, e.value);
        break;
      case 'key':
        await pressKey(page, e.key, nav);
        break;
    }

    base = e.t + (e.durationMs || 0);
    actionSinceLoad = true;
    if (nav) navExpected = true;
  }
}

// ---------- window size ----------

// The recording notes the size of the page area at the start (and at every page load). The player makes
// its window match, so the site lays itself out the same way as when it was recorded.
const firstWindowEvent = SIZE_WINDOW ? events.find((e) => e.type === 'window') : undefined;

let warnedAboutSize = false;
let warnedAboutError = false;

// Resizes the window until the PAGE AREA (not the whole window, which also holds tabs and the address
// bar) is the recorded size. Only calls Chrome when the size is actually different.
// Returns { ok, bounds }: whether the page area ended up at the wanted size, and the final window bounds.
async function fitWindow(page, wanted) {
  let cdp;
  try {
    cdp = await (page.createCDPSession ? page.createCDPSession() : page.target().createCDPSession());
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const measure = () => page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
      availW: window.screen.availWidth,   // the part of the screen a window may use (without the taskbar)
      availH: window.screen.availHeight,
    }));
    const close = (m) => Math.abs(wanted.width - m.w) <= 1 && Math.abs(wanted.height - m.h) <= 1;

    let m = await measure();
    for (let attempt = 0; attempt < 3 && !close(m); attempt++) {
      const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
      // The window is the page area plus tabs and address bar: change it by exactly the difference.
      // Never ask for more than the screen has, and always place it at the top left so it is on screen.
      const width = Math.max(300, Math.min(bounds.width + (wanted.width - m.w), m.availW));
      const height = Math.max(200, Math.min(bounds.height + (wanted.height - m.h), m.availH));
      if (attempt > 0 && width === bounds.width && height === bounds.height) break; // already as close as the screen allows
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', left: 0, top: 0, width, height },
      });
      await sleep(200); // let the window settle
      m = await measure();
    }
    await page.bringToFront();
    const { bounds } = await cdp.send('Browser.getWindowBounds', { windowId });
    if (close(m)) return { ok: true, bounds };
    if (!warnedAboutSize) {
      warnedAboutSize = true;
      console.warn(`Could not make the page area ${wanted.width} x ${wanted.height} (it is ${m.w} x ${m.h}); the screen is probably too small.`);
    }
    return { ok: false, bounds };
  } catch (err) {
    // Resizing is a nicety; never fail a replay because of it, but do say what went wrong
    if (!warnedAboutError) {
      warnedAboutError = true;
      console.warn(`Could not resize the window: ${err.message}`);
    }
    return { ok: false, bounds: null };
  } finally {
    if (cdp) await cdp.detach().catch(() => {});
  }
}

// ---------- video recording ----------

// The player asks first whether to record the replay as a video (filmed with ffmpeg, which must be on
// your PATH, or set FFMPEG_PATH). Setting RECORD_VIDEO answers the question up front:
//   RECORD_VIDEO=on             record, with an automatic file name
//   RECORD_VIDEO=some\file.mp4     record to that file
//   RECORD_VIDEO=off            don't record
// Recording starts once the browser window is open and stops when the script ends: Ctrl+C, or closing the window.
const RECORD = (process.env.RECORD_VIDEO || '').trim();
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
let recordVideo = RECORD !== '' && !['off', 'no', 'false', '0'].includes(RECORD.toLowerCase());

let recorder = null; // { proc, file, exited, stopping } while a video is being recorded

function videoFile() {
  if (RECORD && !['on', 'yes', 'true', '1'].includes(RECORD.toLowerCase())) return path.resolve(RECORD);
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const stamp = `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} - ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const name = path.basename(file, path.extname(file));
  return path.join(path.dirname(path.resolve(file)), `${name} - replay ${stamp}.mp4`);
}

// ffmpeg's gdigrab finds a window by its exact title, so ask Windows for the browser window's title
async function windowTitle(pid) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const title = await new Promise((resolve) => {
      execFile(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).MainWindowTitle`],
        { windowsHide: true },
        (err, stdout) => resolve(err ? '' : String(stdout).trim())
      );
    });
    if (title) return title;
    await sleep(300); // the window may not have a title yet
  }
  return '';
}

// Why a video cannot be recorded here, or null if it can
function videoUnavailableReason() {
  if (process.platform !== 'win32') return 'video recording is only supported on Windows for now.';
  const probe = spawnSync(FFMPEG, ['-version'], { windowsHide: true });
  if (probe.error || probe.status !== 0) return `could not run "${FFMPEG}". Put ffmpeg on your PATH or set FFMPEG_PATH.`;
  return null;
}

// Asks a yes/no question in the terminal and waits for y or n followed by Enter
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('SIGINT', () => { rl.close(); process.exit(130); }); // Ctrl+C at the question
    rl.on('close', () => { if (!answered) resolve(false); });  // input ended without an answer
    const ask = () => rl.question(question, (text) => {
      const answer = text.trim().toLowerCase();
      if (answer === 'y' || answer === 'yes') { answered = true; rl.close(); resolve(true); }
      else if (answer === 'n' || answer === 'no') { answered = true; rl.close(); resolve(false); }
      else { console.log('Please type y or n, then press Enter.'); ask(); }
    });
    ask();
  });
}

// The first step of every replay: should it be filmed? (Skipped when RECORD_VIDEO is set, or when
// there is no terminal to ask in, for example when the player runs from a script.)
async function askAboutRecording() {
  if (RECORD !== '' || !process.stdin.isTTY) return;
  const why = videoUnavailableReason();
  if (why) {
    console.log(`(Video recording is not available: ${why})\n`);
    return;
  }
  recordVideo = await askYesNo('Record this replay as a video? (y/n, then Enter): ');
  console.log('');
}

// Where the browser window is on screen, in REAL pixels and across all monitors, straight from Windows:
// { left, top, right, bottom, virtual: { left, top, width, height } } where "virtual" is the area covered by
// all monitors together. Chrome's own numbers are not used because they are scaled by the display scaling
// and only know about one monitor. Returns null if Windows cannot say.
function windowRect(pid) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WinInfo {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out RECT rect, int size);
}
'@
# report real pixels on every monitor, not scaled ones (per-monitor aware; the older call is the fallback)
try { [void][WinInfo]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { [void][WinInfo]::SetProcessDPIAware() }
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 10 -and $h -eq [IntPtr]::Zero; $i++) {
  $h = (Get-Process -Id ${pid}).MainWindowHandle
  if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 300 }
}
if ($h -eq [IntPtr]::Zero) { exit 2 }
$r = New-Object WinInfo+RECT
# the visible frame of the window (without the invisible resize borders), or the plain window rectangle
if ([WinInfo]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) -ne 0) { [void][WinInfo]::GetWindowRect($h, [ref]$r) }
'{0} {1} {2} {3} {4} {5} {6} {7}' -f $r.Left, $r.Top, $r.Right, $r.Bottom, [WinInfo]::GetSystemMetrics(76), [WinInfo]::GetSystemMetrics(77), [WinInfo]::GetSystemMetrics(78), [WinInfo]::GetSystemMetrics(79)
`;
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 30000 },
      (err, stdout) => {
        const n = err ? [] : String(stdout).trim().split(/\s+/).map(Number);
        if (n.length !== 8 || n.some(Number.isNaN)) return resolve(null);
        resolve({ left: n[0], top: n[1], right: n[2], bottom: n[3], virtual: { left: n[4], top: n[5], width: n[6], height: n[7] } });
      }
    );
  });
}

// The size of everything ffmpeg captures when it films "desktop": ALL monitors together. Depending on the
// ffmpeg build and the display scaling it may count real pixels or scaled ones, so ask it.
function ffmpegDesktopSize() {
  const probe = spawnSync(
    FFMPEG,
    ['-hide_banner', '-f', 'gdigrab', '-framerate', '1', '-i', 'desktop', '-frames:v', '1', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  );
  const m = /Stream #0:0[^\n]*Video:[^\n]*?\b(\d{3,5})x(\d{3,5})\b/.exec(String(probe.stderr || ''));
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
}

// Method 1: film just the part of the desktop where the browser window is. Works for any window,
// including GPU-accelerated ones, as long as nothing is on top of it.
async function desktopInput(browser) {
  const pid = browser.process() && browser.process().pid;
  if (!pid) throw new Error('could not find the browser process');
  const rect = await windowRect(pid);
  if (!rect) throw new Error('could not read the window position from Windows');
  const desktop = ffmpegDesktopSize();
  if (!desktop) throw new Error('could not read the desktop size from ffmpeg');

  // ffmpeg's pixels per real pixel: 1 if it counts real pixels, less than 1 if it counts scaled ones.
  // Both the width and the height of all monitors together must agree, otherwise something is off.
  const k = desktop.w / rect.virtual.width;
  if (k <= 0.2 || k > 1.05 || Math.abs(desktop.h / rect.virtual.height - k) > 0.02) {
    throw new Error(`the desktop is ${desktop.w} x ${desktop.h} for ffmpeg but ${rect.virtual.width} x ${rect.virtual.height} for Windows`);
  }

  // The window's rectangle in ffmpeg's numbers, kept inside the desktop (which may start at a negative
  // position when a monitor sits to the left of, or above, the main one)
  const minX = Math.round(rect.virtual.left * k);
  const minY = Math.round(rect.virtual.top * k);
  const x0 = Math.max(minX, Math.round(rect.left * k));
  const y0 = Math.max(minY, Math.round(rect.top * k));
  const x1 = Math.min(minX + desktop.w, Math.round(rect.right * k));
  const y1 = Math.min(minY + desktop.h, Math.round(rect.bottom * k));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width < 100 || height < 100) throw new Error(`the window area looks wrong (${width} x ${height})`);
  return {
    label: `desktop area ${width} x ${height} at ${x0},${y0}`,
    args: ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-offset_x', String(x0), '-offset_y', String(y0), '-video_size', `${width}x${height}`, '-i', 'desktop'],
  };
}

// Method 2: film the window itself, found by its title. Nothing can cover it, but some GPU-accelerated
// windows cannot be captured this way.
async function titleInput(browser) {
  const pid = browser.process() && browser.process().pid;
  const title = pid ? await windowTitle(pid) : '';
  if (!title) throw new Error('could not find the title of the browser window');
  return {
    label: `window "${title}"`,
    args: ['-f', 'gdigrab', '-framerate', '30', '-draw_mouse', '0', '-i', `title=${title}`],
  };
}

// Starts ffmpeg on the given input and returns { proc, file, exited, stopping, lastLines }
function launchFfmpeg(inputArgs, out) {
  const proc = spawn(
    FFMPEG,
    [
      '-y',
      ...inputArgs,
      '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2', // H.264 needs an even width and height
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof', // stays playable even if the recording is cut short
      out,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
  );
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  proc.stdin.on('error', () => {});
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  const lastLines = (n = 4) => stderr.trim().split(/\r?\n/).filter(Boolean).slice(-n).join(' | ') || '(no message)';
  return { proc, file: out, exited, stopping: false, lastLines };
}

// RECORD_MODE=desktop or RECORD_MODE=title picks one method; by default the desktop method is tried first
const RECORD_MODE = (process.env.RECORD_MODE || '').trim().toLowerCase();

async function startRecording(browser) {
  if (!recordVideo) return;
  const skip = (why) => console.warn(`Not recording a video: ${why}`);
  const why = videoUnavailableReason();
  if (why) return skip(why);

  const out = videoFile();
  const methods = RECORD_MODE === 'title' ? ['title'] : RECORD_MODE === 'desktop' ? ['desktop'] : ['desktop', 'title'];
  const problems = [];

  for (const method of methods) {
    let input;
    try {
      input = method === 'desktop' ? await desktopInput(browser) : await titleInput(browser);
    } catch (err) {
      problems.push(`${method}: ${err.message}`);
      continue;
    }
    const r = launchFfmpeg(input.args, out);
    // If ffmpeg cannot start on this input it exits right away: report why and try the next method
    const early = await Promise.race([r.exited, sleep(1500).then(() => null)]);
    if (early !== null) {
      problems.push(`${method} (${input.label}): ${r.lastLines()}`);
      continue;
    }

    recorder = r;
    r.exited.then(() => {
      if (!r.stopping) console.warn(`\nffmpeg stopped unexpectedly: ${r.lastLines()}`);
    });
    console.log(`Recording video (${input.label}): ${out}`);
    browser.on('disconnected', () => { stopRecording(); }); // the window was closed
    process.on('exit', () => { // last resort: tell ffmpeg to finish even if we did not get to do it properly
      if (!r.stopping) { try { r.proc.stdin.write('q'); } catch { /* already gone */ } }
    });
    return;
  }
  skip(`\n  ${problems.join('\n  ')}`);
}

// Asks ffmpeg to finish, so the video file is complete
async function stopRecording() {
  const r = recorder;
  if (!r || r.stopping) return;
  r.stopping = true;
  try { r.proc.stdin.write('q'); r.proc.stdin.end(); } catch { /* already gone */ }
  const finished = await Promise.race([r.exited.then(() => true), sleep(10000).then(() => false)]);
  if (!finished) r.proc.kill();
  console.log(`Video saved: ${r.file}`);
}

// ---------- finding Chrome ----------

// Puppeteer wants one specific Chrome version and fails if it isn't installed. Instead of failing,
// fall back to whatever Chrome is already on this machine.

// Newest Chrome that Puppeteer has downloaded into its cache (~/.cache/puppeteer/chrome/<platform>-<version>/...)
function findCachedChrome() {
  const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
  const root = path.join(cacheDir, 'chrome');
  let builds;
  try { builds = fs.readdirSync(root); } catch { return null; }

  // "win64-150.0.7871.24" -> [150, 0, 7871, 24], newest first
  const version = (name) => name.replace(/^[^-]*-/, '').split('.').map(Number);
  const newestFirst = (a, b) => {
    const [x, y] = [version(a), version(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    }
    return 0;
  };

  const exeNames = [
    ['chrome.exe'],                                                                         // Windows
    ['chrome'],                                                                             // Linux
    ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],    // macOS
  ];
  for (const build of builds.sort(newestFirst)) {
    const buildDir = path.join(root, build);
    let subdirs;
    try { subdirs = fs.readdirSync(buildDir); } catch { continue; }
    for (const sub of subdirs) {
      for (const exe of exeNames) {
        const candidate = path.join(buildDir, sub, ...exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

// Regular Google Chrome / Chromium installs
function findSystemChrome() {
  const env = process.env;
  const candidates = {
    win32: [
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env.PROGRAMFILES && path.join(env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      env['PROGRAMFILES(X86)'] && path.join(env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// Order: PUPPETEER_EXECUTABLE_PATH, the version Puppeteer expects, any cached Chrome, installed Chrome.
async function chooseChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    // In current Puppeteer versions executablePath() is asynchronous, so it has to be awaited
    const expected = await puppeteer.executablePath();
    if (typeof expected === 'string' && expected && fs.existsSync(expected)) return expected;
  } catch { /* no default available */ }
  return findCachedChrome() || findSystemChrome();
}

(async () => {
  // Finding Chrome prints nothing, so the question below really is the first thing you see
  const executablePath = await chooseChrome();
  if (!executablePath) {
    console.error(
      'Could not find Chrome. Either:\n' +
      '  - run  npx puppeteer browsers install chrome\n' +
      '  - or set PUPPETEER_EXECUTABLE_PATH to the location of chrome.exe'
    );
    process.exit(1);
  }

  await askAboutRecording(); // step 1: film this replay?
  console.log(`Using Chrome: ${executablePath}`);

  const browser = await puppeteer.launch({ executablePath, headless: false, defaultViewport: null, args: ['--start-maximized'], handleSIGINT: false });

  // Ctrl+C: finish the video first, then close the browser
  process.on('SIGINT', async () => {
    console.log('\nStopping...');
    await stopRecording();
    await browser.close().catch(() => {});
    process.exit(130);
  });

  try {
    const [first] = await browser.pages();
    const page = first || (await browser.newPage());
    await page.bringToFront();
    if (firstWindowEvent) {
      // The window starts maximized; now shrink it to the recorded size
      const { ok, bounds } = await fitWindow(page, firstWindowEvent);
      const at = bounds ? ` (window ${bounds.width} x ${bounds.height} at ${bounds.left}, ${bounds.top})` : '';
      if (ok) console.log(`Window: page area ${firstWindowEvent.width} x ${firstWindowEvent.height}, as recorded${at}`);
    }
    await startRecording(browser); // the window is open and sized: start filming
    if (SHOW_CLICKS) await page.evaluateOnNewDocument(installClickIndicator); // active on every page we open from here on
    await replay(page);
    console.log('Done. The browser stays open; close it (or press Ctrl+C) to exit.');
  } catch (err) {
    console.error('\nReplay failed: ' + err.message);
    process.exitCode = 1;
    if (err.cancelled) {
      await stopRecording();
      await browser.close();
    } else {
      console.error('The browser was left open so you can see where it stopped. Close it (or press Ctrl+C) to exit.');
    }
  }
})();
