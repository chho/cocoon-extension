import type { DrawerController, TagSelection } from "../../content/drawer-controller.ts";
import { runAfterRemotePreferencesReady } from "../../content/remote-preference-controller.ts";

export function createDrawerSubmitter(
  ready: Promise<void>,
  getController: () => Pick<DrawerController<HTMLElement, HTMLButtonElement>, "submit">,
): (selection: TagSelection, event?: MouseEvent) => Promise<void> {
  return async (selection, event) => {
    // Keyboard/programmatic clicks carry no trustworthy pointer position.
    const point = event && event.detail > 0 ? { x: event.clientX, y: event.clientY } : undefined;
    await runAfterRemotePreferencesReady(ready, () => getController().submit(selection, point));
  };
}
