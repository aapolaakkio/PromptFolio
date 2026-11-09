import { createAuthClient } from "better-auth/react";

/** No `baseURL`: better-auth falls back to the relative "/api/auth" (SPA and API share an origin), and stays importable under Vitest, which has no `window`. */
const authClient = createAuthClient();
export const { signIn, signOut } = authClient;
