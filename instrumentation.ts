export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const [
    { ensureQuotaOperationWorker },
    { ensureUserAccessRecoveryWorker },
    { warmQuotaSubmitPool },
    { ensureDepartmentMemberSyncWorker },
    { ensurePackageResetScheduler },
  ] = await Promise.all([
    import("@/lib/quota-saga"),
    import("@/lib/user-access-control"),
    import("@/lib/quota-operation-submit"),
    import("@/lib/department-member-sync"),
    import("@/lib/package-reset-scheduler"),
  ]);
  // Establish the complete durable-submission lane before schedulers and live
  // traffic can turn connection creation into part of the user-visible ACK.
  await warmQuotaSubmitPool();
  ensureQuotaOperationWorker();
  ensureUserAccessRecoveryWorker();
  ensureDepartmentMemberSyncWorker();
  ensurePackageResetScheduler();
}
