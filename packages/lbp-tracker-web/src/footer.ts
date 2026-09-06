/**
 * The footer every page carries: what this is, whose work it stands on, and
 * whose it is not.
 *
 * ⚠️ **Injected rather than copied into four HTML files.** The nav is
 * duplicated markup already and it is the thing that goes stale — the same
 * reason `packages/lbp-tracker-web/src/open-level.ts` and `packages/lbp-tracker-web/src/seq-picker.ts` exist. A page opts in with
 * one import; nothing here needs a page to be edited again.
 *
 * ❗ **The disclaimer is not decoration**, and it says only what is true. It
 * used to add "no game data is included here", which was right for a tracker
 * that only ever read the user's own copy and **stops being right the moment the
 * site serves the banks itself** -- the plan of record. A footer that claims
 * more than the deployment does is worse than one that claims nothing, so what
 * is left is the trademark disclaimer, which is true either way.
 *
 * ⚠️ `steering/game-assets.md` still says the tracker "must not redistribute
 * them". That stance and this deployment cannot both stand; the steering note is
 * the one to settle, not this file.
 */

import { APP_VERSION } from './version.ts';

/** A link that never leaks the referrer and never gets window access. */
const link = (href: string, text: string): string =>
  `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;

/**
 * Append the footer to the page.
 *
 * Idempotent, because a page that mounts it twice would otherwise show it
 * twice, and the cost of the guard is one line.
 */
export function mountFooter(): void {
  if (document.querySelector('.site-foot')) return;
  const foot = document.createElement('footer');
  foot.className = 'site-foot';
  foot.innerHTML =
    `<p class="site-foot-line"><b>LBP Tracker</b> <span class="site-foot-v">v${APP_VERSION}</span>` +
    // ⚠️ No "everything runs in your browser" here: the nav already says
    // "everything runs on your machine", and the same claim twice on one screen
    // reads as a slogan rather than as the fact it is.
    ' · by <b>sgdc3</b> · MIT licensed</p>' +
    '<p class="site-foot-line">Standing on ' +
    link('https://github.com/ennuo/toolkit', 'ennuo’s craftworld toolkit') +
    ', which is the reference this project checks its resource reading against; ' +
    link('https://zaprit.fish', 'Zaprit’s LBP Search Facility') +
    ' and the ' +
    link('https://archive.org/details/@tamiya99', 'Internet Archive') +
    ', where the levels survive. Built with the help of AI.</p>' +
    '<p class="site-foot-line site-foot-small">Not affiliated with, endorsed by or connected to ' +
    'Sony Interactive Entertainment or Media Molecule. LittleBigPlanet is their trademark, and the ' +
    'instrument samples are their work.</p>';
  document.body.append(foot);
}
