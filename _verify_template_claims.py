#!/usr/bin/env python3
"""Offline mutation proof; no reports, serving, network, or production writes."""
import sys
sys.dont_write_bytecode = True
import ast
import base64
import hashlib
import re
import zlib
from pathlib import Path
import check_paid_exit as gate

ORIGINAL = zlib.decompress(base64.b64decode('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'))
OLD_FUNCTION_HASHES = {'read': '623685ec04108426d743178e0cf2e63445667e6ecd96d30b68ff8fd68eb8a973', 'attr': 'e8607a9ee4477a8a5802753b33797650577703524a9b9bbbbbd184d8d10d48dd', 'anchors': '3c79e6bef90de76ed18577cabd5563b73903a5cbe50259cdc8c7a57926fa0d60', 'paid': '7c1fbf8ad04889cd46daa0b63694fa117465c54639a99d9b8676fdd8aaeaf7fb', 'upsell_block': '26324a0803a847f8aac821f4fa5413f453ff4eaf2e681044b101c283992390f0', 'hud_block': '21076ccaea755ac2a11e48e6f5dd37d6e3fe1f655574b6b4acde7ac86a522eef', 'check_paid_anchors': '66f0f285dbfdb1ce1cef205d58e34e978bd8d4ae926dc7bf5f132aa9978a72f7', 'check_accent_slot': '3814fe76a286fedc89223226236bb6e4571b4bac1eaad87a12b5399209b2afa5', 'check_no_dead_link': '6f3fae2c0b0e7bc089eda0897d8ea31709b813abb63071f7e88a9ef2b6eec20e', 'check_orphan_handles': 'a1c2a1632fe009170d48f6e5141450d04b56a0e9ebffaaffd3ce96d32809e3c8', 'check_retired_claim': '391dad3132598c2b02c4f03e329a2b12305981b1c3bc24d56c0d88a2beb2d495', 'meta_content': '30767221bd41a15885c3c0efb41d173a4f14a3e9f864ef45470fd1ad7eefb323', 'check_csp': 'f50cd106780a55efb693dc72bcd026d5639321f84291950920f3665e298b8e2c', 'check_crlf': '28910f54fa61704c18b85ec88678e64c580164c27a9fa5a60ee713ce68341aa0', 'check_banned_ref': '0f693208829a83d45ed3e2dc101efd8d1fce5a08f033ae71a44e62cec978470e', 'check_engagement_exit': '10c08222262bf32dd86a121b7ae409574fce0b7c67097526c16f206f011adaa4', 'check_itch_referrer_attribution': '3b589344eb665a0c5510742d010733c5e704c4492eb31f63af9189e0c0c0fcf8', 'strip_js_comments': '1ab333a81f34254a439e7198377150c37f506318c6ae484e05dce031a69d158d', 'check_sprite_sensor_honest': '77cab1509a7f2328af1ac1ca3437632f980aa05a6c24318989af5c903119e4d9', 'main': 'e6d8461a9cebcd010a5445094a83717e9b23f2482c5b51b5e06193ed4a1d9329'}

OLD_GATE = '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'


def main():
    root = Path(__file__).resolve().parent
    current = (root / 'index.html').read_bytes()
    js = (root / 'js/demo.js').read_bytes()
    source = (root / 'check_paid_exit.py').read_text(encoding='utf-8')
    functions = {n.name: ast.get_source_segment(source, n)
                 for n in ast.parse(source).body if isinstance(n, ast.FunctionDef)}
    for name, digest in OLD_FUNCTION_HASHES.items():
        assert hashlib.sha256(functions[name].encode()).hexdigest() == digest, name
    assert len(gate.CHECKS) == 12
    baseline = ast.parse(zlib.decompress(base64.b64decode(OLD_GATE)).decode())
    revised = ast.parse(source)
    def rows(tree):
        return next(n.value.elts for n in tree.body if isinstance(n, ast.Assign)
                    and any(isinstance(t, ast.Name) and t.id == 'CHECKS' for t in n.targets))
    assert [ast.dump(n) for n in rows(baseline)] == [ast.dump(n) for n in rows(revised)[:11]]
    for label, html in [('original', ORIGINAL), ('new', current)]:
        live = re.sub(rb'<!--.*?-->', b'', html, flags=re.S)
        for name, fn, use_live in gate.CHECKS[:11]:
            assert fn(live if use_live else html, js) is None, (label, name)
        print(label + ': all 11 original checks PASS')
    assert gate.check_template_claims(ORIGINAL, js)
    assert gate.check_template_claims(current, js) is None
    print('check 12: actual captured original FAIL; corrected source PASS')
    # Actual protected elements are located by their existing source structure.
    patterns = [rb'(<button id="btn-full"[^>]*>)(.*?)(</button>)',
                rb'(<div id="upsell-title"[^>]*>)(.*?)(</div>)',
                rb'(<p>)(This demo runs.*?)(</p>)',
                rb'(<p class="upsell-free">)(.*?)(</p>)']
    mutations = 0
    def reject(html):
        nonlocal mutations
        assert gate.check_template_claims(html, js), 'mutation escaped'
        mutations += 1
    phrases = [b'GET THE FULL GAME', b"YOU'RE WATCHING THE DEMO",
               b'Bring your own API key to make the crew actually think',
               b"they'll take on your real tasks, argue about them, and ship.",
               b'The full version wires the crew up to a real LLM via your own API key']
    for pattern in patterns:
        m = re.search(pattern, current, re.S)
        assert m, pattern
        def replace(body, start=None):
            return current[:m.start()] + (start or m[1]) + body + m[3] + current[m.end():]
        for phrase in phrases:
            reject(replace(phrase))
        reject(replace(b''))
        reject(current[:m.start()] + current[m.end():])
        reject(current[:m.end()] + m[0] + current[m.end():])
        reject(replace(b'<!--' + m[2] + b'-->'))
        reject(replace(b'<span hidden>' + m[2] + b'</span>'))
        reject(replace(m[2], m[1][:-1] + b' hidden>'))
        reject(replace(m[2], m[1][:-1] + b' style="display:none">'))
        reject(replace(m[2], m[1][:-1] + b' aria-hidden="true">'))
        reject(replace(b'<template>' + m[2] + b'</template>'))
        reject(replace(b'<span class="hidden">' + m[2] + b'</span>'))
        reject(replace(m[2], m[1].replace(b'<button', b'<a').replace(b'<div', b'<span').replace(b'<p', b'<div')))
        assert gate.check_template_claims(replace(b'<span>' + m[2] + b'</span>'), js) is None
        # Encode already-decoded text so ampersands retain their visible meaning.
        from html import unescape
        encoded = ''.join('&#%d;' % ord(c) for c in unescape(re.sub(rb'<[^>]+>', b'', m[2]).decode())).encode()
        assert gate.check_template_claims(replace(encoded), js) is None
    modal = re.search(rb'<div id="upsell"[^>]*>', current)[0]
    reject(current.replace(modal, b'<!--' + modal + b'-->'))
    reject(current.replace(modal, b''))
    reject(current.replace(modal, modal + modal))
    reject(current.replace(b'type="button">ABOUT', b'type="submit">ABOUT'))
    reject(current.replace(b'class="upsell" hidden', b'class="upsell" hidden style="display:none"'))
    reject(current.replace(b'<div id="upsell-title"', b'<div hidden><div id="upsell-title"'))
    # README is a separate source documentation assertion, never a gate input.
    readme = (root / 'README.md').read_text(encoding='utf-8')
    assert 'The free game here is scripted' in readme
    assert 'no API key or LLM\nintegration is included' in readme
    assert 'https://mrjcarrazco.gumroad.com/l/rqaxx' in readme
    assert 'The full version wires' not in readme
    for name in ('index.html', 'README.md', 'check_paid_exit.py', '_verify_template_claims.py'):
        assert b'\r' not in (root / name).read_bytes(), name
    # Copy-only HTML edits preserve every original tag, attribute, and order.
    assert re.findall(rb'<[^>]+>', ORIGINAL) == re.findall(rb'<[^>]+>', current)
    print('%d negative mutations rejected; 8 encoding/formatting positives PASS' % mutations)
    print('Original function sources + CHECKS rows unchanged; README + LF + DOM preservation PASS')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
