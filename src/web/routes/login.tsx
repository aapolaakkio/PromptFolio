import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { signIn } from "../lib/auth-client";

export const LoginPage = () => {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const { error: failure } = await signIn.email({ email, password });
    setBusy(false);
    // Deliberately non-specific: this message must not reveal whether the
    // email address exists, only that the credentials were not accepted.
    if (failure) {
      setError("Kirjautuminen epäonnistui");
      return;
    }
    void navigate({ to: "/" });
  };

  return (
    <main className="grid min-h-dvh place-items-center">
      <form className="card w-80" onSubmit={(event) => void submit(event)}>
        <h1>PromptFolio</h1>
        <label>
          Sähköposti
          <input
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          Salasana
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
          {busy ? "Kirjaudutaan…" : "Kirjaudu"}
        </button>
      </form>
    </main>
  );
};
