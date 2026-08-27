import { createAuthClient } from "better-auth/react";

/**
 * `baseURL: window.location.origin` matches this app's own deployment
 * model: the SPA and the API are the same origin (Bun.serve serves both
 * from src/server/index.ts), so there is never a cross-origin auth call
 * to configure.
 */
export const authClient = createAuthClient({ baseURL: window.location.origin });
export const { signIn, signOut, useSession } = authClient;
