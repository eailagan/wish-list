const roomPattern = /^[a-f0-9]{48}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const encoder = new TextEncoder();
const maxPhotoChars = 196608;

class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8'}});
}

function field(data, key, max, required = false) {
  const value = data[key] ?? '';
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) {
    throw new InputError('Check the ' + key + ' field.');
  }
  return value.trim();
}

function validate(data) {
  if (!data || typeof data !== 'object') throw new InputError('Invalid gift idea.');
  const person = field(data, 'person', 60, true);
  const title = field(data, 'title', 120, true);
  const notes = field(data, 'notes', 1000);
  const url = field(data, 'url', 2048);
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { throw new InputError('Enter a valid product link.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new InputError('Enter an http or https product link.');
    }
  }
  const price = data.price === null || data.price === undefined ? null : data.price;
  if (price !== null && (!Number.isSafeInteger(price) || price < 0 || price > 999999999)) {
    throw new InputError('Enter a valid price.');
  }
  const photo = field(data, 'photo', maxPhotoChars);
  if (photo && !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(photo)) {
    throw new InputError('Please choose a JPEG-compatible photo.');
  }
  return {person, title, notes, url, price, photo};
}

async function readBody(request, limit = maxPhotoChars + 11000) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    throw new InputError('Send a JSON gift idea.', 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new InputError('A gift idea is required.');
  const chunks = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new InputError('This photo is too large.', 413);
    }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); }
  catch { throw new InputError('Invalid gift idea.'); }
}

async function editHash(request) {
  const key = request.headers.get('x-edit-key') || '';
  if (!roomPattern.test(key)) throw new InputError('This browser does not have the edit key.', 403);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(key));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
}

// All outbound requests use the Worker's public-internet fetch, without caller headers or credentials.
function storefrontURL(value, base) {
  try {
    const url = new URL(value, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(host)) return null;
    if (/(^|\.)(localhost|local|internal|test|invalid|example|lan|home|arpa|onion|chatgpt\.site)$/.test(host)) return null;
    url.hostname = host;
    url.protocol = 'https:';
    url.hash = '';
    return url;
  } catch { return null; }
}

async function headMarkup(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let markup = '';
  let remaining = 512 * 1024;
  try {
    while (remaining > 0) {
      const {done, value} = await reader.read();
      if (done) break;
      const slice = value.subarray(0, remaining);
      remaining -= slice.length;
      markup += decoder.decode(slice, {stream:true});
    }
    return markup + decoder.decode();
  } finally { reader.cancel().catch(() => {}); }
}

async function extractImage(markup, pageURL) {
  const candidates = new Map();
  let base = pageURL;
  const remember = (rank, value) => {
    if (value && !candidates.has(rank)) candidates.set(rank, value);
  };
  const rewriter = new HTMLRewriter()
    .on('base[href]', {element(el) { base = storefrontURL(el.getAttribute('href'), pageURL) || pageURL; }})
    .on('meta', {element(el) {
      const name = (el.getAttribute('property') || el.getAttribute('name') || el.getAttribute('itemprop') || '').trim().toLowerCase();
      const index = ['og:image:secure_url','og:image','og:image:url','twitter:image','twitter:image:src','image'].indexOf(name);
      if (index >= 0) remember(index, el.getAttribute('content'));
    }})
    .on('link[rel~="image_src"]', {element(el) { remember(6, el.getAttribute('href')); }});
  for (const [rank, selector] of ['img[itemprop~="image"]','#landingImage','main img','article img'].entries()) {
    rewriter.on(selector, {element(el) {
      remember(7 + rank, el.getAttribute('data-old-hires') || el.getAttribute('data-src') || el.getAttribute('src'));
    }});
  }
  await rewriter.transform(new Response(markup, {headers:{'Content-Type':'text/html;charset=utf-8'}})).text();
  for (const [,value] of [...candidates].sort(([a],[b]) => a-b)) {
    const url = storefrontURL(value.trim().replace(/&amp;/gi,'&'), base);
    if (url) return url.href;
  }
  return '';
}

// UGG publishes its product photos under stable style-and-colour asset names.
function uggProductImage(url) {
  if (url.hostname !== 'www.ugg.com' && url.hostname !== 'ugg.com') return null;
  const style = url.pathname.match(/\/([a-z0-9]{3,20})\.html$/i)?.[1];
  if (!style) return null;
  const color = url.searchParams.get('dwvar_' + style + '_color') || '';
  if (!/^[a-z0-9]{2,12}$/i.test(color)) return null;
  return 'https://dms.deckers.com/ugg/image/upload/w_640,q_auto,f_auto/' + style.toUpperCase() + '-' + color.toUpperCase() + '_1.png';
}

async function discoverImage(start) {
  let pageURL = start;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5500);
  try {
    const productImage = uggProductImage(start);
    if (productImage) {
      const asset = await fetch(productImage, {method:'HEAD', redirect:'manual', signal:controller.signal}).catch(() => null);
      if (asset?.ok && asset.headers.get('content-type')?.startsWith('image/')) return productImage;
    }
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(pageURL.href, {redirect:'manual', signal:controller.signal, headers:{'Accept':'text/html,image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5'}});
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) return '';
        pageURL = storefrontURL(location, pageURL);
        if (!pageURL) return '';
        continue;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !response.body || !['text/html','application/xhtml+xml'].includes(type)) {
        response.body?.cancel().catch(() => {});
        return response.ok && /^image\/(?:jpeg|png|webp|avif|gif)$/.test(type) ? pageURL.href : '';
      }
      return await extractImage(await headMarkup(response), pageURL);
    }
  } catch { return ''; }
  finally { clearTimeout(timer); }
  return '';
}

async function linkPreview(request, endpoint) {
  const data = await readBody(request, 12000);
  const url = storefrontURL(field(data || {}, 'url', 2048, true));
  if (!url) return json({image:''});
  // Keep submitted URLs, including their query parameters, out of cache keys and access logs.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(url.href));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  const key = new Request(endpoint.origin + endpoint.pathname + '/v2/' + hex);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(key).catch(() => null);
  if (cached) return json(await cached.json());
  const image = await discoverImage(url);
  if (cache) {
    const ttl = image ? 86400 : 300;
    const result = new Response(JSON.stringify({image}), {headers:{'Cache-Control':'public, max-age=' + ttl,'Content-Type':'application/json'}});
    await cache.put(key,result).catch(() => {});
  }
  return json({image});
}

const normalizePerson = name => name.normalize('NFC').trim().toLowerCase();

async function catalogPage(bucket, prefix, url) {
  const namesOnly = url.searchParams.get('view') === 'people';
  const person = normalizePerson(url.searchParams.get('person') || '');
  const page = await bucket.list({prefix, limit:20, include:['customMetadata'], cursor:url.searchParams.get('cursor') || undefined});
  const entries = await Promise.all(page.objects.map(async object => {
    const storedName = object.customMetadata?.person;
    if (storedName) {
      const name = decodeURIComponent(storedName);
      if (namesOnly) return name;
      if (person && normalizePerson(name) !== person) return null;
    }
    const stored = await bucket.get(object.key);
    if (!stored) return null;
    const {buyerHash, ...idea} = await stored.json();
    if (namesOnly) return idea.person;
    return !person || normalizePerson(idea.person) === person ? idea : null;
  }));
  const items = entries.filter(Boolean);
  const payload = namesOnly ? {people:[...new Set(items)]} : {ideas:items};
  return json({...payload, cursor:page.truncated ? page.cursor : null});
}

async function purchaseStatus(request, bucket, key) {
  const method = request.method;
  if (!['GET', 'PUT', 'DELETE'].includes(method)) throw new InputError('Unsupported operation.', 405);
  const stored = await bucket.get(key);
  if (!stored) throw new InputError('This gift is no longer on the list.', 404);
  const record = await stored.json();
  const buyer = method === 'GET' && !request.headers.has('X-Edit-Key') ? null : await editHash(request);
  const bought = Boolean(record.buyerHash);
  const yours = bought && record.buyerHash === buyer;
  if (method === 'GET' || (method === 'PUT' && bought) || (method === 'DELETE' && !bought)) {
    return json({bought, yours});
  }
  if (method === 'DELETE' && !yours) throw new InputError('Only the buyer can undo this mark.', 403);
  if (method === 'PUT') record.buyerHash = buyer;
  else delete record.buyerHash;
  const updated = await bucket.put(key, JSON.stringify(record), {
    onlyIf: {etagMatches: stored.etag},
    customMetadata: stored.customMetadata,
    httpMetadata: stored.httpMetadata
  });
  if (!updated) throw new InputError('This gift changed. Check its purchase status again.', 409);
  return json({bought: method === 'PUT', yours: method === 'PUT'});
}

async function handle(request, env, url) {
  const [, , room, resource, id, extra] = url.pathname.split('/');
  if (!roomPattern.test(room) || extra !== undefined) throw new InputError('Catalog not found.', 404);
  if (resource === 'preview' && !id && request.method === 'POST') return linkPreview(request, url);
  if (resource === 'purchases' && idPattern.test(id || '')) {
    return purchaseStatus(request, env.BUCKET, 'catalog/' + room + '/' + id);
  }
  if (resource !== 'ideas' || (id !== undefined && !idPattern.test(id))) {
    throw new InputError('Catalog not found.', 404);
  }
  const prefix = 'catalog/' + room + '/';
  const bucket = env.BUCKET;
  if (!id && request.method === 'GET') {
    return catalogPage(bucket, prefix, url);
  }
  if (!id || !['PUT', 'DELETE'].includes(request.method)) throw new InputError('Unsupported operation.', 405);
  const hash = await editHash(request);
  const key = prefix + id;
  const current = await bucket.get(key);
  if (current && current.customMetadata?.editHash !== hash) throw new InputError('Only the browser that added this idea can edit it.', 403);
  if (request.method === 'DELETE') {
    if (current) await bucket.delete(key);
    return new Response(null, {status: 204});
  }
  const data = validate(await readBody(request));
  const created = current?.customMetadata?.created || new Date().toISOString();
  const idea = {id, created, ...data};
  const buyerHash = current && (await current.json()).buyerHash;
  const record = buyerHash ? {...idea, buyerHash} : idea;
  const written = await bucket.put(key, JSON.stringify(record), {
    onlyIf: current ? {etagMatches: current.etag} : {etagDoesNotMatch: '*'},
    customMetadata: {editHash: hash, created, person: encodeURIComponent(data.person)},
    httpMetadata: {contentType: 'application/json'}
  });
  if (!written) throw new InputError('The idea changed. Refresh and try again.', 409);
  return json(idea, current ? 200 : 201);
}

export async function serveCatalog(request, env) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const allowed = !origin || origin === url.origin || origin === 'https://eailagan.github.io';
  const headers = new Headers({'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff'});
  if (!allowed) return new Response('Origin unavailable', {status: 403, headers});
  if (origin) headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Key');
  let result;
  try {
    result = request.method === 'OPTIONS' ? new Response(null, {status: 204}) : await handle(request, env, url);
  } catch (e) {
    result = json({error: e instanceof InputError ? e.message : 'The catalog could not be reached. Please try again.'}, e instanceof InputError ? e.status : 503);
  }
  for (const [name, value] of result.headers) headers.set(name, value);
  return new Response(result.body, {status: result.status, headers});
}
