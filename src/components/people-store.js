import { CPXStore } from '@chapeaux/cpx-store';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { SSETransport } from '@chapeaux/cpx-store/transports/sse';
import { updateLabels } from '/src/utils/i18n.js';

const transport = new SSETransport('/api/events/people', { apiUrl: '/api/people' });

/** @type {Function} */
let _resolve;

/** @type {Promise<PeopleStore>} */
const _ready = new Promise((r) => (_resolve = r));

class PeopleStore extends CPXStore {
  constructor() {
    super(
      { people: [] },
      collabPlugin({ transport }),
    );
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

customElements.define('people-store', PeopleStore);

export function getStore() {
  return _ready;
}
