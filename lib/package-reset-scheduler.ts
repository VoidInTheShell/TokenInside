import {
  buildMonthlyPeriodOpenPlan,
  enqueuePackageResetPlan,
} from "@/lib/billing";
import { latestDuePackageReset } from "@/lib/package-reset";
import { isPostgresAdvisoryLockBusyError } from "@/lib/postgres-store";
import {
  getAppSettings,
  preparePackageResetPeriod,
  withPackageResetSchedulerFence,
} from "@/lib/store";

const schedulerIdlePollMs = 60_000;
const schedulerBlockedPollMs = 5 * 60_000;
const schedulerCompletionRecheckMs = 60 * 60_000;

type PackageResetSchedulerResult =
  | { status: "disabled" | "busy" }
  | { status: "completed" | "cached"; period: string }
  | { status: "blocked"; period: string; blockers: number }
  | { status: "enqueued"; period: string; operations: number };

type PackageResetSchedulerRuntime = {
  started: boolean;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  lastCompletedPeriod?: string;
  completedRecheckAfter?: number;
};

type PackageResetSchedulerGlobal = typeof globalThis & {
  __tokenInsidePackageResetSchedulerV1?: PackageResetSchedulerRuntime;
};

const runtimeGlobal = globalThis as PackageResetSchedulerGlobal;
const schedulerRuntime =
  runtimeGlobal.__tokenInsidePackageResetSchedulerV1 ??=
    { started: false, running: false };

export async function runPackageResetSchedulerOnce(
  now = new Date(),
): Promise<PackageResetSchedulerResult> {
  const settings = await getAppSettings();
  const due = latestDuePackageReset(settings.packageReset, now);
  if (!due) return { status: "disabled" };
  if (
    schedulerRuntime.lastCompletedPeriod === due.period &&
    (schedulerRuntime.completedRecheckAfter ?? 0) > now.getTime()
  ) {
    return { status: "cached", period: due.period };
  }

  try {
    return await withPackageResetSchedulerFence(async () => {
      const currentSettings = await getAppSettings();
      const currentDue = latestDuePackageReset(currentSettings.packageReset, now);
      if (!currentDue) return { status: "disabled" };

      await preparePackageResetPeriod(currentDue.period);
      const plan = await buildMonthlyPeriodOpenPlan({ period: currentDue.period });
      if (plan.blocked) {
        return {
          status: "blocked",
          period: currentDue.period,
          blockers: plan.blockers.length,
        };
      }

      const userCount =
        plan.departments.reduce((sum, department) => sum + department.users.length, 0) +
        plan.unscoped.users.length;
      if (userCount === 0) {
        schedulerRuntime.lastCompletedPeriod = currentDue.period;
        schedulerRuntime.completedRecheckAfter =
          now.getTime() + schedulerCompletionRecheckMs;
        return { status: "completed", period: currentDue.period };
      }

      const operations = await enqueuePackageResetPlan({ plan });
      return {
        status: "enqueued",
        period: currentDue.period,
        operations: operations.length,
      };
    });
  } catch (error) {
    if (isPostgresAdvisoryLockBusyError(error)) return { status: "busy" };
    throw error;
  }
}

function schedulePackageResetTick(delayMs: number) {
  if (schedulerRuntime.timer) clearTimeout(schedulerRuntime.timer);
  schedulerRuntime.timer = setTimeout(async () => {
    schedulerRuntime.timer = undefined;
    if (schedulerRuntime.running) {
      schedulePackageResetTick(schedulerIdlePollMs);
      return;
    }

    schedulerRuntime.running = true;
    let nextDelay = schedulerIdlePollMs;
    try {
      const result = await runPackageResetSchedulerOnce();
      if (result.status === "blocked") {
        nextDelay = schedulerBlockedPollMs;
        console.warn(
          JSON.stringify({
            event: "tokeninside.package_reset.blocked",
            period: result.period,
            blockers: result.blockers,
          }),
        );
      }
    } catch {
      nextDelay = schedulerBlockedPollMs;
      console.error(
        JSON.stringify({
          event: "tokeninside.package_reset.scheduler_failed",
          reason: "execution_failed",
        }),
      );
    } finally {
      schedulerRuntime.running = false;
      schedulePackageResetTick(nextDelay);
    }
  }, Math.max(delayMs, 25));
  schedulerRuntime.timer.unref?.();
}

export function notifyPackageResetScheduler() {
  schedulerRuntime.lastCompletedPeriod = undefined;
  schedulerRuntime.completedRecheckAfter = undefined;
  if (!schedulerRuntime.started) schedulerRuntime.started = true;
  schedulePackageResetTick(25);
}

export function ensurePackageResetScheduler() {
  if (schedulerRuntime.started) return;
  schedulerRuntime.started = true;
  schedulePackageResetTick(1_000);
}
