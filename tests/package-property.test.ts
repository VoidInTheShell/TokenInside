import assert from "node:assert/strict";
import test from "node:test";
import { planGrantAllocations, remainingGrantQuota } from "../lib/package-model.ts";
import type { UserPackageGrant } from "../lib/package-types.ts";

const SEEDS = Array.from({ length: 20 }, (_, index) => 0x6d2b79f5 ^ (index * 0x9e3779b1));
const STEPS_PER_SEED = 10_000;

function randomFor(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeGrant(id: string, quota: number, expiryOrder: number): UserPackageGrant {
  const startsAt = new Date(Date.UTC(2026, 0, 1) + (expiryOrder % 17) * 1_000).toISOString();
  const expiresAt = new Date(Date.UTC(2027, 0, 1) + expiryOrder * 60_000).toISOString();
  return {
    id,
    userId: "property-user",
    departmentIdAtGrant: "property-department",
    packageDefinitionId: "property-definition",
    packageVersionId: "property-version",
    snapshot: {
      packageCode: "property",
      packageName: "Property Package",
      packageDescription: "",
      version: 1,
      grantedQuota: quota,
      cycleType: "fixed_days",
      cycleValue: 7,
      timezone: "Asia/Hong_Kong",
      eligibilityPolicy: { allowFirstRequest: true },
      regrantPolicy: { mode: "exhausted" },
    },
    grantedQuota: quota,
    allocatedQuota: 0,
    startsAt,
    expiresAt,
    status: "active",
    sourceRequestId: `request-${id}`,
    budgetCommitmentId: `commitment-${id}`,
    createdByUserId: "property-admin",
    createdAt: startsAt,
  };
}

function referenceAllocation(grants: UserPackageGrant[], requested: number) {
  let remaining = requested;
  const result: Array<{ grantId: string; quota: number }> = [];
  const ordered = grants
    .filter((grant) => grant.status === "active" && grant.allocatedQuota < grant.grantedQuota)
    .sort((left, right) =>
      left.expiresAt.localeCompare(right.expiresAt) ||
      left.startsAt.localeCompare(right.startsAt) ||
      left.id.localeCompare(right.id),
    );
  for (const grant of ordered) {
    if (remaining === 0) break;
    const quota = Math.min(grant.grantedQuota - grant.allocatedQuota, remaining);
    if (quota > 0) result.push({ grantId: grant.id, quota });
    remaining -= quota;
  }
  assert.equal(remaining, 0);
  return result;
}

test("20 fixed seeds preserve grant allocation invariants over 200,000 state transitions", () => {
  for (const seed of SEEDS) {
    const random = randomFor(seed);
    const grants: UserPackageGrant[] = [];
    let sequence = 0;
    let consumed = 0;
    let archivedAllocated = 0;
    for (let step = 0; step < STEPS_PER_SEED; step += 1) {
      if (grants.length >= 64) {
        const retiredIndex = grants.findIndex((grant) => grant.status !== "active");
        if (retiredIndex >= 0) {
          archivedAllocated += grants[retiredIndex].allocatedQuota;
          grants.splice(retiredIndex, 1);
        }
      }
      const active = grants.filter((grant) => grant.status === "active");
      const available = active.reduce((sum, grant) => sum + remainingGrantQuota(grant), 0);
      const action = Math.floor(random() * 100);
      if (grants.length === 0 || (action < 34 && grants.length < 64)) {
        sequence += 1;
        grants.push(makeGrant(`seed-${seed}-grant-${sequence}`, 1 + Math.floor(random() * 10_000), Math.floor(random() * 2_000)));
      } else if (action < 74 && available > 0) {
        const requested = 1 + Math.floor(random() * Math.min(available, 2_000));
        const expected = referenceAllocation(grants, requested);
        const actual = planGrantAllocations(grants, requested);
        assert.deepEqual(actual, expected, `allocation drift at seed=${seed} step=${step}`);
        for (const allocation of actual) {
          const target = grants.find((grant) => grant.id === allocation.grantId);
          assert.ok(target);
          target.allocatedQuota += allocation.quota;
          if (target.allocatedQuota === target.grantedQuota) target.status = "exhausted";
        }
        consumed += requested;
      } else if (active.length > 0) {
        const target = active[Math.floor(random() * active.length)];
        target.status = action % 2 === 0 ? "expired" : "revoked";
      }
      const allocated = archivedAllocated + grants.reduce((sum, grant) => sum + grant.allocatedQuota, 0);
      assert.equal(allocated, consumed, `consumption drift at seed=${seed} step=${step}`);
      for (const grant of grants) {
        assert.ok(grant.allocatedQuota >= 0);
        assert.ok(grant.allocatedQuota <= grant.grantedQuota);
      }
    }
  }
});
