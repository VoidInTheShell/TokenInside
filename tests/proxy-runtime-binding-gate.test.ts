import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveProxyRuntimeBinding } from "../lib/proxy-runtime-binding-gate.ts";

const proxyRoutePath = new URL("../app/v1/[...path]/route.ts", import.meta.url);

for (const failure of ["manifest_drift", "binding_database_unavailable"] as const) {
  test(`${failure} stops before an active slot or pending proxy log`, async () => {
    let activeSlots = 0;
    let pendingLogs = 0;
    const binding = await resolveProxyRuntimeBinding(async () => {
      throw new Error(failure);
    });

    if (binding.ready) {
      activeSlots += 1;
      pendingLogs += 1;
    }

    assert.equal(binding.ready, false);
    assert.equal(activeSlots, 0);
    assert.equal(pendingLogs, 0);
  });
}

test("the proxy route resolves and returns the binding gate before every admission side effect", async () => {
  const source = (await readFile(proxyRoutePath, "utf8")).replace(/\r\n/g, "\n");
  const gate = source.indexOf("const binding = await resolveProxyRuntimeBinding");
  const failureStart = source.indexOf("if (!binding.ready)", gate);
  const unavailable = source.indexOf('code: "greenfield_binding_unavailable"', gate);
  const upstreamSlot = source.indexOf("await acquireProxyConcurrencySlot", gate);
  const preparationSlot = source.indexOf("await acquireProxyPreparationSlot", gate);
  const pendingLog = source.indexOf("await beginQuotaAwareProxyRequest", gate);
  const heartbeat = source.indexOf("startProxyLeaseHeartbeat", pendingLog);

  for (const [label, index] of [
    ["binding gate", gate],
    ["binding failure branch", failureStart],
    ["binding 503", unavailable],
    ["upstream slot", upstreamSlot],
    ["preparation slot", preparationSlot],
    ["pending admission", pendingLog],
    ["heartbeat", heartbeat],
  ] as const) {
    assert.notEqual(index, -1, `missing ${label}`);
  }
  assert.ok(gate < unavailable);
  assert.ok(unavailable < upstreamSlot);
  assert.ok(unavailable < preparationSlot);
  assert.ok(unavailable < pendingLog);
  assert.ok(unavailable < heartbeat);

  const failureBranch = source.slice(failureStart, upstreamSlot);
  assert.match(failureBranch, /return buildProxyErrorResponse\(/);
  assert.match(failureBranch, /status: 503/);
});
