/** @type {Set<ShadowRoot>} Shadow roots tracked for locale changes. */
const shadowRoots = new Set();

/** @type {string} The currently active locale code. */
let currentLocale =
  (typeof document !== 'undefined' ? document.documentElement.lang : 'en') || 'en';

/**
 * Register a shadow root so locale changes propagate into it.
 * @param {ShadowRoot} root
 */
export function registerShadowRoot(root) {
  shadowRoots.add(root);
}

/**
 * Remove a shadow root from locale tracking.
 * @param {ShadowRoot} root
 */
export function unregisterShadowRoot(root) {
  shadowRoots.delete(root);
}

/**
 * Change the active locale, update the document lang attribute,
 * and re-apply i18n visibility across all tracked roots.
 * @param {string} locale - Language code, e.g. `"en"`, `"fr"`, `"es"`.
 */
export function setLocale(locale) {
  currentLocale = locale;
  document.documentElement.lang = locale;
  applyI18n(document);
  for (const root of shadowRoots) {
    applyI18n(root);
  }
}

/**
 * Show or hide `[xml:lang]` elements within a root based on the current locale.
 * @param {Document|ShadowRoot} root - DOM root to apply i18n visibility to.
 */
export function applyI18n(root) {
  for (const el of root.querySelectorAll('[xml\\:lang]')) {
    const lang = el.getAttribute('xml:lang');
    if (lang) {
      el.hidden = lang !== currentLocale;
    }
  }
}

/**
 * Apply updated label text from a labels map to all `[typeof]` elements
 * across the document and registered shadow roots.
 * @param {Record<string, Record<string, string>>} labels - Map of subject URI to language→text.
 */
export function updateLabels(labels) {
  const roots = [document, ...shadowRoots];
  for (const root of roots) {
    for (const el of root.querySelectorAll('[typeof]')) {
      const term = el.getAttribute('typeof');
      if (term === 'Person') continue;
      const vocab = el.closest('[vocab]')?.getAttribute('vocab') ?? 'https://schema.org/';
      const uri = vocab + term;
      const langMap = labels[uri];
      if (!langMap) continue;

      if (el.tagName === 'INPUT' || el.tagName === 'IMG') {
        const text = langMap[currentLocale] ?? langMap['en'] ?? '';
        if (text) el.placeholder = text;
      } else {
        for (const span of el.querySelectorAll('[property="rdfs:label"][xml\\:lang]')) {
          const lang = span.getAttribute('xml:lang');
          if (lang && langMap[lang] !== undefined) {
            span.textContent = langMap[lang];
          }
        }
      }
    }
  }
}

/**
 * Open an SSE connection and update labels whenever a `labels` event arrives.
 * @param {string} url - The SSE endpoint URL (e.g. `"/api/events"`).
 */
export function connectLabelStream(url) {
  const source = new EventSource(url);
  source.addEventListener('labels', (e) => {
    updateLabels(JSON.parse(e.data));
  });
}
