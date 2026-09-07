import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import {
  createBlacklistQueryResponse,
  type BlacklistQueryRequest,
  type BlacklistQueryResponse,
} from "../core/blacklist-query-rpc-contract.ts";
import {
  MAX_BLACKLIST_MUTATION_IDENTITIES,
  createBlacklistRpcResponse,
  type BlacklistAuthorIdentityDto,
  type BlacklistAuthorDto,
  type BlacklistTagDto,
  type BlacklistRpcOperation,
  type BlacklistRpcResponse,
} from "../core/blacklist-rpc-contract.ts";
import {
  createBlacklistTransferResponse,
  type BlacklistImportSessionDto,
  type BlacklistTransferError,
} from "../core/blacklist-transfer-rpc-contract.ts";
import {
  BLACKLIST_TRANSFER_FILE_BYTES,
  blacklistTransferTextBytes,
  type BlacklistTransferEnvelopeV1,
} from "../core/blacklist-transfer-values.ts";
import { createBlacklistRpcClient, type StrictBlacklistRpcClient } from "../ui/background-rpc.ts";
import type { BlacklistTransferRpcClient } from "../ui/blacklist-transfer-rpc.ts";
import {
  bootstrapOptions as bootstrapProductionOptions,
  type OptionsAppDependencies,
} from "./app.ts";
import { OptionsTransferPipelineError, runBlacklistExport } from "./transfer-pipeline.ts";

type OptionsTestDependencyDefaults = "readFileText" | "downloadJson" | "transferRpc";
type OptionsTestDependencies = Omit<OptionsAppDependencies, OptionsTestDependencyDefaults> &
  Partial<Pick<OptionsAppDependencies, OptionsTestDependencyDefaults>>;

function unusedTransferRpc(): BlacklistTransferRpcClient {
  const unexpected = async (): Promise<never> => {
    throw new Error("Unexpected transfer RPC.");
  };
  return {
    beginImport: unexpected,
    stageAuthorsChunk: unexpected,
    stageTagsChunk: unexpected,
    inspectImport: unexpected,
    finalizeImport: unexpected,
    abortImport: unexpected,
    beginExport: unexpected,
    exportAuthorsPage: unexpected,
    exportTagsPage: unexpected,
    finishExport: unexpected,
  };
}

function bootstrapOptions(
  dependencies: OptionsTestDependencies,
): ReturnType<typeof bootstrapProductionOptions> {
  return bootstrapProductionOptions({
    transferRpc: unusedTransferRpc(),
    async readFileText() {
      return "";
    },
    downloadJson() {},
    ...dependencies,
  });
}

interface TestBlacklistState {
  readonly authors: readonly BlacklistAuthorDto[];
  readonly tags: readonly BlacklistTagDto[];
}

function selectionState(authorCount: number): TestBlacklistState {
  return {
    authors: Array.from({ length: authorCount }, (_, index) => ({
      platformId: "zhihu",
      userId: `selection-${String(index).padStart(3, "0")}`,
      memberHashId: null,
      authorName: `Selection ${index}`,
      tagId: "default",
      blacklistedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      source: "direct",
    })),
    tags: [{ tagId: "default", name: "default", isDefault: true }],
  };
}

const TEST_STATE: TestBlacklistState = {
  authors: [
    {
      platformId: "zhihu",
      userId: "author-one",
      memberHashId: null,
      authorName: "Author One",
      tagId: "tag-one",
      blacklistedAt: "2026-08-21T10:00:00.000Z",
      source: "direct",
    },
  ],
  tags: [
    { tagId: "default", name: "default", isDefault: true },
    { tagId: "tag-one", name: "Persisted", isDefault: false },
  ],
};

function renameTagDelta(
  snapshot: TestBlacklistState,
  tag: TestBlacklistState["tags"][number],
  revision = 2,
) {
  return createBlacklistRpcResponse("rename-tag", true, {
    revision,
    authorCount: snapshot.authors.length,
    tagCount: snapshot.tags.length,
    tag,
  });
}

function deleteTagDelta(
  snapshot: TestBlacklistState,
  deletedTagId: string,
  migratedCount: number,
  revision = 2,
) {
  return createBlacklistRpcResponse("delete-tag", true, {
    revision,
    authorCount: snapshot.authors.length,
    tagCount: snapshot.tags.length,
    deletedTagId,
    migratedCount,
  });
}

const TRANSFER: BlacklistTransferEnvelopeV1 = {
  product: "cocoon-blacklist",
  formatVersion: 1,
  exportedAt: "2026-08-22T10:00:00.000Z",
  schemaVersion: 5,
  authors: [
    {
      platformId: "zhihu",
      userId: "transfer/zhihu user",
      memberHashId: null,
      authorNameAtCapture: "Transfer Zhihu",
      tagId: "default",
      blacklistedAt: "2026-08-21T10:00:00.000Z",
      blockSource: "direct",
    },
    {
      platformId: "youtube",
      userId: "transfer-youtube",
      memberHashId: null,
      authorNameAtCapture: "Transfer YouTube",
      tagId: "reading",
      blacklistedAt: "2026-08-20T10:00:00.000Z",
      blockSource: "upvoter",
    },
  ],
  tags: [
    { tagId: "default", name: "default" },
    { tagId: "reading", name: "Reading" },
  ],
};

function fixture(): JSDOM {
  const dom = new JSDOM(
    `<!doctype html><body>
    <span id="author-total"></span><span id="tag-total"></span>
    <p id="page-message"></p><p id="write-error" tabindex="-1" hidden></p>
    <section id="transfer-panel">
      <button id="export-data"></button><input id="import-file" type="file">
      <fieldset id="import-mode">
        <input type="radio" name="import-mode" value="merge" checked>
        <input type="radio" name="import-mode" value="replace">
      </fieldset>
      <button id="import-data"></button><p id="transfer-status" tabindex="-1"></p>
      <p id="transfer-error" tabindex="-1" hidden></p>
    </section>
    <input id="author-search"><select id="tag-filter"></select><select id="platform-filter"></select>
    <select id="time-sort"><option value="desc">desc</option><option value="asc">asc</option></select>
    <button id="remove-selected"></button>
    <div id="author-viewport" tabindex="0"><div id="author-list"></div></div>
    <p id="list-summary"></p><h2 id="tags-heading" tabindex="-1"></h2><p id="tag-summary"></p><div id="tag-list"></div>
    <dialog id="batch-dialog"><p id="batch-dialog-description"></p>
      <button id="batch-cancel"></button><button id="batch-confirm"></button>
    </dialog>
    <dialog id="replace-dialog"><p id="replace-dialog-description"></p>
      <button id="replace-cancel"></button><button id="replace-confirm"></button>
    </dialog>
  </body>`,
    {
      pretendToBeVisual: true,
      url: "chrome-extension://runtime/options/options.html",
    },
  );
  for (const dialog of dom.window.document.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.showModal = () => {
      dialog.open = true;
    };
    dialog.close = () => {
      dialog.open = false;
    };
  }
  return dom;
}

test("MANAGE-005/AC-092 keeps transfer tools as the final main section", async () => {
  const source = await readFile(new URL("../../options/options.html", import.meta.url), "utf8");
  const document = new JSDOM(source).window.document;
  const main = document.querySelector("main");
  const tags = document.querySelector(".tags-panel");
  const transfer = document.querySelector("#transfer-panel");
  if (!main || !tags || !transfer) throw new Error("production sections missing");

  const sections = [...main.querySelectorAll(":scope > section")];
  strictEqual(sections.at(-1), transfer);
  strictEqual(sections.indexOf(tags) < sections.indexOf(transfer), true);
});

function selectImportFile(dom: JSDOM, file: File | null): void {
  const input = dom.window.document.querySelector<HTMLInputElement>("#import-file");
  if (!input) throw new Error("import input missing");
  Object.defineProperty(input, "files", {
    configurable: true,
    value: file ? [file] : [],
  });
  input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
}

const TRANSFER_SESSION_ID = "1".repeat(32);
type TransferMetadata = Parameters<BlacklistTransferRpcClient["beginImport"]>[0];

function transferSession(
  metadata: TransferMetadata,
  status: BlacklistImportSessionDto["status"],
): BlacklistImportSessionDto {
  const complete = status === "ready";
  return {
    sessionId: TRANSFER_SESSION_ID,
    metadata,
    status,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 2,
    received: {
      authors: {
        chunks: complete ? metadata.authorChunkCount : 0,
        count: complete ? metadata.authorCount : 0,
        bytes: complete ? metadata.authorsBytes : 2,
      },
      tags: {
        chunks: complete ? metadata.tagChunkCount : 0,
        count: complete ? metadata.tagCount : 0,
        bytes: complete ? metadata.tagsBytes : 2,
      },
    },
  };
}

interface ImportTransferRpcOptions {
  readonly failure?: BlacklistTransferError;
  readonly failDuringChunk?: boolean;
  readonly finalize?: BlacklistTransferRpcClient["finalizeImport"];
}

function createImportTransferRpc(options: ImportTransferRpcOptions = {}) {
  const calls: string[] = [];
  let metadata: TransferMetadata | null = null;
  const currentMetadata = (): TransferMetadata => {
    if (!metadata) throw new Error("Import did not begin.");
    return metadata;
  };
  const rpc: BlacklistTransferRpcClient = {
    ...unusedTransferRpc(),
    async beginImport(value) {
      calls.push("begin");
      metadata = value;
      return createBlacklistTransferResponse(
        "import-begin",
        true,
        transferSession(value, "receiving"),
      );
    },
    async stageTagsChunk(input) {
      calls.push(`tags:${input.tags.length}`);
      if (options.failDuringChunk && options.failure) {
        return createBlacklistTransferResponse("import-tags-chunk", false, null, options.failure);
      }
      return createBlacklistTransferResponse("import-tags-chunk", true, {
        status: "staged",
        session: transferSession(currentMetadata(), "receiving"),
      });
    },
    async stageAuthorsChunk(input) {
      calls.push(`authors:${input.authors.length}`);
      return createBlacklistTransferResponse("import-authors-chunk", true, {
        status: "staged",
        session: transferSession(currentMetadata(), "receiving"),
      });
    },
    async inspectImport() {
      calls.push("inspect");
      return createBlacklistTransferResponse(
        "import-inspect",
        true,
        transferSession(currentMetadata(), "ready"),
      );
    },
    async finalizeImport(sessionId, mode) {
      calls.push(`finalize:${sessionId}:${mode}`);
      if (options.finalize) return options.finalize(sessionId, mode);
      if (options.failure) {
        return createBlacklistTransferResponse("import-finalize", false, null, options.failure);
      }
      const value = currentMetadata();
      return createBlacklistTransferResponse("import-finalize", true, {
        revision: 2,
        authorCount: value.authorCount,
        tagCount: value.tagCount,
      });
    },
    async abortImport(sessionId) {
      calls.push(`abort:${sessionId}`);
      return createBlacklistTransferResponse("import-abort", true, { sessionId });
    },
  };
  return { calls, rpc };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

function requiredTestElement<ElementType extends Element>(
  document: Document,
  selector: string,
): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`missing options test element: ${selector}`);
  return element;
}

function submitTagRename(dom: JSDOM, currentName: string, nextName: string): void {
  const document = dom.window.document;
  requiredTestElement<HTMLButtonElement>(
    document,
    `button[aria-label='重命名标签 ${currentName}']`,
  ).click();
  const input = requiredTestElement<HTMLInputElement>(document, "#tag-list input");
  input.value = nextName;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  requiredTestElement<HTMLFormElement>(document, "#tag-list form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

function emitRevision(
  listener: (changes: Record<string, unknown>, area: string) => void,
  revision = 1,
): void {
  listener({ cocoonBlacklistRevision: { newValue: { version: 1, revision } } }, "local");
}

function optionByText(select: HTMLSelectElement, text: string): HTMLOptionElement {
  const option = [...select.options].find((candidate) => candidate.textContent === text);
  if (!option) throw new Error(`missing option: ${text}`);
  return option;
}

function elementText(document: Document, selector: string): string {
  return requiredTestElement<HTMLElement>(document, selector).textContent ?? "";
}

function deferred<Value>() {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve: (value: Value) => resolve?.(value) };
}

function deferredResponse() {
  return deferred<BlacklistRpcResponse>();
}

class RpcQueue implements StrictBlacklistRpcClient {
  readonly responses = new Map<BlacklistRpcOperation, Array<Promise<BlacklistRpcResponse>>>();
  readonly requestCounts = new Map<BlacklistRpcOperation, number>();
  readonly requests: Array<{
    readonly operation: BlacklistRpcOperation;
    readonly input: Record<string, unknown>;
  }> = [];
  readonly queryRequests: BlacklistQueryRequest[] = [];
  private readonly states: Array<TestBlacklistState | null> = [];
  private activeState: TestBlacklistState | null = null;
  private revision = 0;

  push(
    operation: BlacklistRpcOperation,
    response: BlacklistRpcResponse | Promise<BlacklistRpcResponse>,
  ): void {
    const queue = this.responses.get(operation) ?? [];
    queue.push(Promise.resolve(response));
    this.responses.set(operation, queue);
  }

  pushState(state: TestBlacklistState | null): void {
    this.states.push(state);
  }

  async request(
    operation: BlacklistRpcOperation,
    input: Record<string, unknown> = {},
  ): Promise<BlacklistRpcResponse> {
    this.requestCounts.set(operation, (this.requestCounts.get(operation) ?? 0) + 1);
    this.requests.push({ operation, input });
    const response = this.responses.get(operation)?.shift();
    if (!response) throw new Error(`missing ${operation} response`);
    const resolved = await response;
    if (resolved.ok && this.activeState && resolved.data.revision !== null) {
      this.applyMutationDelta(resolved, input);
      this.revision = resolved.data.revision;
    }
    return resolved;
  }

  private applyMutationDelta(response: BlacklistRpcResponse, input: Record<string, unknown>): void {
    const snapshot = this.activeState;
    if (!snapshot) return;
    if (response.operation === "rename-tag" && response.data.tag) {
      this.activeState = {
        ...snapshot,
        tags: snapshot.tags.map((tag) =>
          tag.tagId === response.data.tag?.tagId ? response.data.tag : tag,
        ),
      };
      return;
    }
    if (response.operation === "delete-tag" && response.data.deletedTagId) {
      this.activeState = {
        tags: snapshot.tags.filter((tag) => tag.tagId !== response.data.deletedTagId),
        authors: snapshot.authors.map((author) =>
          author.tagId === response.data.deletedTagId ? { ...author, tagId: "default" } : author,
        ),
      };
      return;
    }
    if (response.operation === "remove-one" && response.data.removed) {
      this.activeState = {
        ...snapshot,
        authors: snapshot.authors.filter(
          (author) =>
            author.platformId !== response.data.removed?.platformId ||
            author.userId !== response.data.removed.userId,
        ),
      };
      return;
    }
    if (response.operation === "remove-many" && Array.isArray(input.identities)) {
      const removed = new Set(
        input.identities.map((identity) => {
          const value = identity as BlacklistAuthorIdentityDto;
          return JSON.stringify([value.platformId, value.userId]);
        }),
      );
      this.activeState = {
        ...snapshot,
        authors: snapshot.authors.filter(
          (author) => !removed.has(JSON.stringify([author.platformId, author.userId])),
        ),
      };
    }
  }

  private commonQueryState(snapshot: TestBlacklistState) {
    return {
      revision: this.revision,
      authorCount: snapshot.authors.length,
      tagCount: snapshot.tags.length,
    };
  }

  private activateNextState(): boolean {
    const state = this.states.shift() ?? null;
    if (!state) return false;
    this.activeState = state;
    this.revision += 1;
    return true;
  }

  private queryTags(
    request: Extract<BlacklistQueryRequest, { operation: "tags-page" }>,
    snapshot: TestBlacklistState,
  ): BlacklistQueryResponse {
    const offset = Number(request.input.cursor ?? 0);
    const selected = snapshot.tags.slice(offset, offset + request.input.limit);
    return createBlacklistQueryResponse("tags-page", true, {
      ...this.commonQueryState(snapshot),
      tags: selected.map((tag) => ({
        ...tag,
        authorCount: snapshot.authors.filter((author) => author.tagId === tag.tagId).length,
      })),
      nextCursor:
        offset + selected.length < snapshot.tags.length ? String(offset + selected.length) : null,
    });
  }

  private queryPlatforms(
    request: Extract<BlacklistQueryRequest, { operation: "platforms-page" }>,
    snapshot: TestBlacklistState,
  ): BlacklistQueryResponse {
    const all = [...new Set(snapshot.authors.map((author) => author.platformId))].sort();
    const offset = Number(request.input.cursor ?? 0);
    const selected = all.slice(offset, offset + request.input.limit);
    return createBlacklistQueryResponse("platforms-page", true, {
      ...this.commonQueryState(snapshot),
      platforms: selected,
      nextCursor: offset + selected.length < all.length ? String(offset + selected.length) : null,
    });
  }

  private queryAuthors(
    request: Extract<BlacklistQueryRequest, { operation: "authors-page" }>,
    snapshot: TestBlacklistState,
  ): BlacklistQueryResponse {
    const tags = new Map(snapshot.tags.map((tag) => [tag.tagId, tag]));
    const normalizedSearch = request.input.search.toLocaleLowerCase("zh-CN");
    const items = snapshot.authors
      .filter(
        (author) =>
          (!normalizedSearch ||
            author.authorName.toLocaleLowerCase("zh-CN").includes(normalizedSearch)) &&
          (request.input.tagId === null || author.tagId === request.input.tagId) &&
          (request.input.platformId === null || author.platformId === request.input.platformId),
      )
      .flatMap((author) => {
        const tag = tags.get(author.tagId);
        return tag ? [{ author, tag }] : [];
      })
      .sort((left, right) => {
        const compared = (left.author.blacklistedAt ?? "9999").localeCompare(
          right.author.blacklistedAt ?? "9999",
        );
        return request.input.direction === "asc" ? compared : -compared;
      });
    const offset = Number(request.input.cursor ?? 0);
    const selected = items.slice(offset, offset + request.input.limit);
    return createBlacklistQueryResponse("authors-page", true, {
      ...this.commonQueryState(snapshot),
      items: selected,
      nextCursor: offset + selected.length < items.length ? String(offset + selected.length) : null,
      totalCount: items.length,
    });
  }

  async query(request: BlacklistQueryRequest): Promise<BlacklistQueryResponse> {
    this.queryRequests.push(request);
    if (request.operation === "summary" && this.states.length > 0 && !this.activateNextState()) {
      return createBlacklistQueryResponse("summary", false, null, "storage-unreadable");
    }
    const snapshot = this.activeState;
    if (!snapshot) {
      return createBlacklistQueryResponse(request.operation, false, null, "storage-unreadable");
    }
    if (request.operation === "summary") {
      return createBlacklistQueryResponse("summary", true, this.commonQueryState(snapshot));
    }
    if (request.input.revision !== this.revision) {
      return createBlacklistQueryResponse(request.operation, false, null, "stale-cursor");
    }
    if (request.operation === "tags-page") return this.queryTags(request, snapshot);
    if (request.operation === "platforms-page") return this.queryPlatforms(request, snapshot);
    if (request.operation === "authors-page") return this.queryAuthors(request, snapshot);
    return createBlacklistQueryResponse("identity-match", true, {
      revision: this.revision,
      matches: [],
    });
  }

  removeOne(
    identity: Parameters<StrictBlacklistRpcClient["removeOne"]>[0],
  ): Promise<BlacklistRpcResponse> {
    return this.request("remove-one", { identity });
  }

  restoreOne(
    author: Parameters<StrictBlacklistRpcClient["restoreOne"]>[0],
  ): Promise<BlacklistRpcResponse> {
    return this.request("restore-one", { author });
  }
}

test("BUG-014/AC-085 options accepts nullable member aliases through the strict RPC client", async () => {
  const dom = fixture();
  const backend = new RpcQueue();
  backend.pushState(TEST_STATE);
  const rpc = createBlacklistRpcClient(async (message) =>
    backend.query(message as BlacklistQueryRequest),
  );
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  strictEqual(backend.queryRequests.length, 4);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "1");
  strictEqual(dom.window.document.querySelector("#tag-total")?.textContent, "2");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual((dom.window.document.querySelector("#page-message") as HTMLElement).hidden, true);
});

test("BUG-016 options bootstrap uses bounded summary/facet/author pages without management reads", async () => {
  const dom = fixture();
  let managementCalls = 0;
  const rpc = {
    async request(operation: BlacklistRpcOperation): Promise<BlacklistRpcResponse> {
      managementCalls += 1;
      throw new Error(`unexpected management operation: ${operation}`);
    },
    async query(request: BlacklistQueryRequest) {
      if (request.operation === "summary") {
        return createBlacklistQueryResponse("summary", true, {
          revision: 12,
          authorCount: 33_524,
          tagCount: 2,
        });
      }
      if (request.operation === "tags-page") {
        return createBlacklistQueryResponse("tags-page", true, {
          revision: 12,
          authorCount: 33_524,
          tagCount: 2,
          tags: [
            { tagId: "default", name: "default", isDefault: true, authorCount: 0 },
            { tagId: "tag-one", name: "Persisted", isDefault: false, authorCount: 33_524 },
          ],
          nextCursor: null,
        });
      }
      if (request.operation === "platforms-page") {
        return createBlacklistQueryResponse("platforms-page", true, {
          revision: 12,
          authorCount: 33_524,
          tagCount: 2,
          platforms: ["zhihu"],
          nextCursor: null,
        });
      }
      if (request.operation === "authors-page") {
        return createBlacklistQueryResponse("authors-page", true, {
          revision: 12,
          authorCount: 33_524,
          tagCount: 2,
          items: [
            {
              author: TEST_STATE.authors[0]!,
              tag: TEST_STATE.tags[1]!,
            },
          ],
          nextCursor: "bounded-next-page",
          totalCount: 33_524,
        });
      }
      throw new Error("identity query not expected");
    },
    async removeOne() {
      throw new Error("not used");
    },
    async restoreOne() {
      throw new Error("not used");
    },
  } as unknown as StrictBlacklistRpcClient;

  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  strictEqual(managementCalls, 0);
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "33524");
  strictEqual(dom.window.document.querySelector("#tag-total")?.textContent, "2");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
});

test("BUG-016 batch selection stops at the atomic 500-author boundary", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const state = selectionState(MAX_BLACKLIST_MUTATION_IDENTITIES + 1);
  rpc.pushState(state);
  rpc.push(
    "remove-many",
    createBlacklistRpcResponse("remove-many", true, {
      revision: 2,
      authorCount: 1,
      tagCount: 1,
      removedCount: MAX_BLACKLIST_MUTATION_IDENTITIES,
    }),
  );
  const viewport = requiredTestElement<HTMLElement>(dom.window.document, "#author-viewport");
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, value: 50_000 },
    scrollHeight: { configurable: true, value: 50_000 },
  });
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  for (let page = 0; page < 10; page += 1) {
    viewport.dispatchEvent(new dom.window.Event("scroll"));
    await settle();
  }
  const selections = [
    ...dom.window.document.querySelectorAll<HTMLInputElement>(
      "#author-list input[type='checkbox']",
    ),
  ];
  strictEqual(selections.length, MAX_BLACKLIST_MUTATION_IDENTITIES + 1);
  selections.slice(0, MAX_BLACKLIST_MUTATION_IDENTITIES).forEach((selection) => {
    selection.click();
  });
  selections[MAX_BLACKLIST_MUTATION_IDENTITIES]!.click();

  strictEqual(selections[MAX_BLACKLIST_MUTATION_IDENTITIES]!.checked, false);
  strictEqual(elementText(dom.window.document, "#remove-selected"), "解除所选（500）");
  strictEqual(elementText(dom.window.document, "#write-error"), "一次最多选择 500 位作者。");
  strictEqual(dom.window.document.activeElement?.id, "write-error");

  requiredTestElement<HTMLButtonElement>(dom.window.document, "#remove-selected").click();
  strictEqual(
    elementText(dom.window.document, "#batch-dialog-description"),
    "确定解除所选的 500 位作者吗？",
  );
  requiredTestElement<HTMLButtonElement>(dom.window.document, "#batch-confirm").click();
  await settle();
  const request = rpc.requests.find(({ operation }) => operation === "remove-many");
  strictEqual((request?.input.identities as readonly unknown[]).length, 500);
});

test("MANAGE production bootstrap rolls failed rename back and enters read-only on storage-unreadable", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(TEST_STATE);
  rpc.push("rename-tag", createBlacklistRpcResponse("rename-tag", false, {}, "invalid-tag"));
  rpc.pushState(TEST_STATE);
  rpc.push("remove-one", createBlacklistRpcResponse("remove-one", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  submitTagRename(dom, "Persisted", "Rejected");
  await settle();

  const rerenderedName = dom.window.document.querySelector("#tag-list .tag-display-name");
  strictEqual(rerenderedName?.textContent, "Persisted");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 1);
  strictEqual(
    dom.window.document.querySelector("#tag-list")?.textContent?.includes("default"),
    false,
  );
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );
  strictEqual(
    dom.window.document.querySelector("#write-error")?.textContent,
    "标签名称无效或已存在。",
  );
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, false);

  requiredTestElement<HTMLButtonElement>(dom.window.document, "#author-list button").click();
  await settle();
  strictEqual(
    dom.window.document.querySelector("#page-message")?.textContent,
    "本地数据无法读取，Cocoon 未进行修改。",
  );
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 0);
  strictEqual(dom.window.document.querySelectorAll("#tag-list button").length, 0);
  strictEqual(
    (dom.window.document.querySelector("#remove-selected") as HTMLButtonElement).disabled,
    true,
  );
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);
  strictEqual(rpc.requestCounts.get("remove-one"), 1);
});

test("MANAGE-003/AC-087 failed delete rolls back and restores the equivalent action", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(TEST_STATE);
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", false, {}, "save-failed"));
  rpc.pushState(TEST_STATE);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const failedDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  failedDelete?.focus();
  failedDelete?.click();
  await settle();
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Persisted");
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, false);
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "删除标签 Persisted",
  );
});

test("MANAGE-003/AC-087 unreadable tag mutation focuses the visible error fallback", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(TEST_STATE);
  rpc.push("delete-tag", createBlacklistRpcResponse("delete-tag", false, {}, "storage-unreadable"));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const unreadableDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  unreadableDelete?.focus();
  unreadableDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.activeElement?.id, "write-error");
});

test("AC-095 committed rename snapshot remains visible without a post-read", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: TestBlacklistState = {
    ...TEST_STATE,
    tags: [TEST_STATE.tags[0]!, { ...TEST_STATE.tags[1]!, name: "Updated" }],
  };
  rpc.pushState(TEST_STATE);
  rpc.push("rename-tag", renameTagDelta(renamed, renamed.tags[1]!));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 1);
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Updated");
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, true);
});

test("AC-095 newer revision refresh wins over an older pending rename response", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingRename = deferredResponse();
  const updated: TestBlacklistState = {
    ...TEST_STATE,
    tags: [TEST_STATE.tags[0]!, { ...TEST_STATE.tags[1]!, name: "Updated" }],
  };
  const later: TestBlacklistState = {
    ...TEST_STATE,
    tags: [TEST_STATE.tags[0]!, { ...TEST_STATE.tags[1]!, name: "Later" }],
  };
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  rpc.pushState(TEST_STATE);
  rpc.push("rename-tag", pendingRename.promise);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  if (!input) throw new Error("rename input missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  input
    .closest("form")
    ?.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));

  rpc.pushState(later);
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 2 } } }, "local");
  await settle();
  pendingRename.resolve(renameTagDelta(updated, updated.tags[1]!));
  await settle();

  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Later");
});

test("AC-095 committed delete snapshot remains visible without a post-read", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const defaultOnly: TestBlacklistState = {
    authors: [{ ...TEST_STATE.authors[0]!, tagId: "default" }],
    tags: [TEST_STATE.tags[0]!],
  };
  rpc.pushState(TEST_STATE);
  rpc.push("delete-tag", deleteTagDelta(defaultOnly, "tag-one", 1));
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const successfulUnreadableDelete = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  successfulUnreadableDelete?.focus();
  successfulUnreadableDelete?.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(dom.window.document.querySelector(".tag-empty")?.textContent?.includes("暂无"), true);
  strictEqual((dom.window.document.querySelector("#write-error") as HTMLElement).hidden, true);
});

test("MANAGE-003/AC-087 successful rename and delete restore useful focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: TestBlacklistState = {
    ...TEST_STATE,
    tags: [TEST_STATE.tags[0]!, { ...TEST_STATE.tags[1]!, name: "Updated" }],
  };
  const defaultOnly: TestBlacklistState = {
    authors: [{ ...TEST_STATE.authors[0]!, tagId: "default" }],
    tags: [TEST_STATE.tags[0]!],
  };
  rpc.pushState(TEST_STATE);
  rpc.push("rename-tag", renameTagDelta(renamed, renamed.tags[1]!));
  rpc.pushState(renamed);
  rpc.push("delete-tag", deleteTagDelta(defaultOnly, "tag-one", 1, 4));
  rpc.pushState(defaultOnly);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  submitTagRename(dom, "Persisted", "Updated");
  await settle();
  strictEqual(dom.window.document.querySelector(".tag-display-name")?.textContent, "Updated");
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Updated",
  );
  emitRevision(listeners[0]!);
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Updated",
  );

  const successfulDelete = requiredTestElement<HTMLButtonElement>(
    dom.window.document,
    "button[aria-label='删除标签 Updated']",
  );
  successfulDelete.focus();
  successfulDelete.click();
  await settle();
  strictEqual(dom.window.document.querySelectorAll(".tag-row").length, 0);
  strictEqual(
    dom.window.document.querySelector(".tag-empty")?.textContent?.includes("暂无自定义标签"),
    true,
  );
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
  emitRevision(listeners[0]!);
  await settle();
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
});

test("MANAGE-003/AC-087 every storage rerender preserves tag focus or uses the heading", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const defaultOnly: TestBlacklistState = {
    authors: [{ ...TEST_STATE.authors[0]!, tagId: "default" }],
    tags: [TEST_STATE.tags[0]!],
  };
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  rpc.pushState(defaultOnly);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='删除标签 Persisted']")
    ?.focus();
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "删除标签 Persisted",
  );

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  strictEqual(dom.window.document.activeElement?.tagName, "INPUT");
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(
    (dom.window.document.activeElement as HTMLElement).getAttribute("aria-label"),
    "重命名标签 Persisted",
  );

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='删除标签 Persisted']")
    ?.focus();
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.activeElement?.id, "tags-heading");
});

test("MANAGE-003/AC-087 pending rename survives storage refresh without duplicate RPC or focus loss", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const renamed: TestBlacklistState = {
    ...TEST_STATE,
    tags: [TEST_STATE.tags[0]!, { ...TEST_STATE.tags[1]!, name: "Updated" }],
  };
  const pendingRename = deferredResponse();
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  rpc.push("rename-tag", pendingRename.promise);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  strictEqual(dom.window.document.activeElement, save);
  strictEqual(save.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);

  pendingRename.resolve(renameTagDelta(renamed, renamed.tags[1]!, 3));
  await settle();
  const completedAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Updated']",
  );
  strictEqual(dom.window.document.activeElement, completedAction);
  strictEqual(completedAction?.hasAttribute("aria-disabled"), false);
  strictEqual(rpc.requestCounts.get("rename-tag"), 1);
});

test("MANAGE-003/AC-087 pending delete survives storage refresh without duplicate RPC or focus loss", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingDelete = deferredResponse();
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  rpc.push("delete-tag", pendingDelete.promise);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  const remove = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  remove?.focus();
  remove?.click();
  strictEqual(dom.window.document.activeElement, remove);
  strictEqual(remove?.getAttribute("aria-disabled"), "true");

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  const pendingAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, pendingAction);
  strictEqual(pendingAction?.getAttribute("aria-disabled"), "true");
  pendingAction?.click();
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);

  pendingDelete.resolve(createBlacklistRpcResponse("delete-tag", false, {}, "save-failed"));
  await settle();
  const completedAction = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  strictEqual(dom.window.document.activeElement, completedAction);
  strictEqual(completedAction?.hasAttribute("aria-disabled"), false);
  strictEqual(rpc.requestCounts.get("delete-tag"), 1);
});

test("MANAGE-003/AC-087 stale rename completion never steals newer tag focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const initial: TestBlacklistState = {
    ...TEST_STATE,
    tags: [...TEST_STATE.tags, { tagId: "tag-two", name: "Second", isDefault: false }],
  };
  const renamed: TestBlacklistState = {
    ...initial,
    tags: [initial.tags[0]!, { ...initial.tags[1]!, name: "Updated" }, initial.tags[2]!],
  };
  const pendingRename = deferredResponse();
  rpc.pushState(initial);
  rpc.push("rename-tag", pendingRename.promise);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  dom.window.document
    .querySelector<HTMLButtonElement>("button[aria-label='重命名标签 Persisted']")
    ?.click();
  const input = dom.window.document.querySelector<HTMLInputElement>("#tag-list input");
  const save = dom.window.document.querySelector<HTMLButtonElement>("#tag-list .tag-save");
  if (!input || !save) throw new Error("rename controls missing");
  input.value = "Updated";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  save.focus();
  input.closest("form")?.dispatchEvent(
    new dom.window.Event("submit", {
      bubbles: true,
      cancelable: true,
    }),
  );
  const newerFocus = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Second']",
  );
  newerFocus?.focus();
  pendingRename.resolve(renameTagDelta(renamed, renamed.tags[1]!));
  await settle();
  strictEqual(dom.window.document.activeElement?.getAttribute("aria-label"), "删除标签 Second");
});

test("MANAGE-003/AC-087 stale delete failure never steals newer tag focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const initial: TestBlacklistState = {
    ...TEST_STATE,
    tags: [...TEST_STATE.tags, { tagId: "tag-two", name: "Second", isDefault: false }],
  };
  const pendingDelete = deferredResponse();
  rpc.pushState(initial);
  rpc.push("delete-tag", pendingDelete.promise);
  rpc.pushState(initial);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const deleting = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='删除标签 Persisted']",
  );
  deleting?.focus();
  deleting?.click();
  const newerFocus = dom.window.document.querySelector<HTMLButtonElement>(
    "button[aria-label='重命名标签 Second']",
  );
  newerFocus?.focus();
  pendingDelete.resolve(createBlacklistRpcResponse("delete-tag", false, {}, "save-failed"));
  await settle();
  strictEqual(dom.window.document.activeElement?.getAttribute("aria-label"), "重命名标签 Second");
});

function profileFilterSnapshots() {
  const internalUserId = "private-user-token-91";
  const internalTagId = "private-tag-token-73";
  const otherTagId = "private-tag-token-84";
  const initial: TestBlacklistState = {
    authors: [
      {
        platformId: "zhihu",
        userId: internalUserId,
        memberHashId: "abcdef0123456789abcdef0123456789",
        authorName: "Filtered Author",
        tagId: internalTagId,
        blacklistedAt: "2026-08-21T10:00:00.000Z",
        source: "direct",
      },
      {
        platformId: "zhihu",
        userId: "private-user-token-92",
        memberHashId: null,
        authorName: "Other Author",
        tagId: otherTagId,
        blacklistedAt: "2026-08-20T10:00:00.000Z",
        source: "upvoter",
      },
    ],
    tags: [
      { tagId: "default", name: "default", isDefault: true },
      { tagId: internalTagId, name: "Reading", isDefault: false },
      { tagId: otherTagId, name: "Muted", isDefault: false },
    ],
  };
  return {
    internalUserId,
    initial,
    refreshed: { ...initial, tags: [initial.tags[2]!, initial.tags[0]!, initial.tags[1]!] },
    removedTag: {
      authors: [{ ...initial.authors[0]!, tagId: "default" }, initial.authors[1]!],
      tags: [initial.tags[0]!, initial.tags[2]!],
    } satisfies TestBlacklistState,
  };
}

function assertManagementProfileLinks(
  document: Document,
  expectedUserIds: readonly string[],
): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a.author-name"));
  strictEqual(links.length, expectedUserIds.length);
  strictEqual(
    links
      .map((link) => link.href)
      .sort()
      .join("|"),
    expectedUserIds
      .map((userId) => `https://www.zhihu.com/people/${userId}`)
      .sort()
      .join("|"),
  );
  for (const link of links) {
    strictEqual(link.target, "_blank");
    strictEqual(link.rel, "noopener");
  }
}

test("PROFILE-001/AC-086 management links profiles and preserves tag filtering across refreshes", async () => {
  const {
    internalUserId,
    initial: privateSnapshot,
    refreshed: refreshedSnapshot,
    removedTag: removedTagSnapshot,
  } = profileFilterSnapshots();
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(privateSnapshot);
  rpc.pushState(refreshedSnapshot);
  rpc.pushState(removedTagSnapshot);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  assertManagementProfileLinks(dom.window.document, [internalUserId, "private-user-token-92"]);
  strictEqual(elementText(dom.window.document, "#tag-summary"), "2 个自定义标签");
  strictEqual(dom.window.document.querySelectorAll("#tag-list .tag-row").length, 2);
  strictEqual(elementText(dom.window.document, "#tag-list").includes("default"), false);

  const filter = requiredTestElement<HTMLSelectElement>(dom.window.document, "#tag-filter");
  const readingOption = optionByText(filter, "Reading");
  strictEqual(
    [...filter.options].some((option) => option.textContent === "default"),
    true,
  );
  filter.value = readingOption.value;
  filter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(elementText(dom.window.document, "#author-list").includes("Filtered Author"), true);
  strictEqual(elementText(dom.window.document, "#author-list").includes("Other Author"), false);

  emitRevision(listeners[0]!);
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 1);
  strictEqual(elementText(dom.window.document, "#author-list").includes("Filtered Author"), true);
  strictEqual(filter.selectedOptions.item(0)?.textContent, "Reading");
  assertManagementProfileLinks(dom.window.document, [internalUserId]);

  emitRevision(listeners[0]!);
  await settle();
  strictEqual(filter.value, "");
  strictEqual(filter.selectedOptions.item(0)?.textContent, "全部标签");
  strictEqual(dom.window.document.querySelectorAll("#author-list .author-row").length, 2);
  assertManagementProfileLinks(dom.window.document, [internalUserId, "private-user-token-92"]);
});

function platformFilterSnapshots() {
  const initial: TestBlacklistState = {
    tags: TEST_STATE.tags,
    authors: [
      {
        ...TEST_STATE.authors[0]!,
        userId: "zhihu/encoded user",
        authorName: "Video Zhihu",
        blacklistedAt: "2026-08-21T09:00:00.000Z",
      },
      {
        ...TEST_STATE.authors[0]!,
        platformId: "youtube",
        userId: "shared-user",
        memberHashId: null,
        authorName: "Video Older",
        blacklistedAt: "2026-08-20T09:00:00.000Z",
        source: "upvoter",
      },
      {
        ...TEST_STATE.authors[0]!,
        platformId: "youtube",
        userId: "newer-user",
        memberHashId: null,
        authorName: "Video Newer",
        blacklistedAt: "2026-08-22T09:00:00.000Z",
        source: "direct",
      },
      {
        ...TEST_STATE.authors[0]!,
        platformId: "future-site",
        userId: "shared-user",
        memberHashId: null,
        authorName: "Future Author",
        tagId: "default",
        source: "direct",
      },
    ],
  };
  return {
    initial,
    refreshed: {
      tags: initial.tags.map((tag) => ({ ...tag })),
      authors: [
        ...initial.authors.map((author) => ({ ...author })),
        {
          ...initial.authors[1]!,
          userId: "third-user",
          authorName: "Video Middle",
          blacklistedAt: "2026-08-21T09:00:00.000Z",
        },
      ],
    } satisfies TestBlacklistState,
  };
}

function requiredPlatformControls(document: Document) {
  const platformFilter = document.querySelector<HTMLSelectElement>("#platform-filter");
  const tagFilter = document.querySelector<HTMLSelectElement>("#tag-filter");
  const search = document.querySelector<HTMLInputElement>("#author-search");
  const sort = document.querySelector<HTMLSelectElement>("#time-sort");
  if (!platformFilter || !tagFilter || !search || !sort) {
    throw new Error("filter controls missing");
  }
  return { platformFilter, tagFilter, search, sort };
}

function assertPlatformRows(document: Document): void {
  const rows = Array.from(document.querySelectorAll<HTMLElement>("#author-list .author-row"));
  const futureRow = rows.find((row) => row.textContent?.includes("Future Author"));
  if (!futureRow) throw new Error("future platform row missing");
  strictEqual(futureRow.querySelector(".platform-name")?.textContent, "future-site");
  strictEqual(futureRow.querySelector(".source-name")?.textContent, "手动屏蔽");
  strictEqual(futureRow.querySelector("a.author-name"), null);
  const plainFuture = futureRow.querySelector<HTMLElement>("span.author-name");
  if (!plainFuture) throw new Error("plain future author missing");
  strictEqual(plainFuture.tabIndex, -1);
  strictEqual(plainFuture.hasAttribute("href"), false);
  const zhihuRow = rows.find((row) => row.textContent?.includes("Video Zhihu"));
  const zhihu = zhihuRow?.querySelector<HTMLAnchorElement>("a.author-name");
  if (!zhihu) throw new Error("Zhihu author link missing");
  strictEqual(zhihu.href, "https://www.zhihu.com/people/zhihu%2Fencoded%20user");
  strictEqual(zhihu.target, "_blank");
  strictEqual(zhihu.rel, "noopener");
}

test("PLATFORM-001/AC-090 management renders an independent platform column/filter through composed storage refreshes", async () => {
  const { initial: multiPlatform, refreshed } = platformFilterSnapshots();
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(multiPlatform);
  rpc.pushState(refreshed);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const { platformFilter, tagFilter, search, sort } = requiredPlatformControls(dom.window.document);
  const labels = ["future-site", "YouTube", "知乎"].sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );
  deepStrictEqual(
    [...platformFilter.options].map((option) => option.textContent),
    ["全部站点", ...labels],
  );
  assertPlatformRows(dom.window.document);

  const youtubeOption = [...platformFilter.options].find(
    (option) => option.textContent === "YouTube",
  );
  const readingOption = [...tagFilter.options].find((option) => option.textContent === "Persisted");
  if (!youtubeOption || !readingOption) throw new Error("filter option missing");
  platformFilter.value = youtubeOption.value;
  platformFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  tagFilter.value = readingOption.value;
  tagFilter.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  search.value = "video";
  search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  sort.value = "asc";
  sort.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();

  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name")).map(
      (name) => name.textContent,
    ),
    ["Video Older", "Video Newer"],
  );
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .source-name")).map(
      (source) => source.textContent,
    ),
    ["来自点赞者", "手动屏蔽"],
  );
  strictEqual(dom.window.document.querySelectorAll("#author-list a.author-name").length, 0);

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(platformFilter.selectedOptions[0]?.textContent, "YouTube");
  strictEqual(tagFilter.selectedOptions[0]?.textContent, "Persisted");
  deepStrictEqual(
    Array.from(dom.window.document.querySelectorAll("#author-list .author-name")).map(
      (name) => name.textContent,
    ),
    ["Video Older", "Video Middle", "Video Newer"],
  );
  for (const name of dom.window.document.querySelectorAll<HTMLElement>(
    "#author-list span.author-name",
  )) {
    strictEqual(name.tabIndex, -1);
    strictEqual(name.closest("a"), null);
  }
});

test("PLATFORM-001/PROFILE-002/AC-090/AC-091 composed filters keep incremental loading and link focus", async () => {
  const tags = TEST_STATE.tags;
  const large: TestBlacklistState = {
    tags,
    authors: [
      ...Array.from({ length: 130 }, (_, index) => ({
        ...TEST_STATE.authors[0]!,
        userId: `bulk/zhihu ${index}`,
        authorName: `Bulk ${String(index).padStart(3, "0")}`,
        blacklistedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
      ...Array.from({ length: 10 }, (_, index) => ({
        ...TEST_STATE.authors[0]!,
        platformId: "youtube",
        userId: `bulk-youtube-${index}`,
        memberHashId: null,
        authorName: `Bulk Video ${index}`,
      })),
    ],
  };
  const dom = fixture();
  const viewport = dom.window.document.querySelector<HTMLElement>("#author-viewport");
  const list = dom.window.document.querySelector<HTMLElement>("#author-list");
  if (!viewport || !list) throw new Error("author list missing");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 640 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get() {
      return list.querySelectorAll(".author-row").length * 64;
    },
  });
  const rpc = new RpcQueue();
  rpc.pushState(large);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  strictEqual(list.classList.contains("virtual-list"), false);
  strictEqual(list.querySelectorAll(".author-row").length, 50);
  const originalFocus = list.querySelector<HTMLAnchorElement>("a.author-name");
  originalFocus?.focus();
  viewport.scrollTop = 2_600;
  viewport.dispatchEvent(new dom.window.Event("scroll"));
  await settle();
  strictEqual(list.querySelectorAll(".author-row").length, 100);
  strictEqual(dom.window.document.activeElement?.tagName, "A");
  strictEqual(dom.window.document.activeElement === originalFocus, false);
  strictEqual((dom.window.document.activeElement as HTMLAnchorElement).href, originalFocus?.href);

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const youtube = [...(platform?.options ?? [])].find((option) => option.textContent === "YouTube");
  if (!platform || !youtube) throw new Error("YouTube filter missing");
  platform.value = youtube.value;
  platform.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  strictEqual(list.querySelectorAll(".author-row").length, 10);
  strictEqual(list.querySelectorAll("a.author-name").length, 0);
  strictEqual(list.querySelectorAll("span.author-name").length, 10);
});

test("PLATFORM-001/PROFILE-002/AC-090/AC-091 platform filtering and storage refresh preserve >200 virtualization focus", async () => {
  const large: TestBlacklistState = {
    tags: TEST_STATE.tags,
    authors: [
      ...Array.from({ length: 230 }, (_, index) => ({
        ...TEST_STATE.authors[0]!,
        userId: `virtual/zhihu ${index}`,
        authorName: `Virtual ${String(index).padStart(3, "0")}`,
        blacklistedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      })),
      {
        ...TEST_STATE.authors[0]!,
        platformId: "youtube",
        userId: "virtual-youtube",
        memberHashId: null,
        authorName: "Virtual YouTube",
      },
    ],
  };
  const refreshed: TestBlacklistState = {
    tags: large.tags.map((tag) => ({ ...tag })),
    authors: large.authors.map((author) => ({ ...author })),
  };
  const dom = fixture();
  const viewport = dom.window.document.querySelector<HTMLElement>("#author-viewport");
  if (!viewport) throw new Error("viewport missing");
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 640 });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get() {
      const list = dom.window.document.querySelector<HTMLElement>("#author-list");
      return Number.parseFloat(list?.style.height || "0");
    },
  });
  const rpc = new RpcQueue();
  rpc.pushState(large);
  rpc.pushState(refreshed);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();

  const platform = dom.window.document.querySelector<HTMLSelectElement>("#platform-filter");
  const zhihuOption = [...(platform?.options ?? [])].find(
    (option) => option.textContent === "知乎",
  );
  if (!platform || !zhihuOption) throw new Error("Zhihu filter missing");
  platform.value = zhihuOption.value;
  platform.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await settle();
  const list = dom.window.document.querySelector<HTMLElement>("#author-list");
  if (!list) throw new Error("list missing");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(list.querySelectorAll(".author-row").length < 50, true);
  const focused = list.querySelectorAll<HTMLAnchorElement>("a.author-name").item(3);
  focused.focus();

  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(platform.selectedOptions[0]?.textContent, "知乎");
  strictEqual(list.classList.contains("virtual-list"), true);
  strictEqual(dom.window.document.activeElement?.tagName, "A");
  strictEqual(dom.window.document.activeElement === focused, false);
  strictEqual((dom.window.document.activeElement as HTMLAnchorElement).href, focused.href);
  strictEqual(list.querySelectorAll("span.author-name").length, 0);
});

test("MANAGE-004/AC-089 strict merge pipeline guards pending work and reloads bounded queries", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingFinalize =
    deferred<Awaited<ReturnType<BlacklistTransferRpcClient["finalizeImport"]>>>();
  const transfer = createImportTransferRpc({
    finalize: async () => pendingFinalize.promise,
  });
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  let readFile: File | null = null;
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc: transfer.rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText(file) {
      readFile = file;
      return JSON.stringify(TRANSFER);
    },
  });
  await settle();

  const file = new dom.window.File([JSON.stringify(TRANSFER)], "backup.json", {
    type: "application/json",
  }) as unknown as File;
  selectImportFile(dom, file);
  await settle();
  strictEqual(readFile, file);
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已校验 2 位作者和 2 个标签；单个导入文件上限为 32 MiB。",
  );
  strictEqual(
    dom.window.document.querySelector<HTMLInputElement>("input[name='import-mode'][value='merge']")
      ?.checked,
    true,
  );
  const importButton = dom.window.document.querySelector<HTMLButtonElement>("#import-data");
  if (!importButton) throw new Error("import button missing");
  importButton.click();
  importButton.click();
  await settle();
  strictEqual(transfer.calls.filter((call) => call.startsWith("finalize:")).length, 1);
  strictEqual(transfer.calls.at(-1), `finalize:${TRANSFER_SESSION_ID}:merge`);
  strictEqual(
    dom.window.document.querySelector("#transfer-panel")?.getAttribute("aria-busy"),
    "true",
  );
  strictEqual(importButton.disabled, true);
  strictEqual(dom.window.document.querySelector<HTMLInputElement>("#import-file")?.disabled, true);
  strictEqual(
    dom.window.document.querySelector<HTMLFieldSetElement>("#import-mode")?.disabled,
    true,
  );

  pendingFinalize.resolve(
    createBlacklistTransferResponse("import-finalize", true, {
      revision: 2,
      authorCount: TRANSFER.authors.length,
      tagCount: TRANSFER.tags.length,
    }),
  );
  await settle();
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "合并完成；文件包含 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");
  strictEqual(importButton.disabled, true);
  strictEqual(rpc.queryRequests.length, 8);
  strictEqual(rpc.requestCounts.size, 0);
});

test("MANAGE-004/AC-089 strict replace confirms exact counts once and restores focus", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const transfer = createImportTransferRpc();
  rpc.pushState(TEST_STATE);
  rpc.pushState(TEST_STATE);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc: transfer.rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText() {
      return JSON.stringify(TRANSFER);
    },
  });
  await settle();
  selectImportFile(
    dom,
    new dom.window.File([JSON.stringify(TRANSFER)], "replace.json") as unknown as File,
  );
  await settle();

  const merge = dom.window.document.querySelector<HTMLInputElement>(
    "input[name='import-mode'][value='merge']",
  );
  const replace = dom.window.document.querySelector<HTMLInputElement>(
    "input[name='import-mode'][value='replace']",
  );
  const importButton = dom.window.document.querySelector<HTMLButtonElement>("#import-data");
  const dialog = dom.window.document.querySelector<HTMLDialogElement>("#replace-dialog");
  const cancel = dom.window.document.querySelector<HTMLButtonElement>("#replace-cancel");
  const confirm = dom.window.document.querySelector<HTMLButtonElement>("#replace-confirm");
  if (!merge || !replace || !importButton || !dialog || !cancel || !confirm) {
    throw new Error("replace controls missing");
  }
  merge.checked = false;
  replace.checked = true;
  importButton.focus();
  importButton.click();
  strictEqual(dialog.open, true);
  strictEqual(
    dom.window.document.querySelector("#replace-dialog-description")?.textContent,
    "将用文件中的 2 位作者和 2 个标签替换当前列表。现有设置会保留。",
  );
  strictEqual(dom.window.document.activeElement, cancel);
  deepStrictEqual(transfer.calls, []);

  cancel.click();
  strictEqual(dialog.open, false);
  strictEqual(dom.window.document.activeElement, importButton);
  deepStrictEqual(transfer.calls, []);

  importButton.click();
  confirm.click();
  confirm.click();
  await settle();
  strictEqual(
    transfer.calls.filter((call) => call === `finalize:${TRANSFER_SESSION_ID}:replace`).length,
    1,
  );
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已替换为 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");
  strictEqual(rpc.queryRequests.length, 8);
});

test("MANAGE-004/AC-089 accepts exact 32 MiB files and rejects over-limit or unreadable files before RPC", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const transfer = createImportTransferRpc();
  rpc.pushState(TEST_STATE);
  let reads = 0;
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc: transfer.rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    async readFileText(file) {
      reads += 1;
      if (file.name === "unreadable.json") throw new Error("read failed");
      return file.name === "boundary.json" ? JSON.stringify(TRANSFER) : '{"product":"unknown"}';
    },
  });
  await settle();

  const boundary = new dom.window.File(["{}"], "boundary.json") as unknown as File;
  Object.defineProperty(boundary, "size", {
    configurable: true,
    value: BLACKLIST_TRANSFER_FILE_BYTES,
  });
  selectImportFile(dom, boundary);
  await settle();
  strictEqual(reads, 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已校验 2 位作者和 2 个标签；单个导入文件上限为 32 MiB。",
  );
  strictEqual(
    dom.window.document.querySelector<HTMLButtonElement>("#import-data")?.disabled,
    false,
  );

  const oversized = new dom.window.File(["{}"], "oversized.json") as unknown as File;
  Object.defineProperty(oversized, "size", {
    configurable: true,
    value: BLACKLIST_TRANSFER_FILE_BYTES + 1,
  });
  selectImportFile(dom, oversized);
  await settle();
  strictEqual(reads, 1);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "导入文件超过 32 MiB 单文件上限；这不代表本地数据总容量。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-error");

  selectImportFile(dom, new dom.window.File(["{}"], "invalid.json") as unknown as File);
  await settle();
  strictEqual(reads, 2);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "导入文件无效或格式不受支持。",
  );
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "未选择可导入的数据。",
  );

  selectImportFile(dom, new dom.window.File(["{}"], "unreadable.json") as unknown as File);
  await settle();
  strictEqual(reads, 3);
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "无法读取导入文件，请重新选择。",
  );
  strictEqual(dom.window.document.querySelector<HTMLButtonElement>("#import-data")?.disabled, true);
  deepStrictEqual(transfer.calls, []);
  strictEqual(rpc.requestCounts.size, 0);
});

interface ImportFailureCase {
  readonly error: BlacklistTransferError;
  readonly message: string;
}

const IMPORT_FAILURE_CASES: readonly ImportFailureCase[] = [
  {
    error: "transfer-conflict",
    message: "导入内容与本地标签或稳定标识冲突，未进行更改；暂存数据可重试。",
  },
  { error: "chunk-conflict", message: "导入暂存分块发生冲突，已尝试清理；请重新点击导入。" },
  {
    error: "save-failed",
    message: "导入未保存（可能是本地存储空间不足）；暂存数据保留，可重试。",
  },
  { error: "session-expired", message: "导入暂存已失效；文件仍已校验，可重新点击导入。" },
  { error: "session-not-found", message: "导入暂存已失效；文件仍已校验，可重新点击导入。" },
  { error: "incomplete-import", message: "导入分块尚未完整暂存；文件仍已校验，可重试。" },
  { error: "storage-unreadable", message: "本地数据无法读取，Cocoon 未进行修改。" },
];

interface ImportFailureAssertionOptions {
  readonly dom: JSDOM;
  readonly rpc: RpcQueue;
  readonly transferCalls: readonly string[];
  readonly importButton: HTMLButtonElement;
  readonly failureCase: ImportFailureCase;
}

function assertImportFailure(options: ImportFailureAssertionOptions): void {
  const { dom, rpc, transferCalls, importButton, failureCase } = options;
  strictEqual(elementText(dom.window.document, "#transfer-error"), failureCase.message);
  strictEqual(
    requiredTestElement<HTMLElement>(dom.window.document, "#transfer-error").hidden,
    false,
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-error");
  strictEqual(elementText(dom.window.document, "#transfer-status"), "未导入数据。");
  const unreadable = failureCase.error === "storage-unreadable";
  strictEqual(elementText(dom.window.document, "#author-total"), unreadable ? "—" : "1");
  strictEqual(importButton.disabled, unreadable);
  if (failureCase.error === "chunk-conflict") {
    strictEqual(transferCalls.at(-1), `abort:${TRANSFER_SESSION_ID}`);
    strictEqual(importButton.textContent, "导入");
  } else if (!unreadable) {
    strictEqual(importButton.textContent, "重试导入");
  }
  strictEqual(rpc.queryRequests.length, 4);
  strictEqual(rpc.requestCounts.size, 0);
}

for (const failureCase of IMPORT_FAILURE_CASES) {
  test(`MANAGE-004/AC-089 strict import ${failureCase.error} maps errors without false success`, async () => {
    const dom = fixture();
    const rpc = new RpcQueue();
    const transfer = createImportTransferRpc({
      failure: failureCase.error,
      failDuringChunk: failureCase.error === "chunk-conflict",
    });
    rpc.pushState(TEST_STATE);
    bootstrapOptions({
      document: dom.window.document,
      rpc,
      transferRpc: transfer.rpc,
      storageChanges: { addListener() {} },
      requestFrame(callback) {
        callback();
        return 1;
      },
      async readFileText() {
        return JSON.stringify(TRANSFER);
      },
    });
    await settle();
    selectImportFile(
      dom,
      new dom.window.File([JSON.stringify(TRANSFER)], "failure.json") as unknown as File,
    );
    await settle();
    const importButton = requiredTestElement<HTMLButtonElement>(
      dom.window.document,
      "#import-data",
    );
    importButton.click();
    await settle();
    assertImportFailure({
      dom,
      rpc,
      transferCalls: transfer.calls,
      importButton,
      failureCase,
    });
  });
}

type ExportBeginResponse = Awaited<ReturnType<BlacklistTransferRpcClient["beginExport"]>>;

function successfulExportBegin(): ExportBeginResponse {
  return createBlacklistTransferResponse("export-begin", true, {
    product: TRANSFER.product,
    formatVersion: TRANSFER.formatVersion,
    exportedAt: TRANSFER.exportedAt,
    schemaVersion: TRANSFER.schemaVersion,
    revision: 2,
    authorCount: TRANSFER.authors.length,
    tagCount: TRANSFER.tags.length,
  });
}

function sequencedExportRpc(firstBegin: Promise<ExportBeginResponse>) {
  const calls: string[] = [];
  let exportRun = 0;
  const rpc: BlacklistTransferRpcClient = {
    ...unusedTransferRpc(),
    async beginExport() {
      exportRun += 1;
      calls.push("begin");
      return exportRun === 1 ? firstBegin : successfulExportBegin();
    },
    async exportAuthorsPage() {
      calls.push("authors");
      return createBlacklistTransferResponse("export-authors-page", true, {
        revision: 2,
        items: TRANSFER.authors,
        nextCursor: null,
      });
    },
    async exportTagsPage() {
      calls.push("tags");
      return createBlacklistTransferResponse("export-tags-page", true, {
        revision: 2,
        items: TRANSFER.tags,
        nextCursor: null,
      });
    },
    async finishExport(revision) {
      calls.push(`finish:${revision}`);
      return exportRun === 1
        ? createBlacklistTransferResponse("export-finish", true, { revision })
        : createBlacklistTransferResponse("export-finish", false, null, "stale-export");
    },
  };
  return { calls, rpc };
}

function boundaryExportRpc(extraBytes: number) {
  const shell = JSON.stringify({
    product: TRANSFER.product,
    formatVersion: TRANSFER.formatVersion,
    exportedAt: "",
    schemaVersion: TRANSFER.schemaVersion,
    authors: [],
    tags: TRANSFER.tags,
  });
  const exportedAt = "x".repeat(
    BLACKLIST_TRANSFER_FILE_BYTES - blacklistTransferTextBytes(shell) + extraBytes,
  );
  let finishCalls = 0;
  const rpc: BlacklistTransferRpcClient = {
    ...unusedTransferRpc(),
    async beginExport() {
      return createBlacklistTransferResponse("export-begin", true, {
        product: TRANSFER.product,
        formatVersion: TRANSFER.formatVersion,
        exportedAt,
        schemaVersion: TRANSFER.schemaVersion,
        revision: 9,
        authorCount: 0,
        tagCount: TRANSFER.tags.length,
      });
    },
    async exportAuthorsPage() {
      return createBlacklistTransferResponse("export-authors-page", true, {
        revision: 9,
        items: [],
        nextCursor: null,
      });
    },
    async exportTagsPage() {
      return createBlacklistTransferResponse("export-tags-page", true, {
        revision: 9,
        items: TRANSFER.tags,
        nextCursor: null,
      });
    },
    async finishExport(revision) {
      finishCalls += 1;
      return createBlacklistTransferResponse("export-finish", true, { revision });
    },
  };
  return { rpc, finishCalls: () => finishCalls };
}

test("BUG-016 export permits exact 32 MiB UTF-8 and rejects one byte over", async () => {
  const exact = boundaryExportRpc(0);
  const result = await runBlacklistExport({ client: exact.rpc });
  strictEqual(new Blob([...result.parts]).size, BLACKLIST_TRANSFER_FILE_BYTES);
  strictEqual(exact.finishCalls(), 1);

  const oversized = boundaryExportRpc(1);
  await rejects(
    runBlacklistExport({ client: oversized.rpc }),
    (error: unknown) =>
      error instanceof OptionsTransferPipelineError && error.code === "transfer-too-large",
  );
  strictEqual(oversized.finishCalls(), 0);
});

test("BUG-016 oversized export never reaches the download boundary", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const oversized = boundaryExportRpc(1);
  let downloads = 0;
  rpc.pushState(TEST_STATE);
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc: oversized.rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    downloadJson() {
      downloads += 1;
    },
  });
  await settle();
  requiredTestElement<HTMLButtonElement>(dom.window.document, "#export-data").click();
  await settle();
  strictEqual(downloads, 0);
  strictEqual(
    elementText(dom.window.document, "#transfer-error"),
    "导出数据超过 32 MiB 单文件上限，未下载文件。",
  );
});

test("MANAGE-004/AC-089 strict export downloads exact Blob parts and rejects stale output", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const pendingBegin = deferred<ExportBeginResponse>();
  const transfer = sequencedExportRpc(pendingBegin.promise);
  rpc.pushState(TEST_STATE);
  const downloads: Array<{ parts: readonly BlobPart[]; filename: string }> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc: transfer.rpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    downloadJson(parts, filename) {
      downloads.push({ parts, filename });
    },
  });
  await settle();

  const exportButton = requiredTestElement<HTMLButtonElement>(dom.window.document, "#export-data");
  exportButton.click();
  exportButton.click();
  strictEqual(transfer.calls.filter((call) => call === "begin").length, 1);
  strictEqual(exportButton.disabled, true);
  strictEqual(dom.window.document.querySelector<HTMLInputElement>("#import-file")?.disabled, true);
  strictEqual(
    dom.window.document.querySelector("#transfer-panel")?.getAttribute("aria-busy"),
    "true",
  );
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "正在准备导出…");

  pendingBegin.resolve(successfulExportBegin());
  await settle();
  strictEqual(downloads.length, 1);
  deepStrictEqual(JSON.parse(await new Blob([...downloads[0]!.parts]).text()), TRANSFER);
  strictEqual(downloads[0]!.filename, "cocoon-blacklist-2026-08-22.json");
  strictEqual(
    dom.window.document.querySelector("#transfer-status")?.textContent,
    "已导出 2 位作者和 2 个标签。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-status");

  exportButton.click();
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "正在准备导出…");
  await settle();
  strictEqual(downloads.length, 1);
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "未导出数据。");
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "导出期间本地数据发生变化，未下载不一致文件；请重试。",
  );
  strictEqual(dom.window.document.activeElement?.id, "transfer-error");
  strictEqual(rpc.requestCounts.size, 0);
});

test("MANAGE-004/AC-089 strict export storage failure enters read-only without download", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  const transferRpc: BlacklistTransferRpcClient = {
    ...unusedTransferRpc(),
    async beginExport() {
      return createBlacklistTransferResponse("export-begin", false, null, "storage-unreadable");
    },
  };
  rpc.pushState(TEST_STATE);
  let downloads = 0;
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    transferRpc,
    storageChanges: { addListener() {} },
    requestFrame(callback) {
      callback();
      return 1;
    },
    downloadJson() {
      downloads += 1;
    },
  });
  await settle();
  dom.window.document.querySelector<HTMLButtonElement>("#export-data")?.click();
  await settle();

  strictEqual(downloads, 0);
  strictEqual(dom.window.document.querySelector("#transfer-status")?.textContent, "未导出数据。");
  strictEqual(
    dom.window.document.querySelector("#transfer-error")?.textContent,
    "本地数据无法读取，未下载文件。",
  );
  strictEqual(dom.window.document.querySelector("#author-total")?.textContent, "—");
  strictEqual(dom.window.document.querySelector<HTMLButtonElement>("#export-data")?.disabled, true);
});

test("MANAGE production storage listener performs a later validated refresh before re-enabling writes", async () => {
  const dom = fixture();
  const rpc = new RpcQueue();
  rpc.pushState(null);
  rpc.pushState(TEST_STATE);
  const listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
  bootstrapOptions({
    document: dom.window.document,
    rpc,
    storageChanges: { addListener: (listener) => listeners.push(listener) },
    requestFrame(callback) {
      callback();
      return 1;
    },
  });
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 0);
  listeners[0]?.({ cocoonBlacklistRevision: { newValue: { version: 1, revision: 1 } } }, "local");
  await settle();
  strictEqual(dom.window.document.querySelectorAll("#author-list button").length, 1);
  strictEqual(
    (dom.window.document.querySelector("#author-list button") as HTMLButtonElement).disabled,
    false,
  );
});
