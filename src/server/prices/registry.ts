import type { PriceSourceId } from "../../core/types.ts";
import { MANUAL, NORDNET_FUND, OP_FUND } from "./funds.ts";
import type { PriceSource } from "./types.ts";
import { YAHOO } from "./yahoo.ts";

const SOURCES = {
  yahoo: YAHOO,
  nordnet_fund: NORDNET_FUND,
  op_fund: OP_FUND,
  // ponytail: Task 4 replaces this placeholder with the page source.
  page: MANUAL,
  manual: MANUAL,
} satisfies Record<PriceSourceId, PriceSource>;

export const sourceFor = (id: PriceSourceId): PriceSource => SOURCES[id];
