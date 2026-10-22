(() => {
  const syncRightClick = async () => {
    const { rightClickSites = [] } = await chrome.storage.local.get('rightClickSites');
    document.documentElement.classList.toggle('cmx-free', rightClickSites.includes(location.origin));
  };
  if (window.__cmxRightClickInstalled) return syncRightClick();
  window.__cmxRightClickInstalled = true;

  const style = document.createElement('style');
  style.textContent = 'html.cmx-free * { -webkit-user-select: text !important; user-select: text !important; }';
  document.documentElement.append(style);
  for (const type of ['contextmenu', 'copy', 'cut', 'selectstart', 'dragstart']) {
    window.addEventListener(type, event => {
      if (document.documentElement.classList.contains('cmx-free')) event.stopImmediatePropagation();
    }, true);
  }
  window.addEventListener('mousedown', event => {
    if (document.documentElement.classList.contains('cmx-free') && event.button === 2) event.stopImmediatePropagation();
  }, true);
  for (const type of ['keydown', 'keyup']) {
    window.addEventListener(type, event => {
      if (document.documentElement.classList.contains('cmx-free') && (event.ctrlKey || event.metaKey) && ['KeyA', 'KeyC', 'KeyX'].includes(event.code)) event.stopImmediatePropagation();
    }, true);
  }
  chrome.storage.onChanged.addListener(syncRightClick);
  syncRightClick();
})();
