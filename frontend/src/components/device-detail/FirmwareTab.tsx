import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, CheckCircle, AlertCircle, Download, Cpu, ArrowUpCircle, FileText } from 'lucide-react';
import { devicesApi } from '../../services/api';
import type { Device } from '../../types';
import clsx from 'clsx';
import { useCanWrite } from '../../hooks/useCanWrite';
import ChangelogModal from '../ChangelogModal';

interface Props {
  deviceId: number;
  device: Device;
}

export default function FirmwareTab({ deviceId, device }: Props) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [changelogVersion, setChangelogVersion] = useState<string | null>(null);

  // ─── RouterOS update check / install ─────────────────────────────────────
  const [updateInfo, setUpdateInfo] = useState<Record<string, string> | null>(null);
  const [updateChecking, setUpdateChecking] = useState(false);
  const [updateError, setUpdateError] = useState('');
  const [installSuccess, setInstallSuccess] = useState('');

  // Pre-populate from stored DB state so the section is useful without a manual check
  useEffect(() => {
    if (device.ros_version || device.latest_ros_version || device.firmware_update_available) {
      // Pre-populated from the database, not from the device. The status is
      // derived from the stored flag, so presenting this identically to a fresh
      // check invites exactly the confusion it caused: a synthesised "New
      // version is available" with no way to tell it was last week's answer
      // (#144). The channel is the one the device reported at its last check
      // (#162); it was left blank here until #413.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUpdateInfo({
        'installed-version': device.ros_version || '',
        'latest-version': device.latest_ros_version || '',
        'status': device.firmware_update_available ? 'New version is available' : 'System is up to date',
        'channel': device.reported_update_channel || '',
        'from-stored-state': 'yes',
      });
    }
  }, [device.id]);

  // Firmware state is rendered on many screens (Devices list, Firmware page,
  // dashboard "Things to handle", Security Center). The backend persists the
  // new state immediately, so refresh those caches whenever it changes here —
  // otherwise other pages keep stale "update available" data until their own
  // 30s refetch fires.
  const invalidateFirmwareState = () => {
    queryClient.invalidateQueries({ queryKey: ['devices'] });
    queryClient.invalidateQueries({ queryKey: ['device', deviceId] });
    queryClient.invalidateQueries({ queryKey: ['fw-overview'] });
    queryClient.invalidateQueries({ queryKey: ['ops-insights'] });
    queryClient.invalidateQueries({ queryKey: ['security-fleet'] });
  };

  const checkUpdateMutation = useMutation({
    mutationFn: () => devicesApi.checkUpdate(deviceId),
    onMutate: () => { setUpdateChecking(true); setUpdateError(''); setInstallSuccess(''); },
    onSuccess: (res) => { setUpdateInfo(res.data); setUpdateChecking(false); invalidateFirmwareState(); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUpdateError(msg || 'Failed to check for updates');
      setUpdateChecking(false);
    },
  });

  const installUpdateMutation = useMutation({
    mutationFn: () => devicesApi.installUpdate(deviceId),
    // The server now distinguishes "installing" from "there was nothing to
    // install", because this button used to report the first while doing the
    // second. Report back whichever actually happened.
    onSuccess: (res) => {
      setInstallSuccess(res.data.message);
      if (res.data.started) {
        setUpdateInfo(null);
      } else {
        setUpdateInfo({
          'installed-version': res.data.installed_version || '',
          'latest-version': res.data.installed_version || '',
          'status': 'System is up to date',
          'channel': '',
        });
      }
      invalidateFirmwareState();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setUpdateError(msg || 'Failed to install update');
    },
  });

  // RouterOS 7 uses 'installed-version'; RouterOS 6 uses 'version'
  const installedVersion = updateInfo?.['installed-version'] || updateInfo?.['version'] || '';
  const latestVersion    = updateInfo?.['latest-version'] || '';
  const statusSaysUpdate = updateInfo?.['status']?.toLowerCase().includes('new version') ||
                           updateInfo?.['status']?.toLowerCase().includes('available');
  const hasUpdate = updateInfo && latestVersion && (
    (installedVersion && latestVersion !== installedVersion) ||
    (!installedVersion && statusSaysUpdate)
  );

  // ─── RouterBOOT upgrade check / install ──────────────────────────────────
  const [rbInfo, setRbInfo] = useState<{ currentFirmware: string; upgradeFirmware: string; upgradeAvailable: boolean } | null>(null);
  const [rbChecking, setRbChecking] = useState(false);
  const [rbError, setRbError] = useState('');
  const [rbInstallSuccess, setRbInstallSuccess] = useState('');

  // Pre-populate from stored DB state
  useEffect(() => {
    if (device.firmware_version) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRbInfo({
        currentFirmware: device.firmware_version,
        upgradeFirmware: device.upgrade_firmware_version || '',
        upgradeAvailable: device.routerboard_upgrade_available || false,
      });
    }
  }, [device.id]);

  const checkRouterboardMutation = useMutation({
    mutationFn: () => devicesApi.checkRouterboard(deviceId),
    onMutate: () => { setRbChecking(true); setRbError(''); setRbInstallSuccess(''); },
    onSuccess: (res) => { setRbInfo(res.data); setRbChecking(false); invalidateFirmwareState(); },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setRbError(msg || 'Failed to check RouterBOOT');
      setRbChecking(false);
    },
  });

  const installRouterboardMutation = useMutation({
    mutationFn: () => devicesApi.installRouterboard(deviceId),
    onSuccess: (res) => {
      setRbInstallSuccess(res.data.message);
      if (res.data.started) setRbInfo(null);
      invalidateFirmwareState();
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
      setRbError(msg || 'Failed to install RouterBOOT upgrade');
    },
  });

  return (
    <div className="space-y-6">
      {changelogVersion && (
        <ChangelogModal version={changelogVersion} onClose={() => setChangelogVersion(null)} />
      )}
      {/* ── Software & Firmware Updates ── */}
      <div className="card p-5">
        <h3 className="font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-5">
          <Download className="w-4 h-4 text-blue-500" />
          Software &amp; Firmware Updates
          <Link to="/firmware" className="ml-auto text-xs font-normal text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
            title="Upgrade several devices in staged waves, with backups and verification">
            <ArrowUpCircle className="w-3.5 h-3.5" /> Update several devices
          </Link>
        </h3>

        {/* Order-of-operations notice when both are pending */}
        {hasUpdate && rbInfo?.upgradeAvailable && (
          <div className="flex items-start gap-2 p-3 mb-5 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg text-sm text-blue-700 dark:text-blue-300">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <p>
              <span className="font-medium">Update order matters:</span> Install the RouterOS update first and let the device reboot, then apply the RouterBOOT upgrade. The new bootloader is bundled inside the RouterOS package.
            </p>
          </div>
        )}

        {/* ── RouterOS ── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-slate-300 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5 text-gray-400" />
              RouterOS
            </h4>
            {canWrite && (
            <button
              onClick={() => checkUpdateMutation.mutate()}
              disabled={updateChecking}
              className="btn-secondary flex items-center gap-2 text-xs py-1"
            >
              <RefreshCw className={clsx('w-3 h-3', updateChecking && 'animate-spin')} />
              {updateChecking ? 'Checking...' : 'Check for Updates'}
            </button>
            )}
          </div>

          {updateError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {updateError}
            </div>
          )}
          {installSuccess && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle className="w-4 h-4" /> {installSuccess}
            </div>
          )}

          {updateInfo ? (
            <div className="space-y-3">
              {updateInfo['from-stored-state'] && (
                <p className="text-xs text-gray-400 dark:text-slate-500">
                  From the last stored check — press Check for Updates to ask the device now.
                </p>
              )}
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                {[
                  ['Status', updateInfo['status'] || '—'],
                  ['Installed Version', installedVersion || '—'],
                  ['Latest Version', latestVersion || '—'],
                  ['Channel', updateInfo['channel']
                    || (updateInfo['from-stored-state'] ? 'not checked yet' : '—')],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between border-b border-gray-100 dark:border-slate-700 pb-2">
                    <span className="text-gray-500 dark:text-slate-400">{k}</span>
                    <span className={clsx(
                      'font-medium text-right',
                      k === 'Status' && hasUpdate ? 'text-orange-500' : 'text-gray-900 dark:text-white'
                    )}>
                      {v}
                    </span>
                  </div>
                ))}
              </div>

              {hasUpdate ? (
                <div className="flex items-center gap-3 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0" />
                  <div className="flex-1 text-sm">
                    <p className="font-medium text-orange-700 dark:text-orange-400">Update available: {latestVersion}</p>
                    <p className="text-orange-600 dark:text-orange-500 text-xs mt-0.5">The device will reboot after installing.</p>
                    <button
                      onClick={() => setChangelogVersion(latestVersion)}
                      className="mt-1.5 text-xs text-blue-600 dark:text-blue-400 hover:underline flex items-center gap-1"
                    >
                      <FileText className="w-3 h-3" /> What&apos;s new in {latestVersion}
                    </button>
                  </div>
                  {canWrite && (
                    <button
                      onClick={() => {
                        if (confirm(`Install RouterOS ${latestVersion} and reboot the device?`)) {
                          installUpdateMutation.mutate();
                        }
                      }}
                      disabled={installUpdateMutation.isPending}
                      className="btn-primary flex items-center gap-2 text-sm flex-shrink-0"
                    >
                      {installUpdateMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                      Install &amp; Reboot
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                  <CheckCircle className="w-4 h-4" /> RouterOS is up to date
                </div>
              )}
            </div>
          ) : !updateChecking && !installSuccess && (
            <p className="text-sm text-gray-400 dark:text-slate-500">
              Click &quot;Check for Updates&quot; to query the MikroTik update server.
            </p>
          )}
        </div>

        <div className="border-t border-gray-200 dark:border-slate-700 my-5" />

        {/* ── RouterBOOT ── */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-slate-300 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-gray-400" />
              RouterBOOT Firmware
            </h4>
            {canWrite && (
            <button
              onClick={() => checkRouterboardMutation.mutate()}
              disabled={rbChecking}
              className="btn-secondary flex items-center gap-2 text-xs py-1"
            >
              <RefreshCw className={clsx('w-3 h-3', rbChecking && 'animate-spin')} />
              {rbChecking ? 'Checking...' : 'Check RouterBOOT'}
            </button>
            )}
          </div>

          {rbError && (
            <div className="flex items-center gap-2 text-sm text-red-500">
              <AlertCircle className="w-4 h-4" /> {rbError}
            </div>
          )}
          {rbInstallSuccess && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle className="w-4 h-4" /> {rbInstallSuccess}
            </div>
          )}

          {rbInfo ? (
            rbInfo.currentFirmware ? (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm">
                  {[
                    ['Current Bootloader', rbInfo.currentFirmware || '—'],
                    ['Available Upgrade', rbInfo.upgradeFirmware || '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-gray-100 dark:border-slate-700 pb-2">
                      <span className="text-gray-500 dark:text-slate-400">{k}</span>
                      <span className="font-medium text-right text-gray-900 dark:text-white">{v}</span>
                    </div>
                  ))}
                </div>

                {rbInfo.upgradeAvailable ? (
                  <div className="flex items-center gap-3 p-3 bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg">
                    <AlertCircle className="w-4 h-4 text-orange-500 flex-shrink-0" />
                    <div className="flex-1 text-sm">
                      <p className="font-medium text-orange-700 dark:text-orange-400">Upgrade available: {rbInfo.upgradeFirmware}</p>
                      <p className="text-orange-600 dark:text-orange-500 text-xs mt-0.5">
                        {hasUpdate ? 'Install RouterOS first, then apply this upgrade.' : 'The device will reboot after upgrading.'}
                      </p>
                    </div>
                    {canWrite && (
                      <button
                        onClick={() => {
                          if (confirm(`Upgrade RouterBOOT to ${rbInfo.upgradeFirmware} and reboot the device?`)) {
                            installRouterboardMutation.mutate();
                          }
                        }}
                        disabled={installRouterboardMutation.isPending || Boolean(hasUpdate)}
                        title={hasUpdate ? 'Install the RouterOS update first' : undefined}
                        className="btn-primary flex items-center gap-2 text-sm flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {installRouterboardMutation.isPending ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Cpu className="w-4 h-4" />}
                        Upgrade &amp; Reboot
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                    <CheckCircle className="w-4 h-4" /> RouterBOOT is up to date
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-gray-400 dark:text-slate-500">
                RouterBOOT is not available on this device (CHR or virtual instance).
              </p>
            )
          ) : !rbChecking && !rbInstallSuccess && (
            <p className="text-sm text-gray-400 dark:text-slate-500">
              Click &quot;Check RouterBOOT&quot; to read the bootloader firmware status from the device.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
