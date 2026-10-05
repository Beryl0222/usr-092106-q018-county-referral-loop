import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildCapacityLedger } from "../src/capacity.js";

const loadScenario = async () =>
  JSON.parse(await readFile(new URL("../data/scenario.json", import.meta.url), "utf8"));

const received = (id, day, { triage = "routine", specialty = "测试科" } = {}) => ({
  event_id: `r-${id}`,
  event_type: "REFERRAL_RECEIVED",
  aggregate_type: "referral_case",
  aggregate_id: id,
  occurred_at: `${day}T07:00:00+08:00`,
  version: 1,
  summary: id,
  from_org: "基层",
  to_org: "县医院",
  specialty,
  triage_level: triage,
  patient_ref: id,
  expected_arrival_at: `${day}T09:00:00+08:00`,
});

test("场景容量账无违规，绿通当日心血管普通位为0、危急位为1", async () => {
  const { events } = await loadScenario();
  const ledger = buildCapacityLedger(events);
  assert.deepEqual(ledger.violations, []);
  const xnk = ledger.buckets.find((b) => b.key === "心血管内科@2026-09-28");
  assert.equal(xnk.normal_count, 0, "林秀兰已改约，当日不应再占普通位");
  assert.equal(xnk.critical_count, 1, "钟阿明走危急绿通位");
  assert.equal(xnk.total, 1, "改约与抢占合计仍只占一次容量");
});

test("重复推单归并后只占一次容量", async () => {
  const { events } = await loadScenario();
  const ledger = buildCapacityLedger(events);
  assert.deepEqual(ledger.merged, { "case-C03b": "case-C03" });
  const bucket = ledger.buckets.find((b) => b.key === "内分泌科@2026-10-05");
  assert.equal(bucket.normal_count, 1);
});

test("跨日改约释放旧位、占用新位，全程一位", () => {
  const events = [
    received("case-A", "2026-10-05"),
    {
      event_id: "sched-a",
      event_type: "APPOINTMENT_SCHEDULED",
      aggregate_type: "referral_case",
      aggregate_id: "case-A",
      occurred_at: "2026-10-05T07:30:00+08:00",
      version: 2,
      summary: "排到次日",
      appointment_at: "2026-10-06T09:00:00+08:00",
      specialty: "测试科",
      slot_id: "slot-06",
      actor: { id: "n1", role: "county_center_nurse" },
    },
  ];
  const ledger = buildCapacityLedger(events);
  assert.deepEqual(ledger.violations, []);
  assert.ok(!ledger.buckets.some((b) => b.key === "测试科@2026-10-05"));
  assert.equal(ledger.buckets.find((b) => b.key === "测试科@2026-10-06").normal_count, 1);
});

test("普通预约超出容量上限报错，绿通不受普通上限约束", () => {
  const events = [];
  for (let i = 1; i <= 11; i += 1) {
    events.push(received(`case-N${i}`, "2026-10-05"));
  }
  const over = buildCapacityLedger(events, new Map([["测试科@2026-10-05", 10]]));
  assert.ok(over.violations.some((v) => v.type === "NORMAL_OVER_CAPACITY"));

  // 第 11 人若是危急绿通，则不构成普通超容
  const crit = received("case-N11", "2026-10-05", { triage: "urgent" });
  const green = [...events.slice(0, 10), {
    ...crit,
    triage_level: "critical",
  }];
  const ok = buildCapacityLedger(green, new Map([["测试科@2026-10-05", 10]]));
  assert.ok(!ok.violations.some((v) => v.type === "NORMAL_OVER_CAPACITY"));
});

test("绿通抢占后被挤占普通病例未改约，报悬空违规", () => {
  const events = [
    received("case-normal", "2026-10-05"),
    received("case-crit", "2026-10-05", { triage: "critical" }),
    {
      event_id: "gp1",
      event_type: "GREEN_CHANNEL_PREEMPTED",
      aggregate_type: "referral_case",
      aggregate_id: "case-crit",
      occurred_at: "2026-10-05T08:00:00+08:00",
      version: 2,
      summary: "抢占",
      actor: { id: "d1", role: "receiving_doctor" },
      case_id: "case-crit",
      specialty: "测试科",
      preempted_case_id: "case-normal",
      preempt_reason: "危急须即刻处置",
      appointment_at: "2026-10-05T09:00:00+08:00",
    },
  ];
  const ledger = buildCapacityLedger(events, new Map([["测试科@2026-10-05", 10]]));
  assert.ok(ledger.violations.some((v) => v.type === "PREEMPTED_CASE_NOT_RESCHEDULED"));
});

test("归并后的重复单另行锁号被判违规", () => {
  const events = [
    received("case-A", "2026-10-05"),
    received("case-B", "2026-10-05"),
    {
      event_id: "dup1",
      event_type: "REFERRAL_DUPLICATE_LINKED",
      aggregate_type: "referral_case",
      aggregate_id: "case-A",
      occurred_at: "2026-10-05T07:10:00+08:00",
      version: 2,
      summary: "归并",
      actor: { id: "n1", role: "county_center_nurse" },
      original_case_id: "case-A",
      duplicate_case_id: "case-B",
    },
    {
      event_id: "sched-b",
      event_type: "APPOINTMENT_SCHEDULED",
      aggregate_type: "referral_case",
      aggregate_id: "case-B",
      occurred_at: "2026-10-05T07:20:00+08:00",
      version: 2,
      summary: "重复单仍锁号",
      actor: { id: "n1", role: "county_center_nurse" },
      appointment_at: "2026-10-05T09:00:00+08:00",
      specialty: "测试科",
    },
  ];
  const ledger = buildCapacityLedger(events);
  assert.ok(ledger.violations.some((v) => v.type === "DUPLICATE_OCCUPIES_SLOT"));
});
