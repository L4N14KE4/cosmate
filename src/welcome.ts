// 시작 안내 페이지의 닫기 버튼. window.close()는 탭에 방문 기록이 있으면 막혀서 탭 API로 이 탭을 닫음.
document.getElementById('close')!.onclick = async () => chrome.tabs.remove((await chrome.tabs.getCurrent())!.id!);
