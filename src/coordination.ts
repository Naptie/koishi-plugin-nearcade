import { Context, h, Session } from 'koishi';
import { GroupLink } from './types';

interface OneBotGroup {
  group_id: number | string;
  group_name: string;
  member_count: number;
}

interface OneBotMember {
  user_id: number | string;
}

interface OneBotInternal {
  getGroupList(): Promise<OneBotGroup[]>;
  getGroupMemberList(groupId: number | string): Promise<OneBotMember[]>;
}

interface QQGroupInfo {
  group_openid: string;
  group_name: string;
  group_member_num: number;
}

interface QQGroupState {
  allow_proactive_msg: boolean;
  recv_msg_setting: 'all' | 'only_mention' | 'mention_and_context';
}

interface QQGroupSnapshot {
  at: number;
  info?: QQGroupInfo;
  state?: QQGroupState;
}

interface QQGroupInternal {
  getMe(): Promise<{ id: string; username: string; share_url?: string }>;
  getGuildInfo(groupOpenid: string): Promise<QQGroupInfo>;
  getGuildBotState(groupOpenid: string): Promise<QQGroupState>;
}

interface AdapterBot {
  selfId: string;
  status: number;
  platform?: string;
  hidden?: boolean;
  internal: unknown;
}

interface QQBotLike extends AdapterBot {
  user?: { name?: string };
  guildBot?: {
    internal: QQGroupInternal;
  };
  sendMessage(
    channelId: string,
    content: h.Fragment,
    referrer?: unknown,
    options?: unknown
  ): Promise<string[]>;
}

export interface CoordinationLinkConfig {
  onebotGroupId: string;
  qqGroupOpenid: string;
  onebotSelfId?: string;
  qqSelfId?: string;
}

export interface CoordinationConfig {
  enabled?: boolean;
  onebotSelfId?: string;
  qqSelfId?: string;
  officialRobotUin?: string;
  links?: CoordinationLinkConfig[];
}

export interface CoordinationRoute {
  receivePlatform: string;
  sendPlatform: string;
  canonicalChannelId: string;
  suppressNearcade: boolean;
  linked: boolean;
  onebotGroupId?: string;
  qqGroupOpenid?: string;
  qqSelfId?: string;
  officialSession?: Session;
}

interface OneBotGroupRef {
  bot: AdapterBot;
  id: string;
  name: string;
  memberCount: number;
}

interface OfficialObservation {
  session: Session;
  normalized: string;
  timestamp: number;
}

const GROUP_INFO_TTL = 5 * 60 * 1000;
const NEGATIVE_TTL = 30 * 1000;
const MEMBER_TTL = 60 * 1000;
const PASSIVE_WINDOW = 5 * 60 * 1000 - 2000;
const PASSIVE_MATCH_WINDOW = 10 * 1000;
const MAX_RECENT_OFFICIAL = 20;
const OFFICIAL_SEND_RETRY_DELAYS = [300, 800];

const isRetryableOfficialError = (error: unknown) => {
  const errors = [
    error,
    ...(((error as { errors?: unknown[] } | undefined)?.errors ?? []) as unknown[])
  ];
  return errors.some((item) => {
    const value = item as {
      response?: { status?: number; data?: { code?: number; err_code?: number } };
    };
    const code = value.response?.data?.code ?? value.response?.data?.err_code;
    return code === 50035006 || (value.response?.status ?? 0) >= 500;
  });
};

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const normalizeGroupName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const normalizeMessageContent = (content: string) =>
  content
    .replace(/<at[^>]*\/?>/g, '')
    .replace(/<quote[^>]*>[\s\S]*?<\/quote>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const stripMarkdown = (text: string) =>
  text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1');

/**
 * OneBot 无法渲染 QQ 官方的 markdown/键盘元素。官方发送失败回退到 OneBot 时，
 * 把这些元素降级为纯文本；图片等 OneBot 可渲染的元素保留。
 */
export const degradeForOneBot = (content: h.Fragment): h.Fragment => {
  const elements = h.normalize(content);
  const output: h[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const last = output[output.length - 1];
    if (last?.type === 'text') {
      last.attrs.content += text;
    } else {
      output.push(h.text(text));
    }
  };

  const visit = (element: h) => {
    switch (element.type) {
      case 'text':
        appendText(element.attrs.content ?? '');
        return;
      case 'br':
        appendText('\n');
        return;
      case 'p':
        if (!output.length || !output[output.length - 1]?.attrs.content?.endsWith('\n')) {
          appendText('\n');
        }
        element.children.forEach(visit);
        appendText('\n');
        return;
      case 'at':
      case 'quote':
      case 'passive':
      case 'button':
        return;
      case 'qq:markdown': {
        const text = element.children.map((child) => child.toString()).join('');
        appendText(stripMarkdown(text));
        return;
      }
      case 'img':
      case 'image':
        output.push(element);
        return;
      default:
        element.children.forEach(visit);
    }
  };

  elements.forEach(visit);
  return output;
};

export class Coordinator {
  private routes = new WeakMap<Session, CoordinationRoute>();
  private wrapped = new WeakSet<Session>();
  private nativeSenders = new WeakMap<Session, Session['send']>();
  private linksByOpenid = new Map<string, GroupLink>();
  private linksByOnebot = new Map<string, GroupLink>();
  private pendingLinks = new Map<string, Promise<GroupLink>>();
  private onebotGroups: OneBotGroupRef[] = [];
  private onebotGroupsAt = 0;
  private onebotGroupsPromise?: Promise<void>;
  private qqGroupCache = new Map<string, QQGroupSnapshot>();
  private memberCache = new Map<string, { at: number; members: Set<string> }>();
  private recentOfficial = new Map<string, OfficialObservation[]>();
  private unlinkedOfficial = new Map<string, { at: number; info: QQGroupInfo; qqSelfId: string }>();
  private officialIdentity = new Map<string, { uin?: string; name?: string }>();
  private linksLoaded = false;
  private linksPromise?: Promise<void>;
  private started = false;
  private logger;

  constructor(
    private ctx: Context,
    private config: CoordinationConfig
  ) {
    this.logger = ctx.logger('nearcade');
  }

  async start() {
    if (this.config.enabled === false || this.started) return;
    this.started = true;
    this.ctx.on('ready', () => void this.refresh());
    this.ctx.on('guild-added', () => void this.refresh());
    this.ctx.on('guild-removed', () => void this.refresh());
    this.ctx.on('guild-member-added', () => void this.refresh());
    this.ctx.on('guild-member-removed', () => void this.refresh());
    this.ctx.on('guild-updated', () => void this.refresh());
    this.ctx.on('bot-added', () => void this.refresh());
    this.ctx.on('bot-removed', () => void this.refresh());
    this.ctx.on('bot-status-updated', () => void this.refresh());
    try {
      await this.loadLinks();
      await this.refresh();
    } catch (error) {
      this.logger.warn('初始化多适配器群组信息失败：', error);
    }
  }

  getRoute(session: Session) {
    return this.routes.get(session);
  }

  getChannelId(session: Session) {
    return this.routes.get(session)?.canonicalChannelId ?? session.channelId;
  }

  getSendPlatform(session: Session) {
    return this.routes.get(session)?.sendPlatform ?? session.platform;
  }

  canForward(session: Session) {
    return this.getSendPlatform(session) === 'onebot';
  }

  shouldSuppress(session: Session) {
    return this.routes.get(session)?.suppressNearcade === true;
  }

  async prepare(session: Session): Promise<CoordinationRoute | undefined> {
    const cached = this.routes.get(session);
    if (cached) return cached;
    if (this.config.enabled === false || session.isDirect) return;
    if (session.type !== 'message' && session.type !== 'message-created') return;
    if (session.platform !== 'onebot' && session.platform !== 'qq') return;

    let route: CoordinationRoute | undefined;
    try {
      await this.loadLinks();
      route =
        session.platform === 'qq'
          ? await this.resolveQQ(session)
          : await this.resolveOnebot(session);
    } catch (error) {
      this.logger.warn('解析多适配器群组失败：', error);
      return;
    }

    if (!route) return;
    this.routes.set(session, route);
    if (route.sendPlatform !== session.platform && route.sendPlatform === 'qq') {
      this.wrapSend(session);
    }
    return route;
  }

  private async resolveQQ(session: Session): Promise<CoordinationRoute | undefined> {
    const openid = session.channelId;
    if (!openid) return;
    const qqBot = session.bot as unknown as QQBotLike;
    const snapshot = await this.getQQGroupInfo(qqBot, openid);
    const qqInfo = snapshot?.info;
    this.rememberOfficial(session, openid);
    if (qqInfo) {
      this.unlinkedOfficial.set(openid, {
        at: Date.now(),
        info: qqInfo,
        qqSelfId: qqBot.selfId
      });
    }

    let link = this.linksByOpenid.get(openid);
    if (!link && qqInfo) {
      const candidate = await this.findOnebotCandidate(qqInfo, qqBot);
      if (candidate) {
        link = await this.createLink(qqBot.selfId, openid, candidate, 'metadata');
      }
    }

    const onebotPresent = link ? await this.isOnebotPresent(link) : false;
    const route: CoordinationRoute = {
      receivePlatform: onebotPresent ? 'onebot' : 'qq',
      sendPlatform: 'qq',
      canonicalChannelId: link?.onebotGroupId ?? openid,
      suppressNearcade: onebotPresent && !!link,
      linked: !!link,
      onebotGroupId: link?.onebotGroupId,
      qqGroupOpenid: openid,
      qqSelfId: qqBot.selfId,
      officialSession: session
    };
    return route;
  }

  private async resolveOnebot(session: Session): Promise<CoordinationRoute | undefined> {
    const groupId = session.channelId;
    if (!groupId) return;
    let link = this.linksByOnebot.get(groupId);

    if (!link) {
      const ref = await this.getOneBotGroupById(groupId);
      if (ref) {
        const candidate = await this.findOfficialCandidate(ref);
        if (candidate) {
          link = await this.createLink(candidate.bot.selfId, candidate.openid, ref, 'metadata');
        }
      }
    }

    const snapshot = link
      ? await this.getQQGroupInfo(this.getQQBot(link.qqSelfId), link.qqGroupOpenid)
      : undefined;
    const passive = link ? this.findPassive(link.qqGroupOpenid, session) : undefined;
    // If the Official bot is known to be in the group, prefer its sender and
    // let the send failure path decide whether a OneBot fallback is needed.
    // This avoids emitting an unnecessary OneBot message merely because the
    // cached bot-state response does not advertise proactive permission.
    const canUseOfficial = !!link && !!snapshot?.info;
    const route: CoordinationRoute = {
      receivePlatform: 'onebot',
      sendPlatform: canUseOfficial ? 'qq' : 'onebot',
      canonicalChannelId: link?.onebotGroupId ?? groupId,
      suppressNearcade: false,
      linked: !!link,
      onebotGroupId: link?.onebotGroupId ?? groupId,
      qqGroupOpenid: link?.qqGroupOpenid,
      qqSelfId: link?.qqSelfId,
      officialSession: passive
    };
    return route;
  }

  private wrapSend(session: Session) {
    if (this.wrapped.has(session)) return;
    this.wrapped.add(session);
    this.nativeSenders.set(session, session.send.bind(session));
    session.send = (content, options) => this.send(session, content, options);
  }

  private nativeSend(
    session: Session,
    content: h.Fragment,
    options?: Parameters<Session['send']>[1]
  ) {
    const sender = this.nativeSenders.get(session);
    return sender ? sender(content, options) : session.send(content, options);
  }

  async send(session: Session, content: h.Fragment, options?: Parameters<Session['send']>[1]) {
    const route = await this.prepare(session);
    if (route?.sendPlatform !== 'qq' || !route.qqGroupOpenid) {
      return this.nativeSend(session, content, options);
    }

    const qqBot = this.getQQBot(route.qqSelfId);
    if (!qqBot) return this.nativeSend(session, content, options);

    let lastError: unknown;
    for (let attempt = 0; attempt <= OFFICIAL_SEND_RETRY_DELAYS.length; attempt++) {
      try {
        return await qqBot.sendMessage(
          route.qqGroupOpenid,
          content,
          null,
          route.officialSession ? { ...options, session: route.officialSession } : options
        );
      } catch (error) {
        lastError = error;
        if (attempt >= OFFICIAL_SEND_RETRY_DELAYS.length || !isRetryableOfficialError(error)) {
          break;
        }
        this.logger.warn(
          `QQ 官方发送出现临时错误，将在 ${OFFICIAL_SEND_RETRY_DELAYS[attempt]}ms 后重试：`,
          error
        );
        await wait(OFFICIAL_SEND_RETRY_DELAYS[attempt]);
      }
    }

    this.logger.warn('通过 QQ 官方适配器发送失败，回退到 OneBot：', lastError);
    const fallback = session.platform === 'onebot' ? degradeForOneBot(content) : content;
    return this.nativeSend(session, fallback, options);
  }

  private async loadLinks() {
    if (this.linksLoaded) return;
    if (!this.linksPromise) {
      this.linksPromise = (async () => {
        const links = (await this.ctx.database.get('groupLinks', {})) as GroupLink[];
        for (const link of links) this.cacheLink(link);
        this.linksLoaded = true;
      })().finally(() => {
        this.linksPromise = undefined;
      });
    }
    return this.linksPromise;
  }

  private cacheLink(link: GroupLink) {
    this.linksByOpenid.set(link.qqGroupOpenid, link);
    this.linksByOnebot.set(link.onebotGroupId, link);
  }

  private async createLink(
    qqSelfId: string,
    openid: string,
    ref: OneBotGroupRef,
    source: GroupLink['source']
  ) {
    const key = `${qqSelfId}:${openid}:${ref.bot.selfId}:${ref.id}`;
    const pending = this.pendingLinks.get(key);
    if (pending) return pending;

    const operation = this.persistLink(qqSelfId, openid, ref, source);
    this.pendingLinks.set(key, operation);
    try {
      return await operation;
    } finally {
      this.pendingLinks.delete(key);
    }
  }

  private async persistLink(
    qqSelfId: string,
    openid: string,
    ref: OneBotGroupRef,
    source: GroupLink['source']
  ) {
    await this.loadLinks();
    const existing = this.linksByOpenid.get(openid) ?? this.linksByOnebot.get(ref.id);
    const now = new Date().toISOString();
    if (existing) {
      const updates: Partial<GroupLink> = {
        qqSelfId,
        qqGroupOpenid: openid,
        onebotSelfId: ref.bot.selfId,
        onebotGroupId: ref.id,
        updatedAt: now
      };
      if (existing.source !== 'manual') updates.source = source;
      if (existing.qqGroupOpenid !== openid) {
        this.linksByOpenid.delete(existing.qqGroupOpenid);
      }
      if (existing.onebotGroupId !== ref.id) {
        this.linksByOnebot.delete(existing.onebotGroupId);
      }
      await this.ctx.database.set('groupLinks', { _id: existing._id }, updates);
      Object.assign(existing, updates);
      this.cacheLink(existing);
      return existing;
    }

    const link = (await this.ctx.database.create('groupLinks', {
      qqSelfId,
      qqGroupOpenid: openid,
      onebotSelfId: ref.bot.selfId,
      onebotGroupId: ref.id,
      source,
      createdAt: now,
      updatedAt: now
    })) as GroupLink;
    this.cacheLink(link);
    this.logger.info(
      `已关联 OneBot 群 ${link.onebotGroupId}` +
        ` 与 QQ 官方群 ${link.qqGroupOpenid}，来源：${link.source}`
    );
    return link;
  }

  async refresh() {
    try {
      this.onebotGroupsAt = 0;
      this.memberCache.clear();
      this.qqGroupCache.clear();
      await this.loadLinks();
      await this.refreshOnebotGroups();
      await this.loadKnownOfficialGroups();
      for (const ref of this.onebotGroups) {
        const candidate = await this.findOfficialCandidate(ref);
        if (!candidate) continue;
        await this.createLink(candidate.bot.selfId, candidate.openid, ref, 'metadata');
      }
      for (const manual of this.config.links ?? []) {
        if (!manual.onebotGroupId || !manual.qqGroupOpenid) continue;
        const ref = await this.getOneBotGroupById(manual.onebotGroupId);
        const qqBot = this.getQQBot(manual.qqSelfId);
        if (!ref || !qqBot) continue;
        const snapshot = await this.getQQGroupInfo(qqBot, manual.qqGroupOpenid, true);
        if (!snapshot?.info) continue;
        await this.createLink(qqBot.selfId, manual.qqGroupOpenid, ref, 'manual');
      }
    } catch (error) {
      this.logger.warn('刷新多适配器群组信息失败：', error);
    }
  }

  /**
   * Koishi stores channel IDs after an adapter has observed a group. This is
   * not a QQ group-list API, but it lets a restart recover previously known
   * group_openids without waiting for another message.
   */
  private async loadKnownOfficialGroups() {
    for (const bot of this.getQQBots()) {
      try {
        const channels = (await this.ctx.database.get('channel', {
          platform: 'qq',
          assignee: bot.selfId
        })) as Array<{ id: string }>;
        for (const channel of channels) {
          const snapshot = await this.getQQGroupInfo(bot, channel.id);
          if (!snapshot?.info) continue;
          this.unlinkedOfficial.set(channel.id, {
            at: Date.now(),
            info: snapshot.info,
            qqSelfId: bot.selfId
          });
        }
      } catch (error) {
        this.logger.warn(`读取已知 QQ 官方群失败（${bot.selfId}）：`, error);
      }
    }
  }

  private getQQBots() {
    return this.ctx.bots.filter(
      (bot) => bot.platform === 'qq' && !bot.hidden && bot.status === 1
    ) as unknown as QQBotLike[];
  }

  private getOneBotBots(): AdapterBot[] {
    return this.ctx.bots.filter(
      (bot) =>
        bot.platform === 'onebot' &&
        !bot.hidden &&
        bot.status === 1 &&
        (!this.config.onebotSelfId || bot.selfId === this.config.onebotSelfId)
    ) as unknown as AdapterBot[];
  }

  private getQQBot(preferredSelfId?: string) {
    const bots = this.getQQBots();
    if (preferredSelfId) {
      const preferred = bots.find((bot) => bot.selfId === preferredSelfId);
      if (preferred) return preferred;
    }
    if (this.config.qqSelfId) {
      const configured = bots.find((bot) => bot.selfId === this.config.qqSelfId);
      if (configured) return configured;
    }
    return bots[0];
  }

  private async getOfficialIdentity(qqBot: QQBotLike) {
    if (this.config.officialRobotUin) {
      return { uin: this.config.officialRobotUin, name: qqBot.user?.name };
    }
    const cached = this.officialIdentity.get(qqBot.selfId);
    if (cached) return cached;
    try {
      const me = await qqBot.guildBot?.internal.getMe();
      const match = me?.share_url?.match(/[?&]robot_uin=(\d+)/);
      const identity = { uin: match?.[1], name: me?.username ?? qqBot.user?.name };
      if (identity.uin) this.officialIdentity.set(qqBot.selfId, identity);
      return identity;
    } catch (error) {
      this.logger.warn('获取官方机器人 UIN 失败：', error);
      const identity = { uin: undefined, name: qqBot.user?.name };
      return identity;
    }
  }

  private async refreshOnebotGroups() {
    if (this.onebotGroupsPromise) return this.onebotGroupsPromise;
    this.onebotGroupsPromise = (async () => {
      const groups: OneBotGroupRef[] = [];
      for (const bot of this.getOneBotBots()) {
        try {
          const list = await (bot.internal as OneBotInternal).getGroupList();
          for (const group of list ?? []) {
            groups.push({
              bot,
              id: String(group.group_id),
              name: group.group_name,
              memberCount: Number(group.member_count ?? 0)
            });
          }
        } catch (error) {
          this.logger.warn(`获取 OneBot 群列表失败（${bot.selfId}）：`, error);
        }
      }
      this.onebotGroups = groups;
      this.onebotGroupsAt = Date.now();
    })().finally(() => {
      this.onebotGroupsPromise = undefined;
    });
    return this.onebotGroupsPromise;
  }

  private async ensureOnebotGroups() {
    if (!this.onebotGroupsAt) {
      await this.refreshOnebotGroups();
    }
  }

  private async getOneBotGroupById(groupId: string) {
    await this.ensureOnebotGroups();
    let ref = this.onebotGroups.find((item) => item.id === groupId);
    if (!ref) {
      await this.refreshOnebotGroups();
      ref = this.onebotGroups.find((item) => item.id === groupId);
    }
    return ref;
  }

  private async getGroupMembers(ref: OneBotGroupRef) {
    const key = `${ref.bot.selfId}:${ref.id}`;
    const cached = this.memberCache.get(key);
    if (cached && Date.now() - cached.at < MEMBER_TTL) return cached.members;
    try {
      const list = await (ref.bot.internal as OneBotInternal).getGroupMemberList(ref.id);
      const members = new Set((list ?? []).map((member) => String(member.user_id)));
      this.memberCache.set(key, { at: Date.now(), members });
      return members;
    } catch (error) {
      this.logger.warn(`获取 OneBot 群成员失败（${ref.id}）：`, error);
      return;
    }
  }

  private async isOfficialInGroup(
    ref: OneBotGroupRef,
    qqBot = this.getQQBot(this.config.qqSelfId)
  ) {
    if (!qqBot) return false;
    const identity = await this.getOfficialIdentity(qqBot);
    if (!identity.uin) return false;
    const members = await this.getGroupMembers(ref);
    return members?.has(identity.uin) === true;
  }

  private async findOnebotCandidate(info: QQGroupInfo, qqBot: QQBotLike) {
    await this.ensureOnebotGroups();
    const name = normalizeGroupName(info.group_name);
    const candidates = new Map<string, OneBotGroupRef>();
    for (const ref of this.onebotGroups) {
      if (normalizeGroupName(ref.name) !== name) continue;
      if (ref.memberCount !== info.group_member_num) continue;
      if (!(await this.isOfficialInGroup(ref, qqBot))) continue;
      candidates.set(ref.id, ref);
    }
    if (candidates.size !== 1) return;
    return candidates.values().next().value as OneBotGroupRef;
  }

  private async findOfficialCandidate(ref: OneBotGroupRef) {
    const matches: Array<{ openid: string; info: QQGroupInfo; bot: QQBotLike }> = [];
    for (const [openid, item] of this.unlinkedOfficial) {
      if (Date.now() - item.at > 30 * 60 * 1000) {
        this.unlinkedOfficial.delete(openid);
        continue;
      }
      if (normalizeGroupName(item.info.group_name) !== normalizeGroupName(ref.name)) continue;
      if (item.info.group_member_num !== ref.memberCount) continue;
      const bot = this.getQQBot(item.qqSelfId);
      if (!bot) continue;
      if (!(await this.isOfficialInGroup(ref, bot))) continue;
      matches.push({ openid, info: item.info, bot });
    }
    if (matches.length !== 1) return;
    return matches[0];
  }

  private async getQQGroupInfo(
    qqBot: QQBotLike | undefined,
    openid: string,
    force = false
  ): Promise<QQGroupSnapshot | undefined> {
    if (!qqBot) return;
    const key = `${qqBot.selfId}:${openid}`;
    const cached = this.qqGroupCache.get(key);
    if (
      !force &&
      cached &&
      Date.now() - cached.at < (cached.info ? GROUP_INFO_TTL : NEGATIVE_TTL)
    ) {
      return cached;
    }
    const [infoResult, stateResult] = await Promise.allSettled([
      (qqBot.internal as QQGroupInternal).getGuildInfo(openid),
      (qqBot.internal as QQGroupInternal).getGuildBotState(openid)
    ]);
    const info = infoResult.status === 'fulfilled' ? infoResult.value : undefined;
    const state = stateResult.status === 'fulfilled' ? stateResult.value : undefined;
    const snapshot = { at: Date.now(), info, state };
    this.qqGroupCache.set(key, snapshot);
    if (!info || !state) {
      const error =
        infoResult.status === 'rejected'
          ? infoResult.reason
          : stateResult.status === 'rejected'
            ? stateResult.reason
            : undefined;
      this.logger.warn(`获取 QQ 官方群状态不完整（${openid}）：`, error);
    }
    return snapshot;
  }

  private async isOnebotPresent(link: GroupLink) {
    const ref = await this.getOneBotGroupById(link.onebotGroupId);
    return !!ref && ref.bot.status === 1;
  }

  private rememberOfficial(session: Session, openid: string) {
    const list = this.recentOfficial.get(openid) ?? [];
    const timestamp = session.timestamp ?? Date.now();
    list.push({
      session,
      normalized: normalizeMessageContent(session.content ?? ''),
      timestamp
    });
    const cutoff = Date.now() - PASSIVE_WINDOW;
    this.recentOfficial.set(
      openid,
      list.filter((item) => item.timestamp >= cutoff).slice(-MAX_RECENT_OFFICIAL)
    );
  }

  private findPassive(openid: string, session: Session) {
    const list = this.recentOfficial.get(openid);
    if (!list?.length) return;
    const timestamp = session.timestamp ?? Date.now();
    const normalized = normalizeMessageContent(session.content ?? '');
    for (const item of list) {
      if (Date.now() - item.timestamp > PASSIVE_WINDOW) continue;
      if (Math.abs(item.timestamp - timestamp) > PASSIVE_MATCH_WINDOW) continue;
      if (item.normalized === normalized) return item.session;
    }
  }
}

export const createCoordinator = (ctx: Context, config: CoordinationConfig) =>
  new Coordinator(ctx, config);
