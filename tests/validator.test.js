import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/validator.js";

test("样例符合领域约定", async () => {
  const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("信封缺字段逐项报错", () => {
  const errors = validateEvent({});
  for (const field of ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"]) {
    assert.ok(errors.includes(`缺少字段：${field}`), `应报告缺少 ${field}`);
  }
});

test("未知事件类型与错误聚合归属被拒绝", () => {
  const base = {
    event_id: "x1",
    event_type: "ARRIVAL_CONFIRMED",
    aggregate_type: "referral_case", // 应为 arrival_assessment
    aggregate_id: "a1",
    occurred_at: "2026-10-05T08:00:00+08:00",
    version: 1,
    summary: "聚合错误",
  };
  const errors = validateEvent(base);
  assert.ok(errors.some((e) => e.includes("应归属聚合 arrival_assessment")));
});

test("事件专属必需字段缺失被拒绝", () => {
  const errors = validateEvent({
    event_id: "x2",
    event_type: "RISK_ESCALATED",
    aggregate_type: "arrival_assessment",
    aggregate_id: "a2",
    occurred_at: "2026-10-05T08:00:00+08:00",
    version: 1,
    summary: "缺载荷",
  });
  assert.ok(errors.includes("RISK_ESCALATED 缺少必需字段：case_id"));
  assert.ok(errors.includes("RISK_ESCALATED 缺少必需字段：from_level"));
  assert.ok(errors.includes("RISK_ESCALATED 必须由医护人员发起（actor）"));
});

test("风险只能上调，下调改判必须另记观察分歧", () => {
  const event = {
    event_id: "x3",
    event_type: "RISK_ESCALATED",
    aggregate_type: "arrival_assessment",
    aggregate_id: "a3",
    occurred_at: "2026-10-05T08:00:00+08:00",
    version: 1,
    summary: "误把危急降回普通",
    actor: { id: "doc-1", role: "receiving_doctor" },
    case_id: "case-1",
    from_level: "critical",
    to_level: "routine",
    reason: "症状缓解",
  };
  assert.ok(validateEvent(event).some((e) => e.includes("只能上调风险等级")));
});

test("住院决定只能由接收医生发起，系统与护士不得替代", () => {
  const byNurse = {
    event_id: "x4",
    event_type: "ADMISSION_DECIDED",
    aggregate_type: "referral_case",
    aggregate_id: "case-1",
    occurred_at: "2026-10-05T08:00:00+08:00",
    version: 1,
    summary: "护士替医生开住院",
    actor: { id: "n1", role: "county_center_nurse" },
    case_id: "case-1",
    decision: "admitted",
    decided_by: "王护士",
  };
  assert.ok(validateEvent(byNurse).some((e) => e.includes("只能由 receiving_doctor 发起")));

  const bySystem = { ...byNurse, event_id: "x5", actor: { id: "sys", role: "system" } };
  assert.ok(validateEvent(bySystem).some((e) => e.includes("只能由 receiving_doctor 发起")));
});

test("绿通抢占必须说明原因并由医护发起", () => {
  const event = {
    event_id: "x6",
    event_type: "GREEN_CHANNEL_PREEMPTED",
    aggregate_type: "referral_case",
    aggregate_id: "case-1",
    occurred_at: "2026-10-05T08:00:00+08:00",
    version: 1,
    summary: "无原因抢占",
    case_id: "case-1",
    specialty: "心血管内科",
  };
  const errors = validateEvent(event);
  assert.ok(errors.includes("GREEN_CHANNEL_PREEMPTED 缺少必需字段：preempt_reason"));
  assert.ok(errors.some((e) => e.includes("必须由医护人员发起")));
});

test("枚举非法值与非带时区时间被拒绝", () => {
  const errors = validateEvent({
    event_id: "x7",
    event_type: "REFERRAL_RECEIVED",
    aggregate_type: "referral_case",
    aggregate_id: "case-1",
    occurred_at: "2026-10-05 08:00",
    version: 0,
    summary: "格式错误",
    from_org: "a",
    to_org: "b",
    specialty: "心内",
    triage_level: "emergency",
    patient_ref: "p1",
  });
  assert.ok(errors.includes("version 必须是正整数"));
  assert.ok(errors.some((e) => e.includes("occurred_at 必须是带时区")));
  assert.ok(errors.some((e) => e.includes("triage_level 取值必须是")));
});
