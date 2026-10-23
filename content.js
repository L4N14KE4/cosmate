// 모든 페이지에서 document_start에 실행된다. 기능은 사이트가 켜진 곳(siteActive)에서만 붙이고,
// 아래 도우미 함수는 vod.js도 쓴다.
let cfg = { ...DEFAULTS };
const ready = chrome.storage.local.get(DEFAULTS).then(v => (cfg = v));
chrome.storage.onChanged.addListener(ch => {
  for (const k in ch) cfg[k] = ch[k].newValue;
  syncUnlockCss();
  syncCompact();
});

// 우클릭·복사 차단 해제. 전역 스위치(인천대 LMS 팝업)는 모든 사이트에, 사이트별 스위치(다른 사이트
// 팝업, rightClickSites)는 그 사이트에만 적용되며 퀴즈 응시·답안검토 화면도 포함한다.
const unlock = () => cfg.rightClick || cfg.rightClickSites.includes(location.origin);

// window 캡처 단계에서 먼저 받아 사이트(동영상 플레이어 등)의 차단 처리로 넘기지 않는다.
// 붙여넣기(paste)는 편집기가 동작하도록 건드리지 않는다.
for (const type of ['contextmenu', 'copy', 'cut', 'selectstart', 'dragstart']) {
  window.addEventListener(type, e => unlock() && e.stopImmediatePropagation(), true);
}
// 퀴즈 보안 창은 왼쪽 mousedown 기본 동작도 막아 드래그 선택이 안 된다. 퀴즈 답안검토·응시
// 화면에서는 컨트롤이 아닌 본문 위의 왼쪽 클릭을 풀어 주고, 다른 화면은 오른쪽 버튼만 처리한다.
// ponytail: 컨트롤 목록은 어림값이다. 드래그가 안 되는 위젯이 생기면 선택자를 추가한다.
const quizPage = ['/mod/quiz/review.php', '/mod/quiz/attempt.php'].includes(location.pathname);
const CONTROL = 'a,button,input,select,textarea,label,[role=button],[draggable="true"],.btn,[data-bs-toggle]';
window.addEventListener('mousedown', e => {
  if (!unlock()) return;
  if (e.button === 2) return e.stopImmediatePropagation();
  if (quizPage && e.button === 0 && !e.target.closest(CONTROL)) e.stopImmediatePropagation();
}, true);
// 전체 선택·복사·잘라내기 단축키(Windows는 Ctrl, Mac은 Cmd). e.code는 물리 키라 한글 입력 중에도 맞는다.
for (const type of ['keydown', 'keyup']) {
  window.addEventListener(type, e => unlock() && (e.ctrlKey || e.metaKey) && ['KeyA', 'KeyC', 'KeyX'].includes(e.code) && e.stopImmediatePropagation(), true);
}
// CSS user-select: none은 이벤트로 못 막아서, 해제 중에는 html 클래스 하나로 덮는다(나중에 생긴 요소 포함).
function syncUnlockCss() {
  document.documentElement.classList.toggle('cmx-free', unlock());
}
ready.then(syncUnlockCss);

// 홈 목록형 얇게 보기. 설정을 읽자마자 클래스를 붙여 큰 목록이 잠깐 보이지 않게 하고, 페이지를 다
// 읽은 뒤 사이트가 꺼져 있으면 뗀다. CSS는 코스모스 홈 목록에만 맞아서 다른 곳에는 영향이 없다.
let pageParsed = false;
function syncCompact() {
  document.documentElement.classList.toggle('cmx-compact', cfg.compactList && (!pageParsed || siteActive()));
}
ready.then(syncCompact);

const DL_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M11.9996 2.1001C12.4967 2.1001 12.8996 2.50304 12.8996 3.0001V14.8273L17.3632 10.3637C17.7147 10.0122 18.2845 10.0122 18.636 10.3637C18.9875 10.7152 18.9875 11.285 18.636 11.6365L12.636 17.6365C12.2845 17.988 11.7147 17.988 11.3632 17.6365L5.36321 11.6365C5.01174 11.285 5.01174 10.7152 5.36321 10.3637C5.71468 10.0122 6.28453 10.0122 6.63601 10.3637L11.0996 14.8273V3.0001C11.0996 2.50304 11.5026 2.1001 11.9996 2.1001ZM2.09961 21.0001C2.09961 20.503 2.50255 20.1001 2.99961 20.1001H20.9996C21.4967 20.1001 21.8996 20.503 21.8996 21.0001C21.8996 21.4972 21.4967 21.9001 20.9996 21.9001H2.99961C2.50255 21.9001 2.09961 21.4972 2.09961 21.0001Z" fill="#899199" class="svg-color"/></svg>';

const css = document.createElement('style');
css.textContent = `
  html.cmx-free * { -webkit-user-select: text !important; user-select: text !important; }
  /* 홈 목록형 행을 얇게(105px → 52px): 과목명과 태그를 한 줄로. 사이트 규칙이 #page-content로
     시작해서 !important가 필요하다. 576px 미만은 사이트 자체 모바일 배치를 쓴다. */
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

// sel에 맞는 요소마다 fn을 한 번씩 실행한다(나중에 생기는 요소 포함).
// ponytail: 호출마다 관찰자 하나가 DOM이 바뀔 때마다 다시 찾는다. LMS 페이지에서는 충분하다.
function onEach(sel, fn) {
  const seen = new WeakSet();
  const run = () => document.querySelectorAll(sel).forEach(el => seen.has(el) || (seen.add(el), fn(el)));
  new MutationObserver(run).observe(document, { childList: true, subtree: true });
  run();
}

// 사이트 토스트(.csms-toast) 모양. ms = 0이면 직접 지울 때까지 남고, onCancel을 주면 오른쪽에 취소
// 버튼을 붙인다. 강의 화면은 사이트의 토스트 상자를 쓰고, 없으면 상단 바 바로 아래에 만든다.
// 우리 <style>이 사이트 CSS보다 먼저 로드되어 .toast-container 규칙에 밀리므로 위치는 인라인으로 준다.
function toast(msg, type = 'guide', ms = 4000, onCancel) {
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
  if (onCancel) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm btn-secondary ms-3';
    b.textContent = '취소';
    b.onclick = () => onCancel(b);
    t.querySelector('.toast-body').append(b);
  }
  box.append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

// 첫 사용 안내를 사이트 모달 모양으로 띄우고, 동의하면 true를 돌려준다.
// .modal 클래스는 .modal-content가 사이트의 --bs-modal-* 값을 받도록 붙인다.
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

// 문서 뷰어가 부르는 worker.php. 원본 파일의 다운로드 주소를 알려 준다.
async function fileInfo(cmid) {
  for (let i = 0; i < 10; i++) {
    const t = await (await fetch('/local/csmsdoc/worker.php', {
      method: 'POST',
      body: new URLSearchParams({ id: cmid, tp: 'm', pg: 'ubfile' }),
    })).text();
    const j = JSON.parse(t.slice(t.indexOf('{"code"'))); // 첫 호출 앞에 PHP 경고가 붙을 수 있다
    if (!String(j.code).startsWith('2')) return j; // 2xx = 아직 변환 중
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('파일 변환이 끝나지 않았습니다. 잠시 후 다시 시도하세요.');
}

async function downloadUbfile(cmid) {
  const t = toast('파일을 준비하고 있습니다…', 'guide', 0);
  try {
    const j = await fileInfo(cmid);
    if (j.file_download !== '1' || !j.file_url) return toast('교수님이 다운로드를 허용하지 않은 파일입니다.', 'warning');
    fetch(`/mod/ubfile/view.php?id=${cmid}`); // 원래 흐름처럼 view.php를 방문해 열람 기록을 남긴다
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

// 사이트 켜짐 판단: 팝업에서 고른 사이트별 설정이 우선이고, 없으면 신버전 코스모스 화면을 자동
// 감지한다. 서버가 내려준 HTML에 아래 신호 중 하나라도 있으면 켠다. /local/ubion 링크와 body의
// coursemos- 클래스는 구버전 화면에도 나와서 쓰지 않는다.
const SIGNALS = [
  'link[href*="/theme/styles.php/coursemos/"]', // 테마 스타일시트(끝의 /로 구버전 coursemosv2 제외)
  'script[src*="ubion-courseware"]', // 신버전 코스웨어 스크립트(모든 페이지에 있지는 않음)
  '[class*="csms-"]', // 신버전 컴포넌트 클래스
];
const detected = () => SIGNALS.some(s => document.querySelector(s));
const siteActive = () => {
  const choice = cfg.siteOverrides[location.origin];
  return choice ? choice === 'on' : detected();
};
const parsed = new Promise(r => (document.readyState === 'loading' ? addEventListener('DOMContentLoaded', r, { once: true }) : r()));

// 팝업이 이 사이트의 켜짐/꺼짐을 표시하려고 최상위 프레임에 묻는다.
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (m.cmx === 'status') reply({ origin: location.origin, detected: detected(), active: siteActive() });
});

Promise.all([ready, parsed]).then(() => {
  pageParsed = true;
  syncCompact();
  if (!siteActive()) return;
  // 1. 이번 주 할 일: 과목명을 과목 링크로 바꾼다.
  if (cfg.courseLink) {
    onEach('.current-activity button.grid-row-course', btn => {
      const id = btn.dataset.bsTarget?.match(/accordion-course-(\d+)/)?.[1];
      const span = btn.querySelector('.cell-course .text');
      if (!id || !span) return;
      const a = document.createElement('a');
      a.href = `/course/view.php?id=${id}`;
      a.className = 'text text-truncate cmx-course-link';
      a.textContent = span.textContent;
      // 링크가 아코디언 버튼 안에 있어서 직접 이동하고 아코디언은 열지 않는다.
      a.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        e.metaKey || e.ctrlKey ? open(a.href) : location.assign(a.href);
      });
      span.replaceWith(a);
    });
  }

  // 7. 파일 옆 다운로드 아이콘.
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
    // 다운로드가 아니라 브라우저에서 열리는 첨부파일 링크(forcedownload 없음)에도 붙인다.
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

  // 8. 미리보기로 열기. 다운로드형 파일 카드(onclick 없음, view.php가 바로 파일로 넘김)는 사이트가
  // 보기형 카드에 쓰는 것과 같은 뷰어 팝업으로 열고, 과제·게시판 PDF 첨부파일(?forcedownload=1)은
  // 새 탭의 브라우저 PDF 뷰어로 연다. Ctrl/Cmd/Shift/Alt+클릭은 사이트 동작 그대로 둔다.
  // 설정은 클릭할 때 읽어서 팝업 스위치가 바로 적용된다.
  document.addEventListener('click', e => {
    if (!cfg.previewFiles || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    // 다운로드 아이콘(우리 것, 사이트 버튼)은 그대로 두고 파일 링크만 바꾼다.
    const att = e.target.closest?.('#region-main a[href*="/pluginfile.php/"][href*="forcedownload=1"]:not(.cmx-dl):not([class*="btn"])');
    if (att && /\.pdf$/i.test(new URL(att.href).pathname)) {
      e.preventDefault();
      e.stopPropagation();
      const u = new URL(att.href);
      u.searchParams.delete('forcedownload');
      // 과제: 표시를 빼면 서버가 브라우저에서 열리게 보낸다.
      if (u.pathname.includes('/mod_assign/')) return open(u.href, '_blank', 'noopener');
      // 게시판은 표시와 상관없이 다운로드로 보내서, PDF를 받아 메모리에서 연다. 팝업이 허용되는
      // 클릭 직후에 탭부터 연다.
      const w = open('', '_blank');
      if (!w) return;
      w.document.title = 'PDF를 불러오는 중…';
      w.document.body.textContent = 'PDF를 불러오는 중…';
      fetch(u.href)
        .then(r => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then(b => w.location.replace(URL.createObjectURL(new Blob([b], { type: 'application/pdf' }))))
        .catch(err => {
          w.close();
          toast(`PDF를 열지 못했습니다: ${err.message}`, 'danger', 6000);
        });
      return;
    }
    const a = e.target.closest?.('li.modtype_ubfile a.activity-container-link');
    if (!a || /window\.open/.test(a.getAttribute('onclick') || '')) return; // 보기형 카드는 사이트가 연다
    e.preventDefault();
    e.stopPropagation();
    open(`/mod/ubfile/viewer.php?id=${new URL(a.href).searchParams.get('id')}`, 'documentviewer',
      'width=1005,height=1005,toolbar=no,location=no,menubar=no,copyhistory=no,status=no,directories=no,scrollbars=yes,resizable=1');
  }, true);

  // 4. 퀴즈 답안검토 인쇄. 응시 화면에는 넣지 않는다(버튼 없음, Cmd+P도 사이트의 빈 인쇄 그대로).
  // 보안 창은 .quiz-secure-window * 로 모두 숨기므로 인쇄하는 동안만 그 클래스를 뗀다.
  if (cfg.quizPrint && location.pathname === '/mod/quiz/review.php') {
    let secure; // document_start에는 body가 없을 수 있어 인쇄할 때 읽는다
    addEventListener('beforeprint', () => {
      secure = document.body.classList.contains('quiz-secure-window');
      document.body.classList.remove('quiz-secure-window');
    });
    addEventListener('afterprint', () => document.body.classList.toggle('quiz-secure-window', secure));
    css.textContent += `@media print {
      #pw-nav, #pw-header, #pw-footer, #mod_quiz_navblock { display: none !important; }
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
