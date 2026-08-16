import type { RemoteAuthorization } from "./drawer-controller.ts";
import type {
  RemotePreferenceKey,
  RemotePreferences,
} from "./remote-preferences.ts";

export interface RemoteOptionsView {
  readonly element: HTMLElement;
  renderPreferences(preferences: RemotePreferences): void;
  setVoterAvailable(available: boolean): void;
  getAuthorization(voterAvailable: boolean): RemoteAuthorization;
}

export function createRemoteOptionsView(
  document: Document,
  onPreferenceChange: (key: RemotePreferenceKey, value: boolean) => void,
): RemoteOptionsView {
  const section = document.createElement("section");
  section.className = "cocoon-remote-options";
  section.setAttribute("aria-label", "知乎远程操作");

  function createOption(
    id: string,
    text: string,
  ): { readonly label: HTMLLabelElement; readonly input: HTMLInputElement } {
    const label = document.createElement("label");
    label.className = "cocoon-remote-option";
    const input = document.createElement("input");
    input.id = id;
    input.className = "cocoon-remote-option-input";
    input.type = "checkbox";
    const labelText = document.createElement("span");
    labelText.textContent = text;
    label.append(input, labelText);
    return { label, input };
  }

  const authorOption = createOption(
    "cocoon-block-author-on-zhihu",
    "同时在知乎拉黑该作者",
  );
  const voterOption = createOption(
    "cocoon-block-content-voters",
    "拉黑该内容的点赞者",
  );
  section.append(authorOption.label, voterOption.label);

  for (const [key, input] of [
    ["blockAuthorOnZhihu", authorOption.input],
    ["blockContentVoters", voterOption.input],
  ] as const) {
    input.addEventListener("change", () => {
      onPreferenceChange(key, input.checked);
    });
  }

  return {
    element: section,
    renderPreferences(preferences) {
      authorOption.input.checked = preferences.blockAuthorOnZhihu;
      voterOption.input.checked = preferences.blockContentVoters;
    },
    setVoterAvailable(available) {
      voterOption.input.disabled = !available;
      voterOption.label.classList.toggle(
        "cocoon-remote-option-disabled",
        !available,
      );
    },
    getAuthorization(voterAvailable) {
      return {
        blockAuthorOnZhihu: authorOption.input.checked,
        blockContentVoters:
          voterAvailable &&
          !voterOption.input.disabled &&
          voterOption.input.checked,
      };
    },
  };
}
