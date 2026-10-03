/**
 * Songs the "play a demo song" buttons deal from, on the home view and in the
 * open dialog.
 *
 * Each is a music sequencer in a level of the public archive, named the way a
 * shared link names one (`link.ts`): the root level's SHA-1 and the sequencer
 * Thing's uid. **Nothing of theirs is in this repository or on this site** --
 * the page fetches the level from archive.org when the button is pressed,
 * exactly as it does for `?level=<sha1>&seq=<uid>`.
 *
 * The list is the owner's choice of community songs, 2026-09-21: Festerd_Jester,
 * Velvet--Audio, nk827 and friends. ✔ `dev/check-demos.ts` fetches every one
 * and finds its uid, none needing the dependency walk (`deep`); run it after
 * adding a row, because a uid is only a number until a level answers to it.
 */

export interface DemoSong {
  /** The root level's SHA-1 in the archive. */
  readonly level: string;
  /** The sequencer Thing's uid inside that level. */
  readonly uid: number;
}

const from = (level: string, ...uids: number[]): DemoSong[] =>
  uids.map((uid) => ({ level, uid }));

export const DEMO_SONGS: readonly DemoSong[] = [
  // Festerd_Jester: Rotary, Elixir
  ...from('5aa779456cf3407f2ed16251f461eb2dd5970f3f', 740380, 745610),
  // Festerd_Jester: We Are The Universe, Elysium
  ...from('0123bfd418788d5060a4a223fb19d186c53f07bb', 4416931, 4448789),
  // FJ n Velv: Vision, Sleepless
  ...from('314b1500270c467a50c0abb5af4166f787614108', 15853, 68882),
  // Festerd_Jester & iChaosClay: Voltaic
  ...from('662efbfcc295634beed6f80620fce4129a5a798e', 326005),
  // Velvet--Audio: Northern Lights, Foreign Body, Waiver, Periastron
  ...from('2bc7d95a172044143dde3ff5c0ba7208b1a70b9b', 16629, 7904, 13859, 30473),
  // Velvet--Audio: Casts of Nothing, Planet Rin, LittleBigMe
  ...from('ad4f399cf2952d49878d56940e3c76cdc2ed0199', 33070, 34735, 38256),
  // Velvet--Audio: Chicane, Spent Force
  ...from('ef62fe7fcf15597b9cb9c5babe11be5ea3a8676a', 61018, 60012),
  // nk827 and weirdybeardy: Sinister Forthcomings, Primordial, Cosmic-politan,
  // Forbidden Secrets, Unmiscalculation, Don't Touch the Monocle,
  // Rhombitruncated, Beta Particles, Broken
  ...from(
    '91ab1a669d65557216a37d38717b90c68409d4dc',
    59132, 16385, 12554, 52448, 15191, 57748, 44112, 55904, 9749,
  ),
];

const same = (a: DemoSong | undefined, b: DemoSong | undefined): boolean =>
  a !== undefined && b !== undefined && a.level === b.level && a.uid === b.uid;

/**
 * A shuffled deck of the demos: each call deals the next one, and every song
 * comes up once before any comes up again.
 *
 * ❗ **A deck, not a die.** The button used to pick at random and only refused
 * the song just played, so with 25 songs one came round again within a handful
 * of presses -- which reads as a list far shorter than it is. Now the whole
 * list is shuffled (Fisher-Yates) and dealt; when it runs out it is shuffled
 * again, and a reshuffle that would start with the song just heard swaps that
 * one away from the top, so not even the seam repeats.
 *
 * `random` is a parameter so that a test can stack the deck.
 */
export function demoDeck(
  songs: readonly DemoSong[] = DEMO_SONGS,
  random: () => number = Math.random,
): () => DemoSong {
  let deck: DemoSong[] = [];
  let last: DemoSong | undefined;
  return () => {
    if (deck.length === 0) {
      deck = [...songs];
      for (let i = deck.length - 1; i > 0; i -= 1) {
        const j = Math.min(i, Math.floor(random() * (i + 1)));
        [deck[i], deck[j]] = [deck[j], deck[i]];
      }
      // Dealt from the end, so the end is the top of the deck.
      if (deck.length > 1 && same(deck[deck.length - 1], last)) {
        [deck[0], deck[deck.length - 1]] = [deck[deck.length - 1], deck[0]];
      }
    }
    last = deck.pop()!;
    return last;
  };
}
