/**
 * 字体解析：帮助图片与地图渲染共用的唯一入口。
 *
 * 两张图都用同一套查找机制拼装 ctx.font：
 *
 *   `${weight} ${size}px ${familyStack}`
 *
 * - 字重以**数字**给出，而非靠族名里的 Heavy/Medium 字样。命中多字重字体时取
 *   对应字重；命中单字重字体（如服务器上仅装 Regular 的 Noto Sans CJK）时由
 *   Skia 合成伪粗体，两张图的粗细表现因此一致。
 * - 字体栈优先级固定：`fontPath` 自带字体（注册为 nearcade-map）→ 可选的展示
 *   字体族（如本机安装的 Glow Sans 变体）→ Sora/系统 CJK/无衬线回退链。
 * - 缺中文字体不再静默降级为豆腐块：hasCjkGlyphs 供插件在启动时告警。
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

/** fontPath 提供的字体统一注册到此族名，两张图都以它作为最高优先级 */
export const CUSTOM_FONT_ALIAS = 'nearcade-map';

/**
 * 公共回退链：内置 Sora 负责拉丁与数字，系统 CJK 负责汉字，sans-serif 兜底。
 * 帮助图片与地图共用，任何一张图缺字体时都退到同一处。
 */
export const FALLBACK_FAMILY =
  '"Sora", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans CN", "Source Han Sans SC", "Noto Sans SC", sans-serif';

/** 打包内置的 Sora 字体（与 nearcade.cn 一致），启动时静默注册 */
const VENDOR_FONT_DIR = join(__dirname, '..', 'assets', 'fonts');

/** 汉字探测串：命中任一字形即视为具备中文覆盖 */
const CJK_PROBE = '机厅';

/** 与一个必然不存在的族对比，用于识别「退化为豆腐块/空白」 */
const NO_SUCH_FAMILY = '"nearcade-font-probe-missing"';

let fontRegistered = false;

/** 注册内置字体与 fontPath 提供的字体；进程内只执行一次 */
export function ensureFont(path?: string) {
  if (fontRegistered) return;
  const registerFile = (file: string, alias?: string) => {
    try {
      if (alias) GlobalFonts.registerFromPath(file, alias);
      else GlobalFonts.registerFromPath(file);
    } catch {
      // 字体注册失败时回退到系统字体
    }
  };
  try {
    for (const entry of readdirSync(VENDOR_FONT_DIR)) {
      if (/\.(ttf|otf|woff2?)$/i.test(entry)) registerFile(join(VENDOR_FONT_DIR, entry));
    }
  } catch {
    // 内置字体缺失（非打包运行）时忽略
  }
  if (path) {
    for (const part of path.split(';')) {
      const target = part.trim();
      if (!target) continue;
      try {
        if (statSync(target).isDirectory()) {
          for (const entry of readdirSync(target)) {
            if (/\.(ttf|otf|woff2?)$/i.test(entry))
              registerFile(join(target, entry), CUSTOM_FONT_ALIAS);
          }
        } else {
          registerFile(target, CUSTOM_FONT_ALIAS);
        }
      } catch {
        // 路径无效时忽略
      }
    }
  }
  fontRegistered = true;
}

export interface FontSpec {
  /** 展示字体族，置于回退链之前（如本机安装的 Glow Sans 变体） */
  lead?: string;
  /** 字体栈覆盖；缺省用公共回退链 */
  family?: string;
  /** fontPath 提供的字体文件/目录，存在时以 nearcade-map 置于最前 */
  fontPath?: string;
}

/**
 * 拼装 ctx.font 用的字体串。帮助图片与地图渲染都必须经由此函数，
 * 以保证两者的族优先级与字重解析完全一致。
 */
export function cssFont(weight: number | string, size: number, spec: FontSpec = {}): string {
  const stack = [
    ...(spec.fontPath ? [`"${CUSTOM_FONT_ALIAS}"`] : []),
    ...(spec.lead ? [spec.lead] : []),
    spec.family ?? FALLBACK_FAMILY
  ];
  return `${weight} ${size}px ${stack.join(', ')}`;
}

let cjkAvailable: boolean | undefined;

/**
 * 当前字体环境能否真正画出汉字。缺中文字体时图片会静默变成豆腐块或整列
 * 空白；插件在生成图片前调用一次，据此给出可操作的告警而非静默降级。
 */
export function hasCjkGlyphs(): boolean {
  if (cjkAvailable !== undefined) return cjkAvailable;
  let available = false;
  try {
    const ctx = createCanvas(1, 1).getContext('2d');
    const width = (family: string) => {
      ctx.font = `40px ${family}`;
      return ctx.measureText(CJK_PROBE).width;
    };
    const cjk = width(FALLBACK_FAMILY);
    // 缺字形时汉字与不存在的族度量相同（退化为豆腐块）；有字形则更宽
    available = cjk > 0 && cjk !== width(NO_SUCH_FAMILY);
  } catch {
    // 画布不可用时不做判断，交由调用方按原有路径处理
    available = true;
  }
  cjkAvailable = available;
  return available;
}