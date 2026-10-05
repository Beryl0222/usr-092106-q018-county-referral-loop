// 县域转诊闭环后端领域层统一入口。
export * from "./catalog.js";
export { validateEvent, validateStream } from "./validator.js";
export { buildCapacityLedger } from "./capacity.js";
export { buildBoard } from "./board.js";
export { buildRelations, visibilityForCase, redactEvent, redactBoard } from "./access.js";
