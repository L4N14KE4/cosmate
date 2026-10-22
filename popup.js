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
