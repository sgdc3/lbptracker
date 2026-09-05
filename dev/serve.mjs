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
 * Binds to 127.0.0.1 only. It serves files out of the repository, and makes
 * exactly one kind of outbound request:
 *
 * ❗ **`/zaprit/*` asks <https://zaprit.fish> for a level search**, because that
 * site sends no CORS headers and a page therefore cannot ask it directly. Only
 * the words a listener typed go out; the reply is parsed by `dev/lbpsearch.ts`
 * and comes back as JSON. **No level ever travels over this server** -- the
 * page reads its own disk through a file picker, and a level found by search is
 * fetched by the page straight from archive.org, which does send CORS headers.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSearch, parseSlot, searchUrl, slotUrl } from './lbpsearch.ts';

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

/** Longer than a search takes, short enough that a dead host is not a hang. */
const UPSTREAM_TIMEOUT = 20_000;

/**
 * The search proxy: two routes, GET only, one host, JSON out.
 *
 * ⚠️ **Nothing from the request is forwarded except the search words.** The
 * upstream URL is built here out of parsed parameters rather than by passing a
 * path through, so there is no query, header or method a page can smuggle
 * onward -- this is a dev server on a laptop and it should not become an open
 * proxy by accident.
 *
 * Returns `true` if it handled the request.
 */
async function zaprit(req, res, url) {
  const search = url.pathname === '/zaprit/search';
  const slot = /^\/zaprit\/slot\/(\d+)$/.exec(url.pathname);
  if (!search && !slot) return false;

  const send = (status, value) => {
    res.writeHead(status, {
      'content-type': TYPES.get('.json'),
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
  };
  if (req.method !== 'GET') {
    send(405, { error: 'GET only' });
    return true;
  }

  const id = slot ? Number(slot[1]) : 0;
  const sort = url.searchParams.get('sort');
  const query = (url.searchParams.get('q') ?? '').trim();
  // Upstream answers an empty query with a 400 and an error page. There is
  // nothing to ask on the listener's behalf, so do not ask.
  if (search && query === '') {
    send(200, { rows: [], more: false, page: 0 });
    return true;
  }
  const page = Math.max(0, Number(url.searchParams.get('page') ?? 0) || 0);
  const upstream = search
    ? searchUrl(
        query,
        page,
        sort === 'name' || sort === 'author' ? sort : 'hearts',
        url.searchParams.get('invert') === '1',
      )
    : slotUrl(id);

  try {
    const answer = await fetch(upstream, {
      headers: { accept: 'text/html', 'user-agent': 'lbptracker dev server' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
    });
    if (!answer.ok) {
      send(502, { error: `the archive answered ${answer.status}` });
      return true;
    }
    const html = await answer.text();
    if (search) {
      // The page number is ours, not the site's: see `searchUrl`.
      send(200, { ...parseSearch(html), page });
    } else {
      const found = parseSlot(html, id);
      if (found) send(200, found);
      else send(404, { error: `no root level on slot ${id}` });
    }
  } catch (error) {
    // A dev server on a laptop is offline half the time; say which half.
    send(502, { error: `could not reach the archive: ${error.message}` });
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (await zaprit(req, res, url)) return;

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
