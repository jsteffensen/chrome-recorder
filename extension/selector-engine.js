// Text-based selectors, shared by the extension (content.js) and the player (player.js),
// so recording and replay interpret them identically.
//
// A text-based selector is an object inside a step's "selectors" list:
//
//   { "css": ".mdc-evolution-chip__text-label", "text": "#review-needed" }
//       -> the visible element matching the CSS whose text is exactly "#review-needed"
//   { "css": "[matchipremove]", "in": { "css": ".mat-mdc-chip", "text": "#review-needed" } }
//       -> the remove button inside the chip whose text is "#review-needed"
//   add "nth": 1 to pick the 2nd match when several elements share the same text
//
// Plain script: only function declarations, no imports, so it can be loaded as a content script
// and also evaluated inside a page by Puppeteer.

// Visible text of an element: icons (mat-icon ligatures like "cancel"), svg and aria-hidden parts are
// left out, and whitespace is collapsed.
function ctrText(el) {
  var clone = el.cloneNode(true);
  clone
    .querySelectorAll('mat-icon, .mat-icon, .material-icons, .material-symbols-outlined, svg, script, style, [aria-hidden="true"]')
    .forEach(function (n) { n.remove(); });
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

function ctrIsVisible(el) {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// All visible elements the selector matches, in document order
function ctrQueryAll(spec, root) {
  root = root || document;
  var scopes = spec.in ? ctrQueryAll(spec.in, root) : [root];
  var out = [];
  scopes.forEach(function (scope) {
    scope.querySelectorAll(spec.css).forEach(function (el) {
      if (out.indexOf(el) !== -1) return;
      if (spec.text !== undefined && ctrText(el) !== spec.text) return;
      if (ctrIsVisible(el)) out.push(el);
    });
  });
  return out;
}

// The element the selector points at, or null
function ctrFind(spec) {
  return ctrQueryAll(spec)[spec.nth || 0] || null;
}
