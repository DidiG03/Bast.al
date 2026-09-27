import { SignInForm } from "../../../components/sign-in-form";
import { ThemeToggle } from "../../../components/theme-toggle";

export default function SignInPage() {
  return (
    <main className="auth-page">
      <div className="auth-toolbar">
        <ThemeToggle />
      </div>
      <div className="auth-brand">
        <span className="sidebar-logo" aria-hidden="true">B</span>
        <span className="brand">Bast.al</span>
      </div>
      <p className="muted auth-intro">
        Sign in with your provisioned account. Public registration is disabled.
      </p>
      <SignInForm />
    </main>
  );
}
