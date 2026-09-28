import { useState, FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Network, KeyRound, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { useThemeStore } from '../store/themeStore';
import CircuitBackground from '../components/CircuitBackground';

/**
 * First-login password change (P1-3).
 *
 * The seeded admin account ships with admin/admin. Until it is changed, the
 * server only accepts calls needed to change it, so this page stands alone,
 * outside the app layout, and is where every other route sends such a session.
 */
export default function ChangePasswordPage() {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const setAuth = useAuthStore((s) => s.setAuth);
  const logout = useAuthStore((s) => s.logout);
  const navigate = useNavigate();
  const location = useLocation();
  const { theme } = useThemeStore();
  const isDark = theme === 'dark';

  const carried = (location.state as { currentPassword?: string } | null)?.currentPassword ?? '';
  const [current, setCurrent] = useState(carried);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  if (!token) return <Navigate to="/login" replace />;
  if (user && !user.must_change_password) return <Navigate to="/dashboard" replace />;

  const inputClass = `w-full px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors ${
    isDark
      ? 'bg-slate-800/80 border border-slate-600 text-white placeholder-slate-500'
      : 'bg-white/80 border border-slate-300 text-slate-800 placeholder-slate-400'
  }`;
  const labelClass = `block text-sm font-medium mb-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next !== confirm) { setError('The new passwords do not match.'); return; }
    setSaving(true);
    try {
      const { data } = await authApi.changePassword(current, next);
      if (data.token && data.user) setAuth(data.token, data.user);
      navigate('/dashboard', { replace: true });
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setError(msg || 'Could not change the password.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden"
      style={{ backgroundColor: isDark ? '#040c07' : '#e8f2f7' }}
    >
      <CircuitBackground theme={theme} />
      <div className="w-full max-w-sm relative z-10">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center mb-4 shadow-lg">
            <Network className="w-7 h-7 text-white" />
          </div>
          <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-slate-800'}`}>Mikrotik Manager</h1>
        </div>

        <div className={`backdrop-blur-sm rounded-xl shadow-2xl p-6 ${
          isDark ? 'bg-slate-900/80 border border-slate-700/60' : 'bg-white/75 border border-slate-300/60'
        }`}>
          <h2 className={`text-lg font-semibold flex items-center gap-2 ${isDark ? 'text-white' : 'text-slate-800'}`}>
            <KeyRound className="w-5 h-5 text-blue-500" /> Set a new password
          </h2>
          <p className={`text-sm mt-1 mb-5 ${isDark ? 'text-slate-400' : 'text-slate-600'}`}>
            {user?.username ? <><strong>{user.username}</strong> is</> : 'This account is'} still using the
            default password. Choose a new one to continue: at least 10 characters, with a letter and a number.
          </p>

          <form onSubmit={submit} className="space-y-4">
            {!carried && (
              <div>
                <label className={labelClass} htmlFor="current">Current password</label>
                <input id="current" type={show ? 'text' : 'password'} className={inputClass}
                       value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" autoFocus />
              </div>
            )}
            <div>
              <label className={labelClass} htmlFor="new">New password</label>
              <div className="relative">
                <input id="new" type={show ? 'text' : 'password'} className={`${inputClass} pr-10`}
                       value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" autoFocus={!!carried} />
                <button type="button" onClick={() => setShow(!show)} aria-label={show ? 'Hide passwords' : 'Show passwords'}
                        className={`absolute right-2.5 top-1/2 -translate-y-1/2 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                  {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelClass} htmlFor="confirm">Confirm new password</label>
              <input id="confirm" type={show ? 'text' : 'password'} className={inputClass}
                     value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </div>

            {error && (
              <div className="flex items-center gap-2 text-sm text-red-500">
                <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
              </div>
            )}

            <button type="submit" className="btn-primary w-full" disabled={saving || !current || !next || !confirm}>
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
            <button type="button" onClick={() => { logout(); navigate('/login', { replace: true }); }}
                    className={`w-full text-sm ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}>
              Sign out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
