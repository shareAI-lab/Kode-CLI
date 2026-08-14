export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  subject: string
  description: string
  activeForm?: string
  status: TaskStatus
  owner?: string
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
}

export type TaskSummary = {
  id: string
  subject: string
  status: TaskStatus
  owner?: string
  blockedBy: string[]
}

export type TaskUpdate = Partial<
  Pick<
    Task,
    'subject' | 'description' | 'activeForm' | 'status' | 'owner' | 'metadata'
  >
>
