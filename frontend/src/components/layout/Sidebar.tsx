import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Router, Users, Bell, GitBranch, HardDrive,
  Settings, Network, ChevronLeft, ChevronRight, Layers, ChevronDown, SlidersHorizontal, X, Wifi,
  Server, Globe, Clock, Shield, FileText, Activity, BarChart3, Ticket, ArrowUpCircle, Radio,
  LayoutGrid, TerminalSquare,
} from 'lucide-react';
import clsx from 'clsx';
import { APP_VERSION } from '../../version';
import { devicesApi } from '../../services/api';

const monitorItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/topology',  icon: GitBranch,       label: 'Topology' },
  { to: '/traffic',   icon: Activity,        label: 'Traffic' },
  { to: '/events',    icon: Bell,            label: 'Events' },
  { to: '/security',  icon: Shield,          label: 'Security' },
];

const wirelessSubItems = [
  { to: '/wireless',          icon: Wifi,              label: 'Overview' },
  { to: '/wireless/settings', icon: SlidersHorizontal, label: 'Radios & SSIDs' },
  { to: '/wireless/guest',    icon: Ticket,            label: 'Guest WiFi' },
];

const networkServicesSubItems = [
  { to: '/network-services',            icon: Network,   label: 'Overview' },
  { to: '/network-services/dhcp',       icon: Server,    label: 'DHCP' },
  { to: '/network-services/dns',        icon: Globe,     label: 'DNS' },
  { to: '/network-services/ntp',        icon: Clock,     label: 'NTP' },
  { to: '/network-services/wireguard',  icon: Shield,    label: 'WireGuard' },
  { to: '/network-services/syslog',     icon: FileText,  label: 'Logging' },
  { to: '/network-services/netflow',    icon: BarChart3, label: 'NetFlow' },
  { to: '/network-services/discovery',  icon: Radio,     label: 'Discovery & SNMP' },
];

const operationsItems = [
  { to: '/firmware',  icon: ArrowUpCircle,   label: 'Firmware' },
  { to: '/commands',  icon: TerminalSquare,  label: 'Bulk Commands' },
  { to: '/backups',   icon: HardDrive,       label: 'Backups' },
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
      <Icon className="w-[17px] h-[17px] flex-shrink-0" />
      <span className={clsx(isCollapsed && 'md:hidden')}>{label}</span>
    </NavLink>
  );
}

function SectionLabel({ label, isCollapsed }: { label: string; isCollapsed: boolean }) {
  if (isCollapsed) {
    return <div className="hidden md:block my-[8px] mx-2" style={{ height: 1, background: 'var(--line)' }} />;
  }
  return (
    <div
      className="px-[10px] pt-[14px] pb-[4px] text-[10px] font-semibold uppercase tracking-[0.08em] select-none"
      style={{ color: 'var(--ink-4)' }}
    >
      {label}
    </div>
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
      <Icon className="w-[17px] h-[17px] flex-shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      <ChevronDown className={clsx('w-3.5 h-3.5 transition-transform', isOpen ? 'rotate-0' : '-rotate-90')} />
    </button>
  );
}

/** Collapsed-sidebar icon link that represents a whole group. */
function CollapsedGroupLink({
  to,
  icon: Icon,
  label,
  groupActive,
  onClick,
}: {
  to: string;
  icon: React.ElementType;
  label: string;
  groupActive: boolean;
  onClick: () => void;
}) {
  return (
    <NavLink
      to={to}
      title={label}
      onClick={onClick}
      className={({ isActive }) =>
        clsx(
          'hidden md:flex items-center justify-center rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-2 py-[7px] border-l-2',
          isActive || groupActive
            ? 'bg-surface-3 text-ink border-accent'
            : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
        )
      }
    >
      <Icon className="w-[17px] h-[17px] flex-shrink-0" />
    </NavLink>
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

  // Collapsible groups: until the user touches the chevron (pref === null) a
  // group is open exactly when its section is active; after that the manual
  // choice wins, so collapse always works — even inside the active section.
  const devicesActive = location.pathname.startsWith('/devices');
  const [devicesOpenPref, setDevicesOpenPref] = useState<boolean | null>(null);
  const devicesOpen = devicesOpenPref ?? devicesActive;

  const wirelessActive = location.pathname.startsWith('/wireless');
  const [wirelessOpenPref, setWirelessOpenPref] = useState<boolean | null>(null);
  const wirelessOpen = wirelessOpenPref ?? wirelessActive;

  const networkServicesActive = location.pathname.startsWith('/network-services');
  const [networkServicesOpenPref, setNetworkServicesOpenPref] = useState<boolean | null>(null);
  const networkServicesOpen = networkServicesOpenPref ?? networkServicesActive;

  const isCollapsed = collapsed;

  const handleNavClick = () => {
    onMobileClose();
  };

  // Devices sub-links deep-link into the type-filtered device list.
  const deviceTypeLinks = [
    { to: '/devices',          icon: LayoutGrid, label: 'All Devices' },
    ...(hasRouters  ? [{ to: '/devices?type=RTR', icon: Router, label: 'Routers' }] : []),
    ...(hasSwitches ? [{ to: '/devices?type=SW',  icon: Layers, label: 'Switches' }] : []),
    ...(hasWireless ? [{ to: '/devices?type=AP',  icon: Wifi,   label: 'Wireless APs' }] : []),
  ];
  // With a single device type the sub-links add nothing over the plain entry.
  const showDevicesGroup = deviceTypeLinks.length > 2;

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
        {/* Theme-aware logo: light-tile icon in light mode, navy-tile icon in dark mode */}
        <img src="/logo-light.svg" alt="MikroTik Manager" className="w-[45px] h-[45px] flex-shrink-0 block dark:hidden" />
        <img src="/logo-dark.svg" alt="MikroTik Manager" className="w-[45px] h-[45px] flex-shrink-0 hidden dark:block" />
        <div className={clsx(isCollapsed && 'md:hidden')}>
          <div className="text-[14px] font-semibold leading-none" style={{ color: 'var(--ink)' }}>MikroTik Manager</div>
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
        {/* ── Monitor ── */}
        <SectionLabel label="Monitor" isCollapsed={isCollapsed} />
        {monitorItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} isCollapsed={isCollapsed} onClick={handleNavClick} />
        ))}

        {/* ── Network ── */}
        <SectionLabel label="Network" isCollapsed={isCollapsed} />

        {/* Devices — collapsible group when more than one device type exists */}
        {isCollapsed ? (
          <CollapsedGroupLink to="/devices" icon={Router} label="Devices" groupActive={devicesActive} onClick={handleNavClick} />
        ) : !showDevicesGroup ? (
          <NavItem to="/devices" icon={Router} label="Devices" isCollapsed={false} onClick={handleNavClick} />
        ) : (
          <>
            <GroupHeader
              icon={Router}
              label="Devices"
              isActive={devicesActive}
              isOpen={devicesOpen}
              onToggle={() => setDevicesOpenPref(!devicesOpen)}
            />
            {devicesOpen && (
              <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                {deviceTypeLinks.map(({ to, icon: Icon, label }) => {
                  const [path, query] = to.split('?');
                  const isActive = location.pathname === path &&
                    (query ? location.search === `?${query}` : !location.search.includes('type='));
                  return (
                    <NavLink
                      key={to}
                      to={to}
                      onClick={handleNavClick}
                      className={clsx(
                        'flex items-center gap-[10px] rounded-[6px] text-[13px] font-medium transition-colors duration-150 px-[10px] py-[7px] border-l-2',
                        isActive
                          ? 'bg-surface-3 text-ink font-semibold border-accent pl-[8px]'
                          : 'text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                      )}
                    >
                      <Icon className="w-[17px] h-[17px] flex-shrink-0" />
                      <span>{label}</span>
                    </NavLink>
                  );
                })}
              </div>
            )}
          </>
        )}

        <NavItem to="/clients" icon={Users} label="Clients" isCollapsed={isCollapsed} onClick={handleNavClick} />

        {/* Wireless group (only when wireless APs are managed) */}
        {hasWireless && (
          isCollapsed ? (
            <CollapsedGroupLink to="/wireless" icon={Wifi} label="Wireless" groupActive={wirelessActive} onClick={handleNavClick} />
          ) : (
            <>
              <GroupHeader
                icon={Wifi}
                label="Wireless"
                isActive={wirelessActive}
                isOpen={wirelessOpen}
                onToggle={() => setWirelessOpenPref(!wirelessOpen)}
              />
              {wirelessOpen && (
                <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                  {wirelessSubItems.map(({ to, icon, label }) => (
                    <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
                  ))}
                </div>
              )}
            </>
          )
        )}

        {/* ── Services ── */}
        <SectionLabel label="Services" isCollapsed={isCollapsed} />
        {isCollapsed ? (
          <CollapsedGroupLink to="/network-services" icon={Network} label="Network Services" groupActive={networkServicesActive} onClick={handleNavClick} />
        ) : (
          <>
            <GroupHeader
              icon={Network}
              label="Network Services"
              isActive={networkServicesActive}
              isOpen={networkServicesOpen}
              onToggle={() => setNetworkServicesOpenPref(!networkServicesOpen)}
            />
            {networkServicesOpen && (
              <div className="ml-4 pl-3 space-y-[1px]" style={{ borderLeft: '1px solid var(--line)' }}>
                {networkServicesSubItems.map(({ to, icon, label }) => (
                  <NavItem key={to} to={to} end icon={icon} label={label} isCollapsed={false} onClick={handleNavClick} />
                ))}
              </div>
            )}
          </>
        )}

        {/* ── Operations ── */}
        <SectionLabel label="Operations" isCollapsed={isCollapsed} />
        {operationsItems.map(({ to, icon, label }) => (
          <NavItem key={to} to={to} icon={icon} label={label} isCollapsed={isCollapsed} onClick={handleNavClick} />
        ))}
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
            <ChevronRight className="w-[17px] h-[17px] flex-shrink-0" />
          ) : (
            <><ChevronLeft className="w-[17px] h-[17px] flex-shrink-0" />Collapse</>
          )}
        </button>
      </div>
    </aside>
  );
}
