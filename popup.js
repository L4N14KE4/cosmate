// 페이지를 불러올 때 요소를 넣거나 바꾸는 옵션이라 새로고침해야 적용된다. 나머지는 바로 적용된다.
const NEEDS_REFRESH = ['courseLink', 'fileButton', 'quizPrint', 'vodDownload', 'speedPanel', 'pipButton'];

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const url = (() => { try { return new URL(tab.url); } catch {} })();
  const web = /^https?:$/.test(url?.protocol);
  const reload = () => {
    chrome.tabs.reload(tab.id);
    window.close();
  };
  let staleTab = false; // 페이지가 응답하지 않으면 켜진다(아래 사이트 블록)

  // 스위치는 전역 설정을 바로 바꾼다. 우클릭만 인천대 LMS 밖에서는 그 사이트(origin)에만 켠다.
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    if (box.name === 'rightClick' && url?.hostname !== 'lms.inu.ac.kr') {
      if (!web) {
        box.disabled = true;
        continue;
      }
      const sites = new Set(cfg.rightClickSites);
      box.checked = sites.has(url.origin);
      box.onchange = () => {
        box.checked ? sites.add(url.origin) : sites.delete(url.origin);
        chrome.storage.local.set({ rightClickSites: [...sites] });
      };
      continue;
    }
    box.checked = cfg[box.name];
    box.onchange = () => chrome.storage.local.set({ [box.name]: box.checked });
  }

  // 하단 새로고침 버튼: 팝업을 열었을 때와 값이 다를 때만 보여서, 되돌리면 숨는다.
  const apply = document.getElementById('apply');
  document.addEventListener('change', e => {
    if (!NEEDS_REFRESH.includes(e.target.name)) return;
    apply.hidden = staleTab || !NEEDS_REFRESH.some(k => document.querySelector(`[name=${k}]`).checked !== cfg[k]);
  });
  apply.onclick = reload;

  // 이 사이트 켜기/끄기: 감지된 코스모스 페이지는 켜지고 나머지는 꺼지며, 사용자가 어느 쪽으로든
  // 바꿀 수 있다. 감지 결과는 콘텐츠 스크립트가 알고 있어서 최상위 프레임에 묻는다.
  const section = document.getElementById('site');
  const status = document.getElementById('site-status');
  const button = document.getElementById('site-toggle');
  const info = await chrome.tabs.sendMessage(tab.id, { cmx: 'status' }, { frameId: 0 }).catch(() => null);
  section.hidden = false;
  if (!info) {
    staleTab = true; // 이 카드에 새로고침 버튼이 있으니 하단 버튼은 숨긴다
    // 응답 없음: 확장을 쓸 수 없는 페이지(chrome://, 웹 스토어)이거나, 확장을 새로고침하기 전에
    // 열려서 새로고침할 때까지 연결이 끊긴 탭이다.
    const refreshable = web && !/(^|\.)chromewebstore\.google\.com$/.test(url.hostname);
    status.textContent = refreshable
      ? '확장 업데이트 전에 열린 탭이에요. 새로고침하면 설정할 수 있어요.'
      : '이 페이지에서는 설정할 수 없습니다.';
    if (refreshable) {
      button.textContent = '이 페이지 새로고침';
      button.hidden = false;
      button.onclick = reload;
    }
    return;
  }

  const { origin, detected, active } = info;
  // 이 사이트가 꺼져 있으면 코스모스 기능이 돌지 않으므로 해당 묶음을 회색으로 만들고 조작을
  // 막는다. 우클릭 묶음은 일반 사이트에서도 쓰므로 그대로 둔다.
  for (const group of document.querySelectorAll('.needs-site')) group.inert = !active;
  const { siteOverrides } = cfg;
  const forced = siteOverrides[origin];
  status.textContent =
    forced === 'on' ? '직접 켠 사이트입니다.' :
    forced === 'off' ? '직접 끈 사이트입니다.' :
    detected ? '코스모스 LXP 사이트로 감지되어 켜져 있습니다.' : '코스모스 LXP 사이트로 감지되지 않아 꺼져 있습니다.';
  button.textContent = active ? '이 사이트에서 끄기' : '이 사이트에서 켜기';
  button.hidden = false;
  button.onclick = async () => {
    // 자동 감지 결과로 돌아가는 경우에는 직접 설정을 지워서 이후 감지 결과가 반영되게 한다.
    if (!active === detected) delete siteOverrides[origin];
    else siteOverrides[origin] = active ? 'off' : 'on';
    await chrome.storage.local.set({ siteOverrides });
    reload();
  };
})();
