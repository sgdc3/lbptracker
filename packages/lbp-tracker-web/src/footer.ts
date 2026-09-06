/**
 * The text footer: whose work this stands on, and whose it is not. The credit
 * line -- name, version, author, licence -- lives in the fixed status bar
 * instead (`index.html`, filled by `daw.ts`), where every view shows it.
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
 * `steering/game-assets.md` now says where a deployment gets the assets is the
 * deployment's decision, and the Cloudflare deployment ships them
 * (`dev/stage-site.ts`), so the two agree.
 */

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
  // ⚠️ No "everything runs in your browser" here: the home view already says
  // it, and the same claim twice on one screen reads as a slogan rather than
  // as the fact it is.
  foot.innerHTML =
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
