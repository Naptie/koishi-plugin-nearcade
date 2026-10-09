/**
 * 发现结果地图渲染器：将 /discover 接口返回的机厅列表渲染为一张
 * 带碰撞感知标签的静态地图图片。
 *
 * 图层自下而上：底图瓦片（设备像素级超采样）→ 搜索半径圈 → 地铁步行/乘车线
 * → 地铁站 → 引线 → 机厅编号徽标 → 原点 → 站点/机厅标签（贪心多锚点避让，
 * 密集区域自动退避到带引线的远距候选）→ 标题栏 / 比例尺 / 归属信息。
 *
 * 编号仅出现在机厅圆徽上，与文本列表一一对应；标签只承载名称/线路/在勤人数。
 */

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import type { DiscoverResponse, MetroLineBadge } from '../types';
import { radiusTravelTime } from '../utils';
import { cssFont, ensureFont, FALLBACK_FAMILY, type FontSpec } from '../font';
import { TILE_SIZE, lngToWorldX, latToWorldY, metersPerPixel } from './geo';
import { stitchBasemap } from './basemap';
import { isMvtTemplate, stitchVectorBasemap } from './vector';
import {
  edgePoint,
  findPlacement,
  nudgeOverlaps,
  type Anchor,
  type Rect,
  type ViewportBounds
} from './place';

const REF_ZOOM = 22;

const AMAP_MAX_ZOOM = 18;

/** 高德亮色瓦片的暗色化滤镜（近似 amap://styles/dark 的观感） */
export const AMAP_DARK_FILTER = 'invert(0.95) hue-rotate(180deg) saturate(0.35) brightness(0.95)';

const DEFAULT_FONT_FAMILY = FALLBACK_FAMILY;

/** 单个地区的底图配置 */
export interface RegionBasemap {
  /** 底图瓦片 URL 模板（{x} {y} {z} {s}），含 .mvt 时按矢量渲染 */
  tileUrl?: string;
  /** 底图归属说明 */
  attribution?: string;
}

export interface MapRenderOptions {
  /** 画布宽度（CSS 像素），默认 1200 */
  width?: number;
  /** 按国家/地区代码解析的底图配置；键 * 匹配其余地区，未匹配则不渲染底图 */
  basemaps?: Record<string, RegionBasemap>;
  /** 瓦片服务的最大缩放级别，超出后放大低级别瓦片（Esri Canvas 系列为 16） */
  tileMaxZoom?: number;
  /** 瓦片源文件原始边长（256 标准；512 高清瓦片如高德 scl=2） */
  tileSize?: number;
  /** 底图不透明度（0-1），降低底图视觉干扰，默认 1 */
  basemapOpacity?: number;
  /** 底图 CSS filter：留空时对亮色栅格瓦片（如高德）自动应用暗色滤镜，
   *  'none' 关闭滤镜，其他值作为自定义滤镜（暗色瓦片自动跳过） */
  basemapFilter?: string;
  /** 额外注册的字体文件/目录路径（多个用 ; 分隔；缺少中文字体时设置） */
  fontPath?: string;
  /** CSS font-family 字体栈 */
  fontFamily?: string;
  /** 机厅名称最大字符数（硬性上限；标签优先完整显示，放不下时自适应截短） */
  maxLabelChars?: number;
  /** 是否绘制地铁站 → 机厅的步行虚线 */
  walkLines?: boolean;
}

interface MapShop {
  index: number;
  id: number;
  lng: number;
  lat: number;
  name: string;
  attendance: number;
  lines: MetroLineBadge[];
  stationId: string | null;
  stationName: string | null;
}

interface MapStation {
  id: string;
  lng: number;
  lat: number;
  name: string;
  lines: Set<string>;
}

// ---------------------------------------------------------------------------
// 暗色主题设计变量
// ---------------------------------------------------------------------------

const PANEL_BG = 'rgba(9, 14, 24, 0.88)';
const PANEL_BG_DIM = 'rgba(9, 14, 24, 0.8)';
const PANEL_BORDER = 'rgba(148, 163, 184, 0.3)';
const ACCENT = '#38bdf8';
const INK = '#f1f5f9';
const SUBTLE = '#94a3b8';
const SHADOW = 'rgba(0, 0, 0, 0.5)';

function roundRectPath(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 以 ink 包围盒垂直居中绘制文本（CJK 与拉丁混排时依然视觉居中） */
function fillTextCentered(
  ctx: SKRSContext2D,
  text: string,
  x: number,
  y: number,
  align: CanvasTextAlign = 'left'
) {
  const m = ctx.measureText(text);
  const baseline = y + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  ctx.textAlign = align;
  ctx.fillText(text, x, baseline);
}

function badgeTextColor(hex: string | null | undefined): string {
  if (!hex) return '#ffffff';
  const m = hex.replace('#', '');
  if (!/^[0-9a-fA-F]{6}$/.test(m)) return '#ffffff';
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.62 ? '#111827' : '#ffffff';
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

/** 截断文本至指定渲染宽度（以当前 ctx.font 度量），拉丁与 CJK 一视同仁 */
function truncateToWidth(ctx: SKRSContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  const chars = [...text];
  let lo = 1;
  let hi = chars.length - 1;
  let best = 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= maxWidth) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, best).join('') + '…';
}

export async function renderDiscoverMap(
  result: DiscoverResponse,
  options: MapRenderOptions = {}
): Promise<Buffer> {
  const {
    width: W = 1200,
    basemaps,
    tileMaxZoom = AMAP_MAX_ZOOM,
    tileSize,
    basemapOpacity = 1,
    basemapFilter,
    fontPath,
    fontFamily = DEFAULT_FONT_FAMILY,
    maxLabelChars = 40,
    walkLines = true
  } = options;

  // 以机厅行政区划（region 首元素）的国家/地区代码解析底图配置：
  // 精确匹配 → 通配符 * → 无底图。渲染器不内置任何地区或瓦片服务地址，
  // 默认底图（境内必应矢量、其余地区 Esri 暗色）由插件配置的默认值提供
  const countryId = result.shops.find((s) => s.address?.region?.length)?.address?.region?.[0]?.id;
  const regionKey = countryId?.trim().toUpperCase() || '';
  const basemapEntry =
    (regionKey &&
      Object.entries(basemaps ?? {}).find(([k]) => k.trim().toUpperCase() === regionKey)?.[1]) ||
    basemaps?.['*'];
  const effectiveTileUrl = basemapEntry?.tileUrl;
  const effectiveAttribution = basemapEntry?.attribution;
  // 矢量瓦片（.mvt 模板）自带暗色风格且无需滤镜；暗色滤镜仅作用于亮色
  // 栅格瓦片（地址含 scl=2 的高德高清瓦片自动按 512px 处理，地址含
  // dark/gray/night 等字样的暗色瓦片自动跳过滤镜）
  const vectorTiles = !!effectiveTileUrl && isMvtTemplate(effectiveTileUrl);
  const darkTiles = !!effectiveTileUrl && /dark|gray|grey|night/i.test(effectiveTileUrl);
  const effectiveTileSize = tileSize ?? (/scl=2/i.test(effectiveTileUrl ?? '') ? 512 : 256);
  const effectiveMaxZoom =
    effectiveTileUrl && /arcgisonline\.com.*\/Canvas\//i.test(effectiveTileUrl)
      ? Math.min(tileMaxZoom, 16)
      : tileMaxZoom;
  const effectiveFilter =
    vectorTiles || darkTiles || basemapFilter === 'none'
      ? undefined
      : basemapFilter || AMAP_DARK_FILTER;
  // 缺失瓦片露出的底色随底图配色而定：矢量暗色 ≈ #2a2a2a，Esri 暗灰与
  // 其他暗色瓦片 ≈ #262626，暗色化亮色瓦片 ≈ #131318，未加滤镜的亮色瓦片 ≈ #e9edf0
  const basemapBg = vectorTiles
    ? '#2a2a2a'
    : !effectiveTileUrl || darkTiles
      ? '#262626'
      : effectiveFilter
        ? '#131318'
        : '#e9edf0';

  ensureFont(fontPath);
  // 与帮助图片共用 cssFont：族优先级与字重解析保持一致
  const fontSpec: FontSpec = { family: fontFamily, fontPath };
  const font = (weight: number | string, size: number) => cssFont(weight, size, fontSpec);

  // ------------------------------------------------------------------
  // 数据准备
  // ------------------------------------------------------------------
  const originRaw = result.location;
  const originLng = originRaw.longitude;
  const originLat = originRaw.latitude;

  const haversineKm = (lng1: number, lat1: number, lng2: number, lat2: number) => {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLng = (lng2 - lng1) * rad;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  };

  const metro = result.metro;

  // 过滤离群机厅：搜索范围是「距离半径 + 地铁通行时间」双重限制，
  // 地铁可达的机厅可以出现在半径之外；但个别店铺的 transit 记录指向
  // 错误的车站（数百公里外的店铺记录着原点附近车站），其行程耗时严重
  // 失真。超出合理可达范围的机厅不参与绘图与取景（文本列表仍完整展示，
  // 编号保持一致）
  const viewCutoffKm = Math.max((result.radius || 10) * 3.5, 25);

  const shops: MapShop[] = [];
  result.shops.forEach((shop, i) => {
    const coords = shop.location?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return;
    const [lng, lat] = [coords[0], coords[1]];
    if (haversineKm(originLng, originLat, lng, lat) > viewCutoffKm) return;
    const metroTransit = shop.transit?.metro;
    const stationId = metroTransit?.stationId ?? null;
    shops.push({
      index: i + 1,
      id: shop.id,
      lng,
      lat,
      name: shop.name,
      attendance: shop.totalAttendance ?? 0,
      lines: metroTransit?.lines?.slice(0, 4) ?? [],
      stationId,
      stationName: metroTransit?.stationName ?? null
    });
  });
  if (!shops.length) throw new Error('no shops to render');

  const stations: Map<string, MapStation> = new Map();
  const addStation = (id: string) => {
    if (stations.has(id)) return stations.get(id)!;
    const station = metro?.stations?.[id];
    if (!station || Array.isArray(station) || typeof station.lon !== 'number') return null;
    const [lng, lat] = [station.lon, station.lat];
    const entry: MapStation = { id, lng, lat, name: station.name, lines: new Set() };
    stations.set(id, entry);
    return entry;
  };
  if (metro?.origin) addStation(metro.origin.stationId);

  // 地铁乘车线段去重集合：lineId + 站点序列（仅取画面内机厅的行程）
  const rideLegs = new Map<string, { color: string; stationIds: string[] }>();
  const transferLegs = new Map<string, string[]>();
  if (metro) {
    for (const shop of shops) {
      const itinerary = metro.shops?.[String(shop.id)];
      for (const leg of itinerary?.legs ?? []) {
        if (!leg.stationIds?.length) continue;
        if (leg.kind === 'transfer') {
          const key = leg.stationIds.join('>');
          if (!transferLegs.has(key)) transferLegs.set(key, leg.stationIds);
        } else {
          const line = leg.lineId ? metro.lines?.[leg.lineId] : undefined;
          const color = line?.color || '#5b6b7c';
          const key = `${leg.lineId ?? ''}:${leg.stationIds.join('>')}`;
          if (!rideLegs.has(key)) rideLegs.set(key, { color, stationIds: leg.stationIds });
        }
        if (leg.lineId) {
          for (const sid of leg.stationIds) {
            addStation(sid)?.lines.add(leg.lineId);
          }
        }
      }
      if (shop.stationId) addStation(shop.stationId);
    }
  }

  // ------------------------------------------------------------------
  // 投影：以 REF_ZOOM 世界像素计算跨度，推导缩放级别
  // ------------------------------------------------------------------
  const pointsForBBox: { x: number; y: number }[] = [
    { x: lngToWorldX(originLng, REF_ZOOM), y: latToWorldY(originLat, REF_ZOOM) },
    ...shops.map((s) => ({ x: lngToWorldX(s.lng, REF_ZOOM), y: latToWorldY(s.lat, REF_ZOOM) })),
    ...[...stations.values()].map((s) => ({
      x: lngToWorldX(s.lng, REF_ZOOM),
      y: latToWorldY(s.lat, REF_ZOOM)
    }))
  ];
  const xs = pointsForBBox.map((p) => p.x);
  const ys = pointsForBBox.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  const centerLat = originLat;
  const metersPerWorldPxRef = metersPerPixel(centerLat, REF_ZOOM);
  // 跨度过小时强制最小约 600 米，避免同址机厅导致缩放爆表
  const minSpanPx = 600 / metersPerWorldPxRef;
  maxX = Math.max(maxX, minX + minSpanPx);
  maxY = Math.max(maxY, minY + minSpanPx);

  // 四周各留 12% 边距
  const padX = (maxX - minX) * 0.12;
  const padY = (maxY - minY) * 0.12;
  minX -= padX;
  maxX += padX;
  minY -= padY;
  maxY += padY;

  const spanX22 = maxX - minX;
  const spanY22 = maxY - minY;

  // 缩放：完整容纳两个维度；高度超出上限时按高度收缩比例，
  // 视野向左右扩展（而非裁切，避免边缘机厅被推出画布）
  const MAX_H = 1500;
  const k = Math.min(W / spanX22, MAX_H / spanY22); // CSS 像素 / REF_ZOOM 世界像素
  const H = Math.max(480, Math.round(spanY22 * k));

  // 缩放级别：先算理论最优，再取整
  const zOpt = REF_ZOOM + Math.log2(k);
  let zInt = Math.max(3, Math.min(18, Math.round(zOpt)));
  // 瓦片数量上限保护（约 14×14）
  let f = 0; // CSS 像素 / z 级世界像素
  for (let guard = 0; guard < 8; guard++) {
    f = k * 2 ** (REF_ZOOM - zInt);
    const tilesX = W / (TILE_SIZE * f) + 2;
    const tilesY = H / (TILE_SIZE * f) + 2;
    if (tilesX * tilesY <= 200 || zInt <= 3) break;
    zInt -= 1;
  }

  const offX = (W - spanX22 * k) / 2;
  const offY = (H - spanY22 * k) / 2;
  const leftZ = minX * 2 ** (zInt - REF_ZOOM);
  const topZ = minY * 2 ** (zInt - REF_ZOOM);
  const viewX0 = leftZ - offX / f;
  const viewY0 = topZ - offY / f;

  const project = (lng: number, lat: number): { x: number; y: number } => ({
    x: (lngToWorldX(lng, zInt) - viewX0) * f,
    y: (latToWorldY(lat, zInt) - viewY0) * f
  });

  const metersPerCssPx = metersPerPixel(centerLat, zInt) / f;

  // ------------------------------------------------------------------
  // 画布与底图（底图以设备分辨率拼接后 1:1 绘制，保证清晰度）
  // ------------------------------------------------------------------
  const dpr = 2;
  const canvas = createCanvas(W * dpr, H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const basemap = effectiveTileUrl
    ? vectorTiles
      ? await stitchVectorBasemap({
          template: effectiveTileUrl,
          z: zInt,
          worldX0: viewX0,
          worldY0: viewY0,
          cssPerWorld: f,
          width: W,
          height: H,
          dpr,
          maxFetchZoom: effectiveMaxZoom,
          background: basemapBg
        })
      : await stitchBasemap({
          template: effectiveTileUrl,
          z: zInt,
          worldX0: viewX0,
          worldY0: viewY0,
          cssPerWorld: f,
          width: W,
          height: H,
          dpr,
          tileSize: effectiveTileSize,
          maxFetchZoom: effectiveMaxZoom,
          background: basemapBg,
          filter: effectiveFilter
        })
    : null;
  if (basemap) {
    ctx.save();
    ctx.globalAlpha = basemapOpacity;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(basemap, 0, 0);
    ctx.restore();
  }
  // 滤镜/透明度组合可能产生半透明像素，整体压平为不透明画布，
  // 避免聊天客户端深色模式下底图透出
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = basemapBg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();

  // ------------------------------------------------------------------
  // 图层绘制
  // ------------------------------------------------------------------
  const originPt = project(originLng, originLat);

  // 搜索半径圈
  const radiusPx = (result.radius * 1000) / metersPerCssPx;
  if (radiusPx > 16) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(originPt.x, originPt.y, radiusPx, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.06)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.6)';
    ctx.lineWidth = 1.8;
    ctx.setLineDash([7, 7]);
    ctx.stroke();
    ctx.restore();
  }

  const strokePolyline = (pts: { x: number; y: number }[], paint: () => void) => {
    if (pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    paint();
  };

  const legPoints = (stationIds: string[]) =>
    stationIds
      .map((id) => stations.get(id))
      .filter((s): s is MapStation => !!s)
      .map((s) => project(s.lng, s.lat));

  // 站 → 机厅 步行虚线（最底层）
  if (walkLines && metro) {
    ctx.save();
    ctx.globalAlpha = 0.75;
    for (const shop of shops) {
      const station = shop.stationId ? stations.get(shop.stationId) : null;
      if (!station) continue;
      const pts = [project(station.lng, station.lat), project(shop.lng, shop.lat)];
      strokePolyline(pts, () => {
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
      });
    }
    ctx.restore();
  }

  // 原点 → 原点站 步行虚线
  if (metro?.origin) {
    const originStation = stations.get(metro.origin.stationId);
    if (originStation) {
      const pts = [originPt, project(originStation.lng, originStation.lat)];
      strokePolyline(pts, () => {
        ctx.strokeStyle = 'rgba(241, 245, 249, 0.85)';
        ctx.lineWidth = 3.5;
        ctx.setLineDash([5, 4]);
        ctx.stroke();
      });
    }
  }

  // 地铁乘车线（浅色包边 + 官方线路色，暗色底图上高突出）
  if (metro) {
    for (const leg of rideLegs.values()) {
      const pts = legPoints(leg.stationIds);
      strokePolyline(pts, () => {
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.92)';
        ctx.lineWidth = 7;
        ctx.setLineDash([]);
        ctx.stroke();
      });
    }
    for (const leg of rideLegs.values()) {
      const pts = legPoints(leg.stationIds);
      strokePolyline(pts, () => {
        ctx.strokeStyle = leg.color;
        ctx.lineWidth = 4.2;
        ctx.setLineDash([]);
        ctx.stroke();
      });
    }
    // 换乘步行段
    for (const stationIds of transferLegs.values()) {
      const pts = legPoints(stationIds);
      strokePolyline(pts, () => {
        ctx.strokeStyle = 'rgba(248, 250, 252, 0.9)';
        ctx.lineWidth = 5;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.strokeStyle = '#cbd5e1';
        ctx.lineWidth = 2.6;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
      });
    }
  }

  // 地铁站圆点
  for (const station of stations.values()) {
    const pt = project(station.lng, station.lat);
    const interchange = station.lines.size >= 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, interchange ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = interchange ? 2.4 : 1.8;
    ctx.stroke();
    ctx.restore();
  }

  // 机厅标记（编号圆徽），过近时确定性微移；紧贴原点十字标的
  // 徽标沿径向推开，避免被十字标遮挡
  const markerPts = shops.map((s) => project(s.lng, s.lat));
  nudgeOverlaps(markerPts, 24);
  for (const pt of markerPts) {
    const dist = Math.hypot(pt.x - originPt.x, pt.y - originPt.y);
    if (dist < 18) {
      if (dist < 0.01) {
        pt.x += 18;
      } else {
        pt.x = originPt.x + ((pt.x - originPt.x) / dist) * 18;
        pt.y = originPt.y + ((pt.y - originPt.y) / dist) * 18;
      }
    }
  }

  // ------------------------------------------------------------------
  // 标签放置（碰撞感知 + 引线退避）
  // ------------------------------------------------------------------
  const placed: Rect[] = [];
  const stationRects: Rect[] = [];
  const bounds: ViewportBounds = { x: 4, y: 4, w: W - 8, h: H - 8 };

  // 标题栏
  const sumAttendance = shops.reduce((sum, s) => sum + s.attendance, 0);
  const headerAccent = result.location.name ? `「${result.location.name}」` : '';
  const headerRest = `周边 ${result.radius} 千米 · ${radiusTravelTime(result.radius)}内 · ${shops.length} 家机厅${
    sumAttendance > 0 ? ` · 在勤 ${sumAttendance} 人` : ''
  }`;
  ctx.font = font(600, 13);
  const headerW = ctx.measureText(headerAccent + headerRest).width + 24;
  const headerRect: Rect = { x: 10, y: 10, w: headerW, h: 30 };

  // 底部信息条
  ctx.font = font(400, 10.5);
  const attributionText = [effectiveAttribution && `底图 ${effectiveAttribution}`, '数据 nearcade']
    .filter(Boolean)
    .join(' · ');
  const footerW = ctx.measureText(attributionText).width + 16;
  const footerRect: Rect = { x: 10, y: H - 30, w: footerW, h: 20 };

  // 比例尺（右下）
  const scaleBar = (() => {
    const targetPx = 110;
    const targetMeters = targetPx * metersPerCssPx;
    const mag = 10 ** Math.floor(Math.log10(targetMeters));
    const candidates = [1, 2, 5, 10].map((m) => m * mag);
    const best = candidates.reduce((a, b) =>
      Math.abs(b / metersPerCssPx - targetPx) < Math.abs(a / metersPerCssPx - targetPx) ? b : a
    );
    const px = best / metersPerCssPx;
    const label = best >= 1000 ? `${best / 1000} km` : `${best} m`;
    return { px, label };
  })();
  ctx.font = font(500, 10.5);
  const scaleW = Math.max(scaleBar.px, ctx.measureText(scaleBar.label).width + 6) + 18;
  const scaleRect: Rect = { x: W - scaleW - 10, y: H - 30, w: scaleW, h: 20 };

  const panelKeepOut: Rect[] = [
    headerRect,
    footerRect,
    scaleRect,
    {
      x: originPt.x - 17,
      y: originPt.y - 17,
      w: 34,
      h: 34
    }
  ];
  // 机厅编号徽标保留区：任何标签都不应遮挡其他徽标
  const badgeKeepOut: Rect[] = markerPts.map((p) => ({ x: p.x - 12, y: p.y - 12, w: 24, h: 24 }));
  const stationDotKeepOut: Rect[] = [...stations.values()].map((s) => {
    const pt = project(s.lng, s.lat);
    return { x: pt.x - 7, y: pt.y - 7, w: 14, h: 14 };
  });

  interface LabelPlacement {
    rect: Rect;
    leader: { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  }
  interface ChipData {
    text: string;
    color: string;
    textColor: string;
    w: number;
  }
  const stationLabels: { station: MapStation; label: string; placement: LabelPlacement }[] = [];
  const shopLabels: {
    shop: MapShop;
    pt: { x: number; y: number };
    placement: LabelPlacement;
    name: string;
    chipList: ChipData[];
  }[] = [];

  const chipFont = font(700, 9.5);
  const chipsOf = (shop: MapShop): ChipData[] => {
    ctx.font = chipFont;
    return shop.lines.map((line) => {
      const text = line.shortName || line.name;
      return {
        text,
        color: line.color || '#64748b',
        textColor: badgeTextColor(line.color),
        w: Math.max(14, ctx.measureText(text).width + 7)
      };
    });
  };
  const measurePill = (name: string, chipList: ChipData[], attText: string) => {
    ctx.font = font(600, 13);
    const nameW = ctx.measureText(name).width;
    let attW = 0;
    if (attText) {
      ctx.font = font(600, 11);
      attW = ctx.measureText(attText).width;
    }
    const chipsW = chipList.length ? chipList.reduce((sum, c) => sum + c.w + 2.5, 0) - 2.5 : 0;
    return {
      w: 9 + nameW + (chipList.length ? chipsW + 7 : 0) + (attText ? attW + 7 : 0) + 9,
      h: 24
    };
  };

  const drawLeader = (leader: LabelPlacement['leader']) => {
    if (!leader) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    ctx.lineWidth = 2.8;
    ctx.beginPath();
    ctx.moveTo(leader.from.x, leader.from.y);
    ctx.lineTo(leader.to.x, leader.to.y);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(241, 245, 249, 0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  };

  // 每个标签都与编号徽标以细线相连（贴身候选为短短的连接须，
  // 远距候选为完整引线），保证密集区域中标签与徽标的对应关系一目了然
  const withConnector = (
    pt: { x: number; y: number },
    placement: { rect: Rect; leader: LabelPlacement['leader'] }
  ): LabelPlacement => ({
    rect: placement.rect,
    leader: placement.leader ?? { from: pt, to: edgePoint(placement.rect, pt) }
  });

  // 站点标签（先放置，作为机厅标签的参照物）
  const stationOrder = [...stations.values()].sort((a, b) => {
    if (a.id === metro?.origin?.stationId) return -1;
    if (b.id === metro?.origin?.stationId) return 1;
    if (b.lines.size !== a.lines.size) return b.lines.size - a.lines.size;
    return 0;
  });
  for (const station of stationOrder) {
    // 站名通常很短：以宽度为界自适应，仅在超宽时截短
    ctx.font = font(500, 10.5);
    const label = truncateToWidth(ctx, station.name, 160);
    const size = { w: ctx.measureText(label).width + 14, h: 19 };
    const pt = project(station.lng, station.lat);
    const hit = findPlacement({
      point: pt,
      size,
      anchors: [
        'bottom',
        'right',
        'top',
        'left',
        'bottom-right',
        'top-right',
        'bottom-left',
        'top-left'
      ],
      gaps: [11, 24, 38],
      padding: 2,
      placed,
      keepOut: [...panelKeepOut, ...badgeKeepOut, ...stationDotKeepOut],
      bounds
    });
    if (!hit) continue;
    placed.push(hit.rect);
    stationRects.push(hit.rect);
    stationLabels.push({
      station,
      label,
      placement: withConnector(pt, { rect: hit.rect, leader: hit.leader })
    });
  }

  // 机厅标签：按在勤人数优先（密集区域中繁忙机厅优先获得近距标签）。
  // 长度优先的自适应：先以完整名称尝试全部候选环，全部放不下时才逐级
  // 截短（→150px →112px 并省略线路徽章），杜绝「空间充足仍显示省略号」；
  // 每个标签均以细线与徽标相连
  const ANCHORS: Anchor[] = [
    'right',
    'left',
    'bottom',
    'top',
    'bottom-right',
    'bottom-left',
    'top-right',
    'top-left'
  ];
  const ANCHORS_EXTENDED: Anchor[] = [
    ...ANCHORS,
    'ene',
    'wnw',
    'sse',
    'nnw',
    'ese',
    'wsw',
    'nne',
    'ssw'
  ];
  // 首环双档：先留出一线间距以绘制连接须，放不下时回退贴身档（以紧贴表达关联），
  // 其余环为引线退避距离
  const GAPS = [16, 13, 27, 42, 58, 76];
  const debug = process.env.NEARCADE_MAP_DEBUG === '1';
  const shopOrder = shops
    .map((shop, i) => ({ shop, i, pt: markerPts[i] }))
    .sort((a, b) => b.shop.attendance - a.shop.attendance || a.shop.index - b.shop.index);
  for (const { shop, i, pt } of shopOrder) {
    const chips = chipsOf(shop);
    const attText = shop.attendance > 0 ? `${shop.attendance} 人` : '';
    ctx.font = font(600, 13);
    const names = [
      truncate(truncateToWidth(ctx, shop.name, 300), maxLabelChars),
      truncateToWidth(ctx, shop.name, 150),
      truncateToWidth(ctx, shop.name, 112)
    ];
    let chosen: {
      rect: Rect;
      leader: LabelPlacement['leader'];
      name: string;
      chipList: ChipData[];
      ring: number;
      anchor: Anchor;
      variant: number;
    } | null = null;
    for (const vi of [0, 1, 2]) {
      // 与上一档完全相同的候选直接跳过
      if (vi === 1 && names[1] === names[0]) continue;
      if (vi === 2 && names[2] === names[1] && chips.length === 0) continue;
      const name = names[vi];
      const chipList = vi === 2 ? [] : chips;
      for (const [ring, gap] of GAPS.entries()) {
        const anchorSet = ring <= 1 ? ANCHORS : ANCHORS_EXTENDED;
        const hit = findPlacement({
          point: pt,
          size: measurePill(name, chipList, attText),
          anchors: anchorSet,
          gaps: [gap],
          leaderAfterGap: GAPS[0],
          padding: 2,
          placed,
          // 站点圆点允许被机厅标签覆盖（站名胶囊仍在 placed 中保护），
          // 密集城区中站点圆点过多，否则标签无立足之地
          keepOut: [...panelKeepOut, ...badgeKeepOut.filter((_, j) => j !== i)],
          bounds,
          debug:
            debug && shop.index === 3
              ? (reason) => console.warn(`  #3 v${vi} ${reason}`)
              : undefined
        });
        if (hit) {
          chosen = {
            rect: hit.rect,
            leader: hit.leader,
            name,
            chipList,
            ring,
            anchor: hit.anchor,
            variant: vi
          };
          break;
        }
      }
      if (chosen) break;
    }
    if (debug) {
      console.warn(
        `#${shop.index} ${shop.name} → ${
          chosen ? `ring=${chosen.ring} anchor=${chosen.anchor} variant=${chosen.variant}` : 'FAIL'
        }`
      );
    }
    if (!chosen) continue;
    placed.push(chosen.rect);
    shopLabels.push({
      shop,
      pt,
      placement: withConnector(pt, { rect: chosen.rect, leader: chosen.leader }),
      name: chosen.name,
      chipList: chosen.chipList
    });
  }

  // 兜底：常规候选全部失败的机厅（多为密集城区核心），放宽为允许覆盖
  // 站名胶囊与站点圆点等次级元素，但仍不遮挡编号徽标、面板与其他机厅标签；
  // 同样长度优先并允许更长的引线，保证「有徽标必有名称」
  const LAX_GAPS = [...GAPS, 100, 130];
  const laxPlaced = placed.filter((r) => !stationRects.includes(r));
  for (const { shop, i, pt } of shopOrder) {
    if (shopLabels.some((l) => l.shop === shop)) continue;
    const chips = chipsOf(shop);
    const attText = shop.attendance > 0 ? `${shop.attendance} 人` : '';
    ctx.font = font(600, 13);
    const names = [
      truncate(truncateToWidth(ctx, shop.name, 300), maxLabelChars),
      truncateToWidth(ctx, shop.name, 150),
      truncateToWidth(ctx, shop.name, 112)
    ];
    let chosen: {
      rect: Rect;
      leader: LabelPlacement['leader'];
      name: string;
      chipList: ChipData[];
    } | null = null;
    for (const vi of [0, 1, 2]) {
      if (vi === 1 && names[1] === names[0]) continue;
      if (vi === 2 && names[2] === names[1] && chips.length === 0) continue;
      const chipList = vi === 2 ? [] : chips;
      for (const gap of LAX_GAPS) {
        const hit = findPlacement({
          point: pt,
          size: measurePill(names[vi], chipList, attText),
          anchors: ANCHORS_EXTENDED,
          gaps: [gap],
          leaderAfterGap: GAPS[0],
          padding: 0,
          placed: laxPlaced,
          keepOut: [...panelKeepOut, ...badgeKeepOut.filter((_, j) => j !== i)],
          bounds
        });
        if (hit) {
          chosen = {
            rect: hit.rect,
            leader: hit.leader,
            name: names[vi],
            chipList
          };
          break;
        }
      }
      if (chosen) break;
    }
    if (debug) {
      console.warn(
        `#${shop.index} ${shop.name} → 兜底 ${chosen ? `gap=${chosen.rect.x},${chosen.rect.y}` : 'FAIL'}`
      );
    }
    if (!chosen) continue;
    laxPlaced.push(chosen.rect);
    shopLabels.push({
      shop,
      pt,
      placement: withConnector(pt, { rect: chosen.rect, leader: chosen.leader }),
      name: chosen.name,
      chipList: chosen.chipList
    });
  }

  // ------------------------------------------------------------------
  // 绘制：引线 → 徽标 → 原点 → 标签 → 面板
  // ------------------------------------------------------------------
  for (const { placement } of stationLabels) drawLeader(placement.leader);
  for (const { placement } of shopLabels) drawLeader(placement.leader);

  // 机厅编号圆徽（编号仅出现于此，与文本列表对应）
  shops.forEach((shop, i) => {
    const pt = markerPts[i];
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1.5;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(2, 6, 23, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.font = font(700, 11);
    ctx.fillStyle = '#0f172a';
    fillTextCentered(ctx, String(shop.index), pt.x, pt.y, 'center');
    ctx.restore();
  });

  // 原点十字标（绘制在机厅标记之上，保证在密集区域内可见）
  {
    const { x, y } = originPt;
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 1.5;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.moveTo(x - 14, y);
    ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x, y + 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(x - 14, y);
    ctx.lineTo(x + 14, y);
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x, y + 14);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fillStyle = ACCENT;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fillStyle = '#f8fafc';
    ctx.fill();
    ctx.restore();
  }

  // 站点标签（暗色小胶囊）
  for (const { label, placement } of stationLabels) {
    const { x, y, w, h } = placement.rect;
    ctx.save();
    roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = PANEL_BG_DIM;
    ctx.fill();
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = font(500, 10.5);
    ctx.fillStyle = '#cbd5e1';
    fillTextCentered(ctx, label, x + w / 2, y + h / 2, 'center');
    ctx.restore();
  }

  // 机厅标签（暗色胶囊：名称 + 线路徽章 + 在勤人数）
  for (const { shop, placement, name, chipList } of shopLabels) {
    const attText = shop.attendance > 0 ? `${shop.attendance} 人` : '';
    const chips = chipList;

    const { x, y, w, h } = placement.rect;
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.fillStyle = PANEL_BG;
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRectPath(ctx, x, y, w, h, h / 2);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    let cx = x + 9;
    const cy = y + h / 2;
    ctx.font = font(600, 13);
    ctx.fillStyle = '#f8fafc';
    fillTextCentered(ctx, name, cx, cy);
    cx += ctx.measureText(name).width;
    if (chips.length) {
      cx += 7;
      for (const chip of chips) {
        roundRectPath(ctx, cx, cy - 7.5, chip.w, 15, 4.5);
        ctx.fillStyle = chip.color;
        ctx.fill();
        ctx.font = chipFont;
        ctx.fillStyle = chip.textColor;
        fillTextCentered(ctx, chip.text, cx + chip.w / 2, cy, 'center');
        cx += chip.w + 2.5;
      }
      cx += 4.5;
    } else if (attText) {
      cx += 7;
    }
    if (attText) {
      ctx.font = font(600, 11);
      ctx.fillStyle = '#fbbf24';
      fillTextCentered(ctx, attText, cx, cy);
    }
  }

  // ------------------------------------------------------------------
  // 标题栏 / 底部信息 / 比例尺（暗色面板）
  // ------------------------------------------------------------------
  const drawPanel = (rect: Rect, radius = rect.h / 2) => {
    ctx.save();
    ctx.shadowColor = SHADOW;
    ctx.shadowBlur = 6;
    ctx.shadowOffsetY = 2;
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.fillStyle = PANEL_BG;
    ctx.fill();
    ctx.restore();
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, radius);
    ctx.strokeStyle = PANEL_BORDER;
    ctx.lineWidth = 1;
    ctx.stroke();
  };

  drawPanel(headerRect);
  ctx.font = font(600, 13);
  let hx = headerRect.x + 12;
  const hcy = headerRect.y + headerRect.h / 2;
  if (headerAccent) {
    ctx.fillStyle = ACCENT;
    fillTextCentered(ctx, headerAccent, hx, hcy);
    hx += ctx.measureText(headerAccent).width;
  }
  ctx.fillStyle = INK;
  fillTextCentered(ctx, headerRest, hx, hcy);

  drawPanel(footerRect);
  ctx.font = font(400, 10.5);
  ctx.fillStyle = SUBTLE;
  fillTextCentered(ctx, attributionText, footerRect.x + 8, footerRect.y + footerRect.h / 2);

  drawPanel(scaleRect);
  ctx.save();
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1.5;
  const barY = scaleRect.y + scaleRect.h - 6.5;
  const barX0 = scaleRect.x + 9;
  const barX1 = barX0 + scaleBar.px;
  ctx.beginPath();
  ctx.moveTo(barX0, barY - 3);
  ctx.lineTo(barX0, barY);
  ctx.lineTo(barX1, barY);
  ctx.lineTo(barX1, barY - 3);
  ctx.stroke();
  ctx.font = font(500, 10.5);
  ctx.fillStyle = '#cbd5e1';
  fillTextCentered(ctx, scaleBar.label, barX0, barY - 7);
  ctx.restore();

  return canvas.encode('webp', 85);
}
