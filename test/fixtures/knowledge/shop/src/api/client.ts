export interface ApiError { status: number; message: string }

const BASE_URL = '/api';

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) }
  });
  if (!response.ok) {
    const error: ApiError = { status: response.status, message: await response.text() };
    throw error;
  }
  return response.json() as Promise<T>;
}
