/**
 * SD 캐릭터 목록 데이터(서버도 import 하므로 React·그림 require 를 두지 않는다).
 * 목록 = 앱에 묶인 것(catalog.generated.ts, 바디·기본 아이템) + 관리 페이지에서 업로드한 것(서버 /sd/catalog).
 * 모든 그림은 같은 1000x1000 캔버스 좌표를 쓰고, rects 는 투명 여백을 잘라 낸 그림이 캔버스 안에 놓일 자리다.
 *
 * 2026-11-06 성별별 재편: 모든 아이템은 성별(sex)이 하나다. 남자 아이템은 남자 옷장에만, 여자 아이템은 여자 옷장에만,
 * '공용'(unisex)으로 올린 아이템만 양쪽 옷장에 보인다(그림은 한 장을 남녀 바디에 같이 쓴다).
 */
export type SdSex = 'male' | 'female';
export type SdItemSex = SdSex | 'unisex';
export const SD_ITEM_SEXES: readonly SdItemSex[] = ['male', 'female', 'unisex'];
export const SD_SLOTS = ['hair', 'expression', 'top', 'bottom', 'shoes'] as const;
export type SdSlot = (typeof SD_SLOTS)[number];
export type SdRect = { x: number; y: number; w: number; h: number };
export type SdHair = { name: string; sex: SdItemSex; front?: string; back?: string };
export type SdExpression = { name: string; sex: SdItemSex; open?: string; closed?: string };
/** 상의·하의·신발: 그림 한 장(신발은 양말을 같이 그려도 된다) */
export type SdGarment = { name: string; sex: SdItemSex; art?: string };
export type SdItems = { hair: Record<string, SdHair>; expression: Record<string, SdExpression>; top: Record<string, SdGarment>; bottom: Record<string, SdGarment>; shoes: Record<string, SdGarment> };
export const emptySdItems = (): SdItems => ({ hair: {}, expression: {}, top: {}, bottom: {}, shoes: {} });

export type SdCatalogData = SdItems & {
  version: string;
  canvas: number[];
  groundY: number;
  body: Record<SdSex, string>;
  headBox: Record<SdSex, number[]>;
  views: Record<SdSlot | 'full', SdRect>;
  /** 새 외형의 기본 한 벌. null = 그 칸은 비움(예: 아직 그림이 없음) */
  defaults: Record<SdSex, Record<SdSlot, string | null>>;
  rects: Record<string, SdRect>;
};

/** 서버가 내려주는 업로드 아이템 목록(/sd/catalog). 그림 이름은 저장소 키(sd/<uuid>.webp), urls: 그림 이름 → 주소 */
export type SdRemoteCatalog = { revision: string; items: SdItems; rects: Record<string, SdRect>; urls: Record<string, string> };

/** 칸마다 쓸 수 있는 레이어 이름. 첫 번째가 꼭 있어야 하는 레이어(앞머리·뜬 눈·옷 그림) */
export const SD_LAYERS: Readonly<Record<SdSlot, readonly string[]>> = { hair: ['front', 'back'], expression: ['open', 'closed'], top: ['art'], bottom: ['art'], shoes: ['art'] };
/** 이 성별 옷장에 보이는 아이템인가(성별이 같거나 공용) */
export const sdFitsSex = (itemSex: SdItemSex | undefined, sex: SdSex) => itemSex === 'unisex' || itemSex === sex;
const ID = /^[a-z][a-z0-9]{1,23}$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isSex = (v: unknown): v is SdItemSex => typeof v === 'string' && (SD_ITEM_SEXES as readonly string[]).includes(v);
const isRect = (r: unknown): r is SdRect => {
  if (!r || typeof r !== 'object') return false;
  const { x, y, w, h } = r as Record<string, unknown>;
  return [x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v)) && (x as number) >= 0 && (y as number) >= 0 && (w as number) > 0 && (h as number) > 0 && (x as number) + (w as number) <= 1000 && (y as number) + (h as number) <= 1000;
};

/**
 * 서버(또는 기기에 저장해 둔) 업로드 목록을 검사해 쓸 수 있는 것만 남긴다.
 * 모양이 틀린 ID·레이어·성별, 자리(rect)가 없는 그림은 빼고, 꼭 있어야 하는 레이어(앞머리·뜬 눈·옷 그림)가 없는 아이템도 뺀다.
 */
export function cleanSdRemote(raw: unknown): Pick<SdRemoteCatalog, 'revision' | 'items' | 'rects'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const { revision, items, rects } = raw as Record<string, unknown>;
  if (typeof revision !== 'string' || !items || typeof items !== 'object' || !rects || typeof rects !== 'object') return null;
  const out = emptySdItems();
  const used: Record<string, SdRect> = {};
  for (const slot of SD_SLOTS) {
    const list = (items as Record<string, unknown>)[slot];
    if (!list || typeof list !== 'object') continue;
    for (const [id, item] of Object.entries(list)) {
      if (!ID.test(id) || !item || typeof item !== 'object') continue;
      const { name, sex } = item as Record<string, unknown>;
      if (typeof name !== 'string' || !name || !isSex(sex)) continue;
      const entry: Record<string, string> = { name, sex };
      for (const layer of SD_LAYERS[slot]) {
        const file = (item as Record<string, unknown>)[layer];
        const rect = typeof file === 'string' && own(rects, file) ? (rects as Record<string, unknown>)[file] : undefined;
        if (typeof file === 'string' && isRect(rect)) { entry[layer] = file; used[file] = rect; }
      }
      if (entry[SD_LAYERS[slot][0]]) (out[slot] as Record<string, unknown>)[id] = entry;
    }
  }
  return { revision, items: out, rects: used };
}

/**
 * 묶인 목록 + 업로드 목록. 같은 ID 는 업로드 쪽이 이긴다(성별·이름·레이어). 짝 레이어(뒷머리·감은 눈)는 성별이 같을 때만 묶인 것을 이어 쓴다.
 * 업로드로 새로 생긴 아이템은 목록 뒤에 붙는다(옷장에 보이는 순서).
 */
export function mergeSdCatalog(base: SdCatalogData, remote: Pick<SdRemoteCatalog, 'items' | 'rects'> | null | undefined): SdCatalogData {
  if (!remote) return base;
  const items = {} as Record<SdSlot, Record<string, object>>;
  for (const slot of SD_SLOTS) {
    const merged: Record<string, object> = { ...base[slot] };
    for (const [id, item] of Object.entries(remote.items[slot] ?? {})) {
      if (!ID.test(id)) continue;
      const was = own(base[slot], id) ? (base[slot] as Record<string, { sex: SdItemSex }>)[id] : undefined;
      merged[id] = { ...(was && was.sex === item.sex ? was : {}), ...item };
    }
    items[slot] = merged;
  }
  return { ...base, ...(items as unknown as SdItems), rects: { ...base.rects, ...remote.rects } };
}
