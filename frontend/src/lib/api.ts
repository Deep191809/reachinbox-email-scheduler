const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.message ?? 'Request failed');
  return data as T;
}

export function authUrl() {
  return `${API_URL}/auth/google`;
}

export function slackConnectUrl() {
  return `${API_URL}/slack/connect`;
}
