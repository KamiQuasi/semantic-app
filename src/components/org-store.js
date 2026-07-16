import { CPXStore } from '@chapeaux/cpx-store';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { SSETransport } from '@chapeaux/cpx-store/transports/sse';
import { updateLabels } from '/src/utils/i18n.js';

const segments = window.location.pathname.split('/');
const orgId = segments[3];
const transport = new SSETransport(`/api/events/org/${orgId}`, { apiUrl: `/api/org/${orgId}` });

/** @type {Function} Resolves the singleton store promise. */
let _resolve;

/** @type {Promise<OrgStore>} Resolves once the store element connects and hydrates. */
const _ready = new Promise((r) => (_resolve = r));

/**
 * Custom element wrapping CPXStore with the collab plugin over SSE, scoped
 * to a single organization resource identified by the URL path.
 */
class OrgStore extends CPXStore {
  constructor() {
    super(
      {
        name: '',
        url: '',
        description: '',
        foundingDate: '',
        numberOfEmployees: '',
      },
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

customElements.define('org-store', OrgStore);

/**
 * Returns a promise that resolves to the singleton OrgStore once connected.
 * @returns {Promise<OrgStore>}
 */
export function getStore() {
  return _ready;
}
