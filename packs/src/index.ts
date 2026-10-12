import { agentsPack } from "./packs/agents";
import { businessPack } from "./packs/business";
import { designPack } from "./packs/design";
import { desktopPack } from "./packs/desktop";
import { goPack } from "./packs/go";
import { hostingPack } from "./packs/hosting";
import { mobilePack } from "./packs/mobile";
import { nodePack } from "./packs/node";
import { observabilityPack } from "./packs/observability";
import { platformsPack } from "./packs/platforms";
import { processPack } from "./packs/process";
import { productPack } from "./packs/product";
import { qualityPack } from "./packs/quality";
import { reactPack } from "./packs/react";
import type { Pack } from "./types";

export * from "./contradictions";
export * from "./engine";
export * from "./fixtures";
export * from "./types";

export const name = "@matrix/packs";

/** Order matters: later packs can depend on answers from earlier ones. */
export const defaultPacks: Pack[] = [
  businessPack,
  productPack,
  platformsPack,
  // Backend first: frontend and mobile recommendations depend on it (tRPC vs OpenAPI).
  nodePack,
  goPack,
  reactPack,
  mobilePack,
  desktopPack,
  hostingPack,
  observabilityPack,
  qualityPack,
  processPack,
  agentsPack,
  designPack,
];
