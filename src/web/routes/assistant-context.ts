import { createContext, useContext, useEffect, type Dispatch } from "react";

import type { PanelAction, PanelState } from "./assistant-state.ts";

/** What a page has chosen, as ids only; the server looks up the names. */
export type Selection = {
  readonly accountId?: number | undefined;
  readonly instrumentId?: number | undefined;
};

export const AssistantContext = createContext<{
  readonly state: PanelState;
  readonly dispatch: Dispatch<PanelAction>;
} | null>(null);

/** A page outside the shell (a test) has nowhere to publish to, so the default drops it. */
export const SelectionContext = createContext<(selection: Selection | undefined) => void>(
  () => undefined,
);

/** The shell's assistant state, for the full Chat page that shares its conversation. */
export const useAssistant = () => {
  const assistant = useContext(AssistantContext);
  if (assistant === null) throw new Error("useAssistant needs the authenticated shell");
  return assistant;
};

/** Tells the assistant what this page has chosen; cleared when the page goes away. */
export const usePublishSelection = ({ accountId, instrumentId }: Selection): void => {
  const publish = useContext(SelectionContext);
  useEffect(() => {
    if (accountId === undefined && instrumentId === undefined) return;
    publish({ accountId, instrumentId });
    return () => publish(undefined);
  }, [publish, accountId, instrumentId]);
};
