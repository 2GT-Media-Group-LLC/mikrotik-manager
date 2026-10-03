/** Badge styles for firmware rollouts and their devices. */

export const ITEM_STATUS: Record<string, { label: string; cls: string; spin?: boolean }> = {
  pending:    { label: 'Pending',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
  backing_up: { label: 'Backing up',   cls: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400', spin: true },
  upgrading:  { label: 'Upgrading',    cls: 'bg-violet-100 dark:bg-violet-900/30 text-violet-700 dark:text-violet-400', spin: true },
  rebooting:  { label: 'Rebooting',    cls: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400', spin: true },
  verifying:  { label: 'Verifying',    cls: 'bg-cyan-100 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-400', spin: true },
  success:    { label: 'Success',      cls: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' },
  failed:     { label: 'Failed',       cls: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400' },
  skipped:    { label: 'Skipped',      cls: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400' },
};

export const ROLLOUT_STATUS: Record<string, string> = {
  pending:   'bg-gray-100 dark:bg-slate-700 text-gray-600 dark:text-slate-300',
  running:   'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400',
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400',
  failed:    'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400',
  cancelled: 'bg-gray-100 dark:bg-slate-700 text-gray-500 dark:text-slate-400',
  missed:    'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300',
};
