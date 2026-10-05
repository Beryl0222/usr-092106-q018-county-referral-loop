import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildBoard } from "../src/board.js";

const NOW = "2026-10-05T08:30:00+08:00";

const loadScenario = async () =>
  JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));

test("早班看板六清单与联络升级区符合场景", async () => {
  const { events, board_now } = await loadScenario();
  const board = buildBoard(events, { now: board_now });

  assert.deepEqual(board.counts, {
    risk_upgraded: 1,
    late: 2,
    expected: 2,
    exam_conflicts: 1,
    pending_return: 1,
    followup_due: 1,
    contact_escalations: 3,
  });

  const ids = (lane) => board.lanes[lane].map((i) => i.case_id);
  assert.deepEqual(ids("risk_upgraded"), ["case-C08"]); // 原单胃炎、现场疑夹层
  assert.deepEqual(ids("late"), ["case-C04", "case-C07"]); // 未到院 + 中途离开
  assert.deepEqual(ids("expected"), ["case-C02", "case-C03"]); // 改约后今日到 + 归并后原单
  assert.deepEqual(ids("exam_conflicts"), ["case-C08"]); // C01 冲突已由任务完成核销
  assert.deepEqual(ids("pending_return"), ["case-C09"]);
  assert.deepEqual(ids("followup_due"), ["case-C01"]);
  assert.deepEqual(
    board.contact_escalations.map((i) => `${i.case_id}:${i.escalation.reason_category}`),
    ["case-C10:unreachable", "case-C05:dialect", "case-C06:cost_concern"],
  );
});

test("每条看板记录都带可直接执行的下一步与责任方", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });

  const dialect = board.contact_escalations.find((i) => i.case_id === "case-C05");
  assert.ok(dialect.next_step.next_action.includes("三方通话"));
  assert.equal(dialect.next_step.owner_role, "escort_nurse");
  assert.ok(dialect.next_step.contact_phone);

  const conflict = board.lanes.exam_conflicts[0];
  assert.equal(conflict.next_step.owner_role, "escort_nurse");
  assert.ok(conflict.next_step.next_action.includes("肌酐"));

  const lost = board.lanes.late.find((i) => i.case_id === "case-C04");
  assert.equal(lost.escalation.reason_category, "no_show");
  assert.ok(lost.next_step.next_action.includes("店下镇卫生院"));
});

test("观察分歧病例保留危急呈现，且标记 divergence", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });
  const he = board.lanes.risk_upgraded.find((i) => i.case_id === "case-C08");
  assert.equal(he.triage_level, "critical");
  assert.equal(he.divergence, true);
  assert.ok(he.observation_reason.includes("主动脉夹层"));
});

test("任务分派不核销冲突，完成才核销", () => {
  const mkCase = (id) => ({
    event_id: `ref-${id}`,
    event_type: "REFERRAL_RECEIVED",
    aggregate_type: "referral_case",
    aggregate_id: id,
    occurred_at: "2026-10-05T06:00:00+08:00",
    version: 1,
    summary: id,
    actor: { id: "d", role: "sending_doctor", org: "基层" },
    from_org: "基层",
    to_org: "县医院",
    specialty: "科",
    triage_level: "routine",
    patient_ref: id,
  });
  const arrival = (id) => ({
    event_id: `arr-ev-${id}`,
    event_type: "ARRIVAL_CONFIRMED",
    aggregate_type: "arrival_assessment",
    aggregate_id: `arr-${id}`,
    occurred_at: "2026-10-05T07:00:00+08:00",
    version: 1,
    summary: "到院",
    actor: { id: "n", role: "county_center_nurse" },
    case_id: id,
    arrived_at: "2026-10-05T07:00:00+08:00",
  });
  const conflict = (id) => ({
    event_id: `conf-ev-${id}`,
    event_type: "EXAM_CONFLICT_DETECTED",
    aggregate_type: "arrival_assessment",
    aggregate_id: `arr-${id}`,
    occurred_at: "2026-10-05T07:10:00+08:00",
    version: 2,
    summary: "冲突",
    actor: { id: "n", role: "county_center_nurse" },
    case_id: id,
    conflict_id: `conf-${id}`,
    exam_items: ["CTA"],
    reason: "等待化验",
  });
  const assign = (id) => ({
    event_id: `task-ev-${id}`,
    event_type: "ESCORT_TASK_ASSIGNED",
    aggregate_type: "care_task",
    aggregate_id: `task-${id}`,
    occurred_at: "2026-10-05T07:15:00+08:00",
    version: 1,
    summary: "派人协调",
    actor: { id: "n", role: "county_center_nurse" },
    case_id: id,
    task_type: "exam_coordination",
    assignee_role: "escort_nurse",
    assignee_name: "刘护士",
    due_at: "2026-10-05T08:00:00+08:00",
    next_action: "加急化验",
    resolves: `conf-${id}`,
  });
  const complete = (id) => ({
    event_id: `done-ev-${id}`,
    event_type: "CARE_TASK_COMPLETED",
    aggregate_type: "care_task",
    aggregate_id: `task-${id}`,
    occurred_at: "2026-10-05T07:50:00+08:00",
    version: 2,
    summary: "协调完成",
    actor: { id: "n2", role: "escort_nurse" },
    task_event_id: `task-ev-${id}`,
    case_id: id,
    outcome: "已完成",
    resolves: `conf-${id}`,
  });

  const assignedOnly = buildBoard(
    [mkCase("case-A"), arrival("case-A"), conflict("case-A"), assign("case-A")],
    { now: NOW },
  );
  assert.equal(assignedOnly.lanes.exam_conflicts.length, 1, "仅分派不应核销冲突");

  const done = buildBoard(
    [mkCase("case-A"), arrival("case-A"), conflict("case-A"), assign("case-A"), complete("case-A")],
    { now: NOW },
  );
  assert.equal(done.lanes.exam_conflicts.length, 0, "任务完成后冲突应核销");
});

test("重复推单归并后看板只显示原病例", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });
  const all = [
    ...Object.values(board.lanes).flat(),
    ...board.contact_escalations,
  ];
  assert.ok(!all.some((i) => i.case_id === "case-C03b"));
  assert.ok(board.lanes.expected.some((i) => i.case_id === "case-C03"));
});

test("已出住院决定的风险升级不再占用风险清单", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });
  // 钟阿明曾升级为危急，但已有 ADMISSION_DECIDED，不应再出现在风险清单
  assert.ok(!board.lanes.risk_upgraded.some((i) => i.case_id === "case-C01"));
});
