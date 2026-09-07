/**
 * The family glyph as a DOM element, for the places an instrument is named
 * outside the board: the sound field in the inspector and on the keyboard
 * view, and the rows of the picker. Same drawing as the chips (`drawGlyph`),
 * in the family's colour, on a small canvas sized for the device.
 */

import { drawIcon, type InstrumentInfo } from './instruments.ts';

export function glyphCanvas(info: Pick<InstrumentInfo, 'family' | 'colour' | 'icon'>, size = 18): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;
  canvas.className = 'glyph';
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = info.colour;
    ctx.strokeStyle = info.colour;
    drawIcon(ctx, info, 0, 0, size);
  }
  return canvas;
}

/**
 * Fill a sound field -- a button that opens the picker -- with the glyph and
 * the name of an instrument, or with a fallback when there is none.
 */
export function fillSoundField(field: HTMLElement, info: InstrumentInfo | undefined, fallback: string): void {
  field.textContent = '';
  if (info) field.append(glyphCanvas(info));
  const name = document.createElement('span');
  name.className = 'sound-name';
  name.textContent = info ? info.name : fallback;
  field.append(name);
}
