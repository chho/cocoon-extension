import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

test("ARCH-002 importing the Zhihu runtime has no browser or network side effects", async () => {
  const guardedGlobals = [
    "window",
    "document",
    "chrome",
    "navigator",
    "MutationObserver",
    "fetch",
  ] as const;
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  try {
    for (const key of guardedGlobals) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, {
        configurable: true,
        get() {
          throw new Error(`Zhihu runtime accessed ${key} while importing`);
        },
      });
    }

    const runtime = await import("./runtime.ts");
    strictEqual(typeof runtime.mountZhihuPlugin, "function");
  } finally {
    for (const key of guardedGlobals) {
      const descriptor = descriptors.get(key);
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
  }
});
