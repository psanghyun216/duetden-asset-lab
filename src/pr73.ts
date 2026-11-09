import type { SdItems, SdRect } from './app/sdCatalog.ts';

/**
 * 앱 PR #73(기본 헤어 남 애즈펌·여 가르마 긴 생머리)은 아직 main 에 안 들어가서 앱 목록(catalog.generated.ts)에 없다.
 * 처음 화면에 기본 헤어를 입혀 두려고 그 그림만 따로 실어 둔다. 서버 목록에 같은 ID 가 있으면 서버 쪽이 이긴다.
 * PR #73 이 병합되면 scripts/sync-from-app.sh 를 다시 돌리고 이 파일·public/pr73 을 지우면 된다.
 */
export const PR73: { items: Pick<SdItems, 'hair'>; rects: Record<string, SdRect>; defaults: { male: string; female: string } } = {
  items: {
    hair: {
      asperm01: { name: '애즈펌 (PR #73 기본, 미반영)', sex: 'male', back: 'pr73/hair-back_asperm01_m.webp', front: 'pr73/hair-front_asperm01_m.webp' },
      nbpart01: { name: '가르마 긴 생머리 (PR #73 기본, 미반영)', sex: 'female', back: 'pr73/hair-back_nbpart01_f.webp', front: 'pr73/hair-front_nbpart01_f.webp' },
    },
  },
  rects: {
    'pr73/hair-back_asperm01_m.webp': { x: 312, y: 122, w: 382, h: 376 },
    'pr73/hair-back_nbpart01_f.webp': { x: 254, y: 158, w: 490, h: 654 },
    'pr73/hair-front_asperm01_m.webp': { x: 240, y: 96, w: 524, h: 380 },
    'pr73/hair-front_nbpart01_f.webp': { x: 248, y: 144, w: 498, h: 658 },
  },
  defaults: { male: 'asperm01', female: 'nbpart01' },
};
