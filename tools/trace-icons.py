"""
The game's instrument icons, traced into the SVG paths `src/editor/icons.ts` holds.

    python tools/trace-icons.py <icon-png-dir> [out.ts]

`tools/IconDump.java` writes that directory: each palette plan's
`InventoryItemDetails.icon` decoded to a 128 x 128 PNG, named after the `.rinst`
it places, so the keys line up with `fixtures/rinst`.

❗ **What comes out is a derivative of Sony / Media Molecule's art and it is
committed.** That is the project owner's decision, taken twice and knowingly:
icons drawn from scratch were tried on 2026-09-07 and judged worse to use. The
licensing note in steering/game-assets.md is where the fact lives.

What the pixels are, and what each step is for:

  * The texture is a **striped silhouette inside a metal frame**. The frame is
    the game's chrome, not the instrument, so a fixed inset drops it.
  * The ink is the warm colour; the frame is grey and the ground dark, so
    `r - min(g, b)` separates them where a brightness threshold would not.
  * The stripes are LBP's texture, not the drawing. Left alone every icon comes
    out a comb, so the mask is **closed down the y axis** (dilate then erode)
    and any enclosed gap thinner than a few pixels is filled. ⚠️ A bigger span
    merges parts that should stay apart -- at span 3 a marimba's bars run into
    one another -- so it is deliberately small.
  * Marching squares gives closed loops, outer ones one way round and holes the
    other, which is what makes SVG's nonzero winding cut the holes out for free.
  * Douglas-Peucker then thins the loops. ⚠️ **Run straight on a closed loop it
    returns two points**: the first and last are the same, the baseline has no
    length, and every point measures as being on it. The loop is cut at its far
    side and simplified as two arcs.

**The simplification is deliberately light.** Measured 2026-09-07 at 48 px,
which is the biggest a picker row draws: eps 0.7 costs 1,413 characters an
icon, eps 1.1 costs 597, eps 1.6 costs 485 and eps 2.2 costs 401, and 0.7
against 1.1 is not tellable apart. Past 1.6 the harp's strings and a marimba's
bars start to soften. EPS below is the one knob worth turning.
"""

EPS = 1.1
SPAN = 2
import zlib, struct

def read(path):
    b = open(path, 'rb').read()
    pos, w, h, colour, idat = 8, 0, 0, 6, b''
    while pos < len(b):
        ln = struct.unpack('>I', b[pos:pos+4])[0]; typ = b[pos+4:pos+8]
        data = b[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, depth, colour = struct.unpack('>IIBB', data[:10])
            assert depth == 8, depth
        elif typ == b'IDAT': idat += data
        pos += 12 + ln
    raw = zlib.decompress(idat)
    ch = {6: 4, 2: 3, 0: 1}[colour]
    out = bytearray(w * h * 4)
    stride, prev, p = w * ch, bytearray(w * ch), 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p+stride]); p += stride
        if f:
            for x in range(stride):
                a = line[x-ch] if x >= ch else 0
                bb = prev[x]
                c = prev[x-ch] if x >= ch else 0
                if f == 1: line[x] = (line[x] + a) & 255
                elif f == 2: line[x] = (line[x] + bb) & 255
                elif f == 3: line[x] = (line[x] + (a + bb)//2) & 255
                else:
                    pa, pb, pc = abs(bb-c), abs(a-c), abs(a+bb-2*c)
                    pr = a if (pa <= pb and pa <= pc) else (bb if pb <= pc else c)
                    line[x] = (line[x] + pr) & 255
        for x in range(w):
            px = line[x*ch:(x+1)*ch]
            o = (y*w+x)*4
            if ch == 4: out[o:o+4] = px
            elif ch == 3: out[o:o+4] = bytes(px) + b'\xff'
            else: out[o:o+4] = bytes([px[0]]*3) + b'\xff'
        prev = line
    return w, h, out

def write(path, w, h, buf):
    raw = b''.join(b'\x00' + bytes(buf[y*w*4:(y+1)*w*4]) for y in range(h))
    def chunk(t, data):
        c = t + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


import os

INSET = 12          # the frame, in texture pixels

def mask(path, inset=INSET):
    w, h, px = read(path)
    m = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            if x < inset or y < inset or x >= w - inset or y >= h - inset: continue
            r, g, b, a = px[(y*w+x)*4: (y*w+x)*4+4]
            # the ink is the warm colour; the frame is grey and the ground dark
            if a > 96 and r > 80 and r - min(g, b) > 28: m[y*w+x] = 1
    return w, h, m

def close_vertically(w, h, m, span):
    """Dilate then erode down the y axis: joins the stripes, keeps the outline."""
    d = bytearray(w * h)
    for x in range(w):
        for y in range(h):
            if not m[y*w+x]: continue
            for k in range(-span, span+1):
                yy = y + k
                if 0 <= yy < h: d[yy*w+x] = 1
    e = bytearray(w * h)
    for x in range(w):
        for y in range(h):
            if not d[y*w+x]: continue
            ok = True
            for k in range(-span, span+1):
                yy = y + k
                if yy < 0 or yy >= h or not d[yy*w+x]: ok = False; break
            if ok: e[y*w+x] = 1
    return e

def fill_holes_small(w, h, m, limit):
    """Flood the background from the edge; anything unreached and small is a stripe gap."""
    seen = bytearray(w * h)
    stack = [(x, y) for x in range(w) for y in (0, h-1) if not m[y*w+x]]
    stack += [(x, y) for y in range(h) for x in (0, w-1) if not m[y*w+x]]
    for x, y in stack: seen[y*w+x] = 1
    while stack:
        x, y = stack.pop()
        for dx, dy in ((1,0),(-1,0),(0,1),(0,-1)):
            nx, ny = x+dx, y+dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny*w+nx] and not m[ny*w+nx]:
                seen[ny*w+nx] = 1; stack.append((nx, ny))
    # Group the unreached background into regions, and fill only the thin ones:
    # a stripe gap is a few pixels tall, a real hole is round and bigger.
    out = bytearray(m)
    todo = bytearray(w * h)
    for i in range(w * h):
        if not m[i] and not seen[i]: todo[i] = 1
    for start in range(w * h):
        if not todo[start]: continue
        region, stack = [], [start]
        todo[start] = 0
        while stack:
            i = stack.pop(); region.append(i)
            x, y = i % w, i // w
            for nx, ny in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                if 0 <= nx < w and 0 <= ny < h and todo[ny*w+nx]:
                    todo[ny*w+nx] = 0; stack.append(ny*w+nx)
        ys = [i // w for i in region]
        if max(ys) - min(ys) + 1 <= limit:     # stripe-thin: close it
            for i in region: out[i] = 1
    return out

def contours(w, h, m):
    """Marching squares on the mask's edges: closed loops of unit steps."""
    edges = {}
    def add(a, b): edges.setdefault(a, []).append(b)
    at = lambda x, y: (0 <= x < w and 0 <= y < h and m[y*w+x])
    for y in range(h):
        for x in range(w):
            if not at(x, y): continue
            if not at(x, y-1): add((x, y), (x+1, y))          # top edge, rightwards
            if not at(x+1, y): add((x+1, y), (x+1, y+1))      # right, down
            if not at(x, y+1): add((x+1, y+1), (x, y+1))      # bottom, left
            if not at(x-1, y): add((x, y+1), (x, y))          # left, up
    loops = []
    while edges:
        start = next(iter(edges))
        loop = [start]
        cur = start
        while True:
            nxt = edges.get(cur)
            if not nxt: break
            step = nxt.pop()
            if not nxt: del edges[cur]
            loop.append(step)
            cur = step
            if cur == start: break
        if len(loop) > 8: loops.append(loop)
    return loops

def simplify(points, eps):
    """
    Douglas-Peucker on a **closed** loop.

    ⚠️ Run straight on a loop it returns two points: the first and the last are
    the same, so the baseline has no length and every point is 'on' it. The
    loop has to be cut at its far side first and simplified as two arcs.
    """
    pts_closed = points[:-1] if points[0] == points[-1] else points[:]
    if len(pts_closed) < 4: return points

    def dp(pts):
        if len(pts) < 3: return pts
        ax, ay = pts[0]; bx, by = pts[-1]
        dx, dy = bx-ax, by-ay
        n = (dx*dx + dy*dy) ** .5 or 1
        worst, at = 0, 0
        for i in range(1, len(pts)-1):
            px, py = pts[i]
            d = abs(dy*px - dx*py + bx*ay - by*ax) / n
            if d > worst: worst, at = d, i
        if worst <= eps: return [pts[0], pts[-1]]
        return dp(pts[:at+1])[:-1] + dp(pts[at:])

    ax, ay = pts_closed[0]
    far = max(range(len(pts_closed)), key=lambda i: (pts_closed[i][0]-ax)**2 + (pts_closed[i][1]-ay)**2)
    first = dp(pts_closed[:far+1])
    second = dp(pts_closed[far:] + [pts_closed[0]])
    return first[:-1] + second

def area(points):
    s = 0
    for i in range(len(points)-1):
        x0, y0 = points[i]; x1, y1 = points[i+1]
        s += x0*y1 - x1*y0
    return s / 2

def to_path(loops, w, h, size=24, margin=1.0, eps=0.9, places=1):
    """Loops in texture pixels to one SVG path in a `size` box, biggest first."""
    xs = [p[0] for l in loops for p in l]; ys = [p[1] for l in loops for p in l]
    if not xs: return ''
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    scale = (size - 2*margin) / max(x1-x0, y1-y0, 1)
    ox = margin + ((size - 2*margin) - (x1-x0)*scale) / 2
    oy = margin + ((size - 2*margin) - (y1-y0)*scale) / 2
    out = []
    for loop in sorted(loops, key=lambda l: -abs(area(l))):
        pts = simplify(loop, eps)
        if len(pts) < 4 or abs(area(pts)) < 4: continue
        d = []
        for i, (x, y) in enumerate(pts):
            sx = round(ox + (x - x0) * scale, places)
            sy = round(oy + (y - y0) * scale, places)
            d.append(('M' if i == 0 else 'L') + f'{sx:g} {sy:g}')
        out.append(''.join(d) + 'Z')
    return ''.join(out)

def icon_path(png, **kw):
    w, h, m = mask(png)
    m = close_vertically(w, h, m, kw.pop('span', 3))
    m = fill_holes_small(w, h, m, kw.pop('gap', 4))
    return to_path(contours(w, h, m), w, h, **kw), (w, h, m)


# ------------------------------------------------------------------ the file

HEADER = """/**
 * One icon per sound: the 68 `.rinst` files the game ships, keyed by file name.
 *
 * ❗ **Generated, and traced from the game's own icons.** Each is the silhouette
 * of the texture that sound's palette item carries; `tools/IconDump.java` pulls
 * those out and `tools/trace-icons.py` turns them into paths. Regenerate with
 * those two rather than editing a path here.
 *
 * ❗ They are a derivative of Sony / Media Molecule's art, which is a deliberate
 * decision and not an oversight: see the licensing note in
 * steering/game-assets.md. Icons drawn from scratch were tried and dropped.
 *
 * A path in `f` is **filled** with the nonzero rule, which is how the game
 * draws them; `d` would be stroked. A file with no entry falls back to its
 * family's glyph (`drawGlyph`).
 */

export interface Icon {
  /** Stroked, in the family's colour. */
  readonly d?: string;
  /** Filled solid: every icon here is of this kind. */
  readonly f?: string;
}

export const ICONS: Readonly<Record<string, Icon>> = {
"""

FOOTER = """};

/** The icon's key for a manifest row: the file without its extension. */
export const iconKeyOf = (file: string): string => file.replace(/^.*NEEDSLASH/, '').replace(/NEEDDOTrinst$/, '');
"""

NL = chr(10)


def main(argv):
    src = argv[1]
    out = argv[2] if len(argv) > 2 else 'packages/lbp-tracker-web/src/editor/icons.ts'
    names = sorted(n[:-4] for n in os.listdir(src) if n.endswith('.png'))
    rows = []
    for name in names:
        d, _ = icon_path(os.path.join(src, name + '.png'), eps=EPS, span=SPAN)
        if not d:
            print('  no shape traced for', name)
            continue
        key = name if name[0].isalpha() else "'%s'" % name
        rows.append("  %s: { f: '%s' }," % (key, d))
    footer = FOOTER.replace('NEEDSLASH', chr(92) + '/').replace('NEEDDOT', chr(92) + '.')
    with open(out, 'w', encoding='utf-8', newline=NL) as fh:
        fh.write(HEADER + NL.join(rows) + NL + footer)
    print('%d icons -> %s (%.0f KB)' % (len(rows), out, os.path.getsize(out) / 1024))


if __name__ == '__main__':
    import sys
    main(sys.argv)
