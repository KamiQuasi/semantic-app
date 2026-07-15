import { stamp } from '../utils/stamp.js';
import { transform } from '../utils/transform.js';
import { evaluateConditionals, evaluateConditionalAttrs } from '../utils/conditional.js';
import { applyI18n, registerShadowRoot, unregisterShadowRoot } from '../utils/i18n.js';
import { getStore } from './profile-store.js';

/**
 * Read-only profile display card.
 * Subscribes to the collaborative store and renders property changes
 * into its declarative shadow DOM using RDFa-annotated elements.
 */
class ProfileCard extends HTMLElement {
  #store = null;

  constructor() {
    super();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    registerShadowRoot(this.shadowRoot);
    applyI18n(this.shadowRoot);

    this.#store = await getStore();
    evaluateConditionals(this.shadowRoot, this.#store.state);
    evaluateConditionalAttrs(this.shadowRoot, this.#store.state);

    this.#store.addEventListener('change', (e) => {
      const changes = e.detail?.changes;
      if (!changes) return;
      for (const [key, { val }] of Object.entries(changes)) {
        if (key in this) this[key] = val;
      }
      evaluateConditionals(this.shadowRoot, this.#store.state);
      evaluateConditionalAttrs(this.shadowRoot, this.#store.state);
    });
  }

  disconnectedCallback() {
    unregisterShadowRoot(this.shadowRoot);
  }

  /** @param {string} property - RDFa property name to look up in the shadow root. */
  #el(property) {
    return this.shadowRoot.querySelector(`[property="${property}"]`);
  }

  /**
   * Set an element's `content` attribute and text, applying any `data-transform` pipe.
   * @param {Element} el
   * @param {string} val
   */
  #setText(el, val) {
    el.setAttribute('content', val);
    const spec = el.dataset.transform;
    el.textContent = spec ? transform(val, spec) : val;
  }

  set name(val) {
    this.#setText(this.#el('name'), val);
  }

  set jobTitle(val) {
    this.#setText(this.#el('jobTitle'), val);
  }

  set description(val) {
    this.#setText(this.#el('description'), val);
  }

  set email(val) {
    const el = this.#el('email');
    el.href = `mailto:${val}`;
    this.#setText(el, val);
  }

  set url(val) {
    const el = this.#el('url');
    el.href = val;
    this.#setText(el, val);
  }

  set image(val) {
    this.#el('image').src = val;
  }

  set isActive(val) {
    const el = this.#el('isActive');
    el.setAttribute('content', String(val));
    el.dataset.active = String(!!val);
  }

  set address(val) {
    if (!val || typeof val !== 'object') return;
    const container = this.#el('address');
    if (!container) return;
    for (const [prop, v] of Object.entries(val)) {
      const el = container.querySelector(`[property="${prop}"]`);
      if (el) this.#setText(el, String(v));
    }
  }

  set knowsLanguage(val) {
    const el = this.#el('knowsLanguage');
    const tpl = el.querySelector('template');
    el.replaceChildren(tpl, ...(val ?? []).map((v) => stamp(tpl, v)));
  }

  set hasSkill(val) {
    const el = this.#el('hasSkill');
    const tpl = el.querySelector('template');
    el.replaceChildren(tpl, ...(val ?? []).map((v) => stamp(tpl, v)));
  }
}

customElements.define('profile-card', ProfileCard);
