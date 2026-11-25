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
  const linkedPhoto = photo.startsWith('https://') && photo.length <= 4096 && url && storefrontURL(photo);
  if (photo && !linkedPhoto && !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]+=*$/.test(photo)) {
    throw new InputError('Choose a photo from the product link or upload a photo.');
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

async function editHash(request, header = 'X-Edit-Key') {
  const key = request.headers.get(header) || '';
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

const maxPreviewImages = 6;

async function extractImages(markup, pageURL) {
  const ranked = Array.from({length:4}, () => new Set());
  let base = pageURL;
  function remember(rank, value) {
    if (typeof value === 'string' && value.trim() && value.length <= 4096 && ranked[rank].size < 40) {
      ranked[rank].add(value.trim().replace(/&amp;/gi, '&'));
    }
  }
  function productData(node) {
    if (Array.isArray(node)) { node.forEach(productData); return; }
    if (!node || typeof node !== 'object') return;
    const types = [].concat(node['@type'] || []);
    if (types.some(type => /(?:^|\/)(Product|ProductGroup)$/.test(type))) {
      for (const image of [].concat(node.image || [])) {
        remember(0, typeof image === 'string' ? image : image?.contentUrl || image?.url || image?.['@id']);
      }
    }
    if (node['@graph']) productData(node['@graph']);
    if (node.mainEntity) productData(node.mainEntity);
  }
  let script = null;
  const rewriter = new HTMLRewriter()
    .on('base[href]', {element(el) { base = storefrontURL(el.getAttribute('href'), pageURL) || pageURL; }})
    .on('script[type="application/ld+json"]', {
      element(el) {
        script = '';
        el.onEndTag(() => {
          if (script) { try { productData(JSON.parse(script)); } catch {} }
          script = null;
        });
      },
      text(chunk) {
        if (script !== null) script = script.length + chunk.text.length <= 192 * 1024 ? script + chunk.text : null;
      }
    })
    .on('meta', {element(el) {
      const name = (el.getAttribute('property') || el.getAttribute('name') || el.getAttribute('itemprop') || '').trim().toLowerCase();
      if (['og:image','og:image:secure_url','og:image:url','twitter:image','twitter:image:src','image'].includes(name)) {
        remember(1, el.getAttribute('content'));
      }
    }})
    .on('link[rel~="image_src"]', {element(el) { remember(1, el.getAttribute('href')); }});
  function imageElement(rank) {
    return {element(el) {
      const sourceSet = el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
      const sizes = Array.from(sourceSet.matchAll(/(?:^|,\s*)\s*(\S+)\s+(\d+(?:\.\d+)?)([wx])(?=\s*(?:,|$))/g),
        ([, src, size, unit]) => ({src, width:Number(size) * (unit === 'x' ? 480 : 1)}));
      sizes.sort((a,b) => a.width - b.width);
      const source = (sizes.find(size => size.width >= 640) || sizes.at(-1))?.src;
      remember(rank, el.getAttribute('data-zoom-image') || el.getAttribute('data-old-hires') ||
        el.getAttribute('data-src') || source || el.getAttribute('src'));
    }};
  }
  for (const selector of ['img[itemprop~="image"]', '#landingImage', 'img[data-zoom-image]', '[data-product-media] img',
                          '[class*="product-gallery"] img', '[class*="product__media"] img', '[class*="product-image"] img']) {
    rewriter.on(selector, imageElement(2));
  }
  rewriter.on('main img', imageElement(3)).on('article img', imageElement(3));
  await rewriter.transform(new Response(markup, {headers:{'Content-Type':'text/html;charset=utf-8'}})).text();
  const images = [];
  const seen = new Set();
  for (const group of ranked) {
    if (group === ranked[3] && images.length > 1) break;
    for (const value of group) {
      const url = storefrontURL(value, base);
      if (!url || url.href.length > 4096 || /\.svg$/i.test(url.pathname) ||
          /(?:^|[/_.-])(?:placeholder|spacer|favicon|sprite|logo)(?:[/_.-]|$)/i.test(url.pathname)) continue;
      const identity = new URL(url);
      for (const size of ['width','height','w','h','dpr','quality']) identity.searchParams.delete(size);
      if (/^\?\d{8,}=?$/.test(identity.search)) identity.search = '';
      if (seen.has(identity.href)) continue;
      seen.add(identity.href);
      images.push(url.href);
      if (images.length === maxPreviewImages) return images;
    }
  }
  return images;
}

// UGG's numbered product views share the style and colour in the product link.
function uggProductImages(url) {
  if (url.hostname !== 'www.ugg.com' && url.hostname !== 'ugg.com') return [];
  const style = url.pathname.match(/\/([a-z0-9]{3,20})\.html$/i)?.[1];
  if (!style) return [];
  const color = url.searchParams.get('dwvar_' + style + '_color') || '';
  if (!/^[a-z0-9]{2,12}$/i.test(color)) return [];
  const prefix = 'https://dms.deckers.com/ugg/image/upload/w_640,q_auto,f_auto/' + style.toUpperCase() + '-' + color.toUpperCase() + '_';
  return Array.from({length:maxPreviewImages}, (_, index) => prefix + (index + 1) + '.png');
}

async function discoverImages(start) {
  let pageURL = start;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const candidates = uggProductImages(start);
    if (candidates.length) {
      const verified = await Promise.all(candidates.map(async image => {
        const asset = await fetch(image, {method:'HEAD', redirect:'manual', signal:controller.signal}).catch(() => null);
        return asset?.ok && asset.headers.get('content-type')?.startsWith('image/') ? image : null;
      }));
      if (verified.some(Boolean)) return verified.filter(Boolean);
    }
    for (let redirects = 0; redirects <= 3; redirects++) {
      const response = await fetch(pageURL.href, {redirect:'manual', signal:controller.signal, headers:{'Accept':'text/html,image/avif,image/webp,image/jpeg,image/png,*/*;q=0.5'}});
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) return [];
        pageURL = storefrontURL(location, pageURL);
        if (!pageURL) return [];
        continue;
      }
      const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !response.body || !['text/html','application/xhtml+xml'].includes(type)) {
        response.body?.cancel().catch(() => {});
        return response.ok && /^image\/(?:jpeg|png|webp|avif|gif)$/.test(type) ? [pageURL.href] : [];
      }
      return await extractImages(await headMarkup(response), pageURL);
    }
  } catch { return []; }
  finally { clearTimeout(timer); }
  return [];
}

async function linkPreview(request, endpoint) {
  const data = await readBody(request, 12000);
  const url = storefrontURL(field(data || {}, 'url', 2048, true));
  if (!url) return json({image:'', images:[]});
  // Keep submitted URLs, including their query parameters, out of cache keys and access logs.
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(url.href));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
  const key = new Request(endpoint.origin + endpoint.pathname + '/gallery-v2/' + hex);
  const cache = globalThis.caches?.default;
  const cached = await cache?.match(key).catch(() => null);
  if (cached) return json(await cached.json());
  const images = await discoverImages(url);
  const result = {image: images[0] || '', images};
  if (cache) {
    const ttl = images.length ? 86400 : 300;
    const response = new Response(JSON.stringify(result), {headers:{'Cache-Control':'public, max-age=' + ttl,'Content-Type':'application/json'}});
    await cache.put(key,response).catch(() => {});
  }
  return json(result);
}

const normalizePerson = name => name.normalize('NFC').trim().toLowerCase();

function visibleIdea(record, buyer = null) {
  const {buyerHash, ...idea} = record;
  if (!buyerHash) return idea;
  if (buyer === buyerHash) return {...idea, boughtByYou:true};
  return {id:idea.id, created:idea.created, hiddenPurchase:true, title:'Purchased gift', price:null};
}

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
    const idea = await stored.json();
    if (namesOnly) return idea.person;
    return !person || normalizePerson(idea.person) === person ? visibleIdea(idea) : null;
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
  if (!id || !['GET','PUT','DELETE'].includes(request.method)) throw new InputError('Unsupported operation.', 405);
  const key = prefix + id;
  const current = await bucket.get(key);
  const record = current && await current.json();
  const buyer = request.headers.has('X-Buyer-Key') ? await editHash(request, 'X-Buyer-Key') : null;
  if (request.method === 'GET') {
    if (!record) throw new InputError('This gift is no longer on the list.', 404);
    return json(visibleIdea(record, buyer));
  }
  const hash = await editHash(request);
  if (current && current.customMetadata?.editHash !== hash) throw new InputError('Only the browser that added this idea can edit it.', 403);
  const buyerHash = record?.buyerHash;
  if (buyerHash && buyer !== buyerHash) throw new InputError('This gift has been purchased.', 409);
  if (request.method === 'DELETE') {
    if (current) await bucket.delete(key);
    return new Response(null, {status: 204});
  }
  const data = validate(await readBody(request));
  const created = current?.customMetadata?.created || new Date().toISOString();
  const idea = {id, created, ...data};
  const next = buyerHash ? {...idea, buyerHash} : idea;
  const written = await bucket.put(key, JSON.stringify(next), {
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
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Edit-Key, X-Buyer-Key');
  let result;
  try {
    result = request.method === 'OPTIONS' ? new Response(null, {status: 204}) : await handle(request, env, url);
  } catch (e) {
    result = json({error: e instanceof InputError ? e.message : 'The catalog could not be reached. Please try again.'}, e instanceof InputError ? e.status : 503);
  }
  for (const [name, value] of result.headers) headers.set(name, value);
  return new Response(result.body, {status: result.status, headers});
}
