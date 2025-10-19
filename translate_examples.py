"""
translate_examples.py

Small runnable examples demonstrating the undocumented Google Translate `translate_a/single` endpoint.
These are intended as quick tests (server-side) to avoid CORS and to show parsing patterns.

Usage:
  python translate_examples.py

Requires: requests
  pip install requests

Note: These endpoints are unofficial and may change or rate-limit.
"""

import requests
import json
import time
from typing import Any, Dict, List, Optional

BASE = 'https://translate.googleapis.com/translate_a/single'


def simple_translate(text: str, target: str = 'en') -> Optional[str]:
    params = {
        'client': 'gtx',
        'sl': 'auto',
        'tl': target,
        'dt': 't',
        'q': text,
    }
    try:
        r = requests.get(BASE, params=params, timeout=10)
        r.raise_for_status()
        j = r.json()
        if isinstance(j, list) and isinstance(j[0], list):
            return ' '.join([seg[0] for seg in j[0] if seg and seg[0]])
        return None
    except Exception as e:
        print('translate error', e)
        print('raw', r.text[:400] if 'r' in locals() else None)
        return None


def transliterate(text: str, target_translit: str = 'ja-Latn') -> Optional[str]:
    # dt=rm for romanization/transliteration
    params = {
        'client': 'gtx',
        'sl': 'auto',
        'tl': target_translit,
        'dt': 'rm',
        'q': text,
    }
    try:
        r = requests.get(BASE, params=params, timeout=10)
        r.raise_for_status()
        # Not guaranteed to be well-structured; collect strings
        j = r.json()
        out = []
        def walk(v: Any):
            if v is None: return
            if isinstance(v, str):
                out.append(v)
                return
            if isinstance(v, list):
                for x in v: walk(x)
            if isinstance(v, dict):
                for x in v.values(): walk(x)
        walk(j)
        # join candidate latin strings
        return ' '.join([s for s in out if any(c.isalpha() for c in s)])
    except Exception as e:
        print('transliterate error', e)
        print('raw', r.text[:400] if 'r' in locals() else None)
        return None


def multiple_dt_example(text: str):
    # request both translation dt=t and transliteration dt=rm (multiple dt params)
    params = [
        ('client', 'gtx'),
        ('sl', 'auto'),
        ('tl', 'en'),
        ('dt', 't'),
        ('dt', 'rm'),
        ('q', text),
    ]
    try:
        r = requests.get(BASE, params=params, timeout=10)
        r.raise_for_status()
        print('status', r.status_code)
        print('raw', r.text[:800])
        j = r.json()
        print('parsed root type:', type(j))
        if isinstance(j, list) and j:
            # translation pieces
            if isinstance(j[0], list):
                txt = ' '.join([seg[0] for seg in j[0] if seg and seg[0]])
                print('translation =>', txt)
            # attempt to locate romanization texts
            def walk_collect(v, out):
                if v is None: return
                if isinstance(v, str):
                    out.append(v)
                    return
                if isinstance(v, list):
                    for x in v: walk_collect(x, out)
                if isinstance(v, dict):
                    for x in v.values(): walk_collect(x, out)
            out = []
            walk_collect(j, out)
            print('collected strings (sample):', out[:20])
    except Exception as e:
        print('multiple dt error', e)


# simple CLI-style tests
if __name__ == '__main__':
    print('translate "こんにちは" to en:')
    print(simple_translate('こんにちは', 'en'))
    time.sleep(0.15)
    print('\ntransliterate "こんにちは" to ja-Latn:')
    print(transliterate('こんにちは', 'ja-Latn'))
    time.sleep(0.15)
    print('\nmultiple dt example for "你好"')
    multiple_dt_example('你好')
