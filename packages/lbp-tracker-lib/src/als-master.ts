/**
 * The tracker's master bus on Live's master track: Live's Compressor set as our
 * glue, then Live's Limiter. **Ours, not the game's**, like `audio/master.ts`,
 * which is what it copies, and off unless the export is asked for it.
 *
 * | `audio/master.ts` | Live |
 * |---|---|
 * | the glue: peak detector, 2.5:1, 6 dB soft knee, 10 ms / 150 ms (`GLUE`) | Compressor: Peak, the same ratio, knee, attack and release, no lookahead, Makeup off |
 * | the threshold and makeup the knob gives (`glueLevels`) | Threshold and Gain, both moved by the fold's gain (below) |
 * | the limiter: linked, `ceilingDb`, 80 ms release, 2 ms lookahead (`LIMITER`) | Limiter: Link on, the same ceiling and release, Auto off, the nearest lookahead Live has (1.5 ms) |
 *
 * ❗ **The fold's gain is folded into the compressor.** The tracker's master bus
 * runs after the stereo fold, so it hears the engine's sum times `FOLD_GAIN`
 * (+4.65 dB). Live's master holds the engine's sum alone, with its fader at
 * 0 dB (`steering/ableton-interchange.md`, *The mixer*). A peak detector with a
 * knee in decibels does the same to a signal `G` dB quieter with a threshold
 * `G` dB lower, so the threshold comes down by the fold's gain and the Gain
 * goes up by it. The Limiter then hears what the tracker's limiter hears.
 *
 * Why the Compressor and not the Glue Compressor: the Glue has ratios of 2, 4
 * and 10 only, and its attack and release in steps. The Compressor takes our
 * numbers as they are, and every edition of Live has it.
 *
 * ⚠️ Same settings, different algorithms: Live's attack and release are its
 * own, and so is its knee curve. This is a starting point a mix can be
 * adjusted from, not a copy of our output sample for sample.
 */

import { emitDevice, Ids, type DeviceNode } from './als-xml.ts';
import { FOLD_GAIN } from './audio/effects.ts';
import { GLUE, LIMITER, glueLevels, type MasterSettings } from './audio/master.ts';

/** The fold's gain in decibels: what the tracker's master bus hears over Live's master. */
const FOLD_DB = 20 * Math.log10(FOLD_GAIN);

/**
 * Live's Limiter lookahead menu, by `Lookahead` index: 1.5, 3 and 6 ms. The
 * order is read off Live's own presets -- `Low Latency` at 0, `Fast` and `Slow`
 * at 1, `Lookahead` at 2 -- and the values off the device in Live.
 */
const LIMITER_LOOKAHEAD_MS = [1.5, 3, 6];

/** The Compressor's `Model`: 0 is Peak (`Basic Peak Compressor`), 1 RMS (`Mix Gel`), 2 Expand. */
const PEAK = 0;

/** The two devices for the master track's `<Devices>`, as the tracker's master bus is set. */
export function masterBusDevices(ids: Ids, settings: MasterSettings): string {
  const { thresholdDb, makeupDb } = glueLevels(settings.amount);
  const lookahead = LIMITER_LOOKAHEAD_MS.reduce((best, ms, i) =>
    Math.abs(ms - LIMITER.lookaheadMs) < Math.abs(LIMITER_LOOKAHEAD_MS[best] - LIMITER.lookaheadMs) ? i : best, 0);
  const compressor = emitDevice(ids, ['c', 'Compressor2', { Id: '0' }, COMPRESSOR_MEMBERS], {
    IsExpanded: true,
    LastPresetRef: { xml: '<Value />' },
    ShouldShowPresetName: false,
    UserName: `LBP glue ${settings.amount}`,
    Threshold: 10 ** ((thresholdDb - FOLD_DB) / 20),
    Ratio: GLUE.ratio,
    Attack: GLUE.attackMs,
    Release: GLUE.releaseMs,
    AutoReleaseControlOnOff: false,
    Gain: makeupDb + FOLD_DB,
    GainCompensation: false,
    DryWet: 1,
    Model: PEAK,
    Knee: GLUE.kneeDb,
    LookAhead: 0,
  });
  const limiter = emitDevice(ids, ['c', 'Limiter', { Id: '1' }, LIMITER_MEMBERS], {
    IsExpanded: true,
    LastPresetRef: { xml: '<Value />' },
    ShouldShowPresetName: false,
    UserName: 'LBP limiter',
    Gain: 0,
    Ceiling: settings.ceilingDb,
    Release: LIMITER.releaseMs,
    AutoRelease: false,
    LinkChannels: true,
    Lookahead: lookahead,
  });
  return [compressor, limiter].join('\n');
}

/* ---------------------------------------------------------------- the trees */
// Generated from Live 11.3's own presets by `dev/als-device-tree.ts`, which
// checks that the tree rebuilds the file's elements in the file's order.

/** Live's Compressor, 260 elements, rebuilt in the same order, from Core Library/Devices/Audio Effects/Compressor/Basic Peak Compressor.adv. */
const COMPRESSOR_MEMBERS: readonly DeviceNode[] = [
  ['v', 'LomId', 0],
  ['v', 'LomIdView', 0],
  ['v', 'IsExpanded', false],
  ['b', 'On', true],
  ['v', 'ModulationSourceCount', 0],
  ['x', 'ParametersListWrapper', {'LomId':'0'}],
  ['x', 'Pointee', {'Id':'0'}],
  ['v', 'LastSelectedTimeableIndex', 0],
  ['v', 'LastSelectedClipEnvelopeIndex', 0],
  ['c', 'LastPresetRef', {}, [
    ['c', 'Value', {}, [
      ['c', 'AbletonDefaultPresetRef', {'Id':'0'}, [
        ['c', 'FileRef', {}, [
          ['v', 'RelativePathType', 5],
          ['v', 'RelativePath', 'Devices/Audio Effects/Compressor'],
          ['v', 'Path', '/Volumes/data/tmp/trunk/Core Library/Devices/Audio Effects/Compressor'],
          ['v', 'Type', 2],
          ['v', 'LivePackName', 'Core Library'],
          ['v', 'LivePackId', 'www.ableton.com/0'],
          ['v', 'OriginalFileSize', 0],
          ['v', 'OriginalCrc', 0],
        ]],
        ['x', 'DeviceId', {'Name':'Compressor2'}],
      ]],
    ]],
  ]],
  ['x', 'LockedScripts', {}],
  ['v', 'IsFolded', false],
  ['v', 'ShouldShowPresetName', true],
  ['v', 'UserName', 'Basic Peak Compressor'],
  ['v', 'Annotation', ''],
  ['c', 'SourceContext', {}, [
    ['x', 'Value', {}],
  ]],
  ['v', 'OverwriteProtectionNumber', 2820],
  ['f', 'Threshold', 1, 0.0003162277571, 1.99526238],
  ['f', 'Ratio', 2, 1, 3.4028232635611926e+38],
  ['f', 'ExpansionRatio', 1.14999998, 1, 2],
  ['f', 'Attack', 2, 0.009999999776, 1000],
  ['f', 'Release', 50, 1, 3000],
  ['b', 'AutoReleaseControlOnOff', false],
  ['f', 'Gain', 0, -36, 36],
  ['b', 'GainCompensation', true],
  ['f', 'DryWet', 1, 0, 1],
  ['e', 'Model', 0],
  ['e', 'LegacyModel', 1],
  ['b', 'LogEnvelope', true],
  ['e', 'LegacyEnvFollowerMode', 0],
  ['f', 'Knee', 6, 0, 18],
  ['e', 'LookAhead', 0],
  ['b', 'SideListen', false],
  ['c', 'SideChain', {}, [
    ['b', 'OnOff', false],
    ['c', 'RoutedInput', {}, [
      ['c', 'Routable', {}, [
        ['v', 'Target', 'AudioIn/None'],
        ['v', 'UpperDisplayString', 'No Output'],
        ['v', 'LowerDisplayString', ''],
        ['c', 'MpeSettings', {}, [
          ['v', 'ZoneType', 0],
          ['v', 'FirstNoteChannel', 1],
          ['v', 'LastNoteChannel', 15],
        ]],
      ]],
      ['f', 'Volume', 1, 0.0003162277571, 15.8489332],
    ]],
    ['f', 'DryWet', 1, 0, 1],
  ]],
  ['c', 'SideChainEq', {}, [
    ['b', 'On', false],
    ['e', 'Mode', 5],
    ['f', 'Freq', 200, 30, 15000],
    ['f', 'Q', 0.7071067691, 0.1000000015, 12],
    ['f', 'Gain', 0, -15, 15],
  ]],
  ['v', 'Live8LegacyMode', false],
  ['v', 'ViewMode', 0],
  ['v', 'IsOutputCurveVisible', false],
  ['v', 'RmsTimeShort', 8],
  ['v', 'RmsTimeLong', 250],
  ['v', 'ReleaseTimeShort', 15],
  ['v', 'ReleaseTimeLong', 1500],
  ['v', 'CrossfaderSmoothingTime', 10],
];

/** Live's Limiter, 78 elements, rebuilt in the same order, from Core Library/Devices/Audio Effects/Limiter/Low Latency.adv. */
const LIMITER_MEMBERS: readonly DeviceNode[] = [
  ['v', 'LomId', 0],
  ['v', 'LomIdView', 0],
  ['v', 'IsExpanded', true],
  ['b', 'On', true],
  ['v', 'ModulationSourceCount', 0],
  ['x', 'ParametersListWrapper', {'LomId':'0'}],
  ['x', 'Pointee', {'Id':'0'}],
  ['v', 'LastSelectedTimeableIndex', 0],
  ['v', 'LastSelectedClipEnvelopeIndex', 0],
  ['c', 'LastPresetRef', {}, [
    ['x', 'Value', {}],
  ]],
  ['x', 'LockedScripts', {}],
  ['v', 'IsFolded', false],
  ['v', 'ShouldShowPresetName', true],
  ['v', 'UserName', ''],
  ['v', 'Annotation', ''],
  ['c', 'SourceContext', {}, [
    ['x', 'Value', {}],
  ]],
  ['v', 'OverwriteProtectionNumber', 2820],
  ['f', 'Gain', 0, -24, 24],
  ['f', 'Ceiling', -0.3000000119, -24, 0],
  ['f', 'Release', 0.2460452169, 0.009999999776, 3000],
  ['b', 'AutoRelease', true],
  ['b', 'LinkChannels', true],
  ['e', 'Lookahead', 0],
];
