/** 앱 Appearance 중 SD 렌더(sdModel.ts)가 쓰는 칸만. 앱: mobile/src/features/space/domain/appearance.ts */
export type Appearance = {
  faceProfileId: 'male' | 'female';
  hairStyleId: string;
  expressionId?: string;
  topId: string;
  bottomId: string;
  shoesId: string;
};
