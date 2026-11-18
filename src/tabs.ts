// 페이지 환경(MAIN)에서 실행됨. 사이트가 창 크기를 지정해 여는 팝업(퀴즈·영상·문서 뷰어)을 새 탭으로 엶.
// 크기 옵션을 빼면 크롬이 탭으로 엶. 창 이름은 그대로 둬서 같은 종류는 같은 탭을 다시 씀.
// 이 환경은 설정을 못 읽어서, 켜짐 여부는 콘텐츠 스크립트가 붙이는 html 클래스(cmx-tabs)로 확인함.
const nativeOpen = window.open;
window.open = function (this: Window, url?: string | URL, name?: string, features?: string) {
  return nativeOpen.call(this, url, name, document.documentElement.classList.contains('cmx-tabs') ? undefined : features);
};
