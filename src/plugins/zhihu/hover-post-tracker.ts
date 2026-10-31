import { normalizeMemberHashId } from "../../content/blacklist-state.ts";
import {
  resolveHoverCardFromItem,
  type HoverAuthorActivation,
} from "../../content/hover-card-controller.ts";
import { parseZhihuUserId } from "../../content/parse-zhihu-user-id.ts";
import type { ZhihuContentSource } from "../../content/zhihu-content-source.ts";
import type { SourcePost } from "../../core/source-post.ts";
import { getCardContentSource, getCardSourcePost } from "./card-content-source.ts";

type Mode = "pointer" | "focus";
type Hover = NonNullable<ReturnType<typeof resolveHoverCardFromItem>>;
interface Dependencies {
  schedule(callback: () => void): number;
  cancel(handle: number): void;
  isActive(link: HTMLAnchorElement, mode: Mode): boolean;
}
interface Observation {
  card: WeakRef<HTMLElement>;
  url: string | null;
  ambiguous: boolean;
}
interface Origin {
  link: HTMLAnchorElement;
  card: HTMLElement;
  id: string;
  expected: ZhihuContentSource;
  bound: Hover | null;
}
export interface HoverPostTracker {
  capture(activation: HoverAuthorActivation): SourcePost | null;
  dispose(): void;
}

function profileId(link: HTMLAnchorElement): string | null {
  const id = parseZhihuUserId(link.getAttribute("href") ?? "");
  return id ? (normalizeMemberHashId(id) ?? id) : null;
}

function sameHover(left: Hover, right: Hover): boolean {
  return (
    left.root === right.root &&
    left.userId === right.userId &&
    left.memberHashId === right.memberHashId
  );
}

function invalidatesOrigin(record: MutationRecord, origin: Origin): boolean {
  const nodes = [origin.card, origin.bound?.root].filter((node): node is HTMLElement =>
    Boolean(node),
  );
  if ([...record.removedNodes].some((removed) => nodes.some((node) => removed.contains(node))))
    return true;
  return (
    (record.type === "attributes" || record.removedNodes.length > 0) &&
    nodes.some((node) => node.contains(record.target))
  );
}

function livePost(origin: Origin): SourcePost | null {
  if (
    !origin.link.isConnected ||
    origin.link.closest(".TopstoryItem") !== origin.card ||
    profileId(origin.link) !== origin.id
  )
    return null;
  return getCardSourcePost(origin.card, origin.expected);
}

class Tracker implements HoverPostTracker {
  private readonly document: Document;
  private readonly dependencies: Dependencies;
  private readonly observer: MutationObserver;
  private roots = new Map<HTMLElement, Hover>();
  private seen = new WeakSet<Element>();
  // No timer proves which card caused a delayed same-author popup; quarantine for this page.
  private observations = new Map<string, Observation>();
  private pointer: HTMLAnchorElement | null = null;
  private focus: HTMLAnchorElement | null = null;
  private origin: Origin | null = null;
  private frame: number | null = null;
  private running = false;

  constructor(document: Document, dependencies: Partial<Dependencies>) {
    this.document = document;
    this.dependencies = {
      schedule: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
      isActive: (link, mode) =>
        mode === "pointer" ? link.matches(":hover") : link.contains(document.activeElement),
      ...dependencies,
    };
    this.observer = new document.defaultView!.MutationObserver((records) => {
      this.invalidate(records);
      if (this.origin && this.frame === null)
        this.frame = this.dependencies.schedule(() => {
          this.frame = null;
          this.scan();
        });
    });
    document.defaultView!.addEventListener("pagehide", this.pause);
    document.defaultView!.addEventListener("pageshow", this.resume);
    this.start();
  }

  private collectRoots(): Map<HTMLElement, Hover> {
    const roots = new Map<HTMLElement, Hover>();
    for (const item of this.document.querySelectorAll<HTMLElement>(".HoverCard-item")) {
      const resolved = resolveHoverCardFromItem(item);
      if (resolved) roots.set(resolved.root, resolved);
    }
    return roots;
  }

  private remember(id: string, card: HTMLElement, url: string | null): void {
    const previous = this.observations.get(id);
    if (previous) {
      previous.ambiguous ||= previous.card.deref() !== card || previous.url !== url;
    } else {
      this.observations.set(id, { card: new WeakRef(card), url, ambiguous: url === null });
    }
  }

  private mergeAlias(hover: Hover): void {
    if (!hover.memberHashId) return;
    const token = this.observations.get(hover.userId);
    const hash = this.observations.get(hover.memberHashId);
    const merged = token ?? hash;
    if (!merged) return;
    if (token && hash && token !== hash) this.joinObservations(token, hash);
    this.observations.set(hover.userId, merged);
    this.observations.set(hover.memberHashId, merged);
  }

  private joinObservations(token: Observation, hash: Observation): void {
    token.ambiguous ||=
      hash.ambiguous || token.card.deref() !== hash.card.deref() || token.url !== hash.url;
    for (const [id, observation] of this.observations) {
      if (observation === hash) this.observations.set(id, token);
    }
  }

  private observeRoots(): Set<HTMLElement> {
    this.roots = this.collectRoots();
    const fresh = new Set([...this.roots.keys()].filter((root) => !this.seen.has(root)));
    for (const item of this.document.querySelectorAll<HTMLElement>(".HoverCard-item")) {
      const root = resolveHoverCardFromItem(item)?.root;
      if (root && this.seen.has(item)) fresh.delete(root);
      this.seen.add(item);
    }
    for (const hover of this.roots.values()) {
      this.mergeAlias(hover);
      this.seen.add(hover.root);
    }
    return fresh;
  }

  private scan(): void {
    const fresh = this.observeRoots();
    const origin = this.origin;
    if (!origin) return;
    const matching = [...this.roots.values()].filter(
      (hover) => hover.userId === origin.id || hover.memberHashId === origin.id,
    );
    if (matching.length !== 1 || this.observations.get(origin.id)!.ambiguous) {
      if (origin.bound || matching.length > 1) this.origin = null;
      return;
    }
    const hover = matching[0]!;
    if (origin.bound) {
      if (!sameHover(hover, origin.bound)) this.origin = null;
    } else if (fresh.has(hover.root) && this.active(origin.link)) {
      origin.bound = hover;
    }
  }

  private disagrees(): boolean {
    return this.pointer !== null && this.focus !== null && this.pointer !== this.focus;
  }

  private active(link: HTMLAnchorElement): boolean {
    if (this.disagrees()) return false;
    return (["pointer", "focus"] as const).some(
      (mode) => this[mode] === link && this.dependencies.isActive(link, mode),
    );
  }

  private retireRemoved(nodes: NodeList): void {
    for (const node of nodes) {
      if (node.nodeType !== 1) continue;
      this.seen.add(node as Element);
      for (const child of (node as Element).querySelectorAll(".HoverCard-item"))
        this.seen.add(child);
    }
  }

  private invalidate(records: readonly MutationRecord[]): void {
    if (records.length === 0) return;
    const roots = this.collectRoots();
    for (const record of records) {
      this.retireRemoved(record.removedNodes);
      if (record.type === "attributes" || record.removedNodes.length > 0) {
        const affected = [...roots.keys()].filter((root) => root.contains(record.target));
        affected.forEach((root) => this.seen.add(root));
      }
      this.invalidateOrigin(record);
    }
  }

  private invalidateOrigin(record: MutationRecord): void {
    const origin = this.origin;
    if (!origin || !invalidatesOrigin(record, origin)) return;
    // A source that changed back can still have a delayed popup from its intervening content.
    if (origin.card.contains(record.target)) this.observations.get(origin.id)!.ambiguous = true;
    this.origin = null;
  }

  private flush(): void {
    this.invalidate(this.observer.takeRecords());
    if (this.frame !== null) this.dependencies.cancel(this.frame);
    this.frame = null;
    this.scan();
  }

  private linkAt(target: EventTarget | null): HTMLAnchorElement | null {
    if (!(target instanceof this.document.defaultView!.Element)) return null;
    if ([...this.roots.keys()].some((root) => root.contains(target))) return null;
    const link = target.closest<HTMLAnchorElement>("a[href]");
    return link && profileId(link) ? link : null;
  }

  private onInteraction = (event: Event): void => {
    const mode = event.type.startsWith("pointer") ? "pointer" : "focus";
    const leaving = event.type.endsWith("out");
    const target = leaving ? (event as MouseEvent | FocusEvent).relatedTarget : event.target;
    const anchor =
      target instanceof this.document.defaultView!.Element ? target.closest("a[href]") : null;
    if (this[mode] === anchor) return;
    this.flush();
    const link = this.linkAt(target);
    if (this[mode] === link) return;
    this[mode] = link;
    if (link) return this.begin(link);
    const origin = this.origin;
    // A bound window retains its source across the neutral gap on the way to its button.
    if (origin && !origin.bound && !this.active(origin.link)) this.origin = null;
  };

  private begin(link: HTMLAnchorElement): void {
    const card = link.closest<HTMLElement>(".TopstoryItem");
    if (!card) {
      this.remember(profileId(link)!, link, null);
      this.origin = null;
      return;
    }
    const id = profileId(link)!;
    const expected = getCardContentSource(card);
    const post = getCardSourcePost(card, expected);
    this.remember(id, card, post?.url ?? null);
    if (this.disagrees()) {
      this.origin = null;
      return;
    }
    if (this.origin?.link === link) return;
    this.origin = expected && post ? { link, card, id, expected, bound: null } : null;
  }

  capture(activation: HoverAuthorActivation): SourcePost | null {
    try {
      if (!this.running) return null;
      this.flush();
      const origin = this.origin;
      if (!origin?.bound || !sameHover(origin.bound, activation)) return null;
      if (this.disagrees() || this.observations.get(origin.id)?.ambiguous) return null;
      return livePost(origin);
    } catch {
      // Optional provenance must never prevent the independent author-block action.
      this.origin = null;
      return null;
    }
  }

  private start(): void {
    this.running = true;
    this.scan();
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"])
      this.document.addEventListener(type, this.onInteraction, true);
    this.observer.observe(this.document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["href"],
    });
  }

  private pause = (event?: PageTransitionEvent): void => {
    if (this.running) this.flush();
    this.running = false;
    this.observer.disconnect();
    if (this.frame !== null) this.dependencies.cancel(this.frame);
    this.frame = null;
    this.origin = this.pointer = this.focus = null;
    this.roots.clear();
    // BFCache suspends native delayed work; it does not prove pending popups were cancelled.
    if (!event?.persisted) {
      this.seen = new WeakSet();
      this.observations.clear();
    }
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"])
      this.document.removeEventListener(type, this.onInteraction, true);
  };

  private resume = (event: PageTransitionEvent): void => {
    if (event.persisted && !this.running) this.start();
  };

  dispose(): void {
    this.pause();
    this.document.defaultView!.removeEventListener("pagehide", this.pause);
    this.document.defaultView!.removeEventListener("pageshow", this.resume);
  }
}

export function createHoverPostTracker(
  document: Document,
  dependencies: Partial<Dependencies> = {},
): HoverPostTracker {
  return new Tracker(document, dependencies);
}
