// ==UserScript==
// @name         YouTube Music Beautifier
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  Elevate your YouTube Music Experience with time-synced lyrics, beautiful animated backgrounds, and enhanced controls!
// @author       Based on YouTube Music Beautifier Extension by Natesh Vemuri
// @match        https://music.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // Suppress noisy network/CORS/content-blocker errors coming from YouTube Music internals.
    // These originate from cross-origin telemetry/fetches and content blockers and clutter the console.
    // We add lightweight filters so only unexpected, real errors show up.
    (function installGlobalErrorFilters() {
        const isNoisyNetworkError = (msg) => {
            if (!msg || typeof msg !== 'string') return false;
            const patterns = [
                'XMLHttpRequest cannot load',
                'Fetch API cannot load',
                'Resource blocked by content blocker',
                'due to access control checks'
            ];
            return patterns.some(p => msg.includes(p));
        };

        // Additional detector for specific YouTube Music telemetry endpoints
        const isYouTubeTelemetry = (msg) => {
            if (!msg || typeof msg !== 'string') return false;
            // common endpoints that were noisy in the logs
            const endpoints = [
                'music.youtube.com/api/stats/atr',
                'music.youtube.com/api/stats/qoe',
                'music.youtube.com/youtubei/v1/log_event'
            ];
            return endpoints.some(e => msg.includes(e));
        };

        // In-memory buffer of suppressed messages for later debugging if needed
        window._ytmBeautifierSuppressed = window._ytmBeautifierSuppressed || [];

        // Wrap console.error and console.warn to filter out noisy messages
        try {
            const wrapConsole = (methodName) => {
                const orig = console[methodName].bind(console);
                console[methodName] = function(...args) {
                    try {
                        const text = args.map(a => {
                            if (typeof a === 'string') return a;
                            if (a && a.message) return a.message;
                            try { return JSON.stringify(a); } catch (e) { return String(a); }
                        }).join(' ');

                        if (isNoisyNetworkError(text) || isYouTubeTelemetry(text)) {
                            // store a small record and swallow the noisy message
                            window._ytmBeautifierSuppressed.push({ t: Date.now(), args });
                            // Keep the buffer small
                            if (window._ytmBeautifierSuppressed.length > 200) window._ytmBeautifierSuppressed.shift();
                            return; // prevent noisy output
                        }
                    } catch (e) {
                        // fall through to original
                    }
                    return orig(...args);
                };
            };
            wrapConsole('error');
            wrapConsole('warn');
        } catch (e) {
            // If console can't be wrapped for some reason, ignore and continue
        }

        // Window error handler
        const origOnError = window.onerror;
        window.onerror = function(message, source, lineno, colno, error) {
            try {
                if (isNoisyNetworkError(String(message))) {
                    // swallow the noisy network/CORS/content-blocker error
                    return true; // prevents the error being logged to console by browser
                }
            } catch (e) {
                // fall through to original handler
            }
            if (typeof origOnError === 'function') {
                return origOnError.apply(this, arguments);
            }
            return false;
        };

        // Unhandled promise rejections (Fetch API and XHR sometimes manifest here)
        const origUnhandled = window.onunhandledrejection;
        window.addEventListener('unhandledrejection', (ev) => {
            try {
                const reason = ev?.reason;
                const msg = typeof reason === 'string' ? reason : (reason && reason.message) ? reason.message : '';
                if (isNoisyNetworkError(String(msg))) {
                    ev.preventDefault(); // try to stop the browser from logging it
                    return;
                }
            } catch (e) {}
            if (typeof origUnhandled === 'function') {
                try { origUnhandled(ev); } catch (e) {}
            }
        });
    })();

    // Fallback functions for GM API
    const gmGetValue = (key, defaultValue) => {
        if (typeof GM_getValue !== 'undefined') {
            return GM_getValue(key, defaultValue);
        }
        // Fallback to localStorage
        const stored = localStorage.getItem('ytm_beautifier_' + key);
        return stored !== null ? JSON.parse(stored) : defaultValue;
    };

    const gmSetValue = (key, value) => {
        if (typeof GM_setValue !== 'undefined') {
            return GM_setValue(key, value);
        }
        // Fallback to localStorage
        localStorage.setItem('ytm_beautifier_' + key, JSON.stringify(value));
    };

    const gmAddStyle = (css) => {
        if (typeof GM_addStyle !== 'undefined') {
            return GM_addStyle(css);
        }
        // Fallback to creating style element
        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
        return style;
    };

    const gmXmlHttpRequest = (details) => {
        if (typeof GM_xmlhttpRequest !== 'undefined') {
            return GM_xmlhttpRequest(details);
        }
        // Fallback to fetch
        fetch(details.url, {
            method: details.method || 'GET',
            headers: details.headers || {}
        })
        .then(response => response.text())
        .then(responseText => {
            if (details.onload) {
                details.onload({ responseText });
            }
        })
        .catch(error => {
            if (details.onerror) {
                details.onerror(error);
            }
        });
    };

    // Configuration
    const REST_URL = "https://ytm.nwvbug.com";
    let currentlyPlayingSong = null;
    let lyrics = [];
    let times = [];
    let lyricsActive = false;
    let currentTime = -1;
    let currentIndex = 0;
    let incomingSecondOffset = 0;
    let beautifierContainer = null;

    // Utility Functions
    function timestampToSeconds(timestamp) {
        const [minutes, seconds] = timestamp.split(":").map(x => parseInt(x, 10));
        return minutes * 60 + seconds;
    }

    function formatTime(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = seconds % 60;
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function format(str) {
        str = str.replaceAll("&amp;", "&");
        str = str.replaceAll("&nbsp;", " ");
        return str;
    }

    // Get current song data from YouTube Music DOM
    function getNowPlaying() {
        const playerBar = document.querySelector("ytmusic-player-bar");
        if (!playerBar) return null;

        const outer = playerBar.querySelector("yt-formatted-string.byline.ytmusic-player-bar.complex-string");
        if (!outer) return null;

        const thumbnail = playerBar.querySelector("img.ytmusic-player-bar")?.src;
        const title = format(playerBar.querySelector("yt-formatted-string.title.ytmusic-player-bar")?.innerHTML || "");

        let str = "";
        const items = document.querySelector('.byline.style-scope.ytmusic-player-bar.complex-string')?.children;
        if (items) {
            for (let elem of items) { str += elem.innerText; }
        }
        str = str.split("•");
        const artist = format(str[0] || "");
        const album = format(str[1] || "");
        const date = format(str[2] || "");

        const leftControls = playerBar.querySelector(".left-controls");
        const playPauseButton = leftControls?.querySelector("#play-pause-button");
        const isPlaying = playPauseButton?.getAttribute("aria-label") === "Pause";
        
        const timeInfo = leftControls?.querySelector("span.time-info.ytmusic-player-bar")?.innerHTML.trim();
        if (!timeInfo) return null;
        
        const [elapsed, total] = timeInfo.split(" / ");

        let largeImage = null;
        try {
            largeImage = document.querySelector("#thumbnail")?.children[0]?.src;
        } catch {
            console.log("Image not grabbable");
        }

        return {
            thumbnail,
            title,
            artist,
            album,
            isPlaying,
            elapsed: timestampToSeconds(elapsed),
            total: timestampToSeconds(total),
            largeImage,
            date
        };
    }

    // Lyrics fetching and parsing
    function getSongLyrics(title, artist, album, year, reroll = false) {
        resetOffset();
        let urlAddon = "";
        if (!reroll) {
            urlAddon = title + " " + artist + " " + year;
        } else {
            urlAddon = title + " " + artist + " " + album + " " + year;
        }
        urlAddon = urlAddon.replaceAll("/", "-").replaceAll("%", "%25");

        gmXmlHttpRequest({
            method: 'GET',
            url: REST_URL + "/request-lyrics/" + urlAddon,
            onload: function(response) {
                console.log("Lyrics response:", response.responseText.substring(0, 100) + "...");
                if (response.responseText === "no_lyrics_found" || response.responseText.includes("<title>500 Internal Server Error</title>")) {
                    console.log("No lyrics found for this song");
                    lyrics = ["No lyrics available"];
                    times = [0];
                    initializeLyrics();
                } else {
                    try {
                        const result = JSON.parse(response.responseText);
                        const data = result["lrc"];
                        console.log("Found lyrics with source:", result["source"]);
                        
                        if (result["source"] === "unofficial") {
                            parseUnofficialLyrics(data);
                        } else if (result["source"] === "ytm") {
                            parseYTMLyrics(data);
                        }
                        
                        if (times.length === 0) {
                            lyrics = ["Lyrics parsing failed"];
                            times = [0];
                        }
                        
                        console.log(`Parsed ${lyrics.length} lyric lines`);
                        initializeLyrics();
                    } catch (e) {
                        console.error("Error parsing lyrics:", e);
                        lyrics = ["Error loading lyrics"];
                        times = [0];
                        initializeLyrics();
                    }
                }
            },
            onerror: function(error) {
                console.error('Lyrics fetch error:', error);
                lyrics = ["Failed to fetch lyrics"];
                times = [0];
                initializeLyrics();
            }
        });
    }

    function parseUnofficialLyrics(data) {
        const allTextLines = data.split(/\r\n|\n/);
        lyrics = [];
        times = [];
        
        let lyricIndex = 0;
        for (let i = 0; i < allTextLines.length; i++) {
            if (allTextLines[i].search(/^(\[)(\d*)(:)(.*)(\])(.*)/i) >= 0) {
                const line = allTextLines[i].match(/^(\[)(\d*)(:)(.*)(\])(.*)/i);
                times[lyricIndex] = (parseInt(line[2]) * 60) + parseInt(line[4]);
                lyrics[lyricIndex] = line[6];
                lyricIndex++;
            }
        }
        
        // Clean up empty or unwanted lyrics
        for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === " " || lyrics[i] === '' || lyrics[i]?.substring(1, 3) === "作曲" || lyrics[i]?.substring(1, 3) === "作词") {
                lyrics[i] = "♪♪";
            }
        }
        
        // Remove undefined entries
        lyrics = lyrics.filter((lyric, index) => lyric !== undefined && times[index] !== undefined);
        times = times.filter(time => time !== undefined);
    }

    function parseYTMLyrics(data) {
        lyrics = [];
        times = [];
        for (let i = 0; i < data.length; i++) {
            let lyricText = data[i].text;
            // Replace music note symbols with proper display
            if (lyricText === "♪" || lyricText.trim() === "") {
                lyricText = "♪♪";
            }
            lyrics[i] = lyricText;
            times[i] = Math.floor(data[i].time);
        }
        console.log(`Parsed YTM lyrics: ${lyrics.length} lines`);
    }

    // CSS Styles
    const styles = `
        @import url('https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&display=swap');

        #ytm-lyrics-card {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 350px;
            max-height: 80vh;
            background: rgba(0, 0, 0, 0.85);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 16px;
            font-family: "Host Grotesk", serif;
            color: white;
            z-index: 10000;
            display: none;
            flex-direction: column;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
            transition: all 0.3s ease;
        }

        #ytm-lyrics-card.active {
            display: flex;
        }

        #ytm-lyrics-header {
            padding: 16px 20px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.1);
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: grab;
        }

        #ytm-lyrics-header:active {
            cursor: grabbing;
        }

        #ytm-song-info {
            flex: 1;
            min-width: 0;
        }

        #ytm-song-title {
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #ytm-song-artist {
            font-size: 12px;
            opacity: 0.7;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        #ytm-lyrics-controls {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        .ytm-mini-control {
            width: 28px;
            height: 28px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.1);
            border: none;
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.2s ease;
        }

        .ytm-mini-control:hover {
            background: rgba(255, 255, 255, 0.2);
            transform: scale(1.1);
        }

        #ytm-lyrics-content {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
            text-align: center;
        }

        .ytm-lyric-line {
            font-size: 14px;
            font-weight: 400;
            opacity: 0.4;
            margin: 12px 0;
            transition: all 0.3s ease;
            cursor: pointer;
            line-height: 1.4;
            padding: 8px 12px;
            border-radius: 8px;
            position: relative;
        }

        .ytm-lyric-line.active {
            opacity: 1;
            font-weight: 600;
            font-size: 16px;
            color: #ff6b6b;
            transform: scale(1.05);
            background: rgba(255, 107, 107, 0.1);
        }

        .ytm-lyric-line:hover {
            opacity: 0.8;
            background: rgba(255, 255, 255, 0.05);
            transform: translateX(4px);
        }

        .ytm-lyric-line.seeking {
            background: rgba(255, 255, 255, 0.1);
            transform: scale(0.95);
            opacity: 0.6;
        }

        #ytm-launcher {
            position: fixed;
            top: 100px;
            right: 20px;
            background: linear-gradient(135deg, rgba(255,107,107,0.95) 0%, rgba(255,82,82,0.95) 100%);
            color: white;
            border: none;
            border-radius: 999px;
            padding: 10px 14px;
            font-size: 14px;
            font-weight: 700;
            cursor: pointer;
            z-index: 99999;
            box-shadow: 0 8px 30px rgba(0,0,0,0.35), 0 2px 6px rgba(255,82,82,0.12) inset;
            transition: transform 220ms cubic-bezier(.2,.9,.3,1), box-shadow 220ms ease, opacity 220ms ease;
            display: inline-flex;
            align-items: center;
            gap: 10px;
            backdrop-filter: blur(6px) saturate(120%);
            -webkit-backdrop-filter: blur(6px) saturate(120%);
            padding-left: 12px;
            padding-right: 16px;
        }

        #ytm-launcher:hover {
            transform: translateY(-2px) scale(1.02);
            box-shadow: 0 16px 40px rgba(0,0,0,0.45), 0 4px 14px rgba(255,82,82,0.18) inset;
        }

        /* Scrollbar styling */
        #ytm-lyrics-content::-webkit-scrollbar {
            width: 4px;
        }

        #ytm-lyrics-content::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.05);
            border-radius: 2px;
        }

        #ytm-lyrics-content::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.2);
            border-radius: 2px;
        }

        #ytm-lyrics-content::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        /* Responsive adjustments */
        @media (max-width: 768px) {
            #ytm-lyrics-card {
                width: 300px;
                right: 10px;
                top: 10px;
                max-height: 70vh;
            }
            
            #ytm-launcher {
                top: 10px;
                right: 10px;
                padding: 8px 12px;
                font-size: 13px;
            }
        }
    `;

    gmAddStyle(styles);

    // Lyrics Management
    function initializeLyrics() {
        const lyricsContainer = document.getElementById('ytm-lyrics-content');
        if (!lyricsContainer) return;

    // Clear existing content safely (avoid innerHTML assignment to satisfy Trusted Types)
    lyricsContainer.textContent = '';
        
        // Add padding divs
        for (let i = 0; i < 3; i++) {
            lyricsContainer.appendChild(document.createElement('div'));
        }

        // Add lyric lines
        for (let i = 0; i < lyrics.length; i++) {
            const lyricDiv = document.createElement('div');
            lyricDiv.className = 'ytm-lyric-line';
            lyricDiv.id = `ytm-lyric-${i}`;
            lyricDiv.textContent = lyrics[i];
            lyricDiv.title = `Click to seek to: ${formatTime(times[i])}`;
            lyricDiv.onclick = () => seekToLyric(i);
            lyricsContainer.appendChild(lyricDiv);
        }

        // Add padding divs
        for (let i = 0; i < 3; i++) {
            lyricsContainer.appendChild(document.createElement('div'));
        }

        currentIndex = 0;
        currentTime = -1;
    }

    function seekToLyric(index) {
        if (times[index] !== undefined) {
            const targetTime = times[index];
            const lyricElement = document.getElementById(`ytm-lyric-${index}`);
            
            // Add visual feedback
            if (lyricElement) {
                lyricElement.classList.add('seeking');
                setTimeout(() => {
                    lyricElement.classList.remove('seeking');
                }, 500);
            }
            
            // Show seeking feedback in console
            console.log(`Clicking to seek to: "${lyrics[index]}" at ${targetTime}s`);
            
            // Perform the seek
            simulateSeek(targetTime);
            
            // Update current index to the clicked lyric
            currentIndex = index;
            
            // Remove active class from all lyrics and add to clicked one
            const allLyrics = document.querySelectorAll('.ytm-lyric-line');
            allLyrics.forEach(line => line.classList.remove('active'));
            if (lyricElement) {
                lyricElement.classList.add('active');
                lyricElement.scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'center' 
                });
            }
        }
    }

    function simulateSeek(targetTime) {
        console.log(`\n=== simulateSeek: target ${targetTime}s ===`);

        const songData = getNowPlaying();
        if (!songData) {
            console.log("simulateSeek: no song data");
            return;
        }

        const current = songData.elapsed;
        const diff = targetTime - current;
        console.log(`Current: ${current}s, diff: ${diff}s`);

        // If the difference is negligible, skip
        if (Math.abs(diff) < 0.8) {
            console.log('simulateSeek: difference < 0.8s, skipping');
            return;
        }

        // Preferred order: media element -> ytmusic app API -> UI interactions
        try {
            if (trySeekViaMediaElement(targetTime)) {
                console.log('simulateSeek: seeked via media element');
                return;
            }
        } catch (e) { console.log('media element seek error', e); }

        try {
            if (trySeekViaYtMusicApp(targetTime)) {
                console.log('simulateSeek: seeked via ytmusic-app API');
                return;
            }
        } catch (e) { console.log('ytmusic-app seek error', e); }

        // Fallback to previous UI-based methods
        try {
            if (tryProgressBarSeek(targetTime, songData.total)) {
                console.log('simulateSeek: seeked via progress bar');
                return;
            }
        } catch (e) { console.log('progress bar seek error', e); }

        try {
            if (tryVideoPlayerSeek(targetTime, songData.total)) {
                console.log('simulateSeek: seeked via video element');
                return;
            }
        } catch (e) { console.log('video player seek error', e); }

        // Last resort: keyboard navigation
        try {
            fallbackKeyboardSeek(diff);
            console.log('simulateSeek: fallbackKeyboardSeek triggered');
        } catch (e) { console.log('fallback keyboard error', e); }
    }

    // Attempt to set currentTime on any visible HTMLMediaElement (video/audio)
    function trySeekViaMediaElement(targetTime) {
        try {
            const media = Array.from(document.querySelectorAll('video, audio'))
                .filter(m => m && !isNaN(m.duration) && m.duration > 0 && m.offsetParent !== null)[0];

            if (!media) {
                console.log('trySeekViaMediaElement: no visible media element found');
                return false;
            }

            console.log('trySeekViaMediaElement: using media element', media);

            // Some media elements on YT are controlled via wrappers; attempt direct set
            try {
                media.currentTime = targetTime;
            } catch (e) {
                console.log('trySeekViaMediaElement: direct set failed', e);
            }

            // Dispatch events to notify player
            media.dispatchEvent(new Event('seeking'));
            media.dispatchEvent(new Event('timeupdate'));
            media.dispatchEvent(new Event('seeked'));

            // Verify after short delay
            setTimeout(() => {
                console.log('trySeekViaMediaElement: after set currentTime ->', media.currentTime);
            }, 200);

            return true;
        } catch (e) {
            console.log('trySeekViaMediaElement error', e);
            return false;
        }
    }

    // Attempt to call the ytmusic-app's internal API if available
    function trySeekViaYtMusicApp(targetTime) {
        try {
            const app = document.querySelector('ytmusic-app');
            if (!app) {
                console.log('trySeekViaYtMusicApp: ytmusic-app not found');
                return false;
            }

            // Common API entry points
            const candidates = [
                app.playerApi_,
                app.player_,
                app.playerApi,
                app.appContext_ && app.appContext_.playerApi,
                window.ytplayer,
                window.yt && window.yt.player
            ];

            for (const api of candidates) {
                if (!api) continue;
                if (typeof api.seekTo === 'function') {
                    try { api.seekTo(targetTime); console.log('trySeekViaYtMusicApp: used seekTo'); return true; } catch (e) { console.log('api.seekTo failed', e); }
                }
                if (typeof api.setCurrentTime === 'function') {
                    try { api.setCurrentTime(targetTime); console.log('trySeekViaYtMusicApp: used setCurrentTime'); return true; } catch (e) { console.log('api.setCurrentTime failed', e); }
                }
                // Some APIs accept an object call
                try {
                    if (api.player && typeof api.player.seekTo === 'function') {
                        api.player.seekTo(targetTime); console.log('trySeekViaYtMusicApp: used api.player.seekTo'); return true;
                    }
                } catch (e) {}
            }

            return false;
        } catch (e) {
            console.log('trySeekViaYtMusicApp error', e);
            return false;
        }
    }
    
    function tryProgressBarSeek(targetTime, totalTime) {
        const progressSelectors = [
            '#progress-bar',
            '.progress-bar',
            'tp-yt-paper-slider#progress-bar',
            '.ytmusic-player-bar #progress-bar',
            '[role="slider"]'
        ];
        
        for (const selector of progressSelectors) {
            const progressBar = document.querySelector(selector);
            if (progressBar) {
                const percentage = targetTime / totalTime;
                const rect = progressBar.getBoundingClientRect();
                
                // Try multiple interaction methods
                if (tryDirectSliderInteraction(progressBar, percentage)) {
                    console.log(`Direct slider interaction worked for ${selector}`);
                    return true;
                }
                
                if (tryPointerEvents(progressBar, rect, percentage)) {
                    console.log(`Pointer events worked for ${selector}`);
                    return true;
                }
                
                if (tryFocusAndKeys(progressBar, percentage)) {
                    console.log(`Focus and keys worked for ${selector}`);
                    return true;
                }
                
                console.log(`All methods failed for ${selector}`);
            }
        }
        return false;
    }
    
    function tryDirectSliderInteraction(slider, percentage) {
        try {
            // Method 1: Set value directly
            if (slider.value !== undefined) {
                const oldValue = slider.value;
                slider.value = percentage * 100;
                
                // Trigger all relevant events
                const events = ['input', 'change', 'slide', 'iron-change'];
                events.forEach(eventType => {
                    const event = new CustomEvent(eventType, {
                        bubbles: true,
                        detail: { value: percentage * 100 }
                    });
                    slider.dispatchEvent(event);
                });
                
                // Check if value actually changed
                if (slider.value !== oldValue) {
                    return true;
                }
            }
            
            // Method 2: Use Polymer/iron-input specific methods
            if (slider._setValue) {
                slider._setValue(percentage * 100);
                return true;
            }
            
            if (slider.immediateValue !== undefined) {
                slider.immediateValue = percentage * 100;
                slider.value = percentage * 100;
                return true;
            }
            
        } catch (error) {
            console.log("Direct slider interaction failed:", error);
        }
        return false;
    }
    
    function tryPointerEvents(element, rect, percentage) {
        try {
            const clickX = rect.left + (rect.width * percentage);
            const clickY = rect.top + (rect.height / 2);
            
            // Create a complete pointer event sequence
            const events = [
                { type: 'pointerdown', isPrimary: true },
                { type: 'mousedown', button: 0 },
                { type: 'pointermove', isPrimary: true },
                { type: 'mousemove' },
                { type: 'pointerup', isPrimary: true },
                { type: 'mouseup', button: 0 },
                { type: 'click', button: 0 }
            ];
            
            events.forEach(({ type, isPrimary, button }) => {
                const event = type.startsWith('pointer') 
                    ? new PointerEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        clientX: clickX,
                        clientY: clickY,
                        isPrimary: isPrimary || false,
                        pointerId: 1
                    })
                    : new MouseEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        clientX: clickX,
                        clientY: clickY,
                        button: button || 0
                    });
                
                element.dispatchEvent(event);
            });
            
            return true;
        } catch (error) {
            console.log("Pointer events failed:", error);
            return false;
        }
    }
    
    function tryFocusAndKeys(element, percentage) {
        try {
            // Focus the element first
            element.focus();
            
            // Calculate how many key presses we need
            // Most sliders respond to arrow keys for fine control
            const targetValue = percentage * 100;
            const currentValue = parseFloat(element.value) || 0;
            const difference = targetValue - currentValue;
            
            // Use Home/End for major jumps, then fine-tune with arrows
            if (Math.abs(difference) > 50) {
                const homeEndKey = difference > 0 ? 'End' : 'Home';
                const keyEvent = new KeyboardEvent('keydown', {
                    key: homeEndKey,
                    code: homeEndKey,
                    bubbles: true
                });
                element.dispatchEvent(keyEvent);
                
                // Give it a moment to process
                setTimeout(() => {
                    // Fine-tune with arrow keys if needed
                    const newDifference = targetValue - (parseFloat(element.value) || 0);
                    const arrowKey = newDifference > 0 ? 'ArrowRight' : 'ArrowLeft';
                    const steps = Math.min(Math.abs(newDifference) / 5, 10); // Limit steps
                    
                    for (let i = 0; i < steps; i++) {
                        setTimeout(() => {
                            const arrowEvent = new KeyboardEvent('keydown', {
                                key: arrowKey,
                                code: arrowKey,
                                bubbles: true
                            });
                            element.dispatchEvent(arrowEvent);
                        }, i * 50);
                    }
                }, 100);
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.log("Focus and keys failed:", error);
            return false;
        }
    }
    
    function trySliderSeek(targetTime, totalTime) {
        const slider = document.querySelector('tp-yt-paper-slider');
        if (slider && slider.setAttribute) {
            const percentage = (targetTime / totalTime) * 100;
            slider.setAttribute('value', percentage.toString());
            
            // Trigger change events
            const changeEvent = new Event('change', { bubbles: true });
            const inputEvent = new Event('input', { bubbles: true });
            slider.dispatchEvent(inputEvent);
            slider.dispatchEvent(changeEvent);
            
            console.log(`Set slider value to ${percentage}%`);
            return true;
        }
        return false;
    }
    
    function tryVideoPlayerSeek(targetTime, totalTime) {
        // Try multiple video seeking approaches
        const videos = document.querySelectorAll('video');
        
        for (const video of videos) {
            if (video && !isNaN(video.duration) && video.duration > 0) {
                try {
                    // Method 1: Direct currentTime setting
                    const oldTime = video.currentTime;
                    video.currentTime = targetTime;
                    
                    // Trigger timeupdate event
                    video.dispatchEvent(new Event('timeupdate'));
                    video.dispatchEvent(new Event('seeking'));
                    video.dispatchEvent(new Event('seeked'));
                    
                    console.log(`Set video currentTime from ${oldTime} to ${targetTime}`);
                    
                    // Verify the seek worked
                    setTimeout(() => {
                        if (Math.abs(video.currentTime - targetTime) < 2) {
                            console.log("Video seek verified successful");
                        }
                    }, 100);
                    
                    return true;
                } catch (error) {
                    console.log("Video seek failed:", error);
                }
            }
        }
        
        // Try YouTube's internal player API if available
        return tryYouTubeAPI(targetTime);
    }
    
    function tryYouTubeAPI(targetTime) {
        try {
            // Look for YouTube's internal player object
            const playerElements = document.querySelectorAll('[data-player-name]');
            
            for (const element of playerElements) {
                if (element.seekTo && typeof element.seekTo === 'function') {
                    element.seekTo(targetTime);
                    console.log(`Used YouTube API seekTo(${targetTime})`);
                    return true;
                }
            }
            
            // Try accessing through window objects
            if (window.ytplayer && window.ytplayer.seekTo) {
                window.ytplayer.seekTo(targetTime);
                console.log(`Used window.ytplayer.seekTo(${targetTime})`);
                return true;
            }
            
            // Try looking for Polymer/YouTube Music specific objects
            const app = document.querySelector('ytmusic-app');
            if (app && app.playerApi_ && app.playerApi_.seekTo) {
                app.playerApi_.seekTo(targetTime);
                console.log(`Used ytmusic-app playerApi seekTo(${targetTime})`);
                return true;
            }
            
        } catch (error) {
            console.log("YouTube API seek failed:", error);
        }
        
        return false;
    }
    
    function fallbackKeyboardSeek(timeDifference) {
        // Fallback method using keyboard shortcuts
        // YouTube Music uses arrow keys for seeking (usually 5-10 second intervals)
        const seekInterval = 10; // YouTube Music typically seeks 10 seconds per arrow key
        const seekCount = Math.floor(Math.abs(timeDifference) / seekInterval);
        
        if (seekCount === 0) return;
        
        const key = timeDifference > 0 ? 'ArrowRight' : 'ArrowLeft';
        const targetElement = document.querySelector('ytmusic-player-bar') || document.body;
        
        console.log(`Using keyboard seek: ${key} x${seekCount}`);
        
        // Send multiple key presses with small delays
        for (let i = 0; i < Math.min(seekCount, 10); i++) { // Limit to 10 presses to avoid issues
            setTimeout(() => {
                const keyEvent = new KeyboardEvent('keydown', {
                    key: key,
                    code: key,
                    bubbles: true,
                    cancelable: true
                });
                targetElement.dispatchEvent(keyEvent);
            }, i * 100); // 100ms delay between key presses
        }
    }

    function updateLyrics(currentSeconds) {
        if (times.length === 0) return;

        // Recompute the correct lyric index for the supplied time (handles forward and backward seeks)
        const lyricLines = document.querySelectorAll('.ytm-lyric-line');
        let newIndex = 0;
        for (let i = 0; i < times.length; i++) {
            if (currentSeconds >= times[i]) {
                newIndex = i;
            } else {
                break;
            }
        }

        // If index changed, update classes and scroll
        if (newIndex !== currentIndex) {
            // Remove previous active
            lyricLines.forEach(line => line.classList.remove('active'));

            // Add active to new index if within bounds
            if (lyricLines[newIndex]) {
                lyricLines[newIndex].classList.add('active');
                lyricLines[newIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }

        currentIndex = newIndex;
        currentTime = currentSeconds;
    }

    // Control Functions
    function triggerPlayPause() {
        const playButton = document.getElementById("play-pause-button");
        playButton?.click();
    }

    function triggerNext() {
        const nextButton = document.querySelector(".next-button.style-scope.ytmusic-player-bar");
        nextButton?.click();
        // Force update after a short delay
        setTimeout(() => {
            const songData = getNowPlaying();
            if (songData) {
                updateUI(songData);
            }
        }, 500);
    }

    function triggerPrevious() {
        const prevButton = document.querySelector(".previous-button.style-scope.ytmusic-player-bar");
        prevButton?.click();
        // Force update after a short delay
        setTimeout(() => {
            const songData = getNowPlaying();
            if (songData) {
                updateUI(songData);
            }
        }, 500);
    }

    // Offset Management
    function resetOffset() {
        const currentSongId = currentlyPlayingSong?.title + currentlyPlayingSong?.artist + currentlyPlayingSong?.album;
        incomingSecondOffset = gmGetValue(`offset_${currentSongId}`, 0);
    }

    function saveOffset() {
        const currentSongId = currentlyPlayingSong?.title + currentlyPlayingSong?.artist + currentlyPlayingSong?.album;
        gmSetValue(`offset_${currentSongId}`, incomingSecondOffset);
    }

    // UI Creation
    function createLyricsCard() {
        // Remove existing card if present
        const existing = document.getElementById('ytm-lyrics-card');
        if (existing) existing.remove();

        const lyricsCard = document.createElement('div');
        lyricsCard.id = 'ytm-lyrics-card';
        // Build header
        const header = document.createElement('div');
        header.id = 'ytm-lyrics-header';

        const songInfo = document.createElement('div');
        songInfo.id = 'ytm-song-info';

        const songTitle = document.createElement('div');
        songTitle.id = 'ytm-song-title';
        songTitle.textContent = 'No song playing';

        const songArtist = document.createElement('div');
        songArtist.id = 'ytm-song-artist';
        songArtist.textContent = 'YouTube Music';

        songInfo.appendChild(songTitle);
        songInfo.appendChild(songArtist);

        const controls = document.createElement('div');
        controls.id = 'ytm-lyrics-controls';

        const minimizeBtn = document.createElement('button');
        minimizeBtn.className = 'ytm-mini-control';
        minimizeBtn.id = 'ytm-minimize-btn';
        minimizeBtn.title = 'Minimize';
        minimizeBtn.textContent = '−';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'ytm-mini-control';
        closeBtn.id = 'ytm-close-btn';
        closeBtn.title = 'Close';
        closeBtn.textContent = '×';

        controls.appendChild(minimizeBtn);
        controls.appendChild(closeBtn);

        header.appendChild(songInfo);
        header.appendChild(controls);

        const content = document.createElement('div');
        content.id = 'ytm-lyrics-content';

        const loadingLine = document.createElement('div');
        loadingLine.className = 'ytm-lyric-line';
        loadingLine.textContent = '🎵 Loading lyrics...';
        content.appendChild(loadingLine);

        lyricsCard.appendChild(header);
        lyricsCard.appendChild(content);

        document.body.appendChild(lyricsCard);
        beautifierContainer = lyricsCard;

        // Make the card draggable
        let isDragging = false;
        let currentX;
        let currentY;
        let initialX;
        let initialY;
        let xOffset = 0;
        let yOffset = 0;

        const headerEl = document.getElementById('ytm-lyrics-header');
        
        headerEl.addEventListener('mousedown', (e) => {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            
            if (e.target === headerEl || e.target.closest('#ytm-song-info')) {
                isDragging = true;
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                e.preventDefault();
                currentX = e.clientX - initialX;
                currentY = e.clientY - initialY;
                
                xOffset = currentX;
                yOffset = currentY;
                
                lyricsCard.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
            }
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        // Event listeners
        document.getElementById('ytm-close-btn').onclick = hideLyricsCard;
        document.getElementById('ytm-minimize-btn').onclick = toggleMinimize;

        return lyricsCard;
    }

    function createLauncher() {
        const launcher = document.createElement('button');
        launcher.id = 'ytm-launcher';
        launcher.setAttribute('aria-label', 'Show lyrics');
        launcher.setAttribute('title', 'Show lyrics');
        // Build launcher contents without innerHTML to satisfy TrustedHTML requirements
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('width', '18');
        svg.setAttribute('height', '18');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');

        const path1 = document.createElementNS(svgNS, 'path');
        path1.setAttribute('d', 'M4 6H20V18H8L4 22V6Z');
        path1.setAttribute('fill', 'white');
        path1.setAttribute('opacity', '0.95');

        const path2 = document.createElementNS(svgNS, 'path');
        path2.setAttribute('d', 'M7 9H17');
        path2.setAttribute('stroke', 'rgba(0,0,0,0.12)');
        path2.setAttribute('stroke-width', '1.5');
        path2.setAttribute('stroke-linecap', 'round');
        path2.setAttribute('stroke-linejoin', 'round');

        svg.appendChild(path1);
        svg.appendChild(path2);

        const span = document.createElement('span');
        span.textContent = 'Lyrics';

        launcher.appendChild(svg);
        launcher.appendChild(span);
        launcher.onclick = showLyricsCard;
        document.body.appendChild(launcher);
        return launcher;
    }

    function showLyricsCard() {
        if (!beautifierContainer) {
            createLyricsCard();
        }
        // Position the card just below the launcher (top-right)
        const launcher = document.getElementById('ytm-launcher');
        if (launcher && beautifierContainer) {
            const rect = launcher.getBoundingClientRect();
            const margin = 8; // gap between launcher and card

            // Make the card visible first so we can measure its height for clamping
            beautifierContainer.classList.add('active');

            // Reset any drag transform so positioning is predictable when first shown
            try { beautifierContainer.style.transform = 'none'; } catch (e) {}

            // Compute inline right (distance from viewport right) and top (below launcher)
            const computedRight = Math.max(8, Math.round(window.innerWidth - rect.right));
            let computedTop = Math.round(rect.bottom + margin);

            // Clamp to viewport bottom so the card doesn't overflow
            const cardHeight = beautifierContainer.offsetHeight || 300;
            const maxTop = Math.max(8, window.innerHeight - cardHeight - 10);
            if (computedTop > maxTop) computedTop = maxTop;

            beautifierContainer.style.top = computedTop + 'px';
            beautifierContainer.style.right = computedRight + 'px';
        } else if (beautifierContainer) {
            // Fallback: just show at default position
            beautifierContainer.classList.add('active');
        }

        // Update with current song data
        const songData = getNowPlaying();
        if (songData) {
            updateUI(songData);
        }
    }

    function hideLyricsCard() {
        if (beautifierContainer) {
            beautifierContainer.classList.remove('active');
        }
    }

    function toggleMinimize() {
        const content = document.getElementById('ytm-lyrics-content');
        const minimizeBtn = document.getElementById('ytm-minimize-btn');
        
        if (content.style.display === 'none') {
            content.style.display = 'block';
            minimizeBtn.textContent = '−';
            minimizeBtn.title = 'Minimize';
        } else {
            content.style.display = 'none';
            minimizeBtn.textContent = '+';
            minimizeBtn.title = 'Expand';
        }
    }

    function updateUI(songData) {
        if (!songData) return;

        // Update song info in the header
        const titleElement = document.getElementById('ytm-song-title');
        const artistElement = document.getElementById('ytm-song-artist');
        
        if (titleElement) {
            titleElement.textContent = songData.title || 'Unknown Title';
        }
        if (artistElement) {
            artistElement.textContent = songData.artist || 'Unknown Artist';
        }

        // Update lyrics
        const adjustedTime = songData.elapsed - incomingSecondOffset;
        updateLyrics(adjustedTime);

        // Check if this is a new song
        const songIdentifier = songData.title + songData.artist + songData.album;
        if (currentlyPlayingSong?.title + currentlyPlayingSong?.artist + currentlyPlayingSong?.album !== songIdentifier) {
            currentlyPlayingSong = songData;
            lyrics = [];
            times = [];
            getSongLyrics(songData.title, songData.artist, songData.album, songData.date);
        }
    }

    // Main monitoring function
    function monitorYouTubeMusic() {
        const songData = getNowPlaying();
        if (songData && beautifierContainer && beautifierContainer.classList.contains('active')) {
            updateUI(songData);
        }
    }

    // Keep track of the currently-attached media element so we can listen for seeks/timeupdates
    let _attachedMedia = null;
    function findAndAttachMediaListeners() {
        try {
            const media = Array.from(document.querySelectorAll('video, audio'))
                .filter(m => m && !isNaN(m.duration) && m.duration > 0 && m.offsetParent !== null)[0] || null;

            if (media === _attachedMedia) return; // already attached

            // Remove listeners from old media
            if (_attachedMedia) {
                try {
                    _attachedMedia.removeEventListener('timeupdate', _mediaTimeHandler);
                    _attachedMedia.removeEventListener('seeked', _mediaSeekHandler);
                    _attachedMedia.removeEventListener('play', _mediaPlayHandler);
                    _attachedMedia.removeEventListener('pause', _mediaPauseHandler);
                } catch (e) {}
            }

            _attachedMedia = media;

            if (!_attachedMedia) {
                console.log('findAndAttachMediaListeners: no media element found');
                return;
            }

            // Handlers reference
            _attachedMedia.addEventListener('timeupdate', _mediaTimeHandler);
            _attachedMedia.addEventListener('seeked', _mediaSeekHandler);
            _attachedMedia.addEventListener('play', _mediaPlayHandler);
            _attachedMedia.addEventListener('pause', _mediaPauseHandler);

            console.log('Attached media listeners to', _attachedMedia);
        } catch (e) {
            console.log('findAndAttachMediaListeners error', e);
        }
    }

    function _mediaTimeHandler(e) {
        try {
            const media = e.target;
            const elapsed = Math.floor(media.currentTime || 0);
            // adjust for any offset saved by user
            const adjusted = elapsed - incomingSecondOffset;
            // update the lyric sync
            updateLyrics(adjusted);

            // update currentlyPlayingSong elapsed so UI reflects manual changes
            if (currentlyPlayingSong) currentlyPlayingSong.elapsed = elapsed;
        } catch (err) {
            console.log('mediaTimeHandler error', err);
        }
    }

    function _mediaSeekHandler(e) {
        try {
            const media = e.target;
            const elapsed = Math.floor(media.currentTime || 0);
            console.log('Media seek detected to', elapsed);
            // When a seek happens, reset the lyric index state so updateLyrics recalculates correctly
            currentTime = -1;
            currentIndex = 0;
            updateLyrics(elapsed - incomingSecondOffset);
            if (currentlyPlayingSong) currentlyPlayingSong.elapsed = elapsed;
        } catch (err) {
            console.log('mediaSeekHandler error', err);
        }
    }

    function _mediaPlayHandler(e) {
        // Ensure listeners stay attached
        setTimeout(findAndAttachMediaListeners, 100);
    }

    function _mediaPauseHandler(e) {
        // keep tracking paused state for possible UI updates
        // ...not required currently
    }

    // Force refresh function for manual updates - with throttling
    let lastRefreshTime = 0;
    function forceRefresh() {
        const now = Date.now();
        if (now - lastRefreshTime < 2000) { // Throttle to once every 2 seconds
            return;
        }
        lastRefreshTime = now;
        
        setTimeout(() => {
            const songData = getNowPlaying();
            if (songData && beautifierContainer && beautifierContainer.classList.contains('active')) {
                // Only log if it's actually a different song
                const newSongId = songData.title + songData.artist + songData.album;
                const currentSongId = currentlyPlayingSong?.title + currentlyPlayingSong?.artist + currentlyPlayingSong?.album;
                
                if (newSongId !== currentSongId) {
                    console.log("Song changed, refreshing data:", songData.title);
                }
                updateUI(songData);
            }
        }, 100);
    }

    // Initialize
    function init() {
        console.log("[YouTube Music Beautifier Userscript] Starting...");
        
        // Create launcher button
        createLauncher();
        
        // Start monitoring with less frequent updates
        setInterval(monitorYouTubeMusic, 2000); // Reduced from 1000ms to 2000ms
        
        // Watch for DOM changes with throttling
        const playerBar = document.querySelector("ytmusic-player-bar");
        if (playerBar) {
            let observerTimeout;
            const observer = new MutationObserver(() => {
                // Debounce the observer calls
                clearTimeout(observerTimeout);
                observerTimeout = setTimeout(() => {
                    monitorYouTubeMusic();
                    forceRefresh();
                }, 500); // Wait 500ms before processing changes
            });
            observer.observe(playerBar, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['aria-label', 'src'] // Only watch specific attributes
            });
        }

        // Remove the excessive main content observer that was causing issues
        console.log("[YouTube Music Beautifier Userscript] Initialized!");

        // Attach media listeners to capture manual seeks
        findAndAttachMediaListeners();
    }

    // Wait for page to load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // DOM is already loaded
        setTimeout(init, 1000); // Wait a bit for YouTube Music to initialize
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (!beautifierContainer || !beautifierContainer.classList.contains('active')) return;
        
        switch(e.key) {
            case 'Escape':
                hideLyricsCard();
                break;
            case 'l':
            case 'L':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    showLyricsCard();
                }
                break;
        }
    });

    // Export for debugging
    window.ytmBeautifier = {
        show: showLyricsCard,
        hide: hideLyricsCard,
        getNowPlaying,
        getSongLyrics,
        debugSeek: (targetTime) => {
            console.log("=== COMPREHENSIVE SEEK DEBUG INFO ===");
            console.log("Target time:", targetTime);
            
            // Check progress bar elements
            const progressSelectors = [
                '#progress-bar',
                '.progress-bar', 
                'tp-yt-paper-slider#progress-bar',
                '.ytmusic-player-bar #progress-bar',
                '[role="slider"]'
            ];
            
            console.log("\n--- Progress Bar Elements ---");
            progressSelectors.forEach(selector => {
                const element = document.querySelector(selector);
                if (element) {
                    console.log(`✓ Found: ${selector}`, element);
                    console.log(`  Tag: ${element.tagName}`);
                    console.log(`  Classes: ${element.className}`);
                    console.log(`  Value: ${element.value}`);
                    console.log(`  Min: ${element.min}, Max: ${element.max}`);
                    console.log(`  Attributes:`, [...element.attributes].map(a => `${a.name}="${a.value}"`));
                    
                    if (element.getBoundingClientRect) {
                        const rect = element.getBoundingClientRect();
                        console.log(`  Bounds: ${rect.width}x${rect.height} at (${rect.left}, ${rect.top})`);
                    }
                } else {
                    console.log(`✗ Not found: ${selector}`);
                }
            });
            
            // Check video elements
            console.log("\n--- Video Elements ---");
            const videos = document.querySelectorAll('video');
            videos.forEach((video, index) => {
                console.log(`Video ${index}:`, video);
                console.log(`  Current time: ${video.currentTime}`);
                console.log(`  Duration: ${video.duration}`);
                console.log(`  Paused: ${video.paused}`);
                console.log(`  Ready state: ${video.readyState}`);
            });
            
            // Check for YouTube APIs
            console.log("\n--- YouTube APIs ---");
            console.log("window.ytplayer:", window.ytplayer);
            
            const app = document.querySelector('ytmusic-app');
            if (app) {
                console.log("ytmusic-app found:", app);
                console.log("  playerApi_:", app.playerApi_);
                console.log("  player_:", app.player_);
            }
            
            const playerElements = document.querySelectorAll('[data-player-name]');
            console.log("Player elements:", playerElements);
            
            // Check current song data
            console.log("\n--- Current Song Data ---");
            const songData = window.ytmBeautifier.getNowPlaying();
            console.log("Song data:", songData);
            
            console.log("=== END DEBUG INFO ===");
        },
        testSeek: (targetTime = 60) => {
            console.log(`\n=== TESTING SEEK TO ${targetTime}s ===`);
            window.ytmBeautifier.debugSeek(targetTime);
            
            console.log("\nTrying seek methods...");
            const songData = window.ytmBeautifier.getNowPlaying();
            if (songData) {
                // Test each method individually
                console.log("Method 1: Progress Bar");
                tryProgressBarSeek(targetTime, songData.total);
                
                setTimeout(() => {
                    console.log("Method 2: Video Player");
                    tryVideoPlayerSeek(targetTime, songData.total);
                }, 1000);
                
                setTimeout(() => {
                    console.log("Method 3: Slider");
                    trySliderSeek(targetTime, songData.total);
                }, 2000);
            }
        }
        ,
        reattachMedia: () => { findAndAttachMediaListeners(); console.log('reattachMedia called'); }
    };

})();