/**
 * 碰撞感知的标签放置：为每个锚点 × 引线距离生成一组候选包围盒，
 * 按优先级贪心选择第一个与已放置标签、保留区域均不相交的位置。
 * 近距离候选全部冲突时退避到更远的环（绘制引线连接徽标与标签），
 * 使密集区域中的机厅也能获得标签。
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Anchor =
  | 'right'
  | 'left'
  | 'top'
  | 'bottom'
  | 'top-right'
  | 'top-left'
  | 'bottom-right'
  | 'bottom-left'
  // 扩展方向（远距候选使用，标签盒以中心对齐）
  | 'nne'
  | 'ene'
  | 'ese'
  | 'sse'
  | 'ssw'
  | 'wsw'
  | 'wnw'
  | 'nnw';

export interface ViewportBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Leader {
  from: { x: number; y: number };
  to: { x: number; y: number };
}

export interface Placement {
  rect: Rect;
  anchor: Anchor;
  /** 非首个环（远距候选）时的引线 */
  leader: Leader | null;
}

export function rectsIntersect(a: Rect, b: Rect, pad = 0): boolean {
  return (
    a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y
  );
}

/** 矩形上距离给定点最近的边缘点（引线终点） */
export function edgePoint(rect: Rect, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.min(Math.max(point.x, rect.x), rect.x + rect.w),
    y: Math.min(Math.max(point.y, rect.y), rect.y + rect.h)
  };
}

/** 相对锚点 (px, py) 按 anchor 方向偏移 gap 后包围盒的左上角 */
export function rectFor(
  px: number,
  py: number,
  size: { w: number; h: number },
  anchor: Anchor,
  gap: number
): Rect {
  let x: number;
  let y: number;
  switch (anchor) {
    case 'right':
      x = px + gap;
      y = py - size.h / 2;
      break;
    case 'left':
      x = px - gap - size.w;
      y = py - size.h / 2;
      break;
    case 'top':
      x = px - size.w / 2;
      y = py - gap - size.h;
      break;
    case 'bottom':
      x = px - size.w / 2;
      y = py + gap;
      break;
    case 'top-right':
      x = px + gap * 0.7;
      y = py - gap * 0.7 - size.h;
      break;
    case 'top-left':
      x = px - gap * 0.7 - size.w;
      y = py - gap * 0.7 - size.h;
      break;
    case 'bottom-right':
      x = px + gap * 0.7;
      y = py + gap * 0.7;
      break;
    case 'bottom-left':
      x = px - gap * 0.7 - size.w;
      y = py + gap * 0.7;
      break;
    default: {
      // 扩展方向：自正北顺时针每 45° 内插一个 22.5° 方向，标签盒中心对齐
      const angles: Record<string, [number, number]> = {
        nne: [0.3827, -0.9239],
        ene: [0.9239, -0.3827],
        ese: [0.9239, 0.3827],
        sse: [0.3827, 0.9239],
        ssw: [-0.3827, 0.9239],
        wsw: [-0.9239, 0.3827],
        wnw: [-0.9239, -0.3827],
        nnw: [-0.3827, -0.9239]
      };
      const [dx, dy] = angles[anchor] ?? [1, 0];
      x = px + dx * gap - size.w / 2;
      y = py + dy * gap - size.h / 2;
    }
  }
  return { x, y, w: size.w, h: size.h };
}

/** 将包围盒平移进画布边界；若完全放不下则返回 null */
export function clampRect(rect: Rect, bounds: ViewportBounds): Rect | null {
  const x = Math.max(bounds.x, Math.min(rect.x, bounds.x + bounds.w - rect.w));
  const y = Math.max(bounds.y, Math.min(rect.y, bounds.y + bounds.h - rect.h));
  if (rect.w > bounds.w || rect.h > bounds.h) return null;
  return { ...rect, x, y };
}

export interface PlacementOptions {
  point: { x: number; y: number };
  size: { w: number; h: number };
  anchors: Anchor[];
  /** 依次尝试的锚距，首个为贴身候选，其余距离绘制引线 */
  gaps: number[];
  /** 锚距超过该值时绘制引线（默认取 gaps[0]） */
  leaderAfterGap?: number;
  /** 与已放置矩形的额外间距 */
  padding: number;
  placed: Rect[];
  keepOut: Rect[];
  bounds: ViewportBounds;
  /** 调试：输出每个候选被拒绝的原因 */
  debug?: (reason: string) => void;
}

/**
 * 依候选顺序找到第一个不与 placed/keepOut 冲突且完整位于 bounds 内的位置。
 * 锚距大于 leaderAfterGap 时生成从锚点到标签盒边缘的引线。
 */
export function findPlacement({
  point,
  size,
  anchors,
  gaps,
  leaderAfterGap,
  padding,
  placed,
  keepOut,
  bounds,
  debug
}: PlacementOptions): Placement | null {
  const ordered = gaps.length ? gaps : [0];
  const leaderBeyond = leaderAfterGap ?? ordered[0];
  for (const gap of ordered) {
    for (const anchor of anchors) {
      const raw = rectFor(point.x, point.y, size, anchor, gap);
      const clamped = clampRect(raw, bounds);
      if (!clamped) {
        debug?.(`${anchor}@${gap}: 越界`);
        continue;
      }
      const blockedBy = keepOut.find((k) => rectsIntersect(clamped, k, 2));
      if (blockedBy) {
        debug?.(
          `${anchor}@${gap}: keepOut (${Math.round(blockedBy.x)},${Math.round(blockedBy.y)},${Math.round(blockedBy.w)},${Math.round(blockedBy.h)})`
        );
        continue;
      }
      const overlap = placed.find((p) => rectsIntersect(clamped, p, padding));
      if (overlap) {
        debug?.(
          `${anchor}@${gap}: placed (${Math.round(overlap.x)},${Math.round(overlap.y)},${Math.round(overlap.w)},${Math.round(overlap.h)})`
        );
        continue;
      }
      if (gap <= leaderBeyond) return { rect: clamped, anchor, leader: null };
      return {
        rect: clamped,
        anchor,
        leader: { from: { ...point }, to: edgePoint(clamped, point) }
      };
    }
  }
  return null;
}

/** 多个标记点彼此过近时进行确定性微移，避免完全重叠 */
export function nudgeOverlaps(points: { x: number; y: number }[], minDist: number): void {
  const offsets = [
    [minDist, 0],
    [-minDist, 0],
    [0, minDist],
    [0, -minDist],
    [minDist * 0.7, minDist * 0.7],
    [-minDist * 0.7, minDist * 0.7],
    [minDist * 0.7, -minDist * 0.7],
    [-minDist * 0.7, -minDist * 0.7]
  ];
  for (let i = 1; i < points.length; i++) {
    for (const [dx, dy] of offsets) {
      const candidate = { x: points[i].x + dx, y: points[i].y + dy };
      const clear = points.every(
        (p, j) => j >= i || Math.hypot(p.x - candidate.x, p.y - candidate.y) >= minDist
      );
      if (clear) {
        points[i] = candidate;
        break;
      }
    }
  }
}
