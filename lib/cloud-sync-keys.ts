/**
 * localStorage keys that are mirrored to the user's account (so saved
 * strategies follow them to every device). Shared by the client and the API.
 */
export const CLOUD_SYNCED_KEYS = [
  'centurium:robot-presets',
  'centurium:robot-settings',
  'centurium:robot-settings-profiles',
  'centurium:robot-settings-active-profile',
  'centurium:evenodd-settings-profiles',
  'centurium:evenodd-settings-active-profile',
] as const;

export type CloudSyncedKey = (typeof CLOUD_SYNCED_KEYS)[number];

export function isCloudSyncedKey(key: string): key is CloudSyncedKey {
  return (CLOUD_SYNCED_KEYS as readonly string[]).includes(key);
}

/** Stored per key in the cloud. `value` is the raw localStorage string; null = deleted. */
export interface CloudEntry {
  value: string | null;
  updatedAt: number;
}

export const CLOUD_SYNC_EVENT = 'centurium:cloud-synced';
