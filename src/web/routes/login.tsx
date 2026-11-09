import { useNavigate } from "@tanstack/react-router";
import { getSetupState } from "../server/setup.ts";
import { useEffect, useState } from "react";
import { FirstRunForm } from "./first-run-form.tsx";
import { SignInForm } from "./sign-in-form.tsx";

type Status = "checking" | "needs-setup" | "ready";

/** `/login`: shows `FirstRunForm` while no user exists, else `SignInForm`. A UX choice only; the server (setup.ts) refuses a second account. A failed status check falls back to sign-in, since an existing instance is far likelier. */
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
    return <main className="grid min-h-dvh place-items-center">Loading…</main>;
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
