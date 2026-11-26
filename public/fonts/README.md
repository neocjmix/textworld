# Sarasa Fixed K

This directory contains the Regular face of **Sarasa Fixed K 1.0.43**, converted
from its official unhinted TrueType release to WOFF2 without glyph subsetting,
outline changes, or advance-width changes.

- Project: https://github.com/be5invis/Sarasa-Gothic
- Pinned release: https://github.com/be5invis/Sarasa-Gothic/releases/tag/v1.0.43
- Source archive: https://github.com/be5invis/Sarasa-Gothic/releases/download/v1.0.43/SarasaFixedK-TTF-Unhinted-1.0.43.7z
- License: [SIL Open Font License 1.1](OFL-Sarasa.txt)
- Exact source/output hashes and sizes: [provenance.json](provenance.json)

Only `SarasaFixedK-Regular.ttf` was extracted. Container conversion used FontTools
4.61.1 with Brotli support:

```python
from fontTools.ttLib import TTFont
font = TTFont("SarasaFixedK-Regular.ttf")
font.flavor = "woff2"
font.save("sarasa-fixed-k-regular-1.0.43.woff2")
```

The WOFF2 font has 54,195 glyphs and maps 51,228 Unicode characters. Coverage
includes all 11,172 Hangul syllables, all 20,992 Basic Han characters, all 6,592
CJK Extension A characters, and the standard Hiragana/Katakana letter ranges.
It does not claim to contain every Unicode character or every emoji.

The `K` orthography chooses Korean regional glyph forms; it also includes the
Japanese and Chinese scripts. `Fixed` is the monospaced, no-ligature Sarasa
variant and uses a narrow em dash. The project documentation distinguishes it
from the `Mono` variant, which has full-width em dashes.

Serve the versioned WOFF2 with `Content-Type: font/woff2` and immutable caching.
The historical full-font entry path waited for this entire file before connecting; see the current delivery method below. Font-size 18px
has a 9px narrow advance and an 18px full-width advance; no `fillText` maxWidth
compression is needed for supported glyphs in their correct-width cells.

## Unicode-range delivery (2026-11-26)

The public map now uses CSS `unicode-range` parts of the same pinned font. It
loads the core face to enter the map, then the browser loads the parts required
by visible or typed characters. A FontFaceSet `loadingdone` handler repaints an
idle Canvas when a late part arrives. The original full file remains available
for old cached pages and as a verification oracle; the map does not preload it.

Hangul syllables, modern/archaic jamo, compatibility/halfwidth jamo and tone marks
share one part. Splitting them by scalar range changes NFC/NFD shaping, so that
experiment was rejected. Han is divided into 1,024-code-point ranges; sparse
supplementary Han uses one part. Other scripts, punctuation and symbols use the
core. All original cmap format 14 variation mappings are retained. This is a
transport partition, not a reduction of supported characters.

`subsets.json` records every output hash, byte count and CSS range. Rebuild with
`python3 scripts/subset-map-font.py` after installing the pinned build-only
FontTools/Brotli versions listed in that script. The build checks the union of
all 51,228 characters, advances, outline coordinates/flags and variant mappings
against the original. It also preserves the original .notdef outline, which is
explicitly mapped by one private-use character. No Python/font tools run in
production. Output names contain content hashes and use immutable caching.

`npm run test:fonts` verifies real browser loading, advances, NFC/NFD equivalence
and late-font repainting. Raw Canvas raster differences are recorded: subset
rasterization is not promised to be bit-identical to the full face even though
the vectors and metrics match. The unchanged 1:2 advances keep world positions
stable. A system fallback can briefly draw a not-yet-downloaded part; `swap`
and the repaint handler replace it without changing cell addresses or layout.
