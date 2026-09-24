export function LoadingSpinner({ label = "Loading", size = "medium" }: { label?: string; size?: "small" | "medium" }) {
  return (
    <span className={`loading-spinner loading-spinner-${size}`} role="status" aria-label={label}>
      <span className="loading-spinner-ring" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
