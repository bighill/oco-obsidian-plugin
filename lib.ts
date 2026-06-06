// Pure helpers with NO `obsidian` import — safe to unit-test with node:test.
// Anything that touches App/TFile/DOM stays in main.ts; logic that's easy to
// get subtly wrong lives here so it can be tested in isolation.

/** Safely extract a string from an unknown value (avoids [object Object] coercion). */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
