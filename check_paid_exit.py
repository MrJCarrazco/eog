#!/usr/bin/env python3
"""Gate: the demo's post-play modal (#upsell) and HUD must carry a paid exit.

Run from the repo root:  python check_paid_exit.py
Exit 0 = GATE OPEN, exit 1 = GATE CLOSED (each failure is named).
Standard library only. All checks read files as bytes.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PAID = b'https://mrjcarrazco.gumroad.com/l/rqaxx'
DEAD_ID = b'link-' + b'play'
RETIRED_CLAIM = b'Full version' + b' is'
RATE = b'https://mrjcarrazco.itch.io/empire-of-gods/rate'
BANNED_REF = b'ingest' + b'/starnet'
SKIP_DIRS = {'.git', '.claude'}
# Gate scripts hold the banned path only as a search needle, not as a dependency.
SKIP_FILES = {'check_social_card.py', 'check_paid_exit.py'}

ANCHOR_RE = re.compile(rb'<a\b[^>]*>', re.I)


def read(rel):
    with open(os.path.join(ROOT, rel), 'rb') as f:
        return f.read()


def attr(tag, name):
    m = re.search(rb'\b' + name + rb'\s*=\s*"([^"]*)"', tag)
    return m.group(1) if m else None


def anchors(block):
    return ANCHOR_RE.findall(block)


def paid(tag):
    href = attr(tag, b'href')
    return href is not None and href.startswith(PAID)


def upsell_block(html):
    start = html.find(b'id="upsell"')
    end = html.find(b'id="toast"', start)
    if start < 0 or end < 0:
        return None
    return html[start:end]


def hud_block(html):
    start = html.find(b'class="hud-actions"')
    end = html.find(b'</header>', start)
    if start < 0 or end < 0:
        return None
    return html[start:end]


def check_paid_anchors(html, js):
    total = sum(1 for a in anchors(html) if paid(a))
    up, hud = upsell_block(html), hud_block(html)
    missing = []
    if up is None or not any(paid(a) for a in anchors(up)):
        missing.append('#upsell modal')
    if hud is None or not any(paid(a) for a in anchors(hud)):
        missing.append('HUD (.hud-actions)')
    if missing or total < 2:
        return 'paid gumroad anchor missing from: %s (found %d total, need >=2)' % (
            ', '.join(missing) or 'n/a', total)


def check_accent_slot(html, js):
    up = upsell_block(html)
    if up is None:
        return '#upsell block not found'
    accents = [a for a in anchors(up) if attr(a, b'class') == b'hud-btn accent']
    if not accents:
        return 'no class="hud-btn accent" anchor inside #upsell'
    bad = [a for a in accents if not paid(a)]
    if bad:
        return '#upsell primary (accent) button is not the paid exit: href=%r' % (
            attr(bad[0], b'href'),)


def check_no_dead_link(html, js):
    why = []
    if any(attr(a, b'id') == DEAD_ID for a in anchors(html)):
        why.append('index.html has an anchor id="%s"' % DEAD_ID.decode())
    if DEAD_ID in js:
        why.append('js/demo.js references %s' % DEAD_ID.decode())
    if why:
        return 'dead self-link is back: ' + '; '.join(why)


def check_orphan_handles(html, js):
    ids = sorted(set(re.findall(rb"getElementById\(\s*['\"](link-[^'\"]+)['\"]\s*\)", js)))
    orphans = [i.decode() for i in ids if (b'id="' + i + b'"') not in html]
    if orphans:
        return 'js/demo.js getElementById handle(s) with no element in index.html: ' + ', '.join(orphans)


def check_retired_claim(html, js):
    if RETIRED_CLAIM in html:
        return 'index.html still contains the retired claim "%s"' % RETIRED_CLAIM.decode()


def meta_content(html, key, value):
    for tag in re.findall(rb'<meta\b[^>]*>', html, re.I):
        if (attr(tag, key) or b'').lower() == value.lower():
            return attr(tag, b'content')


def check_csp(html, js):
    why = []
    csp = meta_content(html, b'http-equiv', b'Content-Security-Policy')
    if csp is None or b"connect-src 'none'" not in csp:
        why.append("CSP meta content lacks connect-src 'none' (got %r)" % (csp,))
    ref = meta_content(html, b'name', b'referrer')
    if ref != b'no-referrer':
        why.append('referrer meta content is not "no-referrer" (got %r)' % (ref,))
    if why:
        return '; '.join(why)


def check_crlf(html, js):
    why = ['%s has %d CR byte(s)' % (n, b.count(b'\r'))
           for n, b in (('index.html', html), ('js/demo.js', js)) if b.count(b'\r')]
    if why:
        return '; '.join(why)


def check_banned_ref(html, js):
    hits = []
    for d, dirs, files in os.walk(ROOT):
        dirs[:] = [x for x in dirs if x not in SKIP_DIRS]
        for f in files:
            p = os.path.join(d, f)
            if d == ROOT and f in SKIP_FILES:
                continue
            try:
                with open(p, 'rb') as fh:
                    if BANNED_REF in fh.read().replace(b'\\', b'/'):
                        hits.append(os.path.relpath(p, ROOT))
            except OSError:
                pass
    if hits:
        return 'file(s) reference %s: %s' % (BANNED_REF.decode(), ', '.join(hits))


def check_engagement_exit(html, js):
    """The post-play modal must also ASK for the free engagement signals.

    itch's own browse ranking (new-and-popular, already a live referrer for this
    listing) is fed by ratings/collections/comments. The listing had 0 of all three
    after 10 plays because nothing in the game ever asked. This check keeps the ask
    present; it does NOT replace or weaken the paid exit (checks 1 and 2).
    """
    up = upsell_block(html)
    if up is None:
        return '#upsell block not found'
    if not any((attr(a, b'href') or b'') == RATE for a in anchors(up)):
        return 'no itch rating anchor (href=%s) inside #upsell' % RATE.decode()


def strip_js_comments(js):
    """Executable lines only: a rule must never be satisfied by a comment ABOUT it."""
    js = re.sub(rb'/\*.*?\*/', b'', js, flags=re.S)
    return re.sub(rb'(?m)^\s*//.*$', b'', js)


def check_sprite_sensor_honest(html, js):
    """perf.allMs/first6Ms must mean 'every atlas arrived', not 'the promise settled'.

    load() used to swallow a failed atlas (ensureSkin resolving false still resolved),
    so a run where sheets 404'd was indistinguishable from a clean run.
    """
    code = strip_js_comments(js)
    why = []
    if b'perf.failed++' not in code:
        why.append('sprite load() does not count a failed atlas (no perf.failed++)')
    for field in (b'allMs', b'first6Ms'):
        if not re.search(rb'if \(!perf\.failed\)\s*perf\.' + field + rb'\s*=', code):
            why.append('perf.%s assignment is not guarded by !perf.failed' % field.decode())
    for m in re.finditer(rb'perf\.(?:allMs|first6Ms)\s*=', code):
        line = code[code.rfind(bytes([10]), 0, m.start()) + 1:m.start()]
        if b'if (!perf.failed)' not in line:
            why.append('unguarded completion stamp: %r' % line.strip()[:60])
    if b'failedSheets' not in code:
        why.append('perf() does not report failedSheets to its reader')
    if why:
        return '; '.join(why)


# (name, check, live) - live checks see index.html with <!-- comments --> removed,
# so a commented-out tag or a comment naming a directive can neither pass nor fail them.
CHECKS = [
    ('1 paid anchors in #upsell and HUD', check_paid_anchors, True),
    ('2 #upsell accent slot is paid', check_accent_slot, True),
    ('3 no dead self-link', check_no_dead_link, False),
    ('4 no orphaned link- handles', check_orphan_handles, True),
    ('5 retired free-claim gone', check_retired_claim, False),
    ('6 CSP + no-referrer intact', check_csp, True),
    ('7 LF-only line endings', check_crlf, False),
    ('8 no banned ingest reference', check_banned_ref, False),
    ('9 itch engagement exit in #upsell', check_engagement_exit, True),
    ('10 sprite sensor cannot fake completion', check_sprite_sensor_honest, False),
]


def main():
    html, js = read('index.html'), read(os.path.join('js', 'demo.js'))
    live = re.sub(rb'<!--.*?-->', b'', html, flags=re.S)
    failed = 0
    for name, fn, use_live in CHECKS:
        why = fn(live if use_live else html, js)
        if why:
            failed += 1
            print('[%s] FAIL: %s' % (name, why))
        else:
            print('[%s] OK' % name)
    print('GATE CLOSED' if failed else 'GATE OPEN')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
