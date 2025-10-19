// ==UserScript==
// @name         YouTube Music Beautifier
// @namespace    http://tampermonkey.net/
// @version      1.0.0
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
        }

        .ytm-lyric-line.active {
            opacity: 1;
            font-weight: 600;
            font-size: 16px;
            color: #ff6b6b;
            transform: scale(1.05);
        }

        .ytm-lyric-line:hover {
            opacity: 0.8;
        }

        #ytm-launcher {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #ff6b6b;
            color: white;
            border: none;
            border-radius: 50px;
            padding: 12px 20px;
            font-size: 14px;
            font-weight: 600;
            cursor: pointer;
            z-index: 9999;
            box-shadow: 0 4px 20px rgba(255, 107, 107, 0.3);
            transition: all 0.3s ease;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        #ytm-launcher:hover {
            background: #ff5252;
            transform: scale(1.05);
            box-shadow: 0 6px 25px rgba(255, 107, 107, 0.4);
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
                bottom: 10px;
                right: 10px;
                padding: 10px 16px;
                font-size: 12px;
            }
        }
    `;

    gmAddStyle(styles);

    // Lyrics Management
    function initializeLyrics() {
        const lyricsContainer = document.getElementById('ytm-lyrics-content');
        if (!lyricsContainer) return;

        lyricsContainer.innerHTML = '';
        
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
            // Simulate seeking by triggering keyboard shortcuts
            simulateSeek(targetTime);
        }
    }

    function simulateSeek(targetTime) {
        // This is a simplified seek - in reality you'd need to calculate the difference
        // and simulate multiple forward/backward key presses
        console.log(`Seeking to ${targetTime} seconds`);
    }

    function updateLyrics(currentSeconds) {
        if (times.length === 0) return;

        // Handle rewind
        if (currentSeconds < currentTime) {
            const lyricLines = document.querySelectorAll('.ytm-lyric-line');
            lyricLines.forEach(line => line.classList.remove('active'));
            currentIndex = 0;
            
            for (let i = 0; i < times.length; i++) {
                if (currentSeconds >= times[i]) {
                    currentIndex = i;
                } else {
                    break;
                }
            }
            
            if (currentIndex < lyricLines.length) {
                lyricLines[currentIndex].classList.add('active');
                lyricLines[currentIndex].scrollIntoView({ 
                    behavior: 'smooth', 
                    block: 'center' 
                });
            }
        }

        currentTime = currentSeconds;

        // Handle forward progression
        if (currentIndex < times.length && currentSeconds >= times[currentIndex]) {
            const lyricLines = document.querySelectorAll('.ytm-lyric-line');
            
            // Remove previous highlight
            if (currentIndex > 0) {
                lyricLines[currentIndex - 1]?.classList.remove('active');
            }
            
            // Add current highlight
            lyricLines[currentIndex]?.classList.add('active');
            lyricLines[currentIndex]?.scrollIntoView({ 
                behavior: 'smooth', 
                block: 'center' 
            });
            
            currentIndex++;
        }
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
        lyricsCard.innerHTML = `
            <div id="ytm-lyrics-header">
                <div id="ytm-song-info">
                    <div id="ytm-song-title">No song playing</div>
                    <div id="ytm-song-artist">YouTube Music</div>
                </div>
                <div id="ytm-lyrics-controls">
                    <button class="ytm-mini-control" id="ytm-minimize-btn" title="Minimize">−</button>
                    <button class="ytm-mini-control" id="ytm-close-btn" title="Close">&times;</button>
                </div>
            </div>
            <div id="ytm-lyrics-content">
                <div class="ytm-lyric-line">🎵 Loading lyrics...</div>
            </div>
        `;

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

        const header = document.getElementById('ytm-lyrics-header');
        
        header.addEventListener('mousedown', (e) => {
            initialX = e.clientX - xOffset;
            initialY = e.clientY - yOffset;
            
            if (e.target === header || e.target.closest('#ytm-song-info')) {
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
        launcher.innerHTML = '� <span>Lyrics</span>';
        launcher.onclick = showLyricsCard;
        document.body.appendChild(launcher);
        return launcher;
    }

    function showLyricsCard() {
        if (!beautifierContainer) {
            createLyricsCard();
        }
        beautifierContainer.classList.add('active');
        
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
            minimizeBtn.innerHTML = '−';
            minimizeBtn.title = 'Minimize';
        } else {
            content.style.display = 'none';
            minimizeBtn.innerHTML = '+';
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

    // Force refresh function for manual updates
    function forceRefresh() {
        setTimeout(() => {
            const songData = getNowPlaying();
            if (songData && beautifierContainer && beautifierContainer.classList.contains('active')) {
                console.log("Force refreshing song data:", songData.title);
                updateUI(songData);
            }
        }, 100);
    }

    // Initialize
    function init() {
        console.log("[YouTube Music Beautifier Userscript] Starting...");
        
        // Create launcher button
        createLauncher();
        
        // Start monitoring
        setInterval(monitorYouTubeMusic, 1000);
        
        // Watch for DOM changes
        const playerBar = document.querySelector("ytmusic-player-bar");
        if (playerBar) {
            const observer = new MutationObserver(() => {
                monitorYouTubeMusic();
                // Additional check for song changes
                forceRefresh();
            });
            observer.observe(playerBar, {
                childList: true,
                subtree: true,
                attributes: true
            });
        }

        // Also watch the main content area for navigation changes
        const mainContent = document.querySelector('#main-panel');
        if (mainContent) {
            const contentObserver = new MutationObserver(forceRefresh);
            contentObserver.observe(mainContent, {
                childList: true,
                subtree: false
            });
        }

        console.log("[YouTube Music Beautifier Userscript] Initialized!");
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
        getSongLyrics
    };

})();