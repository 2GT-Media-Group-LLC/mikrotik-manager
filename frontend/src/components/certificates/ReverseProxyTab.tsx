import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Check, Pencil, Plus, Power, RefreshCw, Trash2, X, ArrowRightLeft, ShieldCheck, Lock } from 'lucide-react';
import clsx from 'clsx';
import { format } from 'date-fns';
import { reverseProxyApi, type ProxyDeviceView, type ProxyFleetDevice, type ProxyFix, type ProxyRule } from '../../services/api';
import { useCanWrite, useIsFleetAdmin } from '../../hooks/useCanWrite';
import { useGuardedWrite, GuardedWriteUi } from '../ChangeGuardDialog';
import ReviewChangesButton from '../common/ReviewChangesButton';
import DeviceTypePill from '../devices/DeviceTypePill';
import { apiErrorMessage } from '../../utils/apiError';
import { ruleErrors, movePortError, certCovers, normalizeSni, sniError, isAcmeName, ISSUE_FROM_CA, LETS_ENCRYPT, type RuleForm } from '../../utils/reverseProxy';

const label = 'block text-xs font-medium text-gray-600 dark:text-slate-300 mb-1';
const fieldError = (msg?: string | null) => (msg ? <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">{msg}</p> : null);
const day = (s: string | null | undefined) => (s ? format(new Date(s), 'MMM d, yyyy') : '—');
const soon = (s: string | null | undefined) => !!s && new Date(s).getTime() - Date.now() < 30 * 86_400_000;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white dark:bg-slate-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 dark:border-slate-700">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Which service moves when both want the same port; the user chooses. */
function PortChoice({ view, value, onChange, proxyActive = true, intro }: { view: ProxyDeviceView; value: { service: ProxyFix['service']; port: string };
  onChange: (v: { service: ProxyFix['service']; port: string }) => void; proxyActive?: boolean; intro?: string }) {
  const err = movePortError(view.services, value.service, value.port, proxyActive);
  return (
    <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 space-y-2 text-sm">
      <p className="flex gap-2 text-amber-800 dark:text-amber-300">
        <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <span>{intro ?? `WebFig over HTTPS (www-ssl) also uses port ${view.service.port}, so once this rule is on, one of them couldn't listen. Choose which moves:`}</span>
      </p>
      <label className="flex items-center gap-2">
        <input type="radio" checked={value.service === 'www-ssl'} onChange={() => onChange({ ...value, service: 'www-ssl' })} />
        Move WebFig HTTPS
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" checked={value.service === 'reverse-proxy'} onChange={() => onChange({ ...value, service: 'reverse-proxy' })} />
        Move the reverse proxy (then addresses need the port, like https://nas.example.com:{value.port || '…'})
      </label>
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-600 dark:text-slate-300">to port</span>
        <input className="input w-24" value={value.port} onChange={(e) => onChange({ ...value, port: e.target.value })} />
      </div>
      {fieldError(err)}
    </div>
  );
}

function RuleModal({ deviceId, existing, onClose }: { deviceId: number; existing?: ProxyRule; onClose: () => void }) {
  const qc = useQueryClient();
  const isAdmin = useIsFleetAdmin();
  const { data: view, isLoading, error } = useQuery({
    queryKey: ['reverse-proxy-device', deviceId],
    queryFn: () => reverseProxyApi.device(deviceId).then((r) => r.data),
  });
  const [f, setF] = useState<RuleForm>({
    sni: existing?.sni ?? '', ip: existing?.ipAddress ?? '', port: existing?.port ? String(existing.port) : '',
    certificate: existing ? (isAcmeName(existing.certificate) ? LETS_ENCRYPT : existing.certificate ?? 'none') : '',
    vrf: existing?.vrf ?? '', comment: existing?.comment ?? '', enabled: existing ? !existing.disabled : true,
  });
  // Let's Encrypt's staging server first: no rate limits, but browsers don't trust what it issues.
  const [staging, setStaging] = useState(existing?.certificate ? /^mtm-le-staging-/.test(existing.certificate) : true);
  const acmeOn = f.certificate === LETS_ENCRYPT;
  const dnsName = acmeOn && !sniError(f.sni) ? normalizeSni(f.sni) : '';
  const { data: dnsHint } = useQuery({
    queryKey: ['reverse-proxy-dns', dnsName],
    queryFn: () => reverseProxyApi.dns(dnsName).then((r) => r.data),
    enabled: !!dnsName,
    staleTime: 60_000,
  });
  const [fix, setFix] = useState<{ service: ProxyFix['service']; port: string }>({ service: 'www-ssl', port: '8443' });
  const [steps, setSteps] = useState<string[]>([]);
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setF((x) => ({ ...x, [k]: v }));

  const others = (view?.rules ?? []).filter((r) => r.id !== existing?.id);
  const errors = view ? ruleErrors(f, { certs: view.certificates, vrfs: view.vrfs, others }) : {};
  if (!f.certificate) errors.certificate = 'Choose a certificate.';
  // The clash only matters once the proxy has an enabled rule (this one counts).
  const needsFix = !!view && view.clash && (f.enabled || others.some((r) => !r.disabled));
  const fixErr = needsFix && view ? movePortError(view.services, fix.service, fix.port) : null;
  const valid = !!view && Object.keys(errors).length === 0 && !fixErr;

  const body = (certificate: string) => {
    const b: Record<string, unknown> = {
      sni: normalizeSni(f.sni), 'ip-address': f.ip.trim(), port: Number(f.port), comment: f.comment, disabled: !f.enabled,
      ...(certificate === LETS_ENCRYPT ? { acme: { staging } } : { certificate }),
      ...(f.vrf ? { vrf: f.vrf } : {}),
    };
    if (needsFix) b.fix = { service: fix.service, port: Number(fix.port) };
    return b;
  };
  const ruleRequest = (certificate: string) => (existing
    ? reverseProxyApi.updateRule(deviceId, existing.id, existing.sni, body(certificate))
    : reverseProxyApi.addRule(deviceId, body(certificate)));
  const save = useMutation({
    meta: { inlineError: true },
    mutationFn: async () => {
      let cert = f.certificate;
      if (cert === ISSUE_FROM_CA) {
        const r = await reverseProxyApi.issueCert(deviceId, normalizeSni(f.sni));
        setSteps(r.data.steps);
        cert = r.data.cert_name ?? 'none';
      }
      return ruleRequest(cert);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reverse-proxy'] });
      qc.invalidateQueries({ queryKey: ['reverse-proxy-device', deviceId] });
      onClose();
    },
  });
  // The rule write is previewable; issuing a certificate isn't, so the preview shows the rule with "none".
  const reviewRequest = () => ruleRequest(f.certificate === ISSUE_FROM_CA ? 'none' : f.certificate);

  const certs = view?.certificates ?? [];
  const fits = certs.filter((c) => !c.expired && (!f.sni || certCovers(f.sni, c.commonName, c.subjectAltName)));
  const rest = certs.filter((c) => !fits.includes(c));

  return (
    <Modal title={`${existing ? 'Edit' : 'Add'} reverse proxy rule${view ? ` on ${view.device.name}` : ''}`} onClose={onClose}>
      {isLoading && <p className="p-5 text-sm text-gray-400">Reading the device…</p>}
      {error && <p className="p-5 text-sm text-red-600">{apiErrorMessage(error)}</p>}
      {view && (
        <>
          <div className="p-5 space-y-4">
            <p className="text-xs text-gray-500 dark:text-slate-400">
              HTTPS for this host name is answered by the router and passed to the web server over plain HTTP.
              Point the name&apos;s DNS at the router.
            </p>
            <div>
              <label className={label}>Host name *</label>
              <input className="input w-full" value={f.sni} onChange={(e) => set('sni', e.target.value)} placeholder="nas.example.com" />
              {fieldError(errors.sni)}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className={label}>Web server address *</label>
                <input className="input w-full font-mono" value={f.ip} onChange={(e) => set('ip', e.target.value)} placeholder="192.168.88.10" />
                {fieldError(errors.ip)}
              </div>
              <div>
                <label className={label}>Port *</label>
                <input className="input w-full" value={f.port} onChange={(e) => set('port', e.target.value)} placeholder="80" />
                {fieldError(errors.port)}
              </div>
            </div>
            <div>
              <label className={label}>Certificate *</label>
              <select className="input w-full" value={f.certificate} onChange={(e) => set('certificate', e.target.value)}>
                <option value="">Choose…</option>
                {isAdmin && view.ca_ready && <option value={ISSUE_FROM_CA}>Issue one from the manager&apos;s CA (renewed automatically)</option>}
                <option value={LETS_ENCRYPT}>Let&apos;s Encrypt, for a public name (the router requests and renews it)</option>
                {fits.length > 0 && (
                  <optgroup label="On the device, for this name">
                    {fits.map((c) => <option key={c.name} value={c.name}>{c.name}{c.invalidAfter ? ` (until ${c.invalidAfter.slice(0, 10)})` : ''}</option>)}
                  </optgroup>
                )}
                {rest.length > 0 && (
                  <optgroup label="Other certificates on the device">
                    {rest.map((c) => <option key={c.name} value={c.name}>{c.name}{c.expired ? ' (expired)' : ''}</option>)}
                  </optgroup>
                )}
                <option value="none">The reverse-proxy service&apos;s certificate{view.service.certificate ? ` (${view.service.certificate})` : ' (none set)'}</option>
              </select>
              {fieldError(errors.certificate)}
              {f.certificate === ISSUE_FROM_CA && (
                <p className="mt-0.5 text-xs text-gray-500">Browsers trust it once the CA certificate is installed on them (Download CA certificate on the PKI tab).</p>
              )}
              {acmeOn && (
                <div className="mt-2 p-3 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 text-xs text-blue-900 dark:text-blue-200 space-y-1.5">
                  <p>The router asks Let&apos;s Encrypt for the certificate and renews it itself. For that to work:</p>
                  <ul className="list-disc ml-4 space-y-0.5">
                    <li>{normalizeSni(f.sni) || 'The name'} must point at this router&apos;s public address in public DNS.</li>
                    <li>TCP port 80 must reach the router from the internet (a firewall rule or port forward), at least while it&apos;s issued and renewed.</li>
                  </ul>
                  {dnsName && dnsHint && (
                    <p className={dnsHint.addresses.length ? '' : 'text-amber-700 dark:text-amber-300'}>
                      {dnsHint.addresses.length
                        ? <>From the manager, {dnsName} resolves to {dnsHint.addresses.join(', ')}. Check that&apos;s the router&apos;s public address.</>
                        : <>From the manager, {dnsName} doesn&apos;t resolve{dnsHint.error ? ` (${dnsHint.error})` : ''}, so Let&apos;s Encrypt probably can&apos;t find it either.</>}
                    </p>
                  )}
                  <label className="flex items-start gap-2 pt-1">
                    <input type="checkbox" className="mt-0.5" checked={staging} onChange={(e) => setStaging(e.target.checked)} />
                    <span><b>Test with the staging server first.</b> It has no rate limits, but browsers don&apos;t trust what it issues.
                      Once it works, edit the rule and untick this to get the real certificate.</span>
                  </label>
                </div>
              )}
              {f.certificate === 'none' && !view.service.certificate && (
                <p className="mt-0.5 text-xs text-amber-600">The service has no certificate either, so HTTPS for this name would fail.</p>
              )}
              {!view.ca_ready && isAdmin && <p className="mt-0.5 text-xs text-gray-500">Set up the manager&apos;s CA on the PKI tab to issue certificates from here.</p>}
            </div>
            {view.vrfs.length > 1 && (
              <div>
                <label className={label}>VRF</label>
                <select className="input w-full" value={f.vrf} onChange={(e) => set('vrf', e.target.value)}>
                  <option value="">Default</option>
                  {view.vrfs.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
                {fieldError(errors.vrf)}
              </div>
            )}
            <div>
              <label className={label}>Comment</label>
              <input className="input w-full" value={f.comment} onChange={(e) => set('comment', e.target.value)} />
              {fieldError(errors.comment)}
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} /> Enabled</label>
            {needsFix && <PortChoice view={view} value={fix} onChange={setFix} />}
            {view.service.disabled && <p className="text-xs text-amber-600">The reverse-proxy service is disabled on this device, so rules won&apos;t answer until it&apos;s enabled under IP Services.</p>}
            {steps.length > 0 && <ul className="text-xs text-gray-500 list-disc ml-4">{steps.map((s, i) => <li key={i}>{s}</li>)}</ul>}
          </div>
          <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
            <button onClick={() => save.mutate()} disabled={!valid || save.isPending}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
              <Check className="w-3.5 h-3.5" />{save.isPending ? (f.certificate === ISSUE_FROM_CA ? 'Issuing…' : 'Saving…') : 'Save'}
            </button>
            <ReviewChangesButton request={reviewRequest} onApply={() => save.mutate()} applyLabel="Save" deviceName={view.device.name} disabled={!valid || save.isPending} />
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            {save.isError && <span className="text-xs text-red-500">{apiErrorMessage(save.error)}</span>}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Fix a clash that's already there: rules exist and one of the two services can't listen. */
function MovePortModal({ deviceId, onClose }: { deviceId: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: view } = useQuery({ queryKey: ['reverse-proxy-device', deviceId], queryFn: () => reverseProxyApi.device(deviceId).then((r) => r.data) });
  const [fix, setFix] = useState<{ service: ProxyFix['service']; port: string }>({ service: 'www-ssl', port: '8443' });
  const err = view ? movePortError(view.services, fix.service, fix.port, view.rules.some((r) => !r.disabled)) : 'Reading the device…';
  const request = () => reverseProxyApi.movePort(deviceId, { service: fix.service, port: Number(fix.port) });
  const run = useMutation({
    meta: { inlineError: true },
    mutationFn: request,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['reverse-proxy'] }); qc.invalidateQueries({ queryKey: ['reverse-proxy-device', deviceId] }); onClose(); },
  });
  return (
    <Modal title="Move a port" onClose={onClose}>
      <div className="p-5">{view ? <PortChoice view={view} value={fix} onChange={setFix} proxyActive={view.rules.some((r) => !r.disabled)}
        intro={`WebFig HTTPS is on port ${view.service.wwwSslPort ?? '?'}${view.service.wwwSslDisabled ? ' (off)' : ''}, the reverse proxy on ${view.service.port ?? '?'}. Choose which to move:`} /> : <p className="text-sm text-gray-400">Reading the device…</p>}</div>
      <div className="px-5 pb-4 flex items-center gap-3 flex-wrap">
        <button onClick={() => run.mutate()} disabled={!!err || run.isPending}
          className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg disabled:opacity-50">
          <ArrowRightLeft className="w-3.5 h-3.5" />{run.isPending ? 'Moving…' : 'Move'}
        </button>
        <ReviewChangesButton request={request} onApply={() => run.mutate()} applyLabel="Move" deviceName={view?.device.name} disabled={!!err || run.isPending} />
        <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
        {run.isError && <span className="text-xs text-red-500">{apiErrorMessage(run.error)}</span>}
      </div>
    </Modal>
  );
}

function DeviceCard({ d, onNote }: { d: ProxyFleetDevice; onNote: (n: { ok: boolean; text: string }) => void }) {
  const qc = useQueryClient();
  const canWrite = useCanWrite();
  const isAdmin = useIsFleetAdmin();
  const guard = useGuardedWrite();
  const [form, setForm] = useState<ProxyRule | 'new' | null>(null);
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ['reverse-proxy'] }); qc.invalidateQueries({ queryKey: ['reverse-proxy-device', d.id] }); };
  const write = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (res) => {
      guard.onSuccess(res);
      const warning = (res as { data?: { warning?: string } } | undefined)?.data?.warning;
      setNote(warning ? { ok: false, text: warning } : null);
      done();
    },
    onError: (e) => setNote({ ok: false, text: apiErrorMessage(e) }),
  });
  const certJob = useMutation({
    mutationFn: (fn: () => Promise<{ data: { message: string } }>) => fn(),
    // Shown above the cards: removing the last certificate takes this card away.
    onSuccess: (r) => { setNote(null); onNote({ ok: true, text: r.data.message }); done(); },
    onError: (e) => setNote({ ok: false, text: apiErrorMessage(e) }),
  });
  const asRule = (r: ProxyFleetDevice['rules'][number]): ProxyRule => ({
    id: r.rule_id, sni: r.sni, ipAddress: r.ip_address, port: r.port, certificate: r.certificate, vrf: r.vrf, comment: r.comment, disabled: r.disabled, dynamic: r.dynamic,
  });
  const svc = d.service;
  // While RouterOS is requesting a Let's Encrypt certificate, read the device every few seconds
  // so its progress shows; the fleet list only refreshes with the slow poll.
  // A request just made isn't in the slow-poll data yet, so a Let's Encrypt rule without a settled status counts too.
  const pendingAcme = d.rules.some((r) => isAcmeName(r.certificate) && (!r.acme || r.acme.phase === 'pending'));
  const cached = qc.getQueryData<ProxyDeviceView>(['reverse-proxy-device', d.id]);
  const livePending = !!cached?.acme.some((a) => a.phase === 'pending');
  const { data: liveView } = useQuery({
    queryKey: ['reverse-proxy-device', d.id],
    queryFn: () => reverseProxyApi.device(d.id).then((x) => x.data),
    enabled: (pendingAcme || livePending) && d.status === 'online',
    refetchInterval: (q) => ((q.state.data as ProxyDeviceView | undefined)?.acme.some((a) => a.phase === 'pending') ? 5_000 : false),
  });
  const acmeFor = (r: ProxyFleetDevice['rules'][number]) => {
    const live = liveView?.acme.find((a) => a.name === r.certificate);
    return live ? { staging: live.staging, phase: live.phase, status: live.status } : r.acme;
  };
  const acmeAgain = (r: ProxyFleetDevice['rules'][number], staging: boolean) =>
    write.mutate(() => reverseProxyApi.updateRule(d.id, r.rule_id, r.sni, { acme: { staging } }));

  return (
    <div className="card overflow-hidden">
      {form && <RuleModal deviceId={d.id} existing={form === 'new' ? undefined : form} onClose={() => setForm(null)} />}
      {moving && <MovePortModal deviceId={d.id} onClose={() => setMoving(false)} />}
      <div className="flex items-center gap-2 px-5 py-3 border-b border-gray-200 dark:border-slate-700 flex-wrap">
        <DeviceTypePill type={d.device_type} />
        <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
        <span className="text-xs text-gray-400">{[d.model, d.ros_version].filter(Boolean).join(' · ')}</span>
        {svc && (
          <span className="text-xs text-gray-500">
            · proxy on port {svc.port ?? '?'}{svc.disabled ? ' (service disabled)' : ''}{!svc.www_ssl_disabled ? ` · WebFig HTTPS on ${svc.www_ssl_port}` : ''}
          </span>
        )}
        {canWrite && (
          <span className="ml-auto flex items-center gap-3">
            <button onClick={() => setMoving(true)} disabled={d.status !== 'online'} title="Move WebFig HTTPS or the reverse proxy to another port"
              className="text-xs text-gray-500 hover:text-gray-700 underline disabled:opacity-50">Ports</button>
            <button onClick={() => setForm('new')} disabled={d.status !== 'online'}
              className="flex items-center gap-1 px-2.5 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg disabled:opacity-50">
              <Plus className="w-3 h-3" />Add rule
            </button>
          </span>
        )}
      </div>
      <div className="p-5 space-y-3">
        <GuardedWriteUi state={guard} deviceId={d.id} deviceName={d.name} pending={write.isPending} />
        {note && <p className={clsx('text-sm', note.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400')}>{note.text}</p>}
        {d.clash && d.rules.some((r) => !r.disabled) && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            <span className="flex-1">WebFig HTTPS and the reverse proxy both use port {svc?.port}, so one of them isn&apos;t listening.</span>
            {canWrite && <button onClick={() => setMoving(true)} className="text-xs underline">Fix it</button>}
          </div>
        )}
        {d.rules.length === 0 ? (
          <p className="text-sm text-gray-400">No rules.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-slate-700">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-gray-200 dark:border-slate-700 bg-gray-50 dark:bg-slate-800/40 text-left text-xs font-semibold text-gray-500 dark:text-slate-400 uppercase tracking-wide">
                <th className="px-3 py-2">Host name</th><th className="px-3 py-2">Web server</th><th className="px-3 py-2">Certificate</th><th className="px-3 py-2">Expires</th>
                {canWrite && <th className="px-3 py-2 text-right">Actions</th>}
              </tr></thead>
              <tbody>
                {d.rules.map((r) => (
                  <tr key={r.rule_id} className={clsx('border-b border-gray-100 dark:border-slate-800', r.disabled && 'opacity-60')}>
                    <td className="px-3 py-2">
                      <span className="font-medium">{r.sni}</span>
                      {r.disabled && <span className="ml-1 text-xs text-gray-400">disabled</span>}
                      {r.dynamic && <span className="ml-1 text-xs text-gray-400" title="Created by RouterOS for a container app">app</span>}
                      {r.comment && <div className="text-xs text-gray-400">{r.comment}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono">{r.ip_address}:{r.port}{r.vrf ? ` (${r.vrf})` : ''}</td>
                    <td className="px-3 py-2 text-xs">
                      {(() => {
                        const a = acmeFor(r);
                        if (!a) return (
                          <>
                            {r.effective_certificate ?? <span className="text-red-600">none: HTTPS fails</span>}
                            {!r.certificate && r.effective_certificate && <span className="text-gray-400"> (service)</span>}
                            {r.managed && <span className="ml-1 inline-flex items-center gap-0.5 text-green-700 dark:text-green-400"><ShieldCheck className="w-3 h-3" />CA, renews</span>}
                          </>
                        );
                        return (
                          <div className="space-y-0.5">
                            <div>
                              Let&apos;s Encrypt{a.staging && <span className="text-amber-600"> (staging, not trusted by browsers)</span>}
                              {a.phase === 'issued' && <span className="ml-1 inline-flex items-center gap-0.5 text-green-700 dark:text-green-400"><ShieldCheck className="w-3 h-3" />renews itself</span>}
                              {a.phase === 'pending' && <span className="ml-1 text-blue-600 dark:text-blue-400"><RefreshCw className="w-3 h-3 inline animate-spin" /> {a.status || 'requesting'}…</span>}
                            </div>
                            {a.phase === 'failed' && <div className="text-red-600 dark:text-red-400 break-words max-w-md">{a.status}</div>}
                            {canWrite && !r.dynamic && (
                              <div className="flex gap-3">
                                {a.phase === 'failed' && <button className="underline text-blue-600" disabled={write.isPending} onClick={() => acmeAgain(r, a.staging)}>Try again</button>}
                                {a.phase === 'issued' && a.staging && (
                                  <button className="underline text-blue-600" disabled={write.isPending}
                                    onClick={() => { if (confirm(`Staging works for ${r.sni}. Request the real certificate from Let's Encrypt now?`)) acmeAgain(r, false); }}>
                                    Get the real certificate
                                  </button>
                                )}
                                {a.phase === 'issued' && r.certificate && (
                                  <button className="underline text-gray-500" disabled={certJob.isPending}
                                    onClick={() => certJob.mutate(() => reverseProxyApi.renewAcme(d.id, r.certificate!))}>Renew now</button>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td className={clsx('px-3 py-2 text-xs', soon(r.certificate_expires) ? 'text-amber-600' : 'text-gray-500')}>{day(r.certificate_expires)}</td>
                    {canWrite && (
                      <td className="px-3 py-2">
                        {r.dynamic ? (
                          <span className="flex justify-end text-gray-300" title="A container app's rule: change it in the app"><Lock className="w-3.5 h-3.5" /></span>
                        ) : (
                          <div className="flex justify-end gap-1">
                            <button title={r.disabled ? 'Enable' : 'Disable'} onClick={() => (r.disabled && d.clash ? setForm(asRule(r))
                              : write.mutate(() => reverseProxyApi.updateRule(d.id, r.rule_id, r.sni, { disabled: !r.disabled })))}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600"><Power className="w-3.5 h-3.5" /></button>
                            <button title="Edit" onClick={() => setForm(asRule(r))} className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600"><Pencil className="w-3.5 h-3.5" /></button>
                            <button title="Delete" onClick={() => { if (confirm(`Delete the reverse proxy rule for ${r.sni}?`)) write.mutate(() => reverseProxyApi.removeRule(d.id, r.rule_id, r.sni)); }}
                              className="p-1.5 rounded-lg text-gray-400 hover:text-red-600"><Trash2 className="w-3.5 h-3.5" /></button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.managed_certs.length > 0 && (
          <div className="text-xs space-y-1">
            <div className="font-semibold text-gray-500 uppercase tracking-wide">Certificates from the manager&apos;s CA</div>
            {d.managed_certs.map((m) => (
              <div key={m.sni} className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{m.sni}</span>
                <span className="text-gray-400 font-mono">{m.cert_name}</span>
                <span className={clsx(soon(m.not_after) ? 'text-amber-600' : 'text-gray-500')}>until {day(m.not_after)}</span>
                {m.last_error && <span className="text-red-600" title={m.last_error}>renewal failed</span>}
                {isAdmin && (
                  <span className="ml-auto flex gap-3">
                    <button className="underline text-blue-600 disabled:opacity-50" disabled={certJob.isPending} onClick={() => certJob.mutate(() => reverseProxyApi.issueCert(d.id, m.sni))}>
                      {certJob.isPending ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : 'Renew now'}
                    </button>
                    <button className="underline text-red-600" disabled={certJob.isPending}
                      onClick={() => { if (confirm(`Remove the certificate for ${m.sni} from ${d.name}? A rule still using it has to move first.`)) certJob.mutate(() => reverseProxyApi.removeCert(d.id, m.sni)); }}>Remove</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const SUPPORT_TEXT: Record<string, string> = { 'too-old': 'needs RouterOS 7.22 or later', unsupported: 'SMIPS: no reverse proxy', unknown: 'not polled yet' };

/**
 * Reverse proxy rules across the fleet (#358), from the slow poll. Each rule
 * answers HTTPS for one host name on a router and passes it to a web server
 * behind it, with a certificate from the device or the manager's CA.
 */
export default function ReverseProxyTab() {
  const canWrite = useCanWrite();
  const [adding, setAdding] = useState<number | null>(null);
  const [ports, setPorts] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['reverse-proxy'],
    queryFn: () => reverseProxyApi.fleet().then((r) => r.data),
    refetchInterval: 60_000,
  });
  const devices = data?.devices ?? [];
  const withRules = devices.filter((d) => d.rules.length > 0 || d.managed_certs.length > 0);
  const can = devices.filter((d) => d.support === 'supported' && !withRules.includes(d));
  const cannot = devices.filter((d) => d.support !== 'supported' && !withRules.includes(d));

  return (
    <div className="space-y-4">
      {adding !== null && <RuleModal deviceId={adding} onClose={() => setAdding(null)} />}
      {ports !== null && <MovePortModal deviceId={ports} onClose={() => setPorts(null)} />}
      {notice && (
        <div className={clsx('p-3 rounded-lg border text-sm flex items-start gap-2', notice.ok
          ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
          : 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300')}>
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="text-xs underline">Dismiss</button>
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-gray-500 dark:text-slate-400">
          A router answers HTTPS for a host name and passes it to a web server behind it, so several servers can share one address
          on port 443 without a NAT rule each. Needs RouterOS 7.22 or later. Refreshed with each slow poll.
        </p>
        <button onClick={() => void refetch()} disabled={isFetching} className="btn-secondary flex items-center gap-2 text-sm flex-shrink-0">
          <RefreshCw className={clsx('w-3.5 h-3.5', isFetching && 'animate-spin')} /> Refresh
        </button>
      </div>
      {isLoading && <div className="text-center py-8 text-gray-400">Loading…</div>}
      {error && <div className="card p-5 text-sm text-red-500">{apiErrorMessage(error)}</div>}
      {!isLoading && withRules.length === 0 && <div className="card p-5 text-sm text-gray-500">No device in this site has reverse proxy rules yet.</div>}
      {withRules.map((d) => <DeviceCard key={d.id} d={d} onNote={setNotice} />)}
      {can.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-200 dark:border-slate-700 text-sm font-semibold text-gray-700 dark:text-slate-200">Can use the reverse proxy ({can.length})</div>
          <div className="divide-y divide-gray-100 dark:divide-slate-700/60">
            {can.map((d) => (
              <div key={d.id} className="flex items-center gap-2 px-5 py-2">
                <DeviceTypePill type={d.device_type} />
                <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
                <span className="text-xs text-gray-400">{[d.model, d.ros_version].filter(Boolean).join(' · ')}</span>
                {d.service && (d.service.port !== 443 || (!d.service.www_ssl_disabled && d.service.www_ssl_port !== 443)) && (
                  <span className="text-xs text-gray-500">proxy on {d.service.port}{!d.service.www_ssl_disabled ? `, WebFig HTTPS on ${d.service.www_ssl_port}` : ''}</span>
                )}
                {canWrite && (
                  <span className="ml-auto flex items-center gap-3">
                    <button onClick={() => setPorts(d.id)} disabled={d.status !== 'online'} title="Move WebFig HTTPS or the reverse proxy to another port"
                      className="text-xs text-gray-500 hover:text-gray-700 underline disabled:opacity-50">Ports</button>
                    <button onClick={() => setAdding(d.id)} disabled={d.status !== 'online'} className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
                      <Plus className="w-3.5 h-3.5" /> Add rule
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {cannot.length > 0 && (
        <div className="card overflow-hidden">
          <button onClick={() => setShowOthers((v) => !v)} className="w-full text-left px-5 py-3 text-sm font-semibold text-gray-700 dark:text-slate-200">
            Can&apos;t use it ({cannot.length}) <span className="text-xs font-normal text-gray-400">{showOthers ? 'hide' : 'show'}</span>
          </button>
          {showOthers && (
            <div className="divide-y divide-gray-100 dark:divide-slate-700/60 border-t border-gray-200 dark:border-slate-700">
              {cannot.map((d) => (
                <div key={d.id} className="flex items-center gap-2 px-5 py-2">
                  <Link to={`/devices/${d.id}`} className="cell-primary hover:underline">{d.name}</Link>
                  <span className="text-xs text-gray-400">{d.ros_version}</span>
                  <span className="ml-auto text-xs text-gray-500">{SUPPORT_TEXT[d.support] ?? d.support}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
