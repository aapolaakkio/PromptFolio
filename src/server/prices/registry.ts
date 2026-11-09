import type { PriceSourceId } from "../../core/types.ts";
import { MANUAL } from "./manual.ts";
import type { PriceSource } from "./types.ts";
import { YAHOO } from "./yahoo.ts";

// ponytail: a page needs the db and a model client, so refreshPage runs it, never this.
const PAGE: PriceSource = {
  id: "page",
  async fetch(): Promise<never> {
    throw new Error("käytä refreshPage");
  },
};

const SOURCES = {
  yahoo: YAHOO,
  page: PAGE,
  manual: MANUAL,
} satisfies Record<PriceSourceId, PriceSource>;

export const sourceFor = (id: PriceSourceId): PriceSource => SOURCES[id];
