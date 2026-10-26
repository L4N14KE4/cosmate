// 강의 화면 기능. content.ts가 최상위 창에서만 initVod()를 부르고, 사이트가 켜진 곳에서만 동작함.
import { cfg, css, DL_SVG, notice, onEach, parsed, ready, siteActive, toast } from './core';

// background.ts가 다운로드할 때 콘텐츠 스크립트 환경에 넣는 라이브러리(vendor/). 타입 정의는 두지 않음.
declare const muxjs: any;
declare const lamejs: any;

const VOD_NOTICE = `강의 다운로드는 개인 학습(복습) 목적으로만 사용해야 합니다.

· 강의 영상의 저작권은 교수자와 학교에 있습니다.
· 내려받은 파일을 다른 사람에게 공유하거나 인터넷에 올리면 안 됩니다.
· 내려받은 파일로 시청한 시간은 출석·진도율에 반영되지 않습니다.`;

const vodName = () => document.querySelector('a.vod-item-container.active .vod-info-title')?.textContent?.trim() || document.title;

// 5. 강의 다운로드 ---------------------------------------------------------------

async function segmentUrls() {
  const setup = JSON.parse(document.querySelector<HTMLElement>('[data-setup-lazy]')!.dataset.setupLazy!);
  let url: string = [].concat(setup.sources)[0]['src'];
  let text = await (await fetch(url)).text();
  if (text.includes('#EXT-X-STREAM-INF')) { // 마스터 재생 목록이면 가장 높은 화질을 고름
    const best = [...text.matchAll(/BANDWIDTH=(\d+)[^\n]*\n([^\n#]+)/g)].sort((a, b) => +b[1] - +a[1])[0];
    url = new URL(best[2].trim(), url).href;
    text = await (await fetch(url)).text();
  }
  const lines = text.split('\n').map(l => l.trim());
  return {
    urls: lines.filter(l => l && !l.startsWith('#')).map(l => new URL(l, url).href),
    seconds: lines.reduce((s, l) => s + Number(/^#EXTINF:([\d.]+)/.exec(l)?.[1] ?? 0), 0),
  };
}

// 조각을 순서대로 넘김. 4개씩 미리 받아 두고, signal이 취소되면 멈춤.
async function* segments(urls: string[], signal: AbortSignal, onSegment?: (n: number) => void) {
  const get = (u: string) => fetch(u, { signal }).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
  const q: Promise<ArrayBuffer>[] = [];
  const want = (i: number) => {
    if (i >= urls.length) return;
    const p = get(urls[i]).catch(e => (signal.aborted ? Promise.reject(e) : get(urls[i]))); // 조각마다 한 번 재시도
    p.catch(() => {}); // 취소 뒤 남은 요청이 처리 안 된 오류로 콘솔에 찍히지 않게 함
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

// TS → 조각형 MP4(재인코딩 없음). 받는 속도에 맞춰 변환되므로 진행도는 받은 조각 수로 셈.
async function toMp4(urls: string[], signal: AbortSignal, onProgress: (f: number) => void) {
  const parts: Blob[] = [];
  const tm = new muxjs.mp4.Transmuxer();
  tm.on('data', (s: { initSegment: BlobPart; data: BlobPart }) => {
    if (!parts.length) parts.push(new Blob([s.initSegment]));
    parts.push(new Blob([s.data]));
  });
  for await (const seg of segments(urls, signal, n => onProgress(n / urls.length))) {
    tm.push(seg);
    tm.flush();
  }
  return parts;
}

// ponytail: 강의는 말소리라 모노 96kbps로 줄여 lamejs 인코딩 시간을 절반으로 줄임.
// 음악이 중요한 강의가 있으면 채널·비트레이트를 옵션으로 만들 것.
function mono(a: AudioData) {
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

// TS → AAC 프레임(mux.js) → PCM(WebCodecs) → MP3(lamejs), 조각 단위로 처리함.
// 받기가 인코딩보다 훨씬 먼저 끝나므로 진행도는 인코딩한 오디오 길이로 잼.
async function toMp3(urls: string[], seconds: number, signal: AbortSignal, onProgress: (f: number) => void) {
  const parts: Blob[] = [];
  const ts = new muxjs.mp2t.TransportPacketStream();
  const adts = new muxjs.codecs.Adts();
  ts.pipe(new muxjs.mp2t.TransportParseStream()).pipe(new muxjs.mp2t.ElementaryStream()).pipe(adts);
  let enc: any, dec: AudioDecoder | undefined, time = 0;
  // 디코더를 닫으면 대기열이 버려지고 아래 flush()가 실패함.
  signal.addEventListener('abort', () => dec && dec.state !== 'closed' && dec.close(), { once: true });
  adts.on('data', (f: any) => {
    if (!dec) {
      const sfi = f.samplingfrequencyindex;
      enc = new lamejs.Mp3Encoder(1, f.samplerate, 96);
      dec = new AudioDecoder({
        output: a => {
          parts.push(new Blob([enc.encodeBuffer(mono(a))]));
          onProgress((a.timestamp + (a.duration ?? 0)) / 1e6 / seconds);
          a.close();
        },
        error: e => console.error(e), // 디코더가 실패하면 아래 flush()도 실패함
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

// ponytail: 파일 전체를 Blob으로 들고 있음(크롬은 큰 Blob을 디스크로 넘김).
// 아주 긴 강의에서 메모리가 모자라면 showSaveFilePicker 스트리밍으로 바꿀 것.
function save(parts: Blob[], type: string, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(parts, { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// mux.js·lamejs(약 270KB)는 모든 페이지에 싣지 않고, 다운로드할 때 background.ts가 넣음.
async function loadLibs() {
  if (typeof muxjs !== 'undefined' && typeof lamejs !== 'undefined') return;
  if (!(await chrome.runtime.sendMessage({ loadLibs: true }))) throw new Error('변환 라이브러리를 불러오지 못했습니다.');
}

const timeLeft = (s: number) => (s < 60 ? `${Math.max(10, Math.ceil(s / 10) * 10)}초` : `약 ${Math.round(s / 60)}분`);

let busy = false;
async function downloadVod(fmt: 'mp4' | 'mp3') {
  if (busy) return toast('이미 다운로드 중입니다.', 'warning');
  if (!(await notice('vod', '강의 다운로드 안내', VOD_NOTICE))) return;
  busy = true;
  const ctl = new AbortController();
  // 사이트 토스트에 글자, 그 아래 Bootstrap 진행 막대, 오른쪽 취소 버튼을 배치함.
  const t = toast('', 'guide', 0, b => {
    b.disabled = true;
    ctl.abort();
  });
  t.classList.add('cmx-dl-toast');
  t.querySelector('.toast-text')!.innerHTML = `<span></span>
    <div class="progress cmx-dl-progress" role="progressbar" aria-label="다운로드 진행도" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar" style="width: 0%"></div></div>`;
  const [text, bar] = t.querySelectorAll<HTMLElement>('.toast-text span, .progress');
  text.textContent = '강의 정보를 불러오는 중…';

  let start = 0, shown = -1;
  const progress = (f: number) => {
    const p = Math.min(99, Math.floor(f * 100)); // 100%는 파일을 저장한 뒤에만 표시
    if (p === shown) return; // MP3 인코더는 오디오 약 20ms마다 알림
    shown = p;
    // 남은 시간은 지금까지의 속도로 계산하고, 2%가 넘기 전에는 표시하지 않음.
    const left = f > 0.02 ? (((performance.now() - start) / 1000) * (1 - f)) / f : 0;
    text.textContent = `${fmt.toUpperCase()} 파일을 만드는 중… ${p}%${left ? ` · ${timeLeft(left)} 남음` : ''} (이 탭을 닫지 마세요)`;
    (bar.firstElementChild as HTMLElement).style.width = `${p}%`;
    bar.setAttribute('aria-valuenow', String(p));
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
    else toast(`다운로드에 실패했습니다: ${(e as Error).message}`, 'danger', 8000);
  } finally {
    t.remove();
    busy = false;
  }
}

// 사이트 버튼의 Bootstrap 툴팁은 확장 버튼이 생기기 전에 초기화됨. 그래서 Bootstrap이 만드는 것과
// 같은 마크업을 마우스를 올리거나 포커스할 때 직접 만들도록 구현함(모양은 사이트 CSS).
function tooltip(el: HTMLElement, text: string) {
  let tip: HTMLDivElement | null = null;
  const show = () => {
    if (tip) return;
    const t = (tip = document.createElement('div'));
    t.className = 'tooltip bs-tooltip-auto fade';
    t.setAttribute('role', 'tooltip');
    t.dataset.popperPlacement = 'top';
    t.innerHTML = '<div class="tooltip-arrow" style="position:absolute;left:0"></div><div class="tooltip-inner"></div>';
    t.lastChild!.textContent = text;
    // 먼저 페이지 왼쪽 위에 고정함. 위치가 없으면 폭이 페이지 전체로 늘어남.
    t.style.cssText = 'position:absolute;inset:0 auto auto 0;margin:0';
    document.body.append(t);
    const r = el.getBoundingClientRect(), w = t.offsetWidth;
    // 문서 좌표 기준으로 Bootstrap처럼 버튼 6px 위에 둠.
    t.style.transform = `translate3d(${r.left + scrollX + (r.width - w) / 2}px,${r.top + scrollY - t.offsetHeight - 6}px,0)`;
    (t.firstChild as HTMLElement).style.transform = `translate3d(${(w - 12.8) / 2}px,0,0)`; // 12.8px = 화살표 폭
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

function addDownloadMenu(box: Element) {
  const d = document.createElement('details');
  d.className = 'cmx-vod-dl';
  d.innerHTML = `<summary class="btn-csms-svgicon-circle btn-csms-svgicon-circle-help" aria-label="강의 다운로드">${DL_SVG}</summary>
    <div class="dropdown-menu dropdown-menu-end show">
      <button type="button" class="dropdown-item" data-fmt="mp4">동영상 (MP4)</button>
      <button type="button" class="dropdown-item" data-fmt="mp3">오디오 (MP3)</button>
    </div>`;
  tooltip(d.querySelector('summary')!, '강의 다운로드');
  d.querySelector('.dropdown-menu')!.addEventListener('click', e => {
    const fmt = (e.target as Element).closest<HTMLElement>('[data-fmt]')?.dataset.fmt as 'mp4' | 'mp3' | undefined;
    if (!fmt) return;
    d.open = false;
    downloadVod(fmt);
  });
  document.addEventListener('click', e => d.contains(e.target as Node) || (d.open = false));
  box.prepend(d);
}

// 6. 강의 종료 알림 · 다음 영상 -----------------------------------------------------

// 크롬은 사용자가 페이지를 클릭하거나 입력한 뒤에만 소리를 허용함. 그 전에는 소리 없이
// 시스템 알림만 뜸.
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

function goNext(href: string) {
  let n = 5, timer: ReturnType<typeof setTimeout>;
  const t = toast('', 'success', 0, () => {
    clearTimeout(timer);
    t.remove();
  });
  const tick = () => {
    if (!n) {
      sessionStorage.cmxAutoplay = '1';
      return location.assign(href);
    }
    t.querySelector('.toast-text')!.textContent = `강의가 끝났습니다. ${n--}초 뒤 다음 영상으로 이동합니다.`;
    timer = setTimeout(tick, 1000);
  };
  tick();
}

// 다음 강의 주소는 사이트의 "다음영상" 버튼에서 읽음.
function onEnded() {
  const next = cfg.autoNext && document.querySelector<HTMLAnchorElement>('.right-container a[aria-label="다음영상"]')?.href;
  if (cfg.endNotify) {
    chime();
    chrome.runtime.sendMessage({ title: vodName(), next: !!next });
  }
  if (next) goNext(next);
  else if (cfg.endNotify) toast('강의 시청을 마쳤습니다.', 'success', 8000);
}

// 7. 다 들은 강의 배속 ---------------------------------------------------------------

// 사이트는 다 들은 강의도 교수가 정한 최대 배속으로 묶음. 사이트가 완료로 표시한 강의(자유
// 탐색이 풀리는 그 값)에만 유튜브식 패널(슬라이더, −/+, 프리셋, 최대 4배)을 붙이고, 진도가
// 남은 강의는 사이트 배속 메뉴와 제한을 그대로 둠.
const SPEED_MAX = 4;
const SPEED_PRESETS = [1, 1.25, 1.5, 2, 3];

// 사이트의 amd.progress(vodTag, isProgress, courseId, cmid, attempt, isComplete, interval,
// maxPosition, beforeProgress, isRate, maxRate, …) 호출을 읽음. 예상과 다르면 패널을 만들지 않음.
function siteRate() {
  for (const s of document.scripts) {
    const m = /amd\.progress\(([^)]*)\)/.exec(s.textContent || '');
    if (!m) continue;
    const a = m[1].split(',').map(x => x.trim().replace(/^"|"$/g, ''));
    return { complete: a[5] === 'true', cap: a[9] === 'true' ? Number(a[10]) || 1 : 1 };
  }
}

async function addSpeedPanel(video: HTMLVideoElement) {
  const info = siteRate();
  const player = video.closest<HTMLElement>('.video-js');
  if (!info?.complete || !player) return;
  // 페이지 쪽 보정 코드를 못 넣으면 사이트가 배속을 되돌리므로 사이트 제한 안에서만 씀.
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

  const range = panel.querySelector('input')!;
  const set = (r: number) => { video.playbackRate = Math.min(max, Math.max(0.25, Math.round(r * 100) / 100)); };
  const sync = () => {
    const r = video.playbackRate; // 콘텐츠 스크립트는 페이지가 보는 제한값이 아니라 실제 배속을 읽음
    range.value = String(r);
    panel.querySelector('b')!.textContent = `${r.toFixed(2)}x`;
    panel.querySelectorAll<HTMLElement>('[data-rate]').forEach(b => b.classList.toggle('on', +b.dataset.rate! === r));
    // video.js가 바뀔 때마다 버튼 라벨에 제한값을 쓰는데, 이 처리가 그 뒤에 실행되어 덮어씀.
    const label = player.querySelector('.vjs-playback-rate-value');
    if (label) label.textContent = `${+r.toFixed(2)}x`;
  };
  video.addEventListener('ratechange', sync);
  sync();

  panel.addEventListener('click', e => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (b) set(b.dataset.step ? video.playbackRate + +b.dataset.step : +b.dataset.rate!);
  });
  range.addEventListener('input', () => set(+range.value));
  // 슬라이더의 화살표 키가 플레이어의 탐색·볼륨 단축키로 가지 않게 함.
  panel.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') panel.hidden = true;
  });
  // 플레이어의 배속 버튼을 누르면 사이트 메뉴 대신 이 패널을 엶.
  document.addEventListener('click', e => {
    const target = e.target as Element;
    if (player.contains(target) && target.closest('.vjs-playback-rate')) {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
    } else if (!panel.contains(target)) panel.hidden = true;
  }, true);
}

// 8. 작은 창(PiP) -------------------------------------------------------------------

// 사이트는 <video disablePictureInPicture>로 PiP를 막고 video.js PiP 버튼도 숨김. 이 버튼은 누를
// 때 그 설정을 풀고 PiP 창을 엶. 진도 기록은 <video> 이벤트를 따르므로 PiP에서도 이어짐.
// 워터마크는 화면 위에 덮는 요소라 PiP 창에 안 보이지만, 감상용이라 워터마크 강의에도 둠(사용자 결정).
const PIP_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2.5" stroke="#fff" stroke-width="2"/><rect x="12" y="11.5" width="7" height="5.5" rx="1" fill="#fff"/></svg>';

function addPipButton(fs: Element) {
  const video = fs.closest('.video-js')?.querySelector<HTMLVideoElement>('video.vjs-tech');
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
      // 창이 닫히면 사이트 설정을 되돌림.
      video.addEventListener('leavepictureinpicture', () => (video.disablePictureInPicture = true), { once: true });
    } catch (e) {
      video.disablePictureInPicture = true;
      toast(`작은 창으로 열지 못했습니다: ${(e as Error).message}`, 'danger', 6000);
    }
  };
  fs.before(b);
  tooltip(b, '작은 창으로 보기');
}

// URL로 거르지 않음. 모든 학교가 /mod/vod/view.php를 쓴다고 확신할 수 없어서, 강의 페이지의
// 요소(플레이어, 버튼 줄)를 보고 붙이도록 구현함.
export function initVod() {
  css.textContent += `
    .cmx-vod-dl { position: relative; }
    .cmx-vod-dl > summary { list-style: none; cursor: pointer; }
    .cmx-vod-dl > summary::-webkit-details-marker { display: none; }
    .cmx-vod-dl .dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 0; width: max-content; }
    .cmx-vod-dl .dropdown-item { padding-right: 14px; } /* 사이트 항목 여백이 왼쪽 14px, 오른쪽 8px이라 맞춤 */
    /* 다운로드 토스트: 사이트의 .toast-text가 가운데 정렬 가로 배치라 진행 막대를 글자 아래로 쌓음. */
    .cmx-dl-toast .toast-text { flex-direction: column; font-variant-numeric: tabular-nums; }
    .cmx-dl-progress { align-self: stretch; height: 4px; margin-top: 8px; }
    .cmx-dl-progress .progress-bar { background-color: #1181f9; } /* 사이트 기본 막대 색은 주황색 */

    /* 배속 패널: 플레이어 메뉴 같은 어두운 바탕에 유튜브 배속 창 배치. */
    .video-js.cmx-speed .vjs-playback-rate .vjs-menu { display: none !important; }
    .cmx-speed-panel { position: absolute; right: 8px; bottom: 56px; z-index: 10; box-sizing: border-box;
      width: min(300px, calc(100% - 16px)); padding: 14px 16px 16px; border-radius: 16px;
      background: rgba(0, 0, 0, .88); color: #fff; font-size: 14px; line-height: 1.4;
      font-family: "Pretendard Variable", Pretendard, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; }
    .cmx-speed-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
    .cmx-speed-head b { font-size: 20px; font-weight: 700; }
    .cmx-speed-row { display: flex; align-items: center; gap: 10px; }
    .cmx-speed-row input { flex: 1; min-width: 0; accent-color: #1181f9; }
    /* .video-js를 앞에 붙여야 사이트의 버튼 초기화 규칙보다 우선함. */
    .video-js .cmx-speed-panel button { border: 0; border-radius: 999px; background: #2c2f32; color: #fff; font: inherit; cursor: pointer; }
    .video-js .cmx-speed-panel button:hover { background: #3d4146; }
    .cmx-speed-row button { flex: none; width: 30px; height: 30px; font-size: 18px; line-height: 1; }
    .cmx-speed-chips { display: flex; gap: 6px; margin-top: 12px; }
    .cmx-speed-chips button { flex: 1; padding: 7px 0; font-size: 13px; }
    .video-js .cmx-speed-chips button.on { background: #1181f9; }

    /* 사이트가 컨트롤바 아이콘 크기를 이 변수(18px)로 정해 width 속성이 무시됨. 22px이면 옆 아이콘과 맞음. */
    .cmx-pip { display: flex; align-items: center; justify-content: center; --csms-btn-icon-svg-size: 22px; }
    .cmx-pip svg { pointer-events: none; }
  `;

  Promise.all([ready, parsed]).then(() => {
    if (!siteActive()) return;
    // 안쪽 .csms-flex-box가 아닌 바깥 상자에 넣어야 ? 버튼과의 간격(4px 아닌 8px)이 맞음.
    if (cfg.vodDownload) onEach('.additional-info .right-container', addDownloadMenu);
    // 항상 듣도록 구현함. onEnded가 끝나는 순간 endNotify/autoNext를 읽으므로 두 스위치는 새로고침 없이 적용됨.
    onEach<HTMLVideoElement>('video.vjs-tech', v => v.addEventListener('ended', onEnded));
    if (cfg.speedPanel) onEach<HTMLVideoElement>('video.vjs-tech', addSpeedPanel);
    if (cfg.pipButton) onEach('.vjs-fullscreen-control', addPipButton);
    if (sessionStorage.cmxAutoplay) {
      sessionStorage.removeItem('cmxAutoplay');
      // 크롬은 새로 연 페이지에서 소리 있는 자동 재생을 막으므로 음소거로 시작함. video.play() 대신
      // 플레이어 재생 버튼을 눌러야 video.js와 그에 걸린 사이트 진도 기록이 재생을 알아챔.
      onEach<HTMLVideoElement>('video.vjs-tech', v => {
        const go = () => {
          v.muted = true;
          v.closest('.video-js')?.querySelector<HTMLElement>('.vjs-big-play-button')?.click();
          setTimeout(() => toast(v.paused
            ? '재생 버튼을 눌러 다음 영상을 시작하세요.'
            : '다음 영상을 음소거로 재생합니다. 플레이어의 음소거 버튼으로 소리를 켜세요.', 'guide', 6000), 2000);
        };
        // 플레이어 준비가 끝나도록 메타데이터를 기다린 뒤 버튼을 누름.
        v.readyState ? go() : v.addEventListener('loadedmetadata', go, { once: true });
      });
    }
  });
}
