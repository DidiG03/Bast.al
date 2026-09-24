import { SignIn } from "@clerk/nextjs";

export default function RecoveryPage() {
  return (
    <main className="stack" style={{ alignItems: "center", paddingTop: "2rem" }}>
      <div className="brand">Bast.al</div>
      <div className="card stack" style={{ maxWidth: 480, width: "100%" }}>
        <h1 style={{ margin: 0 }}>Password recovery</h1>
        <p className="muted">Use the secure Clerk recovery flow to reset your password.</p>
        <SignIn routing="path" path="/sign-in" />
      </div>
    </main>
  );
}
