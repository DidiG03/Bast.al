## 2024-09-24 - Missing Error Text Class

**Learning:** Found an accessibility and visual issue where components were using a class `.error-text` to display inline error messages, but this class did not exist in the global CSS (only `.error` and `.error-toast` did). This resulted in error text showing up as regular text, reducing usability and making it harder for users to identify validation failures.
**Action:** Add `.error-text` alongside `.error` in global CSS when working with existing inline error patterns to ensure consistent warning colors.
