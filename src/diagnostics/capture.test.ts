import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installDevDiagnostics } from "./content.ts";
import type { DiagnosticRequest } from "./contract.ts";

test("Dev automatic capture saves before/after with one incident ID; clear cancels pending recapture", async () => {
  const dom = new JSDOM(
    '<body><div class="cocoon-comment-blacklisted"><a href="/people/synthetic-author">Synthetic</a></div></body>',
    { url: "https://www.zhihu.com/" },
  );
  try {
    let now = 1_000,
      nextId = 0;
    const requests: DiagnosticRequest[] = [];
    const timers = new Map<() => void, number>();
    const handle = installDevDiagnostics(dom.window.document, {
      now: () => now,
      nextId: () => `test-${++nextId}`,
      send: async (request) => {
        requests.push(request);
        return { ok: true };
      },
      schedule: (callback, delay) => {
        timers.set(callback, delay);
        return () => {
          timers.delete(callback);
        };
      },
    })!;
    const run = (delay: number) => {
      for (const [callback, ms] of [...timers])
        if (ms === delay) {
          timers.delete(callback);
          callback();
        }
    };
    const root = dom.window.document.createElement("div");
    root.className = "HoverCard-item";
    root.innerHTML = '<a class="UserLink-link" href="/people/synthetic-author">Synthetic</a>';
    root.getClientRects = () => [{}] as unknown as DOMRectList;
    dom.window.document.body.append(root);
    await Promise.resolve();
    run(200);
    now += 5_000;
    root
      .querySelector("a")!
      .dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
    run(5_000);
    const saves = requests.filter((r) => r.operation === "save");
    strictEqual(saves.length, 2);
    strictEqual(saves[0]!.incident.id, saves[1]!.incident.id);
    strictEqual(
      saves[1]!.incident.events.some((e) => e.kind === "pointer"),
      true,
    );
    root.remove();
    await Promise.resolve();
    run(200);
    const second = root.cloneNode(true) as HTMLElement;
    second.getClientRects = () => [{}] as unknown as DOMRectList;
    dom.window.document.body.append(second);
    await Promise.resolve();
    run(200);
    strictEqual(timers.size > 0, true);
    strictEqual(await handle.clear(), true);
    const count = requests.length;
    run(5_000);
    strictEqual(requests.length, count);
    dom.window.dispatchEvent(new dom.window.PageTransitionEvent("pagehide"));
  } finally {
    dom.window.close();
  }
});
