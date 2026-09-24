import { SignInForm } from "../../../components/sign-in-form";
import { ThemeToggle } from "../../../components/theme-toggle";

export default function SignInPage() {
  return (
    <main className="stack" style={{ alignItems: "center", paddingTop: "4rem" }}>
      <div className="brand">Bast.al</div>
      <p className="muted" style={{ marginTop: 0 }}>
        Sign in with your provisioned account. Public registration is disabled.
      </p>
      <ThemeToggle />
      <SignInForm />
    </main>
  );
}
