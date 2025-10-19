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
    let doAnimation = gmGetValue('animation', true);
    let backgroundBlur = gmGetValue('backgroundBlur', 0.15);
    let isFullscreen = false;
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
                console.log("Lyrics response:", response.responseText);
                if (response.responseText === "no_lyrics_found" || response.responseText.includes("<title>500 Internal Server Error</title>")) {
                    console.log("No lyrics found");
                    lyrics = [];
                    times = [];
                } else {
                    try {
                        const result = JSON.parse(response.responseText);
                        const data = result["lrc"];
                        if (result["source"] === "unofficial") {
                            parseUnofficialLyrics(data);
                        } else if (result["source"] === "ytm") {
                            parseYTMLyrics(data);
                        }
                        if (times.length === 0) {
                            lyrics = [];
                            times = [];
                        }
                        initializeLyrics();
                    } catch (e) {
                        console.error("Error parsing lyrics:", e);
                        lyrics = [];
                        times = [];
                    }
                }
            },
            onerror: function(error) {
                console.error('Lyrics fetch error:', error);
                lyrics = [];
                times = [];
            }
        });
    }

    function parseUnofficialLyrics(data) {
        const allTextLines = data.split(/\r\n|\n/);
        lyrics = [];
        times = [];
        
        for (let i = 0; i < allTextLines.length; i++) {
            if (allTextLines[i].search(/^(\[)(\d*)(:)(.*)(\])(.*)/i) >= 0) {
                const line = allTextLines[i].match(/^(\[)(\d*)(:)(.*)(\])(.*)/i);
                times[i] = (parseInt(line[2]) * 60) + parseInt(line[4]);
                lyrics[i] = line[6];
            }
        }
        
        for (let i = 0; i < lyrics.length; i++) {
            if (lyrics[i] === " " || lyrics[i] === '' || lyrics[i]?.substring(1, 3) === "作曲" || lyrics[i]?.substring(1, 3) === "作词") {
                lyrics[i] = "♪♪";
            }
        }
    }

    function parseYTMLyrics(data) {
        lyrics = [];
        times = [];
        for (let i = 0; i < data.length; i++) {
            lyrics[i] = data[i].text;
            times[i] = Math.floor(data[i].time);
        }
    }

    // CSS Styles
    const styles = `
        @import url('https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&display=swap');

        #ytm-beautifier {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            background: black;
            z-index: 10000;
            font-family: "Host Grotesk", serif;
            color: white;
            display: none;
        }

        #ytm-beautifier.active {
            display: flex;
        }

        #ytm-background-canvas {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -2;
        }

        #ytm-main-content {
            position: relative;
            width: 100%;
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 5vw;
            backdrop-filter: blur(1px);
        }

        #ytm-info-panel {
            display: flex;
            flex-direction: column;
            align-items: center;
            max-width: 40vw;
            text-align: center;
        }

        #ytm-album-image {
            width: 300px;
            height: 300px;
            border-radius: 20px;
            margin-bottom: 30px;
            cursor: pointer;
            transition: transform 0.2s;
        }

        #ytm-album-image:hover {
            transform: scale(1.05);
        }

        #ytm-title {
            font-size: 2.5rem;
            font-weight: 700;
            margin-bottom: 10px;
        }

        #ytm-artist-album {
            font-size: 1.5rem;
            font-weight: 400;
            opacity: 0.8;
            margin-bottom: 30px;
        }

        #ytm-progress-container {
            width: 100%;
            height: 6px;
            background: rgba(255, 255, 255, 0.2);
            border-radius: 3px;
            margin-bottom: 20px;
            cursor: pointer;
        }

        #ytm-progress-bar {
            height: 100%;
            background: white;
            border-radius: 3px;
            width: 0%;
            transition: width 0.1s;
        }

        #ytm-controls {
            display: flex;
            align-items: center;
            gap: 30px;
        }

        .ytm-control-button {
            width: 50px;
            height: 50px;
            cursor: pointer;
            opacity: 0.8;
            transition: opacity 0.2s, transform 0.2s;
        }

        .ytm-control-button:hover {
            opacity: 1;
            transform: scale(1.1);
        }

        #ytm-lyrics-panel {
            max-width: 50vw;
            height: 70vh;
            overflow-y: auto;
            padding: 20px;
        }

        #ytm-lyrics-container {
            text-align: center;
        }

        .ytm-lyric-line {
            font-size: 2rem;
            font-weight: 500;
            opacity: 0.4;
            margin: 15px 0;
            transition: all 0.3s ease;
            cursor: pointer;
        }

        .ytm-lyric-line.active {
            opacity: 1;
            font-weight: 800;
            font-size: 2.5rem;
            transform: scale(1.1);
        }

        #ytm-toolbar {
            position: absolute;
            top: 30px;
            right: 30px;
            display: flex;
            gap: 20px;
            z-index: 1000;
        }

        .ytm-toolbar-button {
            width: 40px;
            height: 40px;
            cursor: pointer;
            opacity: 0.7;
            transition: opacity 0.2s, transform 0.2s;
        }

        .ytm-toolbar-button:hover {
            opacity: 1;
            transform: scale(1.1);
        }

        #ytm-close-button {
            position: absolute;
            top: 30px;
            left: 30px;
            font-size: 2rem;
            cursor: pointer;
            opacity: 0.7;
            transition: opacity 0.2s;
        }

        #ytm-close-button:hover {
            opacity: 1;
        }

        #ytm-launcher {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: #ff6b6b;
            color: white;
            border: none;
            border-radius: 50px;
            padding: 15px 25px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            z-index: 9999;
            box-shadow: 0 4px 20px rgba(255, 107, 107, 0.3);
            transition: all 0.3s ease;
        }

        #ytm-launcher:hover {
            background: #ff5252;
            transform: scale(1.05);
            box-shadow: 0 6px 25px rgba(255, 107, 107, 0.4);
        }

        @media (max-width: 1300px) {
            #ytm-main-content {
                flex-direction: column;
                gap: 20px;
            }
            
            #ytm-info-panel {
                max-width: 90vw;
            }
            
            #ytm-lyrics-panel {
                max-width: 90vw;
                height: 40vh;
            }
            
            #ytm-album-image {
                width: 200px;
                height: 200px;
            }
            
            #ytm-title {
                font-size: 2rem;
            }
            
            .ytm-lyric-line {
                font-size: 1.5rem;
            }
            
            .ytm-lyric-line.active {
                font-size: 1.8rem;
            }
        }

        /* Scrollbar styling */
        #ytm-lyrics-panel::-webkit-scrollbar {
            width: 6px;
        }

        #ytm-lyrics-panel::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 3px;
        }

        #ytm-lyrics-panel::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 3px;
        }

        #ytm-lyrics-panel::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.5);
        }
    `;

    gmAddStyle(styles);

    // Background Animation Class
    class BackgroundMovingImage {
        constructor(imageUrl, x, y, scale, speedX, speedY, rotationSpeed) {
            this.image = new Image();
            this.image.src = imageUrl;
            this.x = x;
            this.y = y;
            this.scale = scale;
            this.speedX = speedX;
            this.speedY = speedY;
            this.rotation = 0;
            this.rotationSpeed = rotationSpeed;
            this.canvas = document.getElementById('ytm-background-canvas');
            this.ctx = this.canvas?.getContext('2d');
        }

        updatePosition() {
            this.x += this.speedX;
            this.y += this.speedY;
            this.rotation += this.rotationSpeed;

            // Wrap around screen
            if (this.x > window.innerWidth + 100) this.x = -100;
            if (this.x < -100) this.x = window.innerWidth + 100;
            if (this.y > window.innerHeight + 100) this.y = -100;
            if (this.y < -100) this.y = window.innerHeight + 100;
        }

        draw() {
            if (!this.ctx || !this.image.complete) return;
            
            this.ctx.save();
            this.ctx.globalAlpha = 0.3;
            this.ctx.translate(this.x, this.y);
            this.ctx.rotate(this.rotation);
            this.ctx.scale(this.scale, this.scale);
            this.ctx.drawImage(this.image, -50, -50, 100, 100);
            this.ctx.restore();
        }
    }

    // Animation Management
    let backgroundImages = [];
    let animationId = null;

    function createAnimatedBackground(imageUrl) {
        if (!imageUrl) return;
        
        backgroundImages = [];
        const speedsX = [-0.15, 0.17, -0.1, 0.12, -0.15, -0.1, -0.12, -0.15, -0.17, -0.2, 0.1, 0.12, 0.15, 0.17, 0.2];
        const speedsY = [-0.15, 0.17, -0.1, 0.12, -0.15, 0.1, -0.12, 0.2, -0.17, 0.2, -0.15, 0.17, -0.1, 0.12, -0.15];
        const rotationSpeeds = [0.0001, -0.0002, 0.0003, -0.0004, 0.0005, -0.0001, 0.0002, -0.0003, 0.0004, -0.0005, -0.0003, 0.0004, -0.0005, 0.0003, -0.0004];

        for (let i = 0; i < 15; i++) {
            backgroundImages.push(new BackgroundMovingImage(
                imageUrl,
                Math.random() * window.innerWidth,
                Math.random() * window.innerHeight,
                0.8,
                speedsX[i],
                speedsY[i],
                rotationSpeeds[i]
            ));
        }
    }

    function animate() {
        if (!doAnimation || !beautifierContainer || beautifierContainer.style.display === 'none') {
            animationId = requestAnimationFrame(animate);
            return;
        }

        const canvas = document.getElementById('ytm-background-canvas');
        const ctx = canvas?.getContext('2d');
        
        if (ctx && backgroundImages.length > 0) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            backgroundImages.forEach(image => {
                image.updatePosition();
                image.draw();
            });
        }
        
        animationId = requestAnimationFrame(animate);
    }

    // Lyrics Management
    function initializeLyrics() {
        const lyricsContainer = document.getElementById('ytm-lyrics-container');
        if (!lyricsContainer) return;

        lyricsContainer.innerHTML = '';
        
        // Add padding divs
        for (let i = 0; i < 10; i++) {
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
        for (let i = 0; i < 10; i++) {
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
    }

    function triggerPrevious() {
        const prevButton = document.querySelector(".previous-button.style-scope.ytmusic-player-bar");
        prevButton?.click();
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
    function createBeautifierUI() {
        // Remove existing beautifier if present
        const existing = document.getElementById('ytm-beautifier');
        if (existing) existing.remove();

        const beautifier = document.createElement('div');
        beautifier.id = 'ytm-beautifier';
        beautifier.innerHTML = `
            <canvas id="ytm-background-canvas"></canvas>
            <div id="ytm-close-button">&times;</div>
            <div id="ytm-toolbar">
                <div class="ytm-toolbar-button" id="ytm-lyrics-toggle" title="Toggle Lyrics">🎤</div>
                <div class="ytm-toolbar-button" id="ytm-fullscreen-toggle" title="Toggle Fullscreen">⛶</div>
            </div>
            <div id="ytm-main-content" style="background-color: rgba(0, 0, 0, ${backgroundBlur});">
                <div id="ytm-info-panel">
                    <img id="ytm-album-image" src="" alt="Album Art">
                    <h1 id="ytm-title">Title</h1>
                    <h2 id="ytm-artist-album">Artist • Album</h2>
                    <div id="ytm-progress-container">
                        <div id="ytm-progress-bar"></div>
                    </div>
                    <div id="ytm-controls">
                        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHZpZXdCb3g9IjAgMCA1MCA1MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTM1IDI1TDE1IDEwVjQwTDM1IDI1WiIgZmlsbD0id2hpdGUiLz4KPHN2Zz4K" class="ytm-control-button" id="ytm-prev-button" alt="Previous">
                        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHZpZXdCb3g9IjAgMCA1MCA1MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTIwIDEwVjQwTDM1IDI1TDIwIDEwWiIgZmlsbD0id2hpdGUiLz4KPHN2Zz4K" class="ytm-control-button" id="ytm-play-button" alt="Play/Pause">
                        <img src="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHZpZXdCb3g9IjAgMCA1MCA1MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTE1IDI1TDM1IDEwVjQwTDE1IDI1WiIgZmlsbD0id2hpdGUiLz4KPHN2Zz4K" class="ytm-control-button" id="ytm-next-button" alt="Next">
                    </div>
                </div>
                <div id="ytm-lyrics-panel">
                    <div id="ytm-lyrics-container"></div>
                </div>
            </div>
        `;

        document.body.appendChild(beautifier);
        beautifierContainer = beautifier;

        // Setup canvas
        const canvas = document.getElementById('ytm-background-canvas');
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        // Event listeners
        document.getElementById('ytm-close-button').onclick = hideBeautifier;
        document.getElementById('ytm-play-button').onclick = triggerPlayPause;
        document.getElementById('ytm-prev-button').onclick = triggerPrevious;
        document.getElementById('ytm-next-button').onclick = triggerNext;
        
        document.getElementById('ytm-lyrics-toggle').onclick = () => {
            const lyricsPanel = document.getElementById('ytm-lyrics-panel');
            lyricsPanel.style.display = lyricsPanel.style.display === 'none' ? 'block' : 'none';
        };

        document.getElementById('ytm-fullscreen-toggle').onclick = toggleFullscreen;
        
        document.getElementById('ytm-progress-container').onclick = (e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const percentage = clickX / rect.width;
            // This would need more complex seeking implementation
            console.log(`Seek to ${percentage * 100}%`);
        };

        // Resize canvas on window resize
        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });

        return beautifier;
    }

    function createLauncher() {
        const launcher = document.createElement('button');
        launcher.id = 'ytm-launcher';
        launcher.textContent = '🎵 Open Beautifier';
        launcher.onclick = showBeautifier;
        document.body.appendChild(launcher);
        return launcher;
    }

    function showBeautifier() {
        if (!beautifierContainer) {
            createBeautifierUI();
        }
        beautifierContainer.classList.add('active');
        
        // Update with current song data
        const songData = getNowPlaying();
        if (songData) {
            updateUI(songData);
        }
        
        // Start animation
        if (!animationId) {
            animate();
        }
    }

    function hideBeautifier() {
        if (beautifierContainer) {
            beautifierContainer.classList.remove('active');
        }
        if (isFullscreen) {
            document.exitFullscreen();
            isFullscreen = false;
        }
    }

    function toggleFullscreen() {
        if (!isFullscreen) {
            beautifierContainer.requestFullscreen();
            isFullscreen = true;
        } else {
            document.exitFullscreen();
            isFullscreen = false;
        }
    }

    function updateUI(songData) {
        if (!songData) return;

        document.getElementById('ytm-title').textContent = songData.title;
        document.getElementById('ytm-artist-album').textContent = `${songData.artist} • ${songData.album}`;
        
        const albumImage = document.getElementById('ytm-album-image');
        if (songData.largeImage || songData.thumbnail) {
            albumImage.src = songData.largeImage || songData.thumbnail;
            createAnimatedBackground(songData.largeImage || songData.thumbnail);
        }

        // Update progress bar
        const progressBar = document.getElementById('ytm-progress-bar');
        const progressPercent = (songData.elapsed / songData.total) * 100;
        progressBar.style.width = `${progressPercent}%`;

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
            const observer = new MutationObserver(monitorYouTubeMusic);
            observer.observe(playerBar, {
                childList: true,
                subtree: true,
                attributes: true
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
                hideBeautifier();
                break;
            case ' ':
                e.preventDefault();
                triggerPlayPause();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                triggerPrevious();
                break;
            case 'ArrowRight':
                e.preventDefault();
                triggerNext();
                break;
        }
    });

    // Export for debugging
    window.ytmBeautifier = {
        show: showBeautifier,
        hide: hideBeautifier,
        getNowPlaying,
        getSongLyrics
    };

})();