'use strict';

const byId = id => document.getElementById(id);
const form = byId('idea-form');
const editor = byId('editor');
const sessionFallback = new Map();
const preference = {
  get(key) { try { return localStorage.getItem('giftbook.' + key) ?? sessionFallback.get(key); } catch { return sessionFallback.get(key); } },
  set(key, value) { sessionFallback.set(key, value); try { localStorage.setItem('giftbook.' + key, value); } catch {} }
};
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), n => n.toString(16).padStart(2, '0')).join('');
const roomPattern = /^[a-f0-9]{48}$/;
function roomFromURL() {
  const invitation = location.hash.slice(1);
  return roomPattern.test(invitation) ? invitation : window.GIFTBOOK_FAMILY_ROOM;
}
const room = roomFromURL();
const invitationHash = room === window.GIFTBOOK_FAMILY_ROOM ? '' : '#' + room;
history.replaceState(null, '', location.pathname + location.search + invitationHash);
window.addEventListener('hashchange', () => location.reload());

const shared = Boolean(window.GIFTBOOK_API_ORIGIN);
const api = (window.GIFTBOOK_API_ORIGIN || location.origin) + '/api/' + room + '/ideas';
const state = {people: [], person: '', ideas: [], view: preference.get('view') === 'list' ? 'list' : 'grid', loading: true, error: false};
let requestNumber = 0;
let draft, selected, photoWork = 0, photoPending = false, saving = false, toastTimer;
const editStorage = id => 'edit.' + room + '.' + id;
const money = cents => '$' + (cents / 100).toLocaleString(undefined, {minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2});
const personKey = name => name.normalize('NFC').trim().toLowerCase();
const shareLink = () => location.origin + location.pathname + invitationHash;

function toast(message) {
  byId('toast').textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { byId('toast').textContent = ''; }, 2600);
}

function icon(id) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', '#' + id);
  svg.append(use);
  return svg;
}

function make(tag, cls, text) {
  const element = document.createElement(tag);
  if (cls) element.className = cls;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Reuse the same lookup when a link appears in a form, a card, or its detail view.
const linkImages = new Map();
function linkImage(value) {
  if (!value || !shared) return Promise.resolve('');
  if (!linkImages.has(value)) {
    const pending = fetch(api.replace(/\/ideas$/, '/preview'), {
      method:'POST', credentials:'omit', referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:value})
    }).then(async response => {
      if (!response.ok) throw new Error('Preview unavailable');
      return (await response.json()).image || '';
    }).catch(() => '');
    linkImages.set(value, pending);
    pending.then(image => { if (!image) setTimeout(() => linkImages.delete(value), 60000); });
  }
  return linkImages.get(value);
}

function displayImage(img, photo, link) {
  const revision = String(Number(img.dataset.revision || 0) + 1);
  img.dataset.revision = revision;
  img.hidden = true;
  img.removeAttribute('src');
  const show = src => {
    if (!src || img.dataset.revision !== revision) return;
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (img.dataset.revision === revision) img.hidden = false; };
    img.onerror = () => { if (img.dataset.revision === revision) img.hidden = true; };
    img.src = src;
  };
  if (photo) show(photo);
  else if (link) linkImage(link).then(show);
}

function makeCard(idea) {
  const button = make('button', 'idea');
  button.dataset.id = idea.id;
  const visual = make('span', 'idea-visual');
  visual.append(icon('gift'));
  if (idea.photo || idea.url) {
    const photo = make('img');
    photo.alt = '';
    visual.append(photo);
    displayImage(photo, idea.photo, idea.url);
  }
  const info = make('span', 'idea-info');
  info.append(make('span', 'idea-title', idea.title));
  if (idea.price !== null) info.append(make('span', 'idea-price', money(idea.price)));
  button.append(visual, info);
  button.addEventListener('click', () => showDetail(idea));
  return button;
}

function openPerson(name, moveFocus = true) {
  state.person = name;
  state.ideas = [];
  state.loading = true;
  state.error = false;
  render();
  if (moveFocus) byId('collection-title').focus();
  refresh();
}

function makePerson(name) {
  const item = make('li');
  const button = make('button', 'person-row');
  button.dataset.person = personKey(name);
  button.append(make('span', '', name), icon('chevron'));
  button.addEventListener('click', () => {
    history.pushState({wishPerson:name}, '', location.href);
    openPerson(name);
  });
  item.append(button);
  return item;
}

function render() {
  const inside = Boolean(state.person);
  const people = byId('people');
  const list = byId('ideas');
  const focusedPerson = document.activeElement?.dataset.person;
  const focusedId = document.activeElement?.dataset.id;
  byId('collection-title').textContent = inside ? state.person : 'Family lists';
  byId('all-people').hidden = !inside;
  byId('view-options').hidden = !inside;
  byId('known-people').replaceChildren(...state.people.map(name => new Option(name)));
  people.hidden = inside;
  people.replaceChildren(...(inside ? [] : state.people.map(makePerson)));
  list.hidden = !inside;
  list.classList.toggle('list', state.view === 'list');
  list.replaceChildren(...(inside ? state.ideas.map(makeCard) : []));
  if (focusedPerson) [...people.querySelectorAll('button')].find(el => el.dataset.person === focusedPerson)?.focus({preventScroll:true});
  if (focusedId) [...list.children].find(el => el.dataset.id === focusedId)?.focus({preventScroll:true});
  byId('view-grid').setAttribute('aria-pressed', state.view === 'grid');
  byId('view-list').setAttribute('aria-pressed', state.view === 'list');
  const count = inside ? state.ideas.length : state.people.length;
  byId('error').hidden = !state.error;
  byId('empty').hidden = count > 0 || state.error;
  byId('empty-title').textContent = state.loading ? (inside ? 'Loading gift ideas…' : 'Loading lists…') : (inside ? 'No gift ideas yet' : 'No lists yet');
  byId('empty-action').hidden = state.loading || state.error;
}

async function request(url, options) {
  if (!shared) return deviceCatalog.request(room, url, options);
  const response = await fetch(url, {cache:'no-store', credentials:'omit', ...options});
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(problem.error || 'The catalog could not be reached. Please try again.');
  }
  return response.status === 204 ? null : response.json();
}

async function refresh() {
  const number = ++requestNumber;
  try {
    let cursor = null;
    const person = state.person;
    const results = [];
    do {
      const url = new URL(api);
      if (person) url.searchParams.set('person', personKey(person));
      else url.searchParams.set('view', 'people');
      if (cursor) url.searchParams.set('cursor', cursor);
      const page = await request(url);
      if (number !== requestNumber) return;
      const entries = person ? page.ideas : page.people;
      if (!Array.isArray(entries)) throw new Error('The shared list is unavailable.');
      results.push(...entries);
      cursor = page.cursor;
    } while (cursor);
    if (person) {
      state.ideas = results.sort((a,b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
    } else {
      const names = new Map();
      for (const name of results.sort((a,b) => a.localeCompare(b))) names.set(personKey(name), name);
      state.people = [...names.values()];
    }
    state.error = false;
    byId('error').hidden = true;
  } catch {
    if (number !== requestNumber) return;
    state.error = true;
    byId('error').firstElementChild.textContent = 'Couldn’t load the shared catalog.';
    byId('error').hidden = false;
  } finally {
    if (number === requestNumber) { state.loading = false; render(); }
  }
}

function showDetail(idea) {
  selected = idea;
  byId('detail-person').textContent = idea.person;
  byId('detail-title').textContent = idea.title;
  byId('detail-price').textContent = idea.price === null ? '' : money(idea.price);
  byId('detail-notes').textContent = idea.notes;
  displayImage(byId('detail-image'), idea.photo, idea.url);
  const product = byId('detail-link');
  product.hidden = !idea.url;
  if (idea.url) product.href = idea.url; else product.removeAttribute('href');
  byId('edit').hidden = !preference.get(editStorage(idea.id));
  byId('detail').showModal();
}

function setPhoto(value) {
  draft.photo = value;
  displayImage(byId('photo-preview'), value, form.elements.url.value.trim());
  byId('photo-label').textContent = value ? 'Change photo' : 'Add photo';
  byId('remove-photo').hidden = !value;
}

function formError(message = '') {
  byId('form-error').textContent = message;
  byId('form-error').hidden = !message;
}

function openEditor(idea = null) {
  const id = idea?.id || crypto.randomUUID();
  const key = idea ? preference.get(editStorage(id)) : randomKey();
  if (!key) return;
  draft = {id, key, editing: !!idea, photo: ''};
  form.reset();
  form.elements.person.value = idea?.person ?? preference.get('name.' + room) ?? '';
  form.elements.title.value = idea?.title ?? '';
  form.elements.url.value = idea?.url ?? '';
  form.elements.notes.value = idea?.notes ?? '';
  form.elements.price.value = idea?.price == null ? '' : String(idea.price / 100);
  byId('editor-title').textContent = idea ? 'Edit gift idea' : 'Add gift idea';
  byId('remove').hidden = !idea;
  byId('save').textContent = 'Save idea';
  byId('save').disabled = false;
  photoWork++;
  photoPending = false;
  setPhoto(idea?.photo || '');
  formError();
  editor.showModal();
  (form.elements.person.value ? form.elements.title : form.elements.person).focus();
}

async function convertPhoto(file) {
  if (file.size > 30 * 1024 * 1024) throw new Error('Choose a photo under 30 MB.');
  const uri = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = uri;
    await img.decode();
    let side = Math.min(900, Math.max(img.naturalWidth,img.naturalHeight));
    const canvas = document.createElement('canvas');
    while (side >= 1) {
      const scale = side / Math.max(img.naturalWidth,img.naturalHeight);
      canvas.width = Math.max(1,Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1,Math.round(img.naturalHeight * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(img,0,0,canvas.width,canvas.height);
      const result = canvas.toDataURL('image/jpeg',.79);
      if (result.length <= 196608) return result;
      if (side <= 96) break;
      side = Math.floor(side * .72);
    }
    throw new Error('Choose a smaller photo.');
  } finally { URL.revokeObjectURL(uri); }
}

byId('photo-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const number = ++photoWork;
  photoPending = true;
  byId('save').disabled = true;
  formError();
  try {
    const photo = await convertPhoto(file);
    if (number === photoWork) setPhoto(photo);
  } catch {
    if (number === photoWork) formError('Choose a JPG, PNG, or WebP photo under 30 MB.');
  } finally {
    if (number === photoWork) {
      photoPending = false;
      byId('save').disabled = false;
    }
  }
});
byId('remove-photo').addEventListener('click', () => {
  ++photoWork; photoPending = false; byId('save').disabled = false;
  setPhoto(''); byId('photo-file').value = '';
});
function setBusy(value) {
  saving = value;
  for (const control of form.querySelectorAll('button,input,textarea')) control.disabled = value;
  byId('save').textContent = value ? 'Saving…' : 'Save idea';
}
editor.addEventListener('cancel', e => { if (saving) e.preventDefault(); });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (photoPending || saving) return;
  const read = name => form.elements[name].value.trim();
  const data = {person:read('person'),title:read('title'),notes:read('notes'),price:read('price') === '' ? null : Math.round(Number(read('price')) * 100),url:read('url'),photo:draft.photo};
  if (!data.person || !data.title) { formError('Enter a name and a gift idea.'); return; }
  formError(); setBusy(true);
  try {
    await request(api + '/' + draft.id, {method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Key':draft.key},body:JSON.stringify(data)});
    preference.set(editStorage(draft.id), draft.key);
    preference.set('name.' + room, data.person);
    editor.close();
    toast(draft.editing ? 'Gift idea updated' : 'Gift idea added');
    await refresh();
  } catch (e) { formError(e.message === 'Failed to fetch' ? 'Couldn’t save. Check your connection and try again.' : e.message); }
  finally { setBusy(false); }
});
byId('edit').addEventListener('click', () => { byId('detail').close(); openEditor(selected); });
byId('remove').addEventListener('click', () => {
  byId('delete-name').textContent = form.elements.title.value;
  byId('delete-dialog').showModal(); byId('delete-cancel').focus();
});
byId('delete-cancel').addEventListener('click', () => byId('delete-dialog').close());
byId('delete-confirm').addEventListener('click', async () => {
  byId('delete-dialog').close(); setBusy(true); formError();
  try {
    await request(api + '/' + draft.id, {method:'DELETE',headers:{'X-Edit-Key':draft.key}});
    editor.close(); toast('Gift idea deleted'); await refresh();
  } catch { formError('Couldn’t delete the idea. Please try again.'); }
  finally { setBusy(false); }
});
for (const el of document.querySelectorAll('[data-close]')) el.addEventListener('click', () => el.closest('dialog').close());
for (const id of ['add','empty-action']) byId(id).addEventListener('click', () => openEditor());
byId('all-people').addEventListener('click', () => history.back());
window.addEventListener('popstate', event => {
  if (roomFromURL() === room) openPerson(event.state?.wishPerson || '');
});
let previewTimer;
form.elements.url.addEventListener('input', () => {
  clearTimeout(previewTimer);
  if (draft.photo) return;
  displayImage(byId('photo-preview'), '', '');
  previewTimer = setTimeout(() => {
    if (editor.open && !draft.photo && form.elements.url.validity.valid) {
      displayImage(byId('photo-preview'), '', form.elements.url.value.trim());
    }
  }, 450);
});
editor.addEventListener('close', () => clearTimeout(previewTimer));
for (const view of ['grid','list']) byId('view-' + view).addEventListener('click', () => { state.view = view; preference.set('view',view); render(); });
byId('share-btn').addEventListener('click', () => {
  byId('share-url').value = shareLink();
  byId('share-dialog').querySelector('p').textContent = shared ? 'Anyone with this link can view and add gift ideas.' : 'Shared storage is pending. This link opens Giftbook, but ideas are currently saved on each device.';
  byId('copy-link').textContent = 'Copy link';
  byId('share-dialog').showModal();
});
byId('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(shareLink());
    byId('share-dialog').close(); toast('Family link copied');
  } catch {
    byId('share-url').focus(); byId('share-url').select();
    byId('copy-link').textContent = 'Select and copy the link';
  }
});
byId('retry').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
setInterval(() => { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); }, 60000);
async function updateStorageNote() {
  const note = byId('storage-note');
  const sync = byId('sync-device');
  if (!shared) {
    note.firstElementChild.textContent = 'Shared storage is pending. Ideas save on this device.';
    note.hidden = false;
    return;
  }
  const drafts = await deviceCatalog.list(room).catch(() => []);
  note.hidden = !drafts.length;
  sync.hidden = !drafts.length;
  note.firstElementChild.textContent = drafts.length + (drafts.length === 1 ? ' idea is saved only on this device.' : ' ideas are saved only on this device.');
}
byId('sync-device').addEventListener('click', async () => {
  const sync = byId('sync-device');
  sync.disabled = true;
  try {
    for (const idea of await deviceCatalog.list(room)) {
      const key = preference.get(editStorage(idea.id)) || randomKey();
      preference.set(editStorage(idea.id),key);
      await request(api + '/' + idea.id, {method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Key':key}, body:JSON.stringify(idea)});
      await deviceCatalog.remove(room, idea.id);
    }
    await refresh();
    toast('Ideas shared with the family');
  } catch { toast('Couldn’t share all ideas. Try again.'); }
  finally { sync.disabled = false; await updateStorageNote(); }
});
updateStorageNote();
render();
refresh();
