import { Context, h, Schema, Session } from 'koishi';
import { Client } from './client';
import {
  Arcade,
  ArcadeGameAlias,
  AttendanceReport,
  AttendanceResponse,
  CustomAttendanceReport,
  CustomShop,
  DiscoverySettings,
  Game,
  GroupSettings,
  Shop
} from './types';
import zhCN from '../locales/zh-CN.yml';
import { compressDiscoverUrl } from './utils';

type StoredArcadeRow = Arcade;

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
    .default('https://nearcade.cn')
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

const plusOperators = ['+', '＋', '➕'] as const;
const minusOperators = ['-', '－', '➖'] as const;
const attendanceOperators = ['=', '＝', '🟰', ...plusOperators, ...minusOperators] as const;

const isPlus = (op: string) => plusOperators.includes(op as (typeof plusOperators)[number]);
const isMinus = (op: string) => minusOperators.includes(op as (typeof minusOperators)[number]);

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

const SHOP_ID_OFFSET_BEMANICN = 10000;
const SHOP_ID_OFFSET_ZIV = 20000;
const MIGRATION_VERSION_CURRENT = 1;
const MIGRATION_VERSION_FAILED = 0;

const formatArcadeId = (shop: { id: number }) => `${shop.id}`;

const dedupeText = (values: string[] = []) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
};

const isSameGameExact = (left: Partial<Game>, right: Game) =>
  left.titleId === right.titleId &&
  left.name === right.name &&
  left.version === right.version &&
  (left.comment ?? '') === right.comment &&
  (left.quantity ?? 1) === right.quantity &&
  (left.cost ?? '') === right.cost;

const isSameGameIdentity = (left: Partial<Game>, right: Game) =>
  left.titleId === right.titleId && left.name === right.name && left.version === right.version;

const getLowestGame = (shop: Shop) => shop.games.toSorted((a, b) => a.gameId - b.gameId)[0];

const getLowestGameByTitleId = (shop: Shop, titleId: number) =>
  shop.games.filter((game) => game.titleId === titleId).toSorted((a, b) => a.gameId - b.gameId)[0];

const resolveStoredGame = (stored: Partial<Game> | undefined, shop: Shop) => {
  if (!stored) return undefined;
  if (typeof stored.gameId === 'number') {
    const matchedById = shop.games.find((game) => game.gameId === stored.gameId);
    if (matchedById) return matchedById;
  }
  const matchedByExact = shop.games.find((game) => isSameGameExact(stored, game));
  if (matchedByExact) return matchedByExact;
  const matchedByIdentity = shop.games.find((game) => isSameGameIdentity(stored, game));
  if (matchedByIdentity) return matchedByIdentity;
  if (typeof stored.titleId === 'number') {
    return getLowestGameByTitleId(shop, stored.titleId);
  }
};

const inferTitleIdFromAliases = (aliases: string[] = []) => {
  for (const alias of aliases) {
    const normalized = alias.trim().toLowerCase();
    const title = gameTitles.find((item) => item.names.includes(normalized));
    if (title) return title.titleId;
  }
};

const toArcadeGameAlias = (game: Game, aliases: string[]): ArcadeGameAlias => ({
  gameId: game.gameId,
  titleId: game.titleId,
  name: game.name,
  version: game.version,
  comment: game.comment,
  quantity: game.quantity,
  cost: game.cost,
  aliases: dedupeText(aliases)
});

const resolveAliasEntryGame = (entry: ArcadeGameAlias, shop: Shop) => {
  const matched = resolveStoredGame(entry, shop);
  if (matched) return matched;
  const inferredTitleId = inferTitleIdFromAliases(entry.aliases);
  if (typeof inferredTitleId === 'number') {
    return getLowestGameByTitleId(shop, inferredTitleId);
  }
  if (shop.games.length === 1) {
    return shop.games[0];
  }
};

const mergeArcadeGameAliases = (entries: ArcadeGameAlias[] = [], shop?: Shop) => {
  const merged = new Map<string, ArcadeGameAlias>();

  for (const entry of entries) {
    const aliases = dedupeText(entry.aliases);
    if (!aliases.length) continue;

    const resolved = shop ? resolveAliasEntryGame(entry, shop) : undefined;
    const next = resolved ? toArcadeGameAlias(resolved, aliases) : { ...entry, aliases };
    const key = resolved
      ? `game:${resolved.gameId}`
      : `legacy:${entry.gameId}:${entry.titleId ?? ''}:${entry.name ?? ''}:${entry.version ?? ''}`;
    const previous = merged.get(key);

    if (previous) {
      previous.aliases = dedupeText([...previous.aliases, ...next.aliases]);
    } else {
      merged.set(key, next);
    }
  }

  return [...merged.values()];
};

const createMigratedArcade = (arcade: StoredArcadeRow, remoteShop: Shop): Arcade => ({
  ...arcade,
  id: remoteShop.id,
  version: MIGRATION_VERSION_CURRENT,
  defaultGame: resolveStoredGame(arcade.defaultGame, remoteShop) || getLowestGame(remoteShop),
  gameAliases: mergeArcadeGameAliases(arcade.gameAliases || [], remoteShop)
});

const createMigrationFailedArcade = (arcade: StoredArcadeRow): Arcade => ({
  ...arcade,
  version: MIGRATION_VERSION_FAILED
});

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
      id: 'integer',
      version: 'integer',
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

  const shopCache = new Map<number, Promise<Shop | undefined>>();

  const getArcadeMigrationVersion = (arcade: StoredArcadeRow) =>
    typeof arcade.version === 'number' ? arcade.version : undefined;

  const needsArcadeMigration = (arcade: StoredArcadeRow) =>
    (getArcadeMigrationVersion(arcade) ?? -1) < MIGRATION_VERSION_CURRENT;

  const isArcadeMigrated = (arcade: StoredArcadeRow) => !needsArcadeMigration(arcade);

  const findRemoteShopMigrationTarget = async (arcade: StoredArcadeRow) => {
    const primaryName = arcade.names[0]?.trim();
    if (!primaryName) return undefined;

    const searched = await client.findArcades(primaryName, 20, 20);
    if (typeof searched === 'string') return undefined;

    const exactMatches = searched.filter((shop) => shop.name.trim() === primaryName);
    if (exactMatches.length === 1) {
      return exactMatches[0];
    }

    const fallbackIds = [SHOP_ID_OFFSET_BEMANICN + arcade.id, SHOP_ID_OFFSET_ZIV + arcade.id];
    for (const candidateId of fallbackIds) {
      const shop = await getShopById(candidateId);
      if (shop) return shop;
    }
  };

  const getShopById = async (id: number) => {
    if (!shopCache.has(id)) {
      shopCache.set(
        id,
        (async () => {
          const result = await client.getArcade(id);
          if (typeof result === 'string') return undefined;
          return result.shop;
        })()
      );
    }
    return shopCache.get(id)!;
  };

  const hasSameJsonValue = (left: unknown, right: unknown) =>
    JSON.stringify(left) === JSON.stringify(right);

  const normalizeArcadeRecord = (arcade: StoredArcadeRow, shop?: Shop): Arcade => {
    const names = dedupeText(arcade.names);
    const base: Arcade = {
      ...arcade,
      names,
      version: getArcadeMigrationVersion(arcade)
    };

    if (!shop) {
      return needsArcadeMigration(base) ? createMigrationFailedArcade(base) : base;
    }

    return createMigratedArcade(base, shop);
  };

  const persistArcade = async (arcade: StoredArcadeRow, shop?: Shop) => {
    const normalized = normalizeArcadeRecord(arcade, shop);
    const updates: Partial<Arcade> = {};

    if (normalized.id !== arcade.id) updates.id = normalized.id;
    if (normalized.version !== arcade.version) updates.version = normalized.version;
    if (!hasSameJsonValue(normalized.names, arcade.names)) updates.names = normalized.names;
    if (!hasSameJsonValue(normalized.defaultGame, arcade.defaultGame)) {
      updates.defaultGame = normalized.defaultGame;
    }
    if (!hasSameJsonValue(normalized.gameAliases, arcade.gameAliases)) {
      updates.gameAliases = normalized.gameAliases;
    }

    if (Object.keys(updates).length) {
      await ctx.database.set('arcades', { _id: arcade._id }, updates);
    }

    return normalized;
  };

  const ensureArcadeCurrent = async (arcade: StoredArcadeRow, shop?: Shop) => {
    let liveShop = shop;
    if (!liveShop) {
      liveShop = isArcadeMigrated(arcade)
        ? await getShopById(arcade.id)
        : await findRemoteShopMigrationTarget(arcade);
    }
    return persistArcade(arcade, liveShop);
  };

  const syncArcades = async () => {
    const arcades = (await ctx.database.get('arcades', {})) as StoredArcadeRow[];
    const arcadeGroups = new Map<string, StoredArcadeRow[]>();

    for (const arcade of arcades) {
      const key = `${arcade.channelId}:${arcade.id}`;
      if (!arcadeGroups.has(key)) arcadeGroups.set(key, []);
      arcadeGroups.get(key)!.push(arcade);
    }

    for (const group of arcadeGroups.values()) {
      const primary = [...group].sort((a, b) => a._id - b._id)[0];
      const migratedPrimary = await ensureArcadeCurrent(primary);
      const earliest = [...group].sort(
        (a, b) => new Date(a.registeredAt).getTime() - new Date(b.registeredAt).getTime()
      )[0];
      const mergedNames = dedupeText(group.flatMap((item) => item.names));
      const liveShop =
        migratedPrimary.version === MIGRATION_VERSION_CURRENT
          ? await getShopById(migratedPrimary.id)
          : undefined;
      const mergedAliases = mergeArcadeGameAliases(
        group.flatMap((item) => item.gameAliases || []),
        liveShop
      );
      const resolvedDefaultGame = liveShop
        ? group
            .map((item) => resolveStoredGame(item.defaultGame, liveShop))
            .find((item) => !!item) ||
          getLowestGame(liveShop) ||
          migratedPrimary.defaultGame
        : migratedPrimary.defaultGame;

      await ctx.database.set(
        'arcades',
        { _id: primary._id },
        {
          id: migratedPrimary.id,
          version: migratedPrimary.version,
          names: mergedNames,
          defaultGame: resolvedDefaultGame,
          gameAliases: mergedAliases,
          registrantId: earliest.registrantId,
          registrantName: earliest.registrantName,
          registeredAt: earliest.registeredAt
        }
      );

      for (const duplicate of group.filter((item) => item._id !== primary._id)) {
        await ctx.database.remove('arcades', { _id: duplicate._id });
      }
    }

    await Promise.all(
      (await ctx.database.get('attendanceReports', {})).map(async (report) => {
        const linkedArcades = await ctx.database.get('arcades', { id: report.id });
        if (linkedArcades.length) return;
        const candidate = arcades.find(
          (arcade) => arcade.id === report.id || arcade._id === report.id
        );
        if (!candidate) return;
        const migrated = await ensureArcadeCurrent(candidate);
        if (migrated.id !== report.id) {
          await ctx.database.set('attendanceReports', { _id: report._id }, { id: migrated.id });
        }
      })
    );
  };

  let migrationPromise: Promise<void> | undefined;

  const ensureMigrated = () => {
    if (!migrationPromise) {
      migrationPromise = syncArcades().catch((error) => {
        migrationPromise = undefined;
        throw error;
      });
    }
    return migrationPromise;
  };

  ctx.on('ready', () => void ensureMigrated());

  const getArcadesByChannelId = async (channelId: string) => {
    await ensureMigrated();
    const arcades = (await ctx.database.get('arcades', { channelId })) as StoredArcadeRow[];
    return Promise.all(arcades.map((arcade) => ensureArcadeCurrent(arcade)));
  };

  const getReport = async (id: number) => {
    await ensureMigrated();
    return (await ctx.database.get('attendanceReports', { id }))[0];
  };

  const createReport = async (id: number, reporterId: string, reporterName: string) => {
    await ensureMigrated();
    const existing = await ctx.database.get('attendanceReports', { id });
    if (existing.length) {
      await ctx.database.set(
        'attendanceReports',
        { _id: existing[0]._id },
        { reporterId, reporterName }
      );
    } else {
      await ctx.database.create('attendanceReports', {
        id,
        reporterId,
        reporterName
      });
    }
  };

  const printGame = ({ name, version }: { name: string; version: string }) =>
    version ? `${name} (${version})` : name;

  const formatShopAddress = (shop: Shop) => {
    const general = shop.address.general.filter(Boolean).join('·');
    const detailed = shop.address.detailed?.trim();
    return [general, detailed].filter(Boolean).join(' / ') || '未知';
  };

  const printArcades = (arcades: Arcade[]) =>
    arcades
      .map(
        (item) =>
          `- ${item.names[0]} ${formatArcadeId(item)}` +
          `\n  别名：${item.names.slice(1).join('，') || '无'}` +
          `\n  默认机台：${printGame(item.defaultGame)} (ID: ${item.defaultGame.gameId})` +
          `\n  由 ${item.registrantName} (${item.registrantId}) 绑定于 ${new Date(item.registeredAt).toLocaleString()}`
      )
      .join('\n');

  const getDefaultGame = (shop: Shop) => getLowestGame(shop);

  const bind = async (shop: Shop, aliases: string[] = [], session: Session) => {
    await ensureMigrated();
    const { channelId, userId, username } = getSessionContext(session);
    const unifiedId = shop.id;
    const exists = await ctx.database.get('arcades', {
      id: unifiedId,
      channelId
    });
    if (exists.length > 0)
      return `该机厅已由 ${exists[0].registrantName} (${exists[0].registrantId}) 绑定于 ${new Date(exists[0].registeredAt).toLocaleString()}，无需重复绑定。`;
    const defaultGame = getDefaultGame(shop);
    if (!defaultGame) {
      return '该机厅未收录任何机台，无法绑定。';
    }
    await ctx.database.create('arcades', {
      id: unifiedId,
      names: dedupeText([shop.name, ...aliases]),
      defaultGame,
      gameAliases: [],
      channelId,
      registrantId: userId,
      registrantName: username,
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
    const { channelId, userId, username } = getSessionContext(session);
    let count = countInput;
    if (isPlus(operator) || isMinus(operator)) {
      if ('aliases' in arcade) {
        const report = (
          await ctx.database.get('customAttendanceReports', {
            shop: arcade.id,
            channelId
          })
        )[0];
        const existing = report?.count || 0;
        count = Math.max(0, isPlus(operator) ? existing + count : existing - count);
      } else {
        const attendance = await client.getAttendance(arcade.id);
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
        channelId
      });
      await ctx.database.create('customAttendanceReports', {
        shop: arcade.id,
        channelId,
        count,
        reporterId: userId,
        reporterName: username,
        reportedAt: new Date().toISOString()
      });
      return `成功上报机厅「${arcade.aliases[0]}」在勤人数为 ${count} 人。`;
    } else {
      const settings = (await ctx.database.get('groupSettings', { channelId }))[0];
      const isPrivate = settings?.private;
      const group = isPrivate
        ? session.event._data.group_name || '私密群组'
        : session.event._data.group_name
          ? `${session.event._data.group_name} (${channelId})`
          : channelId;
      const result = await client.reportAttendance(
        arcade.id,
        gameId!,
        count,
        `由 ${username} (${userId}) 从 ${isPrivate && !session.event._data.group_name ? '' : 'QQ 群 '}${group} 上报`
      );
      if (typeof result === 'string') {
        return `上报机厅「${arcade.name}」在勤人数失败：${result}`;
      } else if (result.success) {
        const game = arcade.games.find((g) => g.gameId === gameId) || {
          name: '未知机台',
          version: '未知版本',
          quantity: 1
        };
        await createReport(arcade.id, userId, username);
        return `「${arcade.name}」\n- ${printGame(game)}：${count} 人（均 ${(count / game.quantity).toFixed(1)}）`;
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

  const getSessionContext = (session?: Session) => ({
    channelId: session?.channelId ?? `private:${session?.userId ?? 'unknown'}`,
    userId: session?.userId ?? 'unknown',
    username: session?.username ?? '未知用户',
    content: session?.content ?? ''
  });

  ctx.on('message', async (session) => {
    const { channelId, content } = getSessionContext(session);
    const trimmedContent = content.trim();
    const lowerContent = trimmedContent.toLowerCase();

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
          const settings = (await ctx.database.get('discoverySettings', { channelId }))[0];
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
                const currentAttendance = shop.currentReportedAttendance;
                if (currentAttendance) {
                  const reportedBySelf = currentAttendance.reportedBy === ctx.config.selfId;
                  if (reportedBySelf) {
                    const report = await getReport(shop.id);
                    reporter = report ? `${report.reporterName} (${report.reporterId})` : null;
                  } else {
                    const user = currentAttendance.reporter;
                    reporter = user.displayName || `@${user.name}`;
                  }
                }
                lines.push(
                  `-「${shop.name}」${formatDistance(shop.distance)} ${shop.totalAttendance} 人${reporter && currentAttendance ? ` [${reporter} @ ${new Date(currentAttendance.reportedAt).toLocaleTimeString()}]` : ''}`
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
    if (lowerContent === 'nearcade' && ctx.config.helpOnMention !== false) {
      await session.send(getHelpMessage());
      return;
    }
    if (attendanceQuerySuffix.some((suffix) => lowerContent.endsWith(suffix))) {
      const arcades = await getArcadesByChannelId(channelId);
      const suffix = attendanceQuerySuffix.find((suffix) => lowerContent.endsWith(suffix));
      const query = content.slice(0, -suffix!.length).trim().toLowerCase();
      const customShop = ctx.config.customShops.find((shop: CustomShop) =>
        shop.aliases.some((alias) => alias.trim().toLowerCase() === query)
      ) as CustomShop;
      let matched: {
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
          if ('aliases' in arcade) {
            const report = (
              await ctx.database.get('customAttendanceReports', {
                shop: arcade.id,
                channelId
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
          const result = await client.getAttendance(arcade.id);
          if (typeof result === 'string') {
            return;
          }
          arcade.data = result;
        })
      );
      if (arcadeQuery.length > 0) {
        const message = (
          await Promise.all(
            arcadeQuery.map(async (arcade) => {
              if (!arcade.data) {
                return `「${('names' in arcade ? arcade.names : arcade.aliases)[0]}」获取失败`;
              }
              const { total, games, reported, registered } = arcade.data;
              if ('aliases' in arcade) {
                const reporter = arcade.customReporter;
                return `「${arcade.aliases[0]}」${total} 人${reporter ? ` [${reporter.name} (${reporter.id}) @ ${new Date(reporter.time).toLocaleTimeString()}]` : ''}`;
              }
              const report = reported[0];
              let reporter: string | null = null;
              if (report) {
                const reportedBySelf = report.reportedBy === ctx.config.selfId;
                if (reportedBySelf) {
                  const savedReport = await getReport(arcade.id);
                  reporter = savedReport
                    ? `${savedReport.reporterName} (${savedReport.reporterId})`
                    : null;
                } else {
                  reporter = report.reporter.displayName || `@${report.reporter.name}`;
                }
              }
              const lines = [
                `「${arcade.names[0]}」${total} 人${reporter ? ` [${reporter} @ ${new Date(report.reportedAt).toLocaleTimeString()}]` : ''}`
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
      }
      return;
    }
    const reportQueue: {
      count: number;
      operator: (typeof attendanceOperators)[number];
      gameId?: number;
      shop: Shop | CustomShop;
    }[] = [];
    const settings = (await ctx.database.get('groupSettings', { channelId }))[0];
    const allowSearch = settings?.search !== false;
    for (const line of content.split('\n')) {
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
      if (!left) {
        continue;
      }
      if (left.replace(/[^\p{L}\p{N}_]/gu, '').length < 2) {
        doSearch = false;
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
      if (!right) continue;
      const count = parseInt(right, 10);
      const customShop = ctx.config.customShops.find((shop: CustomShop) =>
        shop.aliases.some((alias) => alias.trim().toLowerCase() === left)
      ) as CustomShop;
      if (
        isNaN(count) ||
        count < 0 ||
        count > (customShop ? Infinity : 99) ||
        count.toString() !== right
      )
        continue;
      if (customShop) {
        reportQueue.push({
          count,
          operator,
          shop: customShop
        });
        continue;
      }
      let success = false;
      const arcades = await getArcadesByChannelId(channelId);
      for (const arcade of arcades) {
        let gameId = arcade.defaultGame.gameId;
        const arcadeData = await client.getArcade(arcade.id);
        if (typeof arcadeData === 'string') continue;
        const currentArcade = await ensureArcadeCurrent(arcade, arcadeData.shop);
        success = currentArcade.names.includes(left);
        if (!success) {
          for (let i = 1; i < left.length; i++) {
            const arcadeName = left.slice(0, i).toLowerCase().trim();
            if (!currentArcade.names.includes(arcadeName)) continue;
            const gameName = left.slice(i).toLowerCase().trim();
            const aliasedGameId = currentArcade.gameAliases.find((g) =>
              g.aliases.includes(gameName)
            )?.gameId;
            if (aliasedGameId !== undefined) {
              gameId = aliasedGameId;
              success = true;
              break;
            } else {
              const titleMatchedGameId = arcadeData.shop.games.find(
                (g) => g.titleId === gameTitles.find((g) => g.names.includes(gameName))?.titleId
              )?.gameId;
              if (titleMatchedGameId !== undefined) {
                gameId = titleMatchedGameId;
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
          continue;
        }
        if (matched.length === 0) continue;
        if (matched.length > 1) {
          await session.send(
            '找到多个匹配的机厅，请使用更具体的名称或别名：\n' +
              matched.map((item) => `- ${item.name}`).join('\n')
          );
          continue;
        }
        const defaultGame = getDefaultGame(matched[0]);
        if (!defaultGame) {
          await session.send(`机厅「${matched[0].name}」未收录任何机台，无法上报在勤人数。`);
          continue;
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
      if (!session) return '会话不可用。';
      const option = (optionStr || '').trim().toLowerCase();
      const { channelId, userId, username } = getSessionContext(session);
      let settings: Omit<DiscoverySettings, '_id'> = (
        await ctx.database.get('discoverySettings', { channelId })
      )[0];
      if (!settings) {
        settings = {
          channelId,
          off: false,
          radius: 10,
          operatorId: userId,
          operatorName: username,
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
          { channelId },
          {
            off: true,
            operatorId: userId,
            operatorName: username,
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
          { channelId },
          {
            off: false,
            operatorId: userId,
            operatorName: username,
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
        { channelId },
        {
          radius,
          operatorId: userId,
          operatorName: username,
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
      if (!session) return '会话不可用。';
      const option = (optionStr || '').trim().toLowerCase();
      const { channelId, userId, username } = getSessionContext(session);
      let settings = (await ctx.database.get('groupSettings', { channelId }))[0];
      if (!settings) {
        settings = {
          channelId,
          private: false,
          search: true,
          operatorId: userId,
          operatorName: username,
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
          { channelId },
          {
            private: false,
            operatorId: userId,
            operatorName: username,
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
          { channelId },
          {
            private: true,
            operatorId: userId,
            operatorName: username,
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
      if (!session) return '会话不可用。';
      const option = (optionStr || '').trim().toLowerCase();
      const { channelId, userId, username } = getSessionContext(session);
      let settings = (await ctx.database.get('groupSettings', { channelId }))[0];
      if (!settings) {
        settings = {
          channelId,
          private: false,
          search: true,
          operatorId: userId,
          operatorName: username,
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
          { channelId },
          {
            search: false,
            operatorId: userId,
            operatorName: username,
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
          { channelId },
          {
            search: true,
            operatorId: userId,
            operatorName: username,
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
      if (!session) return '会话不可用。';
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
            let identifier = formatArcadeId(item);
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      return '本群聊已绑定以下机厅：\n' + printArcades(arcades);
    });

  ctx
    .command('nearcade')
    .subcommand('unbind <name>')
    .alias('解绑机厅', '删除机厅', 'remove')
    .action(async ({ session }, ...segments) => {
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
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
    const normalizedName = name.trim();
    return arcades.filter((item) => {
      if (item.names.includes(normalizedName)) return true;
      if (normalizedName === formatArcadeId(item)) return true;
      const numeric = parseInt(normalizedName, 10);
      return !isNaN(numeric) && item.id === numeric;
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
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
        const result = await client.getArcade(arcade.id);
        if (typeof result === 'string') {
          return `请求失败：${result}`;
        }
        shop = result.shop;
      } else {
        shop = arcade;
      }
      const savedArcade = 'names' in arcade ? await ensureArcadeCurrent(arcade, shop) : undefined;
      const message =
        `机厅「${shop.name}」：\n` +
        `- ID：${formatArcadeId(shop)}\n` +
        (savedArcade ? `- 别名：${savedArcade.names.slice(1).join('，') || '无'}\n` : '') +
        `- 机台列表：\n` +
        shop.games
          .map(
            (game) =>
              `  - ${printGame(game)} (ID: ${game.gameId}) ×${game.quantity}` +
              (savedArcade && savedArcade.defaultGame.gameId === game.gameId ? ' [默认]' : '') +
              (savedArcade
                ? `\n    别名：${savedArcade.gameAliases.find((item) => item.gameId === game.gameId)?.aliases?.join('，') || '无'}`
                : '')
          )
          .join('\n') +
        `\n` +
        `- 地址：${formatShopAddress(shop)}\n` +
        `- 更多信息：${urlBase}/shops/${shop.id}` +
        (savedArcade
          ? '\n' +
            `- 由 ${savedArcade.registrantName} (${savedArcade.registrantId}) 绑定于 ${new Date(savedArcade.registeredAt).toLocaleString()}`
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      await ensureArcadeCurrent(arcade, shop);
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      const normalizedArcade = await ensureArcadeCurrent(arcade, shop);
      const newAliases = aliases.filter(
        (alias) =>
          !normalizedArcade.gameAliases.some(
            (item) => item.gameId === gameId && item.aliases.includes(alias)
          )
      );
      if (!newAliases.length) return '提供的别名均已存在或与其他机台冲突。';
      const gameAliases = mergeArcadeGameAliases(
        [...normalizedArcade.gameAliases, toArcadeGameAlias(game, newAliases)],
        shop
      );
      await ctx.database.set('arcades', { _id: arcade._id }, { gameAliases });
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
      if (!session) return '会话不可用。';
      const { channelId } = getSessionContext(session);
      const arcades = await getArcadesByChannelId(channelId);
      if (!arcades.length) return '本群聊尚未绑定任何机厅。';
      const matched = match(name, arcades);
      if (!matched.length) return '未找到匹配的机厅，请检查名称或别名是否正确。';
      if (matched.length > 1) {
        return '找到多个匹配的机厅，请使用更具体的名称或别名：\n' + printArcades(matched);
      }
      const arcade = matched[0];
      const result = await client.getArcade(arcade.id);
      if (typeof result === 'string') {
        return `请求失败：${result}`;
      }
      const { shop } = result;
      const game = shop.games.find((item) => item.gameId === gameId);
      if (!game) return '未找到对应的机台，请检查机台 ID 是否正确。';
      const normalizedArcade = await ensureArcadeCurrent(arcade, shop);
      const aliasEntry = normalizedArcade.gameAliases.find((item) => item.gameId === gameId);
      if (!aliasEntry) return '该机台尚未添加任何别名，无法删除。';
      const existingAliases = aliases.filter((alias) => aliasEntry.aliases.includes(alias));
      if (!existingAliases.length) return '提供的别名均不存在，无法删除。';
      aliasEntry.aliases = aliasEntry.aliases.filter((alias) => !existingAliases.includes(alias));
      const gameAliases = normalizedArcade.gameAliases.filter((item) => item.aliases.length > 0);
      await ctx.database.set('arcades', { _id: arcade._id }, { gameAliases });
      return `机台「${printGame(game)}」已成功删除别名：${existingAliases.join('，')}。`;
    });
};
