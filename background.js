// 6. Lecture finished: system notification + toolbar badge on that tab.
chrome.runtime.onMessage.addListener((m, sender) => {
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
