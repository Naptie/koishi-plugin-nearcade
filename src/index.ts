import { Context, Schema, Session } from 'koishi';
import { Client } from './client';
import { Arcade, AttendanceReport, AttendanceResponse, Shop } from './types';

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
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().required().description('nearcade API 地址').role('url'),
  apiToken: Schema.string().required().description('nearcade API 令牌').role('secret'),
  selfId: Schema.string().required().description('nearcade 用户 ID')
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
  'jr',
  'jgr',
  'dsr',
  'yjr',
  'yjgr',
  'ydsr',
  '几',
  '几人',
  '几个人',
  '多少人',
  '有几人',
  '有几个人',
  '有多少人'
].sort((a, b) => b.length - a.length);

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

  const printArcades = (arcades: Arcade[]) =>
    arcades
      .map(
        (item) =>
          `- ${item.names[0]} ${item.source.toUpperCase()}/${item.id}` +
          `\n  别名：${item.names.slice(1).join('，') || '无'}` +
          `\n  默认机台：${item.defaultGame.name} (${item.defaultGame.version}) (ID: ${item.defaultGame.gameId})` +
          `\n  由 ${item.registrantName} (${item.registrantId}) 绑定于 ${new Date(item.registeredAt).toLocaleString()}`
      )
      .join('\n');

  const bind = async (shop: Shop, aliases: string[] = [], session: Session) => {
    const exists = await ctx.database.get('arcades', {
      source: shop.source,
      id: shop.id,
      channelId: session.channelId
    });
    if (exists.length > 0)
      return `该机厅已由 ${exists[0].registrantName} (${exists[0].registrantId}) 绑定于 ${new Date(exists[0].registeredAt).toLocaleString()}，无需重复绑定。`;
    const defaultGame = shop.games.sort((a, b) =>
      a.titleId === b.titleId ? a.gameId - b.gameId : a.titleId - b.titleId
    )[0];
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
    return `机厅「${shop.name}」绑定成功，默认机台为「${defaultGame.name}」(${defaultGame.version})。`;
  };

  ctx.on('message', async (session) => {
    if (attendanceQuerySuffix.some((suffix) => session.content.endsWith(suffix))) {
      const suffix = attendanceQuerySuffix.find((suffix) => session.content.endsWith(suffix));
      const query = session.content.slice(0, -suffix!.length).trim();
      if (!query) return;
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return;
      const matched = arcades.filter((item) => item.names.some((name) => query.startsWith(name)));
      if (matched.length === 0 && !['机厅', 'jt'].includes(query)) return;
      const arcadeQuery: (Arcade & {
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
      await session.send(
        '实时在勤情况：\n' +
          (
            await Promise.all(
              arcadeQuery.map(async (arcade) => {
                if (!arcade.data) {
                  return `- 机厅「${arcade.names[0]}」在勤人数获取失败`;
                }
                const { total, games, reported, registered } = arcade.data;
                const report = reported.at(0);
                const reportedBySelf = report?.reportedBy === ctx.config.selfId;
                console.log(report, ctx.config.selfId, reportedBySelf);
                let reporter: string;
                if (reportedBySelf) {
                  const { reporterId, reporterName } = await getReport(arcade.source, arcade.id);
                  reporter = `${reporterName} (${reporterId})`;
                } else {
                  reporter = report.reporter.displayName || `@${report.reporter.name}`;
                }
                const lines = [
                  `- 机厅「${arcade.names[0]}」当前共有 ${total} 人在勤${report ? `（由 ${reporter} 上报于 ${new Date(report.reportedAt).toLocaleString()}）` : ''}`
                ];
                if (games.length) {
                  lines.push(
                    ...games
                      .filter(
                        (game) =>
                          reported.some((r) => r.gameId === game.gameId) ||
                          registered.some((r) => r.gameId === game.gameId)
                      )
                      .map((game) => `  - ${game.name} (${game.version}): ${game.total} 人`)
                  );
                }
                return lines.join('\n');
              })
            )
          ).join('\n')
      );
      return;
    }
    if (session.content.includes('=')) {
      const [left, right] = session.content.split('=').map((s) => s.trim());
      if (!left || !right) return;
      const count = parseInt(right);
      if (isNaN(count) || count < 0 || count > 99) return;
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return;
      for (const arcade of arcades) {
        let gameId = arcade.defaultGame.gameId;
        let success = arcade.names.includes(left);
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
            await session.send(`上报机厅「${arcade.names[0]}」在勤人数失败：${result}`);
          } else if (result.success) {
            const game = arcadeData.shop.games.find((g) => g.gameId === gameId) || {
              name: '未知机台',
              version: '未知版本'
            };
            await session.send(
              `成功上报机厅「${arcade.names[0]}」的机台「${game.name}」(${game.version}) 在勤人数为 ${count} 人。`
            );
            await createReport(arcade.source, arcade.id, session.userId, session.username);
          } else {
            await session.send(`上报机厅「${arcade.names[0]}」在勤人数失败：未知错误`);
          }
          break;
        }
      }
    }
  });

  ctx
    .command('nearcade')
    .subcommand('bind <query> [...aliases]')
    .alias('绑定机厅', '添加机厅', 'add')
    .action(async ({ session }, query, ...aliases) => {
      const result = await client.findArcades(query);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const shops = result;
      if (!shops.length) return '未查询到相关机厅';
      if (shops.length === 1) {
        const shop = shops[0];
        return bind(shop, aliases, session);
      } else {
        const message =
          `查询到以下机厅（共 ${shops.length} 家）：\n` +
          shops.map((item, index) => `${index + 1}. ${item.name}`).join('\n') +
          '\n请输入对应的序号以绑定机厅，或发送“取消”以取消操作。序号后可附加数个空格间隔的机厅别名。';
        const forward = shops.length > 5;
        await session.send(forward ? `<message forward>${message}</message>` : message);
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
    .action(async ({ session }, name) => {
      const arcades = await getArcadesByChannelId(session.channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
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
    let matched = [];
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
    .action(async ({ session }, name) => {
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
      return (
        `机厅「${arcade.names[0]}」：\n` +
        `- ID：${arcade.source.toUpperCase()}/${arcade.id}\n` +
        `- 别名：${arcade.names.slice(1).join('，') || '无'}\n` +
        `- 默认机台：${arcade.defaultGame.name} (${arcade.defaultGame.version}) (ID: ${arcade.defaultGame.gameId})\n` +
        `- 机台列表：\n` +
        shop.games
          .map(
            (game) =>
              `  - ${game.name} (${game.version}) (ID: ${game.gameId}) ×${game.quantity}` +
              `\n    别名：${arcade.gameAliases.find((item) => item.gameId === game.gameId)?.aliases.join('，') || '无'}`
          )
          .join('\n') +
        `\n` +
        `- 地址：${shop.source === 'ziv' ? `${shop.address.detailed} / ${shop.address.general.toReversed().join(', ')}` : `${shop.address.general.join('·')} / ${shop.address.detailed}`}\n` +
        `- 更多信息：https://nearcade.phizone.cn/shops/${shop.source}/${shop.id}\n` +
        `- 由 ${arcade.registrantName} (${arcade.registrantId}) 绑定于 ${new Date(arcade.registeredAt).toLocaleString()}`
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
      return `机厅「${arcade.names[0]}」的默认机台已成功设置为「${game.name}」(${game.version})。`;
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
      return `机台「${game.name}」(${game.version}) 已成功添加别名：${newAliases.join('，')}。`;
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
      return `机台「${game.name}」(${game.version}) 已成功删除别名：${existingAliases.join(
        '，'
      )}。`;
    });
};
