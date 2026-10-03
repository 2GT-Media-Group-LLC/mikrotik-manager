import CredentialPresetsSettings from '../components/settings/CredentialPresetsSettings';

/** Device credential presets, under Operations (#228); site admins manage their sites' own. */
export default function CredentialsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold text-gray-900 dark:text-white">Device Credentials</h1>
      <CredentialPresetsSettings />
    </div>
  );
}
