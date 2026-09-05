/**
 * The app's version, in one place.
 *
 * ⚠️ **`package.json` cannot be the source of truth here.** The pages import
 * `.ts` modules directly — no bundler, no build step (see
 * steering/tracker-architecture.md) — so a page that wanted the version out of
 * `package.json` would have to `fetch` it at runtime, which works behind the dev
 * server and fails the moment the tracker is served from anywhere that does not
 * publish its manifest.
 *
 * So the constant lives here and `test/version.test.ts` fails if `package.json`
 * disagrees. One source, one line to change, and the drift is caught by the
 * suite rather than by a listener reading a stale number in the footer.
 */
export const APP_VERSION = '0.1.0';
