import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateStream } from "../src/validator.js";

const loadScenario = async () =>
  JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));

test("完整场景事件流无不变量错误", async () => {
  const { events } = await loadScenario();
  assert.deepEqual(validateStream(events), []);
});

test("event_id 重复被拒绝", async () => {
  const { events } = await loadScenario();
  const dup = [...events, { ...events[0], version: 99 }];
  const errors = validateStream(dup);
  assert.ok(errors.some((e) => e.includes("event_id 重复")));
});

test("同一聚合版本必须连续递增", () => {
  const base = {
    event_type: "REFERRAL_RECEIVED",
    aggregate_type: "referral_case",
    aggregate_id: "case-v",
    occurred_at: "2026-10-05T08:00:00+08:00",
    summary: "s",
    from_org: "a",
    to_org: "b",
    specialty: "s1",
    triage_level: "routine",
    patient_ref: "p",
    actor: { id: "d1", role: "sending_doctor", org: "a" },
  };
  const errors = validateStream([
    { ...base, event_id: "v1", version: 1 },
    { ...base, event_id: "v2", version: 3, occurred_at: "2026-10-05T09:00:00+08:00" },
  ]);
  assert.ok(errors.some((e) => e.includes("版本应为 2")));
});

test("同一聚合事件时间倒退被拒绝", () => {
  const base = {
    event_type: "REFERRAL_RECEIVED",
    aggregate_type: "referral_case",
    aggregate_id: "case-t",
    summary: "s",
    from_org: "a",
    to_org: "b",
    specialty: "s1",
    triage_level: "routine",
    patient_ref: "p",
  };
  const errors = validateStream([
    { ...base, event_id: "t1", version: 1, occurred_at: "2026-10-05T09:00:00+08:00" },
    { ...base, event_id: "t2", version: 2, occurred_at: "2026-10-05T08:00:00+08:00" },
  ]);
  assert.ok(errors.some((e) => e.includes("发生时间早于前序事件")));
});

test("任务完成/升级解除/复查完成必须能追溯前序记录", () => {
  const errors = validateStream([
    {
      event_id: "tc1",
      event_type: "CARE_TASK_COMPLETED",
      aggregate_type: "care_task",
      aggregate_id: "task-x",
      occurred_at: "2026-10-05T08:00:00+08:00",
      version: 1,
      summary: "凭空完成",
      actor: { id: "n1", role: "escort_nurse" },
      task_event_id: "not-exist",
      outcome: "无",
    },
    {
      event_id: "er1",
      event_type: "CONTACT_ESCALATION_RESOLVED",
      aggregate_type: "referral_case",
      aggregate_id: "case-x",
      occurred_at: "2026-10-05T08:00:00+08:00",
      version: 1,
      summary: "凭空解除",
      actor: { id: "n1", role: "county_center_nurse" },
      escalation_id: "esc-x",
      resolution: "无",
    },
  ]);
  assert.ok(errors.some((e) => e.includes("找不到分派记录")));
  assert.ok(errors.some((e) => e.includes("未开启即解除")));
});

test("引用不存在的转诊病例被拒绝", () => {
  const errors = validateStream([
    {
      event_id: "a1",
      event_type: "ARRIVAL_CONFIRMED",
      aggregate_type: "arrival_assessment",
      aggregate_id: "arr-ghost",
      occurred_at: "2026-10-05T08:00:00+08:00",
      version: 1,
      summary: "幽灵病例到院",
      actor: { id: "n1", role: "county_center_nurse" },
      case_id: "case-ghost",
      arrived_at: "2026-10-05T08:00:00+08:00",
    },
  ]);
  assert.ok(errors.some((e) => e.includes("引用的转诊病例 case-ghost 不存在")));
});
