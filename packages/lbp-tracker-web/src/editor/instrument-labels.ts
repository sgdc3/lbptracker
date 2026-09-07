/**
 * What the game calls each of its 68 sequencer instruments, by `.rinst` GUID.
 *
 * ❗ **Measured, not transcribed.** Every `*instrument_*.plan` in the game's own
 * archives is a palette item with an `InventoryItemDetails`, whose `titleKey`
 * is a LAMS id; `gamedata/languages/english.trans` turns that id into the words
 * the player reads, and the plan's dependency list names the `.rinst` it
 * places. Taken that way on 2026-09-07 every one of the 68 files is named by
 * exactly one plan and no two plans disagree. `tools/InstrumentNames.java`
 * regenerates this table and steering/tools.md says how to run it.
 *
 * The game's label carries its own category first -- "Synth: Saw Wave" -- and
 * `instruments.ts` splits the two. ⚠️ That category is **not** the family this
 * project colours a chip by: the family comes from the asset's path, so
 * `move_pack` and `lbp3` and `baiyon` are release-shaped where the game's is
 * musical. Both are kept, neither is derived from the other.
 *
 * ⚠️ Three of the 68 are named by a `gad_instrument_*` plan rather than an
 * `instr_instrument_*` one: the sine, square and triangle waves are gadgets in
 * their own right as well as sequencer instruments.
 */
export const INSTRUMENT_LABELS: Readonly<Record<number, string>> = {
  122721: 'Keys: Honkytonk Piano',                  // honky_tonk_piano.rinst
  122737: 'Keys: Piano',                            // piano.rinst
  127540: 'Percussion: 8-Bit Kit',                  // 8bit_kit_1.rinst
  129031: 'Percussion: Acoustic Kit 1',             // a_kit_1.rinst
  148321: 'Percussion: Baiyon Kit 1',               // baiyon_drums_1.rinst
  129040: 'Percussion: Beatbox Kit 1',              // bb_kit_1.rinst
  129049: 'Percussion: Beatbox Kit 2',              // bb_kit_2.rinst
  843431: 'Percussion: Bongo',                      // bongo.rinst
  843437: 'Percussion: Conga',                      // conga.rinst
  843441: 'Percussion: Djembe',                     // djembe.rinst
  843450: 'Percussion: Dubstep Kit',                // dubstep_kit.rinst
  843454: 'Percussion: Dumbek',                     // dumbek.rinst
  843463: 'Percussion: Electronic Kit',             // electronic_kit.rinst
  843472: 'Percussion: Hand',                       // hand_percussion.rinst
  843488: 'Percussion: Junk Kit',                   // junk_kit.rinst
  129057: 'Percussion: Synth Kit 1',                // e_kit_1.rinst
  129066: 'Percussion: Synth Perc. Kit 1',          // e_perc_1.rinst
  125100: 'Plucked: Bass Guitar',                   // bass_guitar.rinst
  174236: 'Plucked: Col Legno',                     // violin_spic.rinst
  182708: 'Plucked: Double Bass Pizzicato',         // doublebass.rinst
  174225: 'Plucked: Ektara',                        // ektara.rinst
  132205: 'Plucked: Electric Guitar (muted)',       // e_guitar_clean_muted.rinst
  125101: 'Plucked: Electric Guitar Distorted',     // e_guitar_distorted.rinst
  138776: 'Plucked: Electric Guitar Power Chords',  // e_guitar_power.rinst
  129021: 'Plucked: Harp',                          // harp.rinst
  182709: 'Plucked: Koto',                          // koto.rinst
  182710: 'Plucked: Nylon String Guitar',           // nylonguitar.rinst
  186898: 'Plucked: Strings Legato',                // strings_ensemble.rinst
  187847: 'Plucked: Strings Pizzicato',             // strings_pizz.rinst
  843494: 'Plucked: Ukelele',                       // ukulele.rinst
  143479: 'SFX: Baiyon Guildford',                  // baiyon_city_guildford.rinst
  148320: 'SFX: Baiyon Kyoto',                      // baiyon_city_kyoto.rinst
  125386: 'SFX: Record Static',                     // record_static.rinst
  148318: 'Synth: Baiyon Bass 1',                   // baiyon_bass_01.rinst
  148319: 'Synth: Baiyon Bass 2',                   // baiyon_bass_02.rinst
  148322: 'Synth: Baiyon Shiny',                    // baiyon_shiny_01.rinst
  148323: 'Synth: Baiyon Tinkle',                   // baiyon_tinkle_01.rinst
  129086: 'Synth: Bell',                            // synth_bell.rinst
  129075: 'Synth: E-Piano',                         // electric_piano.rinst
  129076: 'Synth: Ghost',                           // ghost.rinst
  129074: 'Synth: Harpsichord',                     // electric_harpsichord.rinst
  129077: 'Synth: Mime Artist',                     // mime_artist.rinst
  129078: 'Synth: Mosquito',                        // mosquito.rinst
  129079: 'Synth: Noise',                           // noise.rinst
  129080: 'Synth: Pulse Wave',                      // pulse_wave.rinst
  129081: 'Synth: Ray Gun',                         // ray_gun.rinst
  129082: 'Synth: Robot',                           // robot.rinst
  129083: 'Synth: Saw Wave',                        // saw_wave.rinst
  129084: 'Synth: Sine Wave',                       // sine_wave.rinst
  129015: 'Synth: Space Piano',                     // space_piano.rinst
  129085: 'Synth: Square Wave',                     // square_wave.rinst
  129087: 'Synth: Strings',                         // synth_strings.rinst
  129088: 'Synth: Tennis',                          // tennis.rinst
  129089: 'Synth: Triangle Wave',                   // triangle_wave.rinst
  129090: 'Synth: Woodpecker',                      // woodpecker.rinst
  129091: 'Synth: Worm',                            // worm.rinst
  187921: 'Tuned Percussion: Glass Harmonica',      // glass_harmonica.rinst
  129017: 'Tuned Percussion: Glockenspiel',         // glockenspiel.rinst
  180212: 'Tuned Percussion: Kalimba',              // kalimba.rinst
  187885: 'Tuned Percussion: Marimba',              // marimba.rinst
  186897: 'Tuned Percussion: Music Box',            // musicbox.rinst
  186899: 'Tuned Percussion: Tubular Bells',        // tubular_bells.rinst
  187877: 'Tuned Percussion: Vibraphone',           // vibraphone.rinst
  186894: 'Voice: Choir Aahs',                      // choir.rinst
  186892: 'Wind: Bassoon',                          // bassoon.rinst
  186893: 'Wind: Brass',                            // brass.rinst
  186895: 'Wind: Clarinet',                         // clarinet.rinst
  132146: 'Wind: Concertina',                       // concertina.rinst
};
