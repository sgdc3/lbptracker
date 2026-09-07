/**
 * "Are you sure?" as one of our own dialogs, not the browser's.
 *
 * `window.confirm` looked like nothing else on the page and, in some
 * browsers, can be switched off by the person after a few of them, after
 * which every question is silently a "no". This is the same `<dialog>` the
 * help and the picker use, with the question, a plain way out and the one
 * button that does the thing. Escape and the backdrop are "no".
 */

import { confineWheel } from './help.ts';

export function confirmDialog(question: string, doIt = 'do it', dontDoIt = 'cancel'): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'picker-dialog confirm-dialog';
    confineWheel(dialog);
    dialog.innerHTML =
      '<div class="picker-box">' +
      '<p class="confirm-question"></p>' +
      '<div class="row picker-foot"><span class="spacer"></span>' +
      '<button type="button" class="confirm-no"></button>' +
      '<button type="button" class="confirm-yes primary"></button>' +
      '</div></div>';
    // Text, never markup: the question can carry a song's or a row's name.
    dialog.querySelector('.confirm-question')!.textContent = question;
    const no = dialog.querySelector<HTMLButtonElement>('.confirm-no')!;
    const yes = dialog.querySelector<HTMLButtonElement>('.confirm-yes')!;
    no.textContent = dontDoIt;
    yes.textContent = doIt;
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    no.addEventListener('click', () => finish(false));
    yes.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    yes.focus();
  });
}
