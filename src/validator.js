// 领域事件校验：信封、事件专属载荷、发起角色，以及事件流层面的不变量。
// 纯函数、无副作用；错误信息为中文，供录入端与联调直接阅读。
import {
  AGGREGATE_TYPES,
  ENVELOPE_REQUIRED,
  EVENTS,
  TRIAGE_LEVELS,
} from "./catalog.js";

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDateTime(value) {
  return typeof value === "string" && ISO_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

function isDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

// 校验单条事件信封与载荷。返回错误字符串数组，空数组表示通过。
export function validateEvent(record) {
  const errors = ENVELOPE_REQUIRED.filter((name) => !(name in record)).map(
    (name) => `缺少字段：${name}`,
  );
  if (errors.length > 0) return errors;

  if (typeof record.event_id !== "string" || record.event_id.trim() === "") {
    errors.push("event_id 必须是非空字符串");
  }
  if (typeof record.aggregate_id !== "string" || record.aggregate_id.trim() === "") {
    errors.push("aggregate_id 必须是非空字符串");
  }
  if (typeof record.summary !== "string" || record.summary.trim() === "") {
    errors.push("summary 必须是非空字符串");
  }
  if (!Number.isInteger(record.version) || record.version < 1) {
    errors.push("version 必须是正整数");
  }
  if (!isDateTime(record.occurred_at)) {
    errors.push("occurred_at 必须是带时区的 ISO 日期时间");
  }

  const spec = EVENTS[record.event_type];
  if (!spec) {
    errors.push(`未知事件类型：${record.event_type}`);
    return errors;
  }
  if (!AGGREGATE_TYPES.includes(record.aggregate_type)) {
    errors.push(`未知聚合类型：${record.aggregate_type}`);
    return errors;
  }
  if (record.aggregate_type !== spec.aggregate) {
    errors.push(
      `${record.event_type} 应归属聚合 ${spec.aggregate}，实际为 ${record.aggregate_type}`,
    );
  }

  for (const field of spec.required ?? []) {
    if (record[field] === undefined || record[field] === null || record[field] === "") {
      errors.push(`${record.event_type} 缺少必需字段：${field}`);
    }
  }

  for (const [field, def] of Object.entries(spec.properties ?? {})) {
    const value = record[field];
    if (value === undefined || value === null) continue;
    const where = `${record.event_type}.${field}`;
    if (def.type === "string" && typeof value !== "string") {
      errors.push(`${where} 必须是字符串`);
    } else if (def.type === "integer" && (!Number.isInteger(value) || value < 0)) {
      errors.push(`${where} 必须是非负整数`);
    } else if (def.type === "boolean" && typeof value !== "boolean") {
      errors.push(`${where} 必须是布尔值`);
    } else if (def.type === "array" && !Array.isArray(value)) {
      errors.push(`${where} 必须是数组`);
    } else if (def.type === "string" && def.enum && !def.enum.includes(value)) {
      errors.push(`${where} 取值必须是 ${def.enum.join("/")} 之一`);
    } else if (def.type === "string" && def.format === "date-time" && !isDateTime(value)) {
      errors.push(`${where} 必须是带时区的 ISO 日期时间`);
    } else if (def.type === "string" && def.format === "date" && !isDate(value)) {
      errors.push(`${where} 必须是 ISO 日期（YYYY-MM-DD）`);
    } else if (def.type === "string" && typeof value === "string" && value.trim() === "") {
      errors.push(`${where} 不允许空白字符串`);
    }
  }

  // 风险“升级”只能更高；降级或改判走 OBSERVATION_DIVERGENCE_RECORDED 并存记录。
  if (record.event_type === "RISK_ESCALATED") {
    const from = TRIAGE_LEVELS.indexOf(record.from_level);
    const to = TRIAGE_LEVELS.indexOf(record.to_level);
    if (from !== -1 && to !== -1 && to <= from) {
      errors.push("RISK_ESCALATED 只能上调风险等级；改判请另记观察分歧事件");
    }
  }

  const actor = record.actor;
  if (spec.requireMedicalActor) {
    if (!actor || typeof actor !== "object") {
      errors.push(`${record.event_type} 必须由医护人员发起（actor）`);
    } else if (!spec.actors.includes(actor.role)) {
      errors.push(`${record.event_type} 只能由 ${spec.actors.join("/")} 发起`);
    }
  } else if (actor && (!spec.actors || !spec.actors.includes(actor.role))) {
    errors.push(`${record.event_type} 的发起角色 ${actor.role} 不在允许范围：${(spec.actors ?? []).join("/")}`);
  }
  if (actor && (typeof actor.id !== "string" || actor.id.trim() === "")) {
    errors.push("actor.id 必须是非空字符串");
  }

  return errors;
}

// 校验事件流：事件标识唯一、同一聚合版本连续递增且时间不倒退、关键字段可追溯。
export function validateStream(events) {
  const errors = [];
  const seenEventIds = new Set();
  const aggregates = new Map(); // aggregate_id -> 上一条 {version, occurred_at}
  const referralCases = new Set();
  const assignedTaskIds = new Set();
  const openEscalations = new Map(); // escalation_id -> 是否已解除
  const scheduledFollowups = new Set();
  const referencedCases = [];

  events.forEach((event, index) => {
    const at = event.event_id || `#${index}`;
    const local = validateEvent(event);
    for (const e of local) errors.push(`${at}：${e}`);

    if (seenEventIds.has(event.event_id)) errors.push(`${at}：event_id 重复，事件标识必须唯一`);
    seenEventIds.add(event.event_id);

    if (event.aggregate_type === "referral_case") referralCases.add(event.aggregate_id);
    if (event.case_id) referencedCases.push({ at, caseRef: event.case_id });

    const prev = aggregates.get(event.aggregate_id);
    if (prev) {
      if (event.version !== prev.version + 1) {
        errors.push(`${at}：聚合 ${event.aggregate_id} 版本应为 ${prev.version + 1}（事件只追加、不改写）`);
      }
      if (Date.parse(event.occurred_at) < Date.parse(prev.occurred_at)) {
        errors.push(`${at}：聚合 ${event.aggregate_id} 发生时间早于前序事件`);
      }
    } else if (event.version !== 1) {
      errors.push(`${at}：聚合 ${event.aggregate_id} 首条事件版本必须为 1`);
    }
    aggregates.set(event.aggregate_id, {
      version: event.version,
      occurred_at: event.occurred_at,
    });

    switch (event.event_type) {
      case "ESCORT_TASK_ASSIGNED":
        assignedTaskIds.add(event.event_id);
        break;
      case "CARE_TASK_COMPLETED":
        if (!assignedTaskIds.has(event.task_event_id)) {
          errors.push(`${at}：完成的任务 ${event.task_event_id} 找不到分派记录`);
        }
        break;
      case "CONTACT_ESCALATION_OPENED":
        openEscalations.set(event.escalation_id, false);
        break;
      case "CONTACT_ESCALATION_RESOLVED":
        if (!openEscalations.has(event.escalation_id)) {
          errors.push(`${at}：联络升级 ${event.escalation_id} 未开启即解除`);
        }
        openEscalations.set(event.escalation_id, true);
        break;
      case "FOLLOWUP_SCHEDULED":
        scheduledFollowups.add(event.followup_id);
        break;
      case "FOLLOWUP_DUE":
      case "FOLLOWUP_COMPLETED":
        if (!scheduledFollowups.has(event.followup_id)) {
          errors.push(`${at}：复查 ${event.followup_id} 未先制定计划`);
        }
        break;
      default:
        break;
    }
  });

  for (const { at, caseRef } of referencedCases) {
    if (!referralCases.has(caseRef)) {
      errors.push(`${at}：引用的转诊病例 ${caseRef} 不存在`);
    }
  }

  return errors;
}
