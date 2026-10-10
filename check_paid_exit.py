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
ITCH_ORIGIN = b'https://mrjcarrazco.itch.io/'
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
    rate_tags = [a for a in anchors(up) if (attr(a, b'href') or b'') == RATE]
    if not rate_tags:
        return 'no itch rating anchor (href=%s) inside #upsell' % RATE.decode()
    # Pin the ask's TEXT (council eog 2026-10-09): the label lives just after the
    # anchor tag; assert it verbatim so a reworded/emptied ask is a failure.
    if b'RATE IT ON ITCH' not in up:
        return 'rating ask label "RATE IT ON ITCH" missing from #upsell'
    # Pin the itch-surface promotion (council eog 2026-10-09): on *.itch.io/.zone
    # the rating ask is moved AHEAD of the $19 exit at runtime. Deleting or
    # defanging that mechanism must close the gate. Static order (paid first on
    # Pages) is deliberate and stays as-is.
    if b'promoteRatingOnItch' not in js:
        return 'promoteRatingOnItch() missing from demo.js (itch-surface rating promotion deleted)'
    if br'/(^|\.)itch\.(io|zone)$/' not in js:
        return 'itch-surface host guard missing/altered in promoteRatingOnItch'
    if b"insertBefore(rate, buy)" not in js:
        return 'promotion no longer reorders rate ahead of buy (insertBefore gone)'


def check_itch_referrer_attribution(html, js):
    """Exactly the 3 pinned itch anchors carry referrerpolicy="origin"; nothing else may.

    R-EOG3's page-wide no-referrer (check 6) means a click from this demo used to
    reach itch with NO Referer, so itch's referrer table could never attribute the
    demo and every T0/T+1 referrer analysis only saw traffic itch itself records.
    Council eog-game 2026-10-05 deferred-then-approved the narrow fix: ONLY
    mrjcarrazco.itch.io anchors may carry a per-element override, and "origin"
    sends just https://mrjcarrazco.github.io/ (no path). A referrerpolicy on any
    other anchor is a posture widening and closes the gate.

    Tightened by council distribution 2026-10-09 (R-D19/R-D20): the attributed
    population is PINNED by id+href+count (a 4th itch anchor used to pass the old
    host-prefix rule silently), each pinned anchor's rel must not contain
    "noreferrer" (that token overrides referrerpolicy=origin in the browser and
    would re-blind the channel while every gate stayed green), and referrerpolicy
    on ANY element -- not just anchors -- is counted, so an instrumented img or
    iframe cannot widen the posture unseen.
    """
    pinned = {
        b'link-itch': b'https://mrjcarrazco.itch.io/empire-of-gods',
        b'link-rate': b'https://mrjcarrazco.itch.io/empire-of-gods/rate',
        b'link-itch2': b'https://mrjcarrazco.itch.io/empire-of-gods',
    }
    why = []
    seen = {}
    for a in anchors(html):
        aid = attr(a, b'id') or b''
        href = attr(a, b'href') or b''
        pol = attr(a, b'referrerpolicy')
        rel = attr(a, b'rel') or b''
        if aid in pinned:
            seen[aid] = True
            if href != pinned[aid]:
                why.append('pinned anchor %r href drifted to %r' % (aid, href))
            if pol != b'origin':
                why.append('pinned anchor %r lacks referrerpolicy="origin" (got %r)'
                           % (aid, pol))
            if b'noreferrer' in rel:
                why.append('pinned anchor %r rel contains "noreferrer" which '
                           'overrides referrerpolicy=origin (got rel=%r)' % (aid, rel))
        elif href.startswith(ITCH_ORIGIN):
            why.append('unpinned itch anchor %r (href=%r): the attributed '
                       'population is pinned to %d anchors' % (aid, href, len(pinned)))
        elif pol is not None:
            why.append('non-itch anchor %r carries referrerpolicy=%r (only '
                       'the pinned itch anchors may)' % (aid, pol))
    for aid in pinned:
        if aid not in seen:
            why.append('pinned itch anchor %r is MISSING' % (aid,))
    n_pol = len(re.findall(rb'referrerpolicy\s*=', html))
    if n_pol != len(pinned):
        why.append('document carries %d referrerpolicy attribute(s), pinned '
                   'population is %d (non-anchor elements count too)'
                   % (n_pol, len(pinned)))
    if why:
        return '; '.join(why)


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
    ('11 itch referrer attribution pinned', check_itch_referrer_attribution, True),
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
