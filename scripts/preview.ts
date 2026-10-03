// Serve a folder like GitHub Pages does (static files only, no special headers), optionally under a sub-path:
//   node scripts/preview.ts dist /MonstersGame/ 8080      ->  http://localhost:8080/MonstersGame/
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const [dir = 'dist', base = '/', port = '8080'] = process.argv.slice(2);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (!path.startsWith(base)) {
    res.writeHead(404).end('not found (this preview only serves ' + base + ')');
    return;
  }
  let file = join(dir, normalize(path.slice(base.length)));
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file.startsWith(dir) || !existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }); // deliberately no COOP/COEP headers
  createReadStream(file).pipe(res);
}).listen(Number(port), () => console.log(`serving ${dir}/ at http://localhost:${port}${base}`));
