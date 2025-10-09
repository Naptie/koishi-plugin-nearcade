import {
  AttendanceReportResponse,
  AttendanceResponse,
  ShopInfoResponse,
  ShopsListResponse
} from './types';

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
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      return response.text() as Promise<string>;
    }
    return response.json() as Promise<T>;
  }

  async findArcades(query: string, limit: number = 0) {
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
    } while (hasNext && limit <= 0);
    return results;
  }

  async getArcade(source: string, id: number) {
    return this.request<ShopInfoResponse>(`/shops/${source}/${id}`);
  }

  async getAttendance(source: string, id: number) {
    return this.request<AttendanceResponse>(`/shops/${source}/${id}/attendance`);
  }

  async reportAttendance(
    source: string,
    id: number,
    gameId: number,
    attendance: number,
    comment: string
  ) {
    return this.request<AttendanceReportResponse>(`/shops/${source}/${id}/attendance`, 'POST', {
      games: [{ id: gameId, currentAttendances: attendance }],
      comment
    });
  }
}
