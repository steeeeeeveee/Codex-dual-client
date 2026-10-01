"""Build white-backed home-screen icons from the unmodified official Codex PNG.

Pillow is a development dependency only. Optionally extract the source from an
official desktop ASAR first; the mobile service never reads desktop resources.
"""
import argparse
import hashlib
import json
from pathlib import Path
import struct

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSET = 'webview/assets/codex-app-ga-logo-3e5209898ca3.png'
DESTINATION = ROOT / 'static/assets/pwa'


def extract_source(archive):
    with archive.open('rb') as stream:
        _, header_size, _, json_size = struct.unpack('<4I', stream.read(16))
        entry = json.loads(stream.read(json_size))
        for part in ASSET.split('/'):
            entry = entry['files'][part]
        if entry.get('unpacked'):
            raise ValueError('Expected a packed official PNG')
        stream.seek(8 + header_size + int(entry['offset']))
        data = stream.read(entry['size'])
        if len(data) != entry['size'] or not data.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Invalid source PNG')
        return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-asar', type=Path)
    args = parser.parse_args()
    DESTINATION.mkdir(parents=True, exist_ok=True)
    source = DESTINATION / 'codex-classic.png'
    if args.source_asar:
        source.write_bytes(extract_source(args.source_asar))
    with Image.open(source) as original:
        mark = original.convert('RGBA')
        # Keep the original gradient and outline, with no baked-in rounded mask.
        for size in (180, 192, 512):
            fitted = mark.copy()
            extent = round(size * .72)
            fitted = fitted.resize(
                (round(mark.width * extent / max(mark.size)),
                 round(mark.height * extent / max(mark.size))),
                Image.Resampling.LANCZOS,
            )
            canvas = Image.new('RGBA', (size, size), 'white')
            canvas.alpha_composite(fitted, ((size - fitted.width) // 2,
                                          (size - fitted.height) // 2))
            canvas.convert('RGB').save(DESTINATION / f'codex-{size}.png', optimize=True)
        print(f'Source: {mark.width}x{mark.height}, SHA-256 {hashlib.sha256(source.read_bytes()).hexdigest()}')
        print('Built opaque PNG icons: 180, 192, 512')


if __name__ == '__main__':
    main()
