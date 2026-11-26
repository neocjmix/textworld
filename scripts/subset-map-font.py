#!/usr/bin/env python3
"""Build the pinned font's CSS unicode-range parts, without reducing coverage.

Build-time only: python3 -m pip install fonttools==4.61.1 brotli==1.2.1
python3 scripts/subset-map-font.py [--ttf /path/to/unpacked-original.ttf]
The optional TTF avoids repeating WOFF2 outline reconstruction during experiments.
"""
import argparse
from concurrent.futures import ProcessPoolExecutor
from hashlib import sha256
import json
import re
from pathlib import Path
import tempfile
from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
DIRECTORY = ROOT / 'public/fonts'
SOURCE = DIRECTORY / 'sarasa-fixed-k-regular-1.0.43.woff2'
SOURCE_HASH = 'd6fe195614ff2e94c6d8bc9e05c39782b8fe0caf06f090116fc900ef39861f77'


def ranges(characters):
    intervals = []
    for char in sorted(characters):
        if intervals and char == intervals[-1][1] + 1:
            intervals[-1][1] = char
        else:
            intervals.append([char, char])
    return ','.join(f'U+{a:X}' + (f'-{b:X}' if a != b else '') for a, b in intervals)


def outline(font, glyph):
    coordinates, ends, flags = font['glyf'][glyph].getCoordinates(font['glyf'])
    return sha256(repr((list(coordinates), list(ends), list(flags))).encode()).hexdigest()


def variations(font, characters):
    return {(selector, char): glyph or font.getBestCmap()[char]
            for table in font['cmap'].tables if table.format == 14
            for selector, pairs in table.uvsDict.items()
            for char, glyph in pairs if char in characters}


def build(job):
    path, name, characters, selectors = job
    font = TTFont(path, recalcTimestamp=False)
    original = font.getBestCmap()
    metrics = {c: font['hmtx'][original[c]] for c in characters}
    shapes = {c: outline(font, original[c]) for c in characters}
    variant_glyphs = variations(font, set(characters))
    variant_shapes = {pair: (outline(font, glyph), font['hmtx'][glyph]) for pair, glyph in variant_glyphs.items()}
    options = subset.Options()
    options.layout_features = ['*']
    options.notdef_outline = True
    worker = subset.Subsetter(options=options)
    worker.populate(unicodes=characters + selectors)
    worker.subset(font)
    font.flavor = 'woff2'
    with tempfile.NamedTemporaryFile(suffix='.woff2') as output:
        font.save(output.name)
        data = Path(output.name).read_bytes()
        check = TTFont(output.name)
        cmap = check.getBestCmap()
        assert set(cmap) == set(characters), name
        assert all(check['hmtx'][cmap[c]] == metrics[c] for c in characters), name
        assert all(outline(check, cmap[c]) == shapes[c] for c in characters), name
        actual_variants = variations(check, set(characters))
        assert set(actual_variants) == set(variant_shapes), name
        assert all((outline(check, glyph), check['hmtx'][glyph]) == variant_shapes[pair]
                   for pair, glyph in actual_variants.items()), name
    digest = sha256(data).hexdigest()
    filename = f'sarasa-fixed-k-{name}-{digest[:12]}-1.0.43.woff2'
    (DIRECTORY / filename).write_bytes(data)
    print(f'{name}: {len(characters)} characters, {len(data)} bytes', flush=True)
    return {'file': filename, 'sha256': digest, 'bytes': len(data), 'characters': len(characters), 'unicodeRange': ranges(characters + selectors)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ttf', type=Path)
    args = parser.parse_args()
    assert sha256(SOURCE.read_bytes()).hexdigest() == SOURCE_HASH
    original = TTFont(SOURCE, recalcTimestamp=False)
    cmap = original.getBestCmap()
    selectors = sorted({selector for table in original['cmap'].tables if table.format == 14 for selector in table.uvsDict})
    groups = {}
    for char in cmap:
        if (0xAC00 <= char <= 0xD7FF or 0x1100 <= char <= 0x11FF or 0x3131 <= char <= 0x318E
                or 0xA960 <= char <= 0xA97F or 0xFFA0 <= char <= 0xFFDC or char in (0x302E, 0x302F)):
            name = 'hangul'
        elif 0x3400 <= char <= 0x9FFF:
            name = f'{char // 1024 * 1024:04x}'
        elif 0x20000 <= char <= 0x3FFFF:
            name = 'han-supplement'
        else:
            name = 'core'
        groups.setdefault(name, []).append(char)
    assert sum(map(len, groups.values())) == len(cmap)
    with tempfile.TemporaryDirectory() as temporary:
        ttf = args.ttf or Path(temporary) / 'original.ttf'
        if args.ttf:
            candidate = TTFont(ttf)
            assert candidate.getBestCmap() == cmap
            assert candidate['hmtx'].metrics == original['hmtx'].metrics
        else:
            original.flavor = None
            original.save(ttf)
        with ProcessPoolExecutor(max_workers=4) as pool:
            parts = list(pool.map(build, [(str(ttf), name, chars, selectors) for name, chars in groups.items()]))
    manifest = {'sourceSha256': SOURCE_HASH, 'build': 'FontTools 4.61.1; all layout features; original outlines, advances, Unicode coverage and variation mappings verified',
                'characters': len(cmap), 'totalBytes': sum(p['bytes'] for p in parts), 'parts': parts}
    (DIRECTORY / 'subsets.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    css = '/* Generated by scripts/subset-map-font.py; SIL OFL 1.1. */\n'
    for part in parts:
        css += ('@font-face {\n  font-family: "Textworld Sarasa";\n  font-style: normal;\n  font-weight: 400;\n'
                '  font-display: swap;\n' + f'  src: url("/fonts/{part["file"]}") format("woff2");\n'
                + f'  unicode-range: {part["unicodeRange"]};\n' + '}\n')
    (DIRECTORY / 'sarasa.css').write_text(css)
    index = ROOT / 'public/index.html'
    core = next(part for part in parts if '-core-' in part['file'])
    index.write_text(re.sub(r'/fonts/sarasa-fixed-k-core-[^"/]+\.woff2', '/fonts/' + core['file'], index.read_text()))
    print(json.dumps({'parts': len(parts), 'characters': len(cmap), 'bytes': manifest['totalBytes']}))


if __name__ == '__main__':
    main()
