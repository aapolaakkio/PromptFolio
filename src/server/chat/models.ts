/**
 * The Workers AI models the assistant may run on. Every one does OpenAI-style
 * tool calling, which the runner depends on; a model that does not would
 * answer from memory, which is exactly what the system prompt forbids.
 *
 * No imports: the chat page reads this list for its picker.
 */
export const CHAT_MODEL_IDS = [
  "@cf/qwen/qwen3.8-27b",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-4-scout-17b-16e-instruct",
  "@cf/openai/gpt-oss-120b",
  "@cf/openai/gpt-oss-20b",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "@cf/google/gemma-3-12b-it",
] as const;

export type ChatModel = (typeof CHAT_MODEL_IDS)[number];

export const DEFAULT_CHAT_MODEL: ChatModel = "@cf/qwen/qwen3.8-27b";

const LABELS = {
  "@cf/qwen/qwen3.8-27b": "Qwen 3.8 27B",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen3 30B A3B",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama 3.3 70B",
  "@cf/meta/llama-4-scout-17b-16e-instruct": "Llama 4 Scout 17B",
  "@cf/openai/gpt-oss-120b": "GPT-OSS 120B",
  "@cf/openai/gpt-oss-20b": "GPT-OSS 20B",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral Small 3.1 24B",
  "@cf/google/gemma-3-12b-it": "Gemma 3 12B",
} satisfies Record<ChatModel, string>;

/** The picker's options, in the order above. */
export const CHAT_MODELS = CHAT_MODEL_IDS.map((id) => ({ id, label: LABELS[id] }));
