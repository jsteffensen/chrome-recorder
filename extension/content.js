// Content script: runs in every page, but only records while the popup
// has started a recording for this tab.
(() => {
  let listening = false;
  let lastLabel = null;            // label click just seen (browser forwards a 2nd click to its input)
  const typing = new WeakMap();    // text field -> { first, last } timestamps of the current typing burst

  // ---------- sending ----------
  function send(evt) {
    try {
      chrome.runtime
        .sendMessage({ kind: 'event', evt: { t: Date.now(), url: location.href, ...evt } })
        .catch(() => {});
    } catch (_) {
      /* extension was reloaded; ignore */
    }
  }

  // ---------- selectors ----------
  // ctrText / ctrQueryAll come from selector-engine.js (loaded before this file)
  const isUnique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  };
  const attrValue = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'formcontrolname', 'name', 'aria-label', 'placeholder', 'title', 'alt'];

  // Ids made up at runtime (mat-mdc-chip-0, cdk-overlay-3, :r1:, ...) differ between visits, so never rely on them.
  const isGeneratedId = (id) => /\d{4,}/.test(id) || /^(mat|cdk|mdc)[-_].*\d/.test(id) || /^:.*:$/.test(id);

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && !isGeneratedId(el.id) && isUnique('#' + CSS.escape(el.id))) {
        parts.unshift('#' + CSS.escape(el.id));
        break;
      }
      let part = el.tagName.toLowerCase();
      const parent = el.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.tagName === el.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
      el = parent;
    }
    return parts.join(' > ');
  }

  // CSS selectors built from a stable id or attribute that is unique on the page right now
  function attrCandidates(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    if (el.id && !isGeneratedId(el.id)) {
      const sel = '#' + CSS.escape(el.id);
      if (isUnique(sel)) out.push(sel);
    }
    for (const attr of ATTRS) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 80 || /[\n\r]/.test(v)) continue;
      const sel = tag + '[' + attr + '="' + attrValue(v) + '"]';
      if (isUnique(sel)) out.push(sel);
    }
    return out;
  }

  // A text-based selector (see selector-engine.js) for `el`. When several visible elements match
  // the same css + text, "nth" says which one it was.
  function textSpec(el, css, text, scope) {
    const spec = { css, text };
    if (scope) spec.in = scope;
    const all = ctrQueryAll(spec);
    if (all.length > 1 && all.indexOf(el) >= 0) spec.nth = all.indexOf(el);
    return spec;
  }

  // Buttons and links with a label: match by that label, but only if it is unique on the page
  function genericTextSelector(el) {
    if (el.tagName !== 'A' && el.tagName !== 'BUTTON') return [];
    const text = ctrText(el);
    if (!text || text.length > 200) return [];
    const spec = { css: el.tagName.toLowerCase(), text };
    const all = ctrQueryAll(spec);
    return all.length === 1 && all[0] === el ? [spec] : [];
  }

  // Every way to find `el`, best first. The replay tries them in order.
  function candidates(el) {
    const all = [...attrCandidates(el), ...genericTextSelector(el), cssPath(el)];
    const seen = new Set();
    return all.filter((s) => {
      const key = JSON.stringify(s);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // ---------- Angular Material ----------
  // Chips, options, menu items, tabs and list items are identified by their text, not by their position:
  // they can appear in a different order next time, and their ids (mat-mdc-chip-0) are made up at runtime.
  // There is deliberately no position-based fallback, so a missing item fails loudly instead of
  // clicking a different one.
  const CHIP = 'mat-chip, mat-chip-row, mat-chip-option, mat-basic-chip, .mat-mdc-chip';
  const CHIP_REMOVE = '[matchipremove], .mat-mdc-chip-remove, .mat-chip-remove';
  const CHIP_LABEL = '.mdc-evolution-chip__text-label, .mat-mdc-chip-action-label';
  const OPTION = 'mat-option, .mat-mdc-option, mat-list-option, .mat-mdc-list-option';
  const MENU_ITEM = '.mat-mdc-menu-item, [mat-menu-item]';
  const TAB = '[role="tab"]';
  const LIST_ITEM = 'mat-list-item, .mat-mdc-list-item';
  const LIST_TITLE = '.mdc-list-item__primary-text, [matListItemTitle]';

  function materialTarget(raw) {
    const chip = raw.closest(CHIP);
    if (chip) {
      const label = chip.querySelector(CHIP_LABEL);
      const text = ctrText(label || chip);
      if (text) {
        const chipSpec = textSpec(chip, CHIP, text);
        if (raw.closest(CHIP_REMOVE)) {
          return { text: 'remove ' + text, selectors: [{ css: CHIP_REMOVE, in: chipSpec }] };
        }
        return {
          text: text,
          selectors: [
            ...(label ? [textSpec(label, CHIP_LABEL, text)] : []),
            chipSpec,
            ...attrCandidates(chip),
          ],
        };
      }
    }

    for (const css of [OPTION, MENU_ITEM, TAB]) {
      const el = raw.closest(css);
      if (!el) continue;
      const text = ctrText(el);
      if (text) return { text: text, selectors: [textSpec(el, css, text)] };
    }

    const item = raw.closest(LIST_ITEM);
    if (item) {
      const text = ctrText(item);
      if (text) {
        const selectors = [textSpec(item, LIST_ITEM, text)];
        const title = item.querySelector(LIST_TITLE);
        const titleText = title ? ctrText(title) : '';
        if (titleText && titleText !== text) selectors.push(textSpec(title, LIST_TITLE, titleText));
        return { text: text.slice(0, 50), selectors };
      }
    }
    return null;
  }

  // Short human-readable name, only used as a comment in the generated script.
  function labelOf(el) {
    const tag = el.tagName;
    let s = '';
    if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) s = el.value;
    else if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
      s = el.getAttribute('aria-label') || el.placeholder || el.name || '';
    else s = el.innerText || el.getAttribute('aria-label') || el.title || '';
    return String(s).replace(/\s+/g, ' ').trim().slice(0, 50);
  }

  // ---------- event handlers ----------
  const INTERACTIVE =
    'a,button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[onclick]';

  // Records one click. Returns true if something was recorded.
  function recordClick(e) {
    const raw = e.target instanceof Element ? e.target : e.target.parentElement;
    if (!raw) return false;
    const material = materialTarget(raw);
    if (material) {
      send({ type: 'click', selectors: material.selectors, text: material.text });
      return true;
    }

    const el = raw.closest(INTERACTIVE) || raw;
    const now = Date.now();

    // Clicking a <label> makes the browser click its input too; keep only the first.
    if (el.tagName === 'LABEL') lastLabel = { el, now };
    else if (lastLabel && lastLabel.el.control === el && now - lastLabel.now < 100) return false;

    send({ type: 'click', selectors: candidates(el), text: labelOf(el) });
    return true;
  }

  // A press on a scrollbar has the scrolled element as its target, but is not a click on it.
  function onScrollbar(e) {
    const t = e.target;
    if (!(t instanceof Element) || t.clientWidth === 0 || t.clientHeight === 0) return false;
    if (t.scrollHeight <= t.clientHeight && t.scrollWidth <= t.clientWidth) return false;
    const r = t.getBoundingClientRect();
    return e.clientX > r.left + t.clientLeft + t.clientWidth || e.clientY > r.top + t.clientTop + t.clientHeight;
  }

  // Clicks are recorded when the mouse button goes DOWN, not when the click event fires.
  // Many apps (dropdown results, autocomplete lists) act on mousedown and remove the element before
  // the button is released, so no click event ever arrives.
  let mouseRecorded = false; // this press was already recorded, so its click event must be ignored

  function onMouseDown(e) {
    mouseRecorded = false;
    if (!e.isTrusted || e.button !== 0 || onScrollbar(e)) return;
    // The browser fires blur/change on the field being left only AFTER mousedown,
    // so log what was typed into it first to keep the steps in the right order.
    const active = document.activeElement;
    if (active && active !== e.target) recordFill(active);
    mouseRecorded = recordClick(e);
  }

  function onClick(e) {
    if (!e.isTrusted) return;
    if (e.detail > 0 && mouseRecorded) { // the release of a press we already recorded
      mouseRecorded = false;
      if (lastLabel && lastLabel.el.contains(e.target)) lastLabel.now = Date.now();
      return;
    }
    recordClick(e); // keyboard-triggered clicks (Enter/Space on a button) have no mousedown
  }

  function isTextField(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement)
      return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range', 'color'].includes(el.type);
    return false;
  }

  function onInput(e) {
    const el = e.target;
    if (!isTextField(el)) return;
    const now = Date.now();
    const s = typing.get(el);
    if (s) s.last = now;
    else typing.set(el, { first: now, last: now });
  }

  // Emits one "fill" per typing burst, timestamped at the first keystroke.
  function recordFill(el) {
    if (!isTextField(el)) return;
    const s = typing.get(el);
    if (!s) return;
    typing.delete(el);
    const isPassword = el.type === 'password';
    send({
      type: 'fill',
      t: s.first,
      durationMs: s.last - s.first,
      selectors: candidates(el),
      value: isPassword ? '__PASSWORD__' : el.value,
      text: labelOf(el),
    });
  }

  function onChange(e) {
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      send({ type: 'select', selectors: candidates(el), value: el.value, text: labelOf(el) });
    } else {
      recordFill(el);
    }
  }

  const KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
  function onKeyDown(e) {
    if (!e.isTrusted || e.repeat || !KEYS.has(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    const el = e.target;
    recordFill(el); // make sure typed text is logged before the key press
    // Enter on a button/link is turned into a click by the browser, which is already recorded.
    if (
      e.key === 'Enter' &&
      el instanceof Element &&
      el.closest('button,a,summary,[role="button"],[role="link"],input[type="button"],input[type="submit"],input[type="checkbox"],input[type="radio"]')
    )
      return;
    send({ type: 'key', key: e.key });
  }

  // ---------- start / stop ----------
  function start() {
    if (listening) return;
    listening = true;
    send({ type: 'navigate' });
    if (document.readyState === 'complete') send({ type: 'loaded' });
    else window.addEventListener('load', () => send({ type: 'loaded' }), { once: true });
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stop() {
    if (!listening) return;
    listening = false;
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('keydown', onKeyDown, true);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.kind === 'start') start();
    if (msg.kind === 'stop') stop();
    sendResponse({ ok: true });
  });

  // A new page loaded: are we in the middle of a recording?
  try {
    chrome.runtime
      .sendMessage({ kind: 'content-status' })
      .then((res) => { if (res && res.recording) start(); })
      .catch(() => {});
  } catch (_) {
    /* extension was reloaded; ignore */
  }
})();
