export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { ensureUsageSyncScheduler },
    { ensureQuotaOperationWorker },
    { ensureQuotaReconciliationScheduler },
  ] = await Promise.all([
    import("@/lib/usage-sync"),
    import("@/lib/quota-saga"),
    import("@/lib/quota-reconciliation-worker"),
  ]);
  await ensureUsageSyncScheduler();
  ensureQuotaOperationWorker();
  ensureQuotaReconciliationScheduler();
}
