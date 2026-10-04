/**
 * A Live device preset to a `DeviceNode` tree, the shape `als-xml.ts` emits.
 *
 *     node packages/lbp-tracker-lib/dev/als-device-tree.ts "<Core Library>/Devices/Audio Effects/Limiter/Low Latency.adv"
 *
 * Reads the file Live saved (gzipped or not), takes the device under `<Ableton>`,
 * reduces every member to one of the kinds `DeviceNode` lists -- a dial with its
 * range, a switch, a choice, a dial with no range, a leaf, an empty element, a
 * container -- and prints the tree as a TypeScript literal. Then it checks
 * itself: the tree goes back through `emitDevice` and the element names must
 * come out the same, in the same order, as the file's. The ids, the numbers'
 * last digits and the preset reference are what may differ.
 *
 * ❗ This is the "derived, not typed" rule of `steering/ableton-interchange.md`
 * as a script: the devices in `als-sampler.ts` and `als-master.ts` are its
 * output, pasted, and a member Live writes and a tree lacks is how a set loses
 * a setting with a clean log.
 */

import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { emitDevice, Ids, type DeviceNode } from '../src/als-xml.ts';

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

const unescape = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Live's XML has no text content, only elements and attributes: a tag stack is enough. */
function parse(xml: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  for (const [, close, name, rest, self] of xml.matchAll(/<(\/?)([A-Za-z][\w.]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const [, key, value] of rest.matchAll(/([\w.]+)="([^"]*)"/g)) attrs[key] = unescape(value);
    const node: XmlNode = { name, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root;
}

const typed = (text: string): string | number | boolean =>
  text === 'true' ? true : text === 'false' ? false : /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;

const names = (node: XmlNode) => node.children.map((c) => c.name).join(',');
const manual = (node: XmlNode) => typed(node.children[1].attrs.Value);

function reduce(node: XmlNode): DeviceNode {
  const shape = names(node);
  if (shape === 'LomId,Manual,MidiControllerRange,AutomationTarget,ModulationTarget') {
    const range = node.children[2].children;
    return ['f', node.name, manual(node) as number, Number(range[0].attrs.Value), Number(range[1].attrs.Value)];
  }
  if (shape === 'LomId,Manual,AutomationTarget,MidiCCOnOffThresholds') return ['b', node.name, manual(node) as boolean];
  if (shape === 'LomId,Manual,AutomationTarget') return ['e', node.name, manual(node) as number | boolean];
  if (shape === 'LomId,Manual,AutomationTarget,ModulationTarget') return ['m', node.name, manual(node) as number];
  const keys = Object.keys(node.attrs);
  if (node.children.length === 0 && keys.length === 1 && keys[0] === 'Value') return ['v', node.name, typed(node.attrs.Value)];
  if (node.children.length === 0) return ['x', node.name, node.attrs];
  return ['c', node.name, node.attrs, node.children.map(reduce)];
}

const literal = (value: unknown) => (typeof value === 'string' ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'` : String(value));
const attrsLiteral = (a: Readonly<Record<string, string>>) =>
  `{${Object.entries(a).map(([k, value]) => `${literal(k)}:${literal(value)}`).join(', ')}}`;

function print(node: DeviceNode, depth: number): string[] {
  const pad = '  '.repeat(depth);
  switch (node[0]) {
    case 'c':
      return [`${pad}['c', ${literal(node[1])}, ${attrsLiteral(node[2])}, [`, ...node[3].flatMap((c) => print(c, depth + 1)), `${pad}]],`];
    case 'x':
      return [`${pad}['x', ${literal(node[1])}, ${attrsLiteral(node[2])}],`];
    default:
      return [`${pad}[${node.map(literal).join(', ')}],`];
  }
}

const file = process.argv[2];
if (!file) throw new Error('usage: als-device-tree.ts <preset.adv>');
const bytes = await readFile(file);
const xml = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
const device = parse(xml).children.find((n) => n.name === 'Ableton')?.children[0];
if (!device) throw new Error(`${file}: no device under <Ableton>`);
const tree = reduce(device);

// The check: the same elements, in the same order, out of `emitDevice`.
const tags = (text: string) => [...text.matchAll(/<([A-Za-z][\w.]*)[\s/>]/g)].map((m) => m[1]);
const original = tags(xml.slice(xml.indexOf(`<${device.name}`)));
const rebuilt = tags(emitDevice(new Ids(), tree));
const first = original.findIndex((tag, i) => tag !== rebuilt[i]);
if (first >= 0 || original.length !== rebuilt.length) {
  const at = first >= 0 ? first : Math.min(original.length, rebuilt.length);
  throw new Error(`element ${at} differs: Live wrote ${original[at]}, the tree gives ${rebuilt[at]}`);
}
console.log(`// ${original.length} elements, rebuilt in the same order, from ${file.replace(/^.*Core Library/, 'Core Library')}`);
console.log(print(tree, 0).join('\n').replace(/,$/, ';'));
