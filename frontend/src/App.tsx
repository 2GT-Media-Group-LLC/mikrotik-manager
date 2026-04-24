import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import AppLayout from './components/layout/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import DevicesPage from './pages/DevicesPage';
import DeviceDetailPage from './pages/DeviceDetailPage';
import ClientsPage from './pages/ClientsPage';
import EventsPage from './pages/EventsPage';
import TopologyPage from './pages/TopologyPage';
import BackupsPage from './pages/BackupsPage';
import SettingsPage from './pages/SettingsPage';
import SwitchesOverviewPage from './pages/SwitchesOverviewPage';
import SwitchesSettingsPage from './pages/SwitchesSettingsPage';
import RoutersPage from './pages/RoutersPage';
import RouterSettingsPage from './pages/RouterSettingsPage';
import WirelessPage from './pages/WirelessPage';
import WirelessSettingsPage from './pages/WirelessSettingsPage';
import WirelessClientsPage from './pages/WirelessClientsPage';
import ClientDetailPage from './pages/ClientDetailPage';
import NetworkServicesOverviewPage from './pages/NetworkServicesOverviewPage';
import NetworkServicesDHCPPage from './pages/NetworkServicesDHCPPage';
import NetworkServicesDNSPage from './pages/NetworkServicesDNSPage';
import NetworkServicesNTPPage from './pages/NetworkServicesNTPPage';
import NetworkServicesWireGuardPage from './pages/NetworkServicesWireGuardPage';
import NetworkServicesSyslogPage from './pages/NetworkServicesSyslogPage';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="devices/:id" element={<DeviceDetailPage />} />
          <Route path="clients" element={<ClientsPage />} />
          <Route path="clients/:mac" element={<ClientDetailPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="topology" element={<TopologyPage />} />
          <Route path="backups" element={<BackupsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="switches" element={<SwitchesOverviewPage />} />
          <Route path="switches/settings" element={<SwitchesSettingsPage />} />
          <Route path="routers" element={<RoutersPage />} />
          <Route path="routers/settings" element={<RouterSettingsPage />} />
          <Route path="wireless" element={<WirelessPage />} />
          <Route path="wireless/settings" element={<WirelessSettingsPage />} />
          <Route path="wireless/clients" element={<WirelessClientsPage />} />
          <Route path="network-services" element={<NetworkServicesOverviewPage />} />
          <Route path="network-services/dhcp" element={<NetworkServicesDHCPPage />} />
          <Route path="network-services/dns" element={<NetworkServicesDNSPage />} />
          <Route path="network-services/ntp" element={<NetworkServicesNTPPage />} />
          <Route path="network-services/wireguard" element={<NetworkServicesWireGuardPage />} />
          <Route path="network-services/syslog" element={<NetworkServicesSyslogPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
