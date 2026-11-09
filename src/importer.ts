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
  type SdSex,
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
export async function loadKits(base: string, bodies: Record<SdSex, BodyArt>): Promise<SdKits> {
  const read = async (sex: (typeof SD_SEXES)[number]): Promise<SdKit> => {
    const spec = (await (await fetch(`${base}/${sex}/spec.json`)).json()) as SdKitSpec;
    const masks: Record<string, Uint8Array> = {};
    await Promise.all([...new Set([...sdKitMaskNames(spec), 'masks/body-hands.png'])].map(async (rel) => {
      const { data, w, h } = await decode(await (await fetch(`${base}/${sex}/${rel}`)).blob());
      if (w !== SD_W || h !== SD_H) throw new Error(`kit ${sex}/${rel}: ${SD_W}x${SD_H} 이어야 해요`);
      const m = new Uint8Array(SD_W * SD_H);
      for (let p = 0; p < m.length; p++) m[p] = data[p * 4] > 127 ? 1 : 0;
      masks[rel] = m;
    }));
    await labRules(spec, masks, bodies[sex]);
    return { sex, spec, masks };
  };
  const [male, female] = await Promise.all([read('male'), read('female')]);
  return { male, female };
}

/**
 * 랩 규칙(2026-11-09 사용자). 앱 키트에는 아직 없음.
 * - 상의·하의: 옆으로 퍼지는 건 괜찮다. 원래 위아래 길이 안에서 가로 끝까지 그려도 되고, 손만 가리면 안 된다.
 *   손 = 키트 손 영역 중 실제 바디 그림이 있는 픽셀(외곽선 포함, 여유 없음). 경계 번짐만큼(LAB_TOUCH_PX)은 닿아도 통과.
 *   팔 살이 보이는지(몸 폭·소매 틈)는 앱 검사 그대로.
 * - 신발: 실제 발 그림(발목선 아래, 외곽선 포함)을 빈틈 없이 덮어야 하고, 발 옆·앞으로 LAB_SHOE_OUT_PX, 바닥 아래로 LAB_SOLE_PX 까지만.
 */
export const LAB_TOUCH_PX = 12;
/** 신발은 발보다 크게 그리는 게 보통이라 옆·앞으로는 넉넉히, 바닥 아래로는 LAB_SOLE_PX 까지만 */
export const LAB_SHOE_OUT_PX = 40;
export const LAB_SOLE_PX = 16;
export type BodyArt = { url: string; x: number; y: number };

async function bodyAlpha(art: BodyArt, min: number): Promise<Uint8Array> {
  const { data, w, h } = await decode(await (await fetch(art.url)).blob());
  const out = new Uint8Array(SD_W * SD_H);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const tx = x + art.x, ty = y + art.y;
    if (tx < SD_W && ty < SD_H && data[(y * w + x) * 4 + 3] >= min) out[ty * SD_W + tx] = 1;
  }
  return out;
}
const and = (a: Uint8Array, b: Uint8Array) => a.map((v, i) => v & b[i]);
function dilate(m: Uint8Array, r: number): Uint8Array {
  const out = new Uint8Array(m.length);
  for (let p = 0; p < m.length; p++) {
    if (!m[p]) continue;
    const x = p % SD_W, y = (p - x) / SD_W;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const qx = x + dx, qy = y + dy;
      if (qx >= 0 && qy >= 0 && qx < SD_W && qy < SD_H && dx * dx + dy * dy <= r * r) out[qy * SD_W + qx] = 1;
    }
  }
  return out;
}

async function labRules(spec: SdKitSpec, masks: Record<string, Uint8Array>, art: BodyArt) {
  const body = await bodyAlpha(art, 128);
  const solid = await bodyAlpha(art, 200);
  const hand = and(masks['masks/body-hands.png'], body);
  const foot = and(masks['masks/body-feet.png'], solid);
  masks['lab/hand.png'] = hand;
  masks['lab/foot.png'] = foot;
  for (const slot of ['top', 'bottom'] as const) {
    const max = masks[spec.zones[slot].max];
    let y0 = SD_H, y1 = -1;
    for (let p = 0; p < max.length; p++) if (max[p]) { const y = (p / SD_W) | 0; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const out = new Uint8Array(max.length);
    for (let y = y0; y <= y1; y++) out.fill(1, y * SD_W, (y + 1) * SD_W);
    masks[`lab/${slot}_max.png`] = out;
    spec.zones[slot] = { ...spec.zones[slot], max: `lab/${slot}_max.png`, nogo: 'lab/hand.png', touch_tolerance_px: LAB_TOUCH_PX };
  }
  const shoeMax = dilate(foot, LAB_SHOE_OUT_PX);
  const old = masks[spec.zones.shoes.max];
  // 양말은 발목 위 다리로 올라가도 된다(앱 신발 범위 그대로) + 발 바깥 15px
  const sole = spec.lines_y.ground + LAB_SOLE_PX;
  for (let p = 0; p < shoeMax.length; p++) shoeMax[p] = (shoeMax[p] && p < (sole + 1) * SD_W ? 1 : 0) | old[p];
  masks['lab/shoes_max.png'] = shoeMax;
  spec.zones.shoes = { ...spec.zones.shoes, max: 'lab/shoes_max.png', must: 'lab/foot.png' };
}

/** 랩 규칙 문장으로 바꾸기 */
export function labMessage(slot: SdKitSlot, msg: string): string {
  if (slot === 'top' || slot === 'bottom') return msg.replace('금지 구역(빨강 빗금) 침범', '손을 가림');
  if (slot === 'shoes') return msg.replace('반드시 가릴 곳(옅은 칠)이 비어 있음', '발이 덜 덮임').replace('그려도 되는 범위(점선) 밖', `신발 범위(발 옆 ${LAB_SHOE_OUT_PX}px·바닥 아래 ${LAB_SOLE_PX}px) 밖`);
  return msg;
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
  for (const k of keys) for (const n of canvas.get(k)!.notes) notes.push(`${KEY_LABEL[k]}: ${n}`);

  /** 맞추기 → (한 장 헤어 나누기·눈 맞춤) → 검사. src = 1000 캔버스 그림들(keys 순서) */
  const attempt = (src: Rgba[]) => {
    let ks = [...keys];
    const moving: SdLayerAlpha[] = ks.map((k, i) => ({ alpha: alphaMask(src[i], threshold), front: k !== 'back' }));
    const fit = autoFit ? fitSdLayers(kits, slot, moving, sexes).fit : { scale: 1, dx: 0, dy: 0 };
    let placed = src.map((r) => applySdFit(r, fit));
    const extra: string[] = [];
    if (ks[0] === 'whole') {
      const chin = Math.min(...sexes.map((x) => kits[x].spec.lines_y.chin));
      const { front, back } = splitSdHair(placed[0], chin);
      const hasBack = back.some((v, i) => i % 4 === 3 && v >= threshold);
      ks = hasBack ? ['front', 'back'] : ['front'];
      placed = hasBack ? [front, back] : [front];
      extra.push(`앞뒤 한 장을 턱선(y${chin})에서 나눴어요: 위 = 앞머리, 아래 = 뒷머리(어깨·팔 뒤)`);
    }
    if (slot === 'expression' && ks[0] === 'open') {
      const eyes = kits.male.spec.face.eyes;
      const aligned = alignSdEyes(placed, threshold, [eyes[0][0], eyes[1][0]]);
      placed = aligned.frames;
      if (aligned.dx[0] || aligned.dx[1]) extra.push(`눈 간격을 맞추려고 왼눈 ${aligned.dx[0]}px, 오른눈 ${aligned.dx[1]}px 옮겼어요(감은 눈도 같이)`);
    }
    const check = checkSdLayers(kits, slot, placed.map((r, i) => ({ alpha: alphaMask(r, threshold), front: ks[i] !== 'back', eyes: slot === 'expression' && ks[i] === 'open' })), sexes);
    const badPx = check.problems.reduce((a, p) => a + Math.max(1, p.px), 0);
    return { ks, fit, placed, extra, check, badPx };
  };

  const raw = keys.map((k) => canvas.get(k)!.rgba);
  let best = attempt(raw);
  let pre: Placement | null = null;
  // 크게(또는 작게·엉뚱한 자리에) 그린 그림: 기본 맞춤(±5%·±48px)으로 안 맞으면 칸 기준선에 크기·자리를 먼저 잡고 다시 맞춰 본다
  if (autoFit && best.check.problems.some((p) => p.rule === 'max' || p.rule === 'must' || p.rule === 'nogo')) {
    const guess = prePlacement(kits, slot, sexes, raw, threshold);
    // 크기 차이가 15% 안쪽이면 그림 문제(모양)로 보고 키우거나 줄이지 않는다
    if (guess && Math.abs(guess.s - 1) > 0.15) {
      const second = attempt(raw.map((r) => placeRgba(r, guess)));
      if (second.badPx < best.badPx) { best = second; pre = guess; }
    }
  }
  const { fit, extra, check } = best;
  keys = best.ks;
  const placed = best.placed;
  if (pre) notes.push(`크기·자리가 바디와 많이 달라서 ${pre.why} 기준으로 ${Math.round(pre.s * 1000) / 10}%로 줄이거나 키우고 옮겼어요(관리 페이지 업로드엔 아직 없는 랩 전용 맞춤이라, 앱에 올릴 땐 아래 ⬇ 맞춘 그림을 쓰세요. 많이 줄이면 외곽선이 가늘어져요)`);
  const moved = fitText(fit);
  if (moved) notes.push(moved);
  notes.push(...extra);
  problems.push(...check.problems.map((p) => labMessage(slot, p.message)));
  if (autoFit && check.problems.some((p) => p.rule === 'max' || p.rule === 'nogo' || p.rule === 'must')) {
    notes.push(`자동으로 옮기고 크기를 바꿔도 구역에 다 맞지 않았어요. 도안 구역에 맞춰 다시 그려 주세요`);
  }
  notes.push(...check.notes.map((n) => labMessage(slot, n)));
  const layers: Partial<Record<SdFileKey, Rgba>> = {};
  keys.forEach((k, i) => { layers[k] = placed[i]; });
  return { ok: problems.length === 0, layers, problems, notes, bad: check.bad.some(Boolean) ? check.bad : null, fit };
}

// ---------- 크게 그린 그림 먼저 자리 잡기(랩 전용) ----------
/** 새 좌표 = 옛 좌표 * s + (tx, ty) */
type Placement = { s: number; tx: number; ty: number; why: string };

function placeRgba(rgba: Rgba, p: Placement): Rgba {
  const src = canvas2d(SD_W, SD_H);
  src.ctx.putImageData(toImageData(rgba), 0, 0);
  const dst = canvas2d(SD_W, SD_H);
  dst.ctx.imageSmoothingEnabled = true;
  dst.ctx.imageSmoothingQuality = 'high';
  dst.ctx.drawImage(src.c, p.tx, p.ty, SD_W * p.s, SD_H * p.s);
  return new Uint8Array(dst.ctx.getImageData(0, 0, SD_W, SD_H).data.buffer);
}

function bbox(m: Uint8Array): [number, number, number, number] | null {
  let x0 = SD_W, y0 = SD_H, x1 = -1, y1 = -1;
  for (let p = 0; p < m.length; p++) if (m[p]) { const x = p % SD_W, y = (p - x) / SD_W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}
/** 한 줄에서 칠해진 맨 왼쪽~맨 오른쪽 */
function rowSpan(m: Uint8Array, y: number): [number, number] | null {
  let a = -1, b = -1;
  for (let x = 0; x < SD_W; x++) if (m[y * SD_W + x]) { if (a < 0) a = x; b = x; }
  return a < 0 ? null : [a, b];
}

/**
 * 칸마다 기준선 하나로 크기·자리를 잡는다(그다음 기본 맞춤이 미세 조정):
 * 하의 = 그림 맨 위 허리 밴드 폭 → 바디 허리 폭, 허리선에 붙임 / 신발 = 폭 → 발 폭, 바닥선에 붙임
 * 헤어 = 폭 → 두상 폭, 정수리에 붙임 / 상의·표정 = 그려도 되는 범위 상자 안에 들어가게
 */
function prePlacement(kits: SdKits, slot: SdKitSlot, sexes: readonly SdSex[], layers: Rgba[], threshold: number): Placement | null {
  const k = kits[sexes[0]];
  const union = new Uint8Array(SD_W * SD_H);
  for (const r of layers) { const a = alphaMask(r, threshold); for (let p = 0; p < a.length; p++) union[p] |= a[p]; }
  const b = bbox(union);
  if (!b) return null;
  const [x0, y0, x1, y1] = b;
  const w = x1 - x0 + 1, h = y1 - y0 + 1, cx = (x0 + x1) / 2;
  const L = k.spec.lines_y;
  const at = (s: number, ax: number, ay: number, toX: number, toY: number, why: string): Placement => ({ s, tx: toX - ax * s, ty: toY - ay * s, why });
  if (slot === 'bottom') {
    const band = rowSpan(union, Math.min(y1, y0 + Math.max(3, Math.round(h * 0.04))));
    const waist = rowSpan(k.masks['masks/body-torso.png'], L.waist) ?? [413, 586];
    if (!band) return null;
    const s = (waist[1] - waist[0] + 14) / (band[1] - band[0] + 1);
    return at(s, (band[0] + band[1]) / 2, y0, (waist[0] + waist[1]) / 2, L.waist - 15, '허리 밴드 폭');
  }
  if (slot === 'shoes') {
    const feet = bbox(k.masks['masks/body-feet.png']) ?? [419, 872, 582, 917];
    const s = (feet[2] - feet[0] + 60) / w;
    return at(s, cx, y1, (feet[0] + feet[2]) / 2, L.ground + 6, '발 폭');
  }
  if (slot === 'hair') {
    const head = bbox(k.masks['masks/body-head.png']) ?? [287, 156, 712, 527];
    const top = rowSpan(union, Math.min(y1, y0 + Math.round(h * 0.25)));
    if (!top) return null;
    const s = ((head[2] - head[0]) * 1.06) / (top[1] - top[0] + 1);
    return at(s, (top[0] + top[1]) / 2, y0, (head[0] + head[2]) / 2, L.head_top - 8, '두상 폭');
  }
  const zone = bbox(k.masks[k.spec.zones[slot].max]);
  if (!zone) return null;
  const s = Math.min((zone[2] - zone[0]) / w, (zone[3] - zone[1]) / h) * 0.92;
  return at(s, cx, y0, (zone[0] + zone[2]) / 2, zone[1] + (zone[3] - zone[1] - h * s) * 0.15, '그려도 되는 범위');
}
