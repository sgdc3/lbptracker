/*
 * The service worker: what makes the site installable, and what lets it open
 * without a network.
 *
 * ❗ **Network first, always.** A cache-first worker would serve yesterday's
 * app after a deploy, and the app is deployed often; here every request goes
 * to the network, a copy of what comes back is kept, and the copy is only
 * used when the network fails. So an online visit is never stale, and an
 * offline one gets the last version that was seen.
 *
 * ⚠️ **Only same-origin GETs are touched.** The samples the page fetches are
 * same-origin and land in the cache like everything else, which is what lets
 * a song play offline; anything else (a level pulled from the Internet
 * Archive, say) is left to the browser.
 *
 * ⚠️ This file is served from the site's root so its scope is the whole site.
 * It is plain JavaScript on purpose: the bundler would give it a hashed name
 * under /assets/, and a worker's scope is the path it is served from.
 */

const CACHE = 'lbptracker';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      // Only a real answer is worth keeping; an error page is not.
      if (response && response.ok && response.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      // A navigation with nothing cached for it: the app's one page will do.
      if (request.mode === 'navigate') {
        const shell = await caches.match('./');
        if (shell) return shell;
      }
      throw error;
    }
  })());
});
