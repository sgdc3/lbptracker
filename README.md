# LBP Tracker

A faithful re-implementation of LittleBigPlanet 3's in-game **Music Sequencer**, as a standalone
tracker that runs in the browser. *Faithful* is the whole point: the target is not a tracker that
sounds nice, it is one whose output you cannot tell apart from the game's. Every constant in the
engine was measured out of the game's own binaries, and `steering/` says how.

## Layout

Three npm workspaces, split by dependency direction:

| directory | package | what it is |
|---|---|---|
| `packages/cwlib-ts` | `@lbptracker/cwlib` | reads LBP's serialised resources: containers, the Thing graph, saves, archives |
| `packages/lbp-tracker-lib` | `@lbptracker/lib` | turns that into sound: the sampler, the DSP chain, the render pipeline, MIDI |
| `packages/lbp-tracker-web` | `@lbptracker/web` | the four pages — the instrument bench, the live player, the offline renderer, the MIDI bridge |

The two libraries are plain TypeScript with **no build step**: Node runs them directly, so the file
the browser executes is the file the tests execute. Only the web package has a bundler (Vite), and
the reason is a measurement recorded in its `vite.config.ts`. Each package has a `README.md`.

`tools/` holds the reverse-engineering helpers and the Python reference implementations the
TypeScript is checked against; `steering/` holds what is known about the game and how it was
measured. Start with `steering/project-brief.md`.

## Running it

Node 24 or newer.

```bash
npm install          # once; links the workspaces, downloads only the web package's tooling
npm run serve        # http://127.0.0.1:8173
npm run build        # -> dist/, relocatable static files
npm run preview      # serves dist/ on http://127.0.0.1:8174
```

```bash
npm test             # node --test across all packages
npm run typecheck    # tsc for the libraries, vue-tsc for the web package
npm run check        # both, in that order
```

`npm test -w @lbptracker/lib` and `npm run typecheck -w @lbptracker/cwlib` scope either to one
package.

## What is not here

The game's samples and instrument definitions are copyrighted Sony / Media Molecule material. The
tracker reads them out of the user's own installation; `fixtures/` is gitignored for that reason,
and `steering/tools.md` says how to fill it. Nothing extracted from the game may be committed.

## License

MIT — see `LICENSE`. LittleBigPlanet is a trademark of Sony Interactive Entertainment; this project
is not affiliated with or endorsed by Sony or Media Molecule.
