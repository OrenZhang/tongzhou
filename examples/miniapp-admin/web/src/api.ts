// 统一 API 封装：JSON 请求、统一错误抛出（含后端 { error } 消息）
export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    credentials: 'same-origin',
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    if (data && typeof data === 'object' && 'error' in data) {
      message = String((data as { error: unknown }).error);
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : '操作失败，请稍后重试';
}
