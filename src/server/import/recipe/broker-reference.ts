import { NORDNET } from "../brokers.ts";
import type { BrokerTable } from "./broker-table.ts";

/**
 * Nordnet's transaction export, described the way a model is asked to: the
 * hand-written reference the broker table engine is tested against, built from
 * the mapping the old Nordnet parser used so the two cannot drift apart.
 *
 * Five columns are named `Valuutta`; the two read are addressed by position.
 */
export const NORDNET_TABLE_RECIPE: BrokerTable = {
  kind: "broker-table",
  delimiter: "\t",
  columns: [
    ...Object.entries(NORDNET.columns).map(([field, header]) => ({
      // SAFETY: the keys of a FieldMapping's columns are CanonicalFields.
      field: field as BrokerTable["columns"][number]["field"],
      header,
      position: null,
    })),
    { field: "currency", header: "Valuutta", position: 15 },
    { field: "priceCurrency", header: "Valuutta", position: 19 },
  ],
  dateFormat: "yyyy-mm-dd",
  money: { decimal: ",", thousands: " ", negative: "leading", twoColumn: false },
  unsignedAmount: false,
  types: [
    ...Object.entries(NORDNET.typeMap).map(([label, type]) => ({
      label,
      // SAFETY: NORDNET's typeMap only names transaction types the recipe allows.
      type: type as BrokerTable["types"][number]["type"],
      reason: null,
      sign: null,
    })),
    ...Object.entries(NORDNET.ignoredTypes ?? {}).map(([label, reason]) => ({
      label,
      type: "IGNORE" as const,
      reason,
      sign: null,
    })),
  ],
};
