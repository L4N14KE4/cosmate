chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  // 강의 다운로드: mux.js·lamejs(약 270KB)를 다운로드를 시작할 때만 넣는다. 콘텐츠 스크립트와
  // 같은 격리 환경에 들어가서 vod.js가 muxjs·lamejs를 바로 쓴다.
  if (m.loadLibs) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      files: ['vendor/mux.min.js', 'vendor/lame.min.js'],
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true; // 비동기로 답한다
  }

  // 배속 패널: 사이트 플레이어는 교수 최대 배속보다 큰 값을 읽으면 되돌린다. 그 검사는 페이지 안에
  // 있어서 페이지 환경(MAIN)에서 실행하고, 실제 배속은 둔 채 video가 cap 이하로 보고하게 한다.
  if (m.rateShim) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      world: 'MAIN',
      args: [m.rateShim],
      func: cap => {
        const v = document.querySelector('video.vjs-tech');
        if (!v) return false;
        if (!Object.hasOwn(v, 'playbackRate')) {
          const real = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'playbackRate');
          Object.defineProperty(v, 'playbackRate', {
            configurable: true,
            get() { return Math.min(real.get.call(this), cap); },
            set(x) { real.set.call(this, x); },
          });
        }
        return true;
      },
    }).then(([r]) => sendResponse(!!r?.result), () => sendResponse(false));
    return true;
  }

  // 6. 그 밖의 메시지는 강의 종료(vod.js의 onEnded): 시스템 알림과 그 탭의 툴바 배지.
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'cosmos-lxp-logo.png',
    title: '강의 시청 완료',
    message: m.next ? `${m.title}\n곧 다음 영상으로 이동합니다.` : m.title,
  });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#1181F9' });
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: '완료' });
});

// 예전 버전이 사이트별로 등록한 우클릭 스크립트(right-click.js)를 지운다. 이제 content.js가 맡는다.
chrome.runtime.onInstalled.addListener(() => chrome.scripting.unregisterContentScripts());

// 그 탭이 다른 페이지를 불러오면 배지를 지운다.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});
