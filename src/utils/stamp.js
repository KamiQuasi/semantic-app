import { transform } from './transform.js';

/**
 * Set an element's text content, applying a `data-transform` pipe if present.
 * @param {Element} el - Target DOM element.
 * @param {string} value - Raw text value.
 */
function applyText(el, value) {
  const spec = el.dataset?.transform;
  el.textContent = spec ? transform(value, spec) : value;
}

/**
 * Clone a `<template>` and populate it with a value.
 * For objects, fills child `[property]` elements with matching fields.
 * For scalars, sets the `content` attribute and text/input value.
 * @param {HTMLTemplateElement} template - The template element to clone.
 * @param {*} value - Scalar or object value to stamp into the clone.
 * @returns {Element} The populated element.
 */
export function stamp(template, value) {
  const el = template.content.cloneNode(true).firstElementChild;

  if (typeof value === 'object' && value !== null) {
    el.setAttribute('content', JSON.stringify(value));
    for (const child of el.querySelectorAll('[property]')) {
      const prop = child.getAttribute('property');
      if (prop in value) {
        child.setAttribute('content', String(value[prop]));
        applyText(child, String(value[prop]));
      }
    }
  } else {
    el.setAttribute('content', value);
    const input = el.querySelector('input');
    if (input) input.value = value;
    const textTarget = el.querySelector('[data-text]');
    if (textTarget) {
      applyText(textTarget, value);
    } else if (!el.children.length) {
      applyText(el, value);
    }
  }

  return el;
}
