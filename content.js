// Runs on every page at document_start; features only wire up where the site is on (see
// siteActive below). vod.js reuses the helpers below.
let cfg = { ...DEFAULTS };
const ready = chrome.storage.local.get(DEFAULTS).then(v => (cfg = v));
chrome.storage.onChanged.addListener(ch => {
  for (const k in ch) cfg[k] = ch[k].newValue;
  syncUnlockCss();
  syncCompact();
});

// LMS에서는 시험 응시와 답안검토를 포함한 모든 페이지에서 설정에 따라 우클릭·복사 차단을 해제한다.
// The extension now runs at other schools' LMS too; this unlock stays on INU only.
const unlock = () => cfg.rightClick

// Our window capture listener runs before the site's handlers (e.g. the video player)
// and keeps them from seeing the event. paste is left alone so editors keep working.
for (const type of ['contextmenu', 'copy', 'cut', 'selectstart', 'dragstart']) {
  window.addEventListener(type, e => unlock() && e.stopImmediatePropagation(), true);
}
// The quiz secure window also cancels the LEFT mousedown's default, which stops mouse
// drag-selection before it starts. On both quiz review and attempt pages, neutralize that
// over plain content (not over controls) so text can be selected; elsewhere only the right button is handled.
// ponytail: control list is a heuristic — add a selector if some widget stops dragging.
const quizPage = ['/mod/quiz/review.php', '/mod/quiz/attempt.php'].includes(location.pathname);
const CONTROL = 'a,button,input,select,textarea,label,[role=button],[draggable="true"],.btn,[data-bs-toggle]';
window.addEventListener('mousedown', e => {
  if (!unlock()) return;
  if (e.button === 2) return e.stopImmediatePropagation();
  if (quizPage && e.button === 0 && !e.target.closest(CONTROL)) e.stopImmediatePropagation();
}, true);
// Select-all / copy / cut shortcuts: Ctrl on Windows, Cmd on Mac. e.code is the physical
// key, so it also matches while the Korean IME is on.
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, e => unlock() && (e.ctrlKey || e.metaKey) && ['KeyA', 'KeyC', 'KeyX'].includes(e.code) && e.stopImmediatePropagation(), true);
}
// CSS `user-select: none` isn't an event, so lift it with one rule while unlocked
// (covers elements added later, and switching off just drops the class).
function syncUnlockCss() {
  document.documentElement.classList.toggle('cmx-free', unlock());
}
ready.then(syncUnlockCss);

// Compact home list ("목록형"). The class goes on as soon as the settings are read so the big
// list never flashes before the first paint; the CSS only matches the Coursemos home list, so it
// is inert elsewhere. Once the page is parsed (see below) it is dropped again if the site is off.
let pageParsed = false;
function syncCompact() {
  document.documentElement.classList.toggle('cmx-compact', cfg.compactList && (!pageParsed || siteActive()));
}
ready.then(syncCompact);

const DL_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.9996 2.1001C12.4967 2.1001 12.8996 2.50304 12.8996 3.0001V14.8273L17.3632 10.3637C17.7147 10.0122 18.2845 10.0122 18.636 10.3637C18.9875 10.7152 18.9875 11.285 18.636 11.6365L12.636 17.6365C12.2845 17.988 11.7147 17.988 11.3632 17.6365L5.36321 11.6365C5.01174 11.285 5.01174 10.7152 5.36321 10.3637C5.71468 10.0122 6.28453 10.0122 6.63601 10.3637L11.0996 14.8273V3.0001C11.0996 2.50304 11.5026 2.1001 11.9996 2.1001ZM2.09961 21.0001C2.09961 20.503 2.50255 20.1001 2.99961 20.1001H20.9996C21.4967 20.1001 21.8996 20.503 21.8996 21.0001C21.8996 21.4972 21.4967 21.9001 20.9996 21.9001H2.99961C2.50255 21.9001 2.09961 21.4972 2.09961 21.0001Z" fill="#899199" class="svg-color"/></svg>';

const css = document.createElement('style');
css.textContent = `
  html.cmx-free * { -webkit-user-select: text !important; user-select: text !important; }
  /* Thin rows for the home list view (105px -> 52px): title and tags on one line, smaller type.
     !important because the site's own rules start with #page-content. Desktop widths only; the
     site has its own stacked layout below 576px. */
  @media (min-width: 576px) {
    html.cmx-compact ul.course-lists-listview { gap: 6px !important; }
    html.cmx-compact .course-list-item .course-thumbnail { width: 12px !important; }
    html.cmx-compact .course-list-item .course-info { padding: 13px 20px 13px 14px !important; gap: 12px !important; }
    html.cmx-compact .course-list-item .course-info-header { flex-direction: row !important; align-items: center !important; gap: 12px !important; padding-right: 0 !important; min-width: 0; }
    html.cmx-compact .course-list-item .course-info-header > * { width: auto !important; }
    html.cmx-compact .course-list-item .course-info-header h5 { order: -1; margin: 0 !important; font-size: 16px !important; line-height: 24px !important; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    html.cmx-compact .course-list-item .course-semester-wrap { flex: none; flex-wrap: nowrap !important; --csms-label-font-size: 12px !important; font-size: 12px !important; }
    html.cmx-compact .course-list-item .course-info-meta { width: 108px !important; }
    html.cmx-compact .course-list-item .professors { --csms-label-font-size: 13px !important; font-size: 13px !important; }
    html.cmx-compact .course-list-item .professors .csms-avata { --csms-avata-size: 24px; width: 24px; height: 24px; font-size: 13px !important; line-height: 24px !important; }
  }
  .cmx-course-link { color: inherit; text-decoration: underline; }
  .cmx-course-link:hover { color: var(--csms-tx-semantic-info-primary); }
  .cmx-dl { flex: none; align-self: center; margin-left: 8px; border: 0; background: none; cursor: pointer; }
  .activity-item:has(> .cmx-dl) { position: relative; padding-right: 56px; }
  .activity-item > .cmx-dl { position: absolute; right: 16px; top: 50%; transform: translateY(-50%); margin: 0; }
  .cmx-toast { pointer-events: auto; }
  dialog.cmx-dialog { position: fixed; inset: 0; display: none; width: min(480px, calc(100% - 32px)); height: fit-content; margin: auto; padding: 0; border: 0; background: none; box-shadow: none; overflow: visible; }
  dialog.cmx-dialog[open] { display: block; }
  dialog.cmx-dialog::backdrop { background: rgba(0, 0, 0, .28); }
  dialog.cmx-dialog .modal-content { box-shadow: rgba(10, 13, 18, .08) 0 12px 16px -4px, rgba(10, 13, 18, .03) 0 4px 6px -2px; }
  dialog.cmx-dialog .modal-body { white-space: pre-line; }
`;
document.documentElement.append(css);

// Calls fn once for every element matching sel, including ones rendered later.
// ponytail: one observer per call re-queries on each mutation batch; fine for LMS pages.
function onEach(sel, fn) {
  const seen = new WeakSet();
  const run = () => document.querySelectorAll(sel).forEach(el => seen.has(el) || (seen.add(el), fn(el)));
  new MutationObserver(run).observe(document, { childList: true, subtree: true });
  run();
}

// Site toast markup (.csms-toast); ms = 0 keeps it until removed. Lecture pages have the
// site's own toast container; elsewhere ours hangs right under the fixed top bar.
// Position is inline because our <style> loads before the page CSS, so .toast-container would win.
function toast(msg, type = 'guide', ms = 4000) {
  let box = document.querySelector('.csms-toast-container');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast-container csms-toast-container cmx-toasts';
    document.body.append(box);
  }
  if (box.classList.contains('cmx-toasts')) {
    const bar = document.querySelector('#pw-header')?.getBoundingClientRect();
    box.style.cssText = `position: fixed; top: ${bar?.bottom ?? 0}px; left: ${bar?.left ?? 0}px; width: ${bar?.width ?? innerWidth}px;`;
  }
  const t = document.createElement('div');
  t.className = `toast csms-toast csms-toast-${type} csms-toast-slide-down show cmx-toast`;
  t.setAttribute('role', 'alert');
  t.innerHTML = '<div class="toast-body"><div class="toast-text"></div></div>';
  t.querySelector('.toast-text').textContent = msg;
  box.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

// First-use notice in the site's modal markup; resolves true once the user agreed.
// The dialog carries .modal only so .modal-content picks up the site's --bs-modal-* variables.
async function notice(key, title, body) {
  const k = 'notice_' + key;
  if ((await chrome.storage.local.get(k))[k]) return true;
  const d = document.createElement('dialog');
  d.className = 'modal cmx-dialog';
  d.innerHTML = `<form method="dialog" class="modal-content">
    <div class="modal-header"><h5 class="modal-title"></h5></div>
    <div class="modal-body"></div>
    <div class="modal-footer">
      <button value="" class="btn btn-secondary">취소</button>
      <button value="ok" class="btn btn-primary">동의하고 계속</button>
    </div></form>`;
  d.querySelector('.modal-title').textContent = title;
  d.querySelector('.modal-body').textContent = body;
  document.body.append(d);
  d.showModal();
  await new Promise(r => d.addEventListener('close', r));
  d.remove();
  if (d.returnValue !== 'ok') return false;
  await chrome.storage.local.set({ [k]: true });
  return true;
}

function dlIcon(tag) {
  const el = document.createElement(tag);
  el.className = 'btn-csms-icon btn-csms-icon-gray-nospace-secondary btn-csms-icon-sm cmx-dl';
  el.title = '다운로드';
  el.innerHTML = DL_SVG;
  return el;
}

// worker.php is what the document viewer calls; it returns the original file's download URL.
async function fileInfo(cmid) {
  for (let i = 0; i < 10; i++) {
    const t = await (await fetch('/local/csmsdoc/worker.php', {
      method: 'POST',
      body: new URLSearchParams({ id: cmid, tp: 'm', pg: 'ubfile' }),
    })).text();
    const j = JSON.parse(t.slice(t.indexOf('{"code"'))); // first call may be prefixed by a PHP warning
    if (!String(j.code).startsWith('2')) return j; // 2xx = viewer still converting
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('파일 변환이 끝나지 않았습니다. 잠시 후 다시 시도하세요.');
}

async function downloadUbfile(cmid) {
  const t = toast('파일을 준비하고 있습니다…', 'guide', 0);
  try {
    const j = await fileInfo(cmid);
    if (j.file_download !== '1' || !j.file_url) return toast('교수님이 다운로드를 허용하지 않은 파일입니다.', 'warning');
    fetch(`/mod/ubfile/view.php?id=${cmid}`); // same visit the normal flow makes, so the activity still counts as viewed
    const a = document.createElement('a');
    a.href = j.file_url;
    a.download = '';
    a.click();
  } catch (e) {
    toast(e.message, 'danger');
  } finally {
    t.remove();
  }
}

// The extension runs on every site, so features only wire up where the site is switched on:
// by the user's per-site choice (popup), else by auto-detection of the new Coursemos UI.
// Detection ORs several signals so a school that changes one still matches. All of them are in
// the server-rendered HTML, so the answer is the same at DOMContentLoaded and whenever the
// popup asks. Measured on 107 saved LMS pages: none hit a non-Coursemos page, and none hit the
// old `coursemosv2` theme except `ubion-courseware` / `csms-` on 2 of 33 (transitional pages).
// Deliberately NOT used:
//  - `/local/ubion` links: 27 of the 33 old-theme pages have them, and they'd switch the
//    extension on for a layout it doesn't fit.
//  - `<body class="coursemos-…">`: absent in the saved HTML, but old-theme pages (cyber.ewha.ac.kr)
//    add it from JS after load, so it flags old layouts and shows up at unpredictable times.
// The trailing slash in the theme path keeps `coursemosv2` out.
const SIGNALS = [
  'link[href*="/theme/styles.php/coursemos/"]', // theme stylesheet
  'script[src*="ubion-courseware"]', // new-UI courseware bundle (not on every page)
  '[class*="csms-"]', // new-UI component classes
];
const detected = () => SIGNALS.some(s => document.querySelector(s));
const siteActive = () => {
  const choice = cfg.siteOverrides[location.origin];
  return choice ? choice === 'on' : detected();
};
const parsed = new Promise(r => (document.readyState === 'loading' ? addEventListener('DOMContentLoaded', r, { once: true }) : r()));
Promise.all([ready, parsed]).then(() => {
  pageParsed = true;
  syncCompact();
});

// The popup asks the top frame about this site, to label its on/off switch.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.cmx === 'status') reply({ origin: location.origin, detected: detected(), active: siteActive() });
});

Promise.all([ready, parsed]).then(() => {
  if (!siteActive()) return;
  // 1. 이번 주 할 일: course name links to the course.
  if (cfg.courseLink) {
    onEach('.current-activity button.grid-row-course', btn => {
      const id = btn.dataset.bsTarget?.match(/accordion-course-(\d+)/)?.[1];
      const span = btn.querySelector('.cell-course .text');
      if (!id || !span) return;
      const a = document.createElement('a');
      a.href = `/course/view.php?id=${id}`;
      a.className = 'text text-truncate cmx-course-link';
      a.textContent = span.textContent;
      // The link sits inside the accordion button, so navigate ourselves and keep the accordion shut.
      a.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        e.metaKey || e.ctrlKey ? open(a.href) : location.assign(a.href);
      });
      span.replaceWith(a);
    });
  }

  // 7. Download icon next to files.
  if (cfg.fileButton) {
    const addUbfileButton = (where, cmid, append) => {
      const b = dlIcon('button');
      b.type = 'button';
      b.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        downloadUbfile(cmid);
      });
      append ? where.append(b) : where.after(b);
    };
    onEach('li.modtype_ubfile .activity-item', item => {
      addUbfileButton(item, item.closest('li').id.replace('module-', ''), true);
    });
    onEach('.current-activity a.cell-activity-link[href*="/mod/ubfile/view.php"]', a => {
      addUbfileButton(a, new URL(a.href).searchParams.get('id'));
    });
    // Board/assignment attachments that open in the browser instead of downloading.
    onEach('#region-main a[href*="/pluginfile.php/"]:not([href*="forcedownload"]):not(.cmx-dl)', a => {
      const d = dlIcon('a');
      const u = new URL(a.href);
      u.searchParams.set('forcedownload', '1');
      d.href = u.href;
      d.style.display = 'inline-flex';
      d.style.verticalAlign = 'middle';
      a.after(d);
    });
  }

  // 8. File cards: some files are "download mode" (the teacher's setting): the card link has no
  // inline onclick and view.php redirects straight to the file, so a click downloads it. Open
  // those in the document viewer popup instead, same call the site makes for "viewer mode"
  // cards. Cmd/Ctrl/Shift/Alt+click keeps the site's behavior. cfg is read at click time, so
  // the popup switch takes effect immediately.
  document.addEventListener('click', e => {
    if (!cfg.previewFiles || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest?.('li.modtype_ubfile a.activity-container-link');
    if (!a || /window\.open/.test(a.getAttribute('onclick') || '')) return; // viewer mode: the site opens it
    e.preventDefault();
    e.stopPropagation();
    open(`/mod/ubfile/viewer.php?id=${new URL(a.href).searchParams.get('id')}`, 'documentviewer',
      'width=1005,height=1005,toolbar=no,location=no,menubar=no,copyhistory=no,status=no,directories=no,scrollbars=yes,resizable=1');
  }, true);

  // 4. Quiz review printing — never during an exam attempt (no button, and Cmd+P keeps the
  // site's blank print). The secure-window quiz hides everything via `.quiz-secure-window *`,
  // so drop that class for the duration of the print.
  if (cfg.quizPrint && location.pathname === '/mod/quiz/review.php') {
    let secure; // body may not exist yet at document_start, so read it at print time
    addEventListener('beforeprint', () => {
      secure = document.body.classList.contains('quiz-secure-window');
      document.body.classList.remove('quiz-secure-window');
    });
    addEventListener('afterprint', () => document.body.classList.toggle('quiz-secure-window', secure));
    css.textContent += `@media print {
      #pw-nav, #pw-header, #pw-footer, #mod_quiz_navblock, .cmx-noprint { display: none !important; }
      #page { margin-left: 0 !important; }
      #page-content { padding-left: 0 !important; }
    }`;
    onEach('#mod_quiz_navblock .othernav', nav => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-secondary w-100 mt-2';
      b.textContent = '인쇄';
      b.onclick = async () => {
        if (await notice('print', '퀴즈 인쇄 안내', '인쇄 기능은 개인 복습 용도로만 사용해 주세요.\n시험 문제와 답안을 다른 사람에게 공유하거나 인터넷에 올리면 안 됩니다.')) print();
      };
      nav.append(b);
    });
  }
});
