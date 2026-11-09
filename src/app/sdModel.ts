import type { Appearance } from '../domain/appearance.ts';
import { SD_BUNDLED } from './catalog.generated.ts';
import { sdFitsSex, SD_LAYERS, SD_SLOTS, type SdCatalogData, type SdRect, type SdSex, type SdSlot } from './sdCatalog.ts';

/**
 * 새 SD 캐릭터(1000x1000 마스터) 규칙. 서버도 import 하므로 React·그림 require 를 두지 않는다.
 * 부위: 바디(남녀 따로) + 헤어 앞/뒤 + 표정 눈+입 + 상의 + 하의 + 신발(양말 포함). 아이템마다 성별이 있고(남·여·공용),
 * 그 성별(또는 공용) 아이템만 옷장에 보이고 입을 수 있다.
 * 모든 함수는 목록(cat)을 받는다. 기본값은 앱에 묶인 목록이고, 화면은 업로드 아이템을 합친 목록(useSdCatalog)을 넘긴다.
 */
export { SD_SLOTS, type SdSex, type SdSlot };
export type SdViewBox = SdRect;

const has = <T>(table: Readonly<Record<string, T>>, id: unknown): id is string => typeof id === 'string' && Object.prototype.hasOwnProperty.call(table, id);

export const SD_CANVAS = SD_BUNDLED.canvas;
export const SD_GROUND_Y = SD_BUNDLED.groundY;
/** 외형 칸 ↔ 저장 필드. SD 는 한 벌·소품 칸이 없다. 빈 문자열 = 그 칸은 비움 */
export const SD_FIELDS = { hair: 'hairStyleId', expression: 'expressionId', top: 'topId', bottom: 'bottomId', shoes: 'shoesId' } as const satisfies Record<SdSlot, keyof Appearance>;

export const sdSexOf = (a: Pick<Appearance, 'faceProfileId'>): SdSex => (a.faceProfileId === 'female' ? 'female' : 'male');

/** 이 성별이 이 칸에 이 ID 를 쓸 수 있나(성별이 같거나 공용, 꼭 있어야 하는 그림이 있음) */
export function sdUsable(slot: SdSlot, sex: SdSex, id: unknown, cat: SdCatalogData = SD_BUNDLED): id is string {
  if (!has(cat[slot], id)) return false;
  const item = cat[slot][id] as { sex?: SdCatalogData['hair'][string]['sex'] } & Record<string, unknown>;
  return sdFitsSex(item.sex, sex) && !!item[SD_LAYERS[slot][0]];
}

/** 이 성별이 입을 수 있는 것(옷장에 보이는 순서): 그 성별 아이템 + 공용 아이템. */
export function sdAvailable(sex: SdSex, cat: SdCatalogData = SD_BUNDLED): Record<SdSlot, string[]> {
  return Object.fromEntries(SD_SLOTS.map((slot) => [slot, Object.keys(cat[slot]).filter((id) => sdUsable(slot, sex, id, cat))])) as Record<SdSlot, string[]>;
}

/** 그릴 때만 쓰는 정리: 없는 ID·다른 성별 옷은 기본으로 그린다(기본이 없는 칸은 비움). 저장된 외형·구매 ID 는 바꾸지 않는다. */
export function resolveSd(a: Appearance, cat: SdCatalogData = SD_BUNDLED) {
  const sex = sdSexOf(a);
  const pick = (slot: SdSlot): string | null => {
    const id = a[SD_FIELDS[slot]];
    if (sdUsable(slot, sex, id, cat)) return id;
    const d = cat.defaults[sex][slot];
    return d && sdUsable(slot, sex, d, cat) ? d : null;
  };
  const hairId = pick('hair'), exprId = pick('expression'), topId = pick('top'), bottomId = pick('bottom'), shoesId = pick('shoes');
  const hair = hairId ? cat.hair[hairId] : undefined;
  const expression = exprId ? cat.expression[exprId] : undefined;
  return {
    sex,
    body: cat.body[sex],
    hairBack: hair?.back,
    hairFront: hair?.front,
    eyesOpen: expression?.open,
    /** 감은 눈 그림이 있는 표정만 깜빡인다 */
    eyesClosed: expression?.closed,
    top: topId ? cat.top[topId].art : undefined,
    bottom: bottomId ? cat.bottom[bottomId].art : undefined,
    shoes: shoesId ? cat.shoes[shoesId].art : undefined,
  };
}
export type SdLook = ReturnType<typeof resolveSd>;

/**
 * 겹치는 순서(아래 → 위): 뒷머리 → 바디 → 표정 → 신발 → 하의 → 상의 → 앞머리.
 * 표정은 얼굴 살갗이라 바디 바로 위(목 높은 옷·목도리가 턱을 덮을 수 있게), 신발은 양말이 있어 하의 아래(바지 밑단이 신발 위를 덮음).
 * SdFigure 와 확인 그림(서버 importer)이 같은 순서를 쓴다.
 */
export const SD_LAYER_ORDER = ['hairBack', 'body', 'face', 'shoes', 'bottom', 'top', 'hairFront'] as const;
export function sdLayers(look: SdLook, eyes: 'open' | 'closed' = 'open'): string[] {
  const face = eyes === 'closed' && look.eyesClosed ? look.eyesClosed : look.eyesOpen;
  const at = { hairBack: look.hairBack, body: look.body, face, shoes: look.shoes, bottom: look.bottom, top: look.top, hairFront: look.hairFront };
  return SD_LAYER_ORDER.map((k) => at[k]).filter((f): f is string => !!f);
}

/**
 * 옷장 화면용 정리: 이 성별이 못 입는 칸을 기본으로 바꾼 외형. 예전(v7) 외형으로 처음 열어도 저장이 막히지 않게 한다.
 * 기본이 없는 칸은 비운다(빈 문자열). 한 벌·소품 등 SD 가 안 쓰는 칸은 그대로(서버도 그 칸은 저장된 값을 유지).
 */
export function normalizeSd(a: Appearance, cat: SdCatalogData = SD_BUNDLED): Appearance {
  const sex = sdSexOf(a);
  const next = { ...a };
  for (const slot of SD_SLOTS) {
    const d = cat.defaults[sex][slot];
    if (!sdUsable(slot, sex, a[SD_FIELDS[slot]], cat)) next[SD_FIELDS[slot]] = d && sdUsable(slot, sex, d, cat) ? d : '';
  }
  return next;
}

export function wearSd(a: Appearance, slot: SdSlot, id: string): Appearance {
  return { ...a, [SD_FIELDS[slot]]: id };
}

/** 새로 만드는 외형의 기본 한 벌. 기본이 없는 칸은 빈 문자열(비움). */
export function sdDefaultLook(sex: SdSex, cat: SdCatalogData = SD_BUNDLED): Pick<Appearance, 'hairStyleId' | 'expressionId' | 'topId' | 'bottomId' | 'shoesId'> {
  return Object.fromEntries(SD_SLOTS.map((slot) => [SD_FIELDS[slot], cat.defaults[sex][slot] ?? ''])) as Pick<Appearance, 'hairStyleId' | 'expressionId' | 'topId' | 'bottomId' | 'shoesId'>;
}
export const SD_DEFAULT_LOOKS = { male: sdDefaultLook('male'), female: sdDefaultLook('female') };

/** 옷장·상점 이름표(서버 저장 검사·상품 자동 등록과 같은 목록). */
export function sdNames(cat: SdCatalogData = SD_BUNDLED): Record<SdSlot, Record<string, string>> {
  return Object.fromEntries(SD_SLOTS.map((slot) => [slot, Object.fromEntries(Object.entries(cat[slot]).map(([id, v]) => [id, v.name]))])) as Record<SdSlot, Record<string, string>>;
}
export const SD_NAMES = sdNames();

/** 상품 그림: 헤어는 앞머리, 표정은 눈+입, 옷·신발은 그 그림. */
export function sdArt(kind: string, id: string, cat: SdCatalogData = SD_BUNDLED): string | undefined {
  if (!(SD_SLOTS as readonly string[]).includes(kind)) return undefined;
  const slot = kind as SdSlot;
  return has(cat[slot], id) ? ((cat[slot][id] as unknown as Record<string, string | undefined>)[SD_LAYERS[slot][0]]) : undefined;
}

/** 얼굴 아이콘을 두상+앞머리를 감싼 상자 가운데에 맞추고, 이만큼 여유를 둔다(v7 과 같은 값). */
const PORTRAIT_PAD = 1.16;
/**
 * 얼굴 아이콘(프로필·일기 등)용 정사각 영역. 두상 상자(키트 spec.json)와 앞머리 그림 자리를 합친 상자의 가운데.
 * 머리 모양이 달라도 얼굴이 원 가운데 온다.
 */
export function sdPortraitViewBox(look: SdLook, cat: SdCatalogData = SD_BUNDLED): SdViewBox {
  const [hx0, hy0, hx1, hy1] = cat.headBox[look.sex];
  const boxes: SdViewBox[] = [{ x: hx0, y: hy0, w: hx1 - hx0, h: hy1 - hy0 }];
  const hair = look.hairFront ? cat.rects[look.hairFront] : undefined;
  if (hair) boxes.push(hair);
  const left = Math.min(...boxes.map((r) => r.x)), top = Math.min(...boxes.map((r) => r.y));
  const right = Math.max(...boxes.map((r) => r.x + r.w)), bottom = Math.max(...boxes.map((r) => r.y + r.h));
  const side = Math.max(right - left, bottom - top) * PORTRAIT_PAD;
  return { x: (left + right - side) / 2, y: (top + bottom - side) / 2, w: side, h: side };
}

/**
 * 옷장 칸 그림(1000x1000 좌표). 빌드가 키트(마스터 도안)의 부위별 '그려도 되는 범위'를 남녀 합쳐 감싼 상자에 여백 40px 을 붙여 만든다.
 * 그래서 긴 머리·긴 옷도 칸 안에 다 들어온다. 전신은 모든 부위를 합친 상자. 업로드 아이템도 같은 구역을 통과해야 해서 같은 값을 쓴다.
 */
export const SD_VIEWS: Readonly<Record<SdSlot | 'full', SdViewBox>> = SD_BUNDLED.views;
