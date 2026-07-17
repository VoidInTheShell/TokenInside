export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { ensureUsageSyncScheduler },
    { ensureQuotaOperationWorker },
    { ensureQuotaReconciliationScheduler },
    { warmQuotaSubmitPool },
  ] = await Promise.all([
    import("@/lib/usage-sync"),
    import("@/lib/quota-saga"),
    import("@/lib/quota-reconciliation-worker"),
    import("@/lib/quota-operation-submit"),
  ]);
  // Establish the complete durable-submission lane before schedulers and live
  // traffic can turn connection creation into part of the user-visible ACK.
  await warmQuotaSubmitPool();
  await ensureUsageSyncScheduler();
  ensureQuotaOperationWorker();
  ensureQuotaReconciliationScheduler();
}
