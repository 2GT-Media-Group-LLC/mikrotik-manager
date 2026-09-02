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
import FirmwarePage from './pages/FirmwarePage';
import CommandsPage from './pages/CommandsPage';
import SettingsPage from './pages/SettingsPage';
import OidcCallbackPage from './pages/OidcCallbackPage';
import WirelessPage from './pages/WirelessPage';
import WirelessSettingsPage from './pages/WirelessSettingsPage';
import GuestWifiPage from './pages/GuestWifiPage';
import ClientDetailPage from './pages/ClientDetailPage';
import NetworkServicesOverviewPage from './pages/NetworkServicesOverviewPage';
import NetworkServicesDHCPPage from './pages/NetworkServicesDHCPPage';
import NetworkServicesDNSPage from './pages/NetworkServicesDNSPage';
import NetworkServicesNTPPage from './pages/NetworkServicesNTPPage';
import NetworkServicesWireGuardPage from './pages/NetworkServicesWireGuardPage';
import NetworkServicesSyslogPage from './pages/NetworkServicesSyslogPage';
import NetworkServicesNetflowPage from './pages/NetworkServicesNetflowPage';
import NetworkServicesDiscoveryPage from './pages/NetworkServicesDiscoveryPage';
import TrafficAnalyticsPage from './pages/TrafficAnalyticsPage';
import SecurityPage from './pages/SecurityPage';

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
        <Route path="/auth/callback" element={<OidcCallbackPage />} />
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
          <Route path="firmware" element={<FirmwarePage />} />
          <Route path="commands" element={<CommandsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          {/* Legacy routes — consolidated in the v0.16.4 UI reorganization */}
          <Route path="switches" element={<Navigate to="/devices?type=SW" replace />} />
          <Route path="switches/settings" element={<Navigate to="/network-services/discovery" replace />} />
          <Route path="routers" element={<Navigate to="/devices?type=RTR" replace />} />
          <Route path="routers/settings" element={<Navigate to="/network-services/discovery" replace />} />
          <Route path="wireless/clients" element={<Navigate to="/clients?type=wireless" replace />} />
          <Route path="wireless" element={<WirelessPage />} />
          <Route path="wireless/settings" element={<WirelessSettingsPage />} />
          <Route path="wireless/guest" element={<GuestWifiPage />} />
          <Route path="network-services" element={<NetworkServicesOverviewPage />} />
          <Route path="network-services/dhcp" element={<NetworkServicesDHCPPage />} />
          <Route path="network-services/dns" element={<NetworkServicesDNSPage />} />
          <Route path="network-services/ntp" element={<NetworkServicesNTPPage />} />
          <Route path="network-services/wireguard" element={<NetworkServicesWireGuardPage />} />
          <Route path="network-services/syslog" element={<NetworkServicesSyslogPage />} />
          <Route path="network-services/netflow" element={<NetworkServicesNetflowPage />} />
          <Route path="network-services/discovery" element={<NetworkServicesDiscoveryPage />} />
          <Route path="traffic" element={<TrafficAnalyticsPage />} />
          <Route path="security" element={<SecurityPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
