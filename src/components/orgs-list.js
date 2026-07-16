import { applyI18n, registerShadowRoot, unregisterShadowRoot } from '../utils/i18n.js';
import { getStore } from './orgs-store.js';

class OrgsList extends HTMLElement {
  #store = null;

  constructor() {
    super();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    registerShadowRoot(this.shadowRoot);
    applyI18n(this.shadowRoot);

    this.#store = await getStore();
    this.#bindAddOrg();
    this.#bindDelete();

    this.#store.addEventListener('change', (e) => {
      const changes = e.detail?.changes;
      if (!changes || !changes.orgs) return;
      this.#render(changes.orgs.val);
    });
  }

  disconnectedCallback() {
    unregisterShadowRoot(this.shadowRoot);
  }

  /** Wire up the "Add Organization" input/button to `POST /api/orgs`, then navigate to the new org's editor. */
  #bindAddOrg() {
    const sr = this.shadowRoot;
    const input = sr.querySelector('.add-org-input');
    const btn = sr.querySelector('.add-org-btn');
    if (!input || !btn) return;

    const addOrg = async () => {
      const name = input.value.trim();
      if (!name) return;
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return;
      const { id } = await res.json();
      location.href = `/orgs/edit/${id}`;
    };

    btn.addEventListener('click', addOrg);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addOrg(); }
    });
  }

  /** Delegate delete-button clicks within the card list to `DELETE /api/org/:id`. */
  #bindDelete() {
    const list = this.shadowRoot.querySelector('.card-list');
    if (!list) return;

    list.addEventListener('click', async (e) => {
      const btn = e.target.closest('.delete-btn');
      if (!btn) return;
      const card = btn.closest('.org-card');
      const id = card?.dataset.id;
      if (!id) return;
      if (!confirm(`Delete this organization?`)) return;
      card.remove();
      await fetch(`/api/org/${id}`, { method: 'DELETE' });
    });
  }

  #render(orgs) {
    const container = this.shadowRoot.querySelector('.card-list');
    if (!container) return;
    const tpl = container.querySelector('template');
    if (!tpl) return;

    const existingCards = container.querySelectorAll('.org-card');
    const cardMap = new Map();
    for (const card of existingCards) {
      cardMap.set(card.dataset.id, card);
    }

    const fragment = document.createDocumentFragment();
    for (const org of orgs) {
      let card = cardMap.get(org.id);
      if (card) {
        this.#updateCard(card, org);
        cardMap.delete(org.id);
      } else {
        card = this.#createCard(tpl, org);
      }
      fragment.appendChild(card);
    }

    for (const stale of cardMap.values()) stale.remove();

    container.replaceChildren(tpl, fragment);
    applyI18n(this.shadowRoot);
  }

  #createCard(tpl, org) {
    const clone = tpl.content.cloneNode(true);
    const card = clone.querySelector('.org-card') || clone.firstElementChild;
    card.dataset.id = org.id;
    this.#updateCard(card, org);
    return card;
  }

  #updateCard(card, org) {
    const link = card.querySelector('.org-card-link');
    if (link) link.href = `/orgs/edit/${org.id}`;

    const name = card.querySelector('[property="name"]');
    if (name) name.textContent = org.name || '';

    const description = card.querySelector('[property="description"]');
    if (description) description.textContent = org.description || '';
  }
}

customElements.define('orgs-list', OrgsList);
