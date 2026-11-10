import type { AssistantPage } from "../../server/chat/page-context.ts";

/** What an empty conversation offers on each page; one click asks it. */
export const STARTERS = {
  dashboard: ["What is my portfolio worth today?", "How did my returns change this month?"],
  holdings: [
    "Which holdings are the largest share of my portfolio?",
    "What do my funds cost me in fees each year?",
  ],
  reconcile: ["Does my latest statement match the ledger?", "Which differences need my attention?"],
  cash: ["How much cash do I have across my accounts?", "What came in and went out last month?"],
  debts: [
    "How much do I spend on loans and credit each month?",
    "What is my portfolio worth before debts?",
  ],
  spending: [
    "Where did the money go last month?",
    "Which payees are still uncategorised?",
    "How has my spending changed this year?",
  ],
  rebalance: ["How far am I from my target allocation?", "Where should my next deposit go?"],
  forecast: [
    "What could my portfolio be worth in ten years?",
    "How much should I save monthly to reach my target?",
  ],
  tax: ["What are my realised gains this tax year?", "Which sales would have the lowest tax?"],
  imports: ["What did my latest import add?", "Which imports can I undo?"],
  chat: ["What is my portfolio worth today?", "Where did the money go last month?"],
} as const satisfies Record<AssistantPage, readonly string[]>;
