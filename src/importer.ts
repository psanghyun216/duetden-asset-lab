/**
 * 관리 페이지 업로드(server/src/domain/sdAssets/importer.ts)를 브라우저로 옮긴 것.
 * 규칙 계산(맞춤·나누기·눈 맞춤·구역 검사)은 앱 저장소의 sdKit.ts 를 그대로 쓰고,
 * 서버가 sharp 로 하던 그림 읽기·크기 바꾸기만 캔버스로 한다(배율이 바뀔 때만 픽셀이 아주 조금 다를 수 있음).
 */
import {
  alignSdEyes,
  alphaMask,
  checkSdLayers,
  clearFlatBackground,
  fitPlacement,
  fitSdLayers,
  sdCheckSexes,
  splitSdHair,
  SD_FIT_RANGE,
  SD_H,
  SD_SEXES,
  SD_W,
  sdKitMaskNames,
  type SdFileKey,
  type SdFit,
  type SdItemSex,
  type SdKit,
  type SdKits,
  type SdKitSlot,
  type SdKitSpec,
  type SdLayerAlpha,
} from './app/sdKit.ts';

export type Rgba = Uint8Array;

function canvas2d(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  return { c, ctx };
}

async function decode(blob: Blob): Promise<{ data: Uint8Array; w: number; h: number }> {
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const { ctx } = canvas2d(bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close();
  return { data: new Uint8Array(img.data.buffer), w: img.width, h: img.height };
}

export const toImageData = (rgba: Rgba, w = SD_W, h = SD_H) => new ImageData(new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.byteLength), w, h);

function resize(rgba: Rgba, w: number, h: number, to: number): Rgba {
  const src = canvas2d(w, h);
  src.ctx.putImageData(toImageData(rgba, w, h), 0, 0);
  const dst = canvas2d(to, to);
  dst.ctx.imageSmoothingEnabled = true;
  dst.ctx.imageSmoothingQuality = 'high';
  dst.ctx.drawImage(src.c, 0, 0, to, to);
  return new Uint8Array(dst.ctx.getImageData(0, 0, to, to).data.buffer);
}

/** server toSdCanvas 와 같은 순서: 칠한 배경 지우기 → 정사각 여백 → 1000 으로 */
export async function toSdCanvas(file: Blob): Promise<{ rgba: Rgba; notes: string[] }> {
  const notes: string[] = [];
  let { data, w, h } = await decode(file);
  if (clearFlatBackground(data, w, h)) notes.push('투명 배경이 아니어서 바깥 배경을 지웠어요');
  if (w !== h) {
    const side = Math.max(w, h);
    const padX = side - w, padY = side - h;
    const out = new Uint8Array(side * side * 4);
    for (let y = 0; y < h; y++) out.set(data.subarray(y * w * 4, (y + 1) * w * 4), ((y + (padY >> 1)) * side + (padX >> 1)) * 4);
    notes.push(`정사각이 아니어서(${w}x${h}) 가운데에 두고 여백을 붙였어요`);
    data = out; w = h = side;
  }
  if (w !== SD_W) {
    notes.push(`캔버스 ${w}x${w} → ${SD_W}x${SD_H}로 맞췄어요`);
    data = resize(data, w, w, SD_W);
  }
  return { rgba: data, notes };
}

/** server applySdFit 와 같음 */
export function applySdFit(rgba: Rgba, fit: SdFit): Rgba {
  if (fit.scale === 1 && fit.dx === 0 && fit.dy === 0) return rgba;
  const { size, left, top } = fitPlacement(fit);
  const src = fit.scale === 1 ? rgba : resize(rgba, SD_W, SD_H, size);
  const out = new Uint8Array(SD_W * SD_H * 4);
  const x0 = Math.max(0, left), x1 = Math.min(SD_W, left + size);
  if (x1 <= x0) return out;
  for (let y = 0; y < size; y++) {
    const ty = top + y;
    if (ty < 0 || ty >= SD_H) continue;
    out.set(src.subarray((y * size + (x0 - left)) * 4, (y * size + (x1 - left)) * 4), (ty * SD_W + x0) * 4);
  }
  return out;
}

/** 키트(남녀 spec.json + 마스크) 읽기 */
export async function loadKits(base: string): Promise<SdKits> {
  const read = async (sex: (typeof SD_SEXES)[number]): Promise<SdKit> => {
    const spec = (await (await fetch(`${base}/${sex}/spec.json`)).json()) as SdKitSpec;
    const masks: Record<string, Uint8Array> = {};
    await Promise.all(sdKitMaskNames(spec).map(async (rel) => {
      const { data, w, h } = await decode(await (await fetch(`${base}/${sex}/${rel}`)).blob());
      if (w !== SD_W || h !== SD_H) throw new Error(`kit ${sex}/${rel}: ${SD_W}x${SD_H} 이어야 해요`);
      const m = new Uint8Array(SD_W * SD_H);
      for (let p = 0; p < m.length; p++) m[p] = data[p * 4] > 127 ? 1 : 0;
      masks[rel] = m;
    }));
    return { sex, spec, masks };
  };
  const [male, female] = await Promise.all([read('male'), read('female')]);
  return { male, female };
}

export type ImportResult = {
  ok: boolean;
  /** 맞춘 레이어(1000x1000). 헤어 한 장은 front/back 으로 나뉘어 들어온다 */
  layers: Partial<Record<SdFileKey, Rgba>>;
  problems: string[];
  notes: string[];
  bad: Uint8Array | null;
  fit: SdFit;
};

const fitText = (f: SdFit) =>
  f.scale === 1 && f.dx === 0 && f.dy === 0 ? '' : `바디에 맞춰 ${f.scale !== 1 ? `${Math.round(f.scale * 1000) / 10}%로 크기를 바꾸고 ` : ''}가로 ${f.dx}px, 세로 ${f.dy}px 옮겼어요`;

const KEY_LABEL: Record<SdFileKey, string> = { whole: '헤어 한 장', front: '앞머리', back: '뒷머리', open: '뜬 눈', closed: '감은 눈', art: '그림' };

/**
 * 아이템 하나(헤어 앞+뒤 / 한 장, 표정 뜬 눈+감은 눈, 옷 한 장)를 서버 업로드와 같은 순서로 처리한다.
 * autoFit=false 면 옮기지 않고 그대로 검사한다(그린 자리 그대로 보기).
 */
export async function importItem(kits: SdKits, slot: SdKitSlot, sex: SdItemSex, files: Partial<Record<SdFileKey, Blob>>, autoFit: boolean): Promise<ImportResult> {
  const threshold = kits.male.spec.alpha_threshold;
  const sexes = sdCheckSexes(sex);
  const problems: string[] = [];
  const notes: string[] = [];
  const order: SdFileKey[] = slot === 'hair' ? (files.whole ? ['whole'] : (['front', 'back'] as const).filter((k) => files[k])) : slot === 'expression' ? (['open', 'closed'] as const).filter((k) => files[k]) : ['art'];
  let keys = order.filter((k) => files[k]);
  if (!keys.length) return { ok: false, layers: {}, problems: ['파일이 없어요'], notes, bad: null, fit: { scale: 1, dx: 0, dy: 0 } };
  if (slot === 'hair' && !files.whole && !files.front) problems.push('앞머리가 없어요. 앱은 헤어에 앞머리가 꼭 있어야 해요(뒷머리만으로는 옷장에 안 보여요)');
  if (slot === 'expression' && !files.open) problems.push('뜬 눈 그림이 없어요. 앱은 표정에 뜬 눈이 꼭 있어야 해요');

  const canvas = new Map<SdFileKey, { rgba: Rgba; notes: string[] }>();
  for (const k of keys) canvas.set(k, await toSdCanvas(files[k]!));
  const moving: SdLayerAlpha[] = keys.map((k) => ({ alpha: alphaMask(canvas.get(k)!.rgba, threshold), front: k !== 'back' }));
  const fit = autoFit ? fitSdLayers(kits, slot, moving, sexes).fit : { scale: 1, dx: 0, dy: 0 };
  let placed = keys.map((k) => applySdFit(canvas.get(k)!.rgba, fit));
  const moved = fitText(fit);
  if (moved) notes.push(moved);
  for (const k of keys) for (const n of canvas.get(k)!.notes) notes.push(`${KEY_LABEL[k]}: ${n}`);

  if (keys[0] === 'whole') {
    const chin = Math.min(...sexes.map((x) => kits[x].spec.lines_y.chin));
    const { front, back } = splitSdHair(placed[0], chin);
    const hasBack = back.some((v, i) => i % 4 === 3 && v >= threshold);
    keys = hasBack ? ['front', 'back'] : ['front'];
    placed = hasBack ? [front, back] : [front];
    notes.push(`앞뒤 한 장을 턱선(y${chin})에서 나눴어요: 위 = 앞머리, 아래 = 뒷머리(어깨·팔 뒤)`);
  }
  if (slot === 'expression' && keys[0] === 'open') {
    const eyes = kits.male.spec.face.eyes;
    const aligned = alignSdEyes(placed, threshold, [eyes[0][0], eyes[1][0]]);
    placed = aligned.frames;
    if (aligned.dx[0] || aligned.dx[1]) notes.push(`눈 간격을 맞추려고 왼눈 ${aligned.dx[0]}px, 오른눈 ${aligned.dx[1]}px 옮겼어요(감은 눈도 같이)`);
  }
  const check = checkSdLayers(kits, slot, placed.map((r, i) => ({ alpha: alphaMask(r, threshold), front: keys[i] !== 'back', eyes: slot === 'expression' && keys[i] === 'open' })), sexes);
  problems.push(...check.problems.map((p) => p.message));
  if (autoFit && check.problems.some((p) => p.rule === 'max' || p.rule === 'nogo' || p.rule === 'must')) {
    notes.push(`옮기거나 크기를 바꿔도(±${SD_FIT_RANGE.px}px, ±${SD_FIT_RANGE.scale * 100}%) 구역에 다 맞지 않아 그대로 검사했어요. 도안 구역에 맞춰 다시 그려 주세요`);
  }
  notes.push(...check.notes);
  const layers: Partial<Record<SdFileKey, Rgba>> = {};
  keys.forEach((k, i) => { layers[k] = placed[i]; });
  return { ok: problems.length === 0, layers, problems, notes, bad: check.bad.some(Boolean) ? check.bad : null, fit };
}
