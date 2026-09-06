# `@lbptracker/web`

The tracker's pages. Four of them, all client-side, all reading the user's own game install in the
tab — nothing is uploaded and the dev server makes no outbound requests.

```bash
npm install          # once, from the repository root
npm run serve        # http://127.0.0.1:8173
npm run build        # -> dist/
npm run preview      # http://127.0.0.1:8174
```

| page | what it is |
|---|---|
| `index.html` | the instrument bench: any of the game's 68 instruments, across its key splits, with every voice and effect parameter live |
| `live.html` | play a song as it is synthesised, notes scheduled a second ahead |
| `render.html` | render a sequencer to a WAV, offline, in a worker |
| `midi.html` | the MIDI bridge, in and out |

## ❗ This is the only package with a build

`cwlib` and `lib` are plain TypeScript that Node runs unaided; the bundler stops here. `vite.config.ts`
carries the reasoning, and the short version is a measurement: **import maps do not reach a Worker or
an AudioWorklet**, and this app has both. `render-worker.ts` reaches `assets.ts`, `render.ts` and
`backup.ts`, so the worker's module graph is nearly the whole engine — without a bundler none of it
could use the package names.

## Two rules the URLs live by

⚠️ **`asset()` in `src/assets.ts` is the one place that builds an asset URL.** A bare relative URL in
a worker resolves against the *worker's* directory, and a leading slash breaks under a static host
that serves from a prefix; `import.meta.url` is the only form right in both. It also percent-encodes
every segment — three of the game's 216 samples carry a `#`, and `new URL` reads that as a fragment.

⚠️ **`fixtures/` is served, never built.** They are the user's own game data, extracted locally with
`tools/ExtractGuid.java`, and they must never enter `dist/`. A middleware in `vite.config.ts` serves
them in dev and in preview; where a real deployment gets them is the deployment's business.
