/**
 * The Claude models the assistant may run on. All do tool calling, which the
 * runner depends on; a model that did not would answer from memory, which is
 * exactly what the system prompt forbids.
 *
 * No imports: the chat page reads this list for its picker.
 */
export const CHAT_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export type ChatModel = (typeof CHAT_MODEL_IDS)[number];

export const DEFAULT_CHAT_MODEL: ChatModel = "claude-opus-5-5";

const LABELS = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
} satisfies Record<ChatModel, string>;

/** The picker's options, in the order above. */
export const CHAT_MODELS = CHAT_MODEL_IDS.map((id) => ({ id, label: LABELS[id] }));
