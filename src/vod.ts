// 강의 화면 기능. content.ts가 최상위 창에서만 initVod()를 부르고, 사이트가 켜진 곳에서만 동작함.
import { cfg, css, DL_SVG, notice, onEach, parsed, ready, siteActive, toast } from './core';

// background.ts가 다운로드할 때 콘텐츠 스크립트 환경에 넣는 라이브러리(vendor/). 타입 정의는 두지 않음.
declare const muxjs: any;
declare const lamejs: any;

const VOD_NOTICE = `강의 다운로드는 개인 학습(복습) 목적으로만 사용해야 합니다.

· 강의 영상의 저작권은 교수자와 학교에 있습니다.
· 내려받은 파일을 다른 사람에게 공유하거나 인터넷에 올리면 안 됩니다.
· 내려받은 파일로 시청한 시간은 출석·진도율에 반영되지 않습니다.`;

// 주차 화면·모아보기 표에서 받을 때는 받아 온 강의 페이지(doc)에서 읽음.
const vodName = (doc = document) => doc.querySelector('a.vod-item-container.active .vod-info-title')?.textContent?.trim() || doc.title;

// 5. 강의 다운로드 ---------------------------------------------------------------

async function segmentUrls(doc = document) {
  const el = doc.querySelector<HTMLElement>('[data-setup-lazy]');
  // 로그인이 풀리면 강의 페이지 대신 로그인 화면이 옴
  if (!el) throw new Error('강의 정보를 찾지 못했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.');
  const setup = JSON.parse(el.dataset.setupLazy!);
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

// mux.js는 조각형 MP4의 moov에 길이를 "모름"(0xffffffff)으로 적고 mehd도 넣지 않음. Mac QuickTime은 조각을
// 훑어 실제 길이를 구하지만 Windows 플레이어는 이 값을 읽어 약 13시간으로 표시함. 그래서 mvhd·tkhd·mdhd에
// 실제 길이를 적고 mvex 맨 앞에 mehd(전체 길이)를 넣음. mux.js는 이 상자들을 모두 버전 0(32비트)으로 씀.
function withDuration(init: Uint8Array, seconds: number) {
  const v = new DataView(init.buffer, init.byteOffset, init.byteLength);
  const at: Record<string, number> = {};
  let scale = 0; // mvhd의 시간 단위. tkhd·mehd 길이는 이 단위로 적음.
  const walk = (start: number, end: number) => {
    for (let p = start; p < end; p += v.getUint32(p)) {
      const type = String.fromCharCode(...init.subarray(p + 4, p + 8));
      at[type] = p;
      if (type === 'mvhd') scale = v.getUint32(p + 20);
      if (type === 'mvhd' || type === 'mdhd') v.setUint32(p + 24, Math.round(seconds * v.getUint32(p + 20)));
      if (type === 'tkhd') v.setUint32(p + 28, Math.round(seconds * scale));
      if (type === 'moov' || type === 'trak' || type === 'mdia') walk(p + 8, p + v.getUint32(p));
    }
  };
  walk(0, init.length);
  // mehd(16바이트)를 끼우고 그것을 감싼 mvex·moov의 크기를 그만큼 늘림.
  const m = at.mvex + 8;
  const out = new Uint8Array(init.length + 16);
  out.set(init.subarray(0, m));
  out.set(init.subarray(m), m + 16);
  const o = new DataView(out.buffer);
  o.setUint32(m, 16);
  out.set([0x6d, 0x65, 0x68, 0x64], m + 4); // 'mehd', 버전·플래그는 0
  o.setUint32(m + 12, Math.round(seconds * scale));
  for (const p of [at.moov, at.mvex]) o.setUint32(p, o.getUint32(p) + 16);
  return out;
}

// TS → 조각형 MP4(재인코딩 없음). 받는 속도에 맞춰 변환되므로 진행도는 받은 조각 수로 셈.
async function toMp4(urls: string[], seconds: number, signal: AbortSignal, onProgress: (f: number) => void) {
  const parts: Blob[] = [];
  const tm = new muxjs.mp4.Transmuxer();
  tm.on('data', (s: { initSegment: Uint8Array; data: BlobPart }) => {
    if (!parts.length) parts.push(new Blob([withDuration(s.initSegment, seconds)]));
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

// TS → AAC 프레임(mux.js) → PCM(WebCodecs), 조각 단위로 처리함. onPcm은 모노 PCM과 표본율, 그 PCM이
// 끝나는 시각(초)을 받음. MP3 저장과 스크립트 만들기가 함께 씀.
async function decodeAudio(urls: string[], signal: AbortSignal, onPcm: (pcm: Int16Array, rate: number, end: number) => void) {
  const ts = new muxjs.mp2t.TransportPacketStream();
  const adts = new muxjs.codecs.Adts();
  ts.pipe(new muxjs.mp2t.TransportParseStream()).pipe(new muxjs.mp2t.ElementaryStream()).pipe(adts);
  let dec: AudioDecoder | undefined, time = 0;
  // 디코더를 닫으면 대기열이 버려지고 아래 flush()가 실패함.
  signal.addEventListener('abort', () => dec && dec.state !== 'closed' && dec.close(), { once: true });
  adts.on('data', (f: any) => {
    if (!dec) {
      const sfi = f.samplingfrequencyindex;
      dec = new AudioDecoder({
        output: a => {
          onPcm(mono(a), a.sampleRate, (a.timestamp + (a.duration ?? 0)) / 1e6);
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
}

// PCM → MP3(lamejs). 받기가 인코딩보다 훨씬 먼저 끝나므로 진행도는 인코딩한 오디오 길이로 잼.
async function toMp3(urls: string[], seconds: number, signal: AbortSignal, onProgress: (f: number) => void) {
  const parts: Blob[] = [];
  let enc: any;
  await decodeAudio(urls, signal, (pcm, rate, end) => {
    enc ??= new lamejs.Mp3Encoder(1, rate, 96);
    parts.push(new Blob([enc.encodeBuffer(pcm)]));
    onProgress(end / seconds);
  });
  parts.push(new Blob([enc.flush()]));
  return parts;
}

// 11. 강의 스크립트(TXT). GitHub용(FULL) 빌드에만 있음 -------------------------------------

// 받아쓰기는 사용자가 넣은 Groq API 키로 Groq의 Whisper에 오디오를 보내서 함. 확장 안에서 끝나지 않고
// 외부 서버로 오디오가 나가므로 스토어용 빌드에서는 빼고, 처음 쓸 때 따로 동의를 받음.
const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_GUIDE = 'https://github.com/L4N14KE4/cosmate/blob/main/docs/groq-api-key.md'; // 키 만드는 방법(스크린샷)
// 무료 등급의 오디오 한도(시간당·하루)는 모델마다 따로 잡힘. turbo가 막히면 large-v3로 넘어감.
const GROQ_MODELS = ['whisper-large-v3-turbo', 'whisper-large-v3'];
// MP3를 20분씩 끊어 보냄. 모노 48kbps라 한 조각이 약 7MB로 무료 등급 파일 한도(25MB) 안에 듦.
// 조각 경계에서 단어가 잘릴 수 있어 앞 조각의 끝 문장을 다음 요청의 prompt로 넘김.
const CHUNK_SEC = 20 * 60;
// 한도가 풀릴 때까지 이보다 오래 기다려야 하면 하루 한도를 다 쓴 것으로 보고 멈춤.
const MAX_WAIT_SEC = 70 * 60;

const GROQ_NOTICE = `스크립트를 만들려면 강의 오디오를 Groq(api.groq.com)로 보내 받아쓰기(Whisper)를 합니다.

· 오디오는 입력한 Groq API 키로 사용자 계정에 보내지며, Cosmate 개발자에게는 아무것도 전송되지 않습니다.
· Groq의 데이터 처리 방침은 groq.com의 개인정보처리방침을 따릅니다.
· 만든 스크립트도 강의 영상과 같이 개인 학습(복습) 목적으로만 사용해야 합니다.
· 다음 창에서 본인의 Groq API 키(무료)를 입력합니다. 처음 한 번만 입력하면 됩니다.`;

const hms = (s: number) => [s / 3600, (s / 60) % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');

// 사이트 모달 모양으로 Groq API 키를 입력받음. 취소하면 null.
async function askGroqKey() {
  const d = document.createElement('dialog');
  d.className = 'modal cmx-dialog';
  d.innerHTML = `<form method="dialog" class="modal-content">
    <div class="modal-header"><h5 class="modal-title">Groq API 키 입력</h5></div>
    <div class="modal-body">
      <p>스크립트 받아쓰기에 쓸 Groq API 키를 입력하세요. 키는 이 브라우저(chrome.storage.local)에만 저장됩니다.</p>
      <p>키는 <a href="https://console.groq.com/keys" target="_blank" rel="noopener">Groq</a>에서 무료로 만들 수 있습니다(카드 등록 없음).<br>
        가입 → API Keys → Create API Key → 이름 적고 Submit → Copy<br>
        <a href="${GROQ_GUIDE}" target="_blank" rel="noopener">화면별 발급 방법 보기</a></p>
      <input type="password" class="form-control" placeholder="gsk_..." autocomplete="off" required>
    </div>
    <div class="modal-footer">
      <button value="" class="btn btn-secondary" formnovalidate>취소</button>
      <button value="ok" class="btn btn-primary">저장하고 계속</button>
    </div></form>`;
  d.querySelector('.modal-body')!.setAttribute('style', 'white-space: normal');
  document.body.append(d);
  d.showModal();
  await new Promise(r => d.addEventListener('close', r));
  const key = d.querySelector('input')!.value.trim();
  d.remove();
  if (d.returnValue !== 'ok' || !key) return null;
  await chrome.storage.local.set({ groqKey: key });
  return key;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((ok, fail) => {
  const t = setTimeout(ok, ms);
  signal.addEventListener('abort', () => (clearTimeout(t), fail(signal.reason)), { once: true });
});

// "Please try again in 7m30.5s" 같은 오류 문구나 retry-after 헤더에서 기다릴 초를 읽음.
function waitSec(res: Response, body: string) {
  const m = /try again in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i.exec(body)?.[1];
  const sec = m ? +(/(\d+)h/.exec(m)?.[1] ?? 0) * 3600 + +(/(\d+)m/.exec(m)?.[1] ?? 0) * 60 + +(/([\d.]+)s/.exec(m)?.[1] ?? 0) : 0;
  return sec || Number(res.headers.get('retry-after')) || 60;
}

type Segment = { start: number; text: string };
const blockedUntil: Record<string, number> = {}; // 모델 → 한도가 풀리는 시각(ms). 같은 탭의 다음 강의에도 이어짐.

// 조각 하나를 받아씀. 한도(429)에 걸리면 다른 모델로 넘어가고, 모두 막혔으면 풀릴 때까지 기다림.
async function transcribe(mp3: Blob, key: string, prompt: string, signal: AbortSignal, onWait: (msg: string) => void) {
  for (let fails = 0; ;) {
    const now = Date.now();
    const model = GROQ_MODELS.find(m => !(blockedUntil[m] > now));
    if (!model) {
      const until = Math.min(...GROQ_MODELS.map(m => blockedUntil[m]));
      if (until - now > MAX_WAIT_SEC * 1000) throw new Error('오늘 Groq 무료 한도를 다 썼습니다. 내일 다시 시도하세요.');
      while (Date.now() < until) {
        const left = Math.ceil((until - Date.now()) / 1000);
        onWait(`Groq 사용 한도에 걸려 ${Math.floor(left / 60)}분 ${left % 60}초 뒤 이어서 진행합니다`);
        await sleep(Math.min(1000, until - Date.now()), signal);
      }
      onWait('한도가 풀려 받아쓰기를 이어서 진행합니다');
      continue;
    }
    const form = new FormData();
    form.append('file', mp3, 'audio.mp3');
    form.append('model', model);
    form.append('language', 'ko'); // 자동 감지는 영어 용어가 많은 강의를 영어로 잘못 고르기도 해서 한국어로 고정함
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (prompt) form.append('prompt', prompt);
    const res = await fetch(GROQ_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal });
    if (res.ok) {
      const j = await res.json();
      return { text: (j.text ?? '') as string, segments: (j.segments ?? []) as Segment[] };
    }
    const body = await res.text();
    if (res.status === 401) {
      await chrome.storage.local.remove('groqKey'); // 다음에 누르면 키를 다시 물음
      throw new Error('Groq API 키가 올바르지 않습니다. 다시 눌러 새 키를 입력하세요.');
    }
    if (res.status === 429) {
      blockedUntil[model] = Date.now() + waitSec(res, body) * 1000;
      continue;
    }
    if (res.status >= 500 && ++fails <= 3) {
      await sleep(3000 * fails, signal);
      continue;
    }
    throw new Error(`Groq 오류 ${res.status}: ${body.slice(0, 200)}`);
  }
}

// PCM → 20분 단위 MP3 → Groq 받아쓰기 → "[00:01:23] 문장" 줄. 앞 조각을 받아쓰는 동안 다음 조각을 인코딩함.
// 진행도는 인코딩한 길이와 받아쓰기를 마친 길이를 반씩 반영함.
async function toTranscript(urls: string[], seconds: number, title: string, href: string, key: string, signal: AbortSignal, onProgress: (f: number) => void, onWait: (msg: string) => void) {
  const lines: string[] = [];
  let chain = Promise.resolve(), prompt = '', enc: any, parts: Blob[] = [], from = 0, encoded = 0, done = 0;
  const report = () => onProgress((encoded + done) / 2 / seconds);
  const send = (end: number) => {
    const mp3 = new Blob([...parts, new Blob([enc.flush()])], { type: 'audio/mpeg' });
    const start = from;
    [enc, parts, from] = [undefined, [], end];
    chain = chain.then(async () => {
      const r = await transcribe(mp3, key, prompt, signal, onWait);
      for (const s of r.segments) if (s.text.trim()) lines.push(`[${hms(start + s.start)}] ${s.text.trim()}`);
      prompt = r.text.slice(-200);
      done = end;
      report();
    });
    chain.catch(() => {}); // 실패는 아래 await chain에서 처리함
  };
  let last = 0;
  await decodeAudio(urls, signal, (pcm, rate, end) => {
    enc ??= new lamejs.Mp3Encoder(1, rate, 48);
    parts.push(new Blob([enc.encodeBuffer(pcm)]));
    last = encoded = end;
    report();
    if (end - from >= CHUNK_SEC) send(end);
  });
  if (enc) send(last);
  await chain;
  return [`# ${title}`, href, `길이 ${hms(seconds)} · Groq Whisper로 받아씀`, '', ...lines, ''].join('\n');
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
// cmid를 주면(주차 화면·모아보기 표) 그 강의 페이지를 받아 와 영상 주소와 제목을 읽음.
async function downloadVod(fmt: 'mp4' | 'mp3' | 'txt', cmid?: string) {
  if (busy) return toast('이미 다운로드 중입니다.', 'warning');
  if (!(await notice('vod', '강의 다운로드 안내', VOD_NOTICE))) return;
  let key = '';
  if (FULL && fmt === 'txt') {
    if (!(await notice('groq', '강의 스크립트 안내', GROQ_NOTICE))) return;
    key = ((await chrome.storage.local.get('groqKey')).groqKey as string) || (await askGroqKey()) || '';
    if (!key) return;
  }
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
  // 스크립트: Groq 한도를 기다리는 동안 진행 문구 대신 남은 대기 시간을 보여 줌. 받아쓰기를 마치면 다시 진행도로 바뀜.
  const wait = (msg: string) => {
    shown = -1;
    text.textContent = `${msg} (이 탭을 닫지 마세요)`;
  };
  try {
    await loadLibs();
    const href = cmid ? new URL(`/mod/vod/view.php?id=${cmid}`, location.origin).href : location.href;
    const doc = cmid ? new DOMParser().parseFromString(await (await fetch(href, { signal: ctl.signal })).text(), 'text/html') : document;
    const { urls, seconds } = await segmentUrls(doc);
    ctl.signal.throwIfAborted();
    start = performance.now();
    progress(0);
    const title = vodName(doc);
    const name = title.replace(/[\\/:*?"<>|]/g, '_');
    if (FULL && fmt === 'txt') {
      save([new Blob([await toTranscript(urls, seconds, title, href, key, ctl.signal, progress, wait)])], 'text/plain;charset=utf-8', `${name}.txt`);
      return;
    }
    const parts = await (fmt === 'mp4' ? toMp4(urls, seconds, ctl.signal, progress) : toMp3(urls, seconds, ctl.signal, progress));
    save(parts, fmt === 'mp4' ? 'video/mp4' : 'audio/mpeg', `${name}.${fmt}`);
  } catch (e) {
    if (ctl.signal.aborted) toast('다운로드를 취소했습니다.', 'guide');
    else toast(`다운로드에 실패했습니다: ${(e as Error).message}`, 'danger', 8000);
  } finally {
    ctl.abort(); // 실패했을 때 미리 받던 조각 요청과 오디오 디코더를 정리함
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

// 강의 화면은 버튼 줄 맨 앞에 둥근 버튼으로, 주차 카드·표(cmid 있음)는 파일 다운로드 아이콘과 같은 모양·자리에 붙임.
function addDownloadMenu(box: Element, cmid?: string) {
  const d = document.createElement('details');
  d.className = cmid ? 'cmx-vod-dl cmx-dl' : 'cmx-vod-dl';
  d.innerHTML = `<summary class="${cmid ? 'btn-csms-icon btn-csms-icon-gray-nospace-secondary btn-csms-icon-sm' : 'btn-csms-svgicon-circle btn-csms-svgicon-circle-help'}" aria-label="강의 다운로드">${DL_SVG}</summary>
    <div class="dropdown-menu dropdown-menu-end show">
      <button type="button" class="dropdown-item" data-fmt="mp4">동영상 (MP4)</button>
      <button type="button" class="dropdown-item" data-fmt="mp3">오디오 (MP3)</button>
      ${FULL ? '<button type="button" class="dropdown-item" data-fmt="txt">스크립트 (TXT)</button>' : ''}
    </div>`;
  tooltip(d.querySelector('summary')!, '강의 다운로드');
  d.querySelector('.dropdown-menu')!.addEventListener('click', e => {
    const fmt = (e.target as Element).closest<HTMLElement>('[data-fmt]')?.dataset.fmt as 'mp4' | 'mp3' | 'txt' | undefined;
    if (!fmt) return;
    d.open = false;
    downloadVod(fmt, cmid);
  });
  document.addEventListener('click', e => d.contains(e.target as Node) || (d.open = false));
  if (!cmid) return void box.prepend(d);
  // 주차 카드는 아래 카드가 메뉴를 덮고, 표는 감싼 상자(.table-coursemos-wrap)가 넘치는 부분을 잘라서
  // 메뉴를 화면 기준으로 띄우고, 스크롤하면 닫음.
  const menu = d.querySelector<HTMLElement>('.dropdown-menu')!;
  d.addEventListener('toggle', () => {
    if (!d.open) return;
    const r = d.getBoundingClientRect();
    Object.assign(menu.style, { position: 'fixed', top: `${r.bottom + 4}px`, right: `${document.documentElement.clientWidth - r.right}px` });
  });
  addEventListener('scroll', () => (d.open = false), { capture: true, passive: true });
  box.tagName === 'A' ? box.after(d) : box.append(d);
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

// 다음 강의 주소는 사이트의 "다음영상" 버튼에서 읽음. 다음 영상 이동은 GitHub용(FULL) 빌드에만 있음.
function onEnded() {
  const next = FULL && cfg.autoNext && document.querySelector<HTMLAnchorElement>('.right-container a[aria-label="다음영상"]')?.href;
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
    // Moodle은 인자를 하나씩 json_encode해 이어 붙임. 참 값은 강의마다 true나 1로 오고(16987은 true,
    // 127155는 1), 사이트는 if (!isComplete)·isRate && …처럼 참인지만 보므로 똑같이 !!로 판단함.
    let a: unknown[];
    try { a = JSON.parse(`[${m[1]}]`); } catch { return; }
    return { complete: !!a[5], cap: a[9] ? Number(a[10]) || 1 : 1 };
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

// 지금 장면을 원본 해상도 PNG로 저장하는 컨트롤바 버튼(다운로드 스위치에 묶음). 영상 픽셀만 그리므로
// 화면 위에 덮는 워터마크는 들어가지 않음(PiP·영상 다운로드와 같음). 파일 이름에 영상 시각을 붙임.
const SHOT_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.5-2h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-9Z" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" stroke="#fff" stroke-width="2"/></svg>';

function addCaptureButton(fs: Element) {
  const video = fs.closest('.video-js')?.querySelector<HTMLVideoElement>('video.vjs-tech');
  if (!video) return;
  const b = document.createElement('button');
  b.className = 'vjs-control vjs-button cmx-shot';
  b.type = 'button';
  b.setAttribute('aria-label', '지금 장면 저장');
  b.innerHTML = SHOT_SVG;
  b.onclick = async () => {
    if (!video.videoWidth) return toast('영상을 재생한 뒤에 저장할 수 있습니다.', 'warning');
    if (!(await notice('vod', '강의 다운로드 안내', VOD_NOTICE))) return;
    const t = Math.floor(video.currentTime);
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    try {
      c.getContext('2d')!.drawImage(video, 0, 0);
      const png = await new Promise<Blob | null>(r => c.toBlob(r)); // 영상이 다른 출처로 막혀 있으면 여기서 오류
      if (!png) throw new Error('이미지를 만들지 못했습니다.');
      save([png], 'image/png', `${vodName().replace(/[\\/:*?"<>|]/g, '_')} ${Math.floor(t / 60)}분 ${t % 60}초.png`);
    } catch (e) {
      toast(`장면을 저장하지 못했습니다: ${(e as Error).message}`, 'danger', 6000);
    }
  };
  fs.before(b);
  tooltip(b, '지금 장면 저장');
}

// URL로 거르지 않음. 모든 학교가 /mod/vod/view.php를 쓴다고 확신할 수 없어서, 강의 페이지의
// 요소(플레이어, 버튼 줄)를 보고 붙이도록 구현함.
export function initVod() {
  css.textContent += `
    .cmx-vod-dl { position: relative; }
    .cmx-vod-dl > summary { list-style: none; cursor: pointer; }
    .cmx-vod-dl > summary::-webkit-details-marker { display: none; }
    .cmx-vod-dl .dropdown-menu { position: absolute; top: calc(100% + 4px); right: 0; min-width: 0; width: max-content; }
    /* 카드의 다운로드 아이콘은 translateY로 가운데에 두는데, transform이 있으면 fixed 메뉴가 아이콘 기준이 됨. 28px = 아이콘 높이. */
    .activity-item > .cmx-vod-dl { top: calc(50% - 14px); transform: none; }
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
    .cmx-pip, .cmx-shot { display: flex; align-items: center; justify-content: center; --csms-btn-icon-svg-size: 22px; }
    .cmx-pip svg, .cmx-shot svg { pointer-events: none; }
  `;

  Promise.all([ready, parsed]).then(() => {
    if (!siteActive()) return;
    // 안쪽 .csms-flex-box가 아닌 바깥 상자에 넣어야 ? 버튼과의 간격(4px 아닌 8px)이 맞음.
    if (cfg.vodDownload) {
      onEach('.additional-info .right-container', box => addDownloadMenu(box));
      // 주차 화면의 강의 카드, 표(학습활동 모아보기·활동 현황)의 강의 이름 옆.
      onEach('li.modtype_vod .activity-item', item => addDownloadMenu(item, item.closest('li')!.id.replace('module-', '')));
      onEach<HTMLAnchorElement>('#region-main td a[href*="/mod/vod/view.php"]', a => addDownloadMenu(a, new URL(a.href).searchParams.get('id')!));
    }
    // 항상 듣도록 구현함. onEnded가 끝나는 순간 endNotify/autoNext를 읽으므로 두 스위치는 새로고침 없이 적용됨.
    onEach<HTMLVideoElement>('video.vjs-tech', v => v.addEventListener('ended', onEnded));
    if (cfg.speedPanel) onEach<HTMLVideoElement>('video.vjs-tech', addSpeedPanel);
    // 둘 다 전체 화면 버튼 앞에 넣으므로 이 순서면 [장면 저장][PiP][전체 화면]이 됨.
    if (cfg.vodDownload) onEach('.vjs-fullscreen-control', addCaptureButton);
    if (cfg.pipButton) onEach('.vjs-fullscreen-control', addPipButton);
    // 이동해 온 페이지를 음소거로 이어서 재생함. GitHub용(FULL) 빌드에만 있음.
    if (FULL && sessionStorage.cmxAutoplay) {
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
