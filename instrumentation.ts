export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureUsageSyncScheduler } = await import("@/lib/usage-sync");
  await ensureUsageSyncScheduler();
}
