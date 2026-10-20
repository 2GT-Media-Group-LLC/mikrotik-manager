import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import clsx from 'clsx';

import { devicesApi } from '../../services/api';
import type { Device } from '../../types';
import DevicePicker from '../common/DevicePicker';
import { ruleSummary } from '../../utils/firewallSummary';
import {
  GuardedWriteUi,
  useGuardedWrite,
} from '../ChangeGuardDialog';

type Rule = Record<string, string> & { '.id': string };

interface Props {
  open: boolean;
  onClose: () => void;
  devices: Device[];
  initialDeviceId?: number | null;
}

function yes(value?: string): boolean {
  return value === 'yes' || value === 'true';
}

function monitorPrefix(action?: string): string | null {
  switch ((action ?? '').toLowerCase()) {
    case 'accept':
      return 'MTM-FW-ACCEPT ';
    case 'drop':
      return 'MTM-FW-DROP ';
    case 'reject':
      return 'MTM-FW-REJECT ';
    default:
      return null;
  }
}

function isManaged(rule: Rule): boolean {
  return yes(rule.log) && (rule['log-prefix'] ?? '').startsWith('MTM-FW-');
}

function hasCustomLogging(rule: Rule): boolean {
  const prefix = rule['log-prefix'] ?? '';

  return (
    (yes(rule.log) || prefix.length > 0) &&
    !prefix.startsWith('MTM-FW-')
  );
}

function connectionStates(rule: Rule): string[] {
  return (rule['connection-state'] ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function riskReason(rule: Rule): string | null {
  const action = (rule.action ?? '').toLowerCase();
  const states = connectionStates(rule);

  if (action === 'fasttrack-connection') {
    return 'FastTrack rules are not monitored — logging them can generate very high event volume.';
  }

  if (action === 'accept' && states.length === 0) {
    return 'This ACCEPT rule has no connection-state filter and may log every matching packet.';
  }

  if (states.includes('established') || states.includes('related')) {
    return 'This rule matches established/related traffic and may generate very high event volume.';
  }

  return null;
}

function blockedReason(rule: Rule): string | null {
  if (yes(rule.dynamic)) {
    return 'Dynamic RouterOS rule';
  }

  if (yes(rule.disabled)) {
    return 'Rule is disabled';
  }

  if (hasCustomLogging(rule)) {
    return 'Rule already has custom logging. Manager will not overwrite it.';
  }

  const action = (rule.action ?? '').toLowerCase();

  if (action === 'fasttrack-connection') {
    return 'FastTrack monitoring is intentionally disabled';
  }

  if (!monitorPrefix(action)) {
    return `Action "${action || 'unknown'}" is not a final ACCEPT/DROP/REJECT decision`;
  }

  return null;
}

function errMsg(error: unknown): string {
  return (
    error as {
      response?: {
        data?: {
          error?: string;
        };
      };
    }
  )?.response?.data?.error ?? 'Failed to update firewall monitoring';
}

export default function FirewallMonitoringModal({
  open,
  onClose,
  devices,
  initialDeviceId,
}: Props) {
  const queryClient = useQueryClient();
  const guard = useGuardedWrite();

  const [deviceId, setDeviceId] = useState<number | null>(
    initialDeviceId ?? null
  );
  const [allowRisky, setAllowRisky] = useState(false);
  const [error, setError] = useState('');

  const selectedDevice = devices.find((d) => d.id === deviceId);

  const {
    data: firewallRules = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['firewall-monitor-rules', deviceId],
    queryFn: () =>
      devicesApi.getFirewall(deviceId!).then((r) => r.data as Rule[]),
    enabled: open && deviceId != null,
    staleTime: 10_000,
  });

  const updateRule = useMutation({
    mutationFn: ({
      ruleId,
      data,
      confirm,
    }: {
      ruleId: string;
      data: Record<string, unknown>;
      confirm?: boolean;
    }) =>
      devicesApi.updateFirewallRule(deviceId!, ruleId, {
        ...data,
        ...(confirm ? { confirm_lockout: true } : {}),
      }),

    onSuccess: (response) => {
      setError('');
      queryClient.invalidateQueries({
        queryKey: ['firewall-monitor-rules', deviceId],
      });
      guard.onSuccess(response);
    },
  });

  const failed = (e: unknown) => setError(errMsg(e));

  const setMonitoring = (rule: Rule, enabled: boolean) => {
    const prefix = monitorPrefix(rule.action);
    if (!prefix && enabled) return;

    const data = enabled
      ? {
          log: 'yes',
          log_prefix: prefix,
        }
      : {
          log: 'no',
          log_prefix: '',
        };

    const request = {
      ruleId: rule['.id'],
      data,
    };

    updateRule.mutate(request, {
      onError: guard.onError(
        () =>
          updateRule.mutate(
            {
              ...request,
              confirm: true,
            },
            { onError: failed }
          ),
        failed
      ),
    });
  };

  if (!open) return null;

  const rules = firewallRules as Rule[];
  const managedCount = rules.filter(isManaged).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-5 border-b border-gray-200 dark:border-slate-700">
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Configure Firewall Monitoring
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-slate-400">
              Enable RouterOS logging for firewall rules you want to see in
              Firewall Logs.
            </p>
          </div>

          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-slate-200"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 border-b border-gray-200 dark:border-slate-700 space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <DevicePicker
              className="w-full sm:w-72"
              emptyLabel="Select device"
              devices={devices}
              aria-label="Monitoring device"
              value={deviceId}
              onChange={(id) => {
                setDeviceId(id);
                setAllowRisky(false);
                setError('');
              }}
            />

            {deviceId != null && (
              <>
                <button
                  onClick={() => refetch()}
                  disabled={isFetching}
                  className="btn-secondary flex items-center gap-2"
                >
                  <RefreshCw
                    className={clsx(
                      'w-4 h-4',
                      isFetching && 'animate-spin'
                    )}
                  />
                  Refresh
                </button>

                <span className="text-xs text-gray-500 dark:text-slate-400">
                  {managedCount} managed rule
                  {managedCount === 1 ? '' : 's'}
                </span>
              </>
            )}
          </div>

          <div className="rounded-lg border border-blue-200 dark:border-blue-900/60 bg-blue-50/50 dark:bg-blue-900/10 p-3 flex items-start gap-2">
            <ShieldCheck className="w-4 h-4 mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-400" />
            <div className="text-xs text-blue-800 dark:text-blue-300">
              Manager only changes <span className="font-mono">log</span> and{' '}
              <span className="font-mono">log-prefix</span>. Rule action,
              matching conditions and order remain unchanged. Existing custom
              logging is never overwritten.
            </div>
          </div>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allowRisky}
              onChange={(e) => setAllowRisky(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded"
            />

            <div>
              <div className="text-sm font-medium text-gray-700 dark:text-slate-300">
                Allow high-volume rules
              </div>
              <div className="text-xs text-gray-500 dark:text-slate-400">
                Allows monitoring ACCEPT rules without a new-connection filter
                and rules matching established/related traffic. This can create
                large amounts of log data.
              </div>
            </div>
          </label>

          {error && (
            <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {deviceId == null ? (
            <div className="p-12 text-center text-gray-500 dark:text-slate-400">
              Select a device to view its firewall rules.
            </div>
          ) : isLoading ? (
            <div className="p-12 text-center text-gray-400">
              Loading firewall rules...
            </div>
          ) : rules.length === 0 ? (
            <div className="p-12 text-center text-gray-500 dark:text-slate-400">
              No firewall filter rules found.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white dark:bg-slate-800 z-10">
                <tr className="border-b border-gray-200 dark:border-slate-700">
                  <th className="table-header px-4 py-2.5 text-left w-20">
                    Chain
                  </th>
                  <th className="table-header px-4 py-2.5 text-left w-24">
                    Action
                  </th>
                  <th className="table-header px-4 py-2.5 text-left">
                    Rule
                  </th>
                  <th className="table-header px-4 py-2.5 text-left w-44">
                    Logging
                  </th>
                  <th className="table-header px-4 py-2.5 text-right w-28">
                    Monitor
                  </th>
                </tr>
              </thead>

              <tbody className="divide-y divide-gray-100 dark:divide-slate-700 table-zebra">
                {rules.map((rule) => {
                  const managed = isManaged(rule);
                  const blocked = blockedReason(rule);
                  const risk = riskReason(rule);

                  const canToggle =
                    managed ||
                    (!blocked && (!risk || allowRisky));

                  const pending =
                    updateRule.isPending &&
                    updateRule.variables?.ruleId === rule['.id'];

                  const action = (rule.action ?? 'unknown').toLowerCase();

                  return (
                    <tr
                      key={rule['.id']}
                      className="hover:bg-gray-50 dark:hover:bg-slate-700/30"
                    >
                      <td className="px-4 py-3 text-xs font-mono text-gray-500 dark:text-slate-400">
                        {rule.chain || '—'}
                      </td>

                      <td className="px-4 py-3">
                        <span
                          className={clsx(
                            'text-xs font-semibold uppercase',
                            action === 'accept' &&
                              'text-green-600 dark:text-green-400',
                            (action === 'drop' ||
                              action === 'reject') &&
                              'text-red-600 dark:text-red-400',
                            action === 'fasttrack-connection' &&
                              'text-indigo-600 dark:text-indigo-400'
                          )}
                        >
                          {action}
                        </span>
                      </td>

                      <td className="px-4 py-3">
                        <div className="text-sm text-gray-800 dark:text-slate-200">
                          {rule.comment || ruleSummary(rule)}
                        </div>

                        {rule.comment && (
                          <div className="mt-0.5 text-xs text-gray-500 dark:text-slate-400">
                            {ruleSummary(rule)}
                          </div>
                        )}

                        {risk && !managed && (
                          <div className="mt-1 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            {risk}
                          </div>
                        )}

                        {blocked && !managed && (
                          <div className="mt-1 text-xs text-gray-400 dark:text-slate-500">
                            {blocked}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {managed ? (
                          <div>
                            <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                              Managed
                            </span>

                            <div className="mt-1 text-[11px] font-mono text-gray-400 dark:text-slate-500">
                              {rule['log-prefix']}
                            </div>
                          </div>
                        ) : hasCustomLogging(rule) ? (
                          <span className="inline-flex px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400">
                            Existing logging
                          </span>
                        ) : (
                          <span className="text-xs text-gray-400 dark:text-slate-500">
                            Off
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          aria-label={
                            managed
                              ? 'Disable firewall monitoring'
                              : 'Enable firewall monitoring'
                          }
                          aria-pressed={managed}
                          title={
                            canToggle
                              ? managed
                                ? 'Disable monitoring'
                                : 'Enable monitoring'
                              : blocked || risk || 'Monitoring unavailable'
                          }
                          disabled={!canToggle || pending}
                          onClick={() => setMonitoring(rule, !managed)}
                          className={clsx(
                            'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
                            managed
                              ? 'bg-blue-600'
                              : 'bg-gray-300 dark:bg-slate-600',
                            (!canToggle || pending) &&
                              'opacity-40 cursor-not-allowed'
                          )}
                        >
                          <span
                            className={clsx(
                              'inline-block h-4 w-4 transform rounded-full bg-white transition-transform',
                              managed
                                ? 'translate-x-6'
                                : 'translate-x-1'
                            )}
                          />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-slate-700 flex justify-between items-center">
          <div className="text-xs text-gray-500 dark:text-slate-400">
            Events appear after the next RouterOS log collection cycle.
          </div>

          <button onClick={onClose} className="btn-secondary">
            Close
          </button>
        </div>

        {deviceId != null && (
          <GuardedWriteUi
            state={guard}
            deviceId={deviceId}
            deviceName={selectedDevice?.name}
            pending={updateRule.isPending}
          />
        )}
      </div>
    </div>
  );
}
