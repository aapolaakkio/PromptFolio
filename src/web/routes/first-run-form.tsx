import { type SubmitEvent, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { createFirstAccount } from "../server/setup.ts";
import { signIn } from "../lib/auth-client.ts";

type FirstRunFormProps = {
  /** Called after the account is created AND the resulting sign-in succeeds. */
  readonly onCreated: () => void;
  /** Called when the server refuses because an account already exists (likely a race); the parent shows sign-in. */
  readonly onAlreadySetUp: () => void;
};

/** First-run account creation, shown by `login.tsx` while no user exists. The server enforces "one account, ever"; signs the owner in via `signIn.email` afterwards. */
export const FirstRunForm = ({ onCreated, onAlreadySetUp }: FirstRunFormProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (password !== passwordConfirm) {
      setError("Passwords do not match");
      return;
    }

    setBusy(true);
    try {
      await createFirstAccount({ data: { name, email, password } });
    } catch (cause) {
      setBusy(false);
      const message = errorMessage(cause, "Could not create the account");
      // Not an error to show: somebody else claimed the instance first, so give way to sign-in.
      if (message.includes("already been created")) {
        onAlreadySetUp();
        return;
      }
      setError(message);
      return;
    }

    const { error: signInFailure } = await signIn.email({ email, password });
    setBusy(false);
    if (signInFailure) {
      // The account exists but the immediate sign-in failed; say so rather than the generic error.
      setError("The account was created, but automatic sign-in failed. Please sign in.");
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
          Welcome. This form creates the app's first and only account, for yourself — accounts for
          family members are added separately.
        </p>
        <label>
          Name
          <input
            type="text"
            value={name}
            autoComplete="name"
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
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
            autoComplete="new-password"
            required
            minLength={8}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label>
          Confirm password
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
          {busy ? "Creating…" : "Create account"}
        </button>
      </form>
    </main>
  );
};
