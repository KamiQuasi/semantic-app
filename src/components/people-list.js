import { applyI18n, registerShadowRoot, unregisterShadowRoot } from '../utils/i18n.js';
import { getStore } from './people-store.js';

class PeopleList extends HTMLElement {
  #store = null;

  constructor() {
    super();
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    registerShadowRoot(this.shadowRoot);
    applyI18n(this.shadowRoot);

    this.#store = await getStore();

    this.#store.addEventListener('change', (e) => {
      const changes = e.detail?.changes;
      if (!changes || !changes.people) return;
      this.#render(changes.people.val);
    });
  }

  disconnectedCallback() {
    unregisterShadowRoot(this.shadowRoot);
  }

  #render(people) {
    const container = this.shadowRoot.querySelector('.card-list');
    if (!container) return;
    const tpl = container.querySelector('template');
    if (!tpl) return;

    const existingCards = container.querySelectorAll('.person-card');
    const cardMap = new Map();
    for (const card of existingCards) {
      cardMap.set(card.dataset.id, card);
    }

    const fragment = document.createDocumentFragment();
    for (const person of people) {
      let card = cardMap.get(person.id);
      if (card) {
        this.#updateCard(card, person);
        cardMap.delete(person.id);
      } else {
        card = this.#createCard(tpl, person);
      }
      fragment.appendChild(card);
    }

    for (const stale of cardMap.values()) stale.remove();

    container.replaceChildren(tpl, fragment);
    applyI18n(this.shadowRoot);
  }

  #createCard(tpl, person) {
    const clone = tpl.content.cloneNode(true);
    const card = clone.querySelector('.person-card') || clone.firstElementChild;
    card.dataset.id = person.id;
    this.#updateCard(card, person);
    return card;
  }

  #updateCard(card, person) {
    card.href = `/profile/${person.id}`;

    const img = card.querySelector('[property="image"]');
    if (img) img.src = person.image || '';

    const name = card.querySelector('[property="name"]');
    if (name) name.textContent = person.name || '';

    const jobTitle = card.querySelector('[property="jobTitle"]');
    if (jobTitle) jobTitle.textContent = person.jobTitle || '';

    const badge = card.querySelector('[property="isActive"]');
    if (badge) {
      badge.setAttribute('content', String(person.isActive));
      badge.dataset.active = String(!!person.isActive);
    }
  }
}

customElements.define('people-list', PeopleList);
