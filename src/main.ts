import { SD_BUNDLED } from './app/catalog.generated.ts';
import { cleanSdRemote, emptySdItems, mergeSdCatalog, SD_SLOTS, type SdCatalogData, type SdItemSex, type SdItems, type SdRect, type SdSex, type SdSlot } from './app/sdCatalog.ts';
import { resolveSd, sdAvailable, SD_FIELDS, SD_VIEWS, sdUsable } from './app/sdModel.ts';
import { parseSdFileName, sdFileName, type SdFileKey, type SdKits } from './app/sdKit.ts';
import source from './app/source.json';
import type { Appearance } from './domain/appearance.ts';
import { importItem, loadKits, toImageData, type ImportResult } from './importer.ts';
import { PR73 } from './pr73.ts';

// ---------- 설정 ----------
const params = new URLSearchParams(location.search);
const API = (params.get('api') ?? 'https://api.duetden.com').replace(/\/$/, '');
const BODY_FILES: Record<string, string> = { 'body_m.png': 'app-assets/body_m.webp', 'body_f.png': 'app-assets/body_f.webp' };

const SLOT_LABEL: Record<SdSlot, string> = { hair: '헤어', expression: '표정', top: '상의', bottom: '하의', shoes: '신발' };
const SLOT_KEYS: Record<SdSlot, { key: SdFileKey; label: string }[]> = {
  hair: [{ key: 'back', label: '뒷머리(후면)' }, { key: 'front', label: '앞머리(전면)' }, { key: 'whole', label: '앞뒤 한 장' }],
  expression: [{ key: 'open', label: '뜬 눈' }, { key: 'closed', label: '감은 눈' }],
  top: [{ key: 'art', label: '파일 첨부' }],
  bottom: [{ key: 'art', label: '파일 첨부' }],
  shoes: [{ key: 'art', label: '파일 첨부' }],
};
const SEX_LABEL: Record<SdItemSex, string> = { male: '남', female: '여', unisex: '공용' };
const VIEW_LABEL: Record<keyof typeof SD_VIEWS, string> = { full: '전신', hair: '머리', expression: '얼굴', top: '상의', bottom: '하의', shoes: '신발' };

/**
 * 랩 겹치는 순서(2026-11-09 사용자): 뒷머리 → 바디 → (표정) → 앞머리 → 신발(양말) → 하의 → 상의.
 * 앱(sdModel SD_LAYER_ORDER)은 아직 뒷머리 → 바디 → 표정 → 신발 → 하의 → 상의 → 앞머리.
 * 표정은 얼굴 살갗이라 바디 바로 위에 둔다.
 */
const LAB_LAYER_ORDER = ['hairBack', 'body', 'face', 'hairFront', 'shoes', 'bottom', 'top'] as const;
function sdLayers(look: ReturnType<typeof resolveSd>, eyes: 'open' | 'closed'): string[] {
  const face = eyes === 'closed' && look.eyesClosed ? look.eyesClosed : look.eyesOpen;
  const at = { hairBack: look.hairBack, body: look.body, face, shoes: look.shoes, bottom: look.bottom, top: look.top, hairFront: look.hairFront };
  return LAB_LAYER_ORDER.map((k) => at[k]).filter((f): f is string => !!f);
}

// ---------- 상태 ----------
type Upload = {
  id: string;
  /** 파일 이름 규칙에서 읽은 ID(저장 파일 이름용) */
  fileId: string;
  slot: SdSlot;
  sex: SdItemSex;
  files: Partial<Record<SdFileKey, File>>;
  result: ImportResult | null;
  busy: boolean;
  drawables: Partial<Record<SdFileKey, HTMLCanvasElement>>;
  badCanvas: HTMLCanvasElement | null;
};
type RemoteState = { status: 'loading' | 'ok' | 'fail'; message: string; items: SdItems; rects: Record<string, SdRect>; urls: Record<string, string> };

const state = {
  sex: 'male' as SdSex,
  looks: {} as Record<SdSex, Appearance>,
  touched: { male: false, female: false },
  autoFit: true,
  unisex: false,
  eyesClosed: false,
  showBad: true,
  view: 'full' as keyof typeof SD_VIEWS,
  bg: 'cream',
  remote: { status: 'loading', message: '앱에 올라간 에셋 불러오는 중…', items: emptySdItems(), rects: {}, urls: {} } as RemoteState,
  uploads: [] as Upload[],
  kits: null as SdKits | null,
  kitsError: '',
};
let uploadSeq = 0;

// ---------- 목록 ----------
function catalog(): SdCatalogData {
  let cat = mergeSdCatalog(SD_BUNDLED, { items: { ...emptySdItems(), ...PR73.items }, rects: PR73.rects });
  if (state.remote.status === 'ok') cat = mergeSdCatalog(cat, state.remote);
  if (state.uploads.length) {
    const items = emptySdItems();
    const rects: Record<string, SdRect> = {};
    for (const u of state.uploads) {
      if (!u.result) continue;
      const entry: Record<string, string> = { name: uploadName(u), sex: u.sex };
      for (const [k, d] of Object.entries(u.drawables)) if (d) { const f = `${u.id}:${k}`; entry[k === 'art' ? 'art' : k] = f; rects[f] = { x: 0, y: 0, w: 1000, h: 1000 }; }
      (items[u.slot] as Record<string, unknown>)[u.id] = entry;
    }
    cat = mergeSdCatalog(cat, { items, rects });
  }
  return cat;
}
const uploadName = (u: Upload) => `📎 ${Object.values(u.files).map((f) => f!.name).join(' + ')}`;

/** 그림 파일 이름 → 그릴 것(이미지 주소 또는 업로드 캔버스) */
function drawableOf(file: string): CanvasImageSource | null {
  const [uid, key] = file.split(':');
  const up = state.uploads.find((u) => u.id === uid);
  if (up && key) return up.drawables[key as SdFileKey] ?? null;
  const url = BODY_FILES[file] ?? (file.startsWith('pr73/') ? file : state.remote.urls[file]);
  return url ? image(url) : null;
}
const imgCache = new Map<string, HTMLImageElement>();
function image(url: string): HTMLImageElement | null {
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = () => scheduleDraw();
    img.onerror = () => scheduleDraw();
    img.src = url;
    imgCache.set(url, img);
  }
  return img.complete && img.naturalWidth ? img : null;
}

function defaultLook(sex: SdSex, cat: SdCatalogData): Appearance {
  const avail = sdAvailable(sex, cat);
  const look: Appearance = { faceProfileId: sex, hairStyleId: '', expressionId: '', topId: '', bottomId: '', shoesId: '' };
  for (const slot of SD_SLOTS) {
    const d = cat.defaults[sex][slot];
    const pick = d && sdUsable(slot, sex, d, cat) ? d : slot === 'hair' && sdUsable('hair', sex, PR73.defaults[sex], cat) ? PR73.defaults[sex] : avail[slot][0] ?? '';
    (look as Record<string, unknown>)[SD_FIELDS[slot]] = pick;
  }
  return look;
}
const look = () => state.looks[state.sex];
const selectedId = (slot: SdSlot) => (look()[SD_FIELDS[slot]] as string | undefined) ?? '';

// ---------- 그리기 ----------
const stage = document.getElementById('stage') as HTMLCanvasElement;
let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}
function draw() {
  const cat = catalog();
  const box = SD_VIEWS[state.view];
  const cssW = Math.max(stage.clientWidth, (stage.clientHeight * box.w) / box.h) || 360;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const s = (cssW * dpr) / box.w;
  stage.width = Math.round(box.w * s);
  stage.height = Math.round(box.h * s);
  stage.style.aspectRatio = `${box.w} / ${box.h}`;
  const ctx = stage.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, stage.width, stage.height);
  const resolved = resolveSd(look(), cat);
  for (const file of sdLayers(resolved, state.eyesClosed ? 'closed' : 'open')) {
    const d = drawableOf(file);
    const r = cat.rects[file];
    if (!d || !r) continue;
    ctx.drawImage(d, (r.x - box.x) * s, (r.y - box.y) * s, r.w * s, r.h * s);
  }
  if (state.showBad) {
    for (const slot of SD_SLOTS) {
      const u = state.uploads.find((x) => x.id === selectedId(slot) && x.slot === slot);
      if (u?.badCanvas && sdUsable(slot, state.sex, u.id, cat)) ctx.drawImage(u.badCanvas, -box.x * s, -box.y * s, 1000 * s, 1000 * s);
    }
  }
}

// ---------- 업로드 ----------
function toCanvas(rgba: Uint8Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 1000; c.height = 1000;
  c.getContext('2d')!.putImageData(toImageData(rgba), 0, 0);
  return c;
}
function badToCanvas(bad: Uint8Array): HTMLCanvasElement {
  const rgba = new Uint8Array(1000 * 1000 * 4);
  for (let p = 0; p < bad.length; p++) if (bad[p]) rgba.set([230, 30, 30, 200], p * 4);
  return toCanvas(rgba);
}

async function runImport(u: Upload) {
  if (!state.kits) { await kitsReady; }
  if (!state.kits) return;
  u.busy = true;
  render();
  await new Promise((r) => setTimeout(r, 30));
  try {
    const res = await importItem(state.kits, u.slot, u.sex, u.files, state.autoFit);
    u.result = res;
    u.drawables = {};
    for (const [k, rgba] of Object.entries(res.layers)) if (rgba) u.drawables[k as SdFileKey] = toCanvas(rgba);
    u.badCanvas = res.bad ? badToCanvas(res.bad) : null;
  } catch (e) {
    u.result = { ok: false, layers: {}, problems: [`읽기 실패: ${(e as Error).message}`], notes: [], bad: null, fit: { scale: 1, dx: 0, dy: 0 } };
    u.drawables = {};
    u.badCanvas = null;
  }
  u.busy = false;
  render();
}

function wear(slot: SdSlot, id: string) {
  (look() as Record<string, unknown>)[SD_FIELDS[slot]] = id;
  state.touched[state.sex] = true;
}

function newUpload(slot: SdSlot, sex: SdItemSex, fileId: string): Upload {
  const u: Upload = { id: `up${++uploadSeq}`, fileId, slot, sex, files: {}, result: null, busy: false, drawables: {}, badCanvas: null };
  state.uploads.push(u);
  return u;
}

function setFile(u: Upload, key: SdFileKey, file: File) {
  if (key === 'whole') { delete u.files.front; delete u.files.back; }
  if (key === 'front' || key === 'back') delete u.files.whole;
  u.files[key] = file;
}

/** 칸의 첨부 버튼: 고른 아이템이 업로드면 그 아이템의 그 그림을 넣거나 바꾸고, 아니면 새 업로드 아이템을 만든다 */
function attach(slot: SdSlot, key: SdFileKey, file: File) {
  const itemSex: SdItemSex = state.unisex ? 'unisex' : state.sex;
  const parsed = parseSdFileName(file.name);
  let u = state.uploads.find((x) => x.id === selectedId(slot) && x.slot === slot);
  if (!u || u.sex !== itemSex) u = newUpload(slot, itemSex, parsed && parsed.slot !== 'body' ? parsed.id : `lab${uploadSeq + 1}`);
  setFile(u, key, file);
  wear(slot, u.id);
  void runImport(u);
}

/** 이름 규칙대로 여러 파일 한꺼번에(관리 페이지와 같은 이름: hair_<id>_m.png, top_<id>_u.png …) */
function attachByName(files: File[]) {
  const errors: string[] = [];
  const groups = new Map<string, Upload>();
  for (const f of files) {
    const info = parseSdFileName(f.name);
    if (!info) { errors.push(`${f.name}: 파일 이름 규칙에 안 맞아요(예: hair_curly01_m.png, top_cardigan01_u.png)`); continue; }
    if (info.slot === 'body') { errors.push(`${f.name}: 바디는 여기서 바꾸지 않아요`); continue; }
    const sex = info.sex ?? (state.unisex ? 'unisex' : state.sex);
    const k = `${info.slot}:${info.id}:${sex}`;
    const u = groups.get(k) ?? newUpload(info.slot, sex, info.id);
    groups.set(k, u);
    setFile(u, info.key, f);
  }
  for (const u of groups.values()) {
    if (u.sex === state.sex || u.sex === 'unisex') wear(u.slot, u.id);
    void runImport(u);
  }
  nameErrors = errors;
  render();
}
let nameErrors: string[] = [];

function download(u: Upload, key: SdFileKey) {
  const c = u.drawables[key];
  if (!c) return;
  const name = sdFileName(u.slot, u.fileId, key, u.sex);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}

// ---------- 화면 ----------
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function render() {
  const cat = catalog();
  document.body.dataset.bg = state.bg;
  $('#sex-m').classList.toggle('on', state.sex === 'male');
  $('#sex-f').classList.toggle('on', state.sex === 'female');
  ($('#autofit') as HTMLInputElement).checked = state.autoFit;
  ($('#unisex') as HTMLInputElement).checked = state.unisex;
  ($('#eyes') as HTMLInputElement).checked = state.eyesClosed;
  ($('#showbad') as HTMLInputElement).checked = state.showBad;
  $('#views').innerHTML = (Object.keys(SD_VIEWS) as (keyof typeof SD_VIEWS)[]).map((v) => `<button class="chip ${v === state.view ? 'on' : ''}" data-view="${v}">${VIEW_LABEL[v]}</button>`).join('');
  const r = state.remote;
  $('#remote').className = `status ${r.status}`;
  $('#remote').textContent = r.message;
  $('#source').textContent = `앱 코드 기준: duetden ${source.commit} (${source.date})${state.kitsError ? ` · 키트 오류: ${state.kitsError}` : ''}`;
  $('#name-errors').innerHTML = nameErrors.map((e) => `<div class="bad">${esc(e)}</div>`).join('');

  const avail = sdAvailable(state.sex, cat);
  $('#slots').innerHTML = SD_SLOTS.map((slot) => {
    const sel = selectedId(slot);
    const def = cat.defaults[state.sex][slot];
    const chips = [`<button class="chip ${sel === '' || !sdUsable(slot, state.sex, sel, cat) ? 'on' : ''}" data-slot="${slot}" data-id="">비우기${def ? '(앱 기본)' : ''}</button>`]
      .concat(avail[slot].map((id) => {
        const it = cat[slot][id] as { name: string; sex: SdItemSex };
        const tag = id === def ? ' · 기본' : '';
        return `<button class="chip ${id === sel ? 'on' : ''} ${id.startsWith('up') && state.uploads.some((u) => u.id === id) ? 'mine' : ''}" data-slot="${slot}" data-id="${id}">${esc(it.name)}<small>${id.startsWith('up') ? '' : ` ${id}`} · ${SEX_LABEL[it.sex]}${tag}</small></button>`;
      })).join('');
    const ups = state.uploads.filter((u) => u.slot === slot && u.id === sel);
    const detail = ups.map((u) => {
      const res = u.result;
      const lines = u.busy ? '<div class="note">맞추고 검사하는 중…</div>' : res ? [
        `<div class="${res.ok ? 'good' : 'bad'}">${res.ok ? '✅ 통과' : '❌ 불통과'}</div>`,
        ...res.problems.map((p) => `<div class="bad">· ${esc(p)}</div>`),
        ...res.notes.map((n) => `<div class="note">· ${esc(n)}</div>`),
        `<div class="dl">${Object.keys(u.drawables).map((k) => `<button class="mini" data-dl="${u.id}" data-key="${k}">⬇ ${esc(sdFileName(u.slot, u.fileId, k as SdFileKey, u.sex))}</button>`).join('')}<button class="mini danger" data-del="${u.id}">지우기</button></div>`,
      ].join('') : '';
      return `<div class="result">${lines}</div>`;
    }).join('');
    const buttons = SLOT_KEYS[slot].map(({ key, label }) => `<label class="file" data-drop-slot="${slot}" data-drop-key="${key}">📎 ${label}<input type="file" accept="image/png,image/webp,image/jpeg" data-attach="${slot}" data-key="${key}"></label>`).join('');
    return `<section class="slot" data-drop-slot="${slot}"><h2>${SLOT_LABEL[slot]}<span class="drop-hint">여기에 끌어다 놓기</span></h2><div class="chips">${chips}</div><div class="files">${buttons}</div>${detail}</section>`;
  }).join('');
  scheduleDraw();
}

document.addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
  if (!t) return;
  if (t.id === 'sex-m' || t.id === 'sex-f') { state.sex = t.id === 'sex-m' ? 'male' : 'female'; render(); return; }
  if (t.dataset.view) { state.view = t.dataset.view as keyof typeof SD_VIEWS; render(); return; }
  if (t.dataset.bg) { state.bg = t.dataset.bg; render(); return; }
  if (t.dataset.slot !== undefined && t.dataset.id !== undefined) { wear(t.dataset.slot as SdSlot, t.dataset.id); render(); return; }
  if (t.dataset.dl) { const u = state.uploads.find((x) => x.id === t.dataset.dl); if (u) download(u, t.dataset.key as SdFileKey); return; }
  if (t.dataset.del) {
    const u = state.uploads.find((x) => x.id === t.dataset.del);
    if (u) { state.uploads = state.uploads.filter((x) => x !== u); wear(u.slot, ''); render(); }
  }
});
document.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.attach && t.files?.[0]) { attach(t.dataset.attach as SdSlot, t.dataset.key as SdFileKey, t.files[0]); t.value = ''; render(); return; }
  if (t.id === 'byname' && t.files?.length) { attachByName([...t.files]); t.value = ''; return; }
  if (t.id === 'autofit') { state.autoFit = t.checked; for (const u of state.uploads) void runImport(u); render(); return; }
  if (t.id === 'unisex') { state.unisex = t.checked; render(); return; }
  if (t.id === 'eyes') { state.eyesClosed = t.checked; render(); return; }
  if (t.id === 'showbad') { state.showBad = t.checked; render(); }
});
window.addEventListener('resize', scheduleDraw);

// ---------- 끌어다 놓기(PC) ----------
/**
 * - 칸의 첨부 버튼 위: 그 그림(앞머리·뒷머리·뜬 눈…)으로
 * - 칸(상자) 위: 상의·하의·신발은 그 칸에, 헤어는 이름이 hair-front_/hair-back_ 이면 그쪽, 아니면 앞뒤 한 장, 표정은 _closed 면 감은 눈
 * - 그 밖(캐릭터 그림·빈 곳): 파일 이름 규칙대로(hair_…_f.png, top_…_u.png). 이름이 규칙에 없으면 안내만
 */
const imageFiles = (dt: DataTransfer | null) => [...(dt?.files ?? [])].filter((f) => /^image\//.test(f.type) || /\.(png|webp|jpe?g)$/i.test(f.name));
function keyFor(slot: SdSlot, file: File): SdFileKey {
  const info = parseSdFileName(file.name);
  if (info && info.slot === slot) return info.key;
  return slot === 'hair' ? 'whole' : slot === 'expression' ? (/_closed/i.test(file.name) ? 'closed' : 'open') : 'art';
}
let dragDepth = 0;
const clearHover = () => document.querySelectorAll('.drop-over').forEach((e) => e.classList.remove('drop-over'));
document.addEventListener('dragenter', (e) => { if (!e.dataTransfer?.types.includes('Files')) return; dragDepth++; document.body.classList.add('dragging'); });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); clearHover(); } });
document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  clearHover();
  const key = (e.target as HTMLElement).closest('[data-drop-key]');
  (key ?? (e.target as HTMLElement).closest('[data-drop-slot]'))?.classList.add('drop-over');
});
document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  clearHover();
  const files = imageFiles(e.dataTransfer);
  if (!files.length) return;
  const keyEl = (e.target as HTMLElement).closest<HTMLElement>('[data-drop-key]');
  const slotEl = (e.target as HTMLElement).closest<HTMLElement>('[data-drop-slot]');
  if (keyEl) { attach(keyEl.dataset.dropSlot as SdSlot, keyEl.dataset.dropKey as SdFileKey, files[0]); render(); return; }
  if (slotEl) {
    const slot = slotEl.dataset.dropSlot as SdSlot;
    // 헤어 앞·뒤나 표정 뜬 눈·감은 눈을 같이 놓으면 같은 아이템으로 묶는다
    for (const f of files.slice(0, slot === 'hair' || slot === 'expression' ? 2 : 1)) attach(slot, keyFor(slot, f), f);
    render();
    return;
  }
  attachByName(files);
});

// ---------- 시작 ----------
const kitsReady = loadKits('kit', { male: { url: BODY_FILES['body_m.png'], x: SD_BUNDLED.rects['body_m.png'].x, y: SD_BUNDLED.rects['body_m.png'].y }, female: { url: BODY_FILES['body_f.png'], x: SD_BUNDLED.rects['body_f.png'].x, y: SD_BUNDLED.rects['body_f.png'].y } }).then((k) => { state.kits = k; }, (e) => { state.kitsError = (e as Error).message; render(); });

async function loadRemote() {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const res = await fetch(`${API}/sd/catalog`, { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const clean = cleanSdRemote(await res.json());
    if (!clean) throw new Error('목록 모양이 달라요');
    const urls = Object.fromEntries(Object.keys(clean.rects).map((k) => [k, `${API}/sd/files/${k}`]));
    const n = SD_SLOTS.reduce((a, s) => a + Object.keys(clean.items[s]).length, 0);
    state.remote = { status: 'ok', message: `앱에 올라간 에셋 ${n}개 (${API})`, items: clean.items, rects: clean.rects, urls };
  } catch (e) {
    state.remote = { ...state.remote, status: 'fail', message: `앱 에셋 목록을 못 불러왔어요(${(e as Error).message}). 앱 기본 바디만 보여요` };
  }
}

(async () => {
  const init = () => { const cat = catalog(); for (const sex of ['male', 'female'] as const) if (!state.touched[sex]) state.looks[sex] = defaultLook(sex, cat); };
  init();
  render();
  await loadRemote();
  init();
  render();
})();
