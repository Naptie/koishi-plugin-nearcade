/**
 * 帮助卡片：在插件加载时按当前实例生成帮助图片，取代手工维护的远程图片。
 *
 * 版式复刻自 nearcade-bot.pptx：背景照片、nearcade 字标、模糊底衬上的三列
 * 表格（功能 / 指令格式 / 示例）。注册指令的关键字以金色（主题色 accent4
 * 亮化 40%）高亮，自然语言句式中的可变部分以浅绿色（accent6 亮化 40%），
 * 隔行底色为 accent1 @ 20%；表格文字带阴影（黑色 70%，右下 2pt@45°，
 * 模糊 1.5pt），标题与副标题无阴影。
 *
 * 版式随指令数量自适应：行高恒定，页面高度随内容收缩或增长（不局限 16:9），
 * 背景照片等比覆盖并居中裁剪。行高与头部间距均较参考版式收紧，为新增指令
 * 预留页面高度。
 *
 * 内容即代码（SSOT）：
 * - 注册指令行：指令注册处的 description（功能列）与 .example()（示例列），
 *   指令格式列由 displayName + declaration 拼接，前缀取实例配置的首个前缀；
 * - 自然语言行（不经过指令系统）：本文件 NATURAL_ROWS，{…} 标记浅绿部分；
 * - 行序由 ROW_ORDER 决定，未登记的指令会告警并追加到末尾。
 *
 * 字体与地图渲染共用 src/font.ts 的 cssFont：字重以数字给出，族优先级统一。
 * 优先使用系统安装的 Glow Sans（未来荧黑，按标准字体目录自动注册），缺失时
 * 由 Skia 在系统 CJK 字体上合成同等粗细；主机缺少中文字体时可用
 * discoverMap.fontPath 提供字体文件（与地图渲染共用）。
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { Context } from 'koishi';
import { cssFont, ensureFont } from './font';

// ---------------------------------------------------------------------------
// 版式设计变量（单位 pt，渲染时乘以 SCALE 转像素）
// ---------------------------------------------------------------------------

const SCALE = 2;

/** 页面宽度与左右留白（复刻参考版式：表格距左右边缘 18.4pt） */
const PAGE_WIDTH = 960;
const MARGIN = 18.4;
/** 表格下缘到页面下缘的留白 */
const BOTTOM_MARGIN = 8;

/** 标题与副标题字号，以及各元素墨迹之间的间距（单位 pt） */
const TITLE_SIZE = 42;
const SUBTITLE_SIZE = 11;
/** 副标题墨迹与标题墨迹的间距、表头墨迹与副标题墨迹的间距 */
const SUBTITLE_GAP = 4;
const HEADER_GAP = 4;
/** 字标下缘与表格上缘的最小间距 */
const LOGO_GAP = 6;

/** 字标内容区（已裁去透明边）在参考版式中的位置与高度，宽度按图片比例 */
const LOGO_RECT = { left: 27.3, top: 24.7, height: 56.3 };

/** 表格字号与行高（行高较参考版式每行收紧约 2px，为新增指令预留高度） */
const BODY_SIZE = 12.4;
const HEADER_SIZE = 14;
/** 表头行盒系数（1em 字号对应的行盒高度） */
const HEADER_LINE = 1.35;
const ROW_HEIGHT = 19.65;

/** 单元格文字与列边界的横向内边距 */
const PAD_X = 7.2;
/** 三列宽度占内容宽度的比例（复刻参考版式） */
const COLUMN_RATIOS = [0.245, 0.447, 0.308];

// 配色取自 nearcade-bot.pptx：白、accent4/accent6 亮化 40%、accent1 隔行底色与描边
const COLOR = {
  white: '#ffffff',
  white70: 'rgba(255, 255, 255, 0.7)',
  gold: '#ffd966',
  gold70: 'rgba(255, 217, 102, 0.7)',
  green: '#a9d18e'
} as const;

const COLOR_BORDER = '#4472c4';
const COLOR_BAND = 'rgba(68, 114, 196, 0.2)';

/** 表格文字阴影（仅表格文字）：黑色 70%，模糊 1.5pt，向右下偏移 2pt@45° */
const TEXT_SHADOW = {
  color: 'rgba(0, 0, 0, 0.7)',
  blur: 1.5,
  offsetX: 2 * Math.SQRT1_2,
  offsetY: 2 * Math.SQRT1_2
} as const;

/**
 * 字体族与字重。与地图渲染共用 cssFont：字重以数字给出，Glow Sans 缺失时
 * 由 Skia 在回退字体上合成同等的粗细，两张图表现一致。
 * Glow Sans 以「字宽 + 字重」拆成不同族名，仅在本机安装时命中。
 */
const GLOW_EXTENDED_HEAVY = '"Glow Sans SC Extended Heavy", "未来荧黑 Extended Heavy"';
const GLOW_EXTENDED_MEDIUM = '"Glow Sans SC Extended Medium", "未来荧黑 Extended Medium"';
const GLOW_EXTENDED_EXTRA_BOLD =
  '"Glow Sans SC Extended ExtraBold", "未来荧黑 Extended ExtraBold"';
const GLOW_NORMAL_MEDIUM = '"Glow Sans SC Normal Medium", "未来荧黑 Normal Medium"';

/** 各处文本的字重与展示字体族 */
const FONT = {
  title: { weight: 900, lead: GLOW_EXTENDED_HEAVY },
  subtitle: { weight: 500, lead: GLOW_EXTENDED_MEDIUM },
  brand: { weight: 600, lead: '"Sora"' },
  header: { weight: 800, lead: GLOW_EXTENDED_EXTRA_BOLD },
  body: { weight: 500, lead: GLOW_NORMAL_MEDIUM }
} as const;

type FontRole = keyof typeof FONT;

/** 按角色拼出完整字体串（字号单位 pt，内部按 SCALE 换算为像素） */
const fontOf = (role: FontRole, size: number, fontPath?: string) =>
  cssFont(FONT[role].weight, px(size), { lead: FONT[role].lead, fontPath });

// ---------------------------------------------------------------------------
// 内容来源
// ---------------------------------------------------------------------------

type SegmentColor = keyof typeof COLOR;

interface Segment {
  text: string;
  color: SegmentColor;
}

export interface HelpCardRow {
  /** 功能列 */
  label: string;
  /** 指令格式列（分段染色） */
  syntax: Segment[];
  /** 示例列（分段染色），null 表示无示例 */
  example: Segment[] | null;
}

/** 自然语言句式行：不经过指令系统，只能在此维护；{…} 标记浅绿部分 */
const NATURAL_ROWS: Array<{ label: string; syntax: string; example?: string }> = [
  {
    label: '查询已绑机厅卡数',
    syntax: '<机厅名/别名>{j/jk/几/几卡}',
    example: '鹅{j} / e{几} / e{jk}'
  },
  {
    label: '查询所有已绑机厅卡数',
    syntax: '{jtj}/{机厅几}/{机厅几卡}/{几卡}'
  },
  {
    label: '查询任一机厅卡数',
    syntax: '<查询字符串>{j/几}',
    example: '番禺天河{j} / 番禺{j} / toronto{几}'
  },
  {
    label: '修改已绑机厅 (机台) 卡数',
    syntax: '<机厅名/别名>[机台名/别名]({[=]/+/-}<数量>/{++/--})',
    example: 'e{=}5 / emai{+}3 / echu{--} / em3 / ec{=}2'
  },
  {
    label: '修改任一机厅 (默认机台) 卡数',
    syntax: '<查询字符串>({=/+/-}<数量>/{++/--})',
    example: 'toronto{=}1 / 章丘和谐{++}'
  },
  {
    label: '查询指定位置的附近机厅',
    syntax: '(在开启附近机厅探索功能的群聊中发送一条{位置信息})'
  }
];

/** 注册指令在帮助图片中的行序（name 为指令叶子名） */
const ROW_ORDER = [
  'search',
  'list',
  'bind',
  'unbind',
  'info',
  'default-game',
  'alias.add',
  'alias.remove',
  'alias.game.add',
  'alias.game.remove',
  'discover',
  'autosearch',
  'privacy'
];

/** 将 {…} 标记的字符串解析为染色分段 */
const parseMarkup = (source: string): Segment[] =>
  source
    .split(/\{([^}]*)\}/g)
    .map((text, index) => ({ text, color: index % 2 ? 'green' : 'white' }) as Segment)
    .filter((segment) => segment.text);

/**
 * 从指令注册表收集帮助行：自然语言行 + 注册指令行。
 * 注册指令的功能列取注册处的 description，示例列取 .example()，
 * 指令格式列由前缀 + displayName + declaration 拼接。
 */
export const collectHelpRows = (ctx: Context, prefix: string): HelpCardRow[] => {
  const logger = ctx.logger('nearcade');
  const rows: HelpCardRow[] = NATURAL_ROWS.map((row) => ({
    label: row.label,
    syntax: parseMarkup(row.syntax),
    example: row.example ? parseMarkup(row.example) : null
  }));

  const commands = ctx.$commander._commandList.filter((cmd) => {
    // 排除根指令与自动创建的中间父级（后者无 declaration 且含子指令）
    if (cmd.declaration === '' && cmd.children.length > 0) return false;
    let parent = cmd.parent;
    while (parent?.parent) parent = parent.parent;
    return parent?.name === 'nearcade';
  });

  const ordered = [...commands].sort((a, b) => {
    const indexOf = (name: string) => {
      const index = ROW_ORDER.indexOf(name);
      return index === -1 ? ROW_ORDER.length : index;
    };
    return indexOf(a.name) - indexOf(b.name) || a.name.localeCompare(b.name);
  });

  for (const cmd of ordered) {
    if (!ROW_ORDER.includes(cmd.name)) {
      logger.warn('指令 %s 未登记在帮助行序中，已追加到帮助图片末尾', cmd.name);
    }
    const description = cmd.toJSON().description;
    const label =
      typeof description === 'string'
        ? description
        : (description?.[''] ?? Object.values(description ?? {})[0] ?? '');
    if (!label) {
      logger.warn('指令 %s 缺少 description，帮助图片的功能列将为空', cmd.name);
    }
    const keyword = prefix + cmd.displayName.replace(/\./g, ' ');
    const syntax: Segment[] = [{ text: keyword, color: 'gold' }];
    if (cmd.declaration) syntax.push({ text: cmd.declaration, color: 'white' });
    rows.push({
      label,
      syntax,
      example: cmd._examples.length
        ? cmd._examples.flatMap((ex, index) => {
            const segments: Segment[] = [
              { text: keyword, color: 'gold' },
              { text: ` ${ex}`, color: 'white' }
            ];
            if (index < cmd._examples.length - 1) {
              segments.push({ text: ' / ', color: 'white' });
            }
            return segments;
          })
        : null
    });
  }

  return rows;
};

// ---------------------------------------------------------------------------
// 字体：系统安装的 Glow Sans 自动注册，不随插件分发
// ---------------------------------------------------------------------------

/** Glow Sans 标准字重/宽度名（family 名必须与此完全一致，区分大小写） */
const GLOW_SANS_WIDTHS = ['Normal', 'Condensed', 'Extended'] as const;
const GLOW_SANS_WEIGHTS = ['Heavy', 'ExtraBold', 'Bold', 'Medium', 'Book', 'Regular'] as const;

/** Windows 标准（用户/系统）字体目录中 Glow Sans 的文件名 */
const GLOW_SANS_FILE =
  /^GlowSansSC-(Normal|Condensed|Extended)-(Heavy|ExtraBold|Bold|Medium|Book|Regular)\.otf$/i;

let systemFontsRegistered = false;

/** 文件名大小写不定，按表内规范名做大小写无关匹配 */
const canonicalGlowSansName = <T extends string>(value: string, candidates: readonly T[]) =>
  candidates.find((candidate) => candidate.toLowerCase() === value.toLowerCase());

const registerSystemFonts = () => {
  if (systemFontsRegistered) return;
  systemFontsRegistered = true;
  const dirs = [
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'Windows', 'Fonts'),
    'C:\\Windows\\Fonts'
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const match = GLOW_SANS_FILE.exec(entry);
      if (!match) continue;
      const width = canonicalGlowSansName(match[1], GLOW_SANS_WIDTHS);
      const weight = canonicalGlowSansName(match[2], GLOW_SANS_WEIGHTS);
      if (!width || !weight) continue;
      try {
        GlobalFonts.registerFromPath(join(dir, entry), `Glow Sans SC ${width} ${weight}`);
      } catch {
        // 注册失败时回退系统字体
      }
    }
  }
};

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

const ASSET_DIR = join(__dirname, '..', 'assets', 'help');

const px = (pt: number) => pt * SCALE;

interface HelpLayout {
  /** 标题、副标题基线（pt，由墨迹度量推导，与 drawHeader 共用） */
  titleBaseline: number;
  subtitleBaseline: number;
  /** 表格上缘（pt） */
  tableTop: number;
  /** 表头高度（pt） */
  headerHeight: number;
  /** 数据行行高（pt） */
  rowHeight: number;
  /** 表格总高（pt，含表头） */
  tableHeight: number;
  /** 页面高度（pt，随内容收缩或增长，0.5pt 对齐以保证像素为整数） */
  pageHeight: number;
}

/** 头部文案（布局与绘制共用） */
const TITLE_TEXT = 'BOT 功能使用指南';
const SUBTITLE_BRAND = 'nearcade';
const SUBTITLE_TEXT = ' 官方 QQ 交流群: 1047949663';

/**
 * 光栅化扫描真实墨迹范围（相对基线，单位 px）。
 *
 * @napi-rs/canvas 的 actualBoundingBox* 在多字体回退的混排字符串上只反映
 * **首个字体 run**：如「BOT 功能使用指南」的 actualBoundingBoxAscent/Descent
 * 报的是 "BOT"（Sora）的 65/3，其后由回退字体绘制的汉字（真实 74/11）被完全
 * 忽略，推进宽度却仍是整串的。据此外推的行距会随字体与脚本混合方式而失真，
 * 字体一变就可能压线。这里改为把实际字符串画到离屏画布上扫描像素，得到与
 * 字体、脚本混合方式无关的墨迹上下沿。
 */
const measureInk = (text: string, font: string, size: number) => {
  const probe = createCanvas(1, 1).getContext('2d');
  probe.font = font;
  const width = Math.max(1, Math.ceil(probe.measureText(text).width) + 2);
  const pad = Math.ceil(px(size) * 1.5);
  const height = pad + Math.ceil(px(size) * 2);
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  g.font = font;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#ffffff';
  g.fillText(text, 1, pad);
  const data = g.getImageData(0, 0, width, height).data;
  let top = -1;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (top < 0) top = y;
        bottom = y;
        break;
      }
    }
  }
  if (top < 0) return { ascent: 0, descent: 0 };
  return { ascent: pad - top, descent: bottom - pad };
};

/**
 * 推导头部基线与表格上缘：标题基线按行盒顶对齐页面上缘（fontBoundingBoxAscent
 * 与字体运行无关，可稳定锚定），标题墨迹底、副标题墨迹顶/底则取 measureInk 的
 * 真实墨迹，使 SUBTITLE_GAP 在任何字体上都成立。副标题一行由字标与说明文字
 * 两段不同字体拼成，墨迹取两者的外沿。表格上缘取「副标题墨迹底 + HEADER_GAP」
 * 与「字标下缘 + LOGO_GAP」中的较大者。在独立画布上度量，供 computeLayout
 * 在建画布前使用。
 */
const measureHeader = (fontPath?: string) => {
  const titleFont = fontOf('title', TITLE_SIZE, fontPath);
  const brandFont = fontOf('brand', SUBTITLE_SIZE, fontPath);
  const subtitleFont = fontOf('subtitle', SUBTITLE_SIZE, fontPath);
  const scratch = createCanvas(1, 1).getContext('2d');
  scratch.font = titleFont;
  const title = scratch.measureText(TITLE_TEXT);

  const titleInk = measureInk(TITLE_TEXT, titleFont, TITLE_SIZE);
  const brandInk = measureInk(SUBTITLE_BRAND, brandFont, SUBTITLE_SIZE);
  const textInk = measureInk(SUBTITLE_TEXT, subtitleFont, SUBTITLE_SIZE);
  const subtitleInk = {
    ascent: Math.max(brandInk.ascent, textInk.ascent),
    descent: Math.max(brandInk.descent, textInk.descent)
  };

  const titleBaseline = MARGIN + title.fontBoundingBoxAscent / SCALE;
  const titleInkBottom = titleBaseline + titleInk.descent / SCALE;
  const subtitleBaseline = titleInkBottom + SUBTITLE_GAP + subtitleInk.ascent / SCALE;
  const subtitleInkBottom = subtitleBaseline + subtitleInk.descent / SCALE;
  const tableTop = Math.max(
    subtitleInkBottom + HEADER_GAP,
    LOGO_RECT.top + LOGO_RECT.height + LOGO_GAP
  );
  return { titleBaseline, subtitleBaseline, tableTop };
};

/** 按行数推导版式：行高恒定，页面高度随表格内容收缩或增长 */
const computeLayout = (rowCount: number, fontPath?: string): HelpLayout => {
  const header = measureHeader(fontPath);
  const headerHeight = HEADER_SIZE * HEADER_LINE;
  const tableHeight = headerHeight + rowCount * ROW_HEIGHT;
  const pageHeight = Math.ceil((header.tableTop + tableHeight + BOTTOM_MARGIN) * 2) / 2;
  return {
    ...header,
    headerHeight,
    rowHeight: ROW_HEIGHT,
    tableHeight,
    pageHeight
  };
};

const drawSegments = (
  g: SKRSContext2D,
  segments: Segment[],
  x: number,
  baseline: number,
  font: string
) => {
  g.font = font;
  let cursor = x;
  g.save();
  g.shadowColor = TEXT_SHADOW.color;
  g.shadowBlur = px(TEXT_SHADOW.blur);
  g.shadowOffsetX = px(TEXT_SHADOW.offsetX);
  g.shadowOffsetY = px(TEXT_SHADOW.offsetY);
  for (const segment of segments) {
    g.fillStyle = COLOR[segment.color];
    g.fillText(segment.text, cursor, baseline);
    cursor += g.measureText(segment.text).width;
  }
  g.restore();
  return cursor;
};

/** 背景照片等比覆盖（cover）整页并居中裁剪：页面高于 16:9 时裁左右，更低时裁上下 */
const drawBackground = async (g: SKRSContext2D, pageHeight: number) => {
  try {
    const background = await loadImage(join(ASSET_DIR, 'background.jpg'));
    const scale = Math.max(px(pageHeight) / background.height, px(PAGE_WIDTH) / background.width);
    const width = background.width * scale;
    const height = background.height * scale;
    g.drawImage(
      background,
      (px(PAGE_WIDTH) - width) / 2,
      (px(pageHeight) - height) / 2,
      width,
      height
    );
    return;
  } catch {
    // 背景资源缺失（未执行资源准备脚本）时回退纯色渐变
  }
  const gradient = g.createLinearGradient(0, 0, px(PAGE_WIDTH), px(pageHeight));
  gradient.addColorStop(0, '#2b2d4f');
  gradient.addColorStop(1, '#1a1030');
  g.fillStyle = gradient;
  g.fillRect(0, 0, px(PAGE_WIDTH), px(pageHeight));
};

/** 模糊底衬拉伸覆盖表格区域（底衬本身为重度模糊图像，拉伸不影响观感） */
const drawBackdrop = async (g: SKRSContext2D, layout: HelpLayout) => {
  try {
    const backdrop = await loadImage(join(ASSET_DIR, 'backdrop.jpg'));
    g.drawImage(
      backdrop,
      px(MARGIN),
      px(layout.tableTop),
      px(PAGE_WIDTH - MARGIN * 2),
      px(layout.tableHeight)
    );
  } catch {
    // 底衬资源缺失（未执行资源准备脚本）时跳过
  }
};

/** 字标：高度按内容区常量，宽度按图片比例 */
const drawLogo = async (g: SKRSContext2D) => {
  try {
    const logo = await loadImage(join(ASSET_DIR, 'logo.png'));
    const width = LOGO_RECT.height * (logo.width / logo.height);
    g.drawImage(logo, px(LOGO_RECT.left), px(LOGO_RECT.top), px(width), px(LOGO_RECT.height));
  } catch {
    // 字标资源缺失时跳过
  }
};

/** 顶部标题与副标题（右对齐，与表格右缘对齐；基线来自 measureHeader 的墨迹度量） */
const drawHeader = (g: SKRSContext2D, layout: HelpLayout, fontPath?: string) => {
  const right = px(PAGE_WIDTH - MARGIN - PAD_X);

  g.font = fontOf('title', TITLE_SIZE, fontPath);
  g.fillStyle = COLOR.white;
  const titleWidth = g.measureText(TITLE_TEXT).width;
  g.fillText(TITLE_TEXT, right - titleWidth, px(layout.titleBaseline));

  const subtitleFont = fontOf('subtitle', SUBTITLE_SIZE, fontPath);
  g.font = subtitleFont;
  const textWidth = g.measureText(SUBTITLE_TEXT).width;
  const subtitleBaseline = px(layout.subtitleBaseline);
  g.font = fontOf('brand', SUBTITLE_SIZE, fontPath);
  const brandWidth = g.measureText(SUBTITLE_BRAND).width;
  const subtitleLeft = right - brandWidth - textWidth;
  g.fillText(SUBTITLE_BRAND, subtitleLeft, subtitleBaseline);
  g.font = subtitleFont;
  g.fillText(SUBTITLE_TEXT, subtitleLeft + brandWidth, subtitleBaseline);
};

const drawTable = (
  g: SKRSContext2D,
  rows: HelpCardRow[],
  layout: HelpLayout,
  fontPath?: string
) => {
  const left = px(MARGIN);
  const top = px(layout.tableTop);
  const width = px(PAGE_WIDTH - MARGIN * 2);
  const headerHeight = px(layout.headerHeight);
  const rowHeight = px(layout.rowHeight);
  const contentWidth = PAGE_WIDTH - MARGIN * 2;
  const columnOffsets = COLUMN_RATIOS.map((_, index) =>
    px(COLUMN_RATIOS.slice(0, index).reduce((sum, ratio) => sum + ratio * contentWidth, 0))
  );

  // 模糊底衬之上的隔行底色（accent1 @ 20%，首个数据行开始隔行填充）
  for (const [index] of rows.entries()) {
    if (index % 2 === 0) {
      g.fillStyle = COLOR_BAND;
      g.fillRect(left, top + headerHeight + index * rowHeight, width, rowHeight);
    }
  }

  // 表格上缘、表头下缘与表格下缘的描边（accent1，1pt）
  g.fillStyle = COLOR_BORDER;
  for (const y of [top, top + headerHeight, top + px(layout.tableHeight)]) {
    g.fillRect(left, y - SCALE / 2, width, SCALE);
  }

  // 行内文本按墨迹垂直居中（用不含降部的 CJK 探针串度量墨迹盒）
  const cellBaseline = (rowTop: number, rowH: number, font: string) => {
    g.font = font;
    const metrics = g.measureText('机厅名');
    return rowTop + (rowH + metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
  };

  const headerFont = fontOf('header', HEADER_SIZE, fontPath);
  const bodyFont = fontOf('body', BODY_SIZE, fontPath);

  // 表头
  const headerBaseline = cellBaseline(top, headerHeight, headerFont);
  drawSegments(g, [{ text: '功能', color: 'white' }], left + columnOffsets[0] + PAD_X * SCALE, headerBaseline, headerFont);
  drawSegments(
    g,
    [{ text: '指令格式', color: 'white' }],
    left + columnOffsets[1] + PAD_X * SCALE,
    headerBaseline,
    headerFont
  );
  drawSegments(
    g,
    [{ text: '示例', color: 'white' }],
    left + columnOffsets[2] + PAD_X * SCALE,
    headerBaseline,
    headerFont
  );

  // 数据行
  for (const [index, row] of rows.entries()) {
    const rowTop = top + headerHeight + index * rowHeight;
    const baseline = cellBaseline(rowTop, rowHeight, bodyFont);
    drawSegments(
      g,
      [{ text: row.label, color: 'white' }],
      left + columnOffsets[0] + PAD_X * SCALE,
      baseline,
      bodyFont
    );
    drawSegments(g, row.syntax, left + columnOffsets[1] + PAD_X * SCALE, baseline, bodyFont);
    if (row.example) {
      drawSegments(g, row.example, left + columnOffsets[2] + PAD_X * SCALE, baseline, bodyFont);
    }
  }
};

/** 渲染帮助图片（PNG buffer），版式按行数自适应 */
export const renderHelpCard = async (rows: HelpCardRow[], fontPath?: string): Promise<Buffer> => {
  ensureFont(fontPath);
  registerSystemFonts();
  const layout = computeLayout(rows.length, fontPath);
  const canvas = createCanvas(px(PAGE_WIDTH), px(layout.pageHeight));
  const g = canvas.getContext('2d');
  g.textBaseline = 'alphabetic';
  await drawBackground(g, layout.pageHeight);
  await drawBackdrop(g, layout);
  await drawLogo(g);
  drawTable(g, rows, layout, fontPath);
  drawHeader(g, layout, fontPath);
  return canvas.encode('png');
};
