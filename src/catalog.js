// 县域转诊闭环——领域事件目录（唯一事实源）
//
// 约定：
// 1. 事件一旦接收，event_id / occurred_at / version 不得原地改写；业务更正产生后继事件，
//    用 linked_event_ids 关联原记录，原记录保留（现场观察与原单不一致时两份同时保留）。
// 2. version 在同一 aggregate_id 内从 1 开始严格递增。
// 3. 系统只记录与提示，不开立诊断、不替代护士/医生做临床决定；危急与临床决定事件必须有
//    医护人员 actor（role 为 *_doctor / *_nurse）。
// 4. 标注 sensitive 的字段按 src/access.js 的最小知情策略过滤。

export const ENVELOPE_REQUIRED = [
  "event_id",
  "event_type",
  "aggregate_type",
  "aggregate_id",
  "occurred_at",
  "version",
  "summary",
];

// 敏感分级：identity 身份、contact 联系方式、clinical 诊疗信息
export const SENSITIVITY = {
  identity: "identity",
  contact: "contact",
  clinical: "clinical",
};

export const AGGREGATES = {
  referral_case: {
    label: "转诊病例",
    note: "从基层推单到住院/下转决定的主线，一个患者一次转诊占一个容量桶",
  },
  arrival_assessment: {
    label: "到院再评估",
    note: "到院时护士/专科的再评估与现场观察，可与原转诊单并存",
  },
  care_task: {
    label: "陪诊与协调任务",
    note: "陪诊、检查协调、联络等可分派可完成的任务",
  },
  return_handoff: {
    label: "下转接收与随访",
    note: "下转基层接收、用药交接、复查与回访",
  },
};

export const TRIAGE_LEVELS = ["routine", "urgent", "critical"];

export const ESCALATION_REASONS = {
  no_show: "预计到院时间已过仍未到院（单到人不到）",
  unreachable: "电话无法接通/无人接听",
  dialect: "方言沟通困难，需要双语联络人",
  cost_concern: "费用顾虑，可能放弃就诊",
  left_midway: "就诊/检查中途离开",
  wrong_department: "到院后找不到对接科室（人到无人接）",
};

// 每个事件：归属聚合、必需载荷字段、字段类型与敏感标记、允许的发起角色
export const EVENTS = {
  // ── 接收与排程 ────────────────────────────────────────────────
  REFERRAL_RECEIVED: {
    aggregate: "referral_case",
    label: "基层转诊单接收",
    required: ["from_org", "to_org", "specialty", "triage_level", "patient_ref"],
    properties: {
      from_org: { type: "string", label: "发起基层机构" },
      to_org: { type: "string", label: "接收医院" },
      specialty: { type: "string", label: "申请专科" },
      triage_level: { type: "string", enum: TRIAGE_LEVELS, label: "原单风险分级" },
      patient_ref: { type: "string", sensitive: "identity", label: "患者标识" },
      patient_name: { type: "string", sensitive: "identity", label: "患者姓名" },
      contact_phone: { type: "string", sensitive: "contact", label: "联系电话" },
      chief_complaint: { type: "string", sensitive: "clinical", label: "主诉（如胸闷待查）" },
      primary_diagnosis: { type: "string", sensitive: "clinical", label: "基层初步诊断" },
      expected_arrival_at: { type: "string", format: "date-time", label: "预计到院时间" },
      source_referral_no: { type: "string", label: "基层转诊单号" },
    },
    actors: ["sending_doctor", "county_center_nurse"],
  },

  REFERRAL_DUPLICATE_LINKED: {
    aggregate: "referral_case",
    label: "重复推单归并",
    required: ["original_case_id", "duplicate_case_id"],
    properties: {
      original_case_id: { type: "string", label: "原转诊病例" },
      duplicate_case_id: { type: "string", label: "重复推单病例" },
      reason: { type: "string", label: "归并原因" },
    },
    note: "重复推单只占一次容量：重复单关联到原单同一个容量桶",
    actors: ["county_center_nurse"],
  },

  APPOINTMENT_SCHEDULED: {
    aggregate: "referral_case",
    label: "到院安排/号源锁定",
    required: ["appointment_at", "specialty"],
    properties: {
      appointment_at: { type: "string", format: "date-time", label: "安排到院时间" },
      specialty: { type: "string", label: "专科" },
      slot_id: { type: "string", label: "号源/容量位" },
      channel: { type: "string", label: "安排渠道" },
    },
    actors: ["county_center_nurse"],
  },

  APPOINTMENT_RESCHEDULED: {
    aggregate: "referral_case",
    label: "跨日改约",
    required: ["from_appointment_at", "to_appointment_at", "reason"],
    properties: {
      from_appointment_at: { type: "string", format: "date-time", label: "原安排时间" },
      to_appointment_at: { type: "string", format: "date-time", label: "改约后时间" },
      reason: { type: "string", label: "改约原因" },
      slot_id: { type: "string", label: "新号源" },
      resolves: { type: "string", label: "顺带解决的冲突标识" },
    },
    note: "改约释放旧容量位、占用新容量位，全流程仍只占一次",
    actors: ["county_center_nurse"],
  },

  PATIENT_TRIP_RECORDED: {
    aggregate: "referral_case",
    label: "患者行程报备",
    required: ["estimated_arrival_at"],
    properties: {
      departed_at: { type: "string", format: "date-time", label: "出发时间" },
      estimated_arrival_at: { type: "string", format: "date-time", label: "预计到院时间" },
      transport: { type: "string", label: "交通方式" },
      companion: { type: "string", label: "陪同人" },
      contact_phone: { type: "string", sensitive: "contact", label: "随车联系电话" },
      note: { type: "string", label: "行程备注（天不亮赶路等）" },
    },
    actors: ["sending_doctor", "county_center_nurse", "patient_family"],
  },

  // ── 到院与再评估 ──────────────────────────────────────────────
  ARRIVAL_CONFIRMED: {
    aggregate: "arrival_assessment",
    label: "到院确认",
    required: ["case_id", "arrived_at"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      arrived_at: { type: "string", format: "date-time", label: "实际到院时间" },
      received_by: { type: "string", label: "接诊人" },
      channel: { type: "string", label: "接诊通道（普通/绿色通道）" },
    },
    actors: ["county_center_nurse", "receiving_doctor"],
  },

  RISK_ESCALATED: {
    aggregate: "arrival_assessment",
    label: "现场风险升级",
    required: ["case_id", "from_level", "to_level", "reason"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      from_level: { type: "string", enum: TRIAGE_LEVELS, label: "原分级" },
      to_level: { type: "string", enum: TRIAGE_LEVELS, label: "升级后分级" },
      reason: { type: "string", sensitive: "clinical", label: "升级依据（现场体征/症状）" },
      pathway: { type: "string", enum: ["normal", "green_channel"], label: "分流路径" },
    },
    requireMedicalActor: true,
    actors: ["county_center_nurse", "receiving_doctor"],
  },

  OBSERVATION_DIVERGENCE_RECORDED: {
    aggregate: "arrival_assessment",
    label: "现场观察与原单不一致",
    required: ["case_id", "original_referral_id", "observation", "new_risk_level", "triaged_to"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      original_referral_id: { type: "string", label: "原转诊单事件（保留不改）" },
      observation: { type: "string", sensitive: "clinical", label: "现场观察记录" },
      new_risk_level: { type: "string", enum: TRIAGE_LEVELS, label: "按现场重新判定的风险" },
      triaged_to: { type: "string", label: "重新分流去向" },
    },
    note: "两份记录同时保留：原 REFERRAL_RECEIVED 不修改，本事件承载新观察并按新风险分流",
    requireMedicalActor: true,
    actors: ["county_center_nurse", "receiving_doctor"],
  },

  EXAM_CONFLICT_DETECTED: {
    aggregate: "arrival_assessment",
    label: "检查冲突",
    required: ["case_id", "conflict_id", "exam_items", "reason"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      conflict_id: { type: "string", label: "冲突标识" },
      exam_items: { type: "array", label: "冲突的检查项目" },
      conflicting_with: { type: "string", label: "冲突对象（专科/时段/禁食要求）" },
      reason: { type: "string", label: "冲突原因" },
    },
    actors: ["county_center_nurse", "receiving_doctor"],
  },

  // ── 容量与绿色通道 ────────────────────────────────────────────
  GREEN_CHANNEL_PREEMPTED: {
    aggregate: "referral_case",
    label: "绿色通道抢占普通安排",
    required: ["case_id", "specialty", "preempt_reason"],
    properties: {
      case_id: { type: "string", label: "发起抢占的危急病例" },
      specialty: { type: "string", label: "被抢占的专科容量" },
      preempted_case_id: { type: "string", label: "被挤占的普通病例（可空）" },
      preempt_reason: { type: "string", sensitive: "clinical", label: "抢占原因（必须说明）" },
      appointment_at: { type: "string", format: "date-time", label: "抢占发生的时段" },
    },
    note: "危急可超普通容量上限，但必须给出原因并保留被挤占方的改约链路",
    requireMedicalActor: true,
    actors: ["receiving_doctor", "county_center_nurse"],
  },

  CAPACITY_BLOCKED: {
    aggregate: "referral_case",
    label: "普通容量已满",
    required: ["specialty", "reason"],
    properties: {
      specialty: { type: "string", label: "专科" },
      slot_date: { type: "string", format: "date", label: "容量日期" },
      reason: { type: "string", label: "满额原因" },
    },
    actors: ["county_center_nurse"],
  },

  // ── 陪诊与检查 ────────────────────────────────────────────────
  ESCORT_TASK_ASSIGNED: {
    aggregate: "care_task",
    label: "陪诊/联络任务分派",
    required: ["case_id", "task_type", "assignee_role", "due_at", "next_action"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      task_type: {
        type: "string",
        enum: ["escort", "exam_coordination", "contact_escalation", "interpretation", "return_coordination", "followup_call"],
        label: "任务类型",
      },
      assignee_role: { type: "string", label: "责任岗位" },
      assignee_name: { type: "string", label: "责任人" },
      due_at: { type: "string", format: "date-time", label: "截止时间" },
      next_action: { type: "string", label: "下一步动作（管家可直接执行）" },
      contact_phone: { type: "string", sensitive: "contact", label: "本次联络电话" },
      resolves: { type: "string", label: "解决的冲突/升级标识" },
    },
    actors: ["county_center_nurse"],
  },

  CARE_TASK_COMPLETED: {
    aggregate: "care_task",
    label: "陪诊/协调任务完成",
    required: ["task_event_id", "outcome"],
    properties: {
      task_event_id: { type: "string", label: "对应分派事件" },
      case_id: { type: "string", label: "转诊病例" },
      outcome: { type: "string", label: "完成情况" },
      resolves: { type: "string", label: "核销的冲突/升级标识" },
    },
    actors: ["county_center_nurse", "escort_nurse"],
  },

  // ── 住院决定（医生职权） ──────────────────────────────────────
  ADMISSION_DECIDED: {
    aggregate: "referral_case",
    label: "住院/留观/门诊决定",
    required: ["case_id", "decision", "decided_by"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      decision: { type: "string", enum: ["admitted", "observation", "outpatient"], label: "医生决定" },
      decided_by: { type: "string", label: "决定医生" },
      ward: { type: "string", label: "病区" },
      reason: { type: "string", sensitive: "clinical", label: "决定依据" },
    },
    requireMedicalActor: true,
    actors: ["receiving_doctor"],
  },

  // ── 联络升级 ──────────────────────────────────────────────────
  CONTACT_ESCALATION_OPENED: {
    aggregate: "referral_case",
    label: "联络升级开启",
    required: ["case_id", "escalation_id", "reason_category", "next_action", "owner_role"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      escalation_id: { type: "string", label: "升级标识" },
      reason_category: { type: "string", enum: Object.keys(ESCALATION_REASONS), label: "升级类别" },
      next_action: { type: "string", label: "下一步（双语联络/费用沟通/寻人等）" },
      owner_role: { type: "string", label: "责任岗位" },
      attempt_count: { type: "integer", label: "已尝试联络次数" },
      note: { type: "string", label: "情况说明" },
    },
    note: "未到院、方言、费用顾虑、中途离开均进入明确的联络升级，而非停留在电话便签",
    actors: ["county_center_nurse", "escort_nurse"],
  },

  CONTACT_ESCALATION_RESOLVED: {
    aggregate: "referral_case",
    label: "联络升级解除",
    required: ["escalation_id", "resolution"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      escalation_id: { type: "string", label: "升级标识" },
      resolution: { type: "string", label: "解除方式（已到院/改约/放弃就诊并记录等）" },
    },
    actors: ["county_center_nurse", "escort_nurse"],
  },

  // ── 下转、用药与复查回访 ──────────────────────────────────────
  RETURN_PLANNED: {
    aggregate: "referral_case",
    label: "下转计划",
    required: ["case_id", "target_org", "planned_at"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      target_org: { type: "string", label: "拟接收基层机构" },
      planned_at: { type: "string", format: "date-time", label: "计划下转时间" },
      medication_summary: { type: "string", sensitive: "clinical", label: "带药方案摘要" },
      rehab_plan: { type: "string", sensitive: "clinical", label: "康复计划" },
    },
    requireMedicalActor: true,
    actors: ["receiving_doctor", "county_center_nurse"],
  },

  RETURN_ACCEPTED: {
    aggregate: "return_handoff",
    label: "下转接收确认",
    required: ["case_id", "receiving_org", "accepted_by"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      receiving_org: { type: "string", label: "实际接收机构" },
      accepted_by: { type: "string", label: "基层接收医生" },
      accepted_at: { type: "string", format: "date-time", label: "接收时间" },
      medication_handover: { type: "string", sensitive: "clinical", label: "用药交接清单" },
      rehab_plan: { type: "string", sensitive: "clinical", label: "康复安排" },
    },
    actors: ["sending_doctor", "county_center_nurse"],
  },

  FOLLOWUP_SCHEDULED: {
    aggregate: "return_handoff",
    label: "复查/回访计划",
    required: ["case_id", "followup_id", "due_at", "channel"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      followup_id: { type: "string", label: "复查标识" },
      due_at: { type: "string", format: "date-time", label: "到期时间" },
      channel: { type: "string", enum: ["clinic", "phone", "home_visit"], label: "复查方式" },
      items: { type: "array", label: "复查项目（血压/电解质/凝血等）" },
    },
    actors: ["county_center_nurse", "sending_doctor"],
  },

  FOLLOWUP_DUE: {
    aggregate: "return_handoff",
    label: "复查到期提醒",
    required: ["case_id", "followup_id", "due_at"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      followup_id: { type: "string", label: "复查标识" },
      due_at: { type: "string", format: "date-time", label: "到期时间" },
    },
    actors: ["system"],
  },

  FOLLOWUP_COMPLETED: {
    aggregate: "return_handoff",
    label: "复查/回访完成",
    required: ["case_id", "followup_id", "reached"],
    properties: {
      case_id: { type: "string", label: "转诊病例" },
      followup_id: { type: "string", label: "复查标识" },
      reached: { type: "boolean", label: "是否联系上/到检" },
      result: { type: "string", sensitive: "clinical", label: "复查结果（失联则注明）" },
      completed_at: { type: "string", format: "date-time", label: "完成时间" },
    },
    note: "回访失联仍是完成记录，但需重新开启联络升级，杜绝下转后失联",
    actors: ["county_center_nurse", "sending_doctor"],
  },
};

export const EVENT_TYPES = Object.keys(EVENTS);
export const AGGREGATE_TYPES = Object.keys(AGGREGATES);
