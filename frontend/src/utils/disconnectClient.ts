import { clientsApi } from '../services/api';

type ApiError = { response?: { status?: number; data?: { error?: string; managed_device?: string } } };

/**
 * Disconnect a wireless client (#338), asking first. When the client turns out
 * to be a managed device (a wireless backhaul in station mode), the server
 * says so and it asks again before going ahead. Resolves to the message to
 * show, or null when the user cancelled.
 */
export async function disconnectClient(mac: string, label: string, apName?: string | null): Promise<{ ok: boolean; message: string } | null> {
  const where = apName ? ` from ${apName}` : '';
  if (!window.confirm(`Disconnect ${label}${where}? It's removed from the access point's registration table and normally reconnects within a few seconds.`)) return null;
  const run = async (confirmManaged: boolean): Promise<{ ok: boolean; message: string } | null> => {
    try {
      const { data } = await clientsApi.disconnect(mac, confirmManaged);
      return { ok: true, message: data.message };
    } catch (e) {
      const res = (e as ApiError).response;
      if (res?.status === 409 && res.data?.managed_device && !confirmManaged) {
        if (!window.confirm(`${res.data.error ?? 'This is a managed device.'}\n\nDisconnect it anyway?`)) return null;
        return run(true);
      }
      return { ok: false, message: res?.data?.error ?? 'Could not disconnect the client' };
    }
  };
  return run(false);
}
