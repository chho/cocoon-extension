import {
  MAX_BLACKLIST_MUTATION_IDENTITIES,
  type BlacklistAuthorIdentityDto,
} from "../core/blacklist-rpc-contract.ts";

interface OptionsSelectionController {
  has(key: string): boolean;
  change(key: string, identity: BlacklistAuthorIdentityDto, selected: boolean): boolean;
  clear(): void;
  values(): readonly BlacklistAuthorIdentityDto[];
  setWritesEnabled(enabled: boolean): void;
}

export function createOptionsSelectionController(options: {
  readonly action: HTMLButtonElement;
  readonly onLimitReached: (limit: number) => void;
}): OptionsSelectionController {
  const selected = new Map<string, BlacklistAuthorIdentityDto>();
  let writesEnabled = false;
  const render = () => {
    options.action.textContent = `解除所选（${selected.size}）`;
    options.action.disabled = !writesEnabled || selected.size === 0;
  };
  render();
  return {
    has: (key) => selected.has(key),
    change(key, identity, isSelected) {
      if (!isSelected) selected.delete(key);
      else if (selected.size >= MAX_BLACKLIST_MUTATION_IDENTITIES) {
        options.onLimitReached(MAX_BLACKLIST_MUTATION_IDENTITIES);
        return false;
      } else selected.set(key, identity);
      render();
      return true;
    },
    clear() {
      selected.clear();
      render();
    },
    values: () => [...selected.values()],
    setWritesEnabled(enabled) {
      writesEnabled = enabled;
      render();
    },
  };
}
