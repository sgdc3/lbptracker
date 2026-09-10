/**
 * What an instrument chip on a sequencer's board is made of, by `.rinst` GUID.
 *
 * A `Track` carries two things about its instrument -- the `RInstrument` GUID
 * the sampler loads, and the tint a creator gave the chip. The **chip** the
 * game draws around it carries three more, all properties of the instrument
 * rather than of the music:
 *
 * - `plan` is the popit item the chip was placed from, which the game stores
 *   as the Thing's `planGuid`;
 * - `icon` is the texture drawn on the chip, `PInstrument.Icon`;
 * - `colour` is the tint that popit item ships with -- what `PInstrument.Colour`
 *   holds on a chip nobody has re-tinted.
 *
 * None of them reaches playback, and a plan written without them still sounds
 * right -- it just puts blank grey chips on the board, which is the first thing
 * anybody opening the sequencer in Create Mode would see.
 *
 * ❗ **Measured, 2026-09-10, out of the game's own popit plans.** A chip is
 * placed from the instrument's own `instrument_*.plan`, so that plan holds
 * every column here: `tools/InstrumentColours.java` walks all 68 of them
 * through the FileDB and prints the row. It agrees with the earlier corpus
 * tally (`dev/chip-table.ts` over 19,116 placements in the 17 gallery plans,
 * the ten-level corpus and the 103-level archive sample) on **50 of 50 rows,
 * plan and icon both**; the other 18 are instruments nobody in that corpus
 * used, and they come from the game's data rather than from a guess. The
 * trailing number is the corpus tally where there was one.
 *
 * ⚠️ **The colour is packed RGBA and the low byte is not an opacity.** Every
 * value a creator picked ends `ff` -- 24 of the 25 distinct values over 68,568
 * corpus placements -- and the one exception is the factory green the fifteen
 * percussion instruments ship with, `0x40ff0100`, whose low byte is 0. Read as
 * ARGB the same numbers make most chips transparent and swap red for blue, so
 * the byte order is settled; what the game does with that last byte is not
 * (steering/open-questions.md).
 *
 * ⚠️ This is a table about the game's own assets, so it is data and not a
 * measurement of the *format*: adding a row means running the tool over a game
 * install, never reading a GUID off a wiki.
 */
export interface InstrumentChip {
  /** The popit plan the chip is placed from -- the Thing's `planGuid`. */
  readonly plan: number;
  /** The texture on the chip -- `PInstrument.Icon`. */
  readonly icon: number;
  /**
   * `PInstrument.Colour` as the instrument's own popit plan carries it.
   *
   * ⚠️ **Written unsigned here and handed out SIGNED** -- `0xff0000ff` reads
   * better in a table than `-16776961`, and `readInstrumentPart` gets the
   * signed one out of the file. Go through `factoryColour`, which normalises;
   * comparing this field to a placement's own said "tinted" for every red,
   * magenta, yellow and white chip in the corpus until it did.
   */
  readonly colour: number;
}

/** `RInstrument` GUID -> its chip, for all 68 of the game's instruments. */
export const INSTRUMENT_CHIPS: Readonly<Record<number, InstrumentChip>> = {
  122721: { plan: 129309, icon: 128323, colour: 0xffff00ff }, // keys_honkytonk_piano
  122737: { plan: 129308, icon: 128325, colour: 0xffff00ff }, // keys_piano, 513
  125100: { plan: 129316, icon: 128317, colour: 0xff0000ff }, // plucked_bass_guitar_1, 343
  125101: { plan: 138985, icon: 138981, colour: 0xff0000ff }, // plucked_e_guitar_distorted, 81
  125386: { plan: 129318, icon: 128327, colour: 0xffffffff }, // sfx_record_static, 4
  127540: { plan: 129310, icon: 128318, colour: 0x40ff0100 }, // perc_8bit_kit, 52
  129015: { plan: 129329, icon: 128330, colour: 0x00bfffff }, // synth_space_piano
  129017: { plan: 129336, icon: 128321, colour: 0x0000ffff }, // tuned_perc_synth_perc_glockenspiel, 208
  129021: { plan: 129317, icon: 128322, colour: 0xff0000ff }, // plucked_harp, 344
  129031: { plan: 129311, icon: 128319, colour: 0x40ff0100 }, // perc_acoustic_kit_1, 1472
  129040: { plan: 129312, icon: 129304, colour: 0x40ff0100 }, // perc_beatbox_kit_1
  129049: { plan: 129313, icon: 130016, colour: 0x40ff0100 }, // perc_beatbox_kit_2
  129057: { plan: 129314, icon: 128320, colour: 0x40ff0100 }, // perc_synth_kit_1, 313
  129066: { plan: 129315, icon: 130017, colour: 0x40ff0100 }, // perc_synth_perc_kit_1, 803
  129074: { plan: 129320, icon: 128334, colour: 0x00bfffff }, // synth_electric_harpsichord_1, 648
  129075: { plan: 129321, icon: 128325, colour: 0x00bfffff }, // synth_electric_piano, 35
  129076: { plan: 129323, icon: 128333, colour: 0x00bfffff }, // synth_ghost, 97
  129077: { plan: 129324, icon: 128335, colour: 0x00bfffff }, // synth_mime_artist, 392
  129078: { plan: 129325, icon: 128336, colour: 0x00bfffff }, // synth_mosquito, 180
  129079: { plan: 129326, icon: 128324, colour: 0x00bfffff }, // synth_noise, 40
  129080: { plan: 129307, icon: 128326, colour: 0x00bfffff }, // synth_pulse_wave_1, 486
  129081: { plan: 129327, icon: 128337, colour: 0x00bfffff }, // synth_ray_gun, 2584
  129082: { plan: 129328, icon: 128338, colour: 0x00bfffff }, // synth_robot, 1022
  129083: { plan: 129303, icon: 128328, colour: 0x00bfffff }, // synth_saw_wave, 428
  129084: { plan: 124100, icon: 128329, colour: 0x00bfffff }, // synth_sine_wave, 622
  129085: { plan: 124099, icon: 128331, colour: 0x00bfffff }, // synth_square_wave, 3254
  129086: { plan: 129319, icon: 128332, colour: 0x00bfffff }, // synth_bell, 12
  129087: { plan: 129330, icon: 128339, colour: 0x00bfffff }, // synth_strings, 219
  129088: { plan: 129332, icon: 128340, colour: 0x00bfffff }, // synth_tennis, 88
  129089: { plan: 124105, icon: 128343, colour: 0x00bfffff }, // synth_triangle_wave, 337
  129090: { plan: 129333, icon: 128341, colour: 0x00bfffff }, // synth_woodpecker, 28
  129091: { plan: 129335, icon: 128342, colour: 0x00bfffff }, // synth_worm, 134
  132146: { plan: 138987, icon: 138983, colour: 0xff00ffff }, // wind_concertina, 14
  132205: { plan: 138984, icon: 138980, colour: 0xff0000ff }, // plucked_e_guitar_muted, 9
  138776: { plan: 138986, icon: 138982, colour: 0xff0000ff }, // plucked_e_guitar_power_chords, 7
  143479: { plan: 148329, icon: 147783, colour: 0xffffffff }, // sfx_baiyon_guildford
  148318: { plan: 148331, icon: 147779, colour: 0x00bfffff }, // synth_bass_1
  148319: { plan: 148332, icon: 147778, colour: 0x00bfffff }, // synth_bass_2
  148320: { plan: 148330, icon: 147784, colour: 0xffffffff }, // sfx_baiyon_kyoto, 18
  148321: { plan: 148328, icon: 147781, colour: 0x40ff0100 }, // perc_baiyon_kit_1, 2416
  148322: { plan: 148333, icon: 147780, colour: 0x00bfffff }, // synth_shiny, 111
  148323: { plan: 148334, icon: 147785, colour: 0x00bfffff }, // synth_tinkle, 35
  174225: { plan: 174272, icon: 174206, colour: 0xff0000ff }, // plucked_ektara
  174236: { plan: 174270, icon: 174200, colour: 0xff0000ff }, // plucked_violin_spiccato, 79
  180212: { plan: 187880, icon: 175676, colour: 0x0000ffff }, // tuned_perc_kalimba, 64
  182708: { plan: 187878, icon: 176208, colour: 0xff0000ff }, // plucked_double_bass_pizzicato, 51
  182709: { plan: 182652, icon: 182641, colour: 0xff0000ff }, // move_koto, 8
  182710: { plan: 187881, icon: 182648, colour: 0xff0000ff }, // move_nylon_guitar, 29
  186892: { plan: 188107, icon: 188081, colour: 0xff00ffff }, // wind_bassoon
  186893: { plan: 188108, icon: 176254, colour: 0xff00ffff }, // wind_brass
  186894: { plan: 188113, icon: 188110, colour: 0xff00ffff }, // voice_choir_aahs, 7
  186895: { plan: 188059, icon: 187940, colour: 0xff00ffff }, // wind_clarinet
  186897: { plan: 187882, icon: 182653, colour: 0x0000ffff }, // tuned_perc_music_box, 771
  186898: { plan: 187848, icon: 175221, colour: 0xff0000ff }, // plucked_strings_legato, 120
  186899: { plan: 187918, icon: 187916, colour: 0x0000ffff }, // tuned_perc_tubular_bells
  187847: { plan: 187849, icon: 175679, colour: 0xff0000ff }, // plucked_strings_pizzicato, 217
  187877: { plan: 187879, icon: 175680, colour: 0x0000ffff }, // tuned_perc_vibraphone, 49
  187885: { plan: 187886, icon: 187883, colour: 0x0000ffff }, // tuned_perc_marimba, 58
  187921: { plan: 192426, icon: 187919, colour: 0x0000ffff }, // tuned_perc_glass_harmonica, 33
  843431: { plan: 843502, icon: 843347, colour: 0x40ff0100 }, // perc_bongo
  843437: { plan: 843593, icon: 843348, colour: 0x40ff0100 }, // perc_conga
  843441: { plan: 843594, icon: 843349, colour: 0x40ff0100 }, // perc_conga_1
  843450: { plan: 843600, icon: 843350, colour: 0x40ff0100 }, // perc_dubstep_kit
  843454: { plan: 843601, icon: 843380, colour: 0x40ff0100 }, // perc_dumbek
  843463: { plan: 843618, icon: 843352, colour: 0x40ff0100 }, // perc_e_kit
  843472: { plan: 843624, icon: 843353, colour: 0x40ff0100 }, // perc_hand_percussion, 6
  843488: { plan: 843626, icon: 843355, colour: 0x40ff0100 }, // perc_junk_kit, 235
  843494: { plan: 843627, icon: 843356, colour: 0xff0000ff }, // plucked_ukelele, 40
};

/** The chip for an instrument GUID, or undefined for one the game has not got. */
export function chipFor(guid: number): InstrumentChip | undefined {
  return INSTRUMENT_CHIPS[guid];
}

/** Sky blue, `0x00bfffff`: the synth family's factory tint. See `factoryColour`. */
export const DEFAULT_CHIP_COLOUR = 0x00bfffff | 0;

/**
 * `0xffffffff`: **no tint**, which is not the same as a chip painted white.
 *
 * ❗ **Measured over the ten-level corpus, 2026-09-10.** White appears in no
 * file below revision `0x3ec` -- 0 of the 27,094 placements in the four oldest
 * -- and then takes over: 6,868 of 7,524 at `0x3ef` and 12,545 of 12,706 at
 * `0x3f4`, whole levels of it. A creator does not paint twelve thousand chips
 * white; an editor writes the identity of a multiplicative tint, and white is
 * that identity (cwlib's `PShape.color` defaults to it for the same reason).
 * So a chip carrying it shows its instrument's own colour, and `drawnColour`
 * is where that is decided.
 *
 * ⚠️ It is stored and written back exactly as it is found. This says what to
 * DRAW, never what to keep.
 */
export const UNTINTED = -1;

/**
 * What colour a chip actually shows: its own, unless it carries no tint.
 *
 * ⚠️ What the game does with a tint that is neither white nor the factory
 * value -- 1,838 of the corpus's 68,568 placements, 2.7% -- has not been seen
 * in Create Mode, and this draws them in the colour they name
 * (steering/open-questions.md).
 */
export function drawnColour(guid: number, colour: number): number {
  return (colour | 0) === UNTINTED ? factoryColour(guid) : colour;
}

/**
 * The tint a chip holding this instrument starts with.
 *
 * ❗ **The fallback matters as much as the table.** A GUID the game has not
 * got -- a level from a version this table predates, an instrument someone
 * added -- still needs a colour, and `DEFAULT_CHIP_COLOUR` is the synth
 * family's, which is what 23 of the 68 instruments carry and by far the
 * commonest value in the corpus (27,272 of 68,568 placements).
 */
export function factoryColour(guid: number): number {
  // `| 0` because a placement's own colour is signed -- see `InstrumentChip`.
  return (INSTRUMENT_CHIPS[guid]?.colour ?? DEFAULT_CHIP_COLOUR) | 0;
}
