import assert from "node:assert/strict";
import test from "node:test";
import { Pool } from "pg";
import {
  listStaleUserAccessResumeCandidatesSql,
  markUserAccessResumeEnableAttemptSql,
  rollbackPendingUserAccessResumeSql,
} from "../lib/user-access-recovery-sql.ts";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test(
  "real PostgreSQL resume rollback is a concurrent CAS and protects completed open access",
  { skip: testDatabaseUrl ? false : "TEST_DATABASE_URL is not configured" },
  async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl, max: 4 });
    const suffix = `${process.pid}_${Date.now()}`;
    const userId = `test_access_recovery_user_${suffix}`;
    const accountId = `test_access_recovery_account_${suffix}`;
    const createdAt = "2098-01-01T00:00:00.000Z";
    const disabledAt = "2098-01-01T00:01:00.000Z";
    const cutoffAt = "2098-01-01T00:02:00.000Z";
    const user = {
      id: userId,
      tenantKey: "test",
      openId: `test_access_recovery_open_${suffix}`,
      status: "active",
      createdAt,
      updatedAt: createdAt,
    };
    const account = {
      id: accountId,
      feishuUserId: userId,
      tokenRequestId: `test_access_recovery_request_${suffix}`,
      newapiTokenId: `test_access_recovery_upstream_${suffix}`,
      keyHash: `test_access_recovery_hash_${suffix}`,
      status: "active",
      billingPeriod: "2098-01",
      operationGeneration: 7,
      createdAt,
    };
    const pendingState = {
      feishuUserId: userId,
      admission: "closed",
      activeGeneration: 7,
      closedReason: "user_access_resume_pending",
      resumeTokenAccountId: accountId,
      resumePreparedAt: createdAt,
      updatedAt: createdAt,
    };

    try {
      await pool.query(
        `insert into feishu_users
          (id, tenant_key, open_id, department_id, data, created_at, updated_at)
         values ($1, 'test', $2, null, $3, $4, $4)`,
        [userId, user.openId, user, createdAt],
      );
      await pool.query(
        `insert into token_accounts
          (id, feishu_user_id, token_request_id, newapi_token_id, key_hash,
           status, billing_period, operation_generation, data, created_at)
         values ($1, $2, $3, $4, $5, 'active', '2098-01', 7, $6, $7)`,
        [
          accountId,
          userId,
          account.tokenRequestId,
          account.newapiTokenId,
          account.keyHash,
          account,
          createdAt,
        ],
      );
      await pool.query(
        `insert into user_quota_states
          (feishu_user_id, admission, active_generation, operation_id, data, updated_at)
         values ($1, 'closed', 7, null, $2, $3)`,
        [userId, pendingState, createdAt],
      );

      const marked = await pool.query<{ data: typeof pendingState & {
        resumeUpstreamEnableAttemptedAt: string;
      } }>(markUserAccessResumeEnableAttemptSql, [
        userId,
        accountId,
        "2098-01-01T00:00:01.000Z",
      ]);
      assert.equal(marked.rowCount, 1);
      assert.equal(
        marked.rows[0].data.resumeUpstreamEnableAttemptedAt,
        "2098-01-01T00:00:01.000Z",
      );

      const staleCandidates = await pool.query<{
        user: typeof user;
        account: typeof account;
        quota_state: typeof pendingState;
      }>(listStaleUserAccessResumeCandidatesSql, [disabledAt, 25]);
      assert.equal(staleCandidates.rowCount, 1);
      assert.equal(staleCandidates.rows[0].user.id, userId);
      assert.equal(staleCandidates.rows[0].account.id, accountId);
      assert.equal(
        staleCandidates.rows[0].quota_state.resumeTokenAccountId,
        accountId,
      );

      const parameters = [
        userId,
        accountId,
        disabledAt,
        cutoffAt,
        "test fail-closed rollback",
      ];
      const concurrent = await Promise.all([
        pool.query(rollbackPendingUserAccessResumeSql, parameters),
        pool.query(rollbackPendingUserAccessResumeSql, parameters),
      ]);
      assert.deepEqual(
        concurrent.map((result) => result.rowCount).sort(),
        [0, 1],
      );
      const stored = await pool.query<{
        user: typeof user & { disabledAt?: string };
        account: typeof account & { disabledAt?: string };
        quota_state: typeof pendingState & {
          upstreamDisabledAt?: string;
          consumptionBarrierCutoffAt?: string;
        };
        account_status: string;
        admission: string;
      }>(
        `select u.data as user, a.data as account, q.data as quota_state,
                a.status as account_status, q.admission
         from feishu_users u
         join token_accounts a on a.feishu_user_id = u.id
         join user_quota_states q on q.feishu_user_id = u.id
         where u.id = $1 and a.id = $2`,
        [userId, accountId],
      );
      assert.equal(stored.rows[0].user.status, "disabled");
      assert.equal(stored.rows[0].account_status, "disabled");
      assert.equal(stored.rows[0].admission, "closed");
      assert.equal(stored.rows[0].quota_state.closedReason, "user_access_revoked");
      assert.equal(stored.rows[0].quota_state.upstreamDisabledAt, disabledAt);
      assert.equal(
        stored.rows[0].quota_state.consumptionBarrierCutoffAt,
        cutoffAt,
      );
      assert.equal("resumeTokenAccountId" in stored.rows[0].quota_state, false);
      assert.equal("resumePreparedAt" in stored.rows[0].quota_state, false);
      assert.equal(
        "resumeUpstreamEnableAttemptedAt" in stored.rows[0].quota_state,
        false,
      );

      const completedState = {
        ...pendingState,
        admission: "open",
        closedReason: undefined,
        updatedAt: disabledAt,
      };
      await pool.query(
        `update feishu_users set data = $2, updated_at = $3 where id = $1`,
        [userId, user, disabledAt],
      );
      await pool.query(
        `update token_accounts
         set status = 'active', disabled_at = null, data = $3
         where id = $1 and feishu_user_id = $2`,
        [accountId, userId, account],
      );
      await pool.query(
        `update user_quota_states
         set admission = 'open', operation_id = null, data = $2, updated_at = $3
         where feishu_user_id = $1`,
        [userId, completedState, disabledAt],
      );
      const protectedOpen = await pool.query(
        rollbackPendingUserAccessResumeSql,
        parameters,
      );
      assert.equal(protectedOpen.rowCount, 0);
      const stillOpen = await pool.query<{
        user_status: string;
        account_status: string;
        admission: string;
      }>(
        `select u.data->>'status' as user_status, a.status as account_status,
                q.admission
         from feishu_users u
         join token_accounts a on a.feishu_user_id = u.id
         join user_quota_states q on q.feishu_user_id = u.id
         where u.id = $1 and a.id = $2`,
        [userId, accountId],
      );
      assert.deepEqual(stillOpen.rows[0], {
        user_status: "active",
        account_status: "active",
        admission: "open",
      });
    } finally {
      await pool
        .query("delete from user_quota_states where feishu_user_id = $1", [userId])
        .catch(() => undefined);
      await pool
        .query("delete from token_accounts where id = $1", [accountId])
        .catch(() => undefined);
      await pool
        .query("delete from feishu_users where id = $1", [userId])
        .catch(() => undefined);
      await pool.end();
    }
  },
);
