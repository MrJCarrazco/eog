"""Mutation proof for check_paid_exit check 11 (pinned referrer-attribution population).

Council distribution 2026-10-09, rules R-D19/R-D20. Each mutation is applied to
index.html bytes ON DISK, the real gate is run as a subprocess, the verdict is
checked, and the file is restored and proven sha256-identical before the next
case. Control must be GATE OPEN; every mutation must CLOSE the gate AND name
check 11. Run under both interpreters:
    py -3.12 _verify_referrer_pin.py
    py -V:Astral/CPython3.14.0 _verify_referrer_pin.py
"""
import hashlib
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
IDX = os.path.join(HERE, 'index.html')
GATE = os.path.join(HERE, 'check_paid_exit.py')


def sha(b):
    return hashlib.sha256(b).hexdigest()


def run_gate():
    p = subprocess.run([sys.executable, GATE], cwd=HERE,
                       capture_output=True, text=True, timeout=120)
    return p.returncode, p.stdout


def main():
    orig = open(IDX, 'rb').read()
    h0 = sha(orig)
    assert orig.count(b'\r') == 0, 'index.html must be LF-only before we start'

    cases = []

    def case(name, mutant, expect_frag):
        cases.append((name, mutant, expect_frag))

    # M1 a 4th itch anchor (old host-prefix rule passed this silently)
    case('M1 fourth itch anchor added',
         orig.replace(b'</body>',
                      b'<a id="link-itch3" href="https://mrjcarrazco.itch.io/empire-of-gods" '
                      b'referrerpolicy="origin" rel="noopener">EXTRA</a></body>'),
         'unpinned itch anchor')
    # M2 rel noreferrer on a pinned anchor (overrides referrerpolicy=origin)
    case('M2 rel noreferrer re-blinds the channel',
         orig.replace(b'<a id="link-rate" class="hud-btn" '
                      b'href="https://mrjcarrazco.itch.io/empire-of-gods/rate" '
                      b'target="_blank" rel="noopener"',
                      b'<a id="link-rate" class="hud-btn" '
                      b'href="https://mrjcarrazco.itch.io/empire-of-gods/rate" '
                      b'target="_blank" rel="noopener noreferrer"'),
         'noreferrer')
    # M3 referrerpolicy removed from a pinned anchor
    case('M3 referrerpolicy attribute removed',
         orig.replace(b'rel="noopener" referrerpolicy="origin" title=',
                      b'rel="noopener" title='),
         'lacks referrerpolicy')
    # M4 referrerpolicy on a non-anchor element
    case('M4 instrumented img widens the posture',
         orig.replace(b'</body>',
                      b'<img src="assets/x.png" referrerpolicy="origin"></body>'),
         'referrerpolicy attribute')
    # M5 pinned href drifts
    case('M5 pinned anchor href drifted',
         orig.replace(b'href="https://mrjcarrazco.itch.io/empire-of-gods/rate"',
                      b'href="https://mrjcarrazco.itch.io/empire-of-gods/devlog"'),
         'href drifted')
    # M6 pinned anchor deleted entirely (id renamed = missing from population)
    case('M6 pinned anchor missing',
         orig.replace(b'id="link-itch2"', b'id="link-itch2x"'),
         'MISSING')

    for name, mutant, _ in cases:
        assert mutant != orig, '%s: mutation did not apply' % name

    failures = 0

    rc, out = run_gate()
    if rc == 0 and 'GATE OPEN' in out:
        print('CONTROL  unmodified tree            GATE OPEN  OK')
    else:
        print('CONTROL  FAILED: gate not open on the real tree\n' + out)
        failures += 1

    for name, mutant, expect_frag in cases:
        open(IDX, 'wb').write(mutant)
        try:
            rc, out = run_gate()
        finally:
            open(IDX, 'wb').write(orig)
        if sha(open(IDX, 'rb').read()) != h0:
            print('%s  RESTORE BROKEN — stop' % name)
            return 2
        line11 = [l for l in out.splitlines() if l.startswith('[11')]
        named = line11 and 'FAIL' in line11[0] and expect_frag in line11[0]
        if rc != 0 and 'GATE CLOSED' in out and named:
            print('%-38s CLOSED, check 11 names it  OK' % name)
        else:
            print('%-38s DID NOT BITE (rc=%s)' % (name, rc))
            print('  check11: %r' % (line11[0] if line11 else '(no line)'))
            failures += 1

    rc, out = run_gate()
    if rc != 0:
        print('FINAL control after restores FAILED')
        failures += 1
    print('restored sha256 identical: %s' % (sha(open(IDX, 'rb').read()) == h0))
    print('%d/%d mutations + control %s on %s' %
          (len(cases) - failures if failures == 0 else len(cases) - failures,
           len(cases), 'OK' if failures == 0 else 'FAILED', sys.version.split()[0]))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
