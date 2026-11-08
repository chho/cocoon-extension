import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import {
  PLATFORM_BLOCK_PREFERENCE_KEY,
  parsePlatformBlockPreference,
} from "./platform-block-preference.ts";

test("VOTER-015 preference grants permission only for the exact versioned boolean shape", () => {
  strictEqual(PLATFORM_BLOCK_PREFERENCE_KEY, "cocoonPlatformBlockPreference");
  strictEqual(parsePlatformBlockPreference({ version: 1, blockVotersOnPlatform: true }), true);
  for (const value of [
    undefined,
    null,
    true,
    [],
    {},
    { version: 1, blockVotersOnPlatform: false },
    { version: 2, blockVotersOnPlatform: true },
    { version: 1, blockVotersOnPlatform: "true" },
    { blockVotersOnPlatform: true },
    { version: 1, blockVotersOnPlatform: true, extra: false },
    Object.create({ version: 1, blockVotersOnPlatform: true }),
  ]) {
    strictEqual(parsePlatformBlockPreference(value), false);
  }
});
