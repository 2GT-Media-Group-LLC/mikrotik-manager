/**
 * Dark Site Mode: every feature that reaches the internet, each switchable.
 *
 * Collected in one place after a user running an isolated network found them
 * one at a time. #106 added a switch for maps; #159 found the dashboard still
 * drew one; the next reply found the update check calling GitHub. Auditing
 * the code for every request the platform starts by itself turned up two more
 * nobody had reported.
 *
 * Everything defaults to on. A new install behaves exactly as before; an
 * operator who needs a site to stay dark turns off what they need to.
 *
 * Deliberately *not* here: alert channels (Telegram, ntfy, Slack, webhooks).
 * Those only send because someone configured a destination, so leaving them
 * unconfigured is already the off switch.
 */

export interface DarkSiteFeature {
  key: string;
  /** Short name for the UI. */
  label: string;
  /** Where the request goes. Stated plainly so an operator can match it against a firewall log. */
  destination: string;
  /** What stops working when it is off. */
  cost: string;
}

export const DARK_SITE_FEATURES: DarkSiteFeature[] = [
  {
    key: 'maps_enabled',
    label: 'Maps and address lookup',
    destination: '*.tile.openstreetmap.org, nominatim.openstreetmap.org',
    cost: 'No location maps; addresses are still stored as text. The address you type is sent to Nominatim when this is on.',
  },
  {
    key: 'update_check_enabled',
    label: 'Platform update check',
    destination: 'raw.githubusercontent.com',
    cost: 'The dashboard no longer says when a newer MikroTik Manager release exists.',
  },
  {
    key: 'device_update_check_enabled',
    label: 'Daily RouterOS update check',
    destination: "MikroTik's update servers, requested by each device rather than by the manager",
    cost: 'Devices are no longer asked each day whether RouterOS updates exist. The Check for updates button still works on demand.',
  },
  {
    key: 'firmware_changelog_enabled',
    label: 'RouterOS changelogs',
    destination: 'download.mikrotik.com',
    cost: 'Release notes are not shown in the firmware page.',
  },
  {
    key: 'oui_download_enabled',
    label: 'MAC vendor database download',
    destination: 'standards-oui.ieee.org',
    cost: 'The vendor list is not refreshed. A copy already downloaded is still used; without one, client vendors show as unknown.',
  },
  {
    key: 'docs_link_enabled',
    label: 'Documentation link',
    destination: '2gt-media-group-llc.github.io',
    cost: 'The documentation button in the top bar is hidden.',
  },
];

export const DARK_SITE_KEYS = DARK_SITE_FEATURES.map((f) => f.key);

/**
 * Whether one feature may reach the internet.
 *
 * Only an explicit `false` turns it off. A missing or unreadable setting means
 * on, which matches the default and keeps an install that predates a key
 * behaving as it did.
 */
export function internetAllowed(settings: Record<string, unknown>, key: string): boolean {
  return settings[key] !== false;
}
