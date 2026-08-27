import type { PriceSourceId } from "../../core/types";
import { DANSKE_FUND, MANUAL, NORDNET_FUND, OP_FUND, SPANKKI_FUND } from "./funds";
import type { PriceSource } from "./types";
import { YAHOO } from "./yahoo";

const SOURCES = {
  yahoo: YAHOO,
  nordnet_fund: NORDNET_FUND,
  op_fund: OP_FUND,
  spankki_fund: SPANKKI_FUND,
  danske_fund: DANSKE_FUND,
  manual: MANUAL,
} satisfies Record<PriceSourceId, PriceSource>;

export const sourceFor = (id: PriceSourceId): PriceSource => SOURCES[id];
