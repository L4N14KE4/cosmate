// 콘텐츠 스크립트 진입점. 공통 기능(core)은 모든 프레임에서, 강의 화면 기능(vod)은 최상위 창에서만 실행함.
import './core';
import { initVod } from './vod';

if (window === window.top) initVod();
