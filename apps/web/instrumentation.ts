/** Next.js runs this once when the server starts: turns on server-side error reporting. */
export async function register() {
  const { initSentry } = await import("./lib/sentry");
  initSentry("server");
}
