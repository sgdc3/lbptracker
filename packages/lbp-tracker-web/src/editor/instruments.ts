/**
 * The instrument palette: what the game's 68 `.rinst` files are called, which
 * family each belongs to, and the colour the board paints that family.
 *
 * ⚠️ **None of this is the game's art.** The game shows each instrument as a
 * texture (`PInstrument.Icon`) that this project cannot ship; the chip on the
 * board is a colour and a glyph of our own, chosen so that a kit, a synth and a
 * guitar are told apart at a glance the way they are in the game's grid.
 *
 * The family comes from the asset's path in the manifest
 * (`gamedata/audio/music/instruments/<family>/x.rinst`), which the staging
 * step keeps; a manifest without paths falls back to the file name.
 */

export interface InstrumentInfo {
  readonly guid: number;
  /** `piano`, `e_guitar_power` -> "piano", "e guitar power". */
  readonly name: string;
  readonly family: string;
  readonly colour: string;
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

/** The most-used instruments in the corpus, first in the palette. */
export const POPULAR_GUIDS = [129085, 129081, 148321, 129031, 129084, 129089, 129083, 186897, 132205, 129080];

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
    out.push({
      guid: row.guid,
      name: row.file.replace(/\.rinst$/, '').replace(/_/g, ' '),
      family,
      colour: FAMILY_COLOURS[family] ?? UNKNOWN_COLOUR,
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
  guid: 0, name: '(no instrument)', family: '', colour: UNKNOWN_COLOUR,
};

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
