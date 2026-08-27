import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { signOut, useSession } from "../lib/auth-client";

/**
 * Session gate for the whole app: every route under this layout requires a
 * signed-in session. `useSession` starts `isPending`, so the redirect only
 * fires once Better Auth has actually resolved the cookie -- an
 * unauthenticated visitor never sees a flash of the dashboard before being
 * sent to /login.
 */
export const RootLayout = () => {
  const { data: session, isPending } = useSession();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isPending && !session) void navigate({ to: "/login" });
  }, [isPending, session, navigate]);

  if (isPending) return <main className="grid min-h-dvh place-items-center">Ladataan…</main>;
  if (!session) return null;

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
          <Link to="/imports" className="text-muted no-underline hover:text-ink">
            Tuonnit
          </Link>
        </nav>
        <button type="button" onClick={() => void signOut()}>
          Kirjaudu ulos
        </button>
      </header>
      <main className="mx-auto max-w-5xl px-5 pb-16 pt-8">
        <Outlet />
      </main>
    </>
  );
};
