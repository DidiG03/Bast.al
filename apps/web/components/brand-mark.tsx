/** The Shtatat.al mark: the same drawing as the favicon (app/icon.svg), sized by its .sidebar-logo box. */
export function BrandMark() {
  return (
    <span className="sidebar-logo brand-mark" aria-hidden="true">
      <svg viewBox="0 0 120 120" width="100%" height="100%">
        <rect width="120" height="120" rx="28" fill="#D6FF3F" />
        <polygon points="30,28 90,28 90,42 62,94 43,94 70,44 30,44" fill="#031208" />
      </svg>
    </span>
  );
}
