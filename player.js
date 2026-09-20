#!/usr/bin/env node
// Replays a recording made by the Chrome Recorder extension with Puppeteer,
// keeping the original pauses between actions.
//
//   node player.js recording.json
//
// Optional environment variables:
//   SPEED=2       replay at twice the recorded speed (0.5 = half speed)
//   PASSWORD=...  text typed into password fields (passwords are never stored in a recording)

const fs = require('fs');
const os = require('os');
const path = require('path');

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
function chooseChrome() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    const expected = puppeteer.executablePath();
    if (expected && fs.existsSync(expected)) return expected;
  } catch { /* no default available */ }
  return findCachedChrome() || findSystemChrome();
}

(async () => {
  const executablePath = chooseChrome();
  if (!executablePath) {
    console.error(
      'Could not find Chrome. Either:\n' +
      '  - run  npx puppeteer browsers install chrome\n' +
      '  - or set PUPPETEER_EXECUTABLE_PATH to the location of chrome.exe'
    );
    process.exit(1);
  }
  console.log(`Using Chrome: ${executablePath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized'],
  });
  try {
    const [first] = await browser.pages();
    const page = first || (await browser.newPage());
    if (SHOW_CLICKS) await page.evaluateOnNewDocument(installClickIndicator); // active on every page we open from here on
    await replay(page);
    console.log('Done. The browser stays open; close it (or press Ctrl+C) to exit.');
  } catch (err) {
    console.error('\nReplay failed: ' + err.message);
    process.exitCode = 1;
    if (err.cancelled) await browser.close();
    else console.error('The browser was left open so you can see where it stopped. Close it (or press Ctrl+C) to exit.');
  }
})();
