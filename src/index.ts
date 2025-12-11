import { Context, h, Schema, Session } from 'koishi';
import { Client } from './client';
import {
  Arcade,
  AttendanceReport,
  AttendanceResponse,
  CustomAttendanceReport,
  CustomShop,
  DiscoverySettings,
  GroupSettings,
  Shop
} from './types';
import zhCN from '../locales/zh-CN.yml';
import { compressDiscoverUrl } from './utils';

declare module 'koishi' {
  interface Tables {
    arcades: Arcade;
    attendanceReports: AttendanceReport;
    customAttendanceReports: CustomAttendanceReport;
    discoverySettings: DiscoverySettings;
    groupSettings: GroupSettings;
  }
}

export const name = 'nearcade';
export const inject = ['database'];

export interface Config {
  urlBase: string;
  apiBase: string;
  apiToken: string;
  selfId: string;
  helpMessage?: string;
  helpOnMention?: boolean;
  customShops?: CustomShop[];
}

export const Config: Schema<Config> = Schema.object({
  urlBase: Schema.string()
    .default('https://nearcade.phizone.cn')
    .description('nearcade 网站地址')
    .role('url'),
  apiBase: Schema.string().required().description('nearcade API 地址').role('url'),
  apiToken: Schema.string().required().description('nearcade API 令牌').role('secret'),
  selfId: Schema.string().required().description('nearcade 用户 ID'),
  helpMessage: Schema.string().description('帮助信息'),
  helpOnMention: Schema.boolean().default(true).description('是否在提及 nearcade 时发送帮助信息'),
  customShops: Schema.array(
    Schema.object({
      id: Schema.number().required().description('机厅 ID'),
      aliases: Schema.array(Schema.string()).required().description('机厅别名')
    })
  )
    .default([])
    .description('自定义机厅列表')
});

const gameTitles: Array<{ titleId: number; names: string[] }> = [
  { titleId: 1, names: ['舞萌DX', '舞萌', 'maimai', 'maimai DX', 'maimaiDX', 'mai', 'm'] },
  { titleId: 3, names: ['中二节奏', 'CHUNITHM', 'CHUNI', '中二', 'CHU', 'c'] },
  { titleId: 31, names: ['太鼓之达人', '太鼓达人', '太鼓', 'Taiko', 'Tai', 't'] },
  { titleId: 4, names: ['音律炫动', 'SOUND VOLTEX', 'SOUNDVOLTEX', 'SDVX', '山东卫星', 's'] },
  { titleId: 17, names: ['华卡音舞', '华卡', 'WACCA', 'w'] }
].map((title) => {
  title.names = title.names.map((name) => name.toLowerCase());
  return title;
});

const attendanceQuerySuffix = [
  'j',
  'jk',
  'jr',
  'jgr',
  'dsr',
  'yjk',
  'yjr',
  'yjgr',
  'ydsk',
  'ydsr',
  '几',
  '几卡',
  '几人',
  '几个人',
  '多少人',
  '有几卡',
  '有几人',
  '有几个人',
  '有多少卡',
  '有多少人'
].sort((a, b) => b.length - a.length);

const attendanceOperators = ['=', '＝', '🟰', '+', '＋', '➕', '-', '－', '➖'] as const;

const isPlus = (op: string) => ['+', '＋', '➕'].includes(op);
const isMinus = (op: string) => ['-', '－', '➖'].includes(op);

const decodeHtmlEntities = (str: string) =>
  str
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

const tryParseCqJson = (text: string) => {
  const m = text.match(/\[CQ:json,data=(\{[\s\S]*?\})[\s]*\]/);
  if (!m) return null;
  const decoded = decodeHtmlEntities(m[1]);
  return { type: 'json', data: { data: decoded } };
};

const helpVersion = 6;

export const apply = (ctx: Context) => {
  const client = new Client(ctx.config.apiBase, ctx.config.apiToken);
  const urlBase = ctx.config.urlBase.endsWith('/')
    ? ctx.config.urlBase.slice(0, -1)
    : ctx.config.urlBase;

  ctx.model.extend(
    'arcades',
    {
      _id: 'integer',
      source: 'string',
      id: 'integer',
      names: 'array',
      defaultGame: 'json',
      gameAliases: 'array',
      channelId: 'string',
      registrantId: 'string',
      registrantName: 'string',
      registeredAt: 'string'
    },
    {
      primary: '_id',
      autoInc: true
    }
  );

  ctx.model.extend(
    'attendanceReports',
    {
      _id: 'integer',
      source: 'string',
      id: 'integer',
      reporterId: 'string',
      reporterName: 'string'
    },
    {
      primary: '_id',
      autoInc: true
    }
  );

  ctx.model.extend(
    'customAttendanceReports',
    {
      _id: 'integer',
      shop: 'integer',
      count: 'integer',
      channelId: 'string',
      reporterId: 'string',
      reporterName: 'string',
      reportedAt: 'string'
    },
    {
      primary: '_id',
      autoInc: true
    }
  );

  ctx.model.extend(
    'discoverySettings',
    {
      _id: 'integer',
      channelId: 'string',
      off: 'boolean',
      radius: 'integer',
      operatorId: 'string',
      operatorName: 'string',
      updatedAt: 'string'
    },
    {
      primary: '_id',
      autoInc: true
    }
  );

  ctx.model.extend(
    'groupSettings',
    {
      channelId: 'string',
      private: 'boolean',
      search: 'boolean',
      operatorId: 'string',
      operatorName: 'string',
      updatedAt: 'string'
    },
    {
      primary: 'channelId'
    }
  );

  ctx.i18n.define('zh-CN', zhCN);

  const getArcadesByChannelId = (channelId: string) => {
    return ctx.database.get('arcades', { channelId });
  };

  const getReport = async (source: string, id: number) => {
    return (await ctx.database.get('attendanceReports', { source, id }))[0];
  };

  const createReport = async (
    source: string,
    id: number,
    reporterId: string,
    reporterName: string
  ) => {
    const existing = await ctx.database.get('attendanceReports', { source, id });
    if (existing.length) {
      await ctx.database.set(
        'attendanceReports',
        { _id: existing[0]._id },
        { reporterId, reporterName }
      );
    } else {
      await ctx.database.create('attendanceReports', { source, id, reporterId, reporterName });
    }
  };

  const printGame = ({ name, version }: { name: string; version: string }) =>
    version ? `${name} (${version})` : name;

  const printArcades = (arcades: Arcade[]) =>
    arcades
      .map(
        (item) =>
          `- ${item.names[0]} ${item.source.toUpperCase()}/${item.id}` +
          `\n  别名：${item.names.slice(1).join('，') || '无'}` +
          `\n  默认机台：${printGame(item.defaultGame)} (ID: ${item.defaultGame.gameId})` +
          `\n  由 ${item.registrantName} (${item.registrantId}) 绑定于 ${new Date(item.registeredAt).toLocaleString()}`
      )
      .join('\n');

  const getDefaultGame = (shop: Shop) =>
    shop.games.sort((a, b) =>
      a.titleId === b.titleId ? a.gameId - b.gameId : a.titleId - b.titleId
    )[0];

  const bind = async (shop: Shop, aliases: string[] = [], session: Session) => {
    const exists = await ctx.database.get('arcades', {
      source: shop.source,
      id: shop.id,
      channelId: session.channelId
    });
    if (exists.length > 0)
      return `该机厅已由 ${exists[0].registrantName} (${exists[0].registrantId}) 绑定于 ${new Date(exists[0].registeredAt).toLocaleString()}，无需重复绑定。`;
    const defaultGame = getDefaultGame(shop);
    if (!defaultGame) {
      return '该机厅未收录任何机台，无法绑定。';
    }
    await ctx.database.create('arcades', {
      source: shop.source,
      id: shop.id,
      names: [shop.name, ...aliases],
      defaultGame,
      channelId: session.channelId,
      registrantId: session.userId,
      registrantName: session.username,
      registeredAt: new Date().toISOString()
    });
    return `机厅「${shop.name}」成功绑定至当前群聊。\n别名：${aliases.join('，') || '无'}\n默认机台：${printGame(defaultGame)}`;
  };

  const report = async (
    countInput: number,
    operator: (typeof attendanceOperators)[number],
    gameId: number | undefined,
    arcade: Shop | CustomShop,
    session: Session
  ) => {
    let count = countInput;
    if (isPlus(operator) || isMinus(operator)) {
      if ('aliases' in arcade) {
        const report = (
          await ctx.database.get('customAttendanceReports', {
            shop: arcade.id,
            channelId: session.channelId
          })
        )[0];
        const existing = report?.count || 0;
        count = Math.max(0, isPlus(operator) ? existing + count : existing - count);
      } else {
        const attendance = await client.getAttendance(arcade.source, arcade.id);
        if (typeof attendance === 'string') {
          return `请求机厅「${arcade.name}」在勤人数失败：${attendance}`;
        }
        const game = attendance.games.find((g) => g.gameId === gameId);
        if (!game) {
          return `机厅「${arcade.name}」不存在 ID 为 ${gameId} 的机台。`;
        }
        const existing = game.total;
        count = Math.min(99, Math.max(0, isPlus(operator) ? existing + count : existing - count));
      }
    }
    if ('aliases' in arcade) {
      await ctx.database.remove('customAttendanceReports', {
        shop: arcade.id,
        channelId: session.channelId
      });
      await ctx.database.create('customAttendanceReports', {
        shop: arcade.id,
        channelId: session.channelId,
        count,
        reporterId: session.userId,
        reporterName: session.username,
        reportedAt: new Date().toISOString()
      });
      return `成功上报机厅「${arcade.aliases[0]}」在勤人数为 ${count} 人。`;
    } else {
      const settings = (
        await ctx.database.get('groupSettings', { channelId: session.channelId })
      )[0];
      const isPrivate = settings?.private;
      const group = isPrivate
        ? session.event._data.group_name || '私密群组'
        : session.event._data.group_name
          ? `${session.event._data.group_name} (${session.channelId})`
          : session.channelId;
      const result = await client.reportAttendance(
        arcade.source,
        arcade.id,
        gameId,
        count,
        `由 ${session.username} (${session.userId}) 从 ${isPrivate && !session.event._data.group_name ? '' : 'QQ 群 '}${group} 上报`
      );
      if (typeof result === 'string') {
        return `上报机厅「${arcade.name}」在勤人数失败：${result}`;
      } else if (result.success) {
        const game = arcade.games.find((g) => g.gameId === gameId) || {
          name: '未知机台',
          version: '未知版本',
          quantity: 1
        };
        await createReport(arcade.source, arcade.id, session.userId, session.username);
        return `成功上报机厅「${arcade.name}」的机台「${printGame(game)}」在勤人数为 ${count} 人（均 ${(count / game.quantity).toFixed(1)}）。`;
      } else {
        return `上报机厅「${arcade.name}」在勤人数失败：未知错误`;
      }
    }
  };

  const toForwarded = (text: string) => `<message forward>${text}</message>`;

  const getHelpMessage = () => {
    let message = h('img', { src: `${urlBase}/bot-help.png?v=${helpVersion}` });
    if (ctx.config.helpMessage) {
      message = h('p', ctx.config.helpMessage, message);
    }
    return message;
  };

  const formatDistance = (distance: number) =>
    distance >= 1 ? `(${distance.toFixed(2)} 千米)` : `(${(distance * 1000).toFixed(0)} 米)`;

  ctx.on('message', async (session) => {
    if ('message' in session.event._data) {
      const rawMessage = session.event._data.message;

      let element: string | (typeof session.event._data.message)[number];
      if (typeof rawMessage === 'string') {
        element = tryParseCqJson(rawMessage) || { type: 'text', data: rawMessage };
      } else if (Array.isArray(rawMessage)) {
        element = rawMessage[0];
        if (typeof element === 'string') {
          element = tryParseCqJson(element) || { type: 'text', data: element };
        }
      } else {
        element = rawMessage[0];
      }

      if (
        typeof element === 'object' &&
        element.type === 'json' &&
        'data' in element &&
        typeof element.data.data === 'string'
      ) {
        const data = JSON.parse(element.data.data);
        if (data.view === 'LocationShare' && 'Location.Search' in data.meta) {
          const settings = (
            await ctx.database.get('discoverySettings', { channelId: session.channelId })
          )[0];
          if (settings?.off) {
            return;
          }
          const query = data.meta['Location.Search'];
          const name = query.name;
          const latitude = query.lat;
          const longitude = query.lng;
          if (latitude && longitude) {
            const radius = settings?.radius || 10;
            const result = await client.discoverArcades(latitude, longitude, radius, name);
            if (typeof result === 'string') {
              await session.send(`查询附近机厅失败：${result}`);
              return;
            }
            const lines = [];
            if (result.shops.length) {
              lines.push(`${name ? `「${name}」` : ''}周围 ${radius} 千米内找到以下机厅：`);
              for (const shop of result.shops) {
                let reporter: string | null = null;
                if (shop.currentReportedAttendance) {
                  const reportedBySelf =
                    shop.currentReportedAttendance.reportedBy === ctx.config.selfId;
                  if (reportedBySelf) {
                    const { reporterId, reporterName } = await getReport(shop.source, shop.id);
                    reporter = `${reporterName} (${reporterId})`;
                  } else {
                    const user = shop.currentReportedAttendance.reporter;
                    reporter = user.displayName || `@${user.name}`;
                  }
                }
                lines.push(
                  `-「${shop.name}」${formatDistance(shop.distance)} ${shop.totalAttendance} 人${reporter ? `（由 ${reporter} 上报于 ${new Date(shop.currentReportedAttendance.reportedAt).toLocaleTimeString()}）` : ''}`
                );
              }
            } else {
              lines.push(`${name ? `「${name}」` : ''}周围 ${radius} 千米内未找到机厅。`);
            }
            lines.push(
              `有关更多信息，请访问 ${compressDiscoverUrl(latitude, longitude, radius, name, urlBase)}`
            );
            const message = lines.join('\n');
            await session.send(result.shops.length > 3 ? toForwarded(message) : message);
            return;
          }
        }
      }
    }
    if (session.content.trim().toLowerCase() === 'nearcade' && ctx.config.helpOnMention !== false) {
      await session.send(getHelpMessage());
      return;
    }
    if (attendanceQuerySuffix.some((suffix) => session.content.toLowerCase().endsWith(suffix))) {
      const arcades = await getArcadesByChannelId(session.channelId);
      const suffix = attendanceQuerySuffix.find((suffix) =>
        session.content.toLowerCase().endsWith(suffix)
      );
      const query = session.content.slice(0, -suffix!.length).trim().toLowerCase();
      const customShop = ctx.config.customShops.find((shop: CustomShop) =>
        shop.aliases.some((alias) => alias.trim().toLowerCase() === query)
      ) as CustomShop;
      let matched: {
        source: string;
        id: number;
        names: string[];
      }[] = arcades.filter((item) =>
        item.names.some((name) => name.trim().toLowerCase() === query)
      );
      if (matched.length === 0 && !(!query || ['机厅', 'jt'].includes(query))) {
        if (query.replace(/[^\p{L}\p{N}_]/gu, '').length < 2) {
          return;
        }
        const result = await client.findArcades(query);
        if (typeof result === 'string') {
          await session.send(`查询机厅失败：${result}`);
          return;
        }
        matched = result.map((shop) => ({
          source: shop.source,
          id: shop.id,
          names: [shop.name]
        }));
        if (!matched.length && !customShop) {
          return;
        }
      }
      const regularQuery = matched.length > 0 ? matched : customShop ? [] : arcades;
      const arcadeQuery: (((typeof matched)[number] | CustomShop) & {
        data?: AttendanceResponse;
        customReporter?: { id: string; name: string; time: string };
      })[] = customShop ? [customShop, ...regularQuery] : regularQuery;
      await Promise.all(
        arcadeQuery.map(async (arcade) => {
          if (!('source' in arcade && 'id' in arcade)) {
            const report = (
              await ctx.database.get('customAttendanceReports', {
                shop: arcade.id,
                channelId: session.channelId
              })
            )[0];
            arcade.data = {
              success: true,
              total: report?.count || 0,
              games: [],
              registered: [],
              reported: []
            };
            arcade.customReporter = report
              ? {
                  id: report.reporterId,
                  name: report.reporterName,
                  time: report.reportedAt
                }
              : undefined;
            return;
          }
          const result = await client.getAttendance(arcade.source, arcade.id);
          if (typeof result === 'string') {
            return;
          }
          arcade.data = result;
        })
      );
      const message =
        '实时在勤情况：\n' +
        (
          await Promise.all(
            arcadeQuery.map(async (arcade) => {
              if (!arcade.data) {
                return `-「${('names' in arcade ? arcade.names : arcade.aliases)[0]}」获取失败`;
              }
              const { total, games, reported, registered } = arcade.data;
              if ('aliases' in arcade) {
                const reporter = arcade.customReporter;
                return `-「${arcade.aliases[0]}」${total} 人${reporter ? `（由 ${reporter.name} (${reporter.id}) 上报于 ${new Date(reporter.time).toLocaleTimeString()}）` : ''}`;
              }
              const report = reported[0];
              let reporter: string | null = null;
              if (report) {
                const reportedBySelf = report.reportedBy === ctx.config.selfId;
                if (reportedBySelf) {
                  const { reporterId, reporterName } = await getReport(arcade.source, arcade.id);
                  reporter = `${reporterName} (${reporterId})`;
                } else {
                  reporter = report.reporter.displayName || `@${report.reporter.name}`;
                }
              }
              const lines = [
                `-「${arcade.names[0]}」${total} 人${reporter ? `（由 ${reporter} 上报于 ${new Date(report.reportedAt).toLocaleTimeString()}）` : ''}`
              ];
              if (games.length) {
                lines.push(
                  ...games
                    .filter(
                      (game) =>
                        reported.some((r) => r.gameId === game.gameId) ||
                        registered.some((r) => r.gameId === game.gameId)
                    )
                    .map(
                      (game) =>
                        `  - ${printGame(game)}: ${game.total} 人（均 ${(game.total / game.quantity).toFixed(1)}）`
                    )
                );
              }
              return lines.join('\n');
            })
          )
        ).join('\n');
      await session.send(arcadeQuery.length > 5 ? toForwarded(message) : message);
      return;
    }
    const reportQueue: {
      count: number;
      operator: (typeof attendanceOperators)[number];
      gameId?: number;
      shop: Shop | CustomShop;
    }[] = [];
    const settings = (await ctx.database.get('groupSettings', { channelId: session.channelId }))[0];
    const allowSearch = settings?.search !== false;
    for (const line of session.content.split('\n')) {
      let operator: (typeof attendanceOperators)[number] | undefined,
        left: string | undefined,
        right: string | undefined,
        doSearch = true;
      for (const op of attendanceOperators) {
        if (!line.includes(op)) {
          continue;
        }
        const [l, r, ...rest] = line.split(op).map((s) => s.trim().toLowerCase());
        if (!l) continue;
        if (
          !r &&
          (!(r === '' && rest.length === 1 && rest[0] === '') || (!isPlus(op) && !isMinus(op)))
        )
          continue;
        operator = op;
        left = l;
        right = r || '1';
      }
      if (!operator) {
        const m = line.trim().match(/^(.+?)(\d+)$/);
        if (!m || !m[1] || !m[2]) continue;
        const [l, r] = m.splice(1).map((s) => s.trim().toLowerCase());
        operator = '=';
        left = l;
        right = r;
        doSearch = false;
      }
      const count = parseInt(right);
      const customShop = ctx.config.customShops.find((shop: CustomShop) =>
        shop.aliases.some((alias) => alias.trim().toLowerCase() === left)
      ) as CustomShop;
      if (
        isNaN(count) ||
        count < 0 ||
        count > (customShop ? Infinity : 99) ||
        count.toString() !== right
      )
        break;
      if (customShop) {
        reportQueue.push({
          count,
          operator,
          shop: customShop
        });
        break;
      }
      let success = false;
      const arcades = await getArcadesByChannelId(session.channelId);
      for (const arcade of arcades) {
        let gameId = arcade.defaultGame.gameId;
        success = arcade.names.includes(left);
        const arcadeData = await client.getArcade(arcade.source, arcade.id);
        if (typeof arcadeData === 'string') continue;
        if (!success) {
          for (let i = 1; i < left.length; i++) {
            const arcadeName = left.slice(0, i).toLowerCase().trim();
            if (!arcade.names.includes(arcadeName)) continue;
            const gameName = left.slice(i).toLowerCase().trim();
            gameId = arcade.gameAliases.find((g) => g.aliases.includes(gameName))?.gameId;
            if (gameId) {
              success = true;
              break;
            } else {
              gameId = arcadeData.shop.games.find(
                (g) => g.titleId === gameTitles.find((g) => g.names.includes(gameName))?.titleId
              )?.gameId;
              if (gameId) {
                success = true;
                break;
              }
            }
          }
        }
        if (success) {
          reportQueue.push({
            count,
            operator,
            gameId,
            shop: arcadeData.shop
          });
          break;
        }
      }
      if (!success && doSearch && allowSearch) {
        const matched = await client.findArcades(left, 5);
        if (typeof matched === 'string') {
          await session.send(`查询机厅失败：${matched}`);
          break;
        }
        if (matched.length === 0) break;
        if (matched.length > 1) {
          await session.send(
            '找到多个匹配的机厅，请使用更具体的名称或别名：\n' +
              matched.map((item) => `- ${item.name}`).join('\n')
          );
          break;
        }
        const defaultGame = getDefaultGame(matched[0]);
        if (!defaultGame) {
          await session.send(`机厅「${matched[0].name}」未收录任何机台，无法上报在勤人数。`);
          break;
        }
        reportQueue.push({
          count,
          operator,
          gameId: defaultGame.gameId,
          shop: matched[0]
        });
      }
    }
    const messages = (
      await Promise.all(
        reportQueue.map(({ count, operator, gameId, shop }) =>
          report(count, operator, gameId, shop, session)
        )
      )
    ).filter((msg) => msg);
    await session.send(
      messages.length > 5 ? toForwarded(messages.join('\n')) : messages.join('\n')
    );
  });

  ctx.command('nearcade').action(() => {
    return getHelpMessage();
  });

  ctx
    .command('nearcade')
    .subcommand('discover <option>')
    .alias(
      '附近机厅',
      '探索附近',
      '探索附近机厅',
      '搜索附近',
      '搜索附近机厅',
      '发现附近',
      '发现附近机厅',
      '查询附近',
      '查询附近机厅',
      '查找附近',
      '查找附近机厅'
    )
    .action(async ({ session }, optionStr) => {
      const option = (optionStr || '').trim().toLowerCase();
      let settings: Omit<DiscoverySettings, '_id'> = (
        await ctx.database.get('discoverySettings', { channelId: session.channelId })
      )[0];
      if (!settings) {
        settings = {
          channelId: session.channelId,
          off: false,
          radius: 10,
          operatorId: session.userId,
          operatorName: session.username,
          updatedAt: new Date().toISOString()
        };
        await ctx.database.create('discoverySettings', settings);
      }
      if (!option) {
        return h(
          'p',
          `本群当前附近机厅探索功能处于${settings.off ? '关闭' : '开启'}状态，探索半径为 ${settings.radius} 千米。\n`,
          `该项设置最后由 ${settings.operatorName} (${settings.operatorId}) 于 ${new Date(settings.updatedAt).toLocaleString()} 修改。\n`,
          '发送“discover 关/off”关闭探索功能；\n',
          '发送“discover 开/on”开启探索功能；\n',
          '发送“discover <数字>”设置探索半径（范围 1~30 千米）。'
        );
      }
      if (['关', '关掉', '关闭', 'off', 'close'].includes(option)) {
        if (settings?.off) {
          return '本群的附近机厅探索功能已是关闭状态。';
        }
        await ctx.database.set(
          'discoverySettings',
          { channelId: session.channelId },
          {
            off: true,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已关闭本群的附近机厅探索功能。';
      }
      if (['开', '打开', '开启', 'on', 'open'].includes(option)) {
        if (!settings?.off) {
          return '本群的附近机厅探索功能已是开启状态。';
        }
        await ctx.database.set(
          'discoverySettings',
          { channelId: session.channelId },
          {
            off: false,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已开启本群的附近机厅探索功能。';
      }
      const radius = parseFloat(option);
      if (isNaN(radius) || radius < 1 || radius > 30 || radius.toString() !== option) {
        return '半径参数无效，请输入 1~30 之间的数字。';
      }
      if (settings.radius === radius) {
        return `本群的附近机厅探索半径已是 ${radius} 千米。`;
      }
      await ctx.database.set(
        'discoverySettings',
        { channelId: session.channelId },
        {
          radius,
          operatorId: session.userId,
          operatorName: session.username,
          updatedAt: new Date().toISOString()
        }
      );
      return `已将本群的附近机厅探索半径设置为 ${radius} 千米。`;
    });

  ctx
    .command('nearcade')
    .subcommand('privacy <option>')
    .alias('隐私设置', '群组隐私')
    .action(async ({ session }, optionStr) => {
      const option = (optionStr || '').trim().toLowerCase();
      let settings = (await ctx.database.get('groupSettings', { channelId: session.channelId }))[0];
      if (!settings) {
        settings = {
          channelId: session.channelId,
          private: false,
          search: true,
          operatorId: session.userId,
          operatorName: session.username,
          updatedAt: new Date().toISOString()
        };
        await ctx.database.create('groupSettings', settings);
      }
      if (!option) {
        return h(
          'p',
          `本群隐私模式当前处于${settings.private ? '开启' : '关闭'}状态。\n`,
          `该项设置最后由 ${settings.operatorName} (${settings.operatorId}) 于 ${new Date(settings.updatedAt).toLocaleString()} 修改。\n`,
          '发送“privacy 关/off”关闭隐私模式（上报时将显示群号）；\n',
          '发送“privacy 开/on”开启隐私模式（上报时将隐藏群号）。'
        );
      }
      if (['关', '关掉', '关闭', 'off', 'close'].includes(option)) {
        if (!settings.private) {
          return '本群已关闭隐私模式。';
        }
        await ctx.database.set(
          'groupSettings',
          { channelId: session.channelId },
          {
            private: false,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已为本群关闭隐私模式。';
      }
      if (['开', '打开', '开启', 'on', 'open'].includes(option)) {
        if (settings.private) {
          return '本群已开启隐私模式。';
        }
        await ctx.database.set(
          'groupSettings',
          { channelId: session.channelId },
          {
            private: true,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已为本群开启隐私模式。';
      }
      return '无效的参数，请发送“privacy”查看帮助。';
    });

  ctx
    .command('nearcade')
    .subcommand('autosearch <option>')
    .alias('自动搜索', '搜索上报')
    .action(async ({ session }, optionStr) => {
      const option = (optionStr || '').trim().toLowerCase();
      let settings = (await ctx.database.get('groupSettings', { channelId: session.channelId }))[0];
      if (!settings) {
        settings = {
          channelId: session.channelId,
          private: false,
          search: true,
          operatorId: session.userId,
          operatorName: session.username,
          updatedAt: new Date().toISOString()
        };
        await ctx.database.create('groupSettings', settings);
      }
      if (!option) {
        return h(
          'p',
          `本群自动搜索功能当前处于${settings.search !== false ? '开启' : '关闭'}状态。\n`,
          `该项设置最后由 ${settings.operatorName} (${settings.operatorId}) 于 ${new Date(settings.updatedAt).toLocaleString()} 修改。\n`,
          '发送“autosearch 关/off”关闭自动搜索（仅允许上报已绑定机厅）；\n',
          '发送“autosearch 开/on”开启自动搜索（允许上报未绑定机厅）。'
        );
      }
      if (['关', '关掉', '关闭', 'off', 'close'].includes(option)) {
        if (settings.search === false) {
          return '本群已关闭自动搜索功能。';
        }
        await ctx.database.set(
          'groupSettings',
          { channelId: session.channelId },
          {
            search: false,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已为本群关闭自动搜索功能。';
      }
      if (['开', '打开', '开启', 'on', 'open'].includes(option)) {
        if (settings.search !== false) {
          return '本群已开启自动搜索功能。';
        }
        await ctx.database.set(
          'groupSettings',
          { channelId: session.channelId },
          {
            search: true,
            operatorId: session.userId,
            operatorName: session.username,
            updatedAt: new Date().toISOString()
          }
        );
        return '已为本群开启自动搜索功能。';
      }
      return '无效的参数，请发送“autosearch”查看帮助。';
    });

  ctx
    .command('nearcade')
    .subcommand('bind <query>')
    .alias('绑定机厅', '添加机厅', 'add')
    .action(async ({ session }, ...segments) => {
      const query = segments.join(' ');
      if (query.trim().length === 0) {
        return '查询字符串不得为空。';
      }
      const result = await client.findArcades(query);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const shops = result;
      if (!shops.length) return '未查询到相关机厅';
      if (shops.length === 1) {
        const shop = shops[0];
        await session.send(
          `查询到唯一机厅「${shop.name}」，请提供数个空格间隔的机厅别名，或发送句号以跳过别名设置。`
        );
        const reply = await session.prompt();
        if (!reply) return '回复超时，操作已取消。';
        const aliases = ['。', '.'].includes(reply.trim()) ? [] : reply.trim().split(/\s+/);
        return bind(shop, aliases, session);
      } else {
        const message =
          `查询到以下机厅（共 ${shops.length} 家）：\n` +
          shops.map((item, index) => `${index + 1}. ${item.name}`).join('\n') +
          '\n请输入对应的序号以绑定机厅，或发送“取消”以取消操作。序号后可附加数个空格间隔的机厅别名。';
        const forward = shops.length > 5;
        await session.send(forward ? toForwarded(message) : message);
        const reply = await session.prompt();
        if (!reply) return '回复超时，操作已取消。';
        if (reply.trim() === '取消') return '操作已取消。';
        const [first, ...aliases] = reply.trim().split(/\s+/);
        const index = parseInt(first);
        if (isNaN(index) || index < 1 || index > shops.length) {
          return '无效的序号，操作已取消。';
        }
        const shop = shops[index - 1];
        return bind(shop, aliases, session);
      }
    });

  ctx
    .command('nearcade')
    .subcommand('search <query>')
    .alias('查找机厅', '搜索机厅', '搜寻机厅', '寻找机厅', 'query', 'find')
    .action(async (_, ...segments) => {
      const query = segments.join(' ');
      if (query.trim().length === 0) {
        return '查询字符串不得为空。';
      }
      const result = await client.findArcades(query);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const shops = result;
      if (!shops.length) return '未查询到相关机厅';
      const message =
        `查询到以下机厅（共 ${shops.length} 家）：\n` +
        shops
          .map((item, index) => {
            let identifier = `${item.source.toUpperCase()}/${item.id}`;
            if (/^[a-zA-Z0-9]{2}$/.test(item.name.slice(-2))) {
              identifier = `[${identifier}]`;
            }
            return `${index + 1}. ${item.name} ${identifier}`;
          })
          .join('\n');
      const forward = shops.length > 5;
      return forward ? toForwarded(message) : message;
    });

  ctx
    .command('nearcade')
    .subcommand('list')
    .alias('机厅列表')
    .action(async ({ session }) => {
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      return '本群聊已绑定以下机厅：\n' + printArcades(arcades);
    });

  ctx
    .command('nearcade')
    .subcommand('unbind <name>')
    .alias('解绑机厅', '删除机厅', 'remove')
    .action(async ({ session }, ...segments) => {
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const name = segments.join(' ').trim();
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      await ctx.database.remove('arcades', { _id: arcade._id });
      return `机厅「${arcade.names[0]}」已成功解绑。`;
    });

  const match = (name: string, arcades: Arcade[]) => {
    return arcades.filter((item) => {
      if (item.names.includes(name)) return true;
      const parts = name.split('/');
      if (parts.length !== 2) return false;
      return item.source === parts[0].toLowerCase() && item.id === parseInt(parts[1]);
    });
  };

  const matchWithAliases = (name: string, aliases: string[], arcades: Arcade[]) => {
    let matched: Arcade[] = [];
    do {
      matched = match(name, arcades);
      if (matched.length) break;
      name = [name, aliases.shift()].join(' ');
    } while (!matched.length && aliases.length);
    return matched;
  };

  ctx
    .command('nearcade')
    .subcommand('alias.add <name> [...aliases]')
    .alias('添加别名', '添加机厅别名')
    .action(async ({ session }, name, ...aliases) => {
      if (!aliases.length) return '请至少提供一个别名。';
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = matchWithAliases(name, aliases, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const newAliases = aliases.filter(
        (alias) => !arcades.some((arcade) => arcade.names.includes(alias))
      );
      if (!newAliases.length) return '提供的别名均已存在或与其他机厅冲突。';
      arcade.names.push(...newAliases);
      await ctx.database.set('arcades', { _id: arcade._id }, { names: arcade.names });
      return `机厅「${arcade.names[0]}」已成功添加别名：${newAliases.join('，')}。`;
    });

  ctx
    .command('nearcade')
    .subcommand('alias.remove <name> [...aliases]')
    .alias('删除别名', '删除机厅别名')
    .action(async ({ session }, name, ...aliases) => {
      if (!aliases.length) return '请至少提供一个别名。';
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = matchWithAliases(name, aliases, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const existingAliases = aliases.filter(
        (alias) => arcade.names.includes(alias) && alias !== arcade.names[0]
      );
      if (!existingAliases.length) return '提供的别名均不存在或为主名称，无法删除。';
      arcade.names = arcade.names.filter((alias) => !existingAliases.includes(alias));
      await ctx.database.set('arcades', { _id: arcade._id }, { names: arcade.names });
      return `机厅「${arcade.names[0]}」已成功删除别名：${existingAliases.join('，')}。`;
    });

  ctx
    .command('nearcade')
    .subcommand('info <name>')
    .alias('查询机厅', '机厅详情', '机厅信息', '机厅')
    .action(async ({ session }, ...segments) => {
      const arcades = await getArcadesByChannelId(session.channelId);
      const name = segments.join(' ').trim();
      let matched: Arcade[] | Shop[] = match(name, arcades);
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      if (!matched.length) {
        const result = await client.findArcades(name, 5);
        if (typeof result === 'string') {
          return `请求失败：${result}`;
        }
        if (!result.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
        if (result.length > 1) {
          return (
            '找到多个匹配的机厅，请使用更具体的名称或别名：\n' +
            result.map((item) => `- ${item.name}`).join('\n')
          );
        }
        matched = result;
      }
      const arcade = matched[0];
      let shop: Shop;
      if ('names' in arcade) {
        const result = await client.getArcade(arcade.source, arcade.id);
        if (typeof result === 'string') {
          return `请求失败：${result}`;
        }
        shop = result.shop;
      } else {
        shop = arcade;
      }
      const message =
        `机厅「${shop.name}」：\n` +
        `- ID：${shop.source.toUpperCase()}/${shop.id}\n` +
        ('names' in arcade ? `- 别名：${arcade.names.slice(1).join('，') || '无'}\n` : '') +
        `- 机台列表：\n` +
        shop.games
          .map(
            (game) =>
              `  - ${printGame(game)} (ID: ${game.gameId}) ×${game.quantity}` +
              ('defaultGame' in arcade && arcade.defaultGame === game ? ' [默认]' : '') +
              ('gameAliases' in arcade
                ? `\n    别名：${arcade.gameAliases.find((item) => item.gameId === game.gameId)?.aliases.join('，') || '无'}`
                : '')
          )
          .join('\n') +
        `\n` +
        `- 地址：${shop.source === 'ziv' ? `${shop.address.detailed} / ${shop.address.general.toReversed().join(', ')}` : `${shop.address.general.join('·')} / ${shop.address.detailed}`}\n` +
        `- 更多信息：${urlBase}/shops/${shop.source}/${shop.id}` +
        ('registrantId' in arcade
          ? '\n' +
            `- 由 ${arcade.registrantName} (${arcade.registrantId}) 绑定于 ${new Date(arcade.registeredAt).toLocaleString()}`
          : '');
      return shop.games.length > 1 ? toForwarded(message) : message;
    });

  ctx
    .command('nearcade')
    .subcommand('default-game <name> <gameId>')
    .alias('设置默认机台', '默认机台', '设置默认游戏', '默认游戏')
    .action(async ({ session }, name, gameIdStr) => {
      const gameId = parseInt(gameIdStr);
      if (isNaN(gameId)) return '无效的机台 ID。';
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.source, arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      await ctx.database.set('arcades', { _id: arcade._id }, { defaultGame: game });
      return `机厅「${arcade.names[0]}」的默认机台已成功设置为「${printGame(game)}」。`;
    });

  ctx
    .command('nearcade')
    .subcommand('alias.game.add <name> <gameId> [...aliases]')
    .alias('添加机台别名', '添加游戏别名')
    .action(async ({ session }, name, gameIdStr, ...aliases) => {
      if (!aliases.length) return '请至少提供一个别名。';
      const gameId = parseInt(gameIdStr);
      if (isNaN(gameId)) return '无效的机台 ID。';
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.source, arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      const newAliases = aliases.filter(
        (alias) =>
          !arcade.gameAliases.some((item) => item.gameId === gameId && item.aliases.includes(alias))
      );
      if (!newAliases.length) return '提供的别名均已存在或与其他机台冲突。';
      arcade.gameAliases.push({ gameId, aliases: newAliases });
      await ctx.database.set('arcades', { _id: arcade._id }, { gameAliases: arcade.gameAliases });
      return `机台「${printGame(game)}」已成功添加别名：${newAliases.join('，')}。`;
    });

  ctx
    .command('nearcade')
    .subcommand('alias.game.remove <name> <gameId> [...aliases]')
    .alias('删除机台别名', '删除游戏别名')
    .action(async ({ session }, name, gameIdStr, ...aliases) => {
      if (!aliases.length) return '请至少提供一个别名。';
      const gameId = parseInt(gameIdStr);
      if (isNaN(gameId)) return '无效的机台 ID。';
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = arcades.filter((item) => {
        if (item.names.includes(name)) return true;
        const parts = name.split('/');
        if (parts.length !== 2) return false;
        return item.source === parts[0].toLowerCase() && item.id === parseInt(parts[1]);
      });
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.source, arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      const aliasEntry = arcade.gameAliases.find((item) => item.gameId === gameId);
      if (!aliasEntry) return '该机台尚未添加任何别名，无法删除。';
      const existingAliases = aliases.filter((alias) => aliasEntry.aliases.includes(alias));
      if (!existingAliases.length) return '提供的别名均不存在，无法删除。';
      aliasEntry.aliases = aliasEntry.aliases.filter((alias) => !existingAliases.includes(alias));
      if (!aliasEntry.aliases.length) {
        arcade.gameAliases = arcade.gameAliases.filter((item) => item.gameId !== gameId);
      }
      await ctx.database.set('arcades', { _id: arcade._id }, { gameAliases: arcade.gameAliases });
      return `机台「${printGame(game)}」已成功删除别名：${existingAliases.join('，')}。`;
    });
};
