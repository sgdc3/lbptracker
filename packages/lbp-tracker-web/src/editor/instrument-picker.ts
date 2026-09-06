/**
 * Ask which instrument, modally, and get a GUID back -- or `null`.
 *
 * A `<dialog>` with `InstrumentPicker.vue` inside: `showModal` is what makes
 * the rest of the page inert and puts the focus in the search box, and a
 * promise is the shape a "draw a chip, then ask" gesture wants. The dialog is
 * created per question and removed with its Vue app when it closes, so there
 * is nothing to keep in step between questions.
 */

import { createApp, h } from 'vue';
import InstrumentPicker from './InstrumentPicker.vue';
import type { InstrumentInfo } from './instruments.ts';

export function pickInstrument(
  instruments: readonly InstrumentInfo[],
  title = 'Which instrument?',
): Promise<number | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'picker-dialog';
    const host = document.createElement('div');
    dialog.append(host);
    document.body.append(dialog);
    let settled = false;
    const app = createApp({
      render: () => h(InstrumentPicker, {
        instruments: instruments as InstrumentInfo[],
        title,
        onPick: (guid: number) => finish(guid),
        onCancel: () => finish(null),
      }),
    });
    const finish = (guid: number | null) => {
      if (settled) return;
      settled = true;
      app.unmount();
      dialog.close();
      dialog.remove();
      resolve(guid);
    };
    // Escape closes a dialog on its own; a click on the backdrop is ours.
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) finish(null);
    });
    app.mount(host);
    dialog.showModal();
  });
}
