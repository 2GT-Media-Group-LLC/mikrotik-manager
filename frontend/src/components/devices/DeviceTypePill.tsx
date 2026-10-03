/**
 * The one device-type badge (#203): the Firmware page had its own grey
 * version, and the dashboard tiles labelled anything that wasn't an AP or a
 * router as "SW".
 */
const TYPES: Record<string, { label: string; color: string }> = {
  wireless_ap: { label: 'AP',  color: 'var(--info)' },
  switch:      { label: 'SW',  color: 'var(--accent)' },
  router:      { label: 'RTR', color: 'var(--violet)' },
};

export function deviceTypeLabel(type: string | null | undefined): string {
  return TYPES[type ?? '']?.label ?? ((type ?? '').slice(0, 3).toUpperCase() || '—');
}

export default function DeviceTypePill({ type }: { type: string | null | undefined }) {
  const color = TYPES[type ?? '']?.color ?? 'var(--ink-3)';
  return (
    <span
      className="mono text-[10.5px] font-medium px-[6px] py-[2px] rounded-full"
      style={{ color, border: '1px solid var(--line)' }}
    >
      {deviceTypeLabel(type)}
    </span>
  );
}
