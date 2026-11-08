import { NORDNET, OP_WEB_PASTE } from "../fixtures/broker-mappings.ts";
import type { BrokerRecord } from "./broker-record.ts";
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

const OP_LINE = String.raw`[^\n]+`;

/**
 * OP's web transaction view as it copies: one value per line, a header that
 * wraps over nine or ten lines, and a blank line between transactions. A fee
 * line is present or absent. `Yhteensä` is
 * unsigned and every figure carries a unit label, stripped as money.
 */
export const OP_PASTE_RECIPE: BrokerRecord = {
  kind: "broker-record",
  skip: [
    String.raw`^(?:Laji|Tapahtuma|Tapahtuma-|päivämäärä|Määrä|Kurssi|Kulut / Korot /|Verot|Yhteensä|Toiminnot)$`,
  ],
  recordStart: null,
  // A corporate action prints no money lines at all, so the price, the
  // optional fee and the total come together or not at all.
  record:
    String.raw`(?<instrumentName>${OP_LINE})\n(?<type>${OP_LINE})\n(?<tradeDate>\d{2}\.\d{2}\.\d{4})\n` +
    String.raw`(?<quantity>${OP_LINE})(?:\n(?<unitPrice>${OP_LINE})(?:\n(?<fee>${OP_LINE}))?\n(?<amount>${OP_LINE}))?`,
  dateFormat: "dd.mm.yyyy",
  money: {
    decimal: ",",
    thousands: " ",
    negative: "leading",
    strip: ["kpl", "EUR"],
    twoColumn: false,
  },
  unsignedAmount: true,
  types: [
    ...Object.entries(OP_WEB_PASTE.typeMap).map(([label, type]) => ({
      label,
      // SAFETY: OP_WEB_PASTE's typeMap only names transaction types the recipe allows.
      type: type as BrokerRecord["types"][number]["type"],
      reason: null,
      sign: OP_WEB_PASTE.amountSign?.[label] ?? 1,
    })),
    ...Object.entries(OP_WEB_PASTE.ignoredTypes ?? {}).map(([label, reason]) => ({
      label,
      type: "IGNORE" as const,
      reason,
      sign: null,
    })),
  ],
};
