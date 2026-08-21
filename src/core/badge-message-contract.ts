export type BadgeResetMessage = {
  readonly version: 1;
  readonly type: "cocoon.badge.reset";
  readonly generation: string;
};

export type BadgeIncrementMessage = {
  readonly version: 1;
  readonly type: "cocoon.badge.increment";
  readonly generation: string;
  readonly delta: number;
};

export type BadgeMessage = BadgeResetMessage | BadgeIncrementMessage;

export type BadgeMessageResponse =
  | { readonly ok: true }
  | { readonly ok: false };
