import { CPXStore } from '@chapeaux/cpx-store';
import { collabPlugin } from '@chapeaux/cpx-store/plugins/collab';
import { SSETransport } from '@chapeaux/cpx-store/transports/sse';

const transport = new SSETransport('/api/events', { apiUrl: '/api/profile' });

/** @type {Function} Resolves the singleton store promise. */
let _resolve;

/** @type {Promise<ProfileStore>} Resolves once the store element connects and hydrates. */
const _ready = new Promise((r) => (_resolve = r));

/**
 * Custom element wrapping CPXStore with the collab plugin over SSE.
 * Hydrates initial state from a server-rendered `#initial-state` script tag.
 */
class ProfileStore extends CPXStore {
  constructor() {
    super(
      {
        name: '',
        jobTitle: '',
        email: '',
        description: '',
        isActive: true,
        knowsLanguage: [],
        hasSkill: [],
        url: '',
        image: '',
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
    _resolve(this);
  }
}

customElements.define('profile-store', ProfileStore);

/**
 * Returns a promise that resolves to the singleton ProfileStore once connected.
 * @returns {Promise<ProfileStore>}
 */
export function getStore() {
  return _ready;
}
