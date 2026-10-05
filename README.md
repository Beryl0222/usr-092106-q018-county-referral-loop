# 县域转诊闭环

福鼎市医院会诊转诊中心的县域转诊后端领域层：把**基层医生、患者行程、前置病情、到院再评估、
专科容量、陪诊任务、住院决定、下转接收、用药复查与回访**贯穿在同一条只追加的事件流上，
为转诊管家的早班工作提供看板、容量账与最小知情访问控制。

## 目录

- `contracts/domain.schema.json`：事件信封契约（事件类型、聚合、发起角色）。
- `src/catalog.js`：领域事件目录（唯一事实源：事件、聚合、载荷字段、敏感分级、允许角色）。
- `src/validator.js`：单事件与事件流校验（标识唯一、版本连续、医护职权等不变量）。
- `src/capacity.js`：容量账（重复推单/跨日改约只占一次、绿通抢占留痕）。
- `src/board.js`：早班看板投影（预计到院、迟到、风险升级、检查冲突、待下转、复查到期 +
  联络升级区，每条带下一步动作与责任方）。
- `src/access.js`：最小知情过滤（无关诊所整条不可见；诊疗字段按角色脱敏）。
- `data/sample.json`：单事件联调样例；`data/scenario.json`：覆盖全流程的早班场景。
- `docs/domain.md`：领域说明、生命周期与不变量清单。
- `tests/`：上述规则的 `node:test` 用例。

## 领域边界

事件一旦被接收，其标识、发生时间和版本不被原地改写；业务更正产生后继记录
（用 `linked_event_ids` 关联）。现场观察与原单不一致时，原单与现场观察两份记录同时保留，
并按新风险分流（`OBSERVATION_DIVERGENCE_RECORDED`）。系统只记录与提示，不替代护士和医生：
风险升级、绿通抢占、住院与下转决定必须由医护人员发起。

未到院、无法接通、方言沟通、费用顾虑、中途离开都进入显式的联络升级
（`CONTACT_ESCALATION_OPENED`），回访失联同样重开升级。重复推单与跨日改约全程只占一次
容量；危急绿色通道可抢占普通安排，但必须说明原因并为被挤占方完成改约。涉及个人与诊疗
信息时，调用方只读取完成职责所必需的字段，无关诊所看不到他人病例的诊断与联系方式。

## 本地检查

```bash
node --test
```

用场景数据生成早班看板的最小示例：

```js
import { readFile } from "node:fs/promises";
import { buildBoard, redactBoard, buildRelations } from "./src/index.js";

const { events, board_now } = JSON.parse(await readFile("./data/scenario.json", "utf8"));
const board = buildBoard(events, { now: board_now });
// 按视角脱敏：中心护士看全量；基层医生只见与本机构有连续照护关系的病例
const view = redactBoard(board, { role: "sending_doctor", org: "磻溪镇卫生院" }, buildRelations(events));
```
