import { h } from './dom.js';
import { confirmButton } from './widgets.js';
import { MSG } from '../shared/messages.js';
import { presetFrom } from '../shared/state.js';
import { PRESETS } from '../engine/presets.js';

const STORAGE_KEY = 'userPresets';
const USER = 'user:';
const NAME_MAX = 40;

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function createPresets({ select, openButton, form, send, getState, flash, showStatus }) {
  let saved = [];

  const input = h('input', {
    type: 'text',
    maxLength: NAME_MAX,
    placeholder: 'Name this FX setup',
    'aria-label': 'Preset name',
    autocomplete: 'off',
    spellcheck: false,
    oninput: () => updateSubmit(),
    onkeydown: (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      close();
    }
  });
  const submit = h('button', { type: 'submit', className: 'key key-go' });
  const cancel = h('button', { type: 'button', className: 'key', textContent: 'Cancel', onclick: () => close() });
  const list = h('div', { className: 'preset-tags', role: 'group', 'aria-label': 'Saved presets' });
  const hint = h('p', { className: 'hint' });
  form.append(h('div', { className: 'preset-form-row' }, input, submit, cancel), list, hint);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save();
  });

  const nameOf = () => input.value.trim().slice(0, NAME_MAX);
  const existing = (name) => saved.find((p) => p.name.localeCompare(name, undefined, { sensitivity: 'base' }) === 0) ?? null;

  function updateSubmit() {
    const name = nameOf();
    const match = name && existing(name);
    submit.textContent = match ? 'Replace' : 'Save';
    submit.disabled = !name;
    hint.textContent = match
      ? `Replaces your preset “${match.name}” with the current FX setup.`
      : 'Saves each bus’s effects, their settings and LFOs, which buses are on, and the bus routing.';
  }

  function fill() {
    const groups = [h('optgroup', { label: 'Built-in' }, ...Object.entries(PRESETS).map(([id, p]) => h('option', { value: id, textContent: p.name })))];
    if (saved.length) groups.push(h('optgroup', { label: 'Saved' }, ...[...saved].sort(byName).map((p) => h('option', { value: USER + p.id, textContent: p.name }))));
    select.replaceChildren(h('option', { value: '', textContent: 'Load preset…' }), ...groups);
  }

  function renderTags() {
    list.hidden = !saved.length;
    list.replaceChildren(
      ...[...saved].sort(byName).map((p) =>
        h(
          'span',
          { className: 'preset-tag' },
          h('button', {
            type: 'button',
            className: 'preset-tag-name',
            textContent: p.name,
            title: `Use the name “${p.name}”, so saving replaces it`,
            onclick: () => {
              input.value = p.name;
              updateSubmit();
              input.focus();
            }
          }),
          confirmButton(h('button', { type: 'button', className: 'preset-tag-delete', 'aria-label': `Delete preset ${p.name}`, title: `Delete “${p.name}”` }), {
            label: '×',
            confirmLabel: 'Delete?',
            onConfirm: () => remove(p.id)
          })
        )
      )
    );
  }

  async function store(next) {
    try {
      await browser.storage.local.set({ [STORAGE_KEY]: next });
      saved = next;
      fill();
      renderTags();
      updateSubmit();
      return true;
    } catch (err) {
      showStatus(`Couldn't save presets: ${err.message}`);
      return false;
    }
  }

  async function save() {
    const name = nameOf();
    const state = getState();
    if (!name || !state) return;
    const match = existing(name);
    const preset = { id: match?.id ?? `p${Date.now().toString(36)}`, ...presetFrom(state, name) };
    const next = match ? saved.map((p) => (p.id === match.id ? preset : p)) : [...saved, preset];
    if (!(await store(next))) return;
    flash(match ? 'Replaced' : 'Saved', name);
    close();
  }

  function remove(id) {
    const preset = saved.find((p) => p.id === id);
    store(saved.filter((p) => p.id !== id)).then((ok) => ok && preset && flash('Deleted', preset.name));
  }

  function open() {
    form.hidden = false;
    openButton.setAttribute('aria-expanded', 'true');
    input.value = '';
    renderTags();
    updateSubmit();
    input.focus();
  }

  function close() {
    form.hidden = true;
    openButton.setAttribute('aria-expanded', 'false');
    openButton.focus();
  }

  select.addEventListener('change', async () => {
    const value = select.value;
    select.blur();
    select.value = '';
    if (!value) return;
    if (value.startsWith(USER)) {
      const preset = saved.find((p) => USER + p.id === value);
      if (preset && (await send(MSG.LOAD_PRESET, { preset }))) flash('Loaded', preset.name);
    } else {
      await send(MSG.LOAD_PRESET, { presetId: value });
    }
  });
  openButton.setAttribute('aria-expanded', 'false');
  openButton.addEventListener('click', () => (form.hidden ? open() : close()));

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    saved = Array.isArray(changes[STORAGE_KEY].newValue) ? changes[STORAGE_KEY].newValue : [];
    fill();
    if (!form.hidden) {
      renderTags();
      updateSubmit();
    }
  });

  fill();
  browser.storage.local.get(STORAGE_KEY).then((data) => {
    saved = Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
    fill();
  });
}
