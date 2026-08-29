import { Link, Outlet } from "@tanstack/react-router";

export type SessionGateProps = {
  readonly isPending: boolean;
  readonly hasSession: boolean;
  readonly onSignOut: () => void;
};

/**
 * Pure, fully presentational rendering decision for the authenticated
 * shell -- props in, JSX out, no hooks, no imports of `../lib/auth-client`
 * at all (the caller supplies `onSignOut`). Deliberately split out of
 * `root.tsx` (which calls the real `useSession()` hook -- a network-backed
 * call this project has no way to stub without touching `bunfig.toml`'s
 * test network guard) so `session-gate.test.ts` can render this component
 * directly with `react-dom/server`'s `renderToStaticMarkup` -- no DOM, no
 * network, no real session -- and assert that the two states a
 * signed-out visitor can ever see contain no trace of the authenticated
 * chrome (nav links, sign-out button) or of `<Outlet/>`'s protected page
 * content:
 *
 *  - pending (`isPending: true`): still resolving the session cookie --
 *    loading text only.
 *  - resolved, no session (`isPending: false, hasSession: false`): the
 *    caller's redirect effect is about to send the visitor to /login --
 *    renders nothing at all, not even a placeholder, so there is no
 *    flash of the dashboard while that navigation is in flight.
 *  - resolved, has a session: the real nav + `<Outlet/>` page content.
 *    (This branch needs a router context to render `<Outlet/>`/`<Link/>`
 *    -- session-gate.test.ts wraps it in a minimal in-memory router.)
 */
export const SessionGate = ({ isPending, hasSession, onSignOut }: SessionGateProps) => {
  if (isPending) return <main className="grid min-h-dvh place-items-center">Ladataan…</main>;
  if (!hasSession) return null;

  return (
    <>
      <header className="flex items-center gap-6 border-b border-line bg-surface px-5 py-3">
        <span className="font-semibold tracking-tight">PromptFolio</span>
        <nav className="mr-auto flex gap-4">
          <Link to="/" className="text-muted no-underline hover:text-ink">
            Yleiskuva
          </Link>
          <Link to="/holdings" className="text-muted no-underline hover:text-ink">
            Omistukset
          </Link>
          <Link to="/reconcile" className="text-muted no-underline hover:text-ink">
            Täsmäytys
          </Link>
          <Link to="/cash" className="text-muted no-underline hover:text-ink">
            Käteinen
          </Link>
          <Link to="/spending" className="text-muted no-underline hover:text-ink">
            Kulutus
          </Link>
          <Link to="/tax" className="text-muted no-underline hover:text-ink">
            Verot
          </Link>
          <Link to="/chat" className="text-muted no-underline hover:text-ink">
            Avustaja
          </Link>
          <Link to="/imports" className="text-muted no-underline hover:text-ink">
            Tuonnit
          </Link>
        </nav>
        <button type="button" onClick={onSignOut}>
          Kirjaudu ulos
        </button>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-16 pt-8">
        <Outlet />
      </main>
    </>
  );
};
