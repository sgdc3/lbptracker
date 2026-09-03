/**
 * The MIDI round trip, over the real level corpus.
 *
 *     node --experimental-strip-types dev/verify-midi.ts
 *
 * `test/midi.test.ts` pins the behaviour on fixtures small enough to reason
 * about. This is the other half: every music sequencer in the corpus, exported
 * and read back, with the scheduled note stream compared position by position.
 * Real compositions carry things a fixture will not think of -- notes that open
 * at volume zero, glides across a scale change, parts a thousand clips long --
 * and the point of a converter is that it survives them.
 *
 * What is compared is the MUSIC, not the bytes: `Key` and `Scale` are baked into
 * the note numbers on the way out, so the record fields legitimately differ.
 * See the header of `src/core/midi.ts`.
 *
 * `LBP_LEVELS` is the corpus directory. Nothing here is committed.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { midiToSequencer, sequencerToMidi } from '../src/core/midi.ts';
import { schedule, type Sequencer } from '../src/core/project.ts';
import { readLevelProject } from '../src/core/project.ts';
import { blockRoot, notePitch } from '../src/core/scale.ts';
import { nodeInflate } from '../src/platform/node.ts';

const LEVELS = process.env.LBP_LEVELS ?? 'C:/Users/sgdc3/Desktop/LBP/toolkit/tools/sequencerdump/data';

/**
 * `LBP_MIDI_PERPART=1` checks the mode a DAW should be given.
 *
 * Sharing the fifteen member channels across every part is the safe default,
 * because a single-stream player has nowhere else to put them; giving each part
 * its own is what Reaper and its like make true on import. The two lose
 * different amounts, so both are worth being able to measure.
 */
const perPart = process.env.LBP_MIDI_PERPART === '1';

/** The note stream, in the terms a MIDI file can carry. */
function music(sequencer: Sequencer) {
  return schedule(sequencer).map((event) => {
    const track = sequencer.tracks[event.track];
    const root = blockRoot(track.key);
    const midi = (raw: number) => Math.max(0, Math.min(127, notePitch(raw, track.scale, root)));
    // ⚠️ **The modulation the note SOUNDS, not its first record's.** Points
    // that share a position are taken at their later value the instant they
    // arrive -- the engine's `t = span > 0 ? … : 1` -- so a pair at the note's
    // start makes the first record's modulation something nothing ever hears.
    // Comparing that field instead blamed `Salem` for notes the round trip
    // reproduces exactly.
    let opening = 0;
    for (const p of event.points) {
      if (p.step > 0) break;
      opening = p.modulation;
    }
    return {
      step: Math.round(event.step * 3),
      duration: Math.round(event.durationSteps * 3),
      pitch: midi(event.pitch),
      volume: event.volume,
      modulation: Math.round(opening * 15),
      // The curve, sampled where records can sit: thirds of a step.
      curve: sampleCurve(
        event.points.map((p) => ({
          at: p.step,
          pitch: midi(p.pitch),
          volume: p.volume,
          // On the nibble's own scale, so one unit means one step of the field.
          mod: p.modulation * 15,
        })),
      ),
    };
  });
}

function sampleCurve(points: { at: number; pitch: number; volume: number; mod: number }[]) {
  const out: [number, number, number][] = [];
  const last = points[points.length - 1].at;
  for (let thirds = 0; thirds <= Math.round(last * 3); thirds += 1) {
    const at = thirds / 3;
    let i = 0;
    while (i + 1 < points.length && points[i + 1].at <= at) i += 1;
    const from = points[i];
    const to = points[i + 1];
    const span = to ? to.at - from.at : 0;
    const t = to && span > 0 ? (at - from.at) / span : 0;
    out.push([
      to ? from.pitch + (to.pitch - from.pitch) * t : from.pitch,
      to ? from.volume + (to.volume - from.volume) * t : from.volume,
      to ? from.mod + (to.mod - from.mod) * t : from.mod,
    ]);
  }
  return out;
}

let sequencers = 0;
let notes = 0;
let failed = 0;
let worstPitch = 0;
let worstVolume = 0;
let worstMod = 0;
let bent = 0;
const totals = {
  shared: 0, dropped: 0, clampedPitch: 0, clampedBend: 0, bytes: 0, lengthened: 0,
  flattened: 0, deviating: 0, automated: 0, dragged: 0, timbred: 0,
};

for (const entry of await readdir(LEVELS, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  let project;
  try {
    project = await readLevelProject(
      entry.name,
      new Uint8Array(await readFile(path.join(LEVELS, entry.name))),
      nodeInflate,
    );
  } catch {
    continue;
  }
  for (const seq of project.sequencers) {
    if (seq.tracks.length === 0) continue;
    sequencers += 1;
    const exported = sequencerToMidi(seq, { channelsPerPart: perPart });
    const imported = midiToSequencer(exported.bytes);
    totals.shared += exported.sharedChannel;
    totals.flattened += exported.flattened;
    totals.dragged += exported.dragged;
    totals.timbred += exported.timbred;
    for (const e of schedule(seq)) {
      if (e.hasPitchAutomation || e.hasVolumeAutomation) totals.automated += 1;
    }
    totals.dropped += exported.dropped;
    totals.clampedPitch += exported.clampedPitch;
    totals.clampedBend += exported.clampedBend;
    totals.bytes += exported.bytes.length;
    totals.lengthened += imported.lengthened;

    // ⚠️ **Compared as a multiset, not in order.** `schedule` sorts by step and
    // then by track index, and the import legitimately renumbers tracks: clips
    // that shared an instrument and a row merged into one part, and long parts
    // were re-cut. Two notes on the same step therefore come back in a different
    // order, and a positional comparison reports that as every note after it
    // being wrong. The first version of this script did exactly that and blamed
    // 142 of 149 sequencers for it.
    const before = music(seq);
    const after = music(imported.sequencer);
    notes += before.length;
    const problems: string[] = [];
    let missing = 0;
    if (after.length !== before.length - exported.dropped) {
      problems.push(`${before.length} notes out, ${after.length} back`);
    }
    /**
     * How far two notes are apart, and whether they are the same note at all.
     *
     * ⚠️ **The pairing is the part of this script that has been wrong most
     * often.** Levels place the same hit on two components, so a bucket
     * routinely holds several notes at one step and one pitch -- and when one of
     * them loses a glide to a shared channel, a greedy walk crosses it with a
     * sibling and reports two casualties for none. It has produced phantom
     * numbers three times: 142 sequencers, then 458 notes, then 8.
     *
     * So: exact matches are taken first, and only what is left is matched by
     * cost. The key stays loose -- step and pitch -- because a flattened note
     * that opened at volume 0 comes back at 1, MIDI having no velocity 0, and a
     * key that included the volume simply lost it.
     */
    const apart = (x: (typeof before)[number], y: (typeof after)[number]) => {
      let worst = Math.abs(x.duration - y.duration) * 1000 + Math.abs(x.modulation - y.modulation);
      for (let s = 0; s < Math.min(x.curve.length, y.curve.length); s += 1) {
        worst +=
          Math.abs(x.curve[s][0] - y.curve[s][0]) +
          Math.abs(x.curve[s][1] - y.curve[s][1]) +
          Math.abs(x.curve[s][2] - y.curve[s][2]);
      }
      return worst + Math.abs(x.curve.length - y.curve.length) * 1000;
    };

    const bucket = new Map<string, typeof after>();
    for (const note of after) {
      const key = `${note.step}/${note.pitch}`;
      const found = bucket.get(key);
      if (found) found.push(note);
      else bucket.set(key, [note]);
    }
    const wanted = new Map<string, typeof before>();
    for (const note of before) {
      const key = `${note.step}/${note.pitch}`;
      const found = wanted.get(key);
      if (found) found.push(note);
      else wanted.set(key, [note]);
    }

    const pairs: { a: (typeof before)[number]; b: (typeof after)[number] }[] = [];
    for (const [key, group] of wanted) {
      const candidates = bucket.get(key) ?? [];
      const left: typeof before = [];
      // Pass one: anything that came back untouched claims its own partner.
      for (const a of group) {
        const exact = candidates.findIndex((b) => apart(a, b) < 1e-9);
        if (exact >= 0) pairs.push({ a, b: candidates.splice(exact, 1)[0] });
        else left.push(a);
      }
      // Pass two: whatever is left, nearest first.
      for (const a of left) {
        if (candidates.length === 0) {
          // ⚠️ A note the export DECLARED it could not carry is not a
          // disagreement -- it is the one thing MPE genuinely cannot do, more
          // copies of a pitch at once than there are channels to tell them
          // apart. Counting it here as well left the gate failing on a single
          // note in `Avian` that the tally had already reported.
          missing += 1;
          if (missing > exported.dropped && problems.length < 3) {
            problems.push(`no note at step ${a.step} pitch ${a.pitch}`);
          }
          continue;
        }
        let best = 0;
        for (let i = 1; i < candidates.length; i += 1) {
          if (apart(a, candidates[i]) < apart(a, candidates[best])) best = i;
        }
        pairs.push({ a, b: candidates.splice(best, 1)[0] });
      }
    }

    for (const { a, b } of pairs) {
      if (a.duration !== b.duration && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: duration ${a.duration} -> ${b.duration}`);
      }
      if (a.modulation !== b.modulation && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: mod ${a.modulation} -> ${b.modulation}`);
      }
      if (a.curve.length !== b.curve.length && problems.length < 3) {
        problems.push(`step ${a.step} pitch ${a.pitch}: curve ${a.curve.length} -> ${b.curve.length}`);
      }
      // ⚠️ A note that had to share a channel lost its glide on purpose, so
      // its curve is expected to differ. Counting those separately is what keeps
      // the worst-case figure meaningful: it is the worst among the notes that
      // were supposed to survive intact.
      let deviation = 0;
      for (let s = 0; s < Math.min(a.curve.length, b.curve.length); s += 1) {
        deviation = Math.max(
          deviation,
          Math.abs(a.curve[s][0] - b.curve[s][0]),
          Math.abs(a.curve[s][1] - b.curve[s][1]),
          Math.abs(a.curve[s][2] - b.curve[s][2]),
        );
      }
      // The same half-a-unit the simplifier uses, and the same hair of slack:
      // both fields are integers, so `round` can miss the true line by exactly
      // half and floating point can make that look like slightly more.
      if (deviation > 0.5 + 1e-9) {
        totals.deviating += 1;
      } else {
        for (let s = 0; s < Math.min(a.curve.length, b.curve.length); s += 1) {
          worstPitch = Math.max(worstPitch, Math.abs(a.curve[s][0] - b.curve[s][0]));
          worstVolume = Math.max(worstVolume, Math.abs(a.curve[s][1] - b.curve[s][1]));
          worstMod = Math.max(worstMod, Math.abs(a.curve[s][2] - b.curve[s][2]));
        }
      }
    }
    if (problems.length > 0) {
      failed += 1;
      console.log(`✗ ${project.file} seq ${seq.uid} "${seq.name}": ${problems.join('; ')}`);
    }
  }
}

const pc = (n: number) => `${((n / notes) * 100).toFixed(2)}%`;
console.log(`channels ${perPart ? 'per part' : 'shared across parts'}`);
console.log(
  `${sequencers} sequencers, ${notes.toLocaleString()} notes, ${failed} disagreeing\n` +
    `intact notes: worst deviation pitch ${worstPitch.toFixed(3)} semitones, ` +
    `volume ${worstVolume.toFixed(3)}, modulation ${worstMod.toFixed(3)}/15\n` +
    `${totals.automated.toLocaleString()} notes carry a glide (${pc(totals.automated)}); ` +
    `${totals.flattened.toLocaleString()} of them lost it to a shared channel (${pc(totals.flattened)}), ` +
    `and ${totals.deviating.toLocaleString()} notes came back with a different curve\n` +
    `${(totals.bytes / 1e6).toFixed(1)} MB of MIDI; ${totals.shared.toLocaleString()} notes shared a ` +
    `channel; ${totals.dragged.toLocaleString()} (${pc(totals.dragged)}) will be bent by a ` +
    `neighbour and ${totals.timbred.toLocaleString()} (${pc(totals.timbred)}) had their timbre ` +
    `moved by one; ${totals.dropped} could not be carried, ${totals.clampedPitch} ` +
    `pitches and ${totals.clampedBend} bends clamped, ${totals.lengthened} lengthened to the grid`,
);
/**
 * What this gates on, and what it only reports.
 *
 * Gated, because they are exact: every note comes back, on the same third of a
 * step, at the same pitch, for the same length, with the same modulation, and
 * an intact note's curve stays within the half unit that integer fields round
 * by.
 *
 * Reported, because the two counters are not strictly nested: `flattened` is
 * what the export declared it could not carry whole, and `deviating` is what
 * measurably changed. A flattened note whose glide was smaller than the
 * quantiser lands in the first and not the second, so the difference can fall
 * either way. It currently runs at **2 notes in 953,791** unaccounted for --
 * 0.0002%, and not chased further; every category found so far is fixed and
 * has a note in `src/core/midi.ts` saying what it was.
 */
// ⚠️ `dragged` and `timbred` are NOT subtracted here. They say what a synth
// will hear from a shared channel, not what this round trip loses -- the
// importer knows whose bend and whose modulation each is -- so counting them
// against the curve differences made shared mode look 4,433 notes better than
// declared, which is as misleading as looking worse.
const unexplained = totals.deviating - totals.flattened;
if (unexplained !== 0) {
  console.log(
    `${unexplained > 0 ? unexplained : -unexplained} notes ` +
      `${unexplained > 0 ? 'changed without being declared' : 'were declared but did not change'} ` +
      `(${((Math.abs(unexplained) / notes) * 100).toFixed(4)}%)`,
  );
}
process.exit(
  failed === 0 && worstPitch <= 0.5 + 1e-9 && worstVolume <= 0.5 + 1e-9 && worstMod <= 0.5 + 1e-9
    ? 0
    : 1,
);
