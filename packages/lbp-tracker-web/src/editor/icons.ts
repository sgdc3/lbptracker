/**
 * One icon per sound: the 68 `.rinst` files the game ships, each drawn as a
 * line icon of our own in a 24 × 24 box, keyed by the file's name.
 *
 * ⚠️ **None of this is the game's art** (see `instruments.ts`); it is what
 * lets a chip on the board and a row in the picker say which sound it is
 * without reading the name. Stroke paths in `d`, drawn in the family's
 * colour; `f` is an optional second path filled solid for the few icons that
 * need a dot or a black key. A file with no entry here falls back to its
 * family's glyph (`drawGlyph`).
 *
 * Kept as SVG path data so the same drawing serves the canvas (`Path2D`) and
 * anything that would rather have an `<svg>`.
 */

export interface Icon {
  readonly d: string;
  readonly f?: string;
}

const keys = (top: string) =>
  `M3 10h18v9H3z M9 10v9 M15 10v9 ${top}`;
const KEYS_FILL = 'M7.5 10h3v5h-3z M13.5 10h3v5h-3z';

/** An electric guitar: an angular body, a neck to the upper right, a headstock. */
const E_GUITAR = 'M2 14c0-3 2-5 4-5 1 0 2 1 3 1s1-1 2-1c2 0 3 1 3 3v4c0 2-1 3-3 3-1 0-1-1-2-1s-2 1-3 1c-2 0-4-2-4-5z M14 13h7 M21 11v4 M6 12v4 M9 12v4';
/** A drum kit: a kick, a snare beside it and a cymbal on its stand. */
const KIT = 'M3 18a4 4 0 1 0 8 0a4 4 0 1 0-8 0z M7 18h.01 M12 14h6v3h-6z M9 9h5v3H9z M14 4h8 M18 4v10';

export const ICONS: Readonly<Record<string, Icon>> = {
  // ---------------------------------------------------------------- keys
  piano: { d: keys(''), f: KEYS_FILL },
  honky_tonk_piano: { d: keys('M4 6q2-3 4 0t4 0t4 0t4 0'), f: KEYS_FILL },
  space_piano: { d: keys('M12 3a3 3 0 1 0 0.01 0 M6 4q6 3 12 0'), f: KEYS_FILL },
  electric_piano: { d: keys('M13 2l-3 4h4l-3 4'), f: KEYS_FILL },
  electric_harpsichord: { d: keys('M5 6l2-2 2 2 2-2 2 2 2-2 2 2 2-2'), f: KEYS_FILL },

  // -------------------------------------------------------------- guitars
  bass_guitar: { d: 'M2 14c0-3.5 2.5-6 5-6 1 0 2 1 3 1s1-1 2-1c2.5 0 3.5 1.5 3.5 3.5v4c0 2-1 3.5-3.5 3.5-1 0-1-1-2-1s-2 1-3 1c-2.5 0-5-2.5-5-5z M15.5 14h6.5 M22 12v4 M20 11v-2 M22 10V8', f: 'M6 12h2v4H6z M10 12h2v4h-2z' },
  e_guitar_clean_muted: { d: `${E_GUITAR} M15 3l5 5 M20 3l-5 5` },
  e_guitar_distorted: { d: `${E_GUITAR} M19 1l-2.5 4.5h4L18 10` },
  e_guitar_power: { d: `${E_GUITAR} M18 2v3 M13.5 4.5l2 1.5 M22.5 4.5l-2 1.5 M15 9h6` },
  nylonguitar: { d: 'M2 14c0-3 2-5 4-5 1 0 2 1 3 1s1-1 2-1c2 0 3 1 3 3v4c0 2-1 3-3 3-1 0-1-1-2-1s-2 1-3 1c-2 0-4-2-4-5z M14 13h7 M21 11v4 M8 14a2 2 0 1 0 0.01 0' },
  ukulele: { d: 'M3 14c0-2.5 1.5-4 3.5-4 .8 0 1.5.8 2.5.8s1.7-.8 2.5-.8c2 0 3 1.5 3 3v2c0 1.5-1 3-3 3-.8 0-1.5-.8-2.5-.8s-1.7.8-2.5.8c-2 0-3.5-1.5-3.5-4z M14.5 14h5 M19.5 12.5v3 M8 14a1.4 1.4 0 1 0 0.01 0' },
  doublebass: { d: 'M12 6c-3 0-4.5 1.5-4 4 .3 1.3-.7 2.2-1.8 2.8-1.7 1-1.7 4 0 6 1.7 2 4 2.7 5.8 2.7s4.1-.7 5.8-2.7c1.7-2 1.7-5 0-6-1.1-.6-2.1-1.5-1.8-2.8.5-2.5-1-4-4-4z M12 6V2 M12 21.5V24 M10 14.5v3 M14 14.5v3', f: 'M12 2a1.1 1.1 0 1 0 0.01 0' },
  koto: { d: 'M2 17l20-6 M2 21l20-6 M2 17v4 M22 11v4 M5 16l0 4 M10 14.5v4 M15 13v4 M20 11.5v4 M6 15l-1-2 M11 13.5l-1-2 M16 12l-1-2' },
  ektara: { d: 'M12 2v14 M12 22a4 4 0 1 0 0.01 0 M8 18h8 M10 4h4', f: 'M12 5a0.9 0.9 0 1 0 0.01 0' },
  concertina: { d: 'M3 6h4v12H3z M17 6h4v12h-4z M7 8l2 1-2 2 2 2-2 2 2 1 M17 8l-2 1 2 2-2 2 2 2-2 1 M9 9h6 M9 16h6', f: 'M4.5 9a0.8 0.8 0 1 0 0.01 0 M4.5 13a0.8 0.8 0 1 0 0.01 0 M19.5 11a0.8 0.8 0 1 0 0.01 0' },

  // ------------------------------------------------------------ orchestra
  violin_spic: { d: 'M12 7c-2.5 0-4 1.5-3.5 3.5.3 1.2-.5 2-1.5 2.5-1.5 1-1.5 3.5 0 5.5 1.5 2 3.5 2.5 5 2.5s3.5-.5 5-2.5c1.5-2 1.5-4.5 0-5.5-1-.5-1.8-1.3-1.5-2.5.5-2-1-3.5-3.5-3.5z M12 7V2 M10 15v2.5 M14 15v2.5 M20 2l2 20', f: 'M12 2a1.1 1.1 0 1 0 0.01 0' },
  strings_ensemble: { d: 'M12 7c-2.5 0-4 1.5-3.5 3.5.3 1.2-.5 2-1.5 2.5-1.5 1-1.5 3.5 0 5.5 1.5 2 3.5 2.5 5 2.5s3.5-.5 5-2.5c1.5-2 1.5-4.5 0-5.5-1-.5-1.8-1.3-1.5-2.5.5-2-1-3.5-3.5-3.5z M12 7V2 M10 15v2.5 M14 15v2.5 M3 3v6 M21 3v6 M3 3a2 2 0 1 0 0.01 0 M21 3a2 2 0 1 0 0.01 0', f: 'M12 2a1.1 1.1 0 1 0 0.01 0' },
  strings_pizz: { d: 'M12 7c-2.5 0-4 1.5-3.5 3.5.3 1.2-.5 2-1.5 2.5-1.5 1-1.5 3.5 0 5.5 1.5 2 3.5 2.5 5 2.5s3.5-.5 5-2.5c1.5-2 1.5-4.5 0-5.5-1-.5-1.8-1.3-1.5-2.5.5-2-1-3.5-3.5-3.5z M12 7V2 M10 15v2.5 M14 15v2.5 M18 3l2 3 2-3', f: 'M12 2a1.1 1.1 0 1 0 0.01 0 M20 8a1.4 1.4 0 1 0 0.01 0' },
  brass: { d: 'M2 12h4 M6 10h6v4H6z M12 12l8-5v10l-8-5 M8 10V7 M10 10V6 M12 10V7 M20 7l2-1 M20 17l2 1' },
  bassoon: { d: 'M9 22V4l3-2 3 2v18z M12 4c3-1 5 0 7-3 M9 8h6 M9 12h6 M9 16h6', f: 'M12 10a0.9 0.9 0 1 0 0.01 0 M12 14a0.9 0.9 0 1 0 0.01 0' },
  clarinet: { d: 'M10 2h4v13h-4z M9 15h6l2 6H7z M10 6h4 M10 9h4 M10 12h4', f: 'M12 4a0.9 0.9 0 1 0 0.01 0' },
  choir: { d: 'M7 12a3 3 0 1 0 0.01 0 M17 12a3 3 0 1 0 0.01 0 M2 21q1-5 5-5t5 5 M12 21q1-5 5-5t5 5 M6 12h2 M16 12h2' },
  harp: { d: 'M4 22V8c0-4 3-6 6-6s5 1 9 4v16z M7 7v14 M10 5v16 M13 5v16 M16 7v14' },
  glockenspiel: { d: 'M4 6h16v3H4z M5 11h14v3H5z M6 16h12v3H6z M20 4l-4 4', f: 'M20.5 4a1.3 1.3 0 1 0 0.01 0' },
  marimba: { d: 'M3 5h18v4H3z M6 9v10 M10 9v12 M14 9v12 M18 9v10 M4 5v4 M9 5v4 M15 5v4 M20 5v4' },
  vibraphone: { d: 'M3 6h18v4H3z M6 10v6 M12 10v8 M18 10v6 M8 6v4 M16 6v4 M4 20q2-2 4 0t4 0t4 0t4 0' },
  tubular_bells: { d: 'M3 4h18 M6 4v14 M10 4v17 M14 4v17 M18 4v14 M4 20h4 M16 20h4' },
  glass_harmonica: { d: 'M1 8h22 M3 8a2 2 0 0 0 4 0 M7 8a3.5 3.5 0 0 0 7 0 M13 8a5.5 5.5 0 0 0 11 0 M6 20l2-2 M6 22h4' },
  kalimba: { d: 'M4 10h16v10H4z M7 10V6 M10 10V4 M12 10V3 M14 10V4 M17 10V6 M4 14h16', f: 'M12 16a1.2 1.2 0 1 0 0.01 0' },
  musicbox: { d: 'M3 9h18v11H3z M3 9l3-4h12l3 4 M6 13h12 M7 13v4 M10 13v4 M13 13v4 M16 13v4 M21 13h2v-2' },

  // ----------------------------------------------------------- percussion
  a_kit_1: { d: KIT },
  e_kit_1: { d: `${KIT} M6 4l-2 4h3l-2 4` },
  bb_kit_1: { d: `${KIT} M3 6q2-4 4 0t4 0` },
  bb_kit_2: { d: `${KIT} M2 6q2-4 4 0t4 0 M2 3q2-2 4 0t4 0` },
  '8bit_kit_1': { d: 'M3 21v-4h4v-4h4v-4h4V5h4', f: 'M5 17h2v2H5z M9 13h2v2H9z M13 9h2v2h-2z M17 5h2v2h-2z' },
  e_perc_1: { d: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z', f: 'M6 6h2v2H6z M16 16h2v2h-2z' },
  dubstep_kit: { d: 'M2 12q2-8 4 0t4 0t4 0t4 0t4 0 M5 20a3 3 0 1 0 0.01 0' },
  electronic_kit: { d: 'M2 4h20v16H2z M6 8a2 2 0 1 0 0.01 0 M12 8a2 2 0 1 0 0.01 0 M18 8a2 2 0 1 0 0.01 0 M5 14h14 M5 17h14' },
  junk_kit: { d: 'M5 8h14l-1 13H6z M4 8h16 M10 4h4v2 M9 11v7 M12 11v7 M15 11v7' },
  hand_percussion: { d: 'M7 21V10a1.5 1.5 0 0 1 3 0v-4a1.5 1.5 0 0 1 3 0v3a1.5 1.5 0 0 1 3 0v2a1.5 1.5 0 0 1 3 0v6q0 4-4 4z M10 10v3 M13 9v4 M16 11v2 M7 12l-3-3' },
  bongo: { d: 'M2 9a4 1.5 0 1 0 8 0a4 1.5 0 1 0-8 0z M2 9v8a4 1.5 0 0 0 8 0V9 M14 9a4 1.5 0 1 0 8 0a4 1.5 0 1 0-8 0z M14 9v8a4 1.5 0 0 0 8 0V9 M10 12h4' },
  conga: { d: 'M7 4a5 1.6 0 1 0 10 0a5 1.6 0 1 0-10 0z M7 4l1 16a4 1.5 0 0 0 8 0l1-16 M6 20h12 M8 12h8' },
  djembe: { d: 'M6 4a6 2 0 1 0 12 0a6 2 0 1 0-12 0z M6 4q0 5 4 8v7a1 1 0 0 0 4 0v-7q4-3 4-8 M8 20h8' },
  dumbek: { d: 'M7 4a5 1.6 0 1 0 10 0a5 1.6 0 1 0-10 0z M7 4q0 6 3 8v4l-3 4h10l-3-4v-4q3-2 3-8' },
  baiyon_drums_1: { d: 'M12 3a8 8 0 1 0 0.01 0 M12 8a3 3 0 1 0 0.01 0 M7 17l-3 5 M17 17l3 5', f: 'M12 10a1 1 0 1 0 0.01 0' },

  // --------------------------------------------------------------- baiyon
  baiyon_bass_01: { d: 'M2 14q3-8 6 0t6 0t6 0t2 0 M2 20h20' },
  baiyon_bass_02: { d: 'M2 12q3-10 6 0t6 0t6 0 M2 17q3-6 6 0t6 0t6 0' },
  baiyon_city_guildford: { d: 'M2 21V11h4v10 M6 21V6h5v15 M11 21v-7h4v7 M15 21V9h4v12 M19 21v-4h3 M8 9v2 M8 13v2 M17 12v2', f: 'M13 16h1v1h-1z' },
  baiyon_city_kyoto: { d: 'M2 9q10-6 20 0 M5 9v4 M19 9v4 M4 13q8-4 16 0 M7 13v8 M17 13v8 M6 21h12 M12 2v7', f: 'M12 2a1 1 0 1 0 0.01 0' },
  baiyon_shiny_01: { d: 'M12 2v20 M2 12h20 M5 5l14 14 M19 5L5 19', f: 'M12 12a2.5 2.5 0 1 0 0.01 0' },
  baiyon_tinkle_01: { d: 'M9 4a5 5 0 0 1 10 0v6l2 3H7l2-3z M12 16a2 2 0 0 0 4 0 M3 5l1 1 M5 3l1 1 M2 9h2 M4 12l1-1', f: 'M14 2.5a1 1 0 1 0 0.01 0' },

  // ---------------------------------------------------------------- synth
  saw_wave: { d: 'M2 18L8 6v12L14 6v12L20 6v12h2' },
  square_wave: { d: 'M2 18V6h6v12h6V6h6v12h2' },
  sine_wave: { d: 'M2 12q3-8 6 0t6 0t6 0t2 0' },
  triangle_wave: { d: 'M2 18l4-12 4 12 4-12 4 12 4-12' },
  pulse_wave: { d: 'M2 18V6h2v12h5V6h2v12h5V6h2v12h4' },
  noise: { d: 'M2 12l1-4 1 7 1-10 1 12 1-8 1 5 1-9 1 12 1-7 1 4 1-8 1 10 1-6 1 3 1-7 1 9 1-5 1 2 1-4 1 2' },
  synth_bell: { d: 'M8 5a4 4 0 0 1 8 0v7l2 3H6l2-3z M10 17a2 2 0 0 0 4 0 M4 6l-2-2 M20 6l2-2 M3 11H1 M21 11h2', f: 'M12 1.5a1.2 1.2 0 1 0 0.01 0' },
  synth_strings: { d: 'M12 7c-2.5 0-4 1.5-3.5 3.5.3 1.2-.5 2-1.5 2.5-1.5 1-1.5 3.5 0 5.5 1.5 2 3.5 2.5 5 2.5s3.5-.5 5-2.5c1.5-2 1.5-4.5 0-5.5-1-.5-1.8-1.3-1.5-2.5.5-2-1-3.5-3.5-3.5z M12 7V2 M10 15v2.5 M14 15v2.5 M20 2l-2.5 4.5h4L19 11', f: 'M12 2a1.1 1.1 0 1 0 0.01 0' },
  ghost: { d: 'M5 22V11a7 7 0 0 1 14 0v11l-2-2-2 2-2-2-2 2-2-2-2 2-2-2z', f: 'M9 11a1.5 1.5 0 1 0 0.01 0 M15 11a1.5 1.5 0 1 0 0.01 0' },
  mime_artist: { d: 'M12 10a5 5 0 1 0 0.01 0 M6 8q6-6 12 0 M3 23q2-8 9-8t9 8 M5 19h14 M4 22h16', f: 'M10 10.5a1 1 0 1 0 0.01 0 M14 10.5a1 1 0 1 0 0.01 0' },
  mosquito: { d: 'M5 13a5 3 0 1 0 10 0a5 3 0 1 0-10 0z M15 13l7-2 M8 10c-3-6 0-8 3-7 M11 10c-1-7 3-8 4-5 M7 15l-3 4 M10 16l-1 5 M13 16l1 5', f: 'M15 12a1.4 1.4 0 1 0 0.01 0' },
  ray_gun: { d: 'M3 8h11l4-3v6l-4-3 M3 8v4h6l-2 8h4l2-8h3 M20 6l2-2 M20 12l2 2 M21 9h2' },
  robot: { d: 'M5 8h14v11H5z M12 8V4 M9 19v3 M15 19v3 M2 11h3 M19 11h3 M8 15h8', f: 'M12 3a1.3 1.3 0 1 0 0.01 0 M8 11h2.5v2.5H8z M13.5 11H16v2.5h-2.5z' },
  tennis: { d: 'M11 3a6 7.5 0 1 0 0.01 0 M8 6v11 M11 4v14 M14 6v11 M6 8h10 M6 13h10 M11 18v4', f: 'M19 19a2 2 0 1 0 0.01 0' },
  woodpecker: { d: 'M3 22V2 M7 22V2 M3 7h4 M3 13h4 M3 19h4 M17 9a3 3 0 1 0 0.01 0 M14 8l-6 1 6 1 M17 12c3 1 3 4 2 7l-2 3 M19 19l2 3 M17 6l1-3', f: 'M18 8a0.9 0.9 0 1 0 0.01 0' },
  worm: { d: 'M2 16q3-6 6 0t6 0t6 0 M19 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0z', f: 'M22 11.5a0.8 0.8 0 1 0 0.01 0' },

  // ------------------------------------------------------------------ sfx
  record_static: { d: 'M12 2a10 10 0 1 0 0.01 0 M12 6a6 6 0 1 0 0.01 0 M12 9a3 3 0 1 0 0.01 0 M3 3l2 2 M19 19l2 2', f: 'M12 11a1 1 0 1 0 0.01 0' },
};

/** The icon's key for a manifest row: the file without its extension. */
export const iconKeyOf = (file: string): string => file.replace(/^.*\//, '').replace(/\.rinst$/, '');
