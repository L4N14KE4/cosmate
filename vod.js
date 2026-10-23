// Runs on every page (top frame) after content.js (shares cfg, ready, parsed, siteActive, onEach,
// toast, notice, css, DL_SVG), but only does anything where the site is switched on.

const VOD_NOTICE = `강의 다운로드는 개인 학습(복습) 목적으로만 사용해야 합니다.

· 강의 영상의 저작권은 교수자와 학교에 있습니다.
· 내려받은 파일을 다른 사람에게 공유하거나 인터넷에 올리면 안 됩니다.
· 내려받은 파일로 시청한 시간은 출석·진도율에 반영되지 않습니다.`;

css.textContent += `
  .cmx-vod-dl { position: relative; }
  .cmx-vod-dl > summary { list-style: none; cursor: pointer; }
  .cmx-vod-dl > summary::-webkit-details-marker { display: none; }
  .cmx-vod-dl .dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 0; width: max-content; }
  .cmx-vod-dl .dropdown-item { padding-right: 14px; } /* the site's item is 14px left, 8px right */
  /* Download toast: the site's .toast-text is a centered flex row, so stack the bar under the text. */
  .cmx-dl-toast .toast-text { flex-direction: column; font-variant-numeric: tabular-nums; }
  .cmx-dl-progress { align-self: stretch; height: 4px; margin-top: 8px; }
  .cmx-dl-progress .progress-bar { background-color: #1181f9; } /* the site's default bar is orange */

  /* Speed panel: dark overlay like the player's own menus, laid out like YouTube's speed sheet. */
  .video-js.cmx-speed .vjs-playback-rate .vjs-menu { display: none !important; }
  .cmx-speed-panel { position: absolute; right: 8px; bottom: 56px; z-index: 10; box-sizing: border-box;
    width: min(300px, calc(100% - 16px)); padding: 14px 16px 16px; border-radius: 16px;
    background: rgba(0, 0, 0, .88); color: #fff; font-size: 14px; line-height: 1.4;
    font-family: "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
  .cmx-speed-panel[hidden] { display: none; }
  .cmx-speed-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
  .cmx-speed-head b { font-size: 20px; font-weight: 700; }
  .cmx-speed-row { display: flex; align-items: center; gap: 10px; }
  .cmx-speed-row input { flex: 1; min-width: 0; accent-color: #1181f9; }
  /* .video-js prefix: the site's own button reset would otherwise win on specificity. */
  .video-js .cmx-speed-panel button { border: 0; border-radius: 999px; background: #2c2f32; color: #fff; font: inherit; cursor: pointer; }
  .video-js .cmx-speed-panel button:hover { background: #3d4146; }
  .cmx-speed-row button { flex: none; width: 30px; height: 30px; font-size: 18px; line-height: 1; }
  .cmx-speed-chips { display: flex; gap: 6px; margin-top: 12px; }
  .cmx-speed-chips button { flex: 1; padding: 7px 0; font-size: 13px; }
  .video-js .cmx-speed-chips button.on { background: #1181f9; }

  /* The site sizes control-bar icons with this variable (18px), which beats a width attribute;
     22px makes ours match the font icons next to it. */
  .cmx-pip { display: flex; align-items: center; justify-content: center; --csms-btn-icon-svg-size: 22px; }
  .cmx-pip svg { pointer-events: none; }
`;

const vodName = () => document.querySelector('a.vod-item-container.active .vod-info-title')?.textContent.trim() || document.title;

// 5. 강의 다운로드 ---------------------------------------------------------------

async function segmentUrls() {
  const setup = JSON.parse(document.querySelector('[data-setup-lazy]').dataset.setupLazy);
  let url = [].concat(setup.sources)[0].src;
  let text = await (await fetch(url)).text();
  if (text.includes('#EXT-X-STREAM-INF')) { // master playlist: take the highest bandwidth variant
    const best = [...text.matchAll(/BANDWIDTH=(\d+)[^\n]*\n([^\n#]+)/g)].sort((a, b) => b[1] - a[1])[0];
    url = new URL(best[2].trim(), url).href;
    text = await (await fetch(url)).text();
  }
  const lines = text.split('\n').map(l => l.trim());
  return {
    urls: lines.filter(l => l && !l.startsWith('#')).map(l => new URL(l, url).href),
    seconds: lines.reduce((s, l) => s + Number(/^#EXTINF:([\d.]+)/.exec(l)?.[1] ?? 0), 0),
  };
}

// Yields segment bytes in order with a few requests in flight, until signal aborts.
async function* segments(urls, signal, onSegment) {
  const get = u => fetch(u, { signal }).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
  const q = [];
  const want = i => {
    if (i >= urls.length) return;
    const p = get(urls[i]).catch(e => (signal.aborted ? Promise.reject(e) : get(urls[i]))); // one retry per segment
    p.catch(() => {}); // requests still in flight after a cancel must not log as unhandled
    q.push(p);
  };
  for (let i = 0; i < 4; i++) want(i);
  for (let i = 0; i < urls.length; i++) {
    want(i + 4);
    const seg = new Uint8Array(await q[i]);
    signal.throwIfAborted();
    yield seg;
    onSegment?.(i + 1);
  }
}

// TS → fragmented MP4 without re-encoding. Remuxing keeps pace with the download, so progress
// is segments received.
async function toMp4(urls, signal, onProgress) {
  const parts = [];
  const tm = new muxjs.mp4.Transmuxer();
  tm.on('data', s => {
    if (!parts.length) parts.push(new Blob([s.initSegment]));
    parts.push(new Blob([s.data]));
  });
  for await (const seg of segments(urls, signal, n => onProgress(n / urls.length))) {
    tm.push(seg);
    tm.flush();
  }
  return parts;
}

// ponytail: lectures are speech, so downmix to mono 96kbps; halves lamejs encode time
// (~4 min for a 55 min lecture). Make channels/bitrate an option if music matters.
function mono(a) {
  const ch = Array.from({ length: a.numberOfChannels }, (_, c) => {
    const f = new Float32Array(a.numberOfFrames);
    a.copyTo(f, { planeIndex: c, format: 'f32-planar' });
    return f;
  });
  const out = new Int16Array(a.numberOfFrames);
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (const f of ch) s += f[i];
    out[i] = Math.max(-1, Math.min(1, s / ch.length)) * 0x7fff;
  }
  return out;
}

// TS → AAC frames (mux.js) → PCM (WebCodecs) → MP3 (lamejs), one segment at a time.
// The download finishes long before the encoding, so progress = seconds of audio encoded.
async function toMp3(urls, seconds, signal, onProgress) {
  const parts = [];
  const ts = new muxjs.mp2t.TransportPacketStream();
  const adts = new muxjs.codecs.Adts();
  ts.pipe(new muxjs.mp2t.TransportParseStream()).pipe(new muxjs.mp2t.ElementaryStream()).pipe(adts);
  let enc, dec, time = 0;
  // Closing the decoder drops its queue and makes the flush() below reject.
  signal.addEventListener('abort', () => dec && dec.state !== 'closed' && dec.close(), { once: true });
  adts.on('data', f => {
    if (!dec) {
      const sfi = f.samplingfrequencyindex;
      enc = new lamejs.Mp3Encoder(1, f.samplerate, 96);
      dec = new AudioDecoder({
        output: a => {
          parts.push(new Blob([enc.encodeBuffer(mono(a))]));
          onProgress((a.timestamp + a.duration) / 1e6 / seconds);
          a.close();
        },
        error: e => console.error(e), // a failed decoder also makes flush() below reject
      });
      dec.configure({
        codec: 'mp4a.40.' + f.audioobjecttype,
        sampleRate: f.samplerate,
        numberOfChannels: f.channelcount,
        description: new Uint8Array([(f.audioobjecttype << 3) | (sfi >> 1), ((sfi & 1) << 7) | (f.channelcount << 3)]),
      });
    }
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: time, data: f.data }));
    time += (1024 * 1e6) / f.samplerate;
  });
  for await (const seg of segments(urls, signal)) ts.push(seg);
  ts.flush();
  if (!dec) throw new Error('오디오 트랙을 찾지 못했습니다.');
  await dec.flush();
  parts.push(new Blob([enc.flush()]));
  return parts;
}

// ponytail: the whole file is held as Blobs (Chrome pages large blobs to disk);
// switch to showSaveFilePicker streaming if very long lectures run out of memory.
function save(parts, type, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(parts, { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// mux.js + lamejs are ~270KB and this script now loads on every page, so they're injected
// by background.js on demand instead of with the page.
async function loadLibs() {
  if (typeof muxjs !== 'undefined' && typeof lamejs !== 'undefined') return;
  if (!(await chrome.runtime.sendMessage({ loadLibs: true }))) throw new Error('변환 라이브러리를 불러오지 못했습니다.');
}

const timeLeft = s => (s < 60 ? `${Math.max(10, Math.ceil(s / 10) * 10)}초` : `약 ${Math.round(s / 60)}분`);

let busy = false;
async function downloadVod(fmt) {
  if (busy) return toast('이미 다운로드 중입니다.', 'warning');
  if (!(await notice('vod', '강의 다운로드 안내', VOD_NOTICE))) return;
  busy = true;
  const ctl = new AbortController();
  // Site toast + Bootstrap progress bar under the text, cancel button on the right.
  const t = toast('', 'guide', 0);
  t.classList.add('cmx-dl-toast');
  t.querySelector('.toast-text').innerHTML = `<span></span>
    <div class="progress cmx-dl-progress" role="progressbar" aria-label="다운로드 진행도" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar" style="width: 0%"></div></div>`;
  const [text, bar] = t.querySelectorAll('.toast-text span, .progress');
  text.textContent = '강의 정보를 불러오는 중…';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-secondary ms-3';
  cancel.textContent = '취소';
  cancel.onclick = () => {
    cancel.disabled = true;
    ctl.abort();
  };
  t.querySelector('.toast-body').append(cancel);

  let start, shown = -1;
  const progress = f => {
    const p = Math.min(99, Math.floor(f * 100)); // 100% only once the file is saved
    if (p === shown) return; // the MP3 encoder reports every ~20ms of audio
    shown = p;
    // Time left from the pace so far; skipped until there is enough to go on.
    const left = f > 0.02 && (((performance.now() - start) / 1000) * (1 - f)) / f;
    text.textContent = `${fmt.toUpperCase()} 파일을 만드는 중… ${p}%${left ? ` · ${timeLeft(left)} 남음` : ''} (이 탭을 닫지 마세요)`;
    bar.firstElementChild.style.width = `${p}%`;
    bar.setAttribute('aria-valuenow', p);
  };
  try {
    await loadLibs();
    const { urls, seconds } = await segmentUrls();
    ctl.signal.throwIfAborted();
    start = performance.now();
    progress(0);
    const parts = await (fmt === 'mp4' ? toMp4(urls, ctl.signal, progress) : toMp3(urls, seconds, ctl.signal, progress));
    save(parts, fmt === 'mp4' ? 'video/mp4' : 'audio/mpeg', `${vodName().replace(/[\\/:*?"<>|]/g, '_')}.${fmt}`);
  } catch (e) {
    if (ctl.signal.aborted) toast('다운로드를 취소했습니다.', 'guide');
    else toast(`다운로드에 실패했습니다: ${e.message}`, 'danger', 8000);
  } finally {
    t.remove();
    busy = false;
  }
}

// The site's buttons get Bootstrap tooltips, but Bootstrap sets those up in the page before our
// button exists. So build the same markup it produces (the site's CSS styles it) on hover/focus.
function tooltip(el, text) {
  let tip;
  const show = () => {
    if (tip) return;
    tip = document.createElement('div');
    tip.className = 'tooltip bs-tooltip-auto fade';
    tip.setAttribute('role', 'tooltip');
    tip.dataset.popperPlacement = 'top';
    tip.innerHTML = '<div class="tooltip-arrow" style="position:absolute;left:0"></div><div class="tooltip-inner"></div>';
    tip.lastChild.textContent = text;
    // Pin it to the page's corner first: unplaced, its width would stretch to the whole page.
    tip.style.cssText = 'position:absolute;inset:0 auto auto 0;margin:0';
    document.body.append(tip);
    const r = el.getBoundingClientRect(), w = tip.offsetWidth;
    // Document coordinates, 6px above the button like Bootstrap's own offset.
    tip.style.transform = `translate3d(${r.left + scrollX + (r.width - w) / 2}px,${r.top + scrollY - tip.offsetHeight - 6}px,0)`;
    tip.firstChild.style.transform = `translate3d(${(w - 12.8) / 2}px,0,0)`; // 12.8px = arrow width
    requestAnimationFrame(() => tip?.classList.add('show'));
  };
  const hide = () => {
    const old = tip;
    tip = null;
    old?.classList.remove('show');
    setTimeout(() => old?.remove(), 150);
  };
  el.addEventListener('mouseenter', show);
  el.addEventListener('focus', show);
  el.addEventListener('mouseleave', hide);
  el.addEventListener('blur', hide);
}

function addDownloadMenu(box) {
  const d = document.createElement('details');
  d.className = 'cmx-vod-dl';
  d.innerHTML = `<summary class="btn-csms-svgicon-circle btn-csms-svgicon-circle-help" aria-label="강의 다운로드">${DL_SVG}</summary>
    <div class="dropdown-menu dropdown-menu-end show">
      <button type="button" class="dropdown-item" data-fmt="mp4">동영상 (MP4)</button>
      <button type="button" class="dropdown-item" data-fmt="mp3">오디오 (MP3)</button>
    </div>`;
  tooltip(d.querySelector('summary'), '강의 다운로드');
  d.querySelector('.dropdown-menu').addEventListener('click', e => {
    const fmt = e.target.closest('[data-fmt]')?.dataset.fmt;
    if (!fmt) return;
    d.open = false;
    downloadVod(fmt);
  });
  document.addEventListener('click', e => d.contains(e.target) || (d.open = false));
  box.prepend(d);
}

// 6. 강의 종료 알림 · 다음 영상 -----------------------------------------------------

// Chrome only lets a page make sound after the user has clicked or typed on it; without that
// the AudioContext stays suspended and logs a warning. The system notification still fires.
function chime() {
  if (!navigator.userActivation.hasBeenActive) return;
  const ac = new AudioContext();
  [880, 1320].forEach((hz, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    const t = ac.currentTime + i * 0.18;
    o.frequency.value = hz;
    g.gain.setValueAtTime(0.25, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    o.connect(g).connect(ac.destination);
    o.start(t);
    o.stop(t + 0.5);
  });
}

function goNext(href) {
  const t = toast('', 'success', 0);
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-secondary ms-3';
  cancel.textContent = '취소';
  t.querySelector('.toast-body').append(cancel);
  let n = 5, timer;
  const tick = () => {
    if (!n) {
      sessionStorage.cmxAutoplay = '1';
      return location.assign(href);
    }
    t.querySelector('.toast-text').textContent = `강의가 끝났습니다. ${n--}초 뒤 다음 영상으로 이동합니다.`;
    timer = setTimeout(tick, 1000);
  };
  cancel.onclick = () => {
    clearTimeout(timer);
    t.remove();
  };
  tick();
}

// The site's own "다음영상" button tells us where the next lecture is.
function onEnded() {
  const next = cfg.autoNext && document.querySelector('.right-container a[aria-label="다음영상"]')?.href;
  if (cfg.endNotify) {
    chime();
    chrome.runtime.sendMessage({ title: vodName(), next: !!next });
  }
  if (next) goNext(next);
  else if (cfg.endNotify) toast('강의 시청을 마쳤습니다.', 'success', 8000);
}

// 7. 다 들은 강의 배속 ---------------------------------------------------------------

// The site caps the speed at the teacher's maximum even on finished lectures. For a lecture the
// site itself marks complete (the flag that also unlocks free seeking) this adds a YouTube-style
// panel: slider, -/+ and presets up to 4x. Lectures still counting toward progress keep the
// site's own speed menu and limit untouched.
const SPEED_MAX = 4;
const SPEED_PRESETS = [1, 1.25, 1.5, 2, 3];

// Reads the site's own amd.progress(vodTag, isProgress, courseId, cmid, attempt, isComplete,
// interval, maxPosition, beforeProgress, isRate, maxRate, …) call. Anything unexpected = no panel.
function siteRate() {
  for (const s of document.scripts) {
    const m = /amd\.progress\(([^)]*)\)/.exec(s.textContent);
    if (!m) continue;
    const a = m[1].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    return { complete: a[5] === 'true', cap: a[9] === 'true' ? Number(a[10]) || 1 : 1 };
  }
}

async function addSpeedPanel(video) {
  const info = siteRate();
  const player = video.closest('.video-js');
  if (!info?.complete || !player) return;
  // Without the page-side shim the site would pull the rate back, so stay within its own limit.
  const max = (await chrome.runtime.sendMessage({ rateShim: info.cap })) ? SPEED_MAX : info.cap;

  const panel = document.createElement('div');
  panel.className = 'cmx-speed-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="cmx-speed-head"><span>재생 속도</span><b></b></div>
    <div class="cmx-speed-row">
      <button type="button" data-step="-0.05" aria-label="느리게">−</button>
      <input type="range" min="0.25" max="${max}" step="0.05" aria-label="재생 속도">
      <button type="button" data-step="0.05" aria-label="빠르게">+</button>
    </div>
    <div class="cmx-speed-chips">${SPEED_PRESETS.filter(r => r <= max)
      .map(r => `<button type="button" data-rate="${r}">${Number.isInteger(r) ? r.toFixed(1) : r}</button>`).join('')}</div>`;
  player.append(panel);
  player.classList.add('cmx-speed');

  const range = panel.querySelector('input');
  const set = r => { video.playbackRate = Math.min(max, Math.max(0.25, Math.round(r * 100) / 100)); };
  const sync = () => {
    const r = video.playbackRate; // content scripts see the real rate, not the page's capped one
    range.value = r;
    panel.querySelector('b').textContent = `${r.toFixed(2)}x`;
    panel.querySelectorAll('[data-rate]').forEach(b => b.classList.toggle('on', +b.dataset.rate === r));
    // video.js writes its capped value to the button label on every change; ours runs after it.
    const label = player.querySelector('.vjs-playback-rate-value');
    if (label) label.textContent = `${+r.toFixed(2)}x`;
  };
  video.addEventListener('ratechange', sync);
  sync();

  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) set(b.dataset.step ? video.playbackRate + +b.dataset.step : +b.dataset.rate);
  });
  range.addEventListener('input', () => set(+range.value));
  // Arrow keys on the slider must not reach the player's seek/volume hotkeys.
  panel.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') panel.hidden = true;
  });
  // The player's speed button opens this panel instead of its own menu.
  document.addEventListener('click', e => {
    if (player.contains(e.target) && e.target.closest('.vjs-playback-rate')) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    } else if (!panel.contains(e.target)) panel.hidden = true;
  }, true);
}

// 8. 작은 창(PiP) -------------------------------------------------------------------

// The site renders <video disablePictureInPicture> and hides video.js's own PiP button. Ours
// clears that flag when pressed and opens the browser's PiP window. The progress code listens to
// the <video>'s own events, which PiP doesn't change, so tracking carries on there. The watermark
// is a DOM overlay, so a PiP window (video pixels only) does not show it. The user chose to keep
// the button on watermarked lectures too: PiP is for watching.
const PIP_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2.5" stroke="#fff" stroke-width="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="#fff"/></svg>';

function addPipButton(fs) {
  const video = fs.closest('.video-js')?.querySelector('video.vjs-tech');
  if (!video || !document.pictureInPictureEnabled) return;
  const b = document.createElement('button');
  b.className = 'vjs-control vjs-button cmx-pip';
  b.type = 'button';
  b.setAttribute('aria-label', '작은 창으로 보기');
  b.innerHTML = PIP_SVG;
  b.onclick = async () => {
    if (document.pictureInPictureElement === video) return document.exitPictureInPicture();
    video.disablePictureInPicture = false;
    try {
      await video.requestPictureInPicture();
      // Put the site's setting back once the window closes.
      video.addEventListener('leavepictureinpicture', () => (video.disablePictureInPicture = true), { once: true });
    } catch (e) {
      video.disablePictureInPicture = true;
      toast(`작은 창으로 열지 못했습니다: ${e.message}`, 'danger', 6000);
    }
  };
  fs.before(b);
  tooltip(b, '작은 창으로 보기');
}

// No URL check: we can't be sure every school serves lectures from /mod/vod/view.php, so the
// features key off the lecture page's own elements (player, button row) where the site is on.
Promise.all([ready, parsed]).then(() => {
  if (!siteActive()) return;
  // Outer container, not the inner .csms-flex-box, so the gap matches the ? button (8px, not 4px).
  if (cfg.vodDownload) onEach('.additional-info .right-container', addDownloadMenu);
  // Always listen: onEnded reads endNotify/autoNext when the lecture ends, so both switches
  // apply live (no refresh) even if they were off when the page loaded.
  onEach('video.vjs-tech', v => v.addEventListener('ended', onEnded));
  if (cfg.speedPanel) onEach('video.vjs-tech', addSpeedPanel);
  if (cfg.pipButton) onEach('.vjs-fullscreen-control', addPipButton);
  if (sessionStorage.cmxAutoplay) {
    sessionStorage.removeItem('cmxAutoplay');
    // Chrome blocks autoplay with sound on a freshly loaded page, so start muted. Press the
    // player's own play button rather than video.play(): only then does video.js (and the
    // site's progress tracking hooked on it) see the play.
    onEach('video.vjs-tech', v => {
      const go = () => {
        v.muted = true;
        v.closest('.video-js')?.querySelector('.vjs-big-play-button')?.click();
        setTimeout(() => toast(v.paused
          ? '재생 버튼을 눌러 다음 영상을 시작하세요.'
          : '다음 영상을 음소거로 재생합니다. 플레이어의 음소거 버튼으로 소리를 켜세요.', 'guide', 6000), 2000);
      };
      // Wait for metadata so the player is fully set up before we press its button.
      v.readyState ? go() : v.addEventListener('loadedmetadata', go, { once: true });
    });
  }
});
