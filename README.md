# Chrome Recorder

Record your clicks, typing and **timing** in Chrome, then replay them with [Puppeteer](https://pptr.dev) at the same pace.

Chrome's built-in DevTools Recorder can export Puppeteer scripts, but it throws away the time between your actions. This extension keeps it, and it keeps recording across page loads.

```
 Chrome extension                 convert.mjs                 Puppeteer
┌──────────────────┐  recording  ┌───────────────┐  replay   ┌──────────────┐
│ click, type,     │───────────▶│ recording.json │──────────▶│ node replay  │
│ navigate + time  │   .json     │  → replay.mjs  │   .mjs    │ same pacing  │
└──────────────────┘             └───────────────┘           └──────────────┘
```

## Quick start

**1. Get the code**

```bash
git clone https://github.com/jsteffensen/chrome-recorder
cd chrome-recorder
```

**2. Install the extension**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.

**3. Record**

1. Open the page you want to automate and **reload it once**, so the recorder can attach to it.
2. Click the extension icon, then **Start recording this tab**. A red `REC` badge appears.
3. Use the site normally, including actions that load new pages.
4. Click the icon again, then **Stop & download**. This saves `recording.json`.

**4. Convert and replay**

```bash
node convert.mjs recording.json replay.mjs
npm i puppeteer
node replay.mjs
```

Requires Node.js 18 or newer.

## What gets recorded

| Action | What is saved |
| --- | --- |
| Click | Several selectors for the element (see below) |
| Typing in a text field | The final value, plus how long you took to type it |
| Dropdown (`<select>`) | The chosen value |
| Enter, Tab, Escape, arrow keys | The key |
| Page load | The URL and when the page finished loading |

Every event carries a millisecond timestamp.

**Selectors.** Each clicked element is saved with a list of ways to find it, best first: a unique `id`, then `data-testid` / `data-test` / `data-cy` / `data-qa` / `name` / `aria-label` / `placeholder` / `title` / `alt` when unique, and finally a full CSS path as the last resort. The replay tries them in order until one matches.

## How timing works

`convert.mjs` turns the gaps between your actions into `sleep()` calls:

- Between two actions on the same page, it waits as long as you did.
- If an action loaded a new page, the replay waits for the load, and your pause is measured from when the page **finished loading**. Slow page loads therefore aren't added on top of your original pacing.
- Typing is replayed at roughly your typing speed.

The generated script is plain, editable code:

```js
await page.goto("https://example.com/login", { waitUntil: 'load' });
await sleep(2200);
// fill: user
await fill(page, ["#user", "input[name=\"user\"]"], "alice", 375);
await sleep(500);
// fill: pw
await fill(page, ["#pw"], process.env.PASSWORD, 80);
await sleep(1100);
// click: Sign in
await click(page, ["#login", "form > button"], { nav: true });
await sleep(3000);
// click: Settings
await click(page, ["a[title=\"Settings\"]"]);
```

### Options

| Variable | Effect |
| --- | --- |
| `SPEED=2 node replay.mjs` | Replay at twice the recorded speed (`0.5` = half speed) |
| `PASSWORD=... node replay.mjs` | Value typed into password fields (see Privacy) |

## Works with

- `http://` and `https://` sites, including `localhost` and other local or LAN addresses.
- Sites with a self-signed certificate: add `acceptInsecureCerts: true` to the `puppeteer.launch(...)` call in `replay.mjs`.
- `file://` pages: enable **Allow access to file URLs** in the extension's details page.

The replay starts a fresh Chrome profile, so it has no cookies or login. If the site needs a login, record the login steps too.

## Privacy

- Everything stays on your machine. The extension makes no network requests.
- The recording is kept in the extension's local storage until you start a new one, and is written to disk only when you click download.
- **Password fields are never recorded.** The recording contains a placeholder, and the replay reads the real value from the `PASSWORD` environment variable.
- **Other typed text is saved in plain text** in `recording.json`. Don't share recordings that contain anything sensitive.
- The content script is loaded on every page (`<all_urls>`) so it can start recording after a page load, but it only listens and reports events for the one tab you chose to record.

## Limitations

- One tab and top-level frame only. Popups, new tabs, iframes and shadow DOM are not recorded.
- Not recorded: scrolling, hover-only menus, drag and drop, file uploads, right clicks, keyboard shortcuts and the back/forward buttons.
- Route changes in single-page apps aren't logged as page loads. The replay simply waits for the next element to appear, which usually works.
- Selectors can break on sites that generate ids or class names on every build. Edit the selectors in `replay.mjs` by hand if a step can't find its element.
- A dev server that does a full reload while you record will add an unexpected `page.goto(...)` line marked `// page loaded without a click`. Delete it and the sleep before it.
- If you drive a page load with the keyboard, the recorder saves the Enter key, and the replay waits for the load.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| "Could not attach to this page" | Reload the page and start again. `chrome://` pages and the Chrome Web Store can't be recorded. |
| `Element not found: ...` during replay | The page changed or the selector is unstable. Open `replay.mjs` and adjust that step's selector list. |
| Recording has fewer events than expected | Make sure you reloaded the page after installing or reloading the extension, and that the actions happened in the recorded tab. |
| Replay is slower than the recording | Puppeteer also waits for elements and page loads. Use `SPEED=1.5` to compensate. |

## Project layout

```
extension/
  manifest.json    Manifest V3 configuration
  content.js       Records clicks, typing, keys, URLs and timestamps in the page
  background.js    Service worker that stores the recording state and events
  popup.html/js    Start / stop / download buttons
convert.mjs        Turns recording.json into a Puppeteer script
```

## Contributing

Issues and pull requests are welcome. Ideas for future versions: scroll and hover recording, iframe support, multiple tabs, and `@puppeteer/replay` JSON output.