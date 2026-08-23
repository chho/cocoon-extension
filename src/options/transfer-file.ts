export interface ObjectUrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

export async function readFileText(file: File): Promise<string> {
  return await file.text();
}

export function downloadJsonBlob(
  document: Document,
  objectUrls: ObjectUrlApi,
  json: string,
  filename: string,
  scheduleCleanup: (callback: () => void) => void,
): void {
  const blob = new Blob([json], { type: "application/json;charset=utf-8" });
  const url = objectUrls.createObjectURL(blob);
  let link: HTMLAnchorElement | null = null;
  let revoked = false;
  const revoke = (): void => {
    if (revoked) return;
    revoked = true;
    objectUrls.revokeObjectURL(url);
  };

  try {
    link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
  } finally {
    link?.remove();
    try {
      scheduleCleanup(revoke);
    } catch (error) {
      revoke();
      throw error;
    }
  }
}
