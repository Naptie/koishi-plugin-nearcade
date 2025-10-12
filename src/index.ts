import { Context, h, Schema, Session } from 'koishi';
import { Client } from './client';
import { Arcade, AttendanceReport, AttendanceResponse, Shop } from './types';
import zhCN from '../locales/zh-CN.yml';

declare module 'koishi' {
  interface Tables {
    arcades: Arcade;
    attendanceReports: AttendanceReport;
  }
}

export const name = 'nearcade';
export const inject = ['database'];

export interface Config {
  apiBase: string;
  apiToken: string;
  selfId: string;
  helpMessage?: string;
  helpOnMention?: boolean;
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().required().description('nearcade API 地址').role('url'),
  apiToken: Schema.string().required().description('nearcade API 令牌').role('secret'),
  selfId: Schema.string().required().description('nearcade 用户 ID'),
  helpMessage: Schema.string().description('帮助信息'),
  helpOnMention: Schema.boolean().default(true).description('是否在提及 nearcade 时发送帮助信息')
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

const helpVersion = 2;

export const apply = (ctx: Context) => {
  const client = new Client(ctx.config.apiBase, ctx.config.apiToken);

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
    gameId: number,
    arcade: Shop,
    session: Session
  ) => {
    let count = countInput;
    if (isPlus(operator) || isMinus(operator)) {
      const attendance = await client.getAttendance(arcade.source, arcade.id);
      if (typeof attendance === 'string') {
        return `请求机厅「${arcade.name}」在勤人数失败：${attendance}`;
      }
      const game = attendance.games.find((g) => g.gameId === gameId);
      if (!game) {
        return `机厅「${arcade.name}」不存在 ID 为 ${gameId} 的机台。`;
      }
      count = Math.min(99, Math.max(0, isPlus(operator) ? game.total + count : game.total - count));
    }
    const group = session.event._data.group_name
      ? `${session.event._data.group_name} (${session.channelId})`
      : session.channelId;
    const result = await client.reportAttendance(
      arcade.source,
      arcade.id,
      gameId,
      count,
      `由 ${session.username} (${session.userId}) 从 QQ 群 ${group} 上报`
    );
    if (typeof result === 'string') {
      return `上报机厅「${arcade.name}」在勤人数失败：${result}`;
    } else if (result.success) {
      const game = arcade.games.find((g) => g.gameId === gameId) || {
        name: '未知机台',
        version: '未知版本'
      };
      await createReport(arcade.source, arcade.id, session.userId, session.username);
      return `成功上报机厅「${arcade.name}」的机台「${printGame(game)}」在勤人数为 ${count} 人。`;
    } else {
      return `上报机厅「${arcade.name}」在勤人数失败：未知错误`;
    }
  };

  const toForwarded = (text: string) => `<message forward>${text}</message>`;

  const getHelpMessage = () => {
    let message = h('img', { src: `https://nearcade.phizone.cn/bot-help.png?v=${helpVersion}` });
    if (ctx.config.helpMessage) {
      message = h('p', ctx.config.helpMessage, message);
    }
    return message;
  };

  ctx.on('message', async (session) => {
    if (session.content.trim().toLowerCase() === 'nearcade' && ctx.config.helpOnMention !== false) {
      await session.send(getHelpMessage());
      return;
    }
    const arcades = await getArcadesByChannelId(session.channelId);
    if (attendanceQuerySuffix.some((suffix) => session.content.endsWith(suffix))) {
      const suffix = attendanceQuerySuffix.find((suffix) => session.content.endsWith(suffix));
      const query = session.content.slice(0, -suffix!.length).trim();
      let matched: {
        source: string;
        id: number;
        names: string[];
      }[] = arcades.filter((item) => item.names.some((name) => query.startsWith(name)));
      if (matched.length === 0 && !(!query || ['机厅', 'jt'].includes(query))) {
        if (query.length < 2) {
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
        if (!matched.length) {
          return;
        }
      }
      const arcadeQuery: ((typeof matched)[number] & {
        data?: AttendanceResponse;
      })[] = matched.length > 0 ? matched : arcades;
      await Promise.all(
        arcadeQuery.map(async (arcade) => {
          const result = await client.getAttendance(arcade.source, arcade.id);
          if (typeof result === 'string') {
            await session.send(`请求机厅「${arcade.names[0]}」在勤人数失败：${result}`);
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
                return `-「${arcade.names[0]}」在勤人数获取失败`;
              }
              const { total, games, reported, registered } = arcade.data;
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
                    .map((game) => `  - ${printGame(game)}: ${game.total} 人`)
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
      gameId: number;
      shop: Shop;
    }[] = [];
    for (const line of session.content.split('\n')) {
      for (const operator of attendanceOperators) {
        if (!line.includes(operator)) {
          continue;
        }
        const [left, right] = line.split(operator).map((s) => s.trim());
        if (!left || !right) continue;
        const count = parseInt(right);
        if (isNaN(count) || count < 0 || count > 99 || count.toString() !== right) break;
        let success = false;
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
        if (!success) {
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
    .subcommand('bind <query>')
    .alias('绑定机厅', '添加机厅', 'add')
    .action(async ({ session }, ...segments) => {
      const query = segments.join(' ');
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
    .alias('机厅信息')
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
      return (
        `机厅「${shop.name}」：\n` +
        `- ID：${shop.source.toUpperCase()}/${shop.id}\n` +
        ('names' in arcade
          ? `- 别名：${arcade.names.slice(1).join('，') || '无'}\n` +
            `- 默认机台：${printGame(arcade.defaultGame)} (ID: ${arcade.defaultGame.gameId})\n`
          : '') +
        `- 机台列表：\n` +
        shop.games
          .map(
            (game) =>
              `  - ${printGame(game)} (ID: ${game.gameId}) ×${game.quantity}` +
              ('gameAliases' in arcade
                ? `\n    别名：${arcade.gameAliases.find((item) => item.gameId === game.gameId)?.aliases.join('，') || '无'}`
                : '')
          )
          .join('\n') +
        `\n` +
        `- 地址：${shop.source === 'ziv' ? `${shop.address.detailed} / ${shop.address.general.toReversed().join(', ')}` : `${shop.address.general.join('·')} / ${shop.address.detailed}`}\n` +
        `- 更多信息：https://nearcade.phizone.cn/shops/${shop.source}/${shop.id}` +
        ('registrantId' in arcade
          ? '\n' +
            `- 由 ${arcade.registrantName} (${arcade.registrantId}) 绑定于 ${new Date(arcade.registeredAt).toLocaleString()}`
          : '')
      );
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
