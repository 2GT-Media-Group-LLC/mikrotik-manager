import { useNavigate } from 'react-router-dom';
import { Sun, Moon, LogOut, Menu, BookOpen } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { useThemeStore } from '../../store/themeStore';
import GlobalSearch from './GlobalSearch';
import { docsUrl } from '../../version';

interface TopBarProps {
  onMenuClick: () => void;
}

export default function TopBar({ onMenuClick }: TopBarProps) {
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme } = useThemeStore();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initial = (user?.username?.[0] ?? 'A').toUpperCase();

  return (
    <header
      className="h-[54px] flex-shrink-0 flex items-center gap-3 px-[22px]"
      style={{ background: 'var(--bg)', borderBottom: '1px solid var(--line)' }}
    >
      {/* Hamburger — mobile only */}
      <button
        onClick={onMenuClick}
        className="md:hidden p-2 rounded-lg transition-colors flex-shrink-0"
        style={{ color: 'var(--ink-3)' }}
        aria-label="Open menu"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Search */}
      <div className="flex-1">
        <GlobalSearch />
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="p-[7px] rounded-lg transition-colors"
          style={{ color: 'var(--ink-3)' }}
          title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
        </button>

        {/* User chip */}
        <div
          className="flex items-center gap-[8px] px-[10px] py-[4px] rounded-[6px]"
          style={{ background: 'var(--surface-2)' }}
        >
          <div
            className="w-[22px] h-[22px] rounded-full flex items-center justify-center text-[11px] font-bold flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, var(--accent), var(--accent-2))',
              color: 'var(--accent-fg)',
            }}
          >
            {initial}
          </div>
          <span className="hidden sm:inline text-[13px] font-medium" style={{ color: 'var(--ink-2)' }}>
            {user?.username}
          </span>
        </div>

        {/* Documentation. Points at the series this build belongs to rather than
            "latest", so the pages describe the version actually running. */}
        <a
          href={docsUrl()}
          target="_blank"
          rel="noopener noreferrer"
          className="p-[7px] rounded-lg transition-colors hover:text-accent"
          style={{ color: 'var(--ink-4)' }}
          title="Documentation"
          aria-label="Open the documentation in a new tab"
        >
          <BookOpen className="w-4 h-4" />
        </a>

        {/* Logout */}
        <button
          onClick={handleLogout}
          className="p-[7px] rounded-lg transition-colors hover:text-bad"
          style={{ color: 'var(--ink-4)' }}
          title="Logout"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
}
