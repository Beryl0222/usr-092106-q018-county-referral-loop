// 早班看板：把事件流折叠成转诊管家一上班就要处理的六条清单。
//
// 清单（顺序即处置优先级）：
//   1. risk_upgraded  现场风险升级（到院后分级上调/观察分歧，尚未出住院决定）
//   2. late           已迟到（预计到院时间已过、未确认到院；未到院联络升级在此显形）
//   3. expected       预计到院（今日将到、尚未到院）
//   4. exam_conflicts 检查冲突（未核销）
//   5. pending_return 待下转（下转计划已开、基层未接收）
//   6. followup_due   复查到期（到期或今日到期、未完成；下转后失联在此显形）
//
// 每条记录都带 next_action 与责任方，管家无需回翻电话便签即可直接联络。

const CN_TZ_OFFSET = 8 * 60; // 事件时间均为北京时间

function shiftDay(ms, offsetMin) {
  const shifted = new Date(ms + offsetMin * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function todayRange(now, offsetMin = CN_TZ_OFFSET) {
  const day = shiftDay(now.getTime(), offsetMin);
  return {
    day,
    start: Date.parse(`${day}T00:00:00+08:00`),
    end: Date.parse(`${day}T23:59:59+08:00`),
  };
}

export function buildBoard(events, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const range = todayRange(now);

  const cases = new Map();
  const mergedInto = new Map(); // 重复推单 case_id -> 原 case_id
  const resolveCase = (id) => (mergedInto.has(id) ? mergedInto.get(id) : id);
  const ensureCase = (id) => {
    if (!cases.has(id)) {
      cases.set(id, {
        case_id: id,
        patient_ref: null,
        patient_name: null,
        contact_phone: null,
        from_org: null,
        to_org: null,
        target_org: null,
        receiving_org: null,
        specialty: null,
        triage_level: null,
        chief_complaint: null,
        eta: null,
        arrived: false,
        arrived_at: null,
        channel: null,
        admission_decision: null,
        return_state: "none",
        risk_upgrade: null,
        open_escalation: null,
        open_tasks: [],
      });
    }
    return cases.get(id);
  };

  const conflicts = new Map(); // conflict_id -> {case_id, items, reason, at, resolved_by}
  const followups = new Map(); // followup_id -> {case_id, due_at, channel, items, completed, reached, result}

  const caseOf = (event) => {
    // referral_case 聚合的事件以 aggregate_id 为病例；其它聚合在 case_id 字段引用。
    const raw = event.aggregate_type === "referral_case" ? event.aggregate_id : event.case_id;
    if (!raw) return null;
    const id = resolveCase(raw);
    return id ? ensureCase(id) : null;
  };

  for (const event of events) {
    if (event.event_type === "REFERRAL_DUPLICATE_LINKED") {
      mergedInto.set(event.duplicate_case_id, event.original_case_id);
      cases.delete(event.duplicate_case_id); // 归并后看板只呈现原病例
      continue;
    }
    const c = caseOf(event);
    switch (event.event_type) {
      case "REFERRAL_RECEIVED": {
        Object.assign(c, {
          patient_ref: event.patient_ref ?? c.patient_ref,
          patient_name: event.patient_name ?? c.patient_name,
          contact_phone: event.contact_phone ?? c.contact_phone,
          from_org: event.from_org,
          to_org: event.to_org,
          specialty: event.specialty,
          triage_level: event.triage_level,
          chief_complaint: event.chief_complaint ?? c.chief_complaint,
        });
        if (event.expected_arrival_at) c.eta = Date.parse(event.expected_arrival_at);
        break;
      }
      case "APPOINTMENT_SCHEDULED": {
        c.eta = Date.parse(event.appointment_at);
        break;
      }
      case "APPOINTMENT_RESCHEDULED": {
        c.eta = Date.parse(event.to_appointment_at);
        break;
      }
      case "PATIENT_TRIP_RECORDED": {
        c.eta = Date.parse(event.estimated_arrival_at);
        break;
      }
      case "ARRIVAL_CONFIRMED": {
        c.arrived = true;
        c.arrived_at = Date.parse(event.arrived_at);
        c.channel = event.channel ?? c.channel;
        if (c.open_escalation && ["no_show", "wrong_department"].includes(c.open_escalation.reason_category)) {
          c.open_escalation = null;
        }
        break;
      }
      case "RISK_ESCALATED": {
        c.triage_level = event.to_level;
        c.risk_upgrade = {
          at: Date.parse(event.occurred_at),
          from_level: event.from_level,
          to_level: event.to_level,
          reason: event.reason,
          pathway: event.pathway ?? "normal",
        };
        break;
      }
      case "OBSERVATION_DIVERGENCE_RECORDED": {
        c.triage_level = event.new_risk_level;
        c.risk_upgrade = {
          at: Date.parse(event.occurred_at),
          from_level: null,
          to_level: event.new_risk_level,
          reason: event.observation,
          pathway: "normal",
          divergence: true,
          triaged_to: event.triaged_to,
        };
        break;
      }
      case "EXAM_CONFLICT_DETECTED": {
        conflicts.set(event.conflict_id, {
          conflict_id: event.conflict_id,
          case_id: c.case_id,
          exam_items: event.exam_items,
          reason: event.reason,
          conflicting_with: event.conflicting_with ?? null,
          at: Date.parse(event.occurred_at),
          resolved_by: null,
        });
        break;
      }
      case "GREEN_CHANNEL_PREEMPTED": {
        c.channel = "green_channel";
        break;
      }
      case "ESCORT_TASK_ASSIGNED": {
        c.open_tasks.push({
          task_event_id: event.event_id,
          task_type: event.task_type,
          assignee_role: event.assignee_role,
          assignee_name: event.assignee_name ?? null,
          due_at: Date.parse(event.due_at),
          next_action: event.next_action,
          contact_phone: event.contact_phone ?? c.contact_phone,
          resolves: event.resolves ?? null,
          opened_at: Date.parse(event.occurred_at),
        });
        // 分派只代表“有人负责”；冲突须等协调任务完成才核销，期间仍留在看板上。
        break;
      }
      case "CARE_TASK_COMPLETED": {
        c.open_tasks = c.open_tasks.filter((t) => t.task_event_id !== event.task_event_id);
        if (event.resolves && conflicts.has(event.resolves)) {
          conflicts.get(event.resolves).resolved_by = event.event_id;
        }
        break;
      }
      case "ADMISSION_DECIDED": {
        c.admission_decision = event.decision;
        break;
      }
      case "CONTACT_ESCALATION_OPENED": {
        c.open_escalation = {
          escalation_id: event.escalation_id,
          reason_category: event.reason_category,
          next_action: event.next_action,
          owner_role: event.owner_role,
          attempt_count: event.attempt_count ?? 1,
          opened_at: Date.parse(event.occurred_at),
        };
        break;
      }
      case "CONTACT_ESCALATION_RESOLVED": {
        if (c.open_escalation && c.open_escalation.escalation_id === event.escalation_id) {
          c.open_escalation = null;
        }
        break;
      }
      case "RETURN_PLANNED": {
        c.return_state = "planned";
        c.target_org = event.target_org;
        break;
      }
      case "RETURN_ACCEPTED": {
        c.return_state = "accepted";
        c.receiving_org = event.receiving_org;
        break;
      }
      case "FOLLOWUP_SCHEDULED": {
        followups.set(event.followup_id, {
          followup_id: event.followup_id,
          case_id: c.case_id,
          due_at: Date.parse(event.due_at),
          channel: event.channel,
          items: event.items ?? [],
          completed: false,
          reached: null,
          result: null,
        });
        break;
      }
      case "FOLLOWUP_DUE": {
        const f = followups.get(event.followup_id);
        if (f) f.due_at = Date.parse(event.due_at);
        break;
      }
      case "FOLLOWUP_COMPLETED": {
        const f = followups.get(event.followup_id);
        if (f) {
          f.completed = true;
          f.reached = event.reached;
          f.result = event.result ?? null;
        }
        break;
      }
      default:
        break;
    }
  }

  // 失联回访（reached=false）重新生成联络任务提示。
  const lostContactFollowups = [...followups.values()].filter((f) => f.completed && f.reached === false);

  const nextStep = (c) => {
    const sources = [
      ...(c.open_escalation
        ? [{
            kind: "escalation",
            next_action: c.open_escalation.next_action,
            owner_role: c.open_escalation.owner_role,
            assignee_name: null,
            contact_phone: c.contact_phone,
            due_at: c.open_escalation.opened_at,
            reason_category: c.open_escalation.reason_category,
          }]
        : []),
      ...c.open_tasks.map((t) => ({
        kind: "task",
        next_action: t.next_action,
        owner_role: t.assignee_role,
        assignee_name: t.assignee_name,
        contact_phone: t.contact_phone,
        due_at: t.due_at,
      })),
    ];
    sources.sort((a, b) => b.due_at - a.due_at);
    return sources[0] ?? null;
  };

  const baseEntry = (c) => ({
    case_id: c.case_id,
    patient_ref: c.patient_ref,
    patient_name: c.patient_name,
    contact_phone: c.contact_phone,
    from_org: c.from_org,
    specialty: c.specialty,
    triage_level: c.triage_level,
    chief_complaint: c.chief_complaint,
    next_step: nextStep(c),
  });

  const lanes = {
    risk_upgraded: [],
    late: [],
    expected: [],
    exam_conflicts: [],
    pending_return: [],
    followup_due: [],
  };

  for (const c of cases.values()) {
    const entry = baseEntry(c);

    if (c.risk_upgrade && c.arrived && !c.admission_decision) {
      lanes.risk_upgraded.push({
        ...entry,
        upgraded_at: new Date(c.risk_upgrade.at).toISOString(),
        observation_reason: c.risk_upgrade.reason,
        pathway: c.risk_upgrade.pathway,
        divergence: c.risk_upgrade.divergence === true,
      });
    }

    if (!c.arrived && c.eta !== null && c.eta < now.getTime()) {
      lanes.late.push({
        ...entry,
        eta: new Date(c.eta).toISOString(),
        late_minutes: Math.round((now.getTime() - c.eta) / 60_000),
        escalation: c.open_escalation
          ? {
              escalation_id: c.open_escalation.escalation_id,
              reason_category: c.open_escalation.reason_category,
              attempt_count: c.open_escalation.attempt_count,
            }
          : null,
      });
    } else if (c.arrived && c.open_escalation?.reason_category === "left_midway") {
      // 已到院但中途离开：对管家而言同样是“人不在应在的位置”，列入迟到/失联清单。
      lanes.late.push({
        ...entry,
        eta: c.arrived_at ? new Date(c.arrived_at).toISOString() : null,
        late_minutes: null,
        left_midway: true,
        escalation: {
          escalation_id: c.open_escalation.escalation_id,
          reason_category: c.open_escalation.reason_category,
          attempt_count: c.open_escalation.attempt_count,
        },
      });
    } else if (!c.arrived && c.eta !== null && c.eta >= range.start && c.eta <= range.end) {
      lanes.expected.push({ ...entry, eta: new Date(c.eta).toISOString() });
    }

    if (c.return_state === "planned") {
      lanes.pending_return.push({
        ...entry,
        target_org: c.target_org,
      });
    }
  }

  for (const conflict of conflicts.values()) {
    if (conflict.resolved_by) continue;
    const c = cases.get(conflict.case_id);
    lanes.exam_conflicts.push({
      ...baseEntry(c),
      conflict_id: conflict.conflict_id,
      exam_items: conflict.exam_items,
      reason: conflict.reason,
      conflicting_with: conflict.conflicting_with,
      detected_at: new Date(conflict.at).toISOString(),
    });
  }

  for (const f of followups.values()) {
    if (f.completed) continue;
    if (f.due_at <= range.end) {
      const c = cases.get(f.case_id);
      lanes.followup_due.push({
        ...baseEntry(c),
        followup_id: f.followup_id,
        due_at: new Date(f.due_at).toISOString(),
        overdue: f.due_at < range.start,
        channel: f.channel,
        items: f.items,
      });
    }
  }

  // 未在“迟到”清单内出现的未闭环联络升级（方言、费用、回访失联等）单独成区。
  const lateCaseIds = new Set(lanes.late.map((item) => item.case_id));
  const contact_escalations = [...cases.values()]
    .filter((c) => c.open_escalation && !lateCaseIds.has(c.case_id))
    .map((c) => ({
      ...baseEntry(c),
      escalation: {
        escalation_id: c.open_escalation.escalation_id,
        reason_category: c.open_escalation.reason_category,
        attempt_count: c.open_escalation.attempt_count,
        opened_at: new Date(c.open_escalation.opened_at).toISOString(),
      },
    }));

  return {
    generated_at: now.toISOString(),
    counts: {
      ...Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.length])),
      contact_escalations: contact_escalations.length,
    },
    lost_contact_followups: lostContactFollowups.map((f) => ({
      case_id: f.case_id,
      followup_id: f.followup_id,
      result: f.result,
    })),
    lanes,
    contact_escalations,
  };
}
