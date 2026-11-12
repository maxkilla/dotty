// Build dist/worker.js: Worker + public/ files in a single module, for API/CI deploys without the assets binding.
// Usage: node scripts/bundle.mjs   (needs esbuild: npx esbuild or devDependency)
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const pub = path.join(root, 'public');
const files = {};
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p);
    else files['/' + path.relative(pub, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8');
  }
})(pub);

const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', txt: 'text/plain; charset=utf-8' };
const entry = `
import app from '${path.join(root, 'src/index.js').replace(/\\/g, '/')}';
const FILES = ${JSON.stringify(files)};
const TYPES = ${JSON.stringify(types)};
const assets = { fetch(req) {
  const u = new URL(req.url);
  let p = u.pathname;
  if (!p.includes('.') && !p.endsWith('/')) return Response.redirect(u.origin + p + '/' + u.search, 301);
  if (p.endsWith('/')) p += 'index.html';
  const body = FILES[p];
  if (body == null) return new Response('Not found', { status: 404 });
  return new Response(body, { headers: { 'content-type': TYPES[p.split('.').pop()] || 'text/plain', 'cache-control': 'public, max-age=300' } });
} };
export default { fetch: (req, env, ctx) => app.fetch(req, { ...env, ASSETS: assets }, ctx) };
`;
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
await build({ stdin: { contents: entry, resolveDir: root }, bundle: true, minify: true, format: 'esm', target: 'es2022', outfile: path.join(root, 'dist/worker.js') });
console.log('dist/worker.js', fs.statSync(path.join(root, 'dist/worker.js')).size, 'bytes');
