/**
 * Web Mercator 投影与瓦片数学。
 */

export const TILE_SIZE = 256;

export const MAX_LAT = 85.05112878;

export interface LngLat {
  lng: number;
  lat: number;
}

/** 经度 → 该缩放级别下世界像素 x */
export function lngToWorldX(lng: number, z: number): number {
  return ((lng + 180) / 360) * TILE_SIZE * 2 ** z;
}

/** 纬度 → 该缩放级别下世界像素 y（Web Mercator，纬度截断到 ±85.05°） */
export function latToWorldY(lat: number, z: number): number {
  const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE_SIZE * 2 ** z;
}

/** 该纬度、该缩放级别下每个瓦片像素对应的米数 */
export function metersPerPixel(lat: number, z: number): number {
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);
}
