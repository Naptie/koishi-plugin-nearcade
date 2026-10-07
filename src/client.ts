import {
  AttendanceReportResponse,
  AttendanceResponse,
  DiscoverResponse,
  ShopInfoResponse,
  ShopsListResponse
} from './types';

/**
 * 结构化筛选状态中与机厅名称匹配相关的子集（对应 nearcade /shops 的 `f` 参数，
 * base64url JSON，见 nearcade `src/lib/schemas/shop-filter.ts`）。
 */
export interface ShopNameFilter {
  name: { value: string; mode: 'contains' | 'exact' };
}

export class Client {
  private apiBase: string;
  private apiToken: string;

  constructor(apiBase: string, apiToken: string) {
    apiBase = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    this.apiBase = apiBase.endsWith('/api') ? apiBase : `${apiBase}/api`;
    this.apiToken = apiToken;
  }

  private async request<T>(endpoint: string, method: string = 'GET', body?: object) {
    const response = await fetch(`${this.apiBase}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      const respClone = response.clone();
      try {
        const data = (await response.json()) as { message?: string };
        return data.message || response.statusText;
      } catch {
        return (await respClone.text()) || response.statusText;
      }
    }
    return response.json() as Promise<T>;
  }

  async discoverArcades(latitude: string, longitude: string, radius: number, name: string) {
    return this.request<DiscoverResponse>(
      `/discover?latitude=${latitude}&longitude=${longitude}&radius=${radius}${
        name ? `&name=${encodeURIComponent(name)}` : ''
      }`
    );
  }

  async findArcades(query: string, limit: number = 0, max: number = 200) {
    let results: ShopsListResponse['shops'] = [];
    let hasNext = true;
    let page = 1;
    do {
      const response = await this.request<ShopsListResponse>(
        `/shops?q=${encodeURIComponent(query)}&limit=${limit > 0 ? limit : 50}&page=${page++}`
      );
      if (typeof response === 'string') {
        return response;
      }
      results = results.concat(response.shops);
      hasNext = response.hasNextPage;
    } while (hasNext && limit <= 0 && results.length < max);
    return results;
  }

  /**
   * 单页结构化筛选查询：返回完整响应（含 totalCount），供按机厅名称精确匹配
   * 使用。q 留空时服务端走 MongoDB 精确路径，totalCount 为真实总数。
   */
  async findArcadesPage(query: string, limit: number, filter?: ShopNameFilter) {
    // 服务端 shop-filter schema 要求筛选状态携带 v（当前为 1）：缺失时整个 f
    // 参数会被判为无效并按"无筛选"处理，返回全量机厅列表而非按名称过滤的
    // 结果（totalCount 为全量总数）。
    const f = filter
      ? `&f=${Buffer.from(JSON.stringify({ v: 1, ...filter }), 'utf8').toString('base64url')}`
      : '';
    return this.request<ShopsListResponse>(
      `/shops?q=${encodeURIComponent(query)}&limit=${limit}&page=1${f}`
    );
  }

  async getArcade(id: number) {
    return this.request<ShopInfoResponse>(`/shops/${id}`);
  }

  async getAttendance(id: number) {
    return this.request<AttendanceResponse>(`/shops/${id}/attendance`);
  }

  async reportAttendance(id: number, gameId: number, attendance: number, comment: string) {
    return this.request<AttendanceReportResponse>(`/shops/${id}/attendance`, 'POST', {
      games: [{ id: gameId, currentAttendances: attendance }],
      comment
    });
  }
}
