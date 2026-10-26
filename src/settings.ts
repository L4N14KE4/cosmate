// 콘텐츠 스크립트와 팝업이 함께 쓰는 기본 설정.
export const DEFAULTS = {
  courseLink: true,
  fileButton: true,
  previewFiles: true,
  rightClick: false,
  rightClickSites: [] as string[],
  siteOverrides: {} as Record<string, 'on' | 'off'>, // origin → 'on' | 'off': 자동 감지보다 우선하는 사용자의 사이트별 선택
  compactList: true,
  quizPrint: true,
  vodDownload: true,
  endNotify: true,
  autoNext: true,
  speedPanel: true,
  pipButton: true,
};

export type Settings = typeof DEFAULTS;
