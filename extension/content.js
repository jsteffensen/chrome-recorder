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
  const isUnique = (sel) => {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  };
  const attrValue = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const ATTRS = ['data-testid', 'data-test', 'data-cy', 'data-qa', 'name', 'aria-label', 'placeholder', 'title', 'alt'];

  function cssPath(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      if (el.id && !/\d{4,}/.test(el.id) && isUnique('#' + CSS.escape(el.id))) {
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

  // Several ways to find the same element, best first. The replay tries them in order.
  function candidates(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    if (el.id && !/\d{4,}/.test(el.id)) {
      const sel = '#' + CSS.escape(el.id);
      if (isUnique(sel)) out.push(sel);
    }
    for (const attr of ATTRS) {
      const v = el.getAttribute(attr);
      if (!v || v.length > 80 || /[\n\r]/.test(v)) continue;
      const sel = tag + '[' + attr + '="' + attrValue(v) + '"]';
      if (isUnique(sel)) out.push(sel);
    }
    out.push(cssPath(el));
    return [...new Set(out)];
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

  function onClick(e) {
    if (!e.isTrusted) return;
    const raw = e.target instanceof Element ? e.target : e.target.parentElement;
    if (!raw) return;
    const el = raw.closest(INTERACTIVE) || raw;
    const now = Date.now();

    // Clicking a <label> makes the browser click its input too; keep only the first.
    if (el.tagName === 'LABEL') lastLabel = { el, now };
    else if (lastLabel && lastLabel.el.control === el && now - lastLabel.now < 100) return;

    send({ type: 'click', selectors: candidates(el), text: labelOf(el) });
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
    document.addEventListener('click', onClick, true);
    document.addEventListener('input', onInput, true);
    document.addEventListener('change', onChange, true);
    document.addEventListener('keydown', onKeyDown, true);
  }

  function stop() {
    if (!listening) return;
    listening = false;
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
