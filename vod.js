// Runs on /mod/vod/view.php after content.js (shares cfg, ready, onEach, toast, notice, css, DL_SVG).

const VOD_NOTICE = `강의 다운로드는 개인 학습(복습) 목적으로만 사용해야 합니다.

· 강의 영상의 저작권은 교수자와 학교에 있습니다.
· 내려받은 파일을 다른 사람에게 공유하거나 인터넷에 올리면 안 됩니다.
· 내려받은 파일로 시청한 시간은 출석·진도율에 반영되지 않습니다.`;

css.textContent += `
  .cmx-vod-dl { position: relative; }
  .cmx-vod-dl > summary { list-style: none; cursor: pointer; }
  .cmx-vod-dl > summary::-webkit-details-marker { display: none; }
  .cmx-vod-dl .dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; }
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
  return text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => new URL(l, url).href);
}

// Yields segment bytes in order with a few requests in flight.
async function* segments(urls, onProgress) {
  const get = u => fetch(u).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
  const q = [];
  const want = i => i < urls.length && q.push(get(urls[i]).catch(() => get(urls[i]))); // one retry per segment
  for (let i = 0; i < 4; i++) want(i);
  for (let i = 0; i < urls.length; i++) {
    want(i + 4);
    yield new Uint8Array(await q[i]);
    onProgress(Math.floor(((i + 1) * 100) / urls.length));
  }
}

// TS → fragmented MP4 without re-encoding.
async function toMp4(urls, onProgress) {
  const parts = [];
  const tm = new muxjs.mp4.Transmuxer();
  tm.on('data', s => {
    if (!parts.length) parts.push(new Blob([s.initSegment]));
    parts.push(new Blob([s.data]));
  });
  for await (const seg of segments(urls, onProgress)) {
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
async function toMp3(urls, onProgress) {
  const parts = [];
  const ts = new muxjs.mp2t.TransportPacketStream();
  const adts = new muxjs.codecs.Adts();
  ts.pipe(new muxjs.mp2t.TransportParseStream()).pipe(new muxjs.mp2t.ElementaryStream()).pipe(adts);
  let enc, dec, time = 0;
  adts.on('data', f => {
    if (!dec) {
      const sfi = f.samplingfrequencyindex;
      enc = new lamejs.Mp3Encoder(1, f.samplerate, 96);
      dec = new AudioDecoder({
        output: a => {
          parts.push(new Blob([enc.encodeBuffer(mono(a))]));
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
  for await (const seg of segments(urls, onProgress)) ts.push(seg);
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

let busy = false;
async function downloadVod(fmt) {
  if (busy) return toast('이미 다운로드 중입니다.', 'warning');
  if (!(await notice('vod', '강의 다운로드 안내', VOD_NOTICE))) return;
  busy = true;
  const t = toast('강의 정보를 불러오는 중…', 'guide', 0);
  const text = t.querySelector('.toast-text');
  try {
    const urls = await segmentUrls();
    const parts = await (fmt === 'mp4' ? toMp4 : toMp3)(urls, p => {
      text.textContent = `${fmt.toUpperCase()} 파일을 만드는 중… ${p}% (이 탭을 닫지 마세요)`;
    });
    save(parts, fmt === 'mp4' ? 'video/mp4' : 'audio/mpeg', `${vodName().replace(/[\\/:*?"<>|]/g, '_')}.${fmt}`);
  } catch (e) {
    toast(`다운로드에 실패했습니다: ${e.message}`, 'danger', 8000);
  } finally {
    t.remove();
    busy = false;
  }
}

function addDownloadMenu(box) {
  const d = document.createElement('details');
  d.className = 'cmx-vod-dl';
  d.innerHTML = `<summary class="btn-csms-svgicon-circle btn-csms-svgicon-circle-help" title="강의 다운로드" aria-label="강의 다운로드">${DL_SVG}</summary>
    <div class="dropdown-menu dropdown-menu-end show">
      <button type="button" class="dropdown-item" data-fmt="mp4">동영상 (MP4)</button>
      <button type="button" class="dropdown-item" data-fmt="mp3">오디오 (MP3)</button>
    </div>`;
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

ready.then(() => {
  // Outer container, not the inner .csms-flex-box, so the gap matches the ? button (8px, not 4px).
  if (cfg.vodDownload) onEach('.additional-info .right-container', addDownloadMenu);
  if (cfg.endNotify || cfg.autoNext) onEach('video.vjs-tech', v => v.addEventListener('ended', onEnded));
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
