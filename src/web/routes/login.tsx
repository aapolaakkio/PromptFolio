import { useNavigate } from "@tanstack/react-router";
import { getSetupState } from "../server/setup.ts";
import { useEffect, useState } from "react";
import { FirstRunForm } from "./first-run-form.tsx";
import { SignInForm } from "./sign-in-form.tsx";

type Status = "checking" | "needs-setup" | "ready";

/**
 * Thin orchestrator for `/login`: asks getSetupState (safe to call
 * unauthenticated -- see setup.ts) whether the instance has any user yet,
 * and renders `FirstRunForm` instead of the normal `SignInForm` while it
 * does not. Once an account exists, `FirstRunForm` is never rendered
 * again for anyone -- and createFirstAccount refuses a second account
 * regardless of what any client renders, so this check is a UX decision,
 * not the security boundary; the boundary is server-side (setup.ts).
 *
 * On a failed status check (network hiccup, 500), this falls back to the
 * normal sign-in form rather than the creation form: showing "create your
 * account" on an instance that might already have one would just fail
 * server-side anyway, but it is confusing UX for what is, in the failure
 * case, very likely an existing instance having a bad moment -- the far
 * more common situation than a still-uninitialised one.
 */
export const LoginPage = () => {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status>("checking");

  useEffect(() => {
    let cancelled = false;
    getSetupState()
      .then((state) => {
        if (!cancelled) setStatus(state.hasUsers ? "ready" : "needs-setup");
      })
      .catch(() => {
        if (!cancelled) setStatus("ready");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === "checking") {
    return <main className="grid min-h-dvh place-items-center">Ladataan…</main>;
  }

  if (status === "needs-setup") {
    return (
      <FirstRunForm
        onCreated={() => void navigate({ to: "/" })}
        onAlreadySetUp={() => setStatus("ready")}
      />
    );
  }

  return <SignInForm />;
};
