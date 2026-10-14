import { Cpu, AlertTriangle } from 'lucide-react';
import clsx from 'clsx';
import type { SwitchVlanView } from '../../services/api';

const MODE_HELP: Record<string, string> = {
  disabled: 'The VLAN table isn’t used on this port',
  fallback: 'VLAN table used; frames for VLANs not in it are forwarded as usual',
  check: 'Frames for VLANs not in the table are dropped',
  secure: 'Frames are dropped unless their VLAN is in the table and this port is a member',
};
const HEADER_HELP: Record<string, string> = {
  'leave-as-is': 'Frames leave as they arrived',
  'add-if-missing': 'Untagged frames get a tag on the way out (a trunk)',
  'always-strip': 'Tags are removed on the way out (an access port)',
};

/**
 * VLANs in the switch chip's own table (#278): older chips such as the
 * Atheros 8327 in a hAP ac² do VLANs here rather than with bridge VLAN
 * filtering, which on them moves switching to the CPU. Read-only for now.
 */
export default function SwitchVlanCard({ view }: { view: SwitchVlanView }) {
  const chip = view.switches.map((s) => s.type).filter(Boolean).join(', ');
  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <Cpu className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Switch chip VLANs</h3>
        <span className={clsx('px-2 py-0.5 rounded-full text-xs font-medium',
          view.inUse ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-600 dark:bg-slate-700 dark:text-slate-300')}>
          {view.inUse ? 'In use' : 'Not set up'}
        </span>
        {chip && <span className="text-xs text-gray-400 dark:text-slate-500 font-mono">{chip}</span>}
        <span className="ml-auto text-xs text-gray-400 dark:text-slate-500">read-only</span>
      </div>
      <p className="text-xs text-gray-500 dark:text-slate-400">
        This device&apos;s switch chip keeps VLANs in its own table (Switch, VLAN in WinBox) rather than with
        bridge VLAN filtering, which on this chip moves switching to the CPU. Showing them here is the first
        step; for now, change them in WinBox or with a command.
      </p>

      {view.filteringBridges.length > 0 && (
        <div className="flex gap-2 p-2.5 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-xs text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <p>
            VLAN filtering is on for {view.filteringBridges.join(', ')}. On this switch chip that bridge&apos;s
            traffic is switched by the CPU, not the chip.
          </p>
        </div>
      )}

      {view.vlans.length > 0 ? (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="py-1.5 pr-3 font-medium">VLAN</th>
              <th className="py-1.5 pr-3 font-medium">Ports</th>
              <th className="py-1.5 font-medium">Switch</th>
            </tr>
          </thead>
          <tbody>
            {view.vlans.map((v) => (
              <tr key={v.id || `${v.switch}-${v.vlanId}`} className={clsx('border-b border-gray-100 dark:border-slate-800', v.disabled && 'opacity-50')}>
                <td className="py-1.5 pr-3 font-mono text-gray-900 dark:text-white">{v.vlanId}{v.disabled && <span className="ml-1 text-gray-400">(disabled)</span>}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300">{v.ports.join(', ') || '—'}</td>
                <td className="py-1.5 font-mono text-gray-500 dark:text-slate-400">{v.switch}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-xs text-gray-400 dark:text-slate-500">The switch VLAN table is empty.</p>
      )}

      {view.ports.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-gray-500 dark:text-slate-400 border-b border-gray-200 dark:border-slate-700">
              <th className="py-1.5 pr-3 font-medium">Port</th>
              <th className="py-1.5 pr-3 font-medium">VLAN mode</th>
              <th className="py-1.5 pr-3 font-medium">VLAN header</th>
              <th className="py-1.5 font-medium">Default VLAN</th>
            </tr>
          </thead>
          <tbody>
            {view.ports.map((p) => (
              <tr key={`${p.switch}-${p.name}`} className="border-b border-gray-100 dark:border-slate-800">
                <td className="py-1.5 pr-3 font-mono text-gray-900 dark:text-white">{p.name}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300" title={MODE_HELP[p.vlanMode]}>{p.vlanMode || '—'}</td>
                <td className="py-1.5 pr-3 font-mono text-gray-700 dark:text-slate-300" title={HEADER_HELP[p.vlanHeader]}>{p.vlanHeader || '—'}</td>
                <td className="py-1.5 font-mono text-gray-700 dark:text-slate-300">{p.defaultVlanId || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
