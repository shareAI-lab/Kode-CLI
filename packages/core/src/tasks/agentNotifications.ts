import {
  listBackgroundAgentTaskSnapshots,
  markBackgroundAgentTaskNotified,
  type BackgroundAgentStatus,
} from '#core/utils/backgroundTasks'
import { getTaskOutputFilePath } from '#runtime/taskOutputStore'

export type BackgroundAgentNotification = {
  type: 'agent_notification'
  taskId: string
  taskType: 'local_agent'
  description: string
  status: Exclude<BackgroundAgentStatus, 'running'>
  outputFile: string
  error?: string
}

export function flushBackgroundAgentNotifications(
  options: { sessionId?: string } = {},
): BackgroundAgentNotification[] {
  const notifications: BackgroundAgentNotification[] = []

  for (const task of listBackgroundAgentTaskSnapshots()) {
    if (task.status === 'running' || task.notified) continue
    if (
      options.sessionId !== undefined &&
      task.sessionId !== options.sessionId
    ) {
      continue
    }

    notifications.push({
      type: 'agent_notification',
      taskId: task.agentId,
      taskType: 'local_agent',
      description: task.description,
      status: task.status,
      outputFile: getTaskOutputFilePath(task.agentId),
      ...(task.error ? { error: task.error } : {}),
    })
    markBackgroundAgentTaskNotified(task.agentId)
  }

  return notifications
}

export function renderBackgroundAgentNotification(
  notification: BackgroundAgentNotification,
): string {
  const summarySuffix =
    notification.status === 'completed'
      ? 'completed'
      : notification.status === 'failed'
        ? 'failed'
        : 'was killed'

  return [
    '<task-notification>',
    `<task-id>${notification.taskId}</task-id>`,
    `<task-type>${notification.taskType}</task-type>`,
    `<output-file>${notification.outputFile}</output-file>`,
    `<status>${notification.status}</status>`,
    `<summary>Background agent "${notification.description}" ${summarySuffix}</summary>`,
    '</task-notification>',
    `Read the output file to retrieve the result: ${notification.outputFile}`,
  ].join('\n')
}
