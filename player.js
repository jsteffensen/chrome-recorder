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

const ACTIONS = new Set(['click', 'fill', 'select', 'key']);
const isAction = (e) => ACTIONS.has(e.type);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------

// Try every recorded selector (best first) until one matches a visible element.
async function find(page, selectors) {
  const deadline = Date.now() + FIND_TIMEOUT;
  for (;;) {
    for (const sel of selectors) {
      let el = null;
      try { el = await page.$(sel); } catch { /* invalid selector: skip it */ }
      if (!el) continue;
      let box = null;
      try { box = await el.boundingBox(); } catch { /* element vanished */ }
      if (box && box.width > 0 && box.height > 0) return el;
      await el.dispose();
    }
    if (Date.now() > deadline) throw new Error('Element not found: ' + selectors.join('  |  '));
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

  const pause = async (t) => {
    const ms = base == null ? 0 : Math.max(0, t - base);
    if (ms >= 50) await sleep(ms / SPEED);
    return ms;
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];

    if (e.type === 'navigate') {
      if (!started) {
        console.log(`Opening ${e.url}`);
        await page.goto(e.url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
        started = true;
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
    console.log(`[${++step}/${total}] ${e.type} ${shown}`.trimEnd() + `  (after ${Math.round(waited / SPEED)} ms)`);

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

(async () => {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ['--start-maximized'] });
  try {
    const [first] = await browser.pages();
    const page = first || (await browser.newPage());
    await replay(page);
    await sleep(1000);
    console.log('Done.');
  } catch (err) {
    console.error('\nReplay failed: ' + err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
