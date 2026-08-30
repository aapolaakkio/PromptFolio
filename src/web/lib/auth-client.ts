import { createAuthClient } from "better-auth/react";

/**
 * No `baseURL` passed: better-auth's `getBaseURL` (dist/utils/url.mjs)
 * falls back to the relative path "/api/auth" whenever no explicit URL,
 * env var, or request is available, which is exactly this app's
 * deployment model -- the SPA and the API are always the same origin
 * (the server serves both from src/server/index.ts), so a relative path
 * works and is proxy/port-agnostic in a way a hardcoded
 * `window.location.origin` is not.
 *
 * This also matters for testability: `getBaseURL` only reads
 * `window.location` behind an explicit `typeof window !== "undefined"`
 * guard (never at module scope), so this file -- unlike a version that
 * passed `baseURL: window.location.origin` itself -- is safely importable
 * under Vitest, which has no `window` global. Every other
 * browser-only access in better-auth's react client (focus/online/storage
 * listeners) is behind the same guard, checked directly against the
 * installed package source.
 */
export const authClient = createAuthClient();
export const { signIn, signOut, useSession } = authClient;
