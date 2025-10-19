// ==UserScript==
// @name         YouTube Music Beautifier (compact)
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @match        https://music.youtube.com/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // --- Suppress noisy network errors (lightweight) ---
    (function () {
        const noisy = msg => typeof msg === 'string' && ['XMLHttpRequest cannot load', 'Fetch API cannot load', 'Resource blocked by content blocker', 'due to access control checks'].some(p => msg.includes(p));
        const ytTelemetry = msg => typeof msg === 'string' && ['music.youtube.com/api/stats/atr', 'music.youtube.com/api/stats/qoe', 'music.youtube.com/youtubei/v1/log_event'].some(p => msg.includes(p));
        window._ytmBeautifierSuppressed = window._ytmBeautifierSuppressed || [];
        try {
            ['error', 'warn'].forEach(m => {
                const orig = console[m].bind(console);
                console[m] = (...args) => {
                    try {
                        const text = args.map(a => (typeof a === 'string' ? a : (a && a.message) ? a.message : JSON.stringify(a))).join(' ');
                        if (noisy(text) || ytTelemetry(text)) {
                            window._ytmBeautifierSuppressed.push({ t: Date.now(), args });
                            if (window._ytmBeautifierSuppressed.length > 200) window._ytmBeautifierSuppressed.shift();
                            return;
                        }
                    } catch (e) {}
                    return orig(...args);
                };
            });
        } catch (e) {}
        const origOnError = window.onerror;
        window.onerror = function (message, ...rest) {
            if (noisy(String(message))) return true;
            return typeof origOnError === 'function' ? origOnError.apply(this, [message, ...rest]) : false;
        };
        window.addEventListener('unhandledrejection', ev => {
            try {
                const r = ev?.reason; const msg = typeof r === 'string' ? r : (r && r.message) ? r.message : '';
                if (noisy(String(msg))) { ev.preventDefault(); return; }
            } catch (e) {}
        });
    })();

    // --- GM API fallbacks ---
    const gmGet = (k, d) => (typeof GM_getValue !== 'undefined' ? GM_getValue(k, d) : (localStorage.getItem('ytm_beautifier_' + k) ?? JSON.stringify(d)) && JSON.parse(localStorage.getItem('ytm_beautifier_' + k) || JSON.stringify(d)));
    const gmSet = (k, v) => (typeof GM_setValue !== 'undefined' ? GM_setValue(k, v) : localStorage.setItem('ytm_beautifier_' + k, JSON.stringify(v)));
    const gmStyle = css => (typeof GM_addStyle !== 'undefined' ? GM_addStyle(css) : document.head.appendChild(Object.assign(document.createElement('style'), { textContent: css })));
    const gmXhr = details => {
        if (typeof GM_xmlhttpRequest !== 'undefined') return GM_xmlhttpRequest(details);
        fetch(details.url, { method: details.method || 'GET', headers: details.headers || {} })
            .then(r => r.text()).then(t => details.onload && details.onload({ responseText: t })).catch(e => details.onerror && details.onerror(e));
    };

    // --- Config & state ---
    const REST_URL = "https://ytm.nwvbug.com";
    let currentSong = null, lyrics = [], times = [], offsetSec = 0, containerEl = null, currentIndex = 0, attachedMedia = null;

    // --- Utilities ---
    const toSec = s => { if (!s) return 0; const [m, sec] = s.split(':').map(x => parseInt(x, 10)); return (m||0)*60 + (sec||0); };
    const pad = s => `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
    const txt = s => (s||'').replaceAll('&amp;','&').replaceAll('&nbsp;',' ');
    const nowPlaying = () => {
        const bar = document.querySelector('ytmusic-player-bar'); if (!bar) return null;
        const title = txt(bar.querySelector('yt-formatted-string.title.ytmusic-player-bar')?.innerHTML || '');
        const thumbnail = bar.querySelector('img.ytmusic-player-bar')?.src || null;
        const byline = Array.from(document.querySelectorAll('.byline.style-scope.ytmusic-player-bar.complex-string > *')).map(n => n.innerText).join('');
        const [artist = '', album='', date=''] = byline.split('•').map(s => txt(s?.trim()));
        const left = bar.querySelector('.left-controls');
        const timeStr = left?.querySelector('span.time-info.ytmusic-player-bar')?.innerHTML?.trim(); if (!timeStr) return null;
        const [elapsed, total] = timeStr.split(' / ');
        const playBtn = left?.querySelector('#play-pause-button');
        const isPlaying = playBtn?.getAttribute('aria-label') === 'Pause';
        let largeImage = null;
        try { largeImage = document.querySelector('#thumbnail')?.children?.[0]?.src; } catch (e) {}
        return { title, artist, album, date, thumbnail, largeImage, isPlaying, elapsed: toSec(elapsed), total: toSec(total) };
    };

    // --- Lyrics fetching/parsing ---
    function fetchLyrics(title, artist, album, year, reroll=false) {
        offsetSec = 0; const base = (title + ' ' + artist + (reroll ? (' ' + album) : '') + ' ' + year).replaceAll('/','-').replaceAll('%','%25');
        gmXhr({ method: 'GET', url: `${REST_URL}/request-lyrics/${base}`, onload: r => parseLyricsResponse(r?.responseText || ''), onerror: () => { lyrics = ['Failed to fetch lyrics']; times = [0]; buildLyrics(); } });
    }
    function parseLyricsResponse(text) {
        if (!text || text === 'no_lyrics_found' || text.includes('<title>500')) { lyrics = ['No lyrics available']; times = [0]; return buildLyrics(); }
        try {
            const res = JSON.parse(text);
            const data = res.lrc;
            if (res.source === 'unofficial' && typeof data === 'string') return parseLRC(data);
            if (res.source === 'ytm' && Array.isArray(data)) return parseYtm(data);
        } catch (e) {}
        lyrics = ['Error loading lyrics']; times = [0]; buildLyrics();
    }
    function parseLRC(txtLrc) {
        const lines = txtLrc.split(/\r?\n/);
        lyrics = []; times = [];
        lines.forEach(l => {
            const m = l.match(/^\[(\d+):(\d+)\](.*)$/);
            if (m) { times.push(parseInt(m[1],10)*60 + parseInt(m[2],10)); lyrics.push(m[3].trim() || '♪♪'); }
        });
        sanitizeAndBuild();
    }
    function parseYtm(arr) {
        lyrics = arr.map(a => (a.text && a.text.trim()) ? a.text : '♪♪');
        times = arr.map(a => Math.floor(a.time||0));
        sanitizeAndBuild();
    }
    function sanitizeAndBuild() { if (lyrics.length===0) { lyrics=['Lyrics parsing failed']; times=[0]; } buildLyrics(); }

    // --- UI styles (minified-ish) ---
    gmStyle(`@import url('https://fonts.googleapis.com/css2?family=Host+Grotesk:ital,wght@0,300..800;1,300..800&display=swap');
#ytm-lyrics-card{position:fixed;top:20px;right:20px;width:350px;max-height:80vh;background:rgba(0,0,0,.85);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);border-radius:16px;font-family:Host Grotesk,serif;color:#fff;z-index:10000;display:none;flex-direction:column;box-shadow:0 8px 32px rgba(0,0,0,.3);transition:all .3s}
#ytm-lyrics-card.active{display:flex}
#ytm-lyrics-header{padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;justify-content:space-between;align-items:center;cursor:grab}
#ytm-song-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ytm-song-artist{font-size:12px;opacity:.7}
.ytm-mini-control{width:28px;height:28px;border-radius:50%;background:rgba(255,255,255,.1);border:none;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:12px}
#ytm-lyrics-content{flex:1;overflow:auto;padding:20px;text-align:center}
.ytm-lyric-line{font-size:14px;opacity:.4;margin:12px 0;transition:all .25s;cursor:pointer;padding:8px 12px;border-radius:8px}
.ytm-lyric-line.active{opacity:1;font-weight:600;color:#ff6b6b;transform:scale(1.03);background:rgba(255,107,107,.06)}
#ytm-launcher{position:fixed;top:100px;right:20px;background:linear-gradient(135deg,#ff6b6b,#ff5252);color:#fff;border:none;border-radius:999px;padding:10px 14px;font-weight:700;cursor:pointer;z-index:99999;display:inline-flex;align-items:center;gap:10px;backdrop-filter:blur(6px);box-shadow:0 8px 30px rgba(0,0,0,.35)}
@media(max-width:768px){#ytm-lyrics-card{width:300px;right:10px;top:10px;max-height:70vh}#ytm-launcher{top:10px;right:10px;padding:8px 12px}}`);

    // --- Build UI ---
    function buildLyricsCard() {
        const old = document.getElementById('ytm-lyrics-card'); if (old) old.remove();
        const card = document.createElement('div'); card.id = 'ytm-lyrics-card';
        const header = document.createElement('div'); header.id = 'ytm-lyrics-header';
        const info = document.createElement('div'); info.style.minWidth = 0;
        const t = document.createElement('div'); t.id = 'ytm-song-title'; t.textContent = 'No song playing';
        const a = document.createElement('div'); a.id = 'ytm-song-artist'; a.textContent = 'YouTube Music';
        info.appendChild(t); info.appendChild(a);
        const ctr = document.createElement('div'); ctr.id = 'ytm-lyrics-controls';
        const minB = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', id: 'ytm-minimize-btn', title: 'Minimize', textContent: '−' });
        const closeB = Object.assign(document.createElement('button'), { className: 'ytm-mini-control', id: 'ytm-close-btn', title: 'Close', textContent: '×' });
        ctr.appendChild(minB); ctr.appendChild(closeB);
        header.appendChild(info); header.appendChild(ctr);
        const content = document.createElement('div'); content.id = 'ytm-lyrics-content';
        content.appendChild(Object.assign(document.createElement('div'), { className: 'ytm-lyric-line', textContent: '🎵 Loading lyrics...' }));
        card.appendChild(header); card.appendChild(content); document.body.appendChild(card); containerEl = card;

        // dragging
        let dragging=false, ix=0,iy=0,xo=0,yo=0;
        header.addEventListener('mousedown', e => { ix = e.clientX - xo; iy = e.clientY - yo; if (e.target===header||e.target.closest('#ytm-song-title')) dragging=true; });
        document.addEventListener('mousemove', e => { if (!dragging) return; e.preventDefault(); const cx = e.clientX - ix, cy = e.clientY - iy; xo=cx; yo=cy; card.style.transform = `translate3d(${cx}px, ${cy}px,0)`; });
        document.addEventListener('mouseup', () => dragging=false);

        closeB.onclick = hide; minB.onclick = () => { const c = document.getElementById('ytm-lyrics-content'); if (!c) return; if (c.style.display==='none') { c.style.display='block'; minB.textContent='−'; minB.title='Minimize'; } else { c.style.display='none'; minB.textContent='+'; minB.title='Expand'; } };
        return card;
    }

    function createLauncher() {
        if (document.getElementById('ytm-launcher')) return;
        const btn = document.createElement('button'); btn.id='ytm-launcher'; btn.title='Show lyrics';
        const svg = document.createElementNS('http://www.w3.org/2000/svg','svg'); svg.setAttribute('width','18'); svg.setAttribute('height','18'); svg.setAttribute('viewBox','0 0 24 24');
        const p1 = document.createElementNS(svg.namespaceURI,'path'); p1.setAttribute('d','M4 6H20V18H8L4 22V6Z'); p1.setAttribute('fill','white'); p1.setAttribute('opacity','0.95');
        const p2 = document.createElementNS(svg.namespaceURI,'path'); p2.setAttribute('d','M7 9H17'); p2.setAttribute('stroke','rgba(0,0,0,0.12)'); p2.setAttribute('stroke-width','1.5'); p2.setAttribute('stroke-linecap','round');
        svg.appendChild(p1); svg.appendChild(p2);
        const span = document.createElement('span'); span.textContent='Lyrics';
        btn.appendChild(svg); btn.appendChild(span); btn.onclick = show; document.body.appendChild(btn);
        return btn;
    }

    function buildLyrics() {
        const content = document.getElementById('ytm-lyrics-content'); if (!content) return;
        content.textContent = '';
        for (let i=0;i<3;i++) content.appendChild(document.createElement('div'));
        lyrics.forEach((l,i) => {
            const d = document.createElement('div'); d.className='ytm-lyric-line'; d.id=`ytm-lyric-${i}`; d.textContent = l; d.title = `Click to seek to: ${pad(times[i]||0)}`;
            d.onclick = () => seekTo(i);
            content.appendChild(d);
        });
        for (let i=0;i<3;i++) content.appendChild(document.createElement('div'));
        currentIndex = 0;
    }

    // --- Seeking helpers (attempts in order) ---
    function seekTo(i) {
        if (times[i]===undefined) return;
        const el = document.getElementById(`ytm-lyric-${i}`);
        if (el) { el.classList.add('seeking'); setTimeout(()=>el.classList.remove('seeking'),500); }
        simulateSeek(times[i]);
        currentIndex = i;
        document.querySelectorAll('.ytm-lyric-line').forEach(n=>n.classList.remove('active'));
        if (el) { el.classList.add('active'); el.scrollIntoView({ behavior:'smooth', block:'center' }); }
    }

    function simulateSeek(target) {
        const song = nowPlaying(); if (!song) return;
        const diff = target - song.elapsed;
        if (Math.abs(diff) < 0.8) return;
        if (tryMediaSeek(target)) return;
        if (tryAppAPI(target)) return;
        if (tryProgressSeek(target, song.total)) return;
        if (tryVideoSeek(target, song.total)) return;
        keyboardFallback(diff);
    }

    function tryMediaSeek(target) {
        try {
            const media = Array.from(document.querySelectorAll('video,audio')).filter(m=>m&&m.duration>0&&m.offsetParent!==null)[0];
            if (!media) return false;
            try { media.currentTime = target; } catch(e) {}
            ['seeking','timeupdate','seeked'].forEach(evt => media.dispatchEvent(new Event(evt)));
            return true;
        } catch (e) { return false; }
    }

    function tryAppAPI(target) {
        try {
            const app = document.querySelector('ytmusic-app');
            const cands = [app?.playerApi_, app?.player_, app?.playerApi, app?.appContext_?.playerApi, window.ytplayer, window.yt?.player];
            for (const api of cands) {
                if (!api) continue;
                if (typeof api.seekTo==='function') { try { api.seekTo(target); return true; } catch(e){} }
                if (typeof api.setCurrentTime==='function') { try { api.setCurrentTime(target); return true; } catch(e){} }
                if (api.player && typeof api.player.seekTo==='function') { try { api.player.seekTo(target); return true; } catch(e){} }
            }
        } catch (e) {}
        return false;
    }

    function tryProgressSeek(target, total) {
        if (!total || total <= 0) return false;
        const selectors = ['#progress-bar','.progress-bar','tp-yt-paper-slider#progress-bar','.ytmusic-player-bar #progress-bar','[role="slider"]'];
        for (const sel of selectors) {
            const el = document.querySelector(sel); if (!el) continue;
            const pct = target / total;
            // direct set if available
            try {
                if (el.value !== undefined) {
                    const v = pct*100; el.value = v; ['input','change','slide','iron-change'].forEach(t=> el.dispatchEvent(new CustomEvent(t,{bubbles:true,detail:{value:v}})));
                    if (el.value == v) return true;
                }
                if (el._setValue) { el._setValue(pct*100); return true; }
                if (el.immediateValue !== undefined) { el.immediateValue = pct*100; el.value = pct*100; return true; }
                // pointer events
                const r = el.getBoundingClientRect(), x = r.left + r.width * pct, y = r.top + r.height/2;
                ['pointerdown','mousedown','pointermove','mousemove','pointerup','mouseup','click'].forEach(t=>{
                    const ev = t.startsWith('pointer') ? new PointerEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,isPrimary:true,pointerId:1}) : new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y,button:0});
                    el.dispatchEvent(ev);
                });
                return true;
            } catch (e) {}
        }
        return false;
    }

    function tryVideoSeek(target) {
        try {
            const videos = document.querySelectorAll('video');
            for (const v of videos) {
                if (v && !isNaN(v.duration) && v.duration>0) {
                    try { v.currentTime = target; v.dispatchEvent(new Event('timeupdate')); v.dispatchEvent(new Event('seeked')); return true; } catch(e) {}
                }
            }
            // try youtube API fallbacks
            const players = document.querySelectorAll('[data-player-name]');
            for (const p of players) if (typeof p.seekTo==='function') { try { p.seekTo(target); return true; } catch(e) {} }
            if (window.ytplayer?.seekTo) { try { window.ytplayer.seekTo(target); return true; } catch(e) {} }
        } catch (e) {}
        return false;
    }

    function keyboardFallback(diff) {
        const interval = 10, count = Math.min(10, Math.floor(Math.abs(diff)/interval));
        if (count===0) return;
        const key = diff>0 ? 'ArrowRight' : 'ArrowLeft';
        const target = document.querySelector('ytmusic-player-bar') || document.body;
        for (let i=0;i<count;i++) setTimeout(()=> target.dispatchEvent(new KeyboardEvent('keydown',{key,code:key,bubbles:true,cancelable:true})), i*100);
    }

    // --- Lyrics update & media listener attachment ---
    function updateLyricsDisplay(sec) {
        if (!times.length) return;
        const lines = document.querySelectorAll('.ytm-lyric-line');
        let idx = 0;
        for (let i=0;i<times.length;i++) { if (sec >= times[i]) idx = i; else break; }
        if (idx !== currentIndex) {
            lines.forEach(l => l.classList.remove('active'));
            if (lines[idx]) { lines[idx].classList.add('active'); lines[idx].scrollIntoView({ behavior:'smooth', block:'center' }); }
        }
        currentIndex = idx;
    }

    function attachMediaListeners() {
        try {
            const media = Array.from(document.querySelectorAll('video,audio')).filter(m=>m&&m.duration>0&&m.offsetParent!==null)[0] || null;
            if (media === attachedMedia) return;
            if (attachedMedia) try { attachedMedia.removeEventListener('timeupdate', onMediaTime); attachedMedia.removeEventListener('seeked', onMediaSeek); } catch(e){}
            attachedMedia = media;
            if (!attachedMedia) return;
            attachedMedia.addEventListener('timeupdate', onMediaTime);
            attachedMedia.addEventListener('seeked', onMediaSeek);
        } catch (e) {}
    }
    function onMediaTime(e) { try { const t = Math.floor(e.target.currentTime||0); updateLyricsDisplay(t - offsetSec); if (currentSong) currentSong.elapsed = t; } catch(e){} }
    function onMediaSeek(e) { try { const t = Math.floor(e.target.currentTime||0); currentIndex = 0; updateLyricsDisplay(t - offsetSec); if (currentSong) currentSong.elapsed = t; } catch(e){} }

    // --- UI show/hide/update ---
    function show() {
        if (!containerEl) buildLyricsCard();
        const launcher = document.getElementById('ytm-launcher'); if (launcher && containerEl) {
            const rect = launcher.getBoundingClientRect(), margin = 8;
            containerEl.classList.add('active'); containerEl.style.transform='none';
            const computedRight = Math.max(8, Math.round(window.innerWidth - rect.right));
            let computedTop = Math.round(rect.bottom + margin);
            const cardH = containerEl.offsetHeight || 300, maxTop = Math.max(8, window.innerHeight - cardH - 10);
            if (computedTop > maxTop) computedTop = maxTop;
            containerEl.style.top = computedTop + 'px'; containerEl.style.right = computedRight + 'px';
        } else containerEl && containerEl.classList.add('active');
        const song = nowPlaying(); if (song) updateUI(song);
    }
    function hide() { containerEl && containerEl.classList.remove('active'); }

    function updateUI(song) {
        if (!song) return;
        const titleEl = document.getElementById('ytm-song-title'), artistEl = document.getElementById('ytm-song-artist');
        if (titleEl) titleEl.textContent = song.title || 'Unknown Title';
        if (artistEl) artistEl.textContent = song.artist || 'Unknown Artist';
        const adjusted = (song.elapsed || 0) - offsetSec;
        updateLyricsDisplay(adjusted);
        const id = (song.title||'') + (song.artist||'') + (song.album||'');
        if ((currentSong?.title||'') + (currentSong?.artist||'') + (currentSong?.album||'') !== id) {
            currentSong = song; lyrics = []; times = []; fetchLyrics(song.title, song.artist, song.album, song.date);
            offsetSec = gmGet(`offset_${id}`, 0) || 0;
        }
    }

    // --- Monitor & init ---
    function monitor() {
        const s = nowPlaying();
        if (s && containerEl && containerEl.classList.contains('active')) updateUI(s);
        attachMediaListeners();
    }

    function init() {
        createLauncher();
        setInterval(monitor, 2000);
        const bar = document.querySelector('ytmusic-player-bar');
        if (bar) {
            let to; new MutationObserver(() => { clearTimeout(to); to = setTimeout(()=>{ monitor(); }, 500); }).observe(bar,{ childList:true, subtree:true, attributes:true, attributeFilter:['aria-label','src'] });
        }
        attachMediaListeners();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else setTimeout(init, 1000);

    // keyboard
    document.addEventListener('keydown', e => {
        if (!containerEl || !containerEl.classList.contains('active')) return;
        if (e.key === 'Escape') hide();
        if ((e.key === 'l' || e.key === 'L') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); show(); }
    });

    // exposed API for debugging/testing
    window.ytmBeautifier = {
        show, hide, getNowPlaying: nowPlaying, getSongLyrics: fetchLyrics,
        reattachMedia: () => { attachMediaListeners(); console.log('reattachMedia called'); },
        debugSeek: target => {
            console.log('Target', target);
            ['#progress-bar','.progress-bar','tp-yt-paper-slider#progress-bar','.ytmusic-player-bar #progress-bar','[role="slider"]'].forEach(s => console.log(s, document.querySelector(s)));
            document.querySelectorAll('video').forEach((v,i)=>console.log(i,v.currentTime,v.duration,v.paused));
            console.log('ytplayer', window.ytplayer, 'ytmusic-app', document.querySelector('ytmusic-app'));
            console.log('song', nowPlaying());
        },
        testSeek: (t=60) => { console.log('Testing seek to', t); const s = nowPlaying(); if (s) { tryProgressSeek(t, s.total); setTimeout(()=>tryVideoSeek(t), 800); setTimeout(()=>{ try { document.querySelector('tp-yt-paper-slider')?.setAttribute('value', ((t/s.total)*100).toString()); } catch(e){} }, 1600); } }
    };

})();
