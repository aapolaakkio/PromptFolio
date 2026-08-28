import { type FormEvent, useState } from "react";
import { signIn } from "../lib/auth-client";

export type FirstRunFormProps = {
  /** Called after the account is created AND the resulting sign-in succeeds. */
  readonly onCreated: () => void;
  /**
   * Called when the server refuses the creation because an account
   * already exists (HTTP 403 from `POST /api/setup`) -- the one outcome
   * that means this form should never have been shown, most likely
   * because someone else's request to the same endpoint won a race that
   * started before this page's own status check resolved. The parent
   * switches back to the normal sign-in form; it is still refused
   * server-side regardless of what this component renders (see
   * `src/server/api/setup.ts`'s `createFirstUser`), so nothing bad
   * happens if a caller ignores this -- it only affects what the visitor
   * sees next.
   */
  readonly onAlreadySetUp: () => void;
};

type SetupErrorBody = { error: string; fields?: ReadonlyArray<{ path: string; message: string }> };

/**
 * The instance's first-run account creation form -- shown by `login.tsx`
 * in place of the sign-in form only while `GET /api/setup` reports no
 * user exists yet. Posts to the same endpoint, which enforces "at most
 * one account, ever" server-side (see setup.ts's module comment for the
 * race reasoning); this form cannot bypass that by being reachable, only
 * by being shown -- the real guarantee lives on the server.
 *
 * After a successful creation this immediately signs the new owner in
 * with the same credentials, through the normal, already-tested
 * `signIn.email` flow, rather than trying to mint a session itself.
 */
export const FirstRunForm = ({ onCreated, onAlreadySetUp }: FirstRunFormProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== passwordConfirm) {
      setError("Salasanat eivät täsmää");
      return;
    }

    setBusy(true);
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });

    if (!response.ok) {
      setBusy(false);
      // SAFETY: handle() (src/server/http.ts) shapes every non-2xx JSON
      // body from this route as { error, fields? }.
      const body = (await response.json()) as SetupErrorBody;
      if (response.status === 403) {
        onAlreadySetUp();
        return;
      }
      const detail = body.fields?.map((f) => f.message).join(", ");
      setError(detail ? `${body.error}: ${detail}` : body.error);
      return;
    }

    const { error: signInFailure } = await signIn.email({ email, password });
    setBusy(false);
    if (signInFailure) {
      // The account now exists (the POST above succeeded), but the
      // immediate sign-in call failed for some other reason -- surface
      // that plainly rather than the generic sign-in error, since a
      // visitor who just filled this exact form typed exactly this
      // password moments ago.
      setError("Tili luotiin, mutta automaattinen kirjautuminen epäonnistui. Kirjaudu sisään.");
      onAlreadySetUp();
      return;
    }
    onCreated();
  };

  return (
    <main className="grid min-h-dvh place-items-center">
      <form className="card w-80" onSubmit={(event) => void submit(event)}>
        <h1>PromptFolio</h1>
        <p className="text-muted text-sm">
          Tervetuloa. Tällä lomakkeella luodaan sovelluksen ensimmäinen ja ainoa tili sinulle
          itsellesi — myöhemmät perheenjäsenten tilit lisätään erikseen.
        </p>
        <label>
          Nimi
          <input
            type="text"
            value={name}
            autoComplete="name"
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
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
            autoComplete="new-password"
            required
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Vahvista salasana
          <input
            type="password"
            value={passwordConfirm}
            autoComplete="new-password"
            required
            minLength={8}
            onChange={(event) => setPasswordConfirm(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-loss text-sm">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className="w-full">
          {busy ? "Luodaan…" : "Luo tili"}
        </button>
      </form>
    </main>
  );
};
