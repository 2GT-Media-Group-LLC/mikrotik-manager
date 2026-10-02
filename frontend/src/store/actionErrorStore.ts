import { create } from 'zustand';

/**
 * The last action that failed without a place of its own to say so (outside
 * review U5). Mutations that handle or show their errors themselves don't use
 * it; the rest used to fail silently, so a delete or a toggle that the server
 * refused looked like it had worked.
 */
interface ActionErrorState {
  message: string | null;
  report: (message: string) => void;
  dismiss: () => void;
}

export const useActionErrorStore = create<ActionErrorState>()((set) => ({
  message: null,
  report: (message) => set({ message }),
  dismiss: () => set({ message: null }),
}));

/** A readable message from an API or network error. */
export function actionErrorMessage(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string; code?: string };
  if (e?.response?.data?.error) return e.response.data.error;
  if (e?.code === 'ECONNABORTED') return 'The manager did not answer in time.';
  return e?.message || 'Something went wrong.';
}
