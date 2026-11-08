export const PLATFORM_BLOCK_PREFERENCE_KEY = "cocoonPlatformBlockPreference";

export function parsePlatformBlockPreference(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 2 &&
    keys.includes("version") &&
    keys.includes("blockVotersOnPlatform") &&
    "version" in value &&
    value.version === 1 &&
    "blockVotersOnPlatform" in value &&
    value.blockVotersOnPlatform === true
  );
}
