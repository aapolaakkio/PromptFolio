import { colourFor } from "./palette";
import { eur } from "../lib/format";

/**
 * Matches `GET /api/allocation`'s actual JSON shape (`src/server/api/portfolio.ts`):
 * `key` (a stable id -- kind code, currency code, account id or instrument id),
 * `label` (the Finnish display name) and `valueEur` (a decimal string, never `value`).
 */
export type AllocationSlice = {
  key: string;
  label: string;
  valueEur: string;
  weight: number;
};

/**
 * A stacked proportion bar plus a legend. Deliberately not a pie: with 3-8 holdings
 * a bar compares lengths, which people read far more accurately than angles.
 */
export const AllocationChart = ({ slices }: { slices: AllocationSlice[] }) => {
  if (slices.length === 0) return <p className="text-muted">Ei omistuksia.</p>;

  return (
    <div>
      <div className="flex h-3.5 overflow-hidden rounded-full">
        {slices.map((slice, index) => (
          <div
            key={slice.key}
            title={`${slice.label} ${(slice.weight * 100).toFixed(1)} %`}
            // width and colour are data-driven, so these two stay inline
            style={{ width: `${slice.weight * 100}%`, background: colourFor(index) }}
          />
        ))}
      </div>
      <ul className="mt-4 grid list-none gap-1.5 p-0">
        {slices.map((slice, index) => (
          <li key={slice.key} className="flex items-center gap-2.5">
            <span
              className="size-2.5 flex-none rounded-sm"
              style={{ background: colourFor(index) }}
            />
            <span className="flex-1">{slice.label}</span>
            <span className="num">{eur(slice.valueEur)}</span>
            <span className="num w-18 text-muted">{(slice.weight * 100).toFixed(1)} %</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
