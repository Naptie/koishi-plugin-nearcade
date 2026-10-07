/**
 * 矢量瓦片（MVT）底图：抓取 Mapbox Vector Tile，按内置暗色风格
 * （对齐 amap://styles/dark 的观感）将几何直接绘制到设备分辨率画布。
 * 文字/图标要素按设计跳过 —— 注记完全由上层自有图层承担。
 *
 * 默认数据源为必应矢量瓦片（微软中国地图服务 ditu.live.com，GCJ-02 坐标、
 * 标准 Web Mercator XYZ 网格，与 nearcade 数据一致，无需坐标转换，
 * 模板形如 …/comp/ch/{z}-{x}-{y}.mvt?…）。矢量几何按任意比例绘制，
 * 恒定清晰，无需超采样。
 */

import { gunzipSync } from 'node:zlib';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { expandTileTemplate, getTile } from './basemap';
import { createCanvas, type Canvas, type SKRSContext2D } from '@napi-rs/canvas';

// ---------------------------------------------------------------------------
// 暗色风格（取自 amap://styles/dark 的真实配色）
// ---------------------------------------------------------------------------

const LAND = '#2a2a2a';
const WATER = '#171717';
const GREEN = '#263129';
const ROAD_CASING = '#1b1b1b';
const ROAD_MAJOR = '#3d3d3d';
const ROAD_ARTERIAL = '#393939';
const ROAD_STREET = '#313131';
const TRAIL = '#474747';
const RAIL = '#202020';

/** 宽度锚点：[缩放级别, CSS 像素]，级别间线性插值 */
type WidthAnchors = [number, number][];

function widthAt(anchors: WidthAnchors, z: number): number {
  if (z <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (z <= anchors[i][0]) {
      const [z0, w0] = anchors[i - 1];
      const [z1, w1] = anchors[i];
      return w0 + ((w1 - w0) * (z - z0)) / (z1 - z0);
    }
  }
  return anchors[anchors.length - 1][1];
}

interface RoadClass {
  fill: string;
  casing: string;
  /** 描边宽度 = 填充宽度 × casingScale */
  casingScale: number;
  width: WidthAnchors;
  match: (pEntry: string, bkt: number) => boolean;
}

// Bing road 图层的类别：p-entry 字符串优先，bkt 兜底
const ROAD_CLASSES: RoadClass[] = [
  {
    fill: ROAD_MAJOR,
    casing: ROAD_CASING,
    casingScale: 2.2,
    width: [
      [10, 1.5],
      [12, 2.4],
      [14, 4],
      [16, 5.6],
      [18, 7]
    ],
    match: (e, bkt) => e.includes('controlledaccess') || bkt === 641
  },
  {
    fill: ROAD_MAJOR,
    casing: ROAD_CASING,
    casingScale: 2,
    width: [
      [10, 1.3],
      [12, 2.1],
      [14, 3.5],
      [16, 5],
      [18, 6.4]
    ],
    match: (e, bkt) => e.includes('highway') || bkt === 635 || bkt === 666
  },
  {
    fill: ROAD_MAJOR,
    casing: ROAD_CASING,
    casingScale: 1.8,
    width: [
      [12, 0.9],
      [14, 1.7],
      [16, 2.8]
    ],
    match: (e, bkt) => e.includes('ramp') || bkt === 663
  },
  {
    fill: ROAD_MAJOR,
    casing: ROAD_CASING,
    casingScale: 1.9,
    width: [
      [11, 1.1],
      [13, 1.9],
      [15, 3],
      [17, 4.4]
    ],
    match: (e, bkt) => e.includes('major') || bkt === 668
  },
  {
    fill: ROAD_ARTERIAL,
    casing: ROAD_CASING,
    casingScale: 1.7,
    width: [
      [12, 0.8],
      [14, 1.7],
      [16, 2.8],
      [18, 4]
    ],
    match: (e, bkt) => e.includes('arterial') || bkt === 676 || bkt === 672
  },
  {
    fill: ROAD_STREET,
    casing: ROAD_CASING,
    casingScale: 1.4,
    width: [
      [13, 0.6],
      [15, 1.1],
      [17, 1.9]
    ],
    match: (e, bkt) => e.includes('street') || bkt === 680 || bkt === 684
  }
];

const WATER_WIDTH: WidthAnchors = [
  [10, 1.5],
  [12, 3.5],
  [14, 8],
  [16, 14],
  [18, 20]
];
const RAIL_WIDTH: WidthAnchors = [
  [11, 0.5],
  [14, 0.9],
  [17, 1.3]
];
const TRAIL_WIDTH: WidthAnchors = [
  [13, 0.6],
  [15, 1],
  [17, 1.5]
];

/** 模板是否为 MVT 矢量瓦片 */
export function isMvtTemplate(template: string): boolean {
  return /\.mvt(\?|$)/i.test(template);
}

// ---------------------------------------------------------------------------
// 解码与绘制
// ---------------------------------------------------------------------------

interface RawFeature {
  type: number; // 1=Point 2=LineString 3=Polygon
  pEntry: string;
  bkt: number;
  geom: { x: number; y: number }[][];
}

function decodeTile(buffer: Buffer): Record<string, RawFeature[]> | null {
  let payload = buffer;
  if (payload.length > 2 && payload[0] === 0x1f && payload[1] === 0x8b) {
    try {
      payload = gunzipSync(payload);
    } catch {
      return null;
    }
  }
  try {
    const vt = new VectorTile(new PbfReader(payload));
    const layers: Record<string, RawFeature[]> = {};
    for (const name of Object.keys(vt.layers)) {
      const layer = vt.layers[name];
      const feats: RawFeature[] = [];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        // 仅保留几何图层；文字/图标（Point）按设计跳过
        if (f.type !== 2 && f.type !== 3) continue;
        feats.push({
          type: f.type,
          pEntry: String(f.properties?.['p-entry'] ?? '').toLowerCase(),
          bkt: Number(f.properties?.bkt ?? -1),
          geom: f.loadGeometry()
        });
      }
      if (feats.length) layers[name] = feats;
    }
    return layers;
  } catch {
    return null;
  }
}

function fillPolys(
  ctx: SKRSContext2D,
  feats: RawFeature[] | undefined,
  px: number,
  py: number,
  s: number,
  color: string
) {
  if (!feats?.length) return;
  ctx.fillStyle = color;
  for (const f of feats) {
    if (f.type !== 3) continue;
    ctx.beginPath();
    for (const ring of f.geom) {
      ring.forEach((p, i) => {
        const x = px + p.x * s;
        const y = py + p.y * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
    ctx.fill('evenodd');
  }
}

function strokeLines(
  ctx: SKRSContext2D,
  feats: RawFeature[] | undefined,
  px: number,
  py: number,
  s: number,
  color: string,
  widthDev: number
) {
  if (!feats?.length || widthDev <= 0) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = widthDev;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const f of feats) {
    if (f.type !== 2) continue;
    ctx.beginPath();
    for (const line of f.geom) {
      line.forEach((p, i) => {
        const x = px + p.x * s;
        const y = py + p.y * s;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
    }
    ctx.stroke();
  }
}

function drawVectorTile(
  ctx: SKRSContext2D,
  buffer: Buffer,
  px: number,
  py: number,
  sizeDev: number,
  zEff: number,
  dpr: number
) {
  const layers = decodeTile(buffer);
  if (!layers) return;
  const s = sizeDev / 4096;

  fillPolys(ctx, layers.vector_background, px, py, s, LAND);
  fillPolys(ctx, layers.reserve, px, py, s, GREEN);
  fillPolys(ctx, layers.land_cover_grass, px, py, s, GREEN);
  fillPolys(ctx, layers.land_cover_forest, px, py, s, GREEN);
  fillPolys(ctx, layers.water_feature, px, py, s, WATER);
  strokeLines(ctx, layers.water_feature, px, py, s, WATER, widthAt(WATER_WIDTH, zEff) * dpr);
  strokeLines(ctx, layers.railway_cn, px, py, s, RAIL, widthAt(RAIL_WIDTH, zEff) * dpr);

  // 道路按类别分桶；先统一绘制描边（深色包边），再由低级到高级绘制填充
  const roads = layers.road;
  if (roads?.length) {
    const byClass: { cls: RoadClass; feats: RawFeature[] }[] = ROAD_CLASSES.map((cls) => ({
      cls,
      feats: []
    }));
    const unknown: RawFeature[] = [];
    for (const f of roads) {
      if (f.type !== 2) continue;
      const cls = byClass.find(({ cls: c }) => c.match(f.pEntry, f.bkt));
      if (cls) cls.feats.push(f);
      else unknown.push(f);
    }
    const ordered = [...byClass].sort(
      (a, b) => widthAt(a.cls.width, zEff) - widthAt(b.cls.width, zEff)
    );
    for (const { cls, feats } of ordered) {
      if (!feats.length) continue;
      const w = widthAt(cls.width, zEff) * dpr;
      strokeLines(ctx, feats, px, py, s, cls.casing, Math.max(w * cls.casingScale, w + dpr));
    }
    for (const { cls, feats } of ordered) {
      if (!feats.length) continue;
      strokeLines(ctx, feats, px, py, s, cls.fill, widthAt(cls.width, zEff) * dpr);
    }
    // 未识别的道路类别按最细街道处理
    strokeLines(ctx, unknown, px, py, s, ROAD_STREET, widthAt(ROAD_CLASSES[5].width, zEff) * dpr);
  }

  strokeLines(ctx, layers.trail, px, py, s, TRAIL, widthAt(TRAIL_WIDTH, zEff) * dpr);
}

// ---------------------------------------------------------------------------
// 拼接
// ---------------------------------------------------------------------------

export interface VectorStitchOptions {
  /** MVT 瓦片 URL 模板（{z}-{x}-{y}.mvt 形式） */
  template: string;
  /** 内容缩放级别（整数，上层元素按此级别投影） */
  z: number;
  /** 视口左上角在 z 级世界像素坐标系下的坐标 */
  worldX0: number;
  worldY0: number;
  /** CSS 像素 / z 级世界像素 */
  cssPerWorld: number;
  /** 画布 CSS 像素宽高 */
  width: number;
  height: number;
  /** 设备像素比 */
  dpr: number;
  /** 数据源最大缩放级别（超出后放大低级别几何） */
  maxFetchZoom?: number;
  /** 背景色（缺失瓦片露出） */
  background: string;
  /** 底图抓取总时限（毫秒） */
  deadlineMs?: number;
  timeoutMs?: number;
}

/** 单次渲染抓取瓦片数上限 */
const MAX_TILES = 260;

/**
 * 拼接覆盖整个视口的矢量底图，返回 width×dpr × height×dpr 设备像素的离屏画布。
 */
export async function stitchVectorBasemap(options: VectorStitchOptions): Promise<Canvas> {
  const {
    template,
    z,
    worldX0,
    worldY0,
    cssPerWorld,
    width,
    height,
    dpr,
    maxFetchZoom,
    background,
    deadlineMs = 8000,
    timeoutMs = 5000
  } = options;

  const canvas = createCanvas(Math.round(width * dpr), Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!template) return canvas;

  // 矢量瓦片无需超采样：内容缩放级别即抓取级别（受数据源上限约束）
  const zf = Math.max(2, Math.min(z, maxFetchZoom ?? z));
  const scale = (cssPerWorld * dpr) / 2 ** (zf - z); // 设备像素 / zf 级世界像素
  const viewX0z = worldX0 * 2 ** (zf - z);
  const viewY0z = worldY0 * 2 ** (zf - z);

  // 瓦片数量保护：过多时降低抓取级别
  const countAt = (zoom: number) => {
    const fp = (256 * (cssPerWorld * dpr)) / 2 ** (zoom - z);
    return (Math.ceil(canvas.width / fp) + 1) * (Math.ceil(canvas.height / fp) + 1);
  };
  let fetchZoom = zf;
  while (fetchZoom > Math.max(2, z) && countAt(fetchZoom) > MAX_TILES) fetchZoom -= 1;

  // 宽度插值使用的等效级别：几何随 f×dpr 拉伸时宽度同步平滑增长
  const zEff = fetchZoom + Math.log2(Math.max(0.6, Math.min(3, cssPerWorld * dpr)));

  const tx0 = Math.floor(viewX0z / 256);
  const ty0 = Math.floor(viewY0z / 256);
  const tx1 = Math.floor((viewX0z + canvas.width / scale) / 256);
  const ty1 = Math.floor((viewY0z + canvas.height / scale) / 256);

  const jobs: Promise<void>[] = [];
  const startedAt = Date.now();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const draw = async () => {
        if (Date.now() - startedAt > deadlineMs) return;
        const buffer = await getTile(
          expandTileTemplate(template, tx, ty, fetchZoom),
          timeoutMs,
          'data'
        );
        if (!buffer) return;
        const px = Math.round((tx * 256 - viewX0z) * scale);
        const px1 = Math.round(((tx + 1) * 256 - viewX0z) * scale);
        const py = Math.round((ty * 256 - viewY0z) * scale);
        // Mercator 瓦片为正方形，纵向尺寸与横向一致
        drawVectorTile(ctx, buffer, px, py, px1 - px, zEff, dpr);
      };
      jobs.push(draw());
    }
  }
  await Promise.all(jobs);
  return canvas;
}
