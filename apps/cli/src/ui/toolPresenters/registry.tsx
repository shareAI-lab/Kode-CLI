import * as React from 'react'
import { Text } from 'ink'

import type { Tool } from '#core/tooling/Tool'
import { truncateTextForDisplay } from '#core/utils/toolOutputDisplay'
import { FallbackToolUseRejectedMessage } from '#ui-ink/components/FallbackToolUseRejectedMessage'

import { renderGlobToolResultMessage } from './GlobToolPresenter'
import { renderTaskStopToolResultMessage } from './TaskStopToolPresenter'
import { renderTaskOutputToolResultMessage } from './TaskOutputToolPresenter'
import {
  renderFileEditToolResultMessage,
  renderFileEditToolUseRejectedMessage,
} from './FileEditToolPresenter'
import {
  renderFileWriteToolResultMessage,
  renderFileWriteToolUseRejectedMessage,
} from './FileWriteToolPresenter'
import { renderWebSearchToolResultMessage } from './WebSearchToolPresenter'

type ResultOptions = { verbose: boolean }
type RejectOptions = {
  columns: number
  verbose: boolean
  conversationKey: string
}

type InkToolPresenter = {
  renderToolResultMessage?: (
    output: unknown,
    options: ResultOptions,
  ) => React.ReactNode
  renderToolUseRejectedMessage?: (
    input: unknown,
    options: RejectOptions,
  ) => React.ReactNode
}

const MAX_INLINE_TOOL_RESULT_LINES = 80
const MAX_INLINE_TOOL_RESULT_CHARS = 8_000

const inkPresentersByToolName: Record<string, InkToolPresenter> = {
  Glob: {
    renderToolResultMessage: output =>
      renderGlobToolResultMessage(
        output as Parameters<typeof renderGlobToolResultMessage>[0],
      ),
  },
  TaskStop: {
    renderToolResultMessage: output =>
      renderTaskStopToolResultMessage(
        output as Parameters<typeof renderTaskStopToolResultMessage>[0],
      ),
  },
  TaskOutput: {
    renderToolResultMessage: (output, options) =>
      renderTaskOutputToolResultMessage(
        output as Parameters<typeof renderTaskOutputToolResultMessage>[0],
        options,
      ),
  },
  Edit: {
    renderToolResultMessage: (output, options) =>
      renderFileEditToolResultMessage(
        output as Parameters<typeof renderFileEditToolResultMessage>[0],
        options,
      ),
    renderToolUseRejectedMessage: (input, options) =>
      renderFileEditToolUseRejectedMessage(
        input as Parameters<typeof renderFileEditToolUseRejectedMessage>[0],
        options,
      ),
  },
  Write: {
    renderToolResultMessage: (output, options) =>
      renderFileWriteToolResultMessage(
        output as Parameters<typeof renderFileWriteToolResultMessage>[0],
        options,
      ),
    renderToolUseRejectedMessage: (input, options) =>
      renderFileWriteToolUseRejectedMessage(
        input as Parameters<typeof renderFileWriteToolUseRejectedMessage>[0],
        options,
      ),
  },
  WebSearch: {
    renderToolResultMessage: (output, options) =>
      renderWebSearchToolResultMessage(output, options),
  },
  web_search: {
    renderToolResultMessage: (output, options) =>
      renderWebSearchToolResultMessage(output, options),
  },
}

function normalizePrimitiveInkToolRenderOutput(
  value: string | number,
  options: ResultOptions,
  key?: React.Key,
): React.ReactNode {
  const text = normalizePrimitiveInkToolRenderChild(value, options)

  return key === undefined ? <Text>{text}</Text> : <Text key={key}>{text}</Text>
}

function normalizePrimitiveInkToolRenderChild(
  value: string | number,
  options: ResultOptions,
): string {
  const rawText = String(value)
  return options.verbose
    ? rawText
    : truncateTextForDisplay(rawText, {
        maxLines: MAX_INLINE_TOOL_RESULT_LINES,
        maxChars: MAX_INLINE_TOOL_RESULT_CHARS,
      }).text
}

function normalizeInkToolRenderChild(
  node: React.ReactNode,
  options: ResultOptions,
): React.ReactNode {
  if (typeof node === 'string' || typeof node === 'number') {
    return normalizePrimitiveInkToolRenderChild(node, options)
  }

  if (Array.isArray(node)) {
    return node.map(child => normalizeInkToolRenderChild(child, options))
  }

  if (!React.isValidElement(node)) {
    return node
  }

  const props = node.props as { children?: React.ReactNode }
  if (props.children === undefined) {
    return node
  }

  return React.cloneElement(
    node as React.ReactElement<{ children?: React.ReactNode }>,
    undefined,
    normalizeInkToolRenderChild(props.children, options),
  )
}

function normalizeInkToolRenderOutput(
  node: unknown,
  options: ResultOptions,
): React.ReactNode {
  if (typeof node === 'string' || typeof node === 'number') {
    return normalizePrimitiveInkToolRenderOutput(node, options)
  }

  if (Array.isArray(node)) {
    return node.map((child, index) =>
      typeof child === 'string' || typeof child === 'number'
        ? normalizePrimitiveInkToolRenderOutput(child, options, `text-${index}`)
        : normalizeInkToolRenderChild(child, options),
    )
  }

  if (React.isValidElement(node)) {
    return normalizeInkToolRenderChild(node, options)
  }

  return node as React.ReactNode
}

export function renderInkToolResultMessage(
  tool: Tool,
  output: unknown,
  options: ResultOptions,
): React.ReactNode {
  const presenter = inkPresentersByToolName[tool.name]
  if (presenter?.renderToolResultMessage) {
    return normalizeInkToolRenderOutput(
      presenter.renderToolResultMessage(output, options),
      options,
    )
  }
  return normalizeInkToolRenderOutput(
    tool.renderToolResultMessage?.(output, options) ?? null,
    options,
  )
}

export function renderInkToolUseRejectedMessage(
  tool: Tool,
  input: unknown,
  options: RejectOptions,
): React.ReactNode {
  const presenter = inkPresentersByToolName[tool.name]
  if (presenter?.renderToolUseRejectedMessage) {
    const node = presenter.renderToolUseRejectedMessage(input, options)
    return normalizeInkToolRenderOutput(
      node ?? <FallbackToolUseRejectedMessage />,
      options,
    )
  }

  if (typeof tool.renderToolUseRejectedMessage === 'function') {
    const node = tool.renderToolUseRejectedMessage(input, options)
    return normalizeInkToolRenderOutput(
      node ?? <FallbackToolUseRejectedMessage />,
      options,
    )
  }

  return <FallbackToolUseRejectedMessage />
}
