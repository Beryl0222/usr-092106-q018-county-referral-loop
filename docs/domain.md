# 县域转诊闭环 · 领域说明

会诊转诊中心的后端把一次县域转诊从**基层推单**贯穿到**回访关闭**：基层医生、患者行程、
前置病情、到院再评估、专科容量、陪诊任务、住院决定、下转接收、用药复查与回访都在同一条
事件流上。本文档与 `src/catalog.js`、`contracts/domain.schema.json` 共同构成领域契约。

## 角色

| 角色 | 职责 |
| --- | --- |
| `sending_doctor` 基层医生 | 发起上转/下转接收，交接病情与用药 |
| `receiving_doctor` 专科医生 | 到院再评估、风险升级、绿通抢占、住院决定（系统不得替代） |
| `county_center_nurse` 转诊管家 | 排程、容量协调、联络升级、分派陪诊、复查督办 |
| `escort_nurse` 陪诊护士 | 现场陪诊、检查协调、寻人、方言居间联络 |
| `patient_family` 家属 | 补充行程信息 |
| `system` | 仅生成复查到期等提醒，不做临床判断 |

系统只**记录与提示**：诊断、风险升级、住院/留观决定必须由医护 actor 发起；
`RISK_ESCALATED`、`OBSERVATION_DIVERGENCE_RECORDED`、`GREEN_CHANNEL_PREEMPTED`、
`ADMISSION_DECIDED`、`RETURN_PLANNED` 均强制医护角色。

## 聚合与事件流

四个聚合（`aggregate_type`）：

- `referral_case` 转诊病例主线；
- `arrival_assessment` 到院再评估（与原单可并存）；
- `care_task` 陪诊/协调任务（分派 → 完成）；
- `return_handoff` 下转接收与复查随访。

完整生命周期事件（详见 `src/catalog.js` 的 `EVENTS`）：

```
REFERRAL_RECEIVED（可被 REFERRAL_DUPLICATE_LINKED 归并）
  ├─ APPOINTMENT_SCHEDULED / APPOINTMENT_RESCHEDULED（跨日改约）
  ├─ PATIENT_TRIP_RECORDED
  ├─ CONTACT_ESCALATION_OPENED → RESOLVED（未到院/方言/费用/中途离开）
  ▼
ARRIVAL_CONFIRMED
  ├─ RISK_ESCALATED（只能上调；改判走观察分歧）
  ├─ OBSERVATION_DIVERGENCE_RECORDED（两份记录同时保留）
  ├─ EXAM_CONFLICT_DETECTED → ESCORT_TASK_ASSIGNED → CARE_TASK_COMPLETED
  └─ GREEN_CHANNEL_PREEMPTED（危急可超普通容量，须说明原因）
  ▼
ADMISSION_DECIDED（admitted / observation / outpatient）
  ▼
RETURN_PLANNED → RETURN_ACCEPTED
  ▼
FOLLOWUP_SCHEDULED → FOLLOWUP_DUE → FOLLOWUP_COMPLETED（reached=false 即重开联络升级）
```

## 关键不变量

1. **事件只追加、不改写。** `event_id` 全局唯一；同一 `aggregate_id` 内 `version` 从 1
   严格递增，`occurred_at` 不倒退。业务更正产生后继事件并用 `linked_event_ids` 关联。
2. **现场观察与原单不一致，两份同时保留。** 原 `REFERRAL_RECEIVED` 不修改，
   `OBSERVATION_DIVERGENCE_RECORDED` 承载现场观察、按新风险分流
   （例：原单“胃炎”，现场疑主动脉夹层，按危急走急诊）。
3. **重复推单、跨日改约只占一次容量。** 重复单经 `REFERRAL_DUPLICATE_LINKED` 归并到原单
   容量桶，不得另行锁号；改约释放旧容量位、占用新位，全程一位。
4. **绿通可抢占但必须留痕。** `GREEN_CHANNEL_PREEMPTED` 必须填写 `preempt_reason`，
   被挤占的普通病例必须随后出现 `APPOINTMENT_RESCHEDULED`，不得悬空。
5. **联络升级是显式状态。** 未到院（`no_show`）、无法接通（`unreachable`）、方言
   （`dialect`）、费用顾虑（`cost_concern`）、中途离开（`left_midway`）、到院找不到对接
   （`wrong_department`）都开启 `CONTACT_ESCALATION_OPENED`，带下一步动作与责任岗位；
   下转后回访 `reached=false` 同样重开升级，杜绝“康复下转后失联”。
6. **检查冲突以任务完成核销。** 分派协调任务只表示“有人负责”，冲突仍留在看板上，
   直到 `CARE_TASK_COMPLETED`（可带 `resolves`）才核销。
7. **最小知情。** 无关诊所与病例完全隔离（整条事件/看板行不下发）；诊疗信息仅中心、
   接诊医生与有连续照护关系的基层可见；陪诊护士可见姓名电话与风险等级以履行找人接人，
   见不到诊断、病史、用药与复查结果。

## 早班看板

`buildBoard(events, { now })` 在任意时点折叠出转诊管家的工作清单：

| 清单 | 进入条件 |
| --- | --- |
| `risk_upgraded` | 已到院、现场风险上调或观察分歧、尚无住院决定 |
| `late` | 预计到院时间已过未到院（未到院升级在此显形）；或已到院但中途离开 |
| `expected` | 今日预计到院、尚未到院 |
| `exam_conflicts` | 未核销的检查冲突（任务分派不核销，完成才核销） |
| `pending_return` | 已开下转计划、基层尚未接收 |
| `followup_due` | 复查/回访今日到期或已逾期、未完成 |
| `contact_escalations` | 其余未闭环升级（方言、费用、回访失联等） |

每条都带 `next_step`（下一步动作、责任岗位/人、联络电话、截止时间），
管家从清单直接联系责任方，不再依赖电话与便签追进度。重复推单归并后只显示原病例。

## 本地校验

```bash
node --test
```

校验分三层：

- `validateEvent`：信封、事件专属字段、枚举/时间格式、发起角色、风险只能上调；
- `validateStream`：事件唯一、版本连续、时间不倒退、任务/升级/复查引用可追溯；
- `buildCapacityLedger`：容量桶占用、普通超容、抢占无原因、被抢占方未改约、重复单占号。
