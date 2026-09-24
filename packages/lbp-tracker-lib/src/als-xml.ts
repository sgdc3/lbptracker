/**
 * The XML Live writes, as the pieces every part of a set is built from: its
 * leaves, its id space, and its three kinds of parameter.
 *
 * Shared by `als.ts` (the set) and `als-sampler.ts` (the instrument), which
 * both have to write members exactly as Live 11.3 does -- see
 * `steering/ableton-interchange.md`.
 */

export const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A number as Live writes one: no exponent, no float noise past the tenth decimal. */
export const num = (x: number) => String(Math.round(x * 1e10) / 1e10);

/** `<Name Value="..." />`, Live's leaf. */
export const v = (name: string, value: string | number | boolean) =>
  `<${name} Value="${typeof value === 'string' ? esc(value) : typeof value === 'number' ? num(value) : value}" />`;

/**
 * The document's ids.
 *
 * ❗ **Every `AutomationTarget`, `ModulationTarget` and `Pointee` in a set is
 * one id space**, and `NextPointeeId` has to lie past all of them; an envelope
 * finds its parameter by that number. One counter hands out the lot.
 */
export class Ids {
  private next = 1;
  take(): number {
    return this.next++;
  }
  get end(): number {
    return this.next;
  }
}

export const target = (ids: Ids, tag = 'AutomationTarget') =>
  `<${tag} Id="${ids.take()}">\n<LockEnvelope Value="0" />\n</${tag}>`;

/** An on/off parameter: `On`, `Speaker`. */
export const toggle = (ids: Ids, name: string, on = true) => [
  `<${name}>`, v('LomId', 0), v('Manual', on), target(ids),
  '<MidiCCOnOffThresholds>', v('Min', 64), v('Max', 127), '</MidiCCOnOffThresholds>',
  `</${name}>`,
].join('\n');

/**
 * A continuous parameter: its value, its MIDI-mapping range, and its two
 * targets. `found` is handed the automation target's id, which is what an
 * envelope names to move the parameter.
 */
export const dial = (
  ids: Ids,
  name: string,
  manual: number,
  min: number,
  max: number,
  found?: (id: number) => void,
) => {
  const id = ids.take();
  found?.(id);
  return [
    `<${name}>`, v('LomId', 0), v('Manual', manual),
    '<MidiControllerRange>', v('Min', min), v('Max', max), '</MidiControllerRange>',
    `<AutomationTarget Id="${id}">\n<LockEnvelope Value="0" />\n</AutomationTarget>`,
    target(ids, 'ModulationTarget'),
    `</${name}>`,
  ].join('\n');
};

export const routing = (tag: string, targetName: string, upper: string, lower: string) => [
  `<${tag}>`, v('Target', targetName), v('UpperDisplayString', upper), v('LowerDisplayString', lower),
  '<MpeSettings>', v('ZoneType', 0), v('FirstNoteChannel', 1), v('LastNoteChannel', 15), '</MpeSettings>',
  `</${tag}>`,
].join('\n');

/** The four routings; `out` is where the audio goes. */
export const routings = (out: 'master' | 'external') => [
  routing('AudioInputRouting', 'AudioIn/External/S0', 'Ext. In', '1/2'),
  routing('MidiInputRouting', 'MidiIn/External.All/-1', 'Ext: All Ins', ''),
  out === 'master'
    ? routing('AudioOutputRouting', 'AudioOut/Master', 'Master', '')
    : routing('AudioOutputRouting', 'AudioOut/External/S0', 'Ext. Out', '1/2'),
  routing('MidiOutputRouting', 'MidiOut/None', 'None', ''),
].join('\n');

/** What every device-like object opens with: the mixer, the sequencers. */
export const deviceHead = (ids: Ids) => [
  v('LomId', 0), v('LomIdView', 0), v('IsExpanded', true),
  toggle(ids, 'On'),
  v('ModulationSourceCount', 0), '<ParametersListWrapper LomId="0" />',
  `<Pointee Id="${ids.take()}" />`,
  v('LastSelectedTimeableIndex', 0), v('LastSelectedClipEnvelopeIndex', 0),
  '<LastPresetRef>\n<Value />\n</LastPresetRef>', '<LockedScripts />',
  v('IsFolded', false), v('ShouldShowPresetName', false), v('UserName', ''), v('Annotation', ''),
  '<SourceContext>\n<Value />\n</SourceContext>',
].join('\n');

/**
 * A member of a Live device, in the shapes Live writes them.
 *
 * ❗ **Every device here is one of these trees, derived from a file Live
 * saved, never typed in.** A script reads a device out of Live's own XML and
 * reduces each member to one of the kinds below; the tree rebuilt from that
 * has the same elements in the same order as Live's, which is what the loader
 * checks (`steering/ableton-interchange.md`).
 *
 * | kind | Live writes | |
 * |---|---|---|
 * | `f` | `LomId`, `Manual`, `MidiControllerRange`, `AutomationTarget`, `ModulationTarget` | a dial, with its range |
 * | `b` | `LomId`, `Manual`, `AutomationTarget`, `MidiCCOnOffThresholds` | a switch |
 * | `e` | `LomId`, `Manual`, `AutomationTarget` | a choice |
 * | `m` | `LomId`, `Manual`, `AutomationTarget`, `ModulationTarget` | a dial with no range |
 * | `v` | `<Name Value="..." />` | a leaf |
 * | `x` | an empty element, with its attributes | |
 * | `c` | an element holding others | |
 */
export type DeviceNode =
  | readonly ['f', string, number, number, number]
  | readonly ['b', string, boolean]
  | readonly ['e', string, number | boolean]
  | readonly ['m', string, number]
  | readonly ['v', string, string | number | boolean]
  | readonly ['x', string, Readonly<Record<string, string>>]
  | readonly ['c', string, Readonly<Record<string, string>>, readonly DeviceNode[]];

/**
 * Values to write over a tree's, by dotted path from the root's children:
 * `Filter.Slot.Value.SimplerFilter.Freq`. A container's entry replaces its
 * children -- with other nodes, or with XML already written.
 */
export type DeviceOverrides = Readonly<Record<string, string | number | boolean | readonly DeviceNode[] | { readonly xml: string }>>;

const attrs = (a: Readonly<Record<string, string>>) =>
  Object.entries(a).map(([k, value]) => ` ${k}="${esc(value)}"`).join('');

/** One tree as Live's XML, with fresh ids from `ids` and `set` written over it. */
export function emitDevice(ids: Ids, root: DeviceNode, set: DeviceOverrides = {}): string {
  const emit = (node: DeviceNode, path: string): string => {
    const own = path in set ? set[path] : undefined;
    const scalar = own !== undefined && typeof own !== 'object' ? own : undefined;
    const kid = (child: DeviceNode) => emit(child, path === '' ? child[1] : `${path}.${child[1]}`);
    switch (node[0]) {
      case 'f':
        return dial(ids, node[1],
          typeof scalar === 'number' ? Math.min(node[4], Math.max(node[3], scalar)) : node[2], node[3], node[4]);
      case 'b':
        return toggle(ids, node[1], typeof scalar === 'boolean' ? scalar : node[2]);
      case 'e':
        return [`<${node[1]}>`, v('LomId', 0), v('Manual', scalar ?? node[2]), target(ids), `</${node[1]}>`].join('\n');
      case 'm':
        return [`<${node[1]}>`, v('LomId', 0), v('Manual', typeof scalar === 'number' ? scalar : node[2]),
          target(ids), target(ids, 'ModulationTarget'), `</${node[1]}>`].join('\n');
      case 'v':
        return v(node[1], scalar ?? node[2]);
      case 'x':
      case 'c': {
        // A pointee is an id like any other, and a fresh one per device.
        if (node[0] === 'x' && node[1] === 'Pointee') return `<Pointee Id="${ids.take()}" />`;
        const open = `<${node[1]}${attrs(node[2])}`;
        const inner = own !== undefined && typeof own === 'object'
          ? ('xml' in own ? own.xml : own.map(kid).join('\n'))
          : node[0] === 'c' ? node[3].map(kid).join('\n') : '';
        return inner === '' ? `${open} />` : [`${open}>`, inner, `</${node[1]}>`].join('\n');
      }
    }
  };
  return emit(root, '');
}

