import type { SitePlugin } from "../../core/plugin/contract.ts";
import descriptor from "./plugin.json";
import "./plugin.css";
import { mountZhihuPlugin } from "./runtime.ts";

const plugin: SitePlugin = {
  descriptor,
  capabilities: {
    cardFiltering: true,
    commentFiltering: true,
    hoverEntry: true,
    remoteAccountBlock: true,
    audienceVoterExpansion: true,
    interceptionBadge: true,
  },
  mount(context) {
    mountZhihuPlugin(context);
  },
};

export default plugin;
