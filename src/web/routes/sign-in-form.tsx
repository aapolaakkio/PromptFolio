import { useNavigate } from "@tanstack/react-router";
import { type SubmitEvent, useState } from "react";
import { signIn } from "../lib/auth-client.ts";

/** The sign-in form, extracted so `login.tsx` stays a thin orchestrator. */
export const SignInForm = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await signIn.email({ email, password });
    setBusy(false);
    // Deliberately non-specific: must not reveal whether the email address exists.
    if (failure) {
      setError("Sign-in failed");
      return;
    }
    void navigate({ to: "/" });
  };

  return (
    <main className="grid min-h-dvh place-items-center">
      <form className="card w-80" onSubmit={(event) => void submit(event)}>
        <h1>PromptFolio</h1>
        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-loss text-sm">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full">
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
};
