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

/**
 * Where on disk a URL might be, best guess first.
 *
 * `dev/` is the **web root, not a path segment**: the pages live there but
 * import out of `src/`, so serving the repository root directly would put
 * `/dev/` in front of every page. Looking in `dev/` first and the repository
 * second gives the pages the URLs they deserve -- `/`, `/live.html`,
 * `/render.html` -- while `../src/...`, which the browser normalises to
 * `/src/...` once the page sits at the root, still finds its module. Old
 * `/dev/...` URLs keep working through the second candidate, so nothing
 * anyone has bookmarked breaks.
 *
 * The confinement check is per candidate, not on the result: `/../x` resolves
 * inside the repository through `dev/` and outside it through the root, and
 * only the safe one may survive.
 */
function candidates(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = `.${clean === '/' ? '/index.html' : clean}`;
  // Never serve outside the repository, whatever the URL claims.
  return [path.resolve(ROOT, 'dev', rel), path.resolve(ROOT, rel)].filter(
    (target) => target === ROOT || target.startsWith(ROOT + path.sep),
  );
}

const server = createServer(async (req, res) => {
  const tries = candidates(req.url ?? '/');
  if (tries.length === 0) {
    res.writeHead(403).end('outside the repository');
    return;
  }

  let body;
  let file;
  for (const candidate of tries) {
    try {
      body = await readFile(candidate);
      file = candidate;
      break;
    } catch {
      // Try the next place it could be.
    }
  }
  if (file === undefined) {
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
