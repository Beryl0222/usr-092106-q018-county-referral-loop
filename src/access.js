// 最小知情访问控制。
//
// 原则：调用方只读取完成职责所必需的字段；与病例无关的诊所既看不到诊断，
// 也看不到联系方式，其看板上不出现他人病例。
//
// 可见级别：
//   full     会诊转诊中心：全部字段
//   clinical 接诊医生（to_org）：身份+联系方式+诊疗
//   continuity 基层医生（from_org / 下转接收机构）：身份+联系方式+随访所需诊疗摘要
//   task     陪诊护士（被分派任务者）：身份+联系方式+风险等级，不看病史诊断
//   none     无关方：病例从视图中移除
import { EVENTS, SENSITIVITY } from "./catalog.js";

// 从事件流推导每个病例与机构/人员的关系。
export function buildRelations(events) {
  const byCase = new Map();
  const ensure = (id) => {
    if (!byCase.has(id)) {
      byCase.set(id, {
        case_id: id,
        from_org: null,
        to_org: null,
        target_org: null,
        receiving_org: null,
        assignees: new Set(),
      });
    }
    return byCase.get(id);
  };

  for (const event of events) {
    const caseId = event.aggregate_type === "referral_case" ? event.aggregate_id : event.case_id;
    if (!caseId) continue;
    const r = ensure(caseId);
    switch (event.event_type) {
      case "REFERRAL_RECEIVED":
        r.from_org = event.from_org;
        r.to_org = event.to_org;
        break;
      case "RETURN_PLANNED":
        r.target_org = event.target_org;
        break;
      case "RETURN_ACCEPTED":
        r.receiving_org = event.receiving_org;
        break;
      case "ESCORT_TASK_ASSIGNED":
        if (event.assignee_name) r.assignees.add(event.assignee_name);
        break;
      default:
        break;
    }
  }
  return byCase;
}

// 返回 viewer 对某病例的可见级别。
export function visibilityForCase(relation, viewer) {
  if (!relation || !viewer) return "none";
  if (viewer.role === "county_center_nurse") return "full";
  const org = viewer.org;
  if (viewer.role === "receiving_doctor" && org && relation.to_org === org) return "clinical";
  if (
    viewer.role === "sending_doctor" &&
    org &&
    (relation.from_org === org ||
      relation.target_org === org ||
      relation.receiving_org === org)
  ) {
    return "continuity";
  }
  if (
    viewer.role === "escort_nurse" &&
    viewer.name &&
    relation.assignees.has(viewer.name)
  ) {
    return "task";
  }
  return "none";
}

const MASKED = "******";

// 对单条事件做字段级脱敏。level=none 时返回 null。
export function redactEvent(event, viewer, relations) {
  if (!viewer) return null;
  const caseId = event.aggregate_type === "referral_case" ? event.aggregate_id : event.case_id;
  const level = caseId
    ? visibilityForCase(relations.get(caseId), viewer)
    : viewer.role === "county_center_nurse"
      ? "full"
      : "none";
  if (level === "none") return null;

  const out = { ...event };
  const spec = EVENTS[event.event_type];
  for (const [field, def] of Object.entries(spec?.properties ?? {})) {
    if (!(field in out)) continue;
    // 诊疗信息：陪诊岗只见风险等级，不见诊断、病史、用药与复查结果。
    // full/clinical/continuity 可见完整诊疗信息；none 已在上面整条剔除。
    if (def.sensitive === SENSITIVITY.clinical && level === "task" && field !== "triage_level") {
      out[field] = MASKED;
    }
    // 身份与联系方式：凡被允许看到该病例的角色（含陪诊找人接人）均可见；
    // 无关机构在 visibilityForCase 即为 none，整条事件不会下发。
  }
  return out;
}

// 对早班看板按视角过滤：none 的病例整条移除；其余按级别脱敏。
export function redactBoard(board, viewer, relations) {
  const allowed = new Set();
  for (const relation of relations.values()) {
    if (visibilityForCase(relation, viewer) !== "none") allowed.add(relation.case_id);
  }

  const scrubEntry = (entry) => {
    if (!entry.case_id || !allowed.has(entry.case_id)) return null;
    const level = visibilityForCase(relations.get(entry.case_id), viewer);
    const out = { ...entry };
    if (level === "task") {
      // 陪诊岗需要姓名、电话来找人接人；屏蔽主诉、观察依据等诊疗细节。
      if (out.chief_complaint) out.chief_complaint = MASKED;
      if (out.observation_reason) out.observation_reason = MASKED;
    }
    return out;
  };

  const lanes = Object.fromEntries(
    Object.entries(board.lanes).map(([k, items]) => [k, items.map(scrubEntry).filter(Boolean)]),
  );
  const contact_escalations = (board.contact_escalations ?? [])
    .map(scrubEntry)
    .filter(Boolean);

  return {
    ...board,
    viewer: { role: viewer.role, org: viewer.org ?? null },
    counts: {
      ...Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length])),
      contact_escalations: contact_escalations.length,
    },
    lost_contact_followups: board.lost_contact_followups.filter((f) => allowed.has(f.case_id)),
    lanes,
    contact_escalations,
  };
}
