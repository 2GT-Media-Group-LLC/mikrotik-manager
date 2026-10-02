import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

/**
 * Landing route for the SSO redirect. The backend hands over a single-use code
 * in the URL fragment, which is exchanged here, from this browser, for the
 * session (outside review S4). The session token used to be in the fragment
 * itself, where it stayed in browser history for its whole life, and a token
 * from anyone's login was accepted. A code from a login this browser didn't
 * start is refused by the server.
 */
export default function OidcCallbackPage() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const code = hash.get('code');
    // Same-site relative paths only (reject absolute / protocol-relative).
    const rawReturn = hash.get('returnTo') || '/dashboard';
    const returnTo = /^\/(?!\/)[^\\]*$/.test(rawReturn) ? rawReturn : '/dashboard';
    // Take the code out of the address bar and history straight away.
    window.history.replaceState(null, '', window.location.pathname);

    const fail = (reason: 'expired' | 'failed') =>
      navigate(`/login?error=sso&code=${reason}`, { replace: true });

    if (!code) {
      fail('failed');
      return;
    }

    authApi.oidcExchange(code)
      .then((r) => {
        setAuth(r.data.token, r.data.user);
        navigate(returnTo, { replace: true });
      })
      .catch((err) => {
        useAuthStore.getState().logout();
        fail((err as { response?: { status?: number } })?.response?.status === 400 ? 'expired' : 'failed');
      });
  }, [navigate, setAuth]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex items-center gap-3 text-slate-500">
        <span className="inline-block w-5 h-5 border-2 border-slate-400/30 border-t-slate-400 rounded-full animate-spin" />
        Signing you in…
      </div>
    </div>
  );
}
