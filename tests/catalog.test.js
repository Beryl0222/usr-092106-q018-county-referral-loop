import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AGGREGATES, AGGREGATE_TYPES, EVENTS, EVENT_TYPES } from "../src/catalog.js";

test("每个事件归属的聚合必须存在", () => {
  for (const [type, spec] of Object.entries(EVENTS)) {
    assert.ok(AGGREGATE_TYPES.includes(spec.aggregate), `${type} 引用了未知聚合 ${spec.aggregate}`);
    assert.ok(spec.required.length > 0 || type === "FOLLOWUP_DUE", `${type} 应明确必需字段`);
  }
  assert.equal(Object.keys(AGGREGATES).length, AGGREGATE_TYPES.length);
});

test("JSON Schema 的事件与聚合枚举与目录保持同步", async () => {
  const schema = JSON.parse(
    await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"),
  );
  assert.deepEqual([...schema.properties.event_type.enum].sort(), [...EVENT_TYPES].sort());
  assert.deepEqual([...schema.properties.aggregate_type.enum].sort(), [...AGGREGATE_TYPES].sort());
});

test("事件类型覆盖转诊闭环各阶段", () => {
  for (const expected of [
    "REFERRAL_RECEIVED",
    "PATIENT_TRIP_RECORDED",
    "ARRIVAL_CONFIRMED",
    "RISK_ESCALATED",
    "OBSERVATION_DIVERGENCE_RECORDED",
    "GREEN_CHANNEL_PREEMPTED",
    "ESCORT_TASK_ASSIGNED",
    "ADMISSION_DECIDED",
    "RETURN_PLANNED",
    "RETURN_ACCEPTED",
    "FOLLOWUP_SCHEDULED",
    "FOLLOWUP_DUE",
    "FOLLOWUP_COMPLETED",
  ]) {
    assert.ok(EVENT_TYPES.includes(expected), `缺少闭环事件 ${expected}`);
  }
});

test("联络升级类别覆盖未到院/方言/费用/中途离开等场景", () => {
  const escalationEvent = EVENTS.CONTACT_ESCALATION_OPENED;
  for (const cat of ["no_show", "dialect", "cost_concern", "left_midway", "unreachable"]) {
    assert.ok(escalationEvent.properties.reason_category.enum.includes(cat));
  }
});
