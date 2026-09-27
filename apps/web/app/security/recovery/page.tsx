import { SignIn } from "@clerk/nextjs";

export default function RecoveryPage() {
  return (
    <main className="auth-page">
      <div className="auth-brand">
        <span className="sidebar-logo" aria-hidden="true">B</span>
        <span className="brand">Bast.al</span>
      </div>
      <div className="card stack auth-card">
        <h1 style={{ margin: 0 }}>Password recovery</h1>
        <p className="muted">Use the secure Clerk recovery flow to reset your password.</p>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </main>
  );
}
