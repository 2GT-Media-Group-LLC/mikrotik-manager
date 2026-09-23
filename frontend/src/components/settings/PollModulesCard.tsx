import { Layers, AlertTriangle } from 'lucide-react';

/**
 * Switching off collectors.
 *
 * Requested by an operator with ~1,500 devices who wants to cut traffic to and
 * from each router. Every collector here is a round trip per device per cycle,
 * so switching one off removes work from the whole fleet rather than shaving
 * milliseconds.
 *
 * Each one costs a feature, and the copy says which. These are not tuning
 * knobs: turning off neighbours stops the topology map updating, and an
 * operator who discovers that three weeks later has been misled.
 */

interface ModuleDef {
  key: string;
  label: string;
  cost: string;
  cadence: string;
}

const MODULES: ModuleDef[] = [
  {
    key: 'poll_clients_enabled',
    label: 'Connected clients',
    cadence: 'every fast poll',
    cost: 'No client list, per-client traffic or device fingerprinting. The heaviest collector on most fleets.',
  },
  {
    key: 'poll_neighbors_enabled',
    label: 'Neighbour discovery',
    cadence: 'every slow poll',
    cost: 'Topology stops updating, and new devices are no longer discovered automatically.',
  },
  {
    key: 'poll_logs_enabled',
    label: 'Device logs',
    cadence: 'its own 60s poll',
    cost: 'No events, and nothing that reads them — log alerts and the events page go quiet. Skips the session entirely.',
  },
  {
    key: 'poll_certificates_enabled',
    label: 'Certificates',
    cadence: 'every slow poll',
    cost: 'No certificate inventory and no expiry warnings.',
  },
];

interface Props {
  settings: Record<string, unknown>;
  onChange: (data: Record<string, unknown>) => void;
  saving: boolean;
}

export default function PollModulesCard({ settings, onChange, saving }: Props) {
  // Anything not explicitly false counts as on, matching the server.
  const isOn = (key: string) => settings[key] !== false;
  const anyOff = MODULES.some((m) => !isOn(m.key));

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-1">
        <Layers className="w-4 h-4 text-blue-500" />
        <h3 className="font-semibold text-gray-900 dark:text-white">Collectors</h3>
      </div>
      <p className="text-xs text-gray-400 dark:text-slate-500 mb-4">
        What each poll gathers. Switching one off reduces traffic to every device on every
        cycle — the lever that matters on a large fleet — at the cost of the feature it feeds.
      </p>

      <div className="space-y-3">
        {MODULES.map((m) => (
          <label key={m.key} className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={isOn(m.key)}
              disabled={saving}
              onChange={(e) => onChange({ [m.key]: e.target.checked })}
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="text-sm font-medium text-gray-700 dark:text-slate-300">
                {m.label}
              </span>
              <span className="text-[11px] text-gray-400 dark:text-slate-500"> · {m.cadence}</span>
              {!isOn(m.key) && (
                <span className="block text-[11.5px] text-amber-600 dark:text-amber-400 mt-0.5">
                  {m.cost}
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {anyOff && (
        <div className="flex items-start gap-2 text-[11.5px] rounded p-2.5 mt-4 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" />
          <span>
            Historical data already collected is kept, but stops being refreshed. Pages fed by a
            disabled collector will show data that quietly ages rather than an empty state.
          </span>
        </div>
      )}
    </div>
  );
}
