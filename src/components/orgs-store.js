import { CPXStore } from '@chapeaux/cpx-store';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { SSETransport } from '@chapeaux/cpx-store/transports/sse';
import { updateLabels } from '/src/utils/i18n.js';

const transport = new SSETransport('/api/events/orgs', { apiUrl: '/api/orgs' });

/** @type {Function} Resolves the singleton store promise. */
let _resolve;

/** @type {Promise<OrgsStore>} Resolves once the store element connects and hydrates. */
const _ready = new Promise((r) => (_resolve = r));

class OrgsStore extends CPXStore {
  constructor() {
    super({ orgs: [] }, collabPlugin({ transport }));
  }

  connectedCallback() {
    super.connectedCallback();
    const el = document.getElementById('initial-state');
    if (el) {
      this.sync(JSON.parse(el.textContent));
      el.remove();
    }
    if (transport._eventSource) {
      transport._eventSource.addEventListener('labels', (e) => {
        updateLabels(JSON.parse(e.data));
      });
    }
    _resolve(this);
  }
}

customElements.define('orgs-store', OrgsStore);

/**
 * Returns a promise that resolves to the singleton OrgsStore once connected.
 * @returns {Promise<OrgsStore>}
 */
export function getStore() {
  return _ready;
}
