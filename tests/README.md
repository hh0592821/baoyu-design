# SVG PNG capture regression

This opt-in browser test uses the actual capture helpers and PNG export function
from the checked-in canvas editor bundle, with a synthetic HTML fixture only.
It is separate from the existing Node-only `npm test` suite.

## Run

With Node.js and Playwright installed:

```sh
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node --test tests/capture-svg.test.mjs
```

Alternatively set `PLAYWRIGHT_MODULE` to an installed `playwright` or
`playwright-core` module specifier or entry-file path, and `CHROME_PATH` to an
existing Chromium executable. Missing dependencies fail explicitly, not skip.
The fixture server binds to a random loopback port and the browser context
blocks requests to other origins.

Set `SVG_CAPTURE_EVIDENCE` to a writable directory to save the synthetic screen,
export PNG, serialized XML, per-icon RGBA digests and diagnostic metadata.
These artifacts are not part of the patch.

## Negative control

Extract the affected baseline bundle, then select it with `BASELINE_ASSET`:

```sh
git show 7db9784ac4f4974d78ab166c7db1c706c0481c3d:skills/claude-design/scripts/editor/assets/index-CLSAsUf1.js > /tmp/svg-capture-baseline.js
BASELINE_ASSET=/tmp/svg-capture-baseline.js node --test tests/capture-svg.test.mjs
```

This run must fail the export-to-screen comparisons for the affected CSS
definition cases; a passing baseline would invalidate the regression proof.

## Coverage boundaries

The 28 synthetic cases cover authored attributes and inline styles, CSS outline
paint, per-use `currentColor`, custom-property chains and priority, structural
selectors, intentional black and fixed multi-color paint, gradients and clipping,
inactive imports, layer ordering with important paint, and source media conditions.
The media cases deliberately use a 1600px source viewport and a 1344px selection
on opposite sides of a 1400px breakpoint, covering rules, sheets and imports.
They assert the entire 1344×48 RGBA image and every icon, unchanged source DOM,
definition child positions, valid XML, empty export warnings and page errors.
They do not constitute a complete editor UI test, private-artwork reproduction,
other-browser validation, or exhaustive stylesheet-feature coverage.
In particular, nested CSS rules containing `currentColor` are a known pre-existing
capture limitation; this patch does not claim to fix that separate case.

## CSS mask PNG capture

Run the synthetic CSS mask regression with the same browser prerequisites:

```sh
node --test tests/capture-mask.test.mjs
```

This test uses the checked-in capture runtime and anonymous loopback fixtures;
it does not read or write actual design projects or exports. It covers external
mask images on elements and pseudo-elements, retained image/background behavior,
and failures that must produce warnings. For a negative control, extract the
previous bundle and confirm the same test fails:

```sh
git show 5ca8ab421ce833dea74e80f601959e2fed63bde6:skills/claude-design/scripts/editor/assets/index-CLSAsUf1.js > /tmp/mask-capture-baseline.js
BASELINE_ASSET=/tmp/mask-capture-baseline.js node --test tests/capture-mask.test.mjs
```

No original artwork is included in the fixture. Multi-layer coverage uses the
standard `intersect` operator, not legacy `-webkit-mask-composite: source-in`.
Complex CSS-escaped URLs are left unembedded with a warning. External SVG
fragment rendering is not exhaustively validated; resource failures can still
yield an incomplete PNG and produce a capture warning.
