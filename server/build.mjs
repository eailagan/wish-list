import {mkdir, readFile, writeFile, copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(root, 'dist');
const api = await readFile(path.join(root, 'server/catalog.mjs'), 'utf8');
const entry = `
export default {
  fetch(request, env) {
    const {pathname} = new URL(request.url);
    if (pathname.startsWith('/api/')) return serveCatalog(request, env);
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') {
        return Response.redirect('https://eailagan.github.io/wish-list/', 302);
      }
      if (pathname === '/favicon.ico') {
        return Response.redirect('https://eailagan.github.io/wish-list/giftbook.svg', 302);
      }
    }
    return new Response('Not found', {status:404});
  }
};
`;
await mkdir(path.join(out, 'server'), {recursive:true});
await mkdir(path.join(out, '.openai'), {recursive:true});
await writeFile(path.join(out, 'server/index.js'), api + entry);
await copyFile(path.join(root, '.openai/hosting.json'), path.join(out, '.openai/hosting.json'));
