import ActionErrorNotice from '../common/ActionErrorNotice';
import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import SecurityBanners from '../SecurityBanners';
import { useAccessRefresh } from '../../hooks/useAccessRefresh';

export default function AppLayout() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useAccessRefresh();

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <Sidebar mobileOpen={sidebarOpen} onMobileClose={() => setSidebarOpen(false)} />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <TopBar onMenuClick={() => setSidebarOpen((o) => !o)} />
        <SecurityBanners />
        <main className="flex-1 overflow-auto" style={{ padding: '22px 28px' }}>
          <Outlet />
          <ActionErrorNotice />
        </main>
      </div>
    </div>
  );
}
