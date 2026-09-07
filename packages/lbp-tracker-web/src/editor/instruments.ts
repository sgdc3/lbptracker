/**
 * The instrument palette: what the game's 68 `.rinst` files are called, which
 * family each belongs to, and the colour the board paints that family.
 *
 * ❗ **The icons are the game's own, traced** (`icons.ts`, and the licensing
 * note in steering/game-assets.md): each is the silhouette of the texture the
 * instrument's palette item carries, so a chip says which sound it is the way
 * the game's grid does. The colour behind it is ours, by family, and a sound
 * with no icon falls back to a glyph of ours.
 *
 * The family comes from the asset's path in the manifest
 * (`gamedata/audio/music/instruments/<family>/x.rinst`), which the staging
 * step keeps; a manifest without paths falls back to the file name.
 */

import { ICONS, iconKeyOf } from './icons.ts';
import { INSTRUMENT_LABELS } from './instrument-labels.ts';

export interface InstrumentInfo {
  readonly guid: number;
  /**
   * What the game calls it, without its category: "Saw Wave", "Harp".
   *
   * From `INSTRUMENT_LABELS`; a GUID the table does not know falls back to its
   * file name -- `e_guitar_power` -> "e guitar power" -- which is what every
   * instrument was called before the game's own names were read.
   */
  readonly name: string;
  /** The game's own category for it: "Synth", "Plucked", "Tuned Percussion". */
  readonly category: string;
  /** The whole of the game's label, category and all, for a tooltip. */
  readonly label: string;
  readonly family: string;
  readonly colour: string;
  /** The key into `ICONS`: the file's own name. */
  readonly icon: string;
}

const FAMILY_COLOURS: Record<string, string> = {
  keys: '#e6c04a',
  guitar: '#e35d5d',
  percussion: '#8fd14f',
  synth: '#4fd1d1',
  orchestra: '#b78cf0',
  acoustic: '#f0a050',
  baiyon: '#f06ab0',
  ektara: '#f0a050',
  move_pack: '#8ea8f0',
  lbp3: '#9bd17a',
  sfx: '#9aa3ad',
};

const UNKNOWN_COLOUR = '#7c8592';

export function familyOf(file: string, path?: string): string {
  const m = path?.match(/instruments\/([^/]+)\//);
  if (m) return m[1];
  if (/kit|perc|bongo|conga|djembe|dumbek|drum/.test(file)) return 'percussion';
  if (/guitar|bass/.test(file)) return 'guitar';
  if (/piano/.test(file)) return 'keys';
  return 'synth';
}

export function instrumentsFrom(
  rows: Iterable<{ guid: number; file: string; path?: string }>,
): InstrumentInfo[] {
  const out: InstrumentInfo[] = [];
  for (const row of rows) {
    const family = familyOf(row.file, row.path);
    const label = INSTRUMENT_LABELS[row.guid] ?? '';
    const colon = label.indexOf(': ');
    out.push({
      guid: row.guid,
      name: colon > 0 ? label.slice(colon + 2) : label || row.file.replace(/\.rinst$/, '').replace(/_/g, ' '),
      category: colon > 0 ? label.slice(0, colon) : '',
      label,
      family,
      colour: FAMILY_COLOURS[family] ?? UNKNOWN_COLOUR,
      icon: iconKeyOf(row.file),
    });
  }
  // Families in the order the palette lists them, names alphabetical within.
  const order = Object.keys(FAMILY_COLOURS);
  out.sort((a, b) => {
    const fa = order.indexOf(a.family);
    const fb = order.indexOf(b.family);
    return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb) || a.name.localeCompare(b.name);
  });
  return out;
}

/** What to show for a placement with no instrument, or one not in the assets. */
export const MISSING_INSTRUMENT: InstrumentInfo = {
  guid: 0, name: '(no instrument)', category: '', label: '', family: '',
  colour: UNKNOWN_COLOUR, icon: '',
};

/**
 * The sound's own icon (`icons.ts`) in the box, or the family's glyph for a
 * file that has none. The icons are 24 units square, stroked at 2, and the
 * canvas is expected to hold the colour in `strokeStyle` and `fillStyle`.
 */
export function drawIcon(
  ctx: CanvasRenderingContext2D,
  info: Pick<InstrumentInfo, 'family' | 'icon'>,
  x: number,
  y: number,
  size: number,
): void {
  const icon = ICONS[info.icon];
  if (!icon || (!icon.d && !icon.f)) {
    drawGlyph(ctx, info.family, x, y, size);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // The traced icons are silhouettes and come as `f`; `d` is stroked, which is
  // what the line drawings this file used to hold were made of.
  if (icon.d) ctx.stroke(new Path2D(icon.d));
  if (icon.f) ctx.fill(new Path2D(icon.f));
  ctx.restore();
}

/**
 * A glyph per family, drawn on a canvas inside a box: a wave for a synth, a
 * drum for percussion, keys, a string. Deliberately plain.
 */
export function drawGlyph(
  ctx: CanvasRenderingContext2D,
  family: string,
  x: number,
  y: number,
  size: number,
): void {
  const s = size;
  ctx.save();
  ctx.translate(x, y);
  ctx.lineWidth = Math.max(1.5, s * 0.11);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (family) {
    case 'percussion':
    case 'lbp3': {
      // A drum: an ellipse head over a short shell.
      ctx.beginPath();
      ctx.ellipse(s / 2, s * 0.38, s * 0.4, s * 0.16, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s * 0.1, s * 0.38);
      ctx.lineTo(s * 0.1, s * 0.72);
      ctx.moveTo(s * 0.9, s * 0.38);
      ctx.lineTo(s * 0.9, s * 0.72);
      ctx.ellipse(s / 2, s * 0.72, s * 0.4, s * 0.16, 0, 0, Math.PI, false);
      ctx.stroke();
      break;
    }
    case 'keys': {
      // Three white keys and two black ones.
      ctx.beginPath();
      ctx.rect(s * 0.1, s * 0.2, s * 0.8, s * 0.6);
      ctx.moveTo(s * 0.37, s * 0.2);
      ctx.lineTo(s * 0.37, s * 0.8);
      ctx.moveTo(s * 0.63, s * 0.2);
      ctx.lineTo(s * 0.63, s * 0.8);
      ctx.stroke();
      ctx.fillRect(s * 0.28, s * 0.2, s * 0.18, s * 0.34);
      ctx.fillRect(s * 0.54, s * 0.2, s * 0.18, s * 0.34);
      break;
    }
    case 'guitar':
    case 'acoustic':
    case 'ektara': {
      // A neck and a body.
      ctx.beginPath();
      ctx.moveTo(s * 0.15, s * 0.85);
      ctx.lineTo(s * 0.85, s * 0.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.ellipse(s * 0.32, s * 0.68, s * 0.22, s * 0.16, -Math.PI / 4, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'orchestra':
    case 'move_pack': {
      // A note head with a stem and a flag.
      ctx.beginPath();
      ctx.ellipse(s * 0.38, s * 0.72, s * 0.18, s * 0.12, -Math.PI / 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(s * 0.54, s * 0.68);
      ctx.lineTo(s * 0.54, s * 0.15);
      ctx.quadraticCurveTo(s * 0.8, s * 0.25, s * 0.7, s * 0.5);
      ctx.stroke();
      break;
    }
    case 'sfx': {
      // A burst.
      ctx.beginPath();
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2;
        ctx.moveTo(s / 2 + Math.cos(a) * s * 0.15, s / 2 + Math.sin(a) * s * 0.15);
        ctx.lineTo(s / 2 + Math.cos(a) * s * 0.42, s / 2 + Math.sin(a) * s * 0.42);
      }
      ctx.stroke();
      break;
    }
    default: {
      // A sine wave: the synths, and anything unknown.
      ctx.beginPath();
      for (let i = 0; i <= 16; i += 1) {
        const px = s * 0.1 + (i / 16) * s * 0.8;
        const py = s / 2 - Math.sin((i / 16) * Math.PI * 2) * s * 0.28;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}
