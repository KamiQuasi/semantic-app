import { applyI18n, registerShadowRoot, unregisterShadowRoot } from '../utils/i18n.js';
import { getStore } from './org-store.js';

const segments = window.location.pathname.split('/');
const orgId = segments[3];

/**
 * Editable organization form with two-way binding to the collaborative store.
 * Simpler than profile-editor.js — every field is a plain scalar.
 */
class OrgEditor extends HTMLElement {
  #store = null;

  constructor() {
    super();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    registerShadowRoot(this.shadowRoot);
    applyI18n(this.shadowRoot);

    this.#store = await getStore();
    this.#bindInputs();
    this.#bindDelete();

    this.#store.addEventListener('change', (e) => {
      const changes = e.detail?.changes;
      if (!changes) return;
      this.#syncInputs(changes);
    });
  }

  disconnectedCallback() {
    unregisterShadowRoot(this.shadowRoot);
  }

  #bindInputs() {
    const sr = this.shadowRoot;
    for (const input of sr.querySelectorAll('[data-prop]')) {
      const prop = input.dataset.prop;
      input.addEventListener('input', () => {
        this.#store.state[prop] = input.value;
      });
    }
  }

  #bindDelete() {
    const btn = this.shadowRoot.querySelector('.delete-btn');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this organization?')) return;
      await fetch(`/api/org/${orgId}`, { method: 'DELETE' });
      location.href = '/orgs';
    });
  }

  #syncInputs(changes) {
    const sr = this.shadowRoot;
    for (const [key, { val }] of Object.entries(changes)) {
      const input = sr.querySelector(`[data-prop="${key}"]`);
      if (input && input !== sr.activeElement) input.value = val ?? '';
    }
  }
}

customElements.define('org-editor', OrgEditor);
