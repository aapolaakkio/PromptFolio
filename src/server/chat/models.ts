// No imports: the chat page reads this list for its picker. All support tool calling, which the runner depends on.
export const CHAT_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

export type ChatModel = (typeof CHAT_MODEL_IDS)[number];

export const DEFAULT_CHAT_MODEL: ChatModel = "claude-opus-5-5";

const LABELS = {
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-sonnet-5-5": "Claude Sonnet 5.5",
  "claude-haiku-5-5": "Claude Haiku 5.5",
} satisfies Record<ChatModel, string>;

export const CHAT_MODELS = CHAT_MODEL_IDS.map((id) => ({ id, label: LABELS[id] }));
