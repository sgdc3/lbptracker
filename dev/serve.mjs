/**
 * Zero-dependency dev server.
 *
 * The browser cannot strip TypeScript types, and this project has no bundler
 * (see steering/tracker-architecture.md). Node can strip them though --
 * `module.stripTypeScriptTypes` is built in -- so this serves .ts files as
 * JavaScript on the fly and the browser imports them directly. No build step,
 * no node_modules, and the same source runs in the browser and under
 * `node --test`.
 *
 *     node dev/serve.mjs [port]
 *
 * Binds to 127.0.0.1 only. It serves files out of the repository and nothing
 * else -- game assets are read by the page from the user's own disk through a
 * file picker and never travel over this server.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? 8173);

const TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.ts', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function resolveSafe(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.resolve(ROOT, `.${clean === '/' ? '/dev/index.html' : clean}`);
  // Never serve outside the repository, whatever the URL claims.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

const server = createServer(async (req, res) => {
  const file = resolveSafe(req.url ?? '/');
  if (!file) {
    res.writeHead(403).end('outside the repository');
    return;
  }

  let body;
  try {
    body = await readFile(file);
  } catch {
    res.writeHead(404).end(`not found: ${req.url}`);
    return;
  }

  const ext = path.extname(file);
  if (ext === '.ts') {
    try {
      body = stripTypeScriptTypes(body.toString('utf8'), {
        mode: 'strip',
        sourceUrl: req.url,
      });
    } catch (error) {
      // Report it as JavaScript so the browser console shows the real reason
      // rather than a bare syntax error from a half-stripped file.
      res.writeHead(200, { 'content-type': TYPES.get('.js') });
      res.end(`throw new Error(${JSON.stringify(`stripping ${req.url}: ${error.message}`)});`);
      return;
    }
  }

  res.writeHead(200, {
    'content-type': TYPES.get(ext) ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`lbptracker dev server: http://127.0.0.1:${PORT}/`);
  console.log(`serving ${ROOT}`);
});
