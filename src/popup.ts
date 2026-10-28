import { DEFAULTS, type Settings } from './settings';

// 페이지를 불러올 때 요소를 넣거나 바꾸는 옵션이라 새로고침해야 적용됨. 나머지는 바로 적용됨.
const NEEDS_REFRESH = ['courseLink', 'fileButton', 'quizPrint', 'calendarLinks', 'vodDownload', 'speedPanel', 'pipButton'];

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const cfg = (await chrome.storage.local.get(DEFAULTS)) as Settings;
  const flags = cfg as unknown as Record<string, boolean>;
  const url = (() => { try { return new URL(tab.url!); } catch {} })();
  const web = /^https?:$/.test(url?.protocol ?? '');
  const reload = () => {
    chrome.tabs.reload(tab.id!);
    window.close();
  };

  // 스위치·칩은 전역 설정을 바로 바꿈. 우클릭만 인천대 LMS 밖에서는 그 사이트(origin)에만 켜도록 구현함.
  for (const box of document.querySelectorAll<HTMLInputElement>('input[name]')) {
    if (box.name === 'rightClick' && url?.hostname !== 'lms.inu.ac.kr') {
      if (!web) {
        box.disabled = true;
        continue;
      }
      const sites = new Set(cfg.rightClickSites);
      box.checked = sites.has(url!.origin);
      box.onchange = () => {
        box.checked ? sites.add(url!.origin) : sites.delete(url!.origin);
        chrome.storage.local.set({ rightClickSites: [...sites] });
      };
      continue;
    }
    box.checked = flags[box.name];
    box.onchange = () => chrome.storage.local.set({ [box.name]: box.checked });
  }

  // 하단 새로고침 바: 페이지를 불러올 때의 값과 다를 때만 보이고, 되돌리면 숨김. 스위치는 바로 저장되므로
  // 팝업을 연 순간의 저장값과 비교하면 새로고침 없이 닫았다 다시 열 때 바가 사라짐. 그래서 기준값은
  // 페이지에 물어보고, 답을 받기 전에는 저장값을 씀.
  const bar = document.getElementById('apply')!;
  let applied = flags;
  const syncBar = () => {
    bar.hidden = !NEEDS_REFRESH.some(k => document.querySelector<HTMLInputElement>(`[name=${k}]`)!.checked !== applied[k]);
  };
  document.addEventListener('change', e => NEEDS_REFRESH.includes((e.target as HTMLInputElement).name) && syncBar());
  bar.querySelector('button')!.onclick = reload;

  // 이 사이트 켜기/끄기(맨 위 묶음의 스위치): 감지된 코스모스 페이지는 켜지고 나머지는 꺼지며, 사용자가
  // 어느 쪽으로든 바꿀 수 있음. 감지 결과는 콘텐츠 스크립트가 알고 있어서 최상위 프레임에 물어봄.
  const status = document.getElementById('site-status')!;
  const toggle = document.getElementById('site-toggle') as HTMLInputElement;
  const info: { origin: string; detected: boolean; active: boolean; loaded: Record<string, boolean> } | null =
    await chrome.tabs.sendMessage(tab.id!, { cmx: 'status' }, { frameId: 0 }).catch(() => null);
  if (!info) {
    // 응답 없음: 확장을 쓸 수 없는 페이지(chrome://, 웹 스토어)이거나, 확장을 새로고침하기 전에
    // 열려서 새로고침할 때까지 연결이 끊긴 탭임. 어느 쪽이든 하단 바는 쓰지 않음.
    bar.remove();
    if (web && !/(^|\.)chromewebstore\.google\.com$/.test(url!.hostname)) {
      // 새로고침할 수 있으면 설정을 흐리게 가리고(inert라 Tab도 막힘) 가운데 버튼으로 새로고침하게 함.
      for (const group of document.querySelectorAll<HTMLElement>('section')) group.inert = true;
      const stale = document.getElementById('stale')!;
      stale.querySelector('button')!.onclick = reload;
      stale.hidden = false;
    } else {
      document.getElementById('notice')!.textContent = '이 페이지에서는 설정할 수 없어요.';
    }
    return;
  }

  const { origin, detected, active, loaded } = info;
  applied = loaded;
  syncBar();
  // 이 사이트가 꺼져 있으면 코스모스 기능이 돌지 않으므로 해당 묶음을 회색으로 만들고 조작을
  // 막음. 우클릭 묶음은 일반 사이트에서도 쓰므로 그대로 둠.
  for (const group of document.querySelectorAll<HTMLElement>('.needs-site')) group.inert = !active;
  const { siteOverrides } = cfg;
  const forced = siteOverrides[origin];
  document.getElementById('site-host')!.textContent = new URL(origin).host;
  status.textContent =
    forced === 'on' ? '직접 켠 사이트' :
    forced === 'off' ? '직접 끈 사이트' :
    detected ? '코스모스 사이트로 감지됨' : '코스모스 사이트가 아님';
  toggle.checked = active;
  document.getElementById('site')!.hidden = false;
  toggle.onchange = async () => {
    // 자동 감지 결과로 돌아가는 경우에는 직접 설정을 지워 이후 감지 결과가 반영되게 함.
    if (!active === detected) delete siteOverrides[origin];
    else siteOverrides[origin] = active ? 'off' : 'on';
    await chrome.storage.local.set({ siteOverrides });
    reload();
  };
  // 채운 값이 한 번 그려진 다음 프레임에 전환 효과를 켬. 같은 프레임에 켜면 스위치가 켜지는 모습이 재생됨.
})().finally(() => requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.classList.remove('preload'))));
