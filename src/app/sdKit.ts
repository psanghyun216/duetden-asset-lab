/**
 * SD 애셋 키트 규칙(순수 TS). 받은 그림을 바디 좌표(1000x1000)에 맞춰 붙이고(fitSdLayers), 구역 검사(checkSdLayers)를 한다.
 * 서버 업로드와 저장소 빌드 도구가 같은 코드를 쓴다. 그림 읽기·쓰기(sharp)는 부르는 쪽이 하고, 여기는 0/1 마스크만 다룬다.
 * 구역 규칙은 키트 check_part.py 와 같다(마스터 도안: 점선 = 그려도 되는 범위, 옅은 칠 = 반드시 가릴 곳, 빨강 빗금 = 금지).
 */
export const SD_W = 1000;
export const SD_H = 1000;
export type SdSex = 'male' | 'female';
export const SD_SEXES: readonly SdSex[] = ['male', 'female'];
export type SdKitSlot = 'hair' | 'expression' | 'top' | 'bottom' | 'shoes';
/** 아이템 성별: 남·여 또는 공용(남녀 바디 둘 다 검사) */
export type SdItemSex = SdSex | 'unisex';

/** 키트 spec.json 중 여기서 쓰는 부분 */
export type SdKitSpec = {
  canvas: [number, number];
  alpha_threshold: number;
  lines_y: Record<string, number>;
  parts_bbox: Record<string, [number, number, number, number]>;
  /**
   * gap_until: 소매 틈(gap) 검사를 이 y 위에서만 한다. 그 아래(손 바로 위)는 소매 끝 안쪽으로 손목이 보이는 자리라 세지 않는다.
   * touch_tolerance_px: 범위 밖·금지 구역에 그림마다 이만큼까지는 걸쳐도 통과(소매 끝이 손등이나 테두리에 몇 px 닿는 정도). 맞추기(fit)에는 쓰지 않는다
   * side_tolerance_px / gap_tolerance_px: 몸 폭(옷이 덮는 길이 안에서 살이 보임)·소매 틈 검사에서 이만큼까지의 얇은 틈은 통과(없으면 SIDE_TOLERANCE_PX). 맞추기(fit)도 같은 값을 쓴다
   */
  zones: Record<SdKitSlot, { max: string; must?: string; nogo?: string; side_runs?: string[]; gap_runs?: string[]; gap_until?: number; touch_tolerance_px?: number; side_tolerance_px?: number; gap_tolerance_px?: number }>;
  /** 얼굴 기준점. eyes = 표정 두 눈 가운데 [x, y](왼, 오른) */
  face: { eyes: [[number, number], [number, number]] };
};
export type SdKit = { sex: SdSex; spec: SdKitSpec; masks: Readonly<Record<string, Uint8Array>> };
export type SdKits = Readonly<Record<SdSex, SdKit>>;

/** 키트에서 읽어야 할 마스크(spec.json 기준 상대 경로) */
export function sdKitMaskNames(spec: SdKitSpec): string[] {
  const names = new Set<string>(['masks/body.png', 'masks/body-head.png']);
  for (const z of Object.values(spec.zones)) {
    for (const rel of [z.max, z.must, z.nogo]) if (rel) names.add(rel);
    for (const r of [...(z.side_runs ?? []), ...(z.gap_runs ?? [])]) names.add(`masks/body-${r}.png`);
  }
  return [...names].sort();
}

// ---------- 파일 이름 ----------
const ID = '[a-z][a-z0-9]{1,23}';
export const SD_ID = new RegExp(`^${ID}$`);
const NAME = new RegExp(`^(?:body_(m|f)|(hair|hair-front|hair-back)_(${ID})|expr_(${ID})(_closed)?|(top|bottom|shoes)_(${ID}))(?:_(m|f|u))?\\.png$`);
/** 레이어: 헤어 앞·뒤(whole = 앞뒤를 한 장에 그린 것, 올릴 때 턱선에서 앞·뒤로 나눈다), 표정 뜬 눈·감은 눈, 옷·신발 그림 한 장 */
export type SdFileKey = 'front' | 'back' | 'whole' | 'open' | 'closed' | 'art';
export type SdFileInfo = { slot: 'body'; sex: SdSex } | { slot: SdKitSlot; id: string; key: SdFileKey; sex: SdItemSex | null };
const SEX: Record<string, SdItemSex> = { m: 'male', f: 'female', u: 'unisex' };
const SUFFIX: Record<SdItemSex, string> = { male: 'm', female: 'f', unisex: 'u' };

/**
 * 파일 이름 → 부위·ID·레이어·성별. 이름이 곧 아이템 이름표다. 끝의 _m·_f·_u 가 성별(남·여·공용)이고, 빼면 올릴 때 고른 성별을 쓴다.
 * hair_<id>_m.png(앞뒤 한 장) · hair-front_<id>_m.png · hair-back_<id>_m.png · expr_<id>_f.png · expr_<id>_closed_f.png
 * top_<id>_u.png · bottom_<id>_m.png · shoes_<id>_f.png · body_m|f.png(바디는 성별 m·f 필수)
 */
export function parseSdFileName(name: string): SdFileInfo | null {
  const r = NAME.exec(name);
  if (!r) return null;
  if (r[1]) return r[8] ? null : { slot: 'body', sex: r[1] === 'm' ? 'male' : 'female' };
  const sex = r[8] ? SEX[r[8]] : null;
  if (r[2]) return { slot: 'hair', id: r[3], key: r[2] === 'hair' ? 'whole' : r[2] === 'hair-front' ? 'front' : 'back', sex };
  if (r[4]) return { slot: 'expression', id: r[4], key: r[5] ? 'closed' : 'open', sex };
  return { slot: r[6] as 'top' | 'bottom' | 'shoes', id: r[7], key: 'art', sex };
}

export function sdFileName(slot: SdKitSlot, id: string, key: SdFileKey, sex: SdItemSex): string {
  const x = `_${SUFFIX[sex]}.png`;
  if (slot === 'hair') return key === 'whole' ? `hair_${id}${x}` : `hair-${key}_${id}${x}`;
  if (slot === 'expression') return key === 'closed' ? `expr_${id}_closed${x}` : `expr_${id}${x}`;
  return `${slot}_${id}${x}`;
}

/** 이 아이템을 어느 성별 키트로 검사하나: 공용은 남녀 둘 다, 아니면 그 성별만 */
export function sdCheckSexes(sex: SdItemSex): SdSex[] {
  return sex === 'unisex' ? [...SD_SEXES] : [sex];
}

/**
 * 앞뒤를 한 장에 그린 헤어를 앞머리·뒷머리로 나눈다(제자리 그림은 그대로, 새 그림 두 장).
 * 턱선(chinY) 위 = 앞머리(얼굴·두상 위), 아래 = 뒷머리(목·어깨·팔 뒤로 내려가는 머리는 몸 뒤에 깔린다).
 * 그래서 긴 머리도 어깨·팔 앞을 덮지 않는다. 앞머리가 빈 그림이면 front 가 비어 있다.
 */
export function splitSdHair(rgba: Uint8Array, chinY: number): { front: Uint8Array; back: Uint8Array } {
  const cut = Math.max(0, Math.min(SD_H, Math.round(chinY) + 1)) * SD_W * 4;
  const front = new Uint8Array(rgba.length), back = new Uint8Array(rgba.length);
  front.set(rgba.subarray(0, cut), 0);
  back.set(rgba.subarray(cut), cut);
  return { front, back };
}

// ---------- 투명 배경 ----------
/**
 * 배경이 칠해진 그림(알파가 전부 불투명)이면 테두리에 닿은 바깥 배경만 지운다(제자리 수정).
 * 흰 바탕·회색 체크무늬 바탕(색 두 가지)까지. 외곽선 안쪽의 흰 옷·양말은 테두리와 이어지지 않아 남는다.
 * 지웠으면 true.
 */
export function clearFlatBackground(rgba: Uint8Array, w: number, h: number, tol = 26): boolean {
  for (let p = 3; p < rgba.length; p += 4) if (rgba[p] < 250) return false;
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
  const near = (p: number, c: number[]) => Math.abs(rgba[p * 4] - c[0]) <= tol && Math.abs(rgba[p * 4 + 1] - c[1]) <= tol && Math.abs(rgba[p * 4 + 2] - c[2]) <= tol;
  const colorAt = (p: number) => [rgba[p * 4], rgba[p * 4 + 1], rgba[p * 4 + 2]];
  const c1 = colorAt(border[0]);
  const other = border.filter((p) => !near(p, c1));
  const colors = [c1];
  // 테두리의 15% 넘게가 두 번째 색이면 체크무늬 바탕으로 본다
  if (other.length > border.length * 0.15) {
    const c2 = colorAt(other[0]);
    if (other.filter((p) => near(p, c2)).length > other.length * 0.8) colors.push(c2);
    else return false;
  } else if (other.length > border.length * 0.02) return false;
  const isBg = (p: number) => colors.some((c) => near(p, c));
  const seen = new Uint8Array(w * h);
  const stack = border.filter(isBg);
  for (const p of stack) seen[p] = 1;
  while (stack.length) {
    const p = stack.pop()!;
    rgba[p * 4 + 3] = 0;
    const x = p % w, y = (p - x) / w;
    for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
      if (q >= 0 && !seen[q] && isBg(q)) { seen[q] = 1; stack.push(q); }
    }
  }
  return true;
}

/** RGBA → 0/1 알파 마스크(키트 알파 기준값 이상) */
export function alphaMask(rgba: Uint8Array, threshold: number): Uint8Array {
  const n = rgba.length / 4;
  const a = new Uint8Array(n);
  for (let p = 0; p < n; p++) a[p] = rgba[p * 4 + 3] >= threshold ? 1 : 0;
  return a;
}

// ---------- 구역 검사 ----------
export const SIDE_TOLERANCE_PX = 150; // 자잘한 차이 허용치(기본값, spec zones.<칸>.side_tolerance_px·gap_tolerance_px 로 칸마다 바꿀 수 있다)
type SdZone = SdKitSpec['zones'][SdKitSlot];
const sideTol = (z: SdZone, rule: 'side' | 'gap'): number => (rule === 'side' ? z.side_tolerance_px : z.gap_tolerance_px) ?? SIDE_TOLERANCE_PX;
export const HEM_ROWS = 16; // 같은 세로줄 위아래 16px 안에 옷이 있으면 밑단 곡선으로 보고 넘어감

/** front: 앞머리처럼 얼굴 위에 오는 그림(머리카락 금지 검사). eyes: 표정 뜬 눈 그림(눈 자리 검사) */
export type SdLayerAlpha = { alpha: Uint8Array; front?: boolean; eyes?: boolean };
export type SdProblem = { sex: SdSex; rule: 'max' | 'nogo' | 'must' | 'side' | 'gap' | 'eyes'; px: number; box: [number, number, number, number]; message: string };
export type SdCheck = { ok: boolean; problems: SdProblem[]; notes: string[]; bad: Uint8Array };

const RULE_TEXT: Record<SdProblem['rule'], string> = {
  max: '그려도 되는 범위(점선) 밖',
  nogo: '금지 구역(빨강 빗금) 침범',
  must: '반드시 가릴 곳(옅은 칠)이 비어 있음',
  side: '옷이 덮는 길이 안에서 살이 보임(옷이 몸보다 좁거나 비어 있음)',
  gap: '소매와 몸통 사이로 팔이 보임(소매가 팔 각도와 다름)',
  eyes: '눈 가운데가 기준 자리에서 벗어남',
};
const KO_SEX: Record<SdSex, string> = { male: '남자', female: '여자' };

function boxOf(m: Uint8Array): [number, number, number, number] {
  let x0 = SD_W, y0 = SD_H, x1 = -1, y1 = -1;
  for (let p = 0; p < m.length; p++) if (m[p]) { const x = p % SD_W, y = (p - x) / SD_W; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

function sidePeek(cover: Uint8Array, body: Uint8Array, out: Uint8Array, _until?: number): number {
  let n = 0;
  for (let y = 0; y < SD_H; y++) {
    let x = 0;
    while (x < SD_W) {
      if (!body[y * SD_W + x]) { x++; continue; }
      const x0 = x;
      while (x < SD_W && body[y * SD_W + x]) x++;
      let covered = 0;
      for (let i = x0; i < x; i++) covered += cover[y * SD_W + i];
      if (covered * 2 <= x - x0 || covered === x - x0) continue;
      for (let i = x0; i < x; i++) {
        if (cover[y * SD_W + i]) continue;
        let near = false;
        for (let d = 1; d <= HEM_ROWS && !near; d++) near = (y - d >= 0 && cover[(y - d) * SD_W + i] === 1) || (y + d < SD_H && cover[(y + d) * SD_W + i] === 1);
        if (!near) { n++; out[y * SD_W + i] = 1; }
      }
    }
  }
  return n;
}

function betweenGap(cover: Uint8Array, body: Uint8Array, out: Uint8Array, until = SD_H): number {
  let n = 0;
  for (let y = 0; y < Math.min(SD_H, until); y++) {
    const row = y * SD_W;
    let first = -1, last = -1;
    for (let x = 0; x < SD_W; x++) if (cover[row + x]) { if (first < 0) first = x; last = x; }
    for (let x = first + 1; x < last; x++) if (body[row + x] && !cover[row + x]) { n++; out[row + x] = 1; }
  }
  return n;
}

/**
 * 한 아이템(헤어는 앞+뒤, 나머지는 한 장)을 검사한다. 최대 범위·금지는 그림마다(금지는 앞머리만), 반드시 덮기·몸 폭은 합친 모양으로 본다.
 * sexes: 그 아이템 성별의 키트(공용이면 남녀 둘 다, sdCheckSexes).
 */
export function checkSdLayers(kits: SdKits, slot: SdKitSlot, layers: readonly SdLayerAlpha[], sexes: readonly SdSex[]): SdCheck {
  const n = SD_W * SD_H;
  const bad = new Uint8Array(n);
  const problems: SdProblem[] = [];
  const notes: string[] = [];
  const union = new Uint8Array(n);
  for (const l of layers) for (let p = 0; p < n; p++) union[p] |= l.alpha[p];
  if (!union.some(Boolean)) {
    for (const sex of sexes) problems.push({ sex, rule: 'must', px: 0, box: [0, 0, 0, 0], message: `[${KO_SEX[sex]}] 그림이 비어 있어요` });
    return { ok: false, problems, notes, bad };
  }
  for (const sex of sexes) {
    const k = kits[sex];
    const z = k.spec.zones[slot];
    const add = (rule: SdProblem['rule'], m: Uint8Array, px: number) => {
      const box = boxOf(m);
      for (let p = 0; p < n; p++) bad[p] |= m[p];
      problems.push({ sex, rule, px, box, message: `[${KO_SEX[sex]}] ${RULE_TEXT[rule]} ${px}px (x${box[0]}~${box[2]}, y${box[1]}~${box[3]})` });
    };
    const max = k.masks[z.max];
    const nogo = z.nogo ? k.masks[z.nogo] : null;
    for (const l of layers) {
      const out = new Uint8Array(n);
      let c = 0;
      for (let p = 0; p < n; p++) if (l.alpha[p] && !max[p]) { out[p] = 1; c++; }
      const tol = z.touch_tolerance_px ?? 0;
      if (c > tol) add('max', out, c);
      else if (c) notes.push(`[${KO_SEX[sex]}] 범위 밖에 살짝 걸침 ${c}px (허용 ${tol}px 이내)`);
      // 얼굴 금지 구역은 앞머리에만. 뒷머리는 바디 뒤에 깔려 얼굴을 가리지 않는다.
      if (nogo && l.front !== false) {
        const hit = new Uint8Array(n);
        let h = 0;
        for (let p = 0; p < n; p++) if (l.alpha[p] && nogo[p]) { hit[p] = 1; h++; }
        if (h > tol) add('nogo', hit, h);
        else if (h) notes.push(`[${KO_SEX[sex]}] 금지 구역에 살짝 닿음 ${h}px (허용 ${tol}px 이내)`);
      }
    }
    if (z.must) {
      const must = k.masks[z.must];
      const miss = new Uint8Array(n);
      let c = 0;
      for (let p = 0; p < n; p++) if (must[p] && !union[p]) { miss[p] = 1; c++; }
      if (c) add('must', miss, c);
    }
    for (const [rule, runs, fn] of [['side', z.side_runs, sidePeek], ['gap', z.gap_runs, betweenGap]] as const) {
      if (!runs) continue;
      const m = new Uint8Array(n);
      let c = 0;
      for (const r of runs) c += fn(union, k.masks[`masks/body-${r}.png`], m, z.gap_until);
      const tol = sideTol(z, rule);
      if (c > tol) add(rule, m, c);
      else if (c) notes.push(`[${KO_SEX[sex]}] ${rule === 'side' ? '밑단 근처' : '소매 안쪽'} 미세 차이 ${c}px (허용 ${tol}px 이내)`);
    }
  }
  // 표정 뜬 눈: 두 눈 가운데가 그 성별 키트 기준 자리(spec face.eyes = 기본 눈 표정의 두 눈 가운데, 공용은 첫 성별)에 있어야 표정마다 눈 간격이 같다
  const eyeTargets = kits[sexes[0]].spec.face.eyes.map((e) => e[0]);
  for (const l of layers) {
    if (!l.eyes) continue;
    const c = sdEyeBlobs(l.alpha);
    const [tl, tr] = eyeTargets;
    if (!c) { problems.push({ sex: sexes[0], rule: 'eyes', px: 0, box: [0, 0, 0, 0], message: `두 눈을 못 찾았어요(가운데 x${CX} 양쪽에 눈이 하나씩 있어야 해요)` }); continue; }
    const off = Math.max(Math.abs(c.left.x - tl), Math.abs(c.right.x - tr));
    if (off <= SD_EYE_TOLERANCE_PX) continue;
    const m = new Uint8Array(n);
    for (const b of [c.left, c.right]) for (const p of b.pixels) m[p] = 1;
    for (let p = 0; p < n; p++) bad[p] |= m[p];
    problems.push({ sex: sexes[0], rule: 'eyes', px: Math.round(off), box: boxOf(m), message: `${RULE_TEXT.eyes}: 왼눈 x${Math.round(c.left.x)}(기준 ${tl}), 오른눈 x${Math.round(c.right.x)}(기준 ${tr}), 허용 ±${SD_EYE_TOLERANCE_PX}px` });
  }
  return { ok: problems.length === 0, problems, notes, bad };
}

// ---------- 표정 눈 자리 ----------
/** 표정 뜬 눈 가운데가 기준 자리에서 이만큼(px)까지 벗어나도 된다 */
export const SD_EYE_TOLERANCE_PX = 3;
/** 가운데(x500)에서 이만큼 넘게 떨어진 덩어리를 왼눈·오른눈 쪽으로 본다(입·코는 가운데) */
const EYE_SIDE_PX = 20;

type Blob = { n: number; x: number; y: number; pixels: number[] };
/** 알파 덩어리(eight: 8방향 연결). 가운데 x·y 와 픽셀 목록 */
function sdBlobs(alpha: Uint8Array, eight = false): Blob[] {
  const seen = new Uint8Array(alpha.length);
  const out: Blob[] = [];
  for (let p0 = 0; p0 < alpha.length; p0++) {
    if (!alpha[p0] || seen[p0]) continue;
    const pixels: number[] = [];
    let sx = 0, sy = 0;
    const stack = [p0];
    seen[p0] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % SD_W, y = (p - x) / SD_W;
      pixels.push(p); sx += x; sy += y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if ((!dx && !dy) || (!eight && dx && dy)) continue;
        const qx = x + dx, qy = y + dy;
        if (qx < 0 || qy < 0 || qx >= SD_W || qy >= SD_H) continue;
        const q = qy * SD_W + qx;
        if (alpha[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
      }
    }
    out.push({ n: pixels.length, x: sx / pixels.length, y: sy / pixels.length, pixels });
  }
  return out;
}

/** 표정의 두 눈: 가운데 양쪽에서 가장 큰 덩어리 하나씩(눈물·속눈썹 조각이 아니라 눈). 못 찾으면 null */
export function sdEyeBlobs(alpha: Uint8Array): { left: Blob; right: Blob } | null {
  let left: Blob | null = null, right: Blob | null = null;
  for (const b of sdBlobs(alpha)) {
    if (b.x < CX - EYE_SIDE_PX && (!left || b.n > left.n)) left = b;
    if (b.x > CX + EYE_SIDE_PX && (!right || b.n > right.n)) right = b;
  }
  return left && right ? { left, right } : null;
}

/**
 * 표정 눈을 기준 자리(targets = 왼눈·오른눈 가운데 x)로 옮긴다. 다시 그리지 않고 눈 쪽 덩어리를 통째로 가로로만 옮긴다(입은 그대로).
 * 옮길 값은 첫 그림(뜬 눈)으로 정하고 나머지(감은 눈)도 똑같이 옮겨서 깜빡일 때 어긋나지 않게 한다.
 * frames: 1000x1000 RGBA. 눈을 못 찾으면 그대로 돌려준다.
 */
export function alignSdEyes(frames: readonly Uint8Array[], threshold: number, targets: readonly [number, number]): { frames: Uint8Array[]; dx: [number, number] } {
  const eyes = frames.length ? sdEyeBlobs(alphaMask(frames[0], threshold)) : null;
  if (!eyes) return { frames: [...frames], dx: [0, 0] };
  const dx: [number, number] = [Math.round(targets[0] - eyes.left.x), Math.round(targets[1] - eyes.right.x)];
  if (!dx[0] && !dx[1]) return { frames: [...frames], dx };
  const moved = frames.map((rgba) => {
    const any = new Uint8Array(SD_W * SD_H);
    for (let p = 0; p < any.length; p++) any[p] = rgba[p * 4 + 3] ? 1 : 0;
    const out = new Uint8Array(rgba.length);
    const sides: { pixels: number[]; d: number }[] = [];
    for (const b of sdBlobs(any, true)) {
      const d = b.x < CX - EYE_SIDE_PX ? dx[0] : b.x > CX + EYE_SIDE_PX ? dx[1] : 0;
      if (!d) for (const p of b.pixels) out.set(rgba.subarray(p * 4, p * 4 + 4), p * 4);
      else sides.push({ pixels: b.pixels, d });
    }
    for (const { pixels, d } of sides) for (const p of pixels) {
      const x = (p % SD_W) + d;
      if (x >= 0 && x < SD_W) out.set(rgba.subarray(p * 4, p * 4 + 4), (p + d) * 4);
    }
    return out;
  });
  return { frames: moved, dx };
}

// ---------- 위치 맞춤 ----------
/** 캔버스 가운데를 축으로 배율 scale, 그다음 (dx, dy)px 이동. 받은 그림 → 바디 좌표 */
export type SdFit = { scale: number; dx: number; dy: number };
export const SD_FIT_IDENTITY: SdFit = { scale: 1, dx: 0, dy: 0 };
const CX = SD_W / 2, CY = SD_H / 2;
/** 찾는 범위: GPT 가 캔버스를 살짝 옮기거나 키워 그린 정도(이보다 크게 어긋나면 다시 그려 받는다) */
export const SD_FIT_RANGE = { scale: 0.05, px: 48 };

type Samples = { alpha: Int32Array[]; front: boolean[]; must: { sex: SdSex; pts: Int32Array }[]; fixed: Uint8Array | null };

function samplePoints(m: Uint8Array, st: number): Int32Array {
  const pts: number[] = [];
  for (let y = 0; y < SD_H; y += st) for (let x = 0; x < SD_W; x += st) if (m[y * SD_W + x]) pts.push(x, y);
  return Int32Array.from(pts);
}

/** 맞춤 점수(낮을수록 좋음): 범위 밖 + 금지 x2 + 반드시 가릴 곳 빈칸. 표본 점(st px 간격) 수. 걸침 허용치(touch_tolerance_px)는 맞출 때 쓰지 않는다(되도록 안 닿는 자리를 찾고, 마지막 검사에서만 봐 줌) */
function score(kits: SdKits, slot: SdKitSlot, layers: readonly SdLayerAlpha[], sexes: readonly SdSex[], s: Samples, f: SdFit): number {
  let total = 0;
  for (const sex of sexes) {
    const k = kits[sex];
    const z = k.spec.zones[slot];
    const max = k.masks[z.max];
    const nogo = z.nogo ? k.masks[z.nogo] : null;
    s.alpha.forEach((pts, li) => {
      for (let i = 0; i < pts.length; i += 2) {
        const x = Math.round(CX + (pts[i] - CX) * f.scale + f.dx), y = Math.round(CY + (pts[i + 1] - CY) * f.scale + f.dy);
        if (x < 0 || y < 0 || x >= SD_W || y >= SD_H) { total++; continue; }
        const p = y * SD_W + x;
        if (!max[p]) total++;
        if (nogo && s.front[li] && nogo[p]) total += 2;
      }
    });
    for (const m of s.must) {
      if (m.sex !== sex) continue;
      const pts = m.pts;
      for (let i = 0; i < pts.length; i += 2) {
        // 옮기지 않는 짝 그림이 이미 덮은 곳
        if (s.fixed && s.fixed[pts[i + 1] * SD_W + pts[i]]) continue;
        const u = Math.round(CX + (pts[i] - CX - f.dx) / f.scale), v = Math.round(CY + (pts[i + 1] - CY - f.dy) / f.scale);
        if (u < 0 || v < 0 || u >= SD_W || v >= SD_H) { total++; continue; }
        const p = v * SD_W + u;
        if (!layers.some((l) => l.alpha[p])) total++;
      }
    }
  }
  return total;
}

const moveCost = (f: SdFit) => Math.abs(f.dx) + Math.abs(f.dy) + Math.abs(f.scale - 1) * 1000;

/**
 * 받은 그림(이미 1000x1000 캔버스로 맞춘 것)을 바디 구역에 가장 잘 맞는 위치·배율로 찾는다.
 * 지금 자리에서 이미 맞으면 움직이지 않는다. 점수가 같으면 덜 움직이는 쪽을 고른다.
 * 헤어 앞·뒤처럼 같이 그린 그림은 layers 로 함께 넘겨 같은 값으로 옮긴다.
 * fixed: 옮기지 않는 짝 그림(예: 앞머리만 다시 올릴 때 저장된 뒷머리). '반드시 가릴 곳'은 둘을 합쳐 본다.
 * 옷은 구역을 다 맞춘 뒤에도 살이 보이면 몸 외곽선에 붙는 자리로 더 옮긴다(fitToBody). 그래서 주문할 때 좌표를 줄 필요가 없다.
 */
export function fitSdLayers(kits: SdKits, slot: SdKitSlot, layers: readonly SdLayerAlpha[], sexes: readonly SdSex[], fixed: readonly SdLayerAlpha[] = []): { fit: SdFit; before: number; after: number } {
  const { samples, ...r } = fitZones(kits, slot, layers, sexes, fixed);
  if (r.after > 0) return r;
  return { ...r, fit: fitToBody(kits, slot, layers, sexes, r.fit, (f) => score(kits, slot, layers, sexes, samples, f) === 0) };
}

/** 옷: 몸 폭·소매 틈 검사와 같은 계산으로 살이 보이는 칸 수(합)와 통과 여부 */
function bodyPeek(kits: SdKits, slot: SdKitSlot, union: Uint8Array, sexes: readonly SdSex[], scratch: Uint8Array): { px: number; ok: boolean } {
  let px = 0, ok = true;
  for (const sex of sexes) {
    const k = kits[sex];
    const z = k.spec.zones[slot];
    for (const [runs, fn, tol] of [[z.side_runs, sidePeek, sideTol(z, 'side')], [z.gap_runs, betweenGap, sideTol(z, 'gap')]] as const) {
      if (!runs) continue;
      let c = 0;
      for (const r of runs) c += fn(union, k.masks[`masks/body-${r}.png`], scratch, z.gap_until);
      px += c;
      if (c > tol) ok = false;
    }
  }
  return { px, ok };
}

/**
 * 옷은 꼭 덮기 구역이 작아(속옷·발) 그 구역만으로는 자리가 덜 정해진다. 구역을 다 맞춘 뒤에도 살이 보이면(몸 폭·소매 틈 불통과)
 * 구역은 계속 맞는 범위 안에서 옮긴다.
 *  1) 통과할 때까지: 살이 보이는 칸이 가장 적게 줄어드는 쪽으로(위치 8→1px, 배율 1%→0.125%), 통과하는 자리가 생기면 덜 움직이는 쪽.
 *  2) 통과한 뒤: 가로로만 더 옮겨 양옆에 보이는 칸을 줄인다(몸 가운데에 맞추기). 세로는 밑단 근처 차이가 기준이 못 돼서 건드리지 않는다.
 * 이미 통과하면 그대로, 옮겨도 통과하지 못하면 시작 자리 그대로.
 */
function fitToBody(kits: SdKits, slot: SdKitSlot, layers: readonly SdLayerAlpha[], sexes: readonly SdSex[], from: SdFit, zonesOk: (f: SdFit) => boolean): SdFit {
  if (!sexes.some((sex) => { const z = kits[sex].spec.zones[slot]; return z.side_runs || z.gap_runs; })) return from;
  const union = new Uint8Array(SD_W * SD_H);
  for (const l of layers) for (let p = 0; p < union.length; p++) union[p] |= l.alpha[p];
  const scratch = new Uint8Array(SD_W * SD_H);
  type At = { fit: SdFit; px: number; ok: boolean; cost: number };
  const at = (f: SdFit): At => ({ fit: f, ...bodyPeek(kits, slot, moveAlpha(union, f), sexes, scratch), cost: Math.abs(f.dx - from.dx) + Math.abs(f.dy - from.dy) + Math.abs(f.scale - from.scale) * 1000 });
  const better = (a: At, b: At) => (a.ok !== b.ok ? a.ok : a.ok ? a.cost < b.cost : a.px < b.px);
  const descend = (cur: At, dirs: (step: number) => [number, number, number][], done: (a: At) => boolean, cmp: (a: At, b: At) => boolean): At => {
    for (let step = 8, round = 0; step >= 1 && round < 80 && !done(cur); round++) {
      let next = cur;
      for (const [ex, ey, es] of dirs(step)) {
        const f = { scale: Math.round((cur.fit.scale + es) * 10000) / 10000, dx: cur.fit.dx + ex, dy: cur.fit.dy + ey };
        if (Math.abs(f.dx) > SD_FIT_RANGE.px || Math.abs(f.dy) > SD_FIT_RANGE.px || Math.abs(f.scale - 1) > SD_FIT_RANGE.scale + 1e-9) continue;
        if (!zonesOk(f)) continue;
        const c = at(f);
        if (cmp(c, next)) next = c;
      }
      if (next === cur) step >>= 1;
      else cur = next;
    }
    return cur;
  };
  const first = at(from);
  if (first.ok) return from;
  const all = (st: number): [number, number, number][] => [[st, 0, 0], [-st, 0, 0], [0, st, 0], [0, -st, 0], [0, 0, st * 0.00125], [0, 0, -st * 0.00125]];
  const passed = descend(first, all, (a) => a.ok, better);
  if (!passed.ok) return from;
  const centered = descend(passed, (st) => [[st, 0, 0], [-st, 0, 0]], () => false, (a, b) => a.ok && a.px < b.px);
  return centered.fit;
}

/** 구역(범위·금지·꼭 덮기)만 보고 찾는 맞춤 */
function fitZones(kits: SdKits, slot: SdKitSlot, layers: readonly SdLayerAlpha[], sexes: readonly SdSex[], fixed: readonly SdLayerAlpha[]): { fit: SdFit; before: number; after: number; samples: Samples } {
  let union: Uint8Array | null = null;
  if (fixed.length) {
    union = new Uint8Array(SD_W * SD_H);
    for (const l of fixed) for (let p = 0; p < union.length; p++) union[p] |= l.alpha[p];
  }
  const samplesAt = (st: number): Samples => ({
    fixed: union,
    alpha: layers.map((l) => samplePoints(l.alpha, st)),
    front: layers.map((l) => l.front !== false),
    must: sexes.flatMap((sex) => { const z = kits[sex].spec.zones[slot]; return z.must ? [{ sex, pts: samplePoints(kits[sex].masks[z.must], st) }] : []; }),
  });
  const fine = samplesAt(1); // 판정은 실제 검사와 같은 1px 간격
  const before = score(kits, slot, layers, sexes, fine, SD_FIT_IDENTITY);
  // 표정: 두 눈은 얼굴 가운데(키트 두 눈 자리의 가운데)를 사이에 두고 좌우로 놓인다 → 가로만 가운데로 맞춘다(세로는 디자인마다 달라 그대로)
  const [[el], [er]] = kits[sexes[0]].spec.face.eyes;
  const start = slot === 'expression' ? eyeCentering(layers[0].alpha, (el + er) / 2) : SD_FIT_IDENTITY;
  const startScore = start === SD_FIT_IDENTITY ? before : score(kits, slot, layers, sexes, fine, start);
  if (startScore === 0) return { fit: start, before, after: 0, samples: fine };
  let best = { fit: start, v: Infinity };
  const search = (st: number, center: SdFit, px: number, pxStep: number, sc: number, scStep: number) => {
    const s = samplesAt(st);
    let local = { fit: center, v: Infinity };
    const ks = Math.round(sc / scStep);
    for (let k = -ks; k <= ks; k++) {
      const scale = Math.round((center.scale + k * scStep) * 10000) / 10000;
      if (Math.abs(scale - 1) > SD_FIT_RANGE.scale + 1e-9) continue;
      for (let dy = center.dy - px; dy <= center.dy + px; dy += pxStep) for (let dx = center.dx - px; dx <= center.dx + px; dx += pxStep) {
        if (Math.abs(dx) > SD_FIT_RANGE.px || Math.abs(dy) > SD_FIT_RANGE.px) continue;
        const f = { scale, dx, dy };
        const v = score(kits, slot, layers, sexes, s, f);
        if (v < local.v || (v === local.v && moveCost(f) < moveCost(local.fit))) local = { fit: f, v };
      }
    }
    return local.fit;
  };
  // 성긴 간격에서 고른 배율이 이후 단계를 묶어 버리지 않게, 배율 그대로(옮기기만)와 배율까지 찾기를 따로 돌려 나은 쪽을 쓴다(같으면 배율 그대로)
  const pipeline = (sc: number) => {
    let f = search(8, start, SD_FIT_RANGE.px, 8, sc, 0.01);
    f = search(4, f, 16, 2, Math.min(sc, 0.01), 0.005);
    f = search(2, f, 4, 1, Math.min(sc, 0.005), 0.0025);
    f = search(1, f, 2, 1, 0, 0.0025); // 마지막: 실제 검사와 같은 1px 간격으로 ±2px
    return { fit: f, v: score(kits, slot, layers, sexes, fine, f) };
  };
  const moved = pipeline(0);
  const scaled = moved.v > 0 ? pipeline(SD_FIT_RANGE.scale) : moved;
  best = scaled.v < moved.v ? scaled : moved;
  // 성긴 단계는 1~2px 두께의 걸림을 못 볼 수 있다 → 아직 걸리면 1px 간격으로 주변을 따라 내려간다(배율도 한 칸씩)
  for (let round = 0; round < 40 && best.v > 0; round++) {
    let next = best;
    const steps: [number, number, number][] = [];
    for (const d of [1, 2, 4, 8]) for (const [ex, ey] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [d, -d], [-d, d], [-d, -d]]) steps.push([ex, ey, 0]);
    // 배율은 위치와 함께 움직여야 나아지는 경우가 많아 한 칸씩 같이 본다
    for (const es of [0.001, -0.001, 0.0025, -0.0025]) for (const ex of [-1, 0, 1]) for (const ey of [-1, 0, 1]) steps.push([ex, ey, es]);
    for (const [ex, ey, es] of steps) {
      const c = { scale: Math.round((best.fit.scale + es) * 10000) / 10000, dx: best.fit.dx + ex, dy: best.fit.dy + ey };
      if (Math.abs(c.dx) > SD_FIT_RANGE.px || Math.abs(c.dy) > SD_FIT_RANGE.px || Math.abs(c.scale - 1) > SD_FIT_RANGE.scale + 1e-9) continue;
      const v = score(kits, slot, layers, sexes, fine, c);
      if (v < next.v || (v === next.v && v < best.v && moveCost(c) < moveCost(next.fit))) next = { fit: c, v };
    }
    if (next === best) break;
    best = next;
  }
  // 옮겨서 다 맞지 않으면 시작 자리에 둔다(못 맞추는 그림을 엉뚱한 곳으로 옮기지 않고, 올린 그대로 무엇이 틀렸는지 보여 준다)
  if (best.v > 0) return { fit: start, before, after: startScore, samples: fine };
  return { fit: best.fit, before, after: best.v, samples: fine };
}

/** 가장 큰 덩어리 둘(두 눈)의 가운데가 얼굴 가운데(mid, 키트 두 눈 자리의 가운데)에서 3px 넘게 벗어나면 가로로 옮기는 값. 눈을 못 찾으면 그대로 */
function eyeCentering(alpha: Uint8Array, mid: number): SdFit {
  const blobs = sdBlobs(alpha).sort((a, b) => b.n - a.n);
  const [l, r] = blobs;
  if (!l || !r || r.n < l.n * 0.6) return SD_FIT_IDENTITY;
  if (Math.abs(l.y - r.y) > 15) return SD_FIT_IDENTITY;
  const dx = Math.round(mid - (l.x + r.x) / 2);
  return Math.abs(dx) >= 3 && Math.abs(dx) <= SD_FIT_RANGE.px ? { scale: 1, dx, dy: 0 } : SD_FIT_IDENTITY;
}

/** 맞춤 값으로 알파 마스크를 옮긴다(가장 가까운 픽셀). 실제 그림은 sharp 로 옮기고, 이것은 시험·미리 점검용 */
export function moveAlpha(alpha: Uint8Array, f: SdFit): Uint8Array {
  if (f.scale === 1 && f.dx === 0 && f.dy === 0) return alpha;
  const out = new Uint8Array(alpha.length);
  for (let y = 0; y < SD_H; y++) for (let x = 0; x < SD_W; x++) {
    const u = Math.round(CX + (x - CX - f.dx) / f.scale), v = Math.round(CY + (y - CY - f.dy) / f.scale);
    if (u >= 0 && v >= 0 && u < SD_W && v < SD_H) out[y * SD_W + x] = alpha[v * SD_W + u];
  }
  return out;
}

/** 맞춤 값 → 원본 그림을 놓을 자리: 배율 적용한 크기와 왼쪽 위 좌표(정수) */
export function fitPlacement(f: SdFit): { size: number; left: number; top: number } {
  const size = Math.round(SD_W * f.scale);
  return { size, left: Math.round(CX - (SD_W * f.scale) / 2 + f.dx), top: Math.round(CY - (SD_H * f.scale) / 2 + f.dy) };
}
