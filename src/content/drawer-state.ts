export type DrawerState =
  | { readonly status: "closed" }
  | {
      readonly status: "open";
      readonly targetId: string;
      readonly draft: string;
    };

export type DrawerEvent =
  | { readonly type: "open"; readonly targetId: string }
  | { readonly type: "draft"; readonly value: string }
  | { readonly type: "close" };

export const CLOSED_DRAWER_STATE: DrawerState = { status: "closed" };

export function reduceDrawerState(
  state: DrawerState,
  event: DrawerEvent,
): DrawerState {
  switch (event.type) {
    case "open":
      return { status: "open", targetId: event.targetId, draft: "" };
    case "draft":
      return state.status === "open"
        ? { ...state, draft: event.value }
        : state;
    case "close":
      return CLOSED_DRAWER_STATE;
  }
}
