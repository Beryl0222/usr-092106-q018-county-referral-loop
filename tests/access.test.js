import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildRelations, redactBoard, redactEvent, visibilityForCase } from "../src/access.js";
import { buildBoard } from "../src/board.js";

const NOW = "2026-10-05T08:30:00+08:00";

const loadScenario = async () =>
  JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));

test("无关诊所看不到任何病例、诊断与联系方式", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });
  const relations = buildRelations(events);
  const view = redactBoard(board, { role: "sending_doctor", org: "某无关牙科诊所" }, relations);
  assert.equal(Object.values(view.lanes).flat().length + view.contact_escalations.length, 0);
});

test("基层医生只见与本机构有连续照护关系的病例，并可见随访诊疗摘要", async () => {
  const { events } = await loadScenario();
  const board = buildBoard(events, { now: NOW });
  const relations = buildRelations(events);
  const panxi = redactBoard(board, { role: "sending_doctor", org: "磻溪镇卫生院" }, relations);

  // 钟阿明下转磻溪、复查到期：可见且诊疗与联系方式保留
  const follow = panxi.lanes.followup_due.find((i) => i.case_id === "case-C01");
  assert.ok(follow);
  assert.equal(follow.contact_phone, "13800001001");
  assert.equal(follow.chief_complaint, "胸闷待查");

  // 与磻溪无关的病例（如佳阳畲语病例）不可见
  const all = [...Object.values(panxi.lanes).flat(), ...panxi.contact_escalations];
  assert.ok(!all.some((i) => i.case_id === "case-C05"));
  assert.ok(!all.some((i) => i.case_id === "case-C08"));
});

test("接诊医生可见身份、联系方式与诊疗字段", () => {
  const relations = new Map([[
    "case-1",
    { case_id: "case-1", from_org: "基层", to_org: "福鼎市医院", target_org: null, receiving_org: null, assignees: new Set() },
  ]]);
  const event = {
    event_id: "e1",
    event_type: "REFERRAL_RECEIVED",
    aggregate_type: "referral_case",
    aggregate_id: "case-1",
    version: 1,
    occurred_at: "2026-10-05T08:00:00+08:00",
    summary: "s",
    patient_name: "钟阿明",
    contact_phone: "13800001001",
    chief_complaint: "胸闷待查",
    triage_level: "critical",
  };
  const doctor = redactEvent(event, { role: "receiving_doctor", org: "福鼎市医院" }, relations);
  assert.equal(doctor.contact_phone, "13800001001");
  assert.equal(doctor.chief_complaint, "胸闷待查");

  const outsider = redactEvent(event, { role: "receiving_doctor", org: "外院" }, relations);
  assert.equal(outsider, null);
});

test("陪诊护士可见姓名电话与风险等级，不见诊断病史，但只见被分派病例", async () => {
  const { events } = await loadScenario();
  const relations = buildRelations(events);

  // 何祖荫的检查协调分派给刘护士
  assert.equal(visibilityForCase(relations.get("case-C08"), { role: "escort_nurse", name: "刘护士" }), "task");
  assert.equal(visibilityForCase(relations.get("case-C05"), { role: "escort_nurse", name: "刘护士" }), "none");

  const event = events.find((e) => e.event_id === "e-c08-03"); // 观察分歧，含诊疗细节
  const shown = redactEvent(event, { role: "escort_nurse", name: "刘护士" }, relations);
  assert.equal(shown.new_risk_level, "critical", "风险等级应对陪诊可见");
  assert.equal(shown.observation, "******", "夹层观察等诊疗细节应对陪诊屏蔽");
});

test("未携带视角的调用方得不到任何事件", () => {
  assert.equal(redactEvent({ event_id: "e" }, null, new Map()), null);
});
