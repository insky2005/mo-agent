/**
 * 事件名的唯一事实源已经移到 core/contract.mjs。
 * 这里保留旧的导入路径，避免一次性改所有文件。
 */
export {
  EVENT,
  LEGACY_ALIASES,
  EVENT_META,
  SILENT_EVENTS,
  STATE_EVENTS,
  SIGNAL_EVENTS,
  SEVERITY,
  NOTIFY_POLICY,
  canonicalEventType,
  isKnownEventType,
  makeRunId,
  withPrefix,
  clip,
  describeQuestion,
  missingFields,
  TERMINAL_STATUSES,
  hasResponseText,
  canControl,
} from "./contract.mjs";
