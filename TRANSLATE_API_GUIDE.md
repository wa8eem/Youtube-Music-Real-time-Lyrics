Google Translate undocumented endpoints — quick reference

This repository uses the undocumented Google Translate web endpoints for lightweight transliteration and translation. They are not part of an official public API and may change, rate-limit, or be subject to CORS restrictions. The examples below are intended for debugging, small experiments, or client-side userscripts (where the browser's origin and extension permissions affect behavior).

WARNING
- These endpoints are unofficial and have no stability guarantees.
- Frequent automated calls may be rate-limited or blocked. Use caching.
- Respect terms of service and legal constraints.

Endpoints used

1) translate_a/single

Purpose: primary translation endpoint used by the browser UI and widely used in lightweight scripts. It can return a compact delta-coded translation result and supports multiple dt (data type) flags to include different pieces of information.

Base URL
- https://translate.googleapis.com/translate_a/single
- (sometimes used via `https://translate.google.com/translate_a/single` — the `translate.googleapis.com` host is typically used for simple fetches)

Common query parameters
- client: client identifier, commonly `gtx` for simple browser clients
- sl: source language (e.g. `auto` to detect)
- tl: target language (e.g. `en` or `es` or `ja`) **or** a transliteration target such as `zh-CN-Latn` or `ja-Latn` in some contexts
- dt: one or more data flags; can appear multiple times
  - dt=t — translation (text segments)
  - dt=rm — transliteration / romanization output (in some responses)
  - dt=at — alternative translations and additional metadata
  - dt=bd — dictionary/definitions (when available)
  - dt=ex — examples
  - dt=md — metadata
  - dt=ss — synonyms
- q: the query text (URL-encoded). For large/payload containing many lines, it is acceptable to send more than one q parameter, but watch URL length limits.

Minimal working examples

- Transliteration (request transliteration / romanization):
  Example URL format used in this repository's romanize helper:

  https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja-Latn&dt=rm&q=こんにちは

  Explanation: request romanization (dt=rm) and tell the server to transliterate into Latin for Japanese (tl=ja-Latn). When `sl=auto`, the server detects source language.

- Translation to English (full translation result):
  Example URL format used in this repository's translate helper:

  https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF

  Explanation: `dt=t` requests the translation segments; the response is usually an array of arrays describing sentence fragments and translations.

Response shapes (typical)
- A translation response is normally a JSON array. A common compact shape is:
  [
    [ ["translated segment","original segment", null, null, ...], ... ],
    null, // source language hint
    "auto"
  ]

- `dt=rm` transliteration output may appear nested in the response or as separate elements; it's not formally documented. You often need to recursively walk arrays and extract Latin-like substrings.

Parsing recommendations
- Because response formats vary and include nested arrays, write resilient parsers:
  - JSON.parse the response
  - recursively walk arrays/objects and collect string leaf nodes
  - prefer segments in the first array (j[0]) when dt=t is used: j[0].map(seg => seg[0]).join(' ')
  - for transliteration (dt=rm), search the parsed tree for Latin-like strings, filter short artifacts (language tags), and join tokens

Limitations / CORS / headers
- When called from a userscript, you may need GM_xmlhttpRequest (Tampermonkey/Greasemonkey) to avoid CORS issues. The script in this repo uses gmXhr which falls back to fetch when GM_xmlhttpRequest is unavailable.
- Responses may be blocked by origin/CORS when called from plain fetch in browser contexts depending on host and referer. Use the GM XHR or server-side proxy for best reliability.
- Rate limiting and 4xx/5xx responses can occur. Cache results where possible.

Small test snippets

JavaScript (browser/userscript)

- Simple translation to English (using fetch). Note CORS may block this in normal pages.

const q = encodeURIComponent('こんにちは');
const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${q}`;
fetch(url)
  .then(r => r.text())
  .then(t => {
    try {
      const j = JSON.parse(t);
      const text = Array.isArray(j) && Array.isArray(j[0]) ? j[0].map(seg => seg[0]).filter(Boolean).join(' ') : null;
      console.log('translation', text);
    } catch (e) {
      console.log('raw', t);
    }
  })
  .catch(console.error);

- Transliteration/romanization (dt=rm). May return nested arrays; example parser approach:

const q = encodeURIComponent('こんにちは');
const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ja-Latn&dt=rm&q=${q}`;
fetch(url)
  .then(r => r.text())
  .then(t => {
    try {
      const j = JSON.parse(t);
      // recursively collect latin-like strings
      const out = [];
      const walker = (v) => {
        if (!v && v !== 0) return;
        if (typeof v === 'string') {
          if (/^[A-Za-z0-9\s'’ː\-]+$/.test(v)) out.push(v);
          return;
        }
        if (Array.isArray(v)) return v.forEach(walker);
        if (typeof v === 'object') return Object.values(v).forEach(walker);
      };
      walker(j);
      console.log('romanized', out.join(' '));
    } catch (e) { console.log('raw', t); }
  })
  .catch(console.error);

Python (requests)

- Use server-side requests to avoid CORS and rate limiting issues from the browser; good for testing.

import requests
import json

q = 'こんにちは'
url = 'https://translate.googleapis.com/translate_a/single'
params = {
    'client': 'gtx',
    'sl': 'auto',
    'tl': 'en',
    'dt': 't',
    'q': q,
}
resp = requests.get(url, params=params, timeout=10)
print('status', resp.status_code)
try:
    j = resp.json()
    if isinstance(j, list) and isinstance(j[0], list):
        txt = ' '.join([seg[0] for seg in j[0] if seg and seg[0]])
        print('translation:', txt)
    else:
        print('unexpected shape', j)
except Exception as e:
    print('raw', resp.text[:400])

- Transliteration example (python):

params['tl'] = 'ja-Latn'
params['dt'] = 'rm'
resp = requests.get(url, params=params, timeout=10)
print(resp.status_code)
print(resp.text)
try:
    j = resp.json()
    # naive gather
    def walk(v, out):
        if v is None: return
        if isinstance(v, str):
            out.append(v)
            return
        if isinstance(v, list):
            for x in v: walk(x, out)
        if isinstance(v, dict):
            for x in v.values(): walk(x, out)
    out = []
    walk(j, out)
    print('collected', ' | '.join([s for s in out if any(c.isalpha() for c in s)]))
except Exception as e:
    print('raw', resp.text[:400])

Practical tips
- Cache results keyed by (target-lang + text) to avoid re-calling for the same line.
- Use a short delay between batched calls (100–300ms) to reduce the chance of temporary rate-limiting.
- When used in userscripts, prefer GM_xmlhttpRequest to bypass CORS; otherwise, proxy via your server.
- Translate large payloads server-side and return a compact JSON to the client for large-scale translation.

Legal / ethical note
- These endpoints are undocumented and intended for internal use at Google. Respect copyright on text you send to external services and the terms of service of Google. Use this guide for experimental or personal tooling only.

---
Generated by the repo maintainer's tooling and updated with examples for JS and Python.
