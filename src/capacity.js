// 容量账：把事件流折叠成“专科 × 日期”的占用情况。
//
// 核心不变量：
// 1. 一个转诊病例全程只占一个容量位——重复推单归并到原单，跨日改约释放旧位、占用新位。
// 2. 普通预约不得超出普通容量；危急走 GREEN_CHANNEL_PREEMPTED 可超出，但必须带原因，
//    且被抢占的普通病例必须随后改约，不得悬空。

const dateOf = (iso) => iso.slice(0, 10);

function bucketKey(specialty, day) {
  return `${specialty}@${day}`;
}

// limits: Map<"专科@YYYY-MM-DD", number>，缺省普通容量为 10。
export function buildCapacityLedger(events, limits = new Map()) {
  const DEFAULT_LIMIT = 10;
  const cases = new Map(); // case_id -> 病例容量状态
  const mergedInto = new Map(); // duplicate_case_id -> original_case_id

  const resolve = (id) => (mergedInto.has(id) ? mergedInto.get(id) : id);

  for (const event of events) {
    switch (event.event_type) {
      case "REFERRAL_RECEIVED": {
        cases.set(event.aggregate_id, {
          case_id: event.aggregate_id,
          specialty: event.specialty,
          triage_level: event.triage_level,
          day: event.expected_arrival_at ? dateOf(event.expected_arrival_at) : null,
          slot_id: null,
          channel: "normal",
          history: [],
        });
        break;
      }
      case "REFERRAL_DUPLICATE_LINKED": {
        mergedInto.set(event.duplicate_case_id, event.original_case_id);
        break;
      }
      case "APPOINTMENT_SCHEDULED": {
        const c = cases.get(resolve(event.aggregate_id));
        if (c) {
          c.history.push({ day: c.day, slot_id: c.slot_id });
          c.day = dateOf(event.appointment_at);
          c.slot_id = event.slot_id ?? c.slot_id;
        }
        break;
      }
      case "APPOINTMENT_RESCHEDULED": {
        const c = cases.get(resolve(event.aggregate_id));
        if (c) {
          c.history.push({ day: c.day, slot_id: c.slot_id });
          c.day = dateOf(event.to_appointment_at);
          c.slot_id = event.slot_id ?? c.slot_id;
        }
        break;
      }
      case "GREEN_CHANNEL_PREEMPTED": {
        const c = cases.get(resolve(event.case_id));
        if (c) c.channel = "green_channel";
        break;
      }
      default:
        break;
    }
  }

  // 归并掉重复单后，按当前有效容量位聚合（历史位已释放，不计数）。
  const buckets = new Map();
  const violations = [];

  const ensureBucket = (specialty, day) => {
    const key = bucketKey(specialty, day);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        specialty,
        day,
        normal_limit: limits.get(key) ?? DEFAULT_LIMIT,
        normal_occupants: [],
        critical_occupants: [],
      });
    }
    return buckets.get(key);
  };

  for (const c of cases.values()) {
    if (mergedInto.has(c.case_id)) continue; // 重复推单归并后不再独立占容量
    if (!c.day) continue;
    const bucket = ensureBucket(c.specialty, c.day);
    if (c.channel === "green_channel" || c.triage_level === "critical") {
      bucket.critical_occupants.push(c.case_id);
    } else {
      bucket.normal_occupants.push(c.case_id);
    }
  }

  for (const bucket of buckets.values()) {
    const overflow = bucket.normal_occupants.length - bucket.normal_limit;
    if (overflow > 0) {
      violations.push({
        type: "NORMAL_OVER_CAPACITY",
        bucket: bucket.key,
        message: `${bucket.specialty} ${bucket.day} 普通预约 ${bucket.normal_occupants.length} 人，超出容量 ${bucket.normal_limit}；普通满额应改约或由危急走绿色通道`,
        case_ids: bucket.normal_occupants.slice(bucket.normal_limit),
      });
    }
    bucket.normal_count = bucket.normal_occupants.length;
    bucket.critical_count = bucket.critical_occupants.length;
    bucket.total = bucket.normal_count + bucket.critical_count;
    bucket.critical_overflow = Math.max(0, bucket.total - bucket.normal_limit);
  }

  // 抢占必须说明原因（schema 已强制），且被挤占方要有后续改约。
  const rescheduled = new Set(events.filter((e) => e.event_type === "APPOINTMENT_RESCHEDULED").map((e) => resolve(e.aggregate_id)));
  for (const event of events) {
    if (event.event_type !== "GREEN_CHANNEL_PREEMPTED") continue;
    if (!event.preempt_reason || event.preempt_reason.trim() === "") {
      violations.push({
        type: "PREEMPT_WITHOUT_REASON",
        bucket: `${event.specialty}@${event.appointment_at ? dateOf(event.appointment_at) : "?"}`,
        message: `危急病例 ${event.case_id} 抢占容量但未说明原因`,
        case_ids: [event.case_id],
      });
    }
    if (event.preempted_case_id && !rescheduled.has(resolve(event.preempted_case_id))) {
      violations.push({
        type: "PREEMPTED_CASE_NOT_RESCHEDULED",
        message: `被绿通挤占的普通病例 ${event.preempted_case_id} 尚无跨日改约记录，不能悬空`,
        case_ids: [event.preempted_case_id],
      });
    }
  }

  // 重复单若自己另占了号源，同样违规（它应被归并而不是再占一位）。
  for (const event of events) {
    if (event.event_type !== "APPOINTMENT_SCHEDULED") continue;
    if (mergedInto.has(event.aggregate_id)) {
      violations.push({
        type: "DUPLICATE_OCCUPIES_SLOT",
        message: `重复推单 ${event.aggregate_id} 已归并到 ${mergedInto.get(event.aggregate_id)}，不得另行锁定号源`,
        case_ids: [event.aggregate_id],
      });
    }
  }

  return {
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
    violations,
    merged: Object.fromEntries(mergedInto),
  };
}
