#!/usr/bin/env python3
"""Gate: the bytes serving at https://mrjcarrazco.github.io/eog/ are the committed bytes.

Run from anywhere:  python check_live.py
Exit 0 = LIVE OK, exit 1 = LIVE FAILED: <named reason>.
Standard library only. A network error, timeout or unreadable response is a FAILURE.

- live index.html must be byte-identical (sha256) to `git show HEAD:index.html`
- live assets/og.png must be HTTP 200, content-type image/png, and the same length
  (and sha256) as `git show HEAD:assets/og.png`

POST-DEPLOY ONLY. GitHub Pages lags a push by a minute or two (plus CDN caching), so
this gate is not in hooks/pre-push; gates.yml runs it after a push to main, with retries.
A ?v=<HEAD sha> query is added to each fetch so a stale CDN copy is not compared.
"""
import hashlib
import os
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = 'https://mrjcarrazco.github.io/eog/'
TIMEOUT = 20


class Fail(Exception):
    pass


def git(*args):
    try:
        r = subprocess.run(['git', '-C', ROOT] + list(args), capture_output=True, timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        raise Fail('cannot run git %s (%s)' % (' '.join(args), e))
    if r.returncode != 0:
        raise Fail('git %s exited %d: %s' % (' '.join(args), r.returncode,
                                             r.stderr.decode('utf-8', 'replace').strip()))
    return r.stdout


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'eog-check-live/1',
                                               'Cache-Control': 'no-cache'})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, resp.headers.get('Content-Type', ''), resp.read()
    except urllib.error.HTTPError as e:
        raise Fail('%s returned HTTP %d' % (url, e.code))
    except urllib.error.URLError as e:
        raise Fail('%s unreachable (%s)' % (url, e.reason))
    except TimeoutError:
        raise Fail('%s timed out after %ds' % (url, TIMEOUT))
    except Exception as e:  # IncompleteRead, RemoteDisconnected, ssl errors, ...
        raise Fail('%s unreadable (%s: %s)' % (url, type(e).__name__, e))


def sha(b):
    return hashlib.sha256(b).hexdigest()


def check():
    head = git('rev-parse', 'HEAD').decode().strip()
    want_html = git('show', 'HEAD:index.html')
    want_og = git('show', 'HEAD:assets/og.png')
    q = '?v=' + head[:12]

    status, _, live_html = fetch(BASE + q)
    print('index.html  HEAD %s  %d bytes  sha256 %s' % (head[:12], len(want_html), sha(want_html)))
    print('index.html  LIVE %s  %d bytes  sha256 %s' % (' ' * 12, len(live_html), sha(live_html)))
    if status != 200:
        raise Fail('%s returned HTTP %d' % (BASE, status))
    if sha(live_html) != sha(want_html):
        raise Fail('live index.html differs from HEAD:index.html (%d vs %d bytes)'
                   % (len(live_html), len(want_html)))

    url = BASE + 'assets/og.png'
    status, ctype, live_og = fetch(url + q)
    print('og.png      HEAD %d bytes  sha256 %s' % (len(want_og), sha(want_og)))
    print('og.png      LIVE %d bytes  sha256 %s  HTTP %d  %s' % (len(live_og), sha(live_og), status, ctype))
    if status != 200:
        raise Fail('%s returned HTTP %d' % (url, status))
    if ctype.split(';')[0].strip().lower() != 'image/png':
        raise Fail('%s content-type is %r, expected image/png' % (url, ctype))
    if not live_og:
        raise Fail('%s returned 0 bytes' % url)
    if len(live_og) != len(want_og):
        raise Fail('live og.png is %d bytes, HEAD is %d' % (len(live_og), len(want_og)))
    if sha(live_og) != sha(want_og):
        raise Fail('live og.png differs from HEAD:assets/og.png (same length, different sha256)')


def main():
    try:
        check()
    except Fail as e:
        print('LIVE FAILED: %s' % e)
        return 1
    except Exception as e:  # never a traceback: an unexpected error is a named failure
        print('LIVE FAILED: unexpected %s: %s' % (type(e).__name__, e))
        return 1
    print('LIVE OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
