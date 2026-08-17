export enum LogLevel {
  TRACE = 'TRACE',
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  FLOW = 'FLOW',
  API = 'API',
  STATE = 'STATE',
  REMINDER = 'REMINDER',
}

export const TERMINAL_LOG_LEVELS = new Set<LogLevel>([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.INFO,
  LogLevel.REMINDER,
])

export const DEBUG_VERBOSE_TERMINAL_LOG_LEVELS = new Set<LogLevel>([
  LogLevel.ERROR,
  LogLevel.WARN,
  LogLevel.FLOW,
  LogLevel.API,
  LogLevel.STATE,
  LogLevel.INFO,
  LogLevel.REMINDER,
])

export const USER_FRIENDLY_LEVELS = new Set<string>([
  'SESSION_START',
  'QUERY_START',
  'QUERY_PROGRESS',
  'QUERY_COMPLETE',
  'TOOL_EXECUTION',
  'ERROR_OCCURRED',
  'PERFORMANCE_SUMMARY',
])
