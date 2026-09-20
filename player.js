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
const NAV_TIMEOUT = 30000;  // how long to wait for a page load
const START_DELAY = 200;    // ms between the key press and the first action (fixed, not affected by SPEED)

const ACTIONS = new Set(['click', 'fill', 'select', 'key']);
const isAction = (e) => ACTIONS.has(e.type);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (nav) await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: NAV_TIMEOUT }), action()]);
  else await action();
}

async function click(page, selectors, nav) {
  const el = await find(page, selectors);
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

  // Waits before an action and returns how many ms it actually waited
  const pause = async (t) => {
    if (justStarted) {
      // The recorded pause includes time the player spent waiting for the key press, so use a fixed delay
      justStarted = false;
      await sleep(START_DELAY);
      return START_DELAY;
    }
    const ms = base == null ? 0 : Math.max(0, t - base) / SPEED;
    if (ms >= 50 / SPEED) await sleep(ms);
    return ms;
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

    const waited = await pause(e.t);
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
        await click(page, selectors, nav);
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
    await replay(page);
    console.log('Done. The browser stays open; close it (or press Ctrl+C) to exit.');
  } catch (err) {
    console.error('\nReplay failed: ' + err.message);
    process.exitCode = 1;
    if (err.cancelled) await browser.close();
    else console.error('The browser was left open so you can see where it stopped. Close it (or press Ctrl+C) to exit.');
  }
})();
