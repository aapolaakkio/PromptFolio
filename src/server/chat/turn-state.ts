import type { ForecastResult } from "../../core/forecast.ts";
import { MAX_CHARTS_PER_TURN } from "./chart-schema.ts";

const MAX_SCENARIOS_PER_TURN = 20;
/** Each one is a real Yahoo request; the owner's rule is to stay well inside Yahoo's limits. */
export const MAX_YAHOO_LOOKUPS_PER_TURN = 3;

export type TurnScenario = {
  readonly id: string;
  readonly holdings: readonly { readonly instrumentId: number; readonly name: string }[];
  readonly result: ForecastResult;
};

/** What one turn's tools share: scenarios exist only here, so an id is valid for this user and turn alone. */
export type TurnState = {
  readonly scenario: (id: string) => TurnScenario | undefined;
  readonly addScenario: (scenario: Omit<TurnScenario, "id">) => TurnScenario;
  /** Claims one of the turn's chart slots; throws when they are used up. */
  readonly claimChart: () => void;
  /** Claims one of the turn's Yahoo lookups; false when they are used up. */
  readonly claimYahooLookup: () => boolean;
};

export const createTurnState = (): TurnState => {
  let scenarios: ReadonlyMap<string, TurnScenario> = new Map();
  let charts = 0;
  let yahooLookups = 0;
  return {
    scenario: (id) => scenarios.get(id),
    addScenario: (scenario) => {
      if (scenarios.size >= MAX_SCENARIOS_PER_TURN) {
        throw new Error(`At most ${MAX_SCENARIOS_PER_TURN} forecasts in one answer`);
      }
      const stored = { ...scenario, id: `S${scenarios.size + 1}` };
      scenarios = new Map([...scenarios, [stored.id, stored]]);
      return stored;
    },
    claimChart: () => {
      if (charts >= MAX_CHARTS_PER_TURN) throw new Error("At most ten charts in one answer");
      charts += 1;
    },
    claimYahooLookup: () => {
      if (yahooLookups >= MAX_YAHOO_LOOKUPS_PER_TURN) return false;
      yahooLookups += 1;
      return true;
    },
  };
};
