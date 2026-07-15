import { DOMParser } from '@b-fuze/deno-dom';
import { SCHEMA, type Labels } from './rdf.ts';
import { transform } from '../src/utils/transform.js';

/** Absolute path to the templates directory, resolved from this module's URL. */
const TEMPLATES_DIR = new URL('../templates/', import.meta.url).pathname;

/** HTML elements that are void (self-closing) and receive placeholders instead of inner text. */
const VOID_TAGS = new Set(['INPUT', 'IMG']);

const domParser = new DOMParser();

/** Parse an HTML string into a DOM document using deno-dom. */
function parse(html: string) {
  return domParser.parseFromString(html, 'text/html')!;
}

/** Escape a value for safe inclusion in HTML text and attributes. */
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Generate multilingual `<span>` elements for a subject's rdfs:label values. */
function labelSpans(subject: string, labels: Labels): string {
  const langMap = labels.get(subject);
  if (!langMap) return '';
  const langs = ['en', 'fr', 'es'];
  return langs
    .map((lang, i) => {
      const text = langMap.get(lang) ?? '';
      const hidden = i > 0 ? ' hidden' : '';
      return `<span property="rdfs:label" xml:lang="${lang}"${hidden}>${esc(text)}</span>`;
    })
    .join('');
}

/** Return the plain text label for a subject in a given language. */
function labelText(subject: string, labels: Labels, lang = 'en'): string {
  return labels.get(subject)?.get(lang) ?? '';
}

/**
 * Phase 1: Stamp `<template>` elements inside `[property]` containers
 * with array/set values from state. Object items trigger recursive state resolution.
 */
function resolveTemplates(
  root: { querySelectorAll: Function },
  state: Record<string, unknown>,
): void {
  for (const tpl of root.querySelectorAll('[property] > template')) {
    const container = tpl.parentElement!;
    const prop = container.getAttribute('property');
    if (!prop || !(prop in state)) continue;
    const items = state[prop];
    if (!Array.isArray(items) && !(items instanceof Set)) continue;
    const arr = Array.isArray(items) ? items : [...items];
    const tplHtml = tpl.innerHTML.trim();

    let insertAfter: any = tpl;
    for (const value of arr) {
      const wrapper = parse(`<body>${tplHtml}</body>`).body;
      const el = wrapper.firstElementChild;
      if (!el) continue;

      if (typeof value === 'object' && value !== null) {
        el.setAttribute('content', JSON.stringify(value));
        resolveState(el, value as Record<string, unknown>);
      } else {
        el.setAttribute('content', String(value));

        const input = el.querySelector('input');
        if (input) input.setAttribute('value', String(value));

        const textTarget = el.querySelector('[data-text]');
        if (textTarget) {
          textTarget.textContent = String(value);
        } else if (!el.children.length) {
          el.textContent = String(value);
        }
      }

      insertAfter.after(el);
      insertAfter = el;
    }
  }
}

/**
 * Phase 2: Fill `[typeof]` elements with multilingual label spans,
 * or set placeholder attributes on void elements.
 */
function resolveLabels(
  root: { querySelectorAll: Function },
  labels: Labels,
): void {
  for (const el of root.querySelectorAll('[typeof]')) {
    const term = el.getAttribute('typeof');
    if (term === 'Person' || term === 'Organization' || term === 'PostalAddress') continue;

    const vocab = el.closest('[vocab]')?.getAttribute('vocab') ?? SCHEMA;
    const uri = vocab + term;

    if (VOID_TAGS.has(el.tagName)) {
      const text = labelText(uri, labels);
      if (text) el.setAttribute('placeholder', text);
    } else {
      const spans = labelSpans(uri, labels);
      if (spans) el.innerHTML = spans;
    }
  }
}

/**
 * Phase 3: Bind scalar state values to DOM elements by `[property]` attribute.
 * Nested objects recurse; arrays/Sets are handled by resolveTemplates.
 */
function resolveState(
  root: { querySelectorAll: Function },
  state: Record<string, unknown>,
): void {
  const processed = new Set();

  for (const el of root.querySelectorAll('[property]')) {
    if (processed.has(el)) continue;
    const prop = el.getAttribute('property');
    if (!prop || prop === 'rdfs:label') continue;
    if (!(prop in state)) continue;

    const value = state[prop];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) || value instanceof Set) continue;

    if (typeof value === 'object' && value !== null) {
      el.setAttribute('content', JSON.stringify(value));
      for (const nested of el.querySelectorAll('[property]')) processed.add(nested);
      resolveState(el, value as Record<string, unknown>);
      continue;
    }

    const strVal = String(value);

    if (el.classList.contains('badge')) {
      el.setAttribute('content', strVal);
      el.setAttribute('data-active', String(!!value));
      continue;
    }

    switch (el.tagName) {
      case 'A': {
        const href = prop === 'email' ? `mailto:${strVal}` : strVal;
        el.setAttribute('href', href);
        el.setAttribute('content', strVal);
        el.textContent = strVal;
        break;
      }
      case 'IMG':
        el.setAttribute('src', strVal);
        break;
      case 'INPUT':
        if (typeof value === 'boolean') {
          if (value) el.setAttribute('checked', '');
          else el.removeAttribute('checked');
        } else {
          el.setAttribute('value', strVal);
        }
        break;
      case 'TEXTAREA':
        el.textContent = strVal;
        break;
      default:
        el.setAttribute('content', strVal);
        el.textContent = strVal;
        break;
    }
  }
}

function resolveValidation(
  root: { querySelectorAll: Function },
  errors: Record<string, string[]>,
): void {
  for (const el of root.querySelectorAll('[data-prop]')) {
    const prop = el.getAttribute('data-prop')!;
    const key = prop.includes('.') ? prop.split('.')[0] : prop;
    const msgs = errors[key];
    if (!msgs?.length) continue;
    el.setAttribute('aria-invalid', 'true');
    el.setAttribute('data-error', msgs[0]);
    const errorSpan = `<span class="field-error">${esc(msgs[0])}</span>`;
    el.insertAdjacentHTML?.('afterend', errorSpan);
  }
}

/** Phase 5: Show/hide elements by evaluating `[data-if]` conditions against state. */
function resolveConditionals(
  root: { querySelectorAll: Function },
  state: Record<string, unknown>,
): void {
  for (const el of root.querySelectorAll('[data-if]')) {
    const cond = el.getAttribute('data-if')!;
    let visible: boolean;

    if (cond.includes(':')) {
      const [prop, val] = cond.split(':');
      visible = String(state[prop]) === val;
    } else {
      visible = Boolean(state[cond]);
    }

    if (!visible) {
      el.setAttribute('hidden', '');
    }
  }
}

/** Phase 4: Apply display transforms via `[data-transform]`, preserving raw values in `content`. */
function resolveTransforms(
  root: { querySelectorAll: Function },
): void {
  for (const el of root.querySelectorAll('[data-transform]')) {
    const spec = el.getAttribute('data-transform')!;
    const raw = el.getAttribute('content') ?? el.textContent ?? '';
    el.textContent = transform(raw, spec);
  }
}

/** Phase 6: Set or remove boolean attributes based on `[data-attr-*]` conditions. */
function resolveConditionalAttrs(
  root: { querySelectorAll: Function },
  state: Record<string, unknown>,
): void {
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.getAttributeNames()]) {
      if (!attr.startsWith('data-attr-')) continue;
      const targetAttr = attr.slice(10);
      const condition = el.getAttribute(attr)!;
      let active: boolean;
      if (condition.includes(':')) {
        const [prop, val] = condition.split(':');
        active = String(state[prop]) === val;
      } else {
        active = Boolean(state[condition]);
      }
      if (active) el.setAttribute(targetAttr, '');
      else el.removeAttribute(targetAttr);
    }
  }
}

/**
 * Render a page template by running the six-phase resolver pipeline,
 * injecting the result into the shell, and returning a complete HTML Response.
 * Declarative shadow DOM `<template shadowrootmode>` content is resolved separately.
 */
export async function renderPeoplePage(
  people: { id: string; name: string; jobTitle: string; image: string; isActive: boolean }[],
  labels: Labels,
  lang = 'en',
): Promise<Response> {
  let pageHtml: string;
  let shellHtml: string;
  try {
    [pageHtml, shellHtml] = await Promise.all([
      Deno.readTextFile(TEMPLATES_DIR + 'people.html'),
      Deno.readTextFile(TEMPLATES_DIR + 'shell.html'),
    ]);
  } catch {
    return new Response('Template not found', { status: 500 });
  }

  const pageDoc = parse(pageHtml);

  for (const shadowTpl of pageDoc.querySelectorAll('template[shadowrootmode]')) {
    const innerHtml = shadowTpl.innerHTML;
    const innerDoc = parse(innerHtml);
    resolveLabels(innerDoc.body, labels);

    const tpl = innerDoc.body.querySelector('.card-list > template');
    if (tpl) {
      const tplHtml = tpl.innerHTML.trim();
      let insertAfter: any = tpl;
      for (const person of people) {
        const wrapper = parse(`<body>${tplHtml}</body>`).body;
        const el = wrapper.firstElementChild;
        if (!el) continue;

        el.setAttribute('href', `/profile/${esc(person.id)}`);
        el.setAttribute('data-id', person.id);
        const state: Record<string, unknown> = {
          name: person.name,
          jobTitle: person.jobTitle,
          image: person.image,
          isActive: person.isActive,
        };
        resolveLabels(el, labels);
        resolveState(el, state);
        resolveConditionals(el, state);

        insertAfter.after(el);
        insertAfter = el;
      }
    }

    shadowTpl.innerHTML = innerDoc.head.innerHTML + innerDoc.body.innerHTML;
  }

  const shellDoc = parse(shellHtml);
  resolveLabels(shellDoc.body, labels);

  const storeEl = shellDoc.querySelector('profile-store');
  if (storeEl) storeEl.remove();
  for (const s of shellDoc.querySelectorAll('script[type="module"][src*="profile-store"]')) s.remove();

  const main = shellDoc.querySelector('main')!;
  main.innerHTML = pageDoc.head.innerHTML + pageDoc.body.innerHTML;

  const stateScript = shellDoc.querySelector('#initial-state')!;
  stateScript.textContent = JSON.stringify({ people });

  shellDoc.documentElement.setAttribute('lang', lang);

  const activeLink = shellDoc.querySelector('a[href="/people"]');
  if (activeLink) activeLink.setAttribute('aria-current', 'page');

  const html = '<!DOCTYPE html>\n' + shellDoc.documentElement.outerHTML;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function renderPage(
  page: 'profile' | 'edit',
  state: Record<string, unknown>,
  labels: Labels,
  lang = 'en',
  resourceIRI?: string,
): Promise<Response> {
  let pageHtml: string;
  let shellHtml: string;
  try {
    [pageHtml, shellHtml] = await Promise.all([
      Deno.readTextFile(TEMPLATES_DIR + page + '.html'),
      Deno.readTextFile(TEMPLATES_DIR + 'shell.html'),
    ]);
  } catch {
    return new Response('Template not found', { status: 500 });
  }

  if (resourceIRI) {
    const baseIRI = resourceIRI.replace(/#.*$/, '');
    pageHtml = pageHtml.replaceAll('resource="#me"', `resource="${esc(resourceIRI)}"`);
    pageHtml = pageHtml.replaceAll('resource="#address"', `resource="${esc(baseIRI + '#address')}"`);
  }

  const profileId = resourceIRI?.match(/\/people\/([^/#]+)/)?.[1];

  const pageDoc = parse(pageHtml);

  for (const shadowTpl of pageDoc.querySelectorAll('template[shadowrootmode]')) {
    const innerHtml = shadowTpl.innerHTML;
    const innerDoc = parse(innerHtml);
    resolveTemplates(innerDoc.body, state);
    resolveLabels(innerDoc.body, labels);
    resolveState(innerDoc.body, state);
    const validationErrors = (state.validationErrors ?? {}) as Record<string, string[]>;
    if (Object.keys(validationErrors).length) {
      resolveValidation(innerDoc.body, validationErrors);
    }
    resolveTransforms(innerDoc.body);
    resolveConditionals(innerDoc.body, state);
    resolveConditionalAttrs(innerDoc.body, state);
    shadowTpl.innerHTML = innerDoc.head.innerHTML + innerDoc.body.innerHTML;
  }

  const shellDoc = parse(shellHtml);
  resolveLabels(shellDoc.body, labels);

  if (profileId) {
    for (const a of shellDoc.querySelectorAll('nav a[href]')) {
      const href = a.getAttribute('href')!;
      if (href === '/profile') a.setAttribute('href', `/profile/${profileId}`);
      else if (href === '/edit') a.setAttribute('href', `/edit/${profileId}`);
    }

    const eventsScript = shellDoc.querySelector('#events-url');
    if (eventsScript) eventsScript.textContent = `/api/events/${profileId}`;
  }

  const main = shellDoc.querySelector('main')!;
  main.innerHTML = pageDoc.head.innerHTML + pageDoc.body.innerHTML;

  const stateScript = shellDoc.querySelector('#initial-state')!;
  stateScript.textContent = JSON.stringify(state);

  shellDoc.documentElement.setAttribute('lang', lang);

  const activeHref = page === 'profile' ? `/profile/${profileId}` : `/edit/${profileId}`;
  const activeLink = shellDoc.querySelector(`a[href="${activeHref}"]`);
  if (activeLink) activeLink.setAttribute('aria-current', 'page');

  const html = '<!DOCTYPE html>\n' + shellDoc.documentElement.outerHTML;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
