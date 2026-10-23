chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  // Lecture download: inject mux.js + lamejs (~270KB) only when a download starts. They land in
  // the same isolated world as our content scripts, so vod.js can use muxjs / lamejs directly.
  if (m.loadLibs) {
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, frameIds: [sender.frameId] },
      files: ['vendor/mux.min.js', 'vendor/lame.min.js'],
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true; // answer asynchronously
  }

  // Speed panel: the site's player pulls the video's playbackRate back whenever it reads more than
  // the teacher's maximum. That check lives in the page, so this runs there (MAIN world) and makes
  // the video *report* at most `cap` while it really plays at the rate the panel set.
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

  // 6. Lecture finished: system notification + toolbar badge on that tab.
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icon.png',
    title: '강의 시청 완료',
    message: m.next ? `${m.title}\n곧 다음 영상으로 이동합니다.` : m.title,
  });
  chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#1181F9' });
  chrome.action.setBadgeText({ tabId: sender.tab.id, text: '완료' });
});

// Clear the badge once that tab loads another page.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' });
});
