import { Link } from "@tanstack/react-router";

import { AssistantLayout } from "./AssistantLayout.tsx";
import { Logo } from "./Logo.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

type SessionGateProps = {
  readonly isPending: boolean;
  readonly hasSession: boolean;
  readonly onSignOut: () => void;
};

/** Pure rendering decision for the authenticated shell: pending shows loading, no session renders nothing (no flash before the /login redirect), else the shell with nav, the assistant toggle and `<Outlet/>`. */
export const SessionGate = ({ isPending, hasSession, onSignOut }: SessionGateProps) => {
  if (isPending) return <main className="grid min-h-dvh place-items-center">Loading…</main>;
  if (!hasSession) return null;

  return (
    <AssistantLayout
      start={
        <>
          <Logo />
          <nav className="mr-auto flex gap-4">
            <Link to="/" className="text-muted no-underline hover:text-ink">
              Dashboard
            </Link>
            <Link to="/holdings" className="text-muted no-underline hover:text-ink">
              Holdings
            </Link>
            <Link to="/reconcile" className="text-muted no-underline hover:text-ink">
              Reconcile
            </Link>
            <Link to="/cash" className="text-muted no-underline hover:text-ink">
              Cash
            </Link>
            <Link to="/spending" className="text-muted no-underline hover:text-ink">
              Spending
            </Link>
            <Link to="/rebalance" className="text-muted no-underline hover:text-ink">
              Rebalance
            </Link>
            <Link to="/forecast" className="text-muted no-underline hover:text-ink">
              Forecast
            </Link>
            <Link to="/tax" className="text-muted no-underline hover:text-ink">
              Tax
            </Link>
            <Link to="/imports" className="text-muted no-underline hover:text-ink">
              Imports
            </Link>
          </nav>
        </>
      }
      end={
        <>
          <ThemeToggle />
          <button type="button" onClick={onSignOut}>
            Sign out
          </button>
        </>
      }
    />
  );
};
