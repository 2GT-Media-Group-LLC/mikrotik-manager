import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Router, Users, Bell, GitBranch, HardDrive,
  Settings, Network, ChevronLeft, ChevronRight, Layers, ChevronDown, SlidersHorizontal, X, Wifi,
  Server, Globe, Clock, Shield, FileText,
} from 'lucide-react';
import clsx from 'clsx';
import { APP_VERSION } from '../../version';
import { devicesApi } from '../../services/api';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/devices',   icon: Router,          label: 'Devices' },
  { to: '/clients',   icon: Users,           label: 'Clients' },
  { to: '/events',    icon: Bell,            label: 'Events' },
  { to: '/topology',  icon: GitBranch,       label: 'Topology' },
  { to: '/backups',   icon: HardDrive,       label: 'Backups' },
];

const switchSubItems = [
  { to: '/switches',          icon: Layers,            label: 'Overview' },
  { to: '/switches/settings', icon: SlidersHorizontal, label: 'Settings' },
];

const routerSubItems = [
  { to: '/routers',          icon: Router,            label: 'Overview' },
  { to: '/routers/settings', icon: SlidersHorizontal, label: 'Settings' },
];

const wirelessSubItems = [
  { to: '/wireless',          icon: Wifi,              label: 'Overview' },
  { to: '/wireless/clients',  icon: Users,             label: 'Clients' },
  { to: '/wireless/settings', icon: SlidersHorizontal, label: 'Settings' },
];

const networkServicesSubItems = [
  { to: '/network-services',            icon: Network,  label: 'Overview' },
  { to: '/network-services/dhcp',       icon: Server,   label: 'DHCP' },
  { to: '/network-services/dns',        icon: Globe,    label: 'DNS' },
  { to: '/network-services/ntp',        icon: Clock,    label: 'NTP' },
  { to: '/network-services/wireguard',  icon: Shield,    label: 'WireGuard' },
  { to: '/network-services/syslog',     icon: FileText,  label: 'Syslog' },
];

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

export default function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();

  const { data: devices = [] } = useQuery({
    queryKey: ['devices'],
    queryFn: () => devicesApi.list().then(r => r.data),
    staleTime: 60_000,
  });

  const hasSwitches  = devices.some(d => d.device_type === 'switch');
  const hasRouters   = devices.some(d => d.device_type === 'router');
  const hasWireless  = devices.some(d => d.device_type === 'wireless_ap');

  const switchesActive = location.pathname.startsWith('/switches');
  const [switchesOpen, setSwitchesOpen] = useState(switchesActive);
  const effectiveSwitchesOpen = switchesOpen || switchesActive;

  const routersActive = location.pathname.startsWith('/routers');
  const [routersOpen, setRoutersOpen] = useState(routersActive);
  const effectiveRoutersOpen = routersOpen || routersActive;

  const wirelessActive = location.pathname.startsWith('/wireless');
  const [wirelessOpen, setWirelessOpen] = useState(wirelessActive);
  const effectiveWirelessOpen = wirelessOpen || wirelessActive;

  const networkServicesActive = location.pathname.startsWith('/network-services');
  const [networkServicesOpen, setNetworkServicesOpen] = useState(networkServicesActive);
  const effectiveNetworkServicesOpen = networkServicesOpen || networkServicesActive;

  // On mobile the sidebar is always expanded (never icon-only)
  const isCollapsed = collapsed;

  const handleNavClick = () => {
    // Close mobile drawer when navigating
    onMobileClose();
  };

  return (
    <aside
      className={clsx(
        // Base styles
        'flex-shrink-0 bg-slate-100 dark:bg-slate-900 border-r border-gray-200 dark:border-slate-700 flex flex-col transition-all duration-200',
        // Mobile: fixed drawer that slides in/out
        'fixed inset-y-0 left-0 z-50',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        // Desktop: static in flex layout, normal collapse behaviour
        'md:relative md:translate-x-0',
        isCollapsed ? 'md:w-14' : 'md:w-56',
        // Mobile always full width
        'w-64',
      )}
    >
      {/* Logo */}
      <div
        className={clsx(
          'flex items-center border-b border-gray-200 dark:border-slate-700 py-5',
          isCollapsed ? 'md:justify-center md:px-2 px-4 gap-3' : 'gap-3 px-4'
        )}
      >
        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center flex-shrink-0">
          <Network className="w-4 h-4 text-white" />
        </div>
        {/* Always show text on mobile; respect collapsed on desktop */}
        <div className={clsx(isCollapsed && 'md:hidden')}>
          <div className="text-sm font-bold text-gray-900 dark:text-white leading-none">Mikrotik</div>
          <div className="text-xs text-gray-500 dark:text-slate-400 mt-0.5 leading-none">Manager</div>
          <div className="text-[10px] text-gray-400 dark:text-slate-500 mt-1 leading-none">{APP_VERSION}</div>
        </div>
        {/* Mobile close button */}
        <button
          onClick={onMobileClose}
          className="ml-auto p-1.5 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-slate-300 md:hidden"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            title={isCollapsed ? label : undefined}
            onClick={handleNavClick}
            className={({ isActive }) =>
              clsx(
                'flex items-center rounded-lg text-sm font-medium transition-colors duration-150',
                isCollapsed ? 'md:justify-center md:px-2 px-3 py-2.5 gap-3' : 'gap-3 px-3 py-2.5',
                isActive
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
              )
            }
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            <span className={clsx(isCollapsed && 'md:hidden')}>{label}</span>
          </NavLink>
        ))}

        {/* Switches group */}
        {hasSwitches && (
          isCollapsed ? (
            <NavLink
              to="/switches"
              title="Switches"
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center rounded-lg text-sm font-medium transition-colors duration-150 px-2 py-2.5',
                  isActive || switchesActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )
              }
            >
              <Layers className="w-4 h-4 flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <button
                onClick={() => setSwitchesOpen(o => !o)}
                className={clsx(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                  switchesActive
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )}
              >
                <Layers className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">Switches</span>
                <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', effectiveSwitchesOpen ? 'rotate-0' : '-rotate-90')} />
              </button>
              {effectiveSwitchesOpen && (
                <div className="ml-4 pl-3 border-l border-gray-300 dark:border-slate-600 space-y-0.5">
                  {switchSubItems.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end
                      onClick={handleNavClick}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-150',
                          isActive
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                        )
                      }
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}
            </>
          )
        )}

        {/* Routers group */}
        {hasRouters && (
          isCollapsed ? (
            <NavLink
              to="/routers"
              title="Routers"
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center rounded-lg text-sm font-medium transition-colors duration-150 px-2 py-2.5',
                  isActive || routersActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )
              }
            >
              <Router className="w-4 h-4 flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <button
                onClick={() => setRoutersOpen(o => !o)}
                className={clsx(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                  routersActive
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )}
              >
                <Router className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">Routers</span>
                <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', effectiveRoutersOpen ? 'rotate-0' : '-rotate-90')} />
              </button>
              {effectiveRoutersOpen && (
                <div className="ml-4 pl-3 border-l border-gray-300 dark:border-slate-600 space-y-0.5">
                  {routerSubItems.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end
                      onClick={handleNavClick}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-150',
                          isActive
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                        )
                      }
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}
            </>
          )
        )}

        {/* Wireless group */}
        {hasWireless && (
          isCollapsed ? (
            <NavLink
              to="/wireless"
              title="Wireless"
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center rounded-lg text-sm font-medium transition-colors duration-150 px-2 py-2.5',
                  isActive || wirelessActive
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )
              }
            >
              <Wifi className="w-4 h-4 flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <button
                onClick={() => setWirelessOpen(o => !o)}
                className={clsx(
                  'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                  wirelessActive
                    ? 'text-blue-600 dark:text-blue-400'
                    : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                )}
              >
                <Wifi className="w-4 h-4 flex-shrink-0" />
                <span className="flex-1 text-left">Wireless</span>
                <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', effectiveWirelessOpen ? 'rotate-0' : '-rotate-90')} />
              </button>
              {effectiveWirelessOpen && (
                <div className="ml-4 pl-3 border-l border-gray-300 dark:border-slate-600 space-y-0.5">
                  {wirelessSubItems.map(({ to, icon: Icon, label }) => (
                    <NavLink
                      key={to}
                      to={to}
                      end
                      onClick={handleNavClick}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-150',
                          isActive
                            ? 'bg-blue-600 text-white shadow-sm'
                            : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                        )
                      }
                    >
                      <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                      {label}
                    </NavLink>
                  ))}
                </div>
              )}
            </>
          )
        )}
        {/* Network Services group — always shown */}
        {isCollapsed ? (
          <NavLink
            to="/network-services"
            title="Network Services"
            onClick={handleNavClick}
            className={({ isActive }) =>
              clsx(
                'hidden md:flex items-center justify-center rounded-lg text-sm font-medium transition-colors duration-150 px-2 py-2.5',
                isActive || networkServicesActive
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
              )
            }
          >
            <Network className="w-4 h-4 flex-shrink-0" />
          </NavLink>
        ) : (
          <>
            <button
              onClick={() => setNetworkServicesOpen(o => !o)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-150',
                networkServicesActive
                  ? 'text-blue-600 dark:text-blue-400'
                  : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
              )}
            >
              <Network className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 text-left">Network Services</span>
              <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', effectiveNetworkServicesOpen ? 'rotate-0' : '-rotate-90')} />
            </button>
            {effectiveNetworkServicesOpen && (
              <div className="ml-4 pl-3 border-l border-gray-300 dark:border-slate-600 space-y-0.5">
                {networkServicesSubItems.map(({ to, icon: Icon, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end
                    onClick={handleNavClick}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm font-medium transition-colors duration-150',
                        isActive
                          ? 'bg-blue-600 text-white shadow-sm'
                          : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
                      )
                    }
                  >
                    <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                    {label}
                  </NavLink>
                ))}
              </div>
            )}
          </>
        )}
      </nav>

      {/* Settings + collapse toggle */}
      <div className="px-2 py-3 border-t border-gray-200 dark:border-slate-700 space-y-0.5">
        <NavLink
          to="/settings"
          title={isCollapsed ? 'Settings' : undefined}
          onClick={handleNavClick}
          className={({ isActive }) =>
            clsx(
              'flex items-center rounded-lg text-sm font-medium transition-colors duration-150',
              isCollapsed ? 'md:justify-center md:px-2 px-3 py-2.5 gap-3' : 'gap-3 px-3 py-2.5',
              isActive
                ? 'bg-blue-600 text-white shadow-sm'
                : 'text-gray-600 dark:text-slate-400 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-900 dark:hover:text-slate-100'
            )
          }
        >
          <Settings className="w-4 h-4 flex-shrink-0" />
          <span className={clsx(isCollapsed && 'md:hidden')}>Settings</span>
        </NavLink>

        {/* Collapse toggle — desktop only */}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'hidden md:flex w-full items-center rounded-lg text-sm font-medium transition-colors duration-150 text-gray-500 dark:text-slate-500 hover:bg-gray-200 dark:hover:bg-slate-700 hover:text-gray-700 dark:hover:text-slate-300',
            isCollapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'
          )}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 flex-shrink-0" />
          ) : (
            <><ChevronLeft className="w-4 h-4 flex-shrink-0" />Collapse</>
          )}
        </button>
      </div>
    </aside>
  );
}
