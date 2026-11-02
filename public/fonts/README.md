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
Wait for the font to load before measuring/drawing world text. Font-size 18px
has a 9px narrow advance and an 18px full-width advance; no `fillText` maxWidth
compression is needed for supported glyphs in their correct-width cells.
