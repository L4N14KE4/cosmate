// Shared by the content scripts and the popup.
const DEFAULTS = {
  courseLink: true,
  fileButton: true,
  previewFiles: true,
  rightClick: false,
  rightClickSites: [],
  siteOverrides: {}, // origin -> 'on' | 'off': the user's per-site choice over auto-detection
  compactList: true,
  quizPrint: true,
  vodDownload: true,
  endNotify: true,
  autoNext: true,
  speedPanel: true,
  pipButton: true,
};
