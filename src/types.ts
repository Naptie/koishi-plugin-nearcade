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

export interface DiscoverResponse {
  /**
   * 原点
   */
  location: ResponseLocation;
  /**
   * 范围半径
   */
  radius: number;
  /**
   * 店铺列表
   */
  shops: (Shop & {
    /**
     * 当前在勤人数报告
     */
    currentReportedAttendance?: null | CurrentReportedAttendance;
    /**
     * 店铺距离，单位 km
     */
    distance: number;
    games: (Game & {
      /**
       * 机台综合在勤人数
       */
      totalAttendance?: number;
    })[];
    /**
     * 店铺综合在勤人数
     */
    totalAttendance?: number;
    /**
     * 公共交通信息
     */
    transit?: ShopTransit;
  })[];
  /**
   * 结果数量上限
   */
  limit?: number;
  /**
   * 地铁网络信息，当原点吸附到地铁站且存在经地铁可达的店铺时返回
   */
  metro?: DiscoverMetroBlock;
}

/**
 * 地铁线路徽标
 */
export interface MetroLineBadge {
  id: string;
  name: string;
  names: {
    zh: string;
    en: string;
  };
  /**
   * 官方线路色，形如 #e3002b
   */
  color: null | string;
  /**
   * 线路短代号，如 “1”、“17”
   */
  shortName: string;
}

/**
 * 店铺公共交通信息
 */
export interface ShopTransit {
  /**
   * 店铺最近地铁站及线路
   */
  metro?: ShopMetroTransit;
}

/**
 * 店铺最近地铁站
 */
export interface ShopMetroTransit {
  networkId: string;
  stationId: string;
  stationName: string;
  names: {
    zh: string;
    en: string;
  };
  /**
   * 步行至地铁站耗时，秒
   */
  walkSeconds: number;
  /**
   * 步行距离，km
   */
  distanceKm: number;
  lines: MetroLineBadge[];
}

/**
 * 地铁行程中的一段
 */
export interface MetroLegPlan {
  kind: 'ride' | 'transfer';
  /**
   * 乘车段对应的线路 ID
   */
  lineId?: string;
  /**
   * 该段经过的地铁站 ID 序列
   */
  stationIds: string[];
  /**
   * 该段耗时，秒
   */
  seconds: number;
  distanceKm?: number;
  direction?: string;
}

/**
 * 原点至店铺的地铁行程
 */
export interface MetroShopItinerary {
  totalSeconds: number;
  rideSeconds: number;
  transferCount: number;
  legs: MetroLegPlan[];
}

/**
 * 地铁站点
 */
export interface MetroStation {
  name: string;
  names: {
    zh: string;
    en: string;
  };
  lon: number;
  lat: number;
}

/**
 * 发现结果附带的地铁网络块
 */
export interface DiscoverMetroBlock {
  network: {
    id: string;
    name: string;
    names: {
      zh: string;
      en: string;
    };
    cityRegionId: string;
  };
  /**
   * 原点吸附的地铁站
   */
  origin: {
    stationId: string;
    stationName: string;
    names: {
      zh: string;
      en: string;
    };
    /**
     * 原点步行至地铁站耗时，秒
     */
    walkSeconds: number;
    lon: number;
    lat: number;
  };
  lines: Record<string, MetroLineBadge>;
  stations: Record<string, MetroStation>;
  /**
   * 以店铺 ID 为键的原点 → 店铺地铁行程
   */
  shops: Record<string, MetroShopItinerary>;
}

/**
 * 原点
 */
export interface ResponseLocation {
  /**
   * 原点纬度
   */
  latitude: number;
  /**
   * 原点经度
   */
  longitude: number;
  /**
   * 原点地名
   */
  name: string;
}

export interface CurrentReportedAttendance {
  /**
   * 上报说明
   */
  comment: null | string;
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
 * 店铺坐标
 */
export interface ShopLocation {
  coordinates: number[];
  type: string;
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
   * 机台数量
   */
  quantity: number;
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
  userType?: UserType;
}

export interface ArcadeId {
  id: number;
}

/**
 * 用户类型
 */
export enum UserType {
  ClubAdmin = 'club_admin',
  ClubModerator = 'club_moderator',
  Developer = 'developer',
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
   * 店铺 ID
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
  /**
   * 行政区划层级列表，首元素为国家/地区（中国大陆为 CN）。
   * name 为已本地化的纯文本。
   */
  region?: Array<{
    id: string;
    name: string;
  }>;
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

export interface ArcadeGameAlias {
  aliases: string[];
  gameId: number;
  titleId?: number;
  name?: string;
  version?: string;
  comment?: string;
  quantity?: number;
  cost?: string;
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
  id: number;
  version?: number;
  names: string[];
  defaultGame: Game;
  gameAliases: ArcadeGameAlias[];
  channelId: string;
  registrantId: string;
  registrantName: string;
  registeredAt: string;
}

export interface AttendanceReport {
  _id: number;
  id: number;
  reporterId: string;
  reporterName: string;
}

export interface CustomShop {
  id: number;
  aliases: string[];
}

export interface CustomAttendanceReport {
  _id: number;
  shop: number;
  channelId: string;
  count: number;
  reporterId: string;
  reporterName: string;
  reportedAt: string;
}

export interface DiscoverySettings {
  _id: number;
  channelId: string;
  off: boolean;
  radius: number;
  operatorId: string;
  operatorName: string;
  updatedAt: string;
}

export interface GroupSettings {
  channelId: string;
  private: boolean;
  search: boolean;
  operatorId: string;
  operatorName: string;
  updatedAt: string;
}
