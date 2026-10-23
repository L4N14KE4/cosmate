async function siteScriptId(origin) {
  const bytes = new TextEncoder().encode(origin);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return 'right-click-' + [...hash.slice(0, 12)].map(x => x.toString(16).padStart(2, '0')).join('');
}

chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  let url;
  try { url = new URL(tab.url); } catch {}
  const isLms = url?.hostname === 'lms.inu.ac.kr';

  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    // The LMS setting is shared across LMS pages, including quiz attempts.
    if (box.name !== 'rightClick' || isLms) {
      box.checked = cfg[box.name];
      box.onchange = () => chrome.storage.local.set({ [box.name]: box.checked });
      continue;
    }

    if (!url || !['http:', 'https:'].includes(url.protocol)) {
      box.disabled = true;
      continue;
    }

    // Other sites are enabled per origin, across pages on the current site.
    const origin = url.origin;
    const pattern = `${origin}/*`;
    const id = await siteScriptId(origin);
    box.checked = cfg.rightClickSites.includes(origin);
    box.onchange = async () => {
      const enabled = box.checked;
      if (enabled && !await chrome.permissions.request({ origins: [pattern] })) {
        box.checked = false;
        return;
      }

      const sites = new Set((await chrome.storage.local.get('rightClickSites')).rightClickSites ?? []);
      enabled ? sites.add(origin) : sites.delete(origin);
      await chrome.storage.local.set({ rightClickSites: [...sites] });

      if (enabled) {
        const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
        if (!registered.length) await chrome.scripting.registerContentScripts([{
          id, matches: [pattern], js: ['right-click.js'], runAt: 'document_start',
        }]);
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['right-click.js'] });
      } else {
        await chrome.scripting.unregisterContentScripts({ ids: [id] });
      }
    };
  }
});

let staleTab = false; // set when the page doesn't answer (see the site block below)

// This site on/off: auto-detected Coursemos pages are on, everything else off; the user can
// override either way. The content script knows the detection result, so ask the top frame.
chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  const section = document.getElementById('site');
  const status = document.getElementById('site-status');
  const button = document.getElementById('site-toggle');
  const info = await chrome.tabs.sendMessage(tab.id, { cmx: 'status' }, { frameId: 0 }).catch(() => null);
  section.hidden = false;
  if (!info) {
    staleTab = true; // this card already offers the refresh, so the bottom button stays hidden
    // No answer: either the page can't run extensions (chrome://, the Web Store), or it was
    // opened before the extension was last reloaded, which cuts it off until a refresh.
    const url = (() => { try { return new URL(tab.url); } catch {} })();
    const refreshable = /^https?:$/.test(url?.protocol) && !/(^|\.)chromewebstore\.google\.com$/.test(url.hostname);
    status.textContent = refreshable
      ? '확장 업데이트 전에 열린 탭이에요. 새로고침하면 설정할 수 있어요.'
      : '이 페이지에서는 설정할 수 없습니다.';
    if (refreshable) {
      button.textContent = '이 페이지 새로고침';
      button.hidden = false;
      button.onclick = () => {
        chrome.tabs.reload(tab.id);
        window.close();
      };
    }
    return;
  }

  const { origin, detected, active } = info;
  // Off for this site: the Coursemos features don't run here, so grey those groups out and make
  // them inert. The right-click group stays usable: it also works on ordinary sites.
  for (const group of document.querySelectorAll('.needs-site')) group.inert = !active;
  const { siteOverrides = {} } = await chrome.storage.local.get('siteOverrides');
  const forced = siteOverrides[origin];
  status.textContent =
    forced === 'on' ? '직접 켠 사이트입니다.' :
    forced === 'off' ? '직접 끈 사이트입니다.' :
    detected ? '코스모스 LXP 사이트로 감지되어 켜져 있습니다.' : '코스모스 LXP 사이트로 감지되지 않아 꺼져 있습니다.';
  button.textContent = active ? '이 사이트에서 끄기' : '이 사이트에서 켜기';
  button.hidden = false;
  button.onclick = async () => {
    // Back to what auto-detection says = drop the override, so future detection changes apply.
    if (!active === detected) delete siteOverrides[origin];
    else siteOverrides[origin] = active ? 'off' : 'on';
    await chrome.storage.local.set({ siteOverrides });
    chrome.tabs.reload(tab.id);
    window.close();
  };
});

// Bottom refresh button. Four options only take effect after a page refresh (they insert or
// replace page elements while loading); the rest apply immediately and never show it. It shows
// while any of the five differs from how it was when the popup opened, so toggling back hides it.
const NEEDS_REFRESH = ['courseLink', 'fileButton', 'quizPrint', 'vodDownload', 'speedPanel'];
chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  const apply = document.getElementById('apply');
  document.addEventListener('change', e => {
    if (!NEEDS_REFRESH.includes(e.target.name)) return;
    apply.hidden = staleTab || !NEEDS_REFRESH.some(k => document.querySelector(`[name=${k}]`).checked !== cfg[k]);
  });
  apply.onclick = () => {
    chrome.tabs.reload(tab.id);
    window.close();
  };
});
