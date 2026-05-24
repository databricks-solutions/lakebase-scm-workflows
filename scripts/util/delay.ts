/** Promise-based sleep — replaces shell `sleep` in poll loops. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
