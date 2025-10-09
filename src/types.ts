export interface ShopsListResponse {
  currentPage: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
  shops: Shop[];
  totalCount: number;
}

export interface ShopInfoResponse {
  shop: Shop;
}

export interface AttendanceResponse {
  /**
   * 机台详情
   */
  games: AttendanceGame[];
  /**
   * 登记的在勤记录
   */
  registered: Registered[];
  /**
   * 上报的在勤记录
   */
  reported: Reported[];
  /**
   * 是否成功
   */
  success: boolean;
  /**
   * 综合在勤人数，结合登记与上报人数综合计算得出
   */
  total: number;
}

export interface AttendanceReportResponse {
  success: boolean;
}

export interface AttendanceGame {
  /**
   * 游戏（版本）ID，BEMANICN 数据源等同于机台 ID
   */
  gameId: number;
  /**
   * 游戏名
   */
  name: string;
  /**
   * 游戏系列 ID
   */
  titleId: number;
  /**
   * 机台综合在勤人数
   */
  total: number;
  /**
   * 游戏版本
   */
  version: string;
}

export interface Registered {
  /**
   * 出勤时间
   */
  attendedAt: string;
  /**
   * 游戏（版本）ID
   */
  gameId: number;
  /**
   * 计划退勤时间
   */
  plannedLeaveAt: string;
  /**
   * 玩家
   */
  user?: User;
  /**
   * 玩家 ID
   */
  userId?: string;
}

/**
 * 玩家
 *
 * User
 *
 * 上报用户
 */
export interface User {
  /**
   * MongoDB ID，请使用 id
   */
  _id: string;
  /**
   * 个人简介
   */
  bio: string;
  /**
   * 用户示名，展示优先级高于 name
   */
  displayName: null | string;
  /**
   * 邮箱，仅在用户勾选“邮箱可见性”时存在；QQ 用户会返回伪造的邮箱地址
   */
  email?: string;
  /**
   * 常去机厅，仅在用户勾选“常去机厅可见性”时存在
   */
  frequentingArcades?: ArcadeId[];
  /**
   * 用户 ID
   */
  id: string;
  /**
   * 头像
   */
  image: string;
  /**
   * 加入时间
   */
  joinedAt: string;
  /**
   * 最后活跃时间
   */
  lastActiveAt: string;
  /**
   * 用户名，展示时请在前面加 @ 符号
   */
  name: string;
  /**
   * 收藏机厅，仅在用户勾选“收藏机厅可见性”时存在
   */
  starredArcades?: ArcadeId[];
  /**
   * 资料更新时间
   */
  updatedAt: string;
  /**
   * 用户类型
   */
  userType: UserType;
}

export interface ArcadeId {
  id: number;
  source: string;
}

/**
 * 用户类型
 */
export enum UserType {
  ClubAdmin = 'club_admin',
  ClubModerator = 'club_moderator',
  Regular = 'regular',
  SchoolAdmin = 'school_admin',
  SchoolModerator = 'school_moderator',
  SiteAdmin = 'site_admin',
  Student = 'student'
}

export interface Reported {
  /**
   * 在勤人数
   */
  currentAttendances: number;
  /**
   * 游戏（版本）ID
   */
  gameId: number;
  /**
   * 上报时间
   */
  reportedAt: string;
  /**
   * 上报用户 ID
   */
  reportedBy: string;
  /**
   * 上报用户
   */
  reporter: User;
}

/**
 * Shop
 */
export interface Shop {
  /**
   * MongoDB ID
   */
  _id: string;
  /**
   * 店铺地址
   */
  address: Address;
  /**
   * 店铺说明
   */
  comment: string;
  /**
   * 创建时间，ZIv 数据源不返回创建时间
   */
  createdAt?: string;
  /**
   * 机台
   */
  games: Game[];
  /**
   * 店铺 ID，须与 source 结合才能唯一确定店铺
   */
  id: number;
  /**
   * 店铺坐标
   */
  location: Location;
  /**
   * 店铺名称
   */
  name: string;
  /**
   * 营业时间，仅有 1 个元素时表示整周均为该营业时间；有 7 个元素时每个元素分别代表一周中一天的营业时间
   */
  openingHours: Array<number[]>;
  /**
   * 店铺来源，目前可能为 bemanicn、ziv
   */
  source: string;
  /**
   * 更新时间
   */
  updatedAt: string;
}

/**
 * 店铺地址
 */
export interface Address {
  /**
   * 详细地址
   */
  detailed: string;
  /**
   * 大致地址，一般为：[国家/地区, 省, 市, 区]
   */
  general: string[];
}

export interface Game {
  /**
   * 游戏说明
   */
  comment: string;
  /**
   * 价格说明
   */
  cost: string;
  /**
   * 游戏（版本）ID，BEMANICN 数据源等同于机台 ID
   */
  gameId: number;
  /**
   * 游戏名
   */
  name: string;
  /**
   * 机台数量
   */
  quantity: number;
  /**
   * 游戏系列 ID
   */
  titleId: number;
  /**
   * 游戏版本
   */
  version: string;
}

/**
 * 店铺坐标
 */
export interface Location {
  coordinates: number[];
  type: string;
}

export interface Arcade {
  _id: number;
  source: string;
  id: number;
  names: string[];
  defaultGame: Game;
  gameAliases: {
    gameId: number;
    aliases: string[];
  }[];
  channelId: string;
  registrantId: string;
  registrantName: string;
  registeredAt: string;
}

export interface AttendanceReport {
  _id: number;
  source: string;
  id: number;
  reporterId: string;
  reporterName: string;
}
