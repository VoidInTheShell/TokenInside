import assert from "node:assert/strict";
import test from "node:test";
import { selectInitialApprovalDepartmentId } from "../lib/approval-routing.ts";

test("known TokenInside department wins over missing or stale contact data", () => {
  assert.equal(
    selectInitialApprovalDepartmentId(" od-known ", []),
    "od-known",
  );
  assert.equal(
    selectInitialApprovalDepartmentId("od-known", ["od-stale"]),
    "od-known",
  );
});

test("contact department is used only when TokenInside has no known department", () => {
  assert.equal(
    selectInitialApprovalDepartmentId(undefined, ["", " od-contact "]),
    "od-contact",
  );
  assert.equal(selectInitialApprovalDepartmentId(undefined, []), undefined);
  assert.equal(
    selectInitialApprovalDepartmentId("system-admin-fallback", ["od-contact"]),
    "od-contact",
  );
});
