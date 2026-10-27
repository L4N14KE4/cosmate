chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  const target = { tabId: sender.tab!.id!, frameIds: [sender.frameId!] };
  // 강의 다운로드: mux.js·lamejs(약 270KB)는 다운로드를 시작할 때만 넣음. 콘텐츠 스크립트와
  // 같은 격리 환경에 들어가서 vod.ts에서 바로 사용함.
  if (m.loadLibs) {
    chrome.scripting.executeScript({ target, files: ['vendor/mux.min.js', 'vendor/lame.min.js'] })
      .then(() => sendResponse(true), () => sendResponse(false));
    return true; // 비동기로 응답함
  }

  // 배속 패널: 사이트 플레이어는 교수 최대 배속보다 큰 값을 읽으면 되돌림. 그 검사가 페이지 안에
  // 있어서 페이지 환경(MAIN)에서 실행하고, 실제 배속은 유지한 채 video가 cap 이하로 보고하게 구현함.
  // 이 함수는 문자열로 페이지에 넘어가므로 바깥 변수를 쓰면 안 됨.
  if (m.rateShim) {
    chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      args: [m.rateShim as number],
      func: (cap: number) => {
        const v = document.querySelector('video.vjs-tech');
        if (!v) return false;
        if (!Object.hasOwn(v, 'playbackRate')) {
          const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate')!;
          Object.defineProperty(v, 'playbackRate', {
            configurable: true,
            get() { return Math.min(real.get!.call(this), cap); },
            set(x) { real.set!.call(this, x); },
          });
        }
        return true;
      },
    }).then(([r]) => sendResponse(!!r?.result), () => sendResponse(false));
    return true;
  }

  // 6. 그 밖의 메시지는 강의 종료(vod.ts의 onEnded)로 처리함: 시스템 알림과 그 탭의 툴바 배지.
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('cosmos-lxp-logo.png'), // 서비스 워커가 js/ 안에 있어 상대 경로 대신 절대 주소로 지정함
    title: '강의 시청 완료',
    message: m.next ? `${m.title}\n곧 다음 영상으로 이동합니다.` : m.title,
  });
  // 배지는 탭이 그새 닫히면 실패하므로 무시함.
  chrome.action.setBadgeBackgroundColor({ tabId: target.tabId, color: '#1181F9' }).catch(() => {});
  chrome.action.setBadgeText({ tabId: target.tabId, text: '완료' }).catch(() => {});
});

// 예전 버전이 사이트별로 등록한 우클릭 스크립트(right-click.js)를 지움. 지금은 콘텐츠 스크립트가 처리함.
chrome.runtime.onInstalled.addListener(() => chrome.scripting.unregisterContentScripts());

// 처음 설치했을 때만 시작 안내 페이지를 엶. 업데이트·확장 새로고침 때는 열지 않음.
// 서비스 워커가 js/ 안에 있어 상대 경로 대신 절대 주소로 지정함.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
});

// 그 탭이 다른 페이지를 불러오면 배지를 지움. 불러오자마자 닫힌 탭(팝업 등)은 실패하므로 무시함.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
