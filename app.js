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
let requestNumber = 0, cardRequest = 0;
const pendingCardPurchases = new Set();
let draft, selected, photoWork = 0, photoPending = false, saving = false, toastTimer;
const editStorage = id => 'edit.' + room + '.' + id;
const buyerStorage = id => 'buyer.' + room + '.' + id;
function buyerHeaders(id) {
  const key = preference.get(buyerStorage(id));
  return key ? {'X-Buyer-Key':key} : {};
}
const readIdea = id => request(api + '/' + id, {headers:buyerHeaders(id)});
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
function imagesFromLink(value) {
  if (!value || !shared) return Promise.resolve([]);
  if (!linkImages.has(value)) {
    const pending = fetch(api.replace(/\/ideas$/, '/preview'), {
      method:'POST', credentials:'omit', referrerPolicy:'no-referrer',
      headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:value})
    }).then(async response => {
      if (!response.ok) throw new Error('Preview unavailable');
      const data = await response.json();
      return data.images || (data.image ? [data.image] : []);
    }).catch(() => []);
    linkImages.set(value, pending);
    pending.then(images => { if (!images.length) setTimeout(() => linkImages.delete(value), 60000); });
  }
  return linkImages.get(value);
}

function displayImage(img, photo, link) {
  const revision = String(Number(img.dataset.revision || 0) + 1);
  img.dataset.revision = revision;
  img.hidden = true;
  img.removeAttribute('src');
  const show = (images, index = 0) => {
    const src = images[index];
    if (!src || img.dataset.revision !== revision) return;
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { if (img.dataset.revision === revision) img.hidden = false; };
    img.onerror = () => { if (img.dataset.revision === revision) { img.hidden = true; show(images, index + 1); } };
    img.src = src;
  };
  if (photo) show([photo]);
  else if (link) imagesFromLink(link).then(show);
}

function makeCard(idea) {
  const entry = make('article', 'gift-entry');
  const card = make('div', 'idea');
  const visual = make('span', 'idea-visual');
  visual.append(icon('gift'));
  entry.append(card);
  if (idea.hiddenPurchase) {
    card.classList.add('purchased-placeholder');
    card.setAttribute('role', 'group');
    card.setAttribute('aria-disabled', 'true');
    card.append(visual, make('span', 'idea-info', 'Purchased gift'));
    return entry;
  }
  if (idea.photo || idea.url) {
    const photo = make('img');
    photo.alt = '';
    visual.append(photo);
    displayImage(photo, idea.photo, idea.url);
  }
  const info = make('span', 'idea-info');
  const open = make('button', 'idea-title', idea.title);
  open.type = 'button';
  open.dataset.id = idea.id;
  open.addEventListener('click', () => openCard(idea));
  info.append(open);
  if (idea.price !== null) info.append(make('span', 'idea-price', money(idea.price)));
  if (idea.boughtByYou) info.append(make('span', 'buyer-note', 'You bought this'));
  card.append(visual, info);
  if (preference.get(editStorage(idea.id))) {
    enablePhotoDrop(card, file => openCard(idea, {edit:true, file}));
  }
  if (shared) {
    const action = make('button', 'card-purchase ' + (idea.boughtByYou ? 'secondary' : 'primary'),
      idea.boughtByYou ? 'Undo purchase' : 'Mark as bought');
    action.type = 'button';
    action.dataset.id = idea.id;
    action.setAttribute('aria-description', idea.title);
    if (pendingCardPurchases.has(idea.id)) action.setAttribute('aria-disabled', 'true');
    action.addEventListener('click', () => changeCardPurchase(idea, action));
    entry.append(action);
  }
  return entry;
}

async function openCard(idea, {edit = false, file} = {}) {
  const version = ++cardRequest;
  try {
    const current = shared ? await readIdea(idea.id) : idea;
    if (version !== cardRequest || document.querySelector('dialog[open]')) return;
    if (current.hiddenPurchase) {
      state.ideas = state.ideas.map(item => item.id === current.id ? current : item);
      render();
      toast('This gift has been purchased.');
    } else if (edit) {
      openEditor(current);
      if (file) applyPhoto(file);
    } else {
      showDetail(current);
    }
  } catch {
    if (version === cardRequest) { toast('Couldn’t open this gift. Please try again.'); refresh(); }
  }
}

function openPerson(name, moveFocus = true) {
  cardRequest++;
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
  const focusedPurchase = document.activeElement?.classList.contains('card-purchase');
  byId('collection-title').textContent = inside ? state.person : 'Family member';
  byId('all-people').hidden = !inside;
  byId('view-options').hidden = !inside;
  byId('known-people').replaceChildren(...state.people.map(name => new Option(name)));
  people.hidden = inside;
  people.replaceChildren(...(inside ? [] : state.people.map(makePerson)));
  list.hidden = !inside;
  list.classList.toggle('list', state.view === 'list');
  list.replaceChildren(...(inside ? state.ideas.map(makeCard) : []));
  if (focusedPerson) [...people.querySelectorAll('button')].find(el => el.dataset.person === focusedPerson)?.focus({preventScroll:true});
  if (focusedId) {
    const controls = list.querySelectorAll(focusedPurchase ? '.card-purchase' : '.idea-title');
    [...controls].find(el => el.dataset.id === focusedId)?.focus({preventScroll:true});
  }
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
      if (person && shared) {
        const visible = await Promise.all(entries.map(idea => {
          if (idea.hiddenPurchase && preference.get(buyerStorage(idea.id))) return readIdea(idea.id).catch(() => idea);
          return idea;
        }));
        if (number !== requestNumber) return;
        results.push(...visible);
      } else results.push(...entries);
      cursor = page.cursor;
    } while (cursor);
    if (person) {
      state.ideas = results.sort((a,b) => b.created.localeCompare(a.created) || a.id.localeCompare(b.id));
      const detail = byId('detail');
      const openId = detail.open ? selected?.id : editor.open && draft?.editing ? draft.id : null;
      if (openId && results.some(idea => idea.id === openId && idea.hiddenPurchase)) {
        if (byId('delete-dialog').open) byId('delete-dialog').close();
        if (detail.open) detail.close();
        if (editor.open) editor.close();
        toast('This gift has been purchased.');
      }
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
  purchase.open = Boolean(idea.boughtByYou);
  purchase.hidden = !shared;
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

const purchase = byId('purchase');
const purchaseAction = byId('purchase-action');
const purchaseStatus = byId('purchase-status');
let purchaseRequest = 0;

function requestPurchase(id, method) {
  const storageKey = buyerStorage(id);
  let key = preference.get(storageKey);
  if (method === 'PUT' && !key) {
    key = randomKey();
    preference.set(storageKey, key);
  }
  const url = api.replace(/\/ideas$/, '/purchases/') + id;
  return request(url, {method, headers: key ? {'X-Edit-Key':key} : {}});
}

async function changeCardPurchase(idea, button) {
  if (pendingCardPurchases.has(idea.id)) return;
  cardRequest++;
  pendingCardPurchases.add(idea.id);
  button.setAttribute('aria-disabled', 'true');
  try {
    const result = await requestPurchase(idea.id, idea.boughtByYou ? 'DELETE' : 'PUT');
    const current = result.bought && !result.yours
      ? {id:idea.id, created:idea.created, hiddenPurchase:true}
      : {...idea, boughtByYou:result.yours};
    state.ideas = state.ideas.map(item => item.id === idea.id ? current : item);
    toast(result.yours ? 'Marked as bought.' : result.bought ? 'Someone already bought this gift.' : 'Purchase mark removed.');
  } catch (error) {
    toast(error.message === 'Failed to fetch' ? 'Couldn’t update the purchase. Try again.' : error.message);
  } finally {
    pendingCardPurchases.delete(idea.id);
    render();
    refresh();
  }
}

async function updatePurchase(method = 'GET') {
  if (!purchase.open || !byId('detail').open) return;
  const id = selected.id;
  const version = ++purchaseRequest;
  purchaseAction.disabled = true;
  try {
    const result = await requestPurchase(id, method);
    if (method !== 'GET' || (result.bought && !result.yours)) refresh();
    if (version !== purchaseRequest) return;
    if (result.bought && !result.yours) {
      byId('detail').close();
      toast('This gift has been purchased.');
      return;
    }
    purchaseStatus.textContent = result.yours ? 'You marked this gift as bought.' : 'No one has marked this gift as bought.';
    purchaseAction.hidden = false;
    purchaseAction.textContent = result.yours ? 'Undo purchase mark' : 'Mark as bought';
    purchaseAction.dataset.method = result.yours ? 'DELETE' : 'PUT';
  } catch (error) {
    if (version !== purchaseRequest) return;
    purchaseStatus.textContent = error.message === 'Failed to fetch' ? 'Couldn’t reach the list. Try checking again.' : error.message;
    purchaseAction.hidden = false;
    purchaseAction.textContent = 'Check again';
    purchaseAction.dataset.method = 'GET';
  } finally {
    if (version === purchaseRequest) purchaseAction.disabled = false;
  }
}

purchase.addEventListener('toggle', () => {
  purchaseRequest++;
  purchaseAction.hidden = true;
  purchaseStatus.textContent = purchase.open ? 'Checking…' : '';
  if (purchase.open) updatePurchase();
});
purchaseAction.addEventListener('click', () => updatePurchase(purchaseAction.dataset.method));
byId('detail').addEventListener('close', () => {
  purchaseRequest++;
  purchase.open = false;
  selected = null;
  byId('detail').classList.remove('photo-drag-over');
  for (const id of ['detail-person','detail-title','detail-notes','detail-price']) byId(id).textContent = '';
  byId('detail-link').removeAttribute('href');
  displayImage(byId('detail-image'), '', '');
});

const photoOptions = byId('photo-options');
const photoStatus = byId('photo-options-status');
let previewTimer, previewVersion = 0;

function setPhoto(value, automatic = false) {
  draft.photo = value;
  draft.autoPhoto = automatic;
  const uploaded = value.startsWith('data:');
  displayImage(byId('photo-preview'), uploaded ? value : '', '');
  byId('photo-label').textContent = uploaded ? 'Change photo' : 'Upload photo';
  byId('remove-photo').hidden = !uploaded;
  for (const button of photoOptions.children) {
    button.setAttribute('aria-pressed', String(button.dataset.src === value));
  }
}

function loadPhotoOptions(delay = 0) {
  clearTimeout(previewTimer);
  const version = ++previewVersion;
  const input = form.elements.url;
  const url = input.value.trim();
  const valid = shared && input.validity.valid && /^https?:/i.test(url);
  byId('linked-photos').hidden = !valid;
  photoOptions.replaceChildren();
  photoStatus.textContent = valid ? 'Finding photos…' : '';
  if (!valid) return;
  previewTimer = setTimeout(async () => {
    const images = await imagesFromLink(url);
    if (!editor.open || version !== previewVersion) return;
    const candidates = [...images];
    if (draft.photo.startsWith('https://') && !candidates.includes(draft.photo)) candidates.unshift(draft.photo);
    const emptyMessage = 'No photos available from this link. You can upload one.';
    if (!candidates.length) { photoStatus.textContent = emptyMessage; return; }
    let remaining = candidates.length;
    const current = () => editor.open && version === previewVersion;
    const showEmpty = () => {
      if (current() && !photoOptions.querySelector('button:not([hidden])')) photoStatus.textContent = emptyMessage;
    };
    previewTimer = setTimeout(showEmpty, 10000);
    candidates.forEach((src, index) => {
      const button = make('button', 'photo-option');
      button.type = 'button';
      button.hidden = true;
      button.dataset.src = src;
      button.setAttribute('aria-label', 'Choose product photo ' + (index + 1));
      button.setAttribute('aria-pressed', String(src === draft.photo));
      const image = make('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.onload = () => {
        if (!current()) return;
        remaining--;
        if (image.naturalWidth < 20 || image.naturalHeight < 20) { if (!remaining) showEmpty(); return; }
        button.hidden = false;
        photoStatus.textContent = 'Choose a product photo';
        if (!draft.photo || draft.autoPhoto) setPhoto(photoOptions.querySelector('button:not([hidden])').dataset.src, true);
      };
      image.onerror = () => { if (!--remaining) showEmpty(); };
      button.addEventListener('click', () => {
        if (saving) return;
        ++photoWork;
        photoPending = false;
        byId('save').disabled = false;
        byId('photo-file').value = '';
        setPhoto(src);
      });
      button.append(image);
      photoOptions.append(button);
      image.src = src;
    });
  }, delay);
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
  loadPhotoOptions();
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

async function applyPhoto(file) {
  if (!file || !editor.open || saving) return;
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
}
byId('photo-file').addEventListener('change', event => applyPhoto(event.target.files[0]));

function enablePhotoDrop(target, accept, allowed = () => true) {
  target.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files') || !allowed()) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('photo-drag-over');
  });
  target.addEventListener('dragleave', event => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('photo-drag-over');
  });
  target.addEventListener('drop', event => {
    target.classList.remove('photo-drag-over');
    const files = event.dataTransfer.files;
    if (!files.length || !allowed()) return;
    event.preventDefault();
    event.stopPropagation();
    if (files.length !== 1 || (files[0].type && !files[0].type.startsWith('image/'))) {
      const message = 'Choose one image file.';
      if (editor.open) formError(message); else toast(message);
      return;
    }
    accept(files[0]);
  });
}
enablePhotoDrop(editor, applyPhoto, () => !saving);
enablePhotoDrop(byId('detail'), file => {
  const idea = selected;
  byId('detail').close();
  openCard(idea, {edit:true, file});
}, () => Boolean(selected && preference.get(editStorage(selected.id))));
for (const type of ['dragover','drop']) {
  document.addEventListener(type, event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'none';
  });
}
byId('remove-photo').addEventListener('click', () => {
  ++photoWork; photoPending = false; byId('save').disabled = false;
  setPhoto(photoOptions.querySelector('button:not([hidden])')?.dataset.src || '', true);
  byId('photo-file').value = '';
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
    await request(api + '/' + draft.id, {method:'PUT',headers:{'Content-Type':'application/json','X-Edit-Key':draft.key,...buyerHeaders(draft.id)},body:JSON.stringify(data)});
    preference.set(editStorage(draft.id), draft.key);
    preference.set('name.' + room, data.person);
    editor.close();
    toast(draft.editing ? 'Gift idea updated' : 'Gift idea added');
    await refresh();
  } catch (e) { formError(e.message === 'Failed to fetch' ? 'Couldn’t save. Check your connection and try again.' : e.message); }
  finally { setBusy(false); }
});
byId('edit').addEventListener('click', () => {
  const idea = selected;
  byId('detail').close();
  openCard(idea, {edit:true});
});
byId('remove').addEventListener('click', () => {
  byId('delete-name').textContent = form.elements.title.value;
  byId('delete-dialog').showModal(); byId('delete-cancel').focus();
});
byId('delete-cancel').addEventListener('click', () => byId('delete-dialog').close());
byId('delete-confirm').addEventListener('click', async () => {
  byId('delete-dialog').close(); setBusy(true); formError();
  try {
    await request(api + '/' + draft.id, {method:'DELETE',headers:{'X-Edit-Key':draft.key,...buyerHeaders(draft.id)}});
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
form.elements.url.addEventListener('input', () => {
  if (draft.photo.startsWith('https://')) setPhoto('');
  loadPhotoOptions(400);
});
editor.addEventListener('close', () => {
  clearTimeout(previewTimer);
  previewVersion++;
  photoWork++;
  editor.classList.remove('photo-drag-over');
});
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
function refreshVisibleView() {
  if (document.hidden || saving) return;
  refresh();
  if (purchase.open && !purchaseAction.disabled) updatePurchase();
}
document.addEventListener('visibilitychange', refreshVisibleView);
window.addEventListener('focus', refreshVisibleView);
setInterval(() => { if (state.person) refreshVisibleView(); }, 15000);
setInterval(() => { if (!state.person) refreshVisibleView(); }, 60000);
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
