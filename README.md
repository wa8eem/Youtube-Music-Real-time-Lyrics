YouTube Music Beautifier — README
=================================

[![Install on Greasy Fork](https://img.shields.io/badge/Install-Greasy%20Fork-brightgreen.svg)](https://greasyfork.org/en/scripts/553103-youtube-music-beautifier)

Compact userscript that adds a floating, time-synced lyrics card to YouTube Music (music.youtube.com). Clickable lyric lines seek playback, and the UI includes romanization, per-line translation, per-line sync controls, font/resizing controls, and developer debug helpers. Designed for Tampermonkey and compatible userscript runners.

Quick links
-----------
- Script file: `Youtube_Music_Beautifier.js`
- Compatible site: https://music.youtube.com/*
- Guide for the undocumented Google Translate endpoints: `TRANSLATE_API_GUIDE.md`
- Python examples for testing translate endpoints: `translate_examples.py`

Highlights (new features since initial release)
---------------------------------------------
- Romanization (per-line): automatic transliteration/romanization of non-Latin scripts using the Google Translate undocumented endpoint (dt=rm). Toggleable via the "Aa" button.
- Translation (per-line + Translate All): per-line translation buttons and a "T→all" button to translate the entire lyrics card. Language selector + freeform language-code input provided.
- Persisted translation target: the selected target language is remembered across sessions (stored with `gmSet`) so the UI restores your last choice.
- Per-line sync controls: each line has a sync (⤴) button that sets an in-memory offset so the clicked line appears as the current lyric. Undo (↶) and reset (⤶) are available. Offsets are intentionally kept in-memory (not persisted per-song) unless explicitly changed.
- Duration-aware time normalization: robust parsing for JSON/LRC providers with heuristics to convert millisecond timestamps to seconds when appropriate (based on song duration and median/max heuristics).
- Adaptive seeking: the script reads playback time from multiple sources (media element, player-bar DOM, nowPlaying()) and biases seeking attempts to match the source (media-first vs progress-bar-first) to improve reliability.
- Improved progress-bar seeking: tries shadowRoot search, updates slider properties (`value`, `immediateValue`, `_setValue`, `aria-valuenow`) and simulates pointer events on `elementFromPoint` where necessary.
- Debugging & diagnostics: verbose debug logs, top-level captures (e.g., `window._ytm_last_lyrics_response`, `window._ytm_parsed_times`) and an exposed API `window.ytmBeautifier` for testing and diagnostics.
- GM fallbacks & safer storage handling: localStorage fallbacks for GM_* APIs plus safer parsing on read.

Install
-------
Same installation approaches as before (Greasy Fork preferred for one-click installs):

1) Install via Greasy Fork (recommended)
   - Install from: https://greasyfork.org/en/scripts/553103-youtube-music-beautifier

2) Manual (Tampermonkey / Chromium / Edge)
   - Paste `Youtube_Music_Beautifier.js` into a new script in Tampermonkey and enable it.

3) Manual (Safari or other userscript runners)
   - Use your userscript manager to add the script. Ensure the manager provides the requested GM_* grants or allow localStorage fallbacks.

Permissions
-----------
The script uses the following grants (metadata header):
- `GM_xmlhttpRequest` — recommended for fetching lyrics and translate endpoints from userscripts (avoids CORS in many setups).
- `GM_addStyle`, `GM_getValue`, `GM_setValue` — used for styling and saving small settings.

If your userscript runner does not provide GM_xmlhttpRequest, the script will fall back to `fetch`, which can be blocked by CORS in some browsers. Using Tampermonkey with cross-domain permission avoids most issues.

Usage & Controls
----------------
- Launcher: a floating "Lyrics" launcher button toggles the lyrics card.
- Romanization toggle: "Aa" button toggles per-line romanized text.
- Translate target: select a language from the dropdown or type a freeform language code (press Enter). The chosen language is persisted.
- Translate All: click "T→all" to translate every visible line (cached per-text+target to avoid repeated calls).
- Per-line translate: each line has a translate button (T→xx) that translates that single line on demand.
- Sync controls:
  - ⤴ (per-line): set this line as current (computes offset = currentPlaybackTime - lineTime). This stores previous offset in-memory so you can undo.
  - ↶ (undo): revert to the previous offset (in-memory only).
  - ⤶ (reset): clear the offset for the current song.
- Font & resize: A and arrow buttons increase/decrease font and resize the card; size persists.

Developer & Debugging API
-------------------------
Exposed helper on `window.ytmBeautifier`:

- `show()` / `hide()` — show or hide the card
- `getNowPlaying()` — returns detected track metadata (title, artist, elapsed, total...)
- `getSongLyrics(title, artist, album)` — manually fetch lyrics via the configured `REST_URL`
- `romanize(text, source_language, options)` — call the romanize helper
- `reattachMedia()` — reattach media event listeners (if the page replaced the player)
- `setDebug(boolean)` — toggle verbose debugging logs
- `debugSeek(target)` — diagnostic dump of candidates for seeking (progress slider, video elements, player APIs)
- `testSeek(t)` — exercise a few seek methods programmatically

When debugging, enable logs:

```js
window.ytmBeautifier.setDebug(true);
```

And try reproducing an issue with:

```js
window.ytmBeautifier.debugSeek(60);
window.ytmBeautifier.testSeek(60);
```

Internal behavior notes (for contributors)
-----------------------------------------
- Lyrics parsing: the script tolerantly handles LRC and several JSON shapes. After extracting times it runs `normalizeTimes(times, songDuration)` which uses median/max heuristics to decide if times are in milliseconds and need dividing by 1000.
- Seeking pipeline: `getPlaybackTime()` detects playback time from the media element, player-bar DOM, or `nowPlaying().elapsed`. `simulateSeek(target, preferredSource)` tries seeking methods in an order biased by the preferred source (media-first vs progress-first).
- Progress-bar seeking: `tryProgressSeek` probes DOM and shadow roots, tries to set `value`/`immediateValue`/`_setValue` properties, sets `aria-valuenow`, dispatches `input/change`, and falls back to pointer events via `elementFromPoint`.
- Translation: uses `translate_a/single` undocumented endpoint. See `TRANSLATE_API_GUIDE.md` for details and client examples. For userscript use prefer GM_xmlhttpRequest (gmXhr wrapper) to avoid CORS.

Files added
-----------
- `TRANSLATE_API_GUIDE.md` — short guide on the undocumented Google Translate endpoints used (dt flags, transliteration, parsing tips).
- `translate_examples.py` — runnable Python examples that call the `translate_a/single` endpoint and demonstrate parsing translation/transliteration responses.

Troubleshooting checklist
-------------------------
1. Enable debug logs: `window.ytmBeautifier.setDebug(true)` and reproduce the issue.
2. Run `window.ytmBeautifier.debugSeek(60)` to log candidate progress elements and APIs.
3. Try `window.ytmBeautifier.reattachMedia()` if the player DOM changed.
4. If translate or remote lyrics calls fail due to CORS, ensure your userscript manager allows cross-origin requests or run the translation server-side using `translate_examples.py` as a template.

Privacy & Remote API
--------------------
Lyrics requests contact the configured `REST_URL` (default: `https://ytm.nwvbug.com`). The script sends title/artist/album to look up lyrics. If you prefer to self-host, change the `REST_URL` constant in `Youtube_Music_Beautifier.js` before installing.

Contributing
------------
PRs, issues and logs are welcome. When reporting seeking or timing issues include the output of `window.ytmBeautifier.debugSeek(...)` and browser/extension details.

License
-------
See the `LICENSE` file for license details (MIT or repository license).

Contact
-------
Open an issue in this repository or include console logs and the userscript manager details when reporting problems.

# Youtube-Music-Real-time-Lyrics
Bring Real Time Lyrics on https://music.youtube.com
