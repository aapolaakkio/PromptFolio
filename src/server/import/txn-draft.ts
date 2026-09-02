import { z } from "zod";

import { EUR, parseCurrency, parseMoney, parseQuantity } from "../../core/money.ts";
import type { Draft, DraftTxn } from "./map.ts";
import type { TransactionsReading } from "./pdf-read.ts";

/**
 * A `Draft` as the browser sends it back after editing. Strict at every level:
 * a field the map never produced is a field the commit never expected.
 */
export const DraftBody = z
  .object({
    txns: z
      .array(
        z
          .object({
            line: z.number().int(),
            accountId: z.number().int().positive(),
            instrumentId: z.number().int().positive().nullable(),
            isin: z.string().nullable(),
            type: z.string().min(1),
            tradeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            quantity: z.number().int(),
            unitPrice: z.number().int().nullable(),
            amount: z.number().int(),
            fee: z.number().int(),
            tax: z.number().int(),
            currency: z.string().length(3).transform(parseCurrency),
            fxRateEur: z.number().int().nonnegative(),
            externalId: z.string().nullable(),
            note: z.string().nullable(),
          })
          .strict(),
      )
      .max(5000),
    problems: z.array(
      z
        .object({
          line: z.number().int(),
          message: z.string(),
          raw: z.record(z.string(), z.string()),
          rawLine: z.string().optional(),
        })
        .strict(),
    ),
    unknownIsins: z.array(
      z
        .object({
          isin: z.string().nullable(),
          name: z.string(),
          currency: z.string().length(3).transform(parseCurrency),
        })
        .strict(),
    ),
  })
  .strict();
export type DraftBody = z.infer<typeof DraftBody>;

const decimal = (text: string): string => text.replace(",", ".").replace(/\s/g, "");

/**
 * A model's reading into the draft the review screen and the commit already
 * understand. Rows that fail to parse become problems with their text, as
 * the CSV mapper does; instruments resolve by ISIN, then by name, and an
 * unresolved one is listed for the owner rather than invented.
 */
export const transactionsDraftFrom = (
  reading: TransactionsReading,
  options: {
    readonly accountId: number;
    readonly knownIsins: ReadonlyMap<string, number>;
    readonly knownNames: ReadonlyMap<string, number>;
  },
): Draft => {
  const txns: DraftTxn[] = [];
  const problems: Draft["problems"] = [];
  const unknown = new Map<string, Draft["unknownIsins"][number]>();
  const namesUpper = new Map(
    [...options.knownNames].map(([name, id]) => [name.toUpperCase(), id] as const),
  );

  reading.transactions.forEach((row, index) => {
    const line = index + 1;
    try {
      const currency = parseCurrency(row.currency.toUpperCase());
      const isin = row.isin?.trim() || null;
      const name = row.name.trim();
      const instrumentId = isin
        ? (options.knownIsins.get(isin) ?? null)
        : name !== ""
          ? (namesUpper.get(name.toUpperCase()) ?? null)
          : null;
      if (instrumentId === null && (isin !== null || name !== "")) {
        const key = isin ?? name;
        if (!unknown.has(key)) unknown.set(key, { isin, name, currency });
      }
      txns.push({
        line,
        accountId: options.accountId,
        instrumentId,
        isin,
        type: row.type,
        tradeDate: row.date,
        quantity: row.type === "DIVIDEND" ? 0 : Number(parseQuantity(decimal(row.quantity)).scaled),
        unitPrice:
          row.unitPrice === null || decimal(row.unitPrice) === "0"
            ? null
            : Number(parseMoney(decimal(row.unitPrice), currency).minor),
        amount: Number(parseMoney(decimal(row.amount), currency).minor),
        fee: Number(parseMoney(decimal(row.fee), currency).minor),
        tax: Number(parseMoney(decimal(row.tax), currency).minor),
        currency,
        fxRateEur: currency === EUR ? 100_000_000 : 0,
        externalId: null,
        note: name === "" ? null : name,
      });
    } catch (cause) {
      problems.push({
        line,
        message: cause instanceof Error ? cause.message : "Rivin käsittely epäonnistui",
        raw: {
          date: row.date,
          type: row.type,
          name: row.name,
          isin: row.isin ?? "",
          quantity: row.quantity,
          unitPrice: row.unitPrice ?? "",
          amount: row.amount,
          fee: row.fee,
          tax: row.tax,
          currency: row.currency,
        },
      });
    }
  });

  const fromReader = reading.problems.map((problem) => ({
    line: problem.line,
    message: "Mallia ei saanut riviä luettua",
    raw: {},
    rawLine: problem.text,
  }));

  return {
    txns,
    problems: [...problems, ...fromReader].sort((a, b) => a.line - b.line),
    unknownIsins: [...unknown.values()],
  };
};
