/**
 * The Mixer view: the song's settings (`MixerPanel.vue`) beside the engine
 * switches (`controls/engine.ts`, drawn by the shared control panel) and the
 * live meters -- notes sounding, dropouts, voices the pool has taken back.
 */

import { createApp, h } from 'vue';
import ControlPanel from '../controls/ControlPanel.vue';
import { CONTROLS } from '../controls/kit.ts';
import { engine } from '../controls/engine.ts';
import MixerPanel from './MixerPanel.vue';
import { onPlan, onPlayer, player, state } from './session.ts';

export function mountMixer(): void {
  const host = document.getElementById('mixer')!;
  const song = document.createElement('div');
  const engineHost = document.createElement('div');
  engineHost.style.marginTop = '1rem';
  const meters = document.createElement('div');
  meters.id = 'meters';
  meters.style.cssText = 'display:flex; gap:1.2rem; flex-wrap:wrap; margin-top:.8rem; font:.82rem/1.5 ui-monospace, Consolas, monospace; color: var(--dim)';
  host.append(song, engineHost, meters);

  createApp({ render: () => h(MixerPanel, { state }) }).mount(song);

  const app = createApp({ render: () => h(ControlPanel, { grid: 'live' }) });
  app.provide(CONTROLS, engine);
  app.mount(engineHost);

  let stolen = 0;
  let notes = 0;
  let dropouts = 0;
  const show = () => {
    meters.innerHTML = [
      ['voices planned', player.plan.length.toLocaleString()],
      ['notes sounding', String(notes)],
      ['stolen so far', String(stolen)],
      ['dropouts', String(dropouts)],
    ].map(([k, v]) => `<span>${k} <b style="color:var(--ink);font-weight:500">${v}</b></span>`).join('');
  };
  onPlayer({
    health: (h) => {
      notes = h.notes;
      dropouts = h.dropouts;
      show();
    },
    stolen: (total) => {
      stolen = total;
      show();
    },
  });
  onPlan(show);
  show();
}
