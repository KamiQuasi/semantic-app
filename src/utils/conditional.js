/**
 * Show or hide elements based on `data-if` attribute conditions.
 * Supports bare property names (truthy check) and `prop:value` equality checks.
 * @param {Document|ShadowRoot|Element} root - DOM root to search within.
 * @param {Record<string, unknown>} state - Current application state.
 */
export function evaluateConditionals(root, state) {
  for (const el of root.querySelectorAll('[data-if]')) {
    const cond = el.dataset.if;
    let visible;
    if (cond.includes(':')) {
      const [prop, val] = cond.split(':');
      visible = String(state[prop]) === val;
    } else {
      visible = Boolean(state[cond]);
    }
    el.hidden = !visible;
  }
}

/**
 * Toggle boolean attributes based on `data-attr-{name}` conditions.
 * The attribute named after the `data-attr-` prefix is set when the condition
 * is met and removed when it is not.
 * @param {Document|ShadowRoot|Element} root - DOM root to search within.
 * @param {Record<string, unknown>} state - Current application state.
 */
export function evaluateConditionalAttrs(root, state) {
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.getAttributeNames()]) {
      if (!attr.startsWith('data-attr-')) continue;
      const targetAttr = attr.slice(10);
      const condition = el.getAttribute(attr);
      let active;
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
