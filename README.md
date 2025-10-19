YouTube Music Beautifier — README
=================================

[![Install on Greasy Fork](https://img.shields.io/badge/Install-Greasy%20Fork-brightgreen.svg)](https://greasyfork.org/en/scripts/553103-youtube-music-beautifier)

A userscript that adds a compact, floating time-synced lyrics card to YouTube Music (music.youtube.com), with clickable lyrics that seek playback. Designed for Tampermonkey (Chrome/Chromium) and userscript runners on Safari (Tampermonkey or Userscripts-compatible apps).

Quick links
-----------
- Script file: `Youtube_Music_Beautifier.js`
- Compatible site: https://music.youtube.com/*
 - Greasy Fork: https://greasyfork.org/en/scripts/553103-youtube-music-beautifier

Install via Greasy Fork
-----------------------
If you prefer a one-click install, users can install the script from Greasy Fork:

https://greasyfork.org/en/scripts/553103-youtube-music-beautifier

When you publish on Greasy Fork, Greasy Fork will display an install button that users can click to add the script to Tampermonkey or other userscript managers.

What it does
------------
- Fetches time-synced lyrics from a remote lyrics service and shows them in a compact floating card.
- Lets you click a lyric line to seek the track to that timestamp.
- Keeps lyrics synced when you manually seek using the YouTube Music progress bar.
- Provides console debug helpers to diagnose seeking and media issues.

Installation
------------
Choose one of the following (recommended: install via Greasy Fork once uploaded):

1) Install via Greasy Fork (recommended)
   - Create a Greasy Fork account and submit a new userscript.
   - Copy the contents of `Youtube_Music_Beautifier.js` into the script body on Greasy Fork.
   - Fill the metadata fields (see "Greasy Fork submission tips").
   - Publish the script. Users can then install via the Greasy Fork install page.

2) Manual install (Tampermonkey — Chrome / Chromium / Edge)
   - Install the Tampermonkey extension from the Chrome Web Store.
   - Open Tampermonkey dashboard → Add a new script → paste the contents of `Youtube_Music_Beautifier.js` → Save.
   - Make sure the script is enabled and the @match is `https://music.youtube.com/*`.

3) Manual install (Safari)
   - If you use Tampermonkey for Safari, you can follow the same steps as for Chrome.
   - Alternatively use a Safari-compatible userscript manager (for example Userscripts.app or similar). Add a new script and paste `Youtube_Music_Beautifier.js`.

Notes on permissions
--------------------
The script requests/uses the following grants (declared in the script header):
- GM_xmlhttpRequest — used to fetch lyrics from the remote lyrics API.
- GM_addStyle, GM_getValue, GM_setValue — used for styling and small persisted settings.

When submitting to Greasy Fork, these grants will be shown to users; Tampermonkey will prompt for cross-origin permission for the GM_xmlhttpRequest call when required.

How to use
----------
- Open https://music.youtube.com and play a song.
- Click the launcher button (bottom-right) to open the floating lyrics card.
- Keyboard shortcuts while the card is open:
  - Ctrl/Cmd + L — open the lyrics card
  - Escape — close the lyrics card
- In the lyrics card:
  - Click any lyric line to seek the track to that line's timestamp.
  - Use the minimize (−) button to collapse the card, or × to close it.

Developer & Debugging helpers
-----------------------------
Open the browser Developer Console and use the following functions exposed on `window.ytmBeautifier`:

- window.ytmBeautifier.show() / .hide()
  - Show or hide the lyrics card programmatically.

- window.ytmBeautifier.getNowPlaying()
  - Returns the script's best-effort object describing the current track (title, artist, elapsed, total, etc.).

- window.ytmBeautifier.debugSeek(targetSeconds)
  - Prints a detailed diagnostic summary of the player DOM, progress bars, media elements and available player APIs. Use when seeking fails.

- window.ytmBeautifier.testSeek(seconds)
  - Runs the built-in seek tests (tries several seeking methods). Useful for quickly exercising the seeking pipelines.

- window.ytmBeautifier.reattachMedia()
  - Reattach internal media event listeners (useful if the player has been re-created by the page and the userscript missed the change).

Troubleshooting
---------------
If clicking lyrics doesn't seek or the lyrics lose sync after manual seeks, try the following in order:

1. Open the Console (DevTools) and run:
   - window.ytmBeautifier.debugSeek(60)
   - This prints which DOM elements, media elements, and APIs the script can see and any errors encountered.

2. Force a reattach of the media listeners:
   - window.ytmBeautifier.reattachMedia()
   - Then manually seek using the progress bar and observe console logs.

3. Use the test utility to exercise seek methods:
   - window.ytmBeautifier.testSeek(60)
   - This runs several seek approaches and reports results.

4. Check extension permissions / Greasy Fork install:
   - Ensure the userscript manager is allowed to run on `music.youtube.com`.
   - If the lyrics API is unreachable, the script will show a "No lyrics available" message; try again later or check network / API host availability.

5. If you see errors mentioning cross-origin requests:
   - In Tampermonkey you may need to allow the GM_xmlhttpRequest cross-domain permission for the script (the Greasy Fork UI or the extension will guide this).

Offset adjustments and saved settings
------------------------------------
- The script supports storing per-song offset corrections (if you manually tweak lyric timing later, the script persists per-song offsets).
- Offsets are stored via the userscript storage API or in localStorage under the prefix `ytm_beautifier_` when GM_* is not available. You can inspect or edit them in the browser console/localStorage.

Privacy & Remote API
--------------------
- Lyrics are fetched from the remote service configured in the script (`https://ytm.nwvbug.com` by default).
- When a lyrics request is made the script sends the song title/artist/album information to that service to find matching lyric files. If you prefer to self-host or change the provider, edit the `REST_URL` constant at the top of `Youtube_Music_Beautifier.js` before installing.

Greasy Fork submission tips
---------------------------
When you upload the script to Greasy Fork, include these items in the script page:
- Title: "YouTube Music Beautifier"
- Description: Short summary + mention lyric fetching from remote service.
- Version number and changelog entries for updates.
- Script header metadata (the header block at the top of `Youtube_Music_Beautifier.js` is already suitable). Ensure @match = `https://music.youtube.com/*`.
- Required grants: GM_addStyle, GM_setValue, GM_getValue, GM_xmlhttpRequest.
- License: add the repository license (see `LICENSE` file). Choose MIT or the license present in the repository.
- Screenshots: add a screenshot of the floating lyrics card to attract users.

FAQ / Common notes
------------------
- Q: "Why do lyrics sometimes say 'No lyrics available'?"
  - A: The script relies on a remote service which may not have a match for every song, or the service may be temporarily down.

- Q: "Seeking doesn't work in my browser"
  - A: Different browsers/userscript runners handle synthetic events differently. Use the debug helpers above and ensure your userscript manager has the required permissions.

- Q: "I want the lyrics to always show on page load"
  - A: The script creates a small launcher button. If you want auto-show behavior consider modifying `init()` in `Youtube_Music_Beautifier.js` to call `showLyricsCard()` after initialization.

Contributing
------------
Pull requests and issues are welcome. Please include console logs (from `debugSeek`) when reporting seek-related bugs — they make diagnosing issues fast.

License
-------
See the `LICENSE` file in this repository for licensing details.

Contact
-------
Create an issue in this repository or link to the Greasy Fork script page once uploaded. Provide browser/version and userscript manager details when you report problems.
# Youtube-Music-Real-time-Lyrics
Bring Real Time Lyrics on https://music.youtube.com
