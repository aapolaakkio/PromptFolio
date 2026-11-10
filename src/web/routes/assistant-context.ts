import { createContext, useContext, useEffect, type Dispatch } from "react";

import type { PanelAction, PanelState } from "./assistant-state.ts";

/**
 * What a page has chosen, as ids only; the server looks up the names. Account only: Holdings' forms
 * are modal dialogs, which make the panel inert while they are open, so an instrument chosen there
 * could never be asked about.
 */
export type Selection = { readonly accountId: number };

export type Assistant = {
  readonly state: PanelState;
  readonly dispatch: Dispatch<PanelAction>;
  /** One turn at a time across the dock and the Chat page, which share the conversation. */
  readonly turnRunning: boolean;
  readonly setTurnRunning: (running: boolean) => void;
};

export const AssistantContext = createContext<Assistant | null>(null);

/** A page outside the shell (a test) has nowhere to publish to, so the default drops it. */
export const SelectionContext = createContext<(selection: Selection | undefined) => void>(
  () => undefined,
);

/** The shell's assistant state, shared by the dock and the full Chat page. */
export const useAssistant = (): Assistant => {
  const assistant = useContext(AssistantContext);
  if (assistant === null) throw new Error("useAssistant needs the authenticated shell");
  return assistant;
};

/** Tells the assistant which account this page has chosen; cleared when the page goes away. */
export const usePublishSelection = (accountId: number | null): void => {
  const publish = useContext(SelectionContext);
  useEffect(() => {
    if (accountId === null) return;
    publish({ accountId });
    return () => publish(undefined);
  }, [publish, accountId]);
};
