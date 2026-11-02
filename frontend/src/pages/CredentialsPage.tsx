import CredentialPresetsSettings from '../components/settings/CredentialPresetsSettings';
import JumpHostsSettings from '../components/settings/JumpHostsSettings';

/**
 * How the manager reaches devices, under Operations: credential presets
 * (#228) and SSH jump hosts. Site admins manage their sites' own.
 */
export default function CredentialsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">Device Credentials</h1>
      <CredentialPresetsSettings />
      <JumpHostsSettings />
    </div>
  );
}
