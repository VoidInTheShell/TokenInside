export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { ensureUsageSyncScheduler },
    { ensureQuotaOperationWorker },
    { ensureUserAccessRecoveryWorker },
    { warmQuotaSubmitPool },
    { ensureDepartmentMemberSyncWorker },
    { ensurePackageResetScheduler },
  ] = await Promise.all([
    import("@/lib/usage-sync"),
    import("@/lib/quota-saga"),
    import("@/lib/user-access-control"),
    import("@/lib/quota-operation-submit"),
    import("@/lib/department-member-sync"),
    import("@/lib/package-reset-scheduler"),
  ]);
  // Establish the complete durable-submission lane before schedulers and live
  // traffic can turn connection creation into part of the user-visible ACK.
  await warmQuotaSubmitPool();
  await ensureUsageSyncScheduler();
  ensureQuotaOperationWorker();
  ensureUserAccessRecoveryWorker();
  ensureDepartmentMemberSyncWorker();
  ensurePackageResetScheduler();

  // The read-only balance observer is diagnostic and must never become a
  // startup dependency. Its own scheduler also catches every run failure.
  void import("@/lib/quota-balance-observer")
    .then(({ ensureQuotaBalanceObserver }) => ensureQuotaBalanceObserver())
    .catch((error) => {
      console.error(
        JSON.stringify({
          event: "tokeninside.quota_balance_observer_start_failed",
          error: error instanceof Error ? error.message : "unknown failure",
        }),
      );
    });
}
