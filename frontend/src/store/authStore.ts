import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserRole } from '../types';
import { reconcileSiteSelection } from './siteStore';

interface AuthState {
  token: string | null;
  user: User | null;
  isAuthenticated: boolean;
  setAuth: (token: string, user: User) => void;
  /** Update role and site access from GET /auth/me, without a new sign-in. */
  applyAccess: (me: { role?: string; siteRoles?: Record<string, string> | null }) => void;
  logout: () => void;
}

const RANK = new Map<string, number>([['viewer', 0], ['operator', 1], ['admin', 2]]);

/**
 * A site-scoped account's role for the interface: its highest site role, but
 * never admin. Admin controls in the interface are fleet administration, which
 * the server refuses to site admins anyway (P1-7).
 */
function scopedRole(siteRoles: Record<string, string>): UserRole {
  const top = Object.values(siteRoles).reduce((a, b) => ((RANK.get(b) ?? -1) > (RANK.get(a) ?? -1) ? b : a), 'viewer');
  return (top === 'admin' ? 'operator' : top) as UserRole;
}

function normalize(user: User): User {
  if (user.siteRoles && Object.keys(user.siteRoles).length > 0) {
    return { ...user, role: scopedRole(user.siteRoles) };
  }
  const { siteRoles: _drop, ...rest } = user;
  void _drop;
  return rest;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      isAuthenticated: false,
      setAuth: (token, user) => {
        reconcileSiteSelection(user.siteRoles);
        set({ token, user: normalize(user), isAuthenticated: true });
      },
      applyAccess: (me) => set((state) => {
        if (!state.user) return {};
        const siteRoles = me.siteRoles && Object.keys(me.siteRoles).length > 0 ? me.siteRoles as Record<string, UserRole> : undefined;
        reconcileSiteSelection(siteRoles);
        return { user: normalize({ ...state.user, role: (me.role ?? state.user.role) as UserRole, siteRoles }) };
      }),
      logout: () => set({ token: null, user: null, isAuthenticated: false }),
    }),
    {
      name: 'mikrotik-auth',
      partialize: (state) => ({
        token: state.token,
        user: state.user,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
