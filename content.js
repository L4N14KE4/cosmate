// Runs on every lms.inu.ac.kr page at document_start. vod.js reuses the helpers below.
let cfg = { ...DEFAULTS };
const ready = chrome.storage.local.get(DEFAULTS).then(v => (cfg = v));
chrome.storage.onChanged.addListener(ch => {
  for (const k in ch) cfg[k] = ch[k].newValue;
  syncUnlockCss();
});

// LMS에서는 시험 응시와 답안검토를 포함한 모든 페이지에서 설정에 따라 우클릭·복사 차단을 해제한다.
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

const DL_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.9996 2.1001C12.4967 2.1001 12.8996 2.50304 12.8996 3.0001V14.8273L17.3632 10.3637C17.7147 10.0122 18.2845 10.0122 18.636 10.3637C18.9875 10.7152 18.9875 11.285 18.636 11.6365L12.636 17.6365C12.2845 17.988 11.7147 17.988 11.3632 17.6365L5.36321 11.6365C5.01174 11.285 5.01174 10.7152 5.36321 10.3637C5.71468 10.0122 6.28453 10.0122 6.63601 10.3637L11.0996 14.8273V3.0001C11.0996 2.50304 11.5026 2.1001 11.9996 2.1001ZM2.09961 21.0001C2.09961 20.503 2.50255 20.1001 2.99961 20.1001H20.9996C21.4967 20.1001 21.8996 20.503 21.8996 21.0001C21.8996 21.4972 21.4967 21.9001 20.9996 21.9001H2.99961C2.50255 21.9001 2.09961 21.4972 2.09961 21.0001Z" fill="#899199" class="svg-color"/></svg>';

const css = document.createElement('style');
css.textContent = `
  html.cmx-free * { -webkit-user-select: text !important; user-select: text !important; }
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

ready.then(() => {
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
