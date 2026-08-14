import type { CoordinatedBlockResult } from "./remote-block-coordinator.ts";
import type { VoterBatchProgress } from "./voter-batch-controller.ts";

export interface RemoteProgressSession {
  updateAuthor(result: CoordinatedBlockResult | "running"): void;
  updateVoters(progress: VoterBatchProgress): void;
}

function authorStatusText(
  result: CoordinatedBlockResult | "running",
): string {
  if (result === "running") {
    return "作者：处理中";
  }
  switch (result.status) {
    case "success":
      return "作者：成功";
    case "skipped":
      return "作者：已跳过";
    case "stopped":
      return "作者：已停止";
    case "failed":
      return "作者：失败";
  }
}

export function formatVoterProgress(progress: VoterBatchProgress): string {
  const completeness =
    progress.phase === "preparing" || progress.phase === "fetching"
      ? "获取中"
      : progress.dataComplete
        ? "完整"
        : "部分";
  return `点赞者：已获取 ${progress.fetched} · 成功 ${progress.success} · 失败 ${progress.failed} · 跳过 ${progress.skipped} · 未处理 ${progress.unprocessed} · ${completeness}`;
}

export function createRemoteProgressSession(
  document: Document,
  options: {
    readonly showAuthor: boolean;
    readonly showVoters: boolean;
    readonly stop: () => void;
  },
): RemoteProgressSession {
  let container = document.querySelector<HTMLElement>(
    ".cocoon-remote-progress-container",
  );
  if (!container) {
    container = document.createElement("div");
    container.className = "cocoon-remote-progress-container";
    document.body.append(container);
  }

  const panel = document.createElement("section");
  panel.className = "cocoon-remote-progress";
  panel.setAttribute("aria-label", "Cocoon 知乎操作进度");
  const header = document.createElement("div");
  header.className = "cocoon-remote-progress-header";
  const title = document.createElement("strong");
  title.textContent = "知乎操作";
  const stopButton = document.createElement("button");
  stopButton.type = "button";
  stopButton.className = "cocoon-remote-progress-stop";
  stopButton.textContent = "停止";
  stopButton.hidden = !options.showVoters;
  let stopRequested = false;
  stopButton.addEventListener("click", () => {
    if (stopRequested) {
      return;
    }
    stopRequested = true;
    options.stop();
    stopButton.disabled = true;
    stopButton.textContent = "停止中";
  });
  header.append(title, stopButton);

  const body = document.createElement("div");
  body.className = "cocoon-remote-progress-body";
  body.setAttribute("aria-live", "polite");
  const localLine = document.createElement("div");
  localLine.className = "cocoon-remote-progress-local";
  localLine.textContent = "本地屏蔽：成功";
  const authorLine = document.createElement("div");
  authorLine.className = "cocoon-remote-progress-author";
  authorLine.hidden = !options.showAuthor;
  const voterLine = document.createElement("div");
  voterLine.className = "cocoon-remote-progress-voters";
  voterLine.hidden = !options.showVoters;
  body.append(localLine, authorLine, voterLine);
  panel.append(header, body);
  container.append(panel);

  function finishVoters(progress: VoterBatchProgress): void {
    if (
      progress.phase === "complete" ||
      progress.phase === "failed" ||
      progress.phase === "stopped"
    ) {
      stopButton.hidden = true;
    }
  }

  return {
    updateAuthor(result) {
      authorLine.textContent = authorStatusText(result);
    },
    updateVoters(progress) {
      voterLine.textContent = formatVoterProgress(progress);
      finishVoters(progress);
    },
  };
}
