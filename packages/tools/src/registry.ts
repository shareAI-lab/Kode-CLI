import { memoize } from 'lodash-es'
import { resolveToolDescription, type Tool } from '@kode/tool-interface/Tool'

import { AskExpertModelTool } from '#tools/tools/ai/AskExpertModelTool/AskExpertModelTool'
import { AskUserQuestionTool } from '#tools/tools/interaction/AskUserQuestionTool/AskUserQuestionTool'
import { BashTool } from '#tools/tools/system/BashTool/BashTool'
import { TaskOutputTool } from '#tools/tools/system/TaskOutputTool/TaskOutputTool'
import { TaskGuideTool } from '#tools/tools/system/TaskGuideTool/TaskGuideTool'
import { TaskMonitorTool } from '#tools/tools/system/TaskMonitorTool/TaskMonitorTool'
import { EnterPlanModeTool } from '#tools/tools/interaction/PlanModeTool/EnterPlanModeTool'
import { ExitPlanModeTool } from '#tools/tools/interaction/PlanModeTool/ExitPlanModeTool'
import { TaskCreateTool } from '#tools/tools/interaction/TaskCreateTool/TaskCreateTool'
import { TaskGetTool } from '#tools/tools/interaction/TaskGetTool/TaskGetTool'
import { TaskListTool } from '#tools/tools/interaction/TaskListTool/TaskListTool'
import { TaskUpdateTool } from '#tools/tools/interaction/TaskUpdateTool/TaskUpdateTool'
import { FileEditTool } from '#tools/tools/filesystem/FileEditTool/FileEditTool'
import { FileReadTool } from '#tools/tools/filesystem/FileReadTool/FileReadTool'
import { FileWriteTool } from '#tools/tools/filesystem/FileWriteTool/FileWriteTool'
import { GlobTool } from '#tools/tools/filesystem/GlobTool/GlobTool'
import { LSTool } from '#tools/tools/filesystem/LSTool/LSTool'
import { GrepTool } from '#tools/tools/search/GrepTool/GrepTool'
import { TaskStopTool } from '#tools/tools/system/TaskStopTool/TaskStopTool'
import { ListMcpResourcesTool } from '#tools/tools/mcp/ListMcpResourcesTool/ListMcpResourcesTool'
import { LspTool } from '#tools/tools/system/LspTool/LspTool'
import { MCPTool } from '#tools/tools/mcp/MCPTool/MCPTool'
import { MCPSearchTool } from '#tools/tools/mcp/MCPSearchTool/MCPSearchTool'
import { NotebookEditTool } from '#tools/tools/filesystem/NotebookEditTool/NotebookEditTool'
import { ReadMcpResourceTool } from '#tools/tools/mcp/ReadMcpResourceTool/ReadMcpResourceTool'
import { SlashCommandTool } from '#tools/tools/interaction/SlashCommandTool/SlashCommandTool'
import { SkillTool } from '#tools/tools/interaction/SkillTool/SkillTool'
import { SessionMessageTool } from '#tools/tools/interaction/SessionMessageTool/SessionMessageTool'
import { TaskTool } from '#tools/tools/ai/TaskTool/TaskTool'
import { TaskBatchTool } from '#tools/tools/ai/TaskBatchTool/TaskBatchTool'
import { TodoWriteTool } from '#tools/tools/interaction/TodoWriteTool/TodoWriteTool'
import { WebFetchTool } from '#tools/tools/network/WebFetchTool/WebFetchTool'
import { WebSearchTool } from '#tools/tools/search/WebSearchTool/WebSearchTool'

import { getMCPTools, getMcpListChangedVersion } from '#core/mcp/client'

// Base tool list for the CLI toolset
export const getAllTools = (): Tool[] => [
  TaskTool as unknown as Tool,
  TaskBatchTool as unknown as Tool,
  AskExpertModelTool as unknown as Tool,
  BashTool as unknown as Tool,
  TaskOutputTool as unknown as Tool,
  TaskMonitorTool as unknown as Tool,
  TaskGuideTool as unknown as Tool,
  TaskStopTool as unknown as Tool,
  LSTool as unknown as Tool,
  GlobTool as unknown as Tool,
  GrepTool as unknown as Tool,
  LspTool as unknown as Tool,
  FileReadTool as unknown as Tool,
  FileEditTool as unknown as Tool,
  FileWriteTool as unknown as Tool,
  NotebookEditTool as unknown as Tool,
  TaskCreateTool as unknown as Tool,
  TaskListTool as unknown as Tool,
  TaskGetTool as unknown as Tool,
  TaskUpdateTool as unknown as Tool,
  TodoWriteTool as unknown as Tool,
  WebSearchTool as unknown as Tool,
  WebFetchTool as unknown as Tool,
  AskUserQuestionTool as unknown as Tool,
  EnterPlanModeTool as unknown as Tool,
  ExitPlanModeTool as unknown as Tool,
  SlashCommandTool as unknown as Tool,
  SkillTool as unknown as Tool,
  SessionMessageTool as unknown as Tool,
  ListMcpResourcesTool as unknown as Tool,
  ReadMcpResourceTool as unknown as Tool,
  MCPSearchTool as unknown as Tool,
  MCPTool as unknown as Tool,
]

export const getTools = memoize(
  async (_includeOptional?: boolean): Promise<Tool[]> => {
    const tools = [...getAllTools(), ...(await getMCPTools())]

    const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
    const enabledTools = tools.filter((_, i) => isEnabled[i])

    // Populate cachedDescription for adapters that require synchronous access.
    await Promise.all(enabledTools.map(tool => resolveToolDescription(tool)))

    return enabledTools
  },
  (_includeOptional?: boolean) =>
    `${_includeOptional ?? ''}:mcp-tools@${getMcpListChangedVersion('tools')}`,
)

export const getReadOnlyTools = memoize(async (): Promise<Tool[]> => {
  const tools = getAllTools().filter(tool => tool.isReadOnly())
  const isEnabled = await Promise.all(tools.map(tool => tool.isEnabled()))
  const enabledTools = tools.filter((_, index) => isEnabled[index])

  // Populate cachedDescription for adapters that require synchronous access.
  await Promise.all(enabledTools.map(tool => resolveToolDescription(tool)))

  return enabledTools
})
