/**
 * Every call to the server goes through here.
 *
 * `credentials: 'same-origin'` matters: the session is an httpOnly cookie,
 * so the browser must be told to send it. Without this every request after
 * login is anonymous and nothing works, with no obvious cause.
 */

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(response.status, body.error ?? `request failed (${response.status})`);
  }
  return body as T;
}

export const get = <T>(path: string) => request<T>(path);
export const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

// ---------- shapes the server actually returns ----------

export interface Me { userId: number; username: string; }

export interface CourseSummary {
  id: number;
  name: string;
  boardCount: number;
  flagCount: number;
  lifeTokens: number;
  hasDock: boolean;
}

export interface GameSummary {
  id: number;
  status: 'lobby' | 'active' | 'finished' | 'abandoned';
  turn_number: number;
  phase_kind: string | null;
  course_name: string;
  players: number;
  updated_at: string;
}

export interface PlayerRow {
  robot_id: string;
  seat: number;
  display_name: string;
  colour: string | null;
  user_id: number;
  created_by: number | null;
  status: GameSummary['status'];
}

export const api = {
  me: () => get<Me>('/api/me'),
  login: (username: string, password: string) =>
    post<{ ok: true }>('/api/auth/login', { username, password }),
  register: (username: string, password: string) =>
    post<{ ok: true }>('/api/auth/register', { username, password }),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  courses: () => get<{ courses: CourseSummary[] }>('/api/courses'),
  games: () => get<{ games: GameSummary[] }>('/api/games'),
  createGame: (courseId: number) => post<{ gameId: number }>('/api/games', { courseId }),
  joinGame: (gameId: number, displayName?: string) =>
    post<{ seat: number; robotId: string }>(`/api/games/${gameId}/join`, { displayName }),
  players: (gameId: number) => get<{ players: PlayerRow[] }>(`/api/games/${gameId}/players`),
  startGame: (gameId: number) => post<{ ok: true }>(`/api/games/${gameId}/start`),
};
