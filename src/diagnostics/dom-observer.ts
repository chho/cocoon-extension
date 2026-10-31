import type { DiagnosticInput } from "./recorder.ts";

const HOVER = ".HoverCard-item";
const HIDDEN = ".cocoon-blacklisted,.cocoon-comment-blacklisted";
const MAX_HOVERS = 8;
const MAX_LINKS = 5_000;

interface DomDependencies {
  record(event: DiagnosticInput): void;
  candidate(): void;
  nodeId(node: Element): number;
  schedule(callback: () => void): () => void;
}

export function profileIdentity(
  element: Element | null,
): { userId: string; profileUrl: string } | null {
  const href = element?.closest("a[href]")?.getAttribute("href");
  if (!href) return null;
  try {
    const url = new URL(href, "https://www.zhihu.com/");
    if (url.origin !== "https://www.zhihu.com" || url.username || url.password) return null;
    const id = /^\/people\/([A-Za-z0-9_-]{1,256})(?:\/(?:answers|posts|followers))?\/?$/.exec(
      url.pathname,
    )?.[1];
    return id ? { userId: id, profileUrl: `https://www.zhihu.com/people/${id}` } : null;
  } catch {
    return null;
  }
}

export function geometry(element: Element): Pick<DiagnosticInput, "x" | "y" | "width" | "height"> {
  const bounds = element.getBoundingClientRect();
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function hoverShell(root: Element): Element {
  let shell = root;
  let parent: Element | null = root;
  for (let depth = 0; parent && parent !== root.ownerDocument.body && depth < 5; depth++) {
    if (
      ["absolute", "fixed"].includes(
        root.ownerDocument.defaultView!.getComputedStyle(parent).position,
      )
    )
      shell = parent;
    parent = parent.parentElement;
  }
  return shell;
}

function matchingAnchors(root: Element, identities: ReadonlySet<string>) {
  const links = root.ownerDocument.links;
  let hidden = 0,
    visible = 0;
  for (let i = 0; i < Math.min(links.length, MAX_LINKS); i++) {
    const link = links[i]!;
    if (root.contains(link) || !identities.has(profileIdentity(link)?.userId ?? "")) continue;
    if (link.closest(HIDDEN) && link.getClientRects().length === 0) hidden++;
    else if (link.getClientRects().length > 0) visible++;
  }
  return { hidden, visible, dropped: Math.max(0, links.length - MAX_LINKS) };
}

function hoverState(root: Element, node: number) {
  const anchors = [
    ...root.querySelectorAll("a.UserLink-link[href],a.NumberBoard-item[href]"),
  ].slice(0, 8);
  const identities = new Set(
    anchors.map((link) => profileIdentity(link)?.userId).filter((id): id is string => !!id),
  );
  const shell = hoverShell(root);
  const style = root.ownerDocument.defaultView!.getComputedStyle(shell);
  const visible =
    shell.getClientRects().length > 0 &&
    style.visibility !== "hidden" &&
    style.display !== "none" &&
    style.opacity !== "0";
  const matches = matchingAnchors(root, identities);
  const event: DiagnosticInput = {
    kind: "hover-state",
    node,
    ...geometry(shell),
    hidden: matches.hidden,
    count: matches.visible,
    dropped: matches.dropped,
    ...(profileIdentity(anchors[0] ?? null) ?? {}),
  };
  return {
    event,
    suspect: visible && !shell.closest(HIDDEN) && matches.hidden > 0 && matches.visible === 0,
    identity: [...identities].join("|"),
  };
}

class DiagnosticDomObserver {
  private readonly roots = new Map<Element, string>();
  private readonly candidates = new WeakMap<Element, string>();
  private readonly treeObserver: MutationObserver;
  private readonly rootObserver: MutationObserver;
  private scheduled: (() => void) | null = null;
  private active = true;
  private overflow = 0;
  private readonly document: Document;
  private readonly dependencies: DomDependencies;

  constructor(document: Document, dependencies: DomDependencies) {
    this.document = document;
    this.dependencies = dependencies;
    const Observer = document.defaultView!.MutationObserver;
    this.treeObserver = new Observer((records) => {
      if (records.some((record) => this.relevantMutation(record))) this.schedule();
    });
    this.rootObserver = new Observer(() => this.schedule());
  }

  start(): void {
    this.treeObserver.observe(this.document.body, { childList: true, subtree: true });
    for (const type of ["mouseover", "mouseout", "click"])
      this.document.addEventListener(type, this.pointer, { capture: true, passive: true });
    this.check();
  }

  private relevantMutation(record: MutationRecord): boolean {
    if ([...this.roots.keys()].some((root) => !root.isConnected || root.contains(record.target)))
      return true;
    return [...record.addedNodes].some(
      (node) =>
        node instanceof this.document.defaultView!.Element &&
        (node.matches(HOVER) || !!node.querySelector(HOVER)),
    );
  }

  private schedule(): void {
    if (!this.active || this.scheduled) return;
    this.scheduled = this.dependencies.schedule(() => {
      this.scheduled = null;
      this.check();
    });
  }

  private readonly pointer = (event: Event): void => {
    try {
      if (!(event.target instanceof this.document.defaultView!.Element)) return;
      const target = event.target.closest("a[href],button,.cocoon-tag-drawer");
      if (!target) return;
      const identity = profileIdentity(target);
      if (
        !identity &&
        !target.closest(".cocoon-tag-drawer,.cocoon-hover-block-button,.cocoon-zhihu-card-close")
      )
        return;
      const mouse = event as MouseEvent;
      if (
        mouse.relatedTarget instanceof this.document.defaultView!.Node &&
        target.contains(mouse.relatedTarget)
      )
        return;
      this.dependencies.record({
        kind: "pointer",
        reason: event.type as "mouseover" | "mouseout" | "click",
        node: this.dependencies.nodeId(target),
        ...(identity ?? {}),
        pointX: mouse.clientX,
        pointY: mouse.clientY,
        ...geometry(target),
      });
    } catch {
      /* A detached or changing DOM cannot interrupt native input. */
    }
  };

  private watchRoot(root: Element): void {
    this.rootObserver.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ["href", "class", "style", "hidden"],
    });
    let parent: Element | null = root.parentElement;
    for (let depth = 0; parent && parent !== this.document.body && depth < 5; depth++) {
      this.rootObserver.observe(parent, {
        attributes: true,
        attributeFilter: ["class", "style", "hidden"],
      });
      parent = parent.parentElement;
    }
  }

  private check(): void {
    if (!this.active) return;
    try {
      const all = this.document.querySelectorAll(HOVER);
      const dropped = Math.max(0, all.length - MAX_HOVERS);
      if (dropped !== this.overflow) {
        this.dependencies.record({ kind: "hover-state", total: all.length, dropped });
        this.overflow = dropped;
      }
      const current = [...all].slice(0, MAX_HOVERS);
      for (const root of this.roots.keys()) {
        if (current.includes(root)) continue;
        this.dependencies.record({ kind: "hover-removed", node: this.dependencies.nodeId(root) });
        this.roots.delete(root);
      }
      this.rootObserver.disconnect();
      for (const root of current) this.inspect(root);
    } catch {
      /* Diagnostics remain best effort during page mutation. */
    }
  }

  private inspect(root: Element): void {
    this.watchRoot(root);
    const state = hoverState(root, this.dependencies.nodeId(root));
    const signature = JSON.stringify(state.event);
    if (signature !== this.roots.get(root)) {
      this.dependencies.record({
        ...state.event,
        kind: this.roots.has(root) ? "hover-state" : "hover-added",
      });
      this.roots.set(root, signature);
    }
    if (state.suspect && this.candidates.get(root) !== state.identity) {
      this.candidates.set(root, state.identity);
      this.dependencies.candidate();
    }
  }

  refresh(): void {
    this.schedule();
  }

  stop(): void {
    this.active = false;
    this.scheduled?.();
    this.scheduled = null;
    this.treeObserver.disconnect();
    this.rootObserver.disconnect();
    this.roots.clear();
    for (const type of ["mouseover", "mouseout", "click"])
      this.document.removeEventListener(type, this.pointer, true);
  }
}

export function observeDiagnosticDom(document: Document, dependencies: DomDependencies) {
  const observer = new DiagnosticDomObserver(document, dependencies);
  try {
    observer.start();
  } catch {
    observer.stop();
  }
  return { stop: () => observer.stop(), refresh: () => observer.refresh() };
}
