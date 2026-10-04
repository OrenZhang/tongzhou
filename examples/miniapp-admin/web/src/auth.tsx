import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface AdminUser {
  id: number;
  username: string;
  name: string;
  role: 'admin' | 'operator';
}

interface AuthState {
  user: AdminUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  login: () => Promise.resolve(),
  logout: () => Promise.resolve(),
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api
      .get<{ user: AdminUser }>('/api/auth/me')
      .then((d) => {
        if (alive) setUser(d.user);
      })
      .catch(() => {
        if (alive) setUser(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const d = await api.post<{ user: AdminUser }>('/api/auth/login', { username, password });
    setUser(d.user);
  }, []);

  const logout = useCallback(async () => {
    await api.post<{ ok: boolean }>('/api/auth/logout', {});
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}
