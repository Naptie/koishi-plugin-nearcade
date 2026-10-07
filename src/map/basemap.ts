/**
 * 底图瓦片获取与拼接：按 Web Mercator 瓦片坐标抓取栅格瓦片，
 * 以并发限制 + 内存缓存拼接为整幅底图画布。单个瓦片失败仅留底色，不阻塞整体。
 *
 * 画布直接以设备像素（CSS 尺寸 × dpr）构建；抓取缩放级别会自动提高
 * （例如 dpr=2 时抓取 z+1 级瓦片降采样绘制），保证底图与上层矢量元素
 * 同等清晰度；512px 高清瓦片（如高德 scl=2）亦按原始分辨率 1:1 绘制。
 */

import { createCanvas, loadImage, type Canvas } from '@napi-rs/canvas';
import { TILE_SIZE } from './geo';

const tileCache = new Map<string, Promise<Buffer | null>>();
const MAX_CACHE_ENTRIES = 800;

let inflight = 0;
const MAX_PARALLEL = 12;
const waiters: (() => void)[] = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (inflight >= MAX_PARALLEL) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    waiters.shift()?.();
  }
}

async function fetchTile(
  url: string,
  timeoutMs: number,
  kind: 'image' | 'data' = 'image'
): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) nearcade-koishi/0.4',
        Referer: 'https://nearcade.cn/'
      }
    });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (kind === 'image') {
      if (contentType && !contentType.startsWith('image/')) return null;
    } else if (contentType.includes('application/json') || contentType.startsWith('text/')) {
      // 矢量瓦片：拒绝明显的 JSON 错误响应
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 64 || buffer.length > 2 * 1024 * 1024) return null;
    return buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getTile(
  url: string,
  timeoutMs: number,
  kind: 'image' | 'data' = 'image'
): Promise<Buffer | null> {
  const cached = tileCache.get(url);
  if (cached) return cached;
  const entry = withSlot(() => fetchTile(url, timeoutMs, kind));
  tileCache.set(url, entry);
  if (tileCache.size > MAX_CACHE_ENTRIES) {
    const oldest = tileCache.keys().next().value;
    if (oldest) tileCache.delete(oldest);
  }
  return entry;
}

export { getTile };

/** 展开瓦片 URL 模板中的 {x} {y} {z} {s} 占位符 */
export function expandTileTemplate(template: string, x: number, y: number, z: number): string {
  return template
    .replace(/\{s\}/g, () => String(((x * 3 + y * 7 + z) % 4) + 1))
    .replace(/\{x\}/g, String(x))
    .replace(/\{y\}/g, String(y))
    .replace(/\{z\}/g, String(z));
}

export interface StitchOptions {
  /** 瓦片 URL 模板，含 {x} {y} {z}（可选 {s}）；为空则返回纯色底 */
  template: string;
  /** 内容缩放级别（整数，上层元素按此级别投影） */
  z: number;
  /** 视口左上角在 z 级世界像素坐标系下的坐标 */
  worldX0: number;
  worldY0: number;
  /** CSS 像素 / z 级世界像素（x、y 一致） */
  cssPerWorld: number;
  /** 画布 CSS 像素宽高 */
  width: number;
  height: number;
  /** 设备像素比（输出画布实际为 width×dpr, height×dpr） */
  dpr: number;
  /** 瓦片源文件原始边长（256 标准，512 高清如高德 scl=2） */
  tileSize?: number;
  /** 瓦片服务最大缩放级别（超出则放大已有级别，如 Esri Canvas 系列为 16） */
  maxFetchZoom?: number;
  /** 瓦片背景色（缺失瓦片露出） */
  background: string;
  /** 应用于每个瓦片的 CSS filter（如 saturate(0.5)） */
  filter?: string;
  /** 底图抓取总时限（毫秒），超时后跳过剩余瓦片 */
  deadlineMs?: number;
  timeoutMs?: number;
}

/** 单次渲染抓取瓦片数上限；超出时降低抓取级别 */
const MAX_TILES = 260;

/**
 * 拼接覆盖整个视口的底图，返回 width×dpr × height×dpr 设备像素的离屏画布。
 */
export async function stitchBasemap(options: StitchOptions): Promise<Canvas> {
  const {
    template,
    z,
    worldX0,
    worldY0,
    width,
    height,
    dpr,
    tileSize = 256,
    maxFetchZoom,
    background,
    filter,
    deadlineMs = 8000,
    timeoutMs = 5000
  } = options;

  const canvas = createCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!template) return canvas;

  // 设备像素 / z 级世界像素
  const devPerWorld = cssPerWorldSafe(options.cssPerWorld) * dpr;
  // 瓦片在设备画布上的占用边长（按内容级别计）
  const footprintAtZ = TILE_SIZE * devPerWorld;

  // 抓取级别：优先选择「绘制尺寸 ≈ 瓦片原生分辨率」的级别（超采样），
  // 被服务级别上限截断时保持能取到的最高级别（此时放大绘制）
  const idealShift = Math.log2(footprintAtZ / tileSize);
  let zf = z + Math.max(0, Math.min(2, Math.round(idealShift)));
  zf = Math.max(2, Math.min(zf, maxFetchZoom ?? 30));
  // 瓦片数量保护：数量过多时逐级降低抓取级别，最低回到内容级别
  const countAt = (zoom: number) => {
    const fp = footprintAtZ / 2 ** (zoom - z);
    return (Math.ceil(canvas.width / fp) + 1) * (Math.ceil(canvas.height / fp) + 1);
  };
  while (zf > Math.max(2, z) && countAt(zf) > MAX_TILES) zf -= 1;

  const shift = zf - z;
  // 设备像素 / zf 级世界像素
  const scale = devPerWorld / 2 ** shift;
  const viewX0z = worldX0 * 2 ** shift;
  const viewY0z = worldY0 * 2 ** shift;

  const tx0 = Math.floor(viewX0z / TILE_SIZE);
  const ty0 = Math.floor(viewY0z / TILE_SIZE);
  const tx1 = Math.floor((viewX0z + canvas.width / scale) / TILE_SIZE);
  const ty1 = Math.floor((viewY0z + canvas.height / scale) / TILE_SIZE);

  const jobs: Promise<void>[] = [];
  const startedAt = Date.now();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const draw = async () => {
        if (Date.now() - startedAt > deadlineMs) return;
        const buffer = await getTile(expandTileTemplate(template, tx, ty, zf), timeoutMs);
        if (!buffer) return;
        let image;
        try {
          image = await loadImage(buffer);
        } catch {
          return;
        }
        // 以取整后的瓦片边界绘制，保证相邻瓦片无缝
        const px = Math.round((tx * TILE_SIZE - viewX0z) * scale);
        const px1 = Math.round(((tx + 1) * TILE_SIZE - viewX0z) * scale);
        const py = Math.round((ty * TILE_SIZE - viewY0z) * scale);
        const py1 = Math.round(((ty + 1) * TILE_SIZE - viewY0z) * scale);
        ctx.save();
        if (filter) ctx.filter = filter;
        ctx.drawImage(image, px, py, px1 - px, py1 - py);
        ctx.restore();
      };
      jobs.push(draw());
    }
  }
  await Promise.all(jobs);
  return canvas;
}

function cssPerWorldSafe(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}
