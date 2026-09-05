/**
 * The footer every page carries: what this is, whose work it stands on, and
 * whose it is not.
 *
 * ⚠️ **Injected rather than copied into four HTML files.** The nav is
 * duplicated markup already and it is the thing that goes stale — the same
 * reason `dev/open-level.ts` and `dev/seq-picker.ts` exist. A page opts in with
 * one import; nothing here needs a page to be edited again.
 *
 * ❗ **The disclaimer is not decoration.** This project reads copyrighted Sony /
 * Media Molecule material out of the user's own copy of the game and other
 * people's levels out of a public archive, and it redistributes neither. Saying
 * so on every page is the honest version of a stance that
 * `steering/game-assets.md` calls a design constraint rather than a footnote.
 */

import { APP_VERSION } from '../src/version.ts';

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
    ' · MIT licensed · everything runs in your browser</p>' +
    '<p class="site-foot-line">Standing on ' +
    link('https://github.com/ennuo/toolkit', 'ennuo’s craftworld toolkit') +
    ', which is the reference this project checks its resource reading against; ' +
    link('https://zaprit.fish', 'Zaprit’s LBP Search Facility') +
    ' and the ' +
    link('https://archive.org/details/@tamiya99', 'Internet Archive') +
    ', where the levels survive.</p>' +
    '<p class="site-foot-line site-foot-small">Not affiliated with, endorsed by or connected to ' +
    'Sony Interactive Entertainment or Media Molecule. LittleBigPlanet is their trademark. ' +
    '<b>No game data is included here.</b> The instrument samples are read from your own copy of ' +
    'the game, in this tab, and never uploaded; a level opened from the archive is its creator’s ' +
    'work and is fetched by your browser, not by any server of ours.</p>';
  document.body.append(foot);
}
