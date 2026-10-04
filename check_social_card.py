"""Gate for the social preview card (og/twitter tags + assets/og.png).

Run: python check_social_card.py  -> prints SOCIAL CARD OK (exit 0) or SOCIAL CARD FAILED: <reason> (exit 1).
Stdlib only (decodes the PNG itself) so it runs on any Python without Pillow.
"""
import os
import struct
import sys
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
OG = os.path.join(ROOT, "assets", "og.png")
HTML = os.path.join(ROOT, "index.html")
MAX_BYTES = 300 * 1024

TAGS = [
    '<meta property="og:type" content="website">',
    '<meta property="og:url" content="https://mrjcarrazco.github.io/eog/">',
    '<meta property="og:title" content="Empire of Gods — free browser demo">',
    '<meta property="og:description" content="Thirteen Greek gods run a scrappy space-station startup. Watch them bicker, judge their calls, survive the night. Plays in your browser, no download.">',
    '<meta property="og:image" content="https://mrjcarrazco.github.io/eog/assets/og.png">',
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:image:alt" content="Pixel-art Greek gods on a space station, with the title Empire of Gods.">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="Empire of Gods — free browser demo">',
    '<meta name="twitter:description" content="Thirteen Greek gods run a scrappy space-station startup. Plays in your browser, no download.">',
    '<meta name="twitter:image" content="https://mrjcarrazco.github.io/eog/assets/og.png">',
]


class Fail(Exception):
    pass


def decode_png(data):
    """Return (width, height, list of (r, g, b) rows) for 8-bit non-interlaced gray/RGB/RGBA/palette PNGs."""
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise Fail("assets/og.png is not a PNG (bad signature)")
    pos, idat, plte, ihdr = 8, b"", None, None
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos:pos + 4])
        ctype, body = data[pos + 4:pos + 8], data[pos + 8:pos + 8 + length]
        if zlib.crc32(ctype + body) != struct.unpack(">I", data[pos + 8 + length:pos + 12 + length])[0]:
            raise Fail("assets/og.png has a corrupt %s chunk" % ctype.decode("latin-1"))
        if ctype == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif ctype == b"PLTE":
            plte = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        pos += 12 + length
    if ihdr is None:
        raise Fail("assets/og.png has no IHDR")
    w, h, depth, color, _, _, interlace = ihdr
    channels = {0: 1, 2: 3, 3: 1, 6: 4}.get(color)
    if depth != 8 or channels is None or interlace:
        raise Fail("assets/og.png uses an unsupported PNG layout (depth=%d color=%d interlace=%d)" % (depth, color, interlace))
    if color == 3 and not plte:
        raise Fail("assets/og.png is palette-based but has no PLTE")
    raw = zlib.decompress(idat)
    stride = w * channels
    prev = bytearray(stride)
    rows = []
    for y in range(h):
        off = y * (stride + 1)
        ftype, line = raw[off], bytearray(raw[off + 1:off + 1 + stride])
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if ftype == 1:
                line[i] = (line[i] + a) & 255
            elif ftype == 2:
                line[i] = (line[i] + b) & 255
            elif ftype == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
            elif ftype != 0:
                raise Fail("assets/og.png has an invalid filter byte")
        prev = line
        if color == 3:
            rows.append([plte[v] for v in line])
        elif color == 0:
            rows.append([(v, v, v) for v in line])
        else:
            rows.append([tuple(line[i:i + 3]) for i in range(0, stride, channels)])
    return w, h, rows


def check():
    if not os.path.isfile(OG):
        raise Fail("assets/og.png does not exist")
    size = os.path.getsize(OG)
    if size >= MAX_BYTES:
        raise Fail("assets/og.png is %d bytes (limit < %d)" % (size, MAX_BYTES))
    with open(OG, "rb") as f:
        try:
            w, h, rows = decode_png(f.read())
        except Fail:
            raise
        except Exception as e:
            # A truncated/corrupt PNG must report a named failure, not a traceback.
            raise Fail("assets/og.png is not a readable PNG (%s: %s)"
                       % (type(e).__name__, e))
    if (w, h) != (1200, 630):
        raise Fail("assets/og.png is %dx%d, expected 1200x630" % (w, h))
    pixels = [p for row in rows for p in row]
    uniq = len(set(pixels))
    if uniq <= 500:
        raise Fail("assets/og.png looks near-blank: only %d unique RGB values (need > 500)" % uniq)
    lum = [0.299 * r + 0.587 * g + 0.114 * b for r, g, b in pixels]
    mean = sum(lum) / len(lum)
    std = (sum((v - mean) ** 2 for v in lum) / len(lum)) ** 0.5
    if std <= 15:
        raise Fail("assets/og.png looks near-blank: luminance stddev %.1f (need > 15)" % std)

    with open(HTML, "rb") as f:
        raw = f.read()
    if raw.count(b"\r"):
        raise Fail("index.html contains %d CR bytes (must be LF-only)" % raw.count(b"\r"))
    html = raw.decode("utf-8")
    lines = set(l.strip() for l in html.split("\n"))
    for tag in TAGS:
        if tag not in lines:
            raise Fail("index.html is missing tag line: %s" % tag)
    n = html.count('property="og:image"')
    if n != 1:
        raise Fail('index.html has %d property="og:image" tags (expected exactly 1)' % n)
    if "connect-src 'none'" not in html:
        raise Fail("index.html lost its CSP connect-src 'none'")
    if 'name="referrer" content="no-referrer"' not in html:
        raise Fail('index.html lost name="referrer" content="no-referrer"')
    if "ingest/starnet" in html.replace("\\", "/"):
        raise Fail("index.html references ingest/starnet (non-MIT upstream art)")
    return size, uniq, std


def main():
    try:
        size, uniq, std = check()
    except Fail as e:
        print("SOCIAL CARD FAILED: %s" % e)
        return 1
    print("og.png: 1200x630, %d bytes, %d unique RGB, luminance stddev %.1f" % (size, uniq, std))
    print("index.html: 12/12 tags, 1 og:image, CR=0, CSP + no-referrer intact, no ingest/starnet")
    print("SOCIAL CARD OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
