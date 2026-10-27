import { useQuery } from '@tanstack/react-query';
import { jumpHostsApi, sitesApi } from '../../services/api';

interface Props {
  /** The site the device is in, or joins; 'new' for a site being created with it. */
  siteId: number | null | 'new';
  /** A jump host's id, null for direct, or undefined for the site's default (adding only). */
  value: number | null | undefined;
  onChange: (value: number | null | undefined) => void;
  /** Offer "the site's default": when adding a device. */
  allowSiteDefault?: boolean;
}

/**
 * How the manager reaches a device: directly, or through an SSH jump host
 * (Operations → Credentials). Hidden until there is a jump host to choose.
 */
export default function JumpHostField({ siteId, value, onChange, allowSiteDefault }: Props) {
  const { data: jumpHosts = [] } = useQuery({
    queryKey: ['jump-hosts'],
    queryFn: () => jumpHostsApi.list().then((r) => r.data),
    staleTime: 60_000,
  });
  const { data: sites = [] } = useQuery({
    queryKey: ['sites'],
    queryFn: () => sitesApi.list().then((r) => r.data),
    staleTime: 300_000,
    enabled: !!allowSiteDefault,
  });

  // A site's jump hosts are only for its own devices.
  const choices = jumpHosts.filter((j) => j.site_id == null || (siteId !== 'new' && j.site_id === siteId));
  if (choices.length === 0 && value == null) return null;

  const site = siteId === 'new' ? null
    : sites.find((s) => (siteId == null ? s.is_default : s.id === siteId));
  const siteDefault = site?.default_jump_host_id != null
    ? jumpHosts.find((j) => j.id === site.default_jump_host_id)?.name ?? 'its jump host'
    : 'direct';

  const selected = value === undefined ? 'default' : value === null ? 'direct' : String(value);
  return (
    <div>
      <label className="label">Connect via</label>
      <select
        className="input"
        value={selected}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'default' ? undefined : v === 'direct' ? null : Number(v));
        }}
      >
        {allowSiteDefault && <option value="default">Site default ({siteDefault})</option>}
        <option value="direct">Direct connection</option>
        {choices.map((j) => (
          <option key={j.id} value={j.id}>
            Jump host: {j.name} ({j.host})
          </option>
        ))}
      </select>
      <p className="text-[11px] text-gray-400 dark:text-slate-500 mt-1">
        Through a jump host, the API, SSH, backups and the terminal all go through that router. If it is down, the
        device shows as offline; it is never connected to another way.
      </p>
    </div>
  );
}
