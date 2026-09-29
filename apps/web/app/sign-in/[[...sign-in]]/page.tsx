import { NamedIcon, type IconName } from "../../../components/icons";
import { SignInForm } from "../../../components/sign-in-form";
import { ThemeToggle } from "../../../components/theme-toggle";

const POINTS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: "users", title: "Your team only", text: "Everyone sees the accounts under them, nothing else." },
  { icon: "commissions", title: "Settled every week", text: "Profit, commission and what each person owes, worked out for you." },
  { icon: "audit", title: "Every change on record", text: "Balance moves and settings changes land in the audit log." },
];

export default function SignInPage() {
  return (
    <main className="role-admin auth-page auth-split">
      <section className="auth-form-side">
        <header className="auth-top">
          <div className="auth-brand">
            <span className="sidebar-logo" aria-hidden="true">B</span>
            <span className="brand">Bast.al</span>
          </div>
          <ThemeToggle />
        </header>
        <div className="auth-form-body">
          <SignInForm />
        </div>
        <p className="auth-footnote">There is no public sign-up. Your Manager, Owner or Super Admin creates your account.</p>
      </section>
      <aside className="auth-aside" aria-hidden="true">
        <div className="auth-aside-inner">
          <p className="auth-aside-lead">The back office for your betting team.</p>
          <ul className="auth-points">
            {POINTS.map((point) => (
              <li key={point.title}>
                <span className="auth-point-icon">
                  <NamedIcon name={point.icon} />
                </span>
                <div>
                  <strong>{point.title}</strong>
                  <span>{point.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
