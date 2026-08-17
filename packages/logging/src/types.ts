import type { LogLevel } from './levels'

export interface LogEntry {
  timestamp: string
  level: LogLevel
  phase: string
  requestId?: string
  data: unknown
  elapsed?: number
}

export interface ErrorDiagnosis {
  errorType: string
  category:
    'NETWORK' | 'API' | 'PERMISSION' | 'CONFIG' | 'SYSTEM' | 'USER_INPUT'
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  description: string
  suggestions: string[]
  debugSteps: string[]
  relatedLogs?: string[]
}
