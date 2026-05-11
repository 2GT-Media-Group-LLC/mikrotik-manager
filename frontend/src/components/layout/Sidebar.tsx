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
  { to: '/network-services/wireguard',  icon: Shield,   label: 'WireGuard' },
  { to: '/network-services/syslog',     icon: FileText, label: 'Syslog' },
];

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
}

function NavItem({
  to,
  icon: Icon,
  label,
  isCollapsed,
  onClick,
  end,
}: {
  to: string;
  icon: React.ElementType;
  label: string;
  isCollapsed: boolean;
  onClick: () => void;
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      title={isCollapsed ? label : undefined}
      onClick={onClick}
      className={({ isActive }) =>
        clsx(
          'flex items-center gap-[10px] rounded-[6px] text-[13px] font-medium transition-colors duration-150 relative',
          isCollapsed ? 'md:justify-center md:px-2 px-[10px] py-[7px]' : 'px-[10px] py-[7px]',
          isActive
            ? 'bg-surface-3 text-ink font-semibold border-l-2 border-accent pl-[8px]'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-l-2 border-transparent'
        )
      }
    >
      <Icon className="w-[15px] h-[15px] flex-shrink-0" />
      <span className={clsx(isCollapsed && 'md:hidden')}>{label}</span>
    </NavLink>
  );
}

function GroupHeader({
  icon: Icon,
  label,
  isActive,
  isOpen,
  onToggle,
}: {
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={clsx(
        'w-full flex items-center gap-[10px] px-[10px] py-[7px] rounded-[6px] text-[13px] font-medium transition-colors duration-150 border-l-2 border-transparent',
        isActive ? 'text-accent' : 'text-ink-2 hover:bg-surface-3 hover:text-ink'
      )}
    >
      <Icon className="w-[15px] h-[15px] flex-shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', isOpen ? 'rotate-0' : '-rotate-90')} />
    </button>
  );
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

  const onlineCount = devices.filter(d => d.status === 'online').length;

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

  const isCollapsed = collapsed;

  const handleNavClick = () => {
    onMobileClose();
  };

  return (
    <aside
      className={clsx(
        'flex-shrink-0 flex flex-col transition-all duration-200',
        'fixed inset-y-0 left-0 z-50',
        mobileOpen ? 'translate-x-0' : '-translate-x-full',
        'md:relative md:translate-x-0',
        isCollapsed ? 'md:w-14' : 'md:w-56',
        'w-64',
      )}
      style={{ background: 'var(--surface)', borderRight: '1px solid var(--line)' }}
    >
      {/* Brand block */}
      <div
        className={clsx(
          'flex items-center py-[22px]',
          isCollapsed ? 'md:justify-center md:px-2 px-4 gap-[10px]' : 'gap-[10px] px-4',
          'border-b'
        )}
        style={{ borderColor: 'var(--line)' }}
      >
        <div
          className="w-[30px] h-[30px] rounded-[7px] flex items-center justify-center flex-shrink-0"
          style={{ background: 'linear-gradient(135deg, var(--accent), var(--accent-2))' }}
        >
          <Network className="w-4 h-4" style={{ color: 'var(--accent-fg)' }} />
        </div>
        <div className={clsx(isCollapsed && 'md:hidden')}>
          <div className="text-[14px] font-semibold leading-none" style={{ color: 'var(--ink)' }}>Mikrotik Manager</div>
          <div className="text-[11px] leading-none mt-[3px]" style={{ color: 'var(--ink-3)' }}>{APP_VERSION}</div>
        </div>
        <button
          onClick={onMobileClose}
          className="ml-auto p-1.5 rounded-lg md:hidden"
          style={{ color: 'var(--ink-4)' }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-[14px] py-3 space-y-[1px] overflow-y-auto">
        {navItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} isCollapsed={isCollapsed} onClick={handleNavClick} />
        ))}

        {/* Divider before device-type groups */}
        {(hasSwitches || hasRouters || hasWireless) && !isCollapsed && (
          <div className="my-[6px] mx-2" style={{ height: 1, background: 'var(--line)' }} />
        )}

        {/* Switches group */}
        {hasSwitches && (
          isCollapsed ? (
            <NavLink
              to="/switches"
              title="Switches"
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-2 py-[7px] border-l-2',
                  isActive || switchesActive
                    ? 'bg-surface-3 text-ink border-accent'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                )
              }
            >
              <Layers className="w-[15px] h-[15px] flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <GroupHeader
                icon={Layers}
                label="Switches"
                isActive={switchesActive}
                isOpen={effectiveSwitchesOpen}
                onToggle={() => setSwitchesOpen(o => !o)}
              />
              {effectiveSwitchesOpen && (
                <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                  {switchSubItems.map(({ to, icon, label }) => (
                    <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
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
                  'hidden md:flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-2 py-[7px] border-l-2',
                  isActive || routersActive
                    ? 'bg-surface-3 text-ink border-accent'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                )
              }
            >
              <Router className="w-[15px] h-[15px] flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <GroupHeader
                icon={Router}
                label="Routers"
                isActive={routersActive}
                isOpen={effectiveRoutersOpen}
                onToggle={() => setRoutersOpen(o => !o)}
              />
              {effectiveRoutersOpen && (
                <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                  {routerSubItems.map(({ to, icon, label }) => (
                    <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
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
                  'hidden md:flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-2 py-[7px] border-l-2',
                  isActive || wirelessActive
                    ? 'bg-surface-3 text-ink border-accent'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                )
              }
            >
              <Wifi className="w-[15px] h-[15px] flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <GroupHeader
                icon={Wifi}
                label="Wireless"
                isActive={wirelessActive}
                isOpen={effectiveWirelessOpen}
                onToggle={() => setWirelessOpen(o => !o)}
              />
              {effectiveWirelessOpen && (
                <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                  {wirelessSubItems.map(({ to, icon, label }) => (
                    <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
                  ))}
                </div>
              )}
            </>
          )
        )}

        {/* Network Services group */}
        <div className="mt-[6px]" style={{ height: 1, background: 'var(--line)', marginInline: '8px' }} />
        <div className="mt-[6px]">
          {isCollapsed ? (
            <NavLink
              to="/network-services"
              title="Network Services"
              onClick={handleNavClick}
              className={({ isActive }) =>
                clsx(
                  'hidden md:flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-2 py-[7px] border-l-2',
                  isActive || networkServicesActive
                    ? 'bg-surface-3 text-ink border-accent'
                    : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                )
              }
            >
              <Network className="w-[15px] h-[15px] flex-shrink-0" />
            </NavLink>
          ) : (
            <>
              <GroupHeader
                icon={Network}
                label="Network Services"
                isActive={networkServicesActive}
                isOpen={effectiveNetworkServicesOpen}
                onToggle={() => setNetworkServicesOpen(o => !o)}
              />
              {effectiveNetworkServicesOpen && (
                <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                  {networkServicesSubItems.map(({ to, icon, label }) => (
                    <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </nav>

      {/* Footer: poll status card + settings + collapse */}
      <div className="px-[14px] pb-3 space-y-1">
        {/* Poll status card */}
        {!isCollapsed && devices.length > 0 && (
          <div
            className="px-3 py-[10px] rounded-[8px] mb-2 text-[11.5px] leading-[1.45]"
            style={{ background: 'var(--surface-2)', color: 'var(--ink-3)' }}
          >
            <div className="flex items-center gap-[6px] mb-1">
              <span
                className="w-[6px] h-[6px] rounded-full flex-shrink-0"
                style={{
                  background: 'var(--good)',
                  boxShadow: '0 0 0 2px rgba(141,224,138,0.2), 0 0 8px rgba(141,224,138,0.5)',
                }}
              />
              <span className="font-semibold text-[11.5px]" style={{ color: 'var(--ink-2)' }}>
                {onlineCount === devices.length ? 'All polls healthy' : `${onlineCount}/${devices.length} reachable`}
              </span>
            </div>
            <span className="mono text-[10.5px]">{onlineCount}/{devices.length} online</span>
          </div>
        )}

        {/* Settings link */}
        <NavItem
          to="/settings"
          icon={Settings}
          label="Settings"
          isCollapsed={isCollapsed}
          onClick={handleNavClick}
        />

        {/* Collapse toggle — desktop only */}
        <button
          onClick={() => setCollapsed(c => !c)}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={clsx(
            'hidden md:flex w-full items-center rounded-[6px] text-[13px] font-medium transition-colors duration-150',
            isCollapsed ? 'justify-center px-2 py-[7px]' : 'gap-[10px] px-[10px] py-[7px]',
            'border-l-2 border-transparent hover:bg-surface-3'
          )}
          style={{ color: 'var(--ink-4)' }}
        >
          {isCollapsed ? (
            <ChevronRight className="w-[15px] h-[15px] flex-shrink-0" />
          ) : (
            <><ChevronLeft className="w-[15px] h-[15px] flex-shrink-0" />Collapse</>
          )}
        </button>
      </div>
    </aside>
  );
}
