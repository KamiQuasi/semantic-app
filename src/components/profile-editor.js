import { stamp } from '../utils/stamp.js';
import { applyI18n, registerShadowRoot, unregisterShadowRoot } from '../utils/i18n.js';
import { getStore } from './profile-store.js';

/**
 * Editable profile form with two-way binding to the collaborative store.
 * Supports scalar fields, nested address fields (dot-notation), language
 * checkboxes, and drag-and-drop skill reordering.
 */
class ProfileEditor extends HTMLElement {
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
    this.#bindLangTabs();
    this.#bindLanguages();
    this.#bindSkills();
    this.#bindWorksFor();

    this.#store.addEventListener('change', (e) => {
      const changes = e.detail?.changes;
      if (!changes) return;
      this.#syncInputs(changes);
    });
  }

  disconnectedCallback() {
    unregisterShadowRoot(this.shadowRoot);
  }

  /** Bind `[data-prop]` inputs to the store, supporting dot-notation for nested fields. */
  #bindInputs() {
    const sr = this.shadowRoot;
    for (const input of sr.querySelectorAll('[data-prop]')) {
      const prop = input.dataset.prop;
      if (prop === 'worksForId') continue;
      const eventType = input.type === 'checkbox' ? 'change' : 'input';

      input.addEventListener(eventType, () => {
        if (prop.includes('.')) {
          const [parent, child] = prop.split('.');
          const current = { ...(this.#store.state[parent] ?? {}) };
          current[child] = input.value;
          this.#store.state[parent] = current;
        } else if (input.type === 'checkbox') {
          this.#store.state[prop] = input.checked;
        } else {
          this.#store.state[prop] = input.value;
        }
      });
    }
  }

  /** Wire up the EN/FR/ES tab buttons above each multi-language field to show/hide its inputs. */
  #bindLangTabs() {
    const sr = this.shadowRoot;
    for (const group of sr.querySelectorAll('.i18n-field')) {
      const tabs = group.querySelectorAll('.lang-tab');
      const fields = group.querySelectorAll('input[data-lang], textarea[data-lang]');
      for (const tab of tabs) {
        tab.addEventListener('click', () => {
          for (const t of tabs) t.classList.toggle('active', t === tab);
          for (const f of fields) f.hidden = f.dataset.lang !== tab.dataset.lang;
        });
      }
    }
  }

  /** Wire up language checkbox changes and the add-language input/button. */
  #bindLanguages() {
    const sr = this.shadowRoot;
    const fieldset = sr.querySelector('fieldset[property="knowsLanguage"]');
    if (!fieldset) return;

    fieldset.addEventListener('change', (e) => {
      if (e.target.type !== 'checkbox') return;
      const checked = [...fieldset.querySelectorAll('.checkbox-item input:checked')]
        .map((cb) => cb.value);
      this.#store.state.knowsLanguage = checked;
    });

    const addInput = sr.querySelector('.add-language-input');
    const addBtn = sr.querySelector('.add-language-btn');
    if (addInput && addBtn) {
      const addLanguage = () => {
        const val = addInput.value.trim();
        if (!val) return;
        const current = [...(this.#store.state.knowsLanguage ?? [])];
        if (!current.includes(val)) {
          current.push(val);
          this.#store.state.knowsLanguage = current;
          const tpl = fieldset.querySelector('template');
          fieldset.insertBefore(stamp(tpl, val), addInput);
        }
        addInput.value = '';
      };
      addBtn.addEventListener('click', addLanguage);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addLanguage(); }
      });
    }
  }

  /** Wire up the worksFor org autocomplete: resolve the selected name to an org id via the datalist. */
  #bindWorksFor() {
    const sr = this.shadowRoot;
    const input = sr.querySelector('[data-prop="worksForId"]');
    const datalist = sr.querySelector('#orgs-datalist');
    if (!input || !datalist) return;

    input.addEventListener('change', () => {
      const option = [...datalist.options].find((o) => o.value === input.value);
      this.#store.state.worksForId = option ? option.dataset.id : '';
    });
  }

  /** Wire up skill drag-and-drop reordering, removal, and the add-skill input/button. */
  #bindSkills() {
    const sr = this.shadowRoot;
    const list = sr.querySelector('[property="hasSkill"]');
    if (!list) return;

    let draggedItem = null;

    list.addEventListener('dragstart', (e) => {
      draggedItem = e.target.closest('li');
      if (draggedItem) {
        e.dataTransfer.effectAllowed = 'move';
        draggedItem.classList.add('dragging');
      }
    });

    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      const target = e.target.closest('li');
      if (target && target !== draggedItem) {
        const rect = target.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        if (e.clientY < midY) {
          list.insertBefore(draggedItem, target);
        } else {
          list.insertBefore(draggedItem, target.nextSibling);
        }
      }
    });

    list.addEventListener('dragend', () => {
      if (draggedItem) draggedItem.classList.remove('dragging');
      const newOrder = [...list.querySelectorAll('li')]
        .map((li) => li.getAttribute('content') || li.textContent.trim());
      this.#store.state.hasSkill = newOrder;
      draggedItem = null;
    });

    list.addEventListener('click', (e) => {
      const btn = e.target.closest('.remove-btn');
      if (!btn) return;
      const li = btn.closest('li');
      const skill = li.getAttribute('content') || li.textContent.trim();
      li.remove();
      const current = [...(this.#store.state.hasSkill ?? [])].filter((s) => s !== skill);
      this.#store.state.hasSkill = current;
    });

    const addInput = sr.querySelector('.add-skill-input');
    const addBtn = sr.querySelector('.add-skill-btn');
    if (addInput && addBtn) {
      const addSkill = () => {
        const val = addInput.value.trim();
        if (!val) return;
        const current = [...(this.#store.state.hasSkill ?? [])];
        if (!current.includes(val)) {
          current.push(val);
          this.#store.state.hasSkill = current;
          this.#rebuildSkillList(current);
        }
        addInput.value = '';
      };
      addBtn.addEventListener('click', addSkill);
      addInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addSkill(); }
      });
    }
  }

  /**
   * Sync incoming store changes back into the form inputs.
   * Skips the currently focused element to avoid clobbering active edits.
   * @param {Record<string, {val: *}>} changes
   */
  #syncInputs(changes) {
    const sr = this.shadowRoot;
    for (const [key, { val }] of Object.entries(changes)) {
      const input = sr.querySelector(`[data-prop="${key}"]`);
      if (input) {
        if (input.type === 'checkbox') {
          input.checked = Boolean(val);
        } else if (input.tagName === 'TEXTAREA') {
          if (input !== sr.activeElement) input.value = val ?? '';
        } else if (input.tagName === 'INPUT') {
          if (input !== sr.activeElement) input.value = val ?? '';
        }
      }

      if (val && typeof val === 'object' && !Array.isArray(val)) {
        for (const nested of sr.querySelectorAll(`[data-prop^="${key}."]`)) {
          if (nested === sr.activeElement) continue;
          const child = nested.dataset.prop.slice(key.length + 1);
          nested.value = val[child] ?? '';
        }
      }

      if (key === 'knowsLanguage') {
        const fieldset = sr.querySelector('fieldset[property="knowsLanguage"]');
        if (fieldset) {
          for (const cb of fieldset.querySelectorAll('.checkbox-item input[type="checkbox"]')) {
            cb.checked = (val ?? []).includes(cb.value);
          }
        }
      }

      if (key === 'hasSkill') {
        this.#rebuildSkillList(val ?? []);
      }

      if (key === 'worksFor') {
        const worksForInput = sr.querySelector('[data-prop="worksForId"]');
        if (worksForInput && worksForInput !== sr.activeElement) {
          worksForInput.value = val?.name ?? '';
        }
      }
    }
  }

  /**
   * Rebuild the skill list DOM from the given array by re-stamping the template.
   * @param {string[]} skills
   */
  #rebuildSkillList(skills) {
    const list = this.shadowRoot.querySelector('[property="hasSkill"]');
    if (!list) return;
    const tpl = list.querySelector('template');
    list.replaceChildren(tpl, ...skills.map((v) => stamp(tpl, v)));
  }
}

customElements.define('profile-editor', ProfileEditor);
