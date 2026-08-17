import type { Input } from './LspTool'
import {
  formatDocumentSymbolsResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  groupLocationsByFile,
  toProjectRelativeIfPossible,
} from './format'

type Args = {
  input: Input
  absPath: string
  pos: number
  ts: any
  program: any
  service: any
  sourceFile: any
}

type CallHierarchyItem = {
  name?: string
  kind?: string
  kindModifiers?: string
  file?: string
  span?: { start?: number }
  selectionSpan?: { start?: number }
  containerName?: string
}

function formatKind(kind: unknown): string {
  const value = String(kind ?? '')
  return value ? value[0]!.toUpperCase() + value.slice(1) : 'Symbol'
}

function getLine(item: CallHierarchyItem, ts: any, program: any): number {
  const fileName = typeof item.file === 'string' ? item.file : null
  const start = item.selectionSpan?.start ?? item.span?.start
  if (!fileName || typeof start !== 'number') return 1
  const source = program.getSourceFile(fileName)
  if (!source) return 1
  return ts.getLineAndCharacterOfPosition(source, start).line + 1
}

function formatCallHierarchyItem(
  item: CallHierarchyItem,
  ts: any,
  program: any,
): string {
  const name = item.name || '(anonymous)'
  const kind = formatKind(item.kind)
  const file = item.file ? toProjectRelativeIfPossible(item.file) : '<unknown>'
  const detail = item.containerName ? ` [${item.containerName}]` : ''
  return `${name} (${kind}) - ${file}:${getLine(item, ts, program)}${detail}`
}

function formatPreparedCallHierarchy(
  value: CallHierarchyItem | CallHierarchyItem[] | undefined,
  ts: any,
  program: any,
): { formatted: string; resultCount: number; fileCount: number } {
  const items = value ? (Array.isArray(value) ? value : [value]) : []
  if (items.length === 0) {
    return {
      formatted: 'No call hierarchy item found at this position',
      resultCount: 0,
      fileCount: 0,
    }
  }

  const fileCount = new Set(items.map(item => item.file).filter(Boolean)).size
  if (items.length === 1) {
    return {
      formatted: `Call hierarchy item: ${formatCallHierarchyItem(items[0]!, ts, program)}`,
      resultCount: 1,
      fileCount,
    }
  }

  return {
    formatted: [
      `Found ${items.length} call hierarchy items:`,
      ...items.map(item => `  ${formatCallHierarchyItem(item, ts, program)}`),
    ].join('\n'),
    resultCount: items.length,
    fileCount,
  }
}

function formatCallHierarchyCalls(
  calls: Array<{
    from?: CallHierarchyItem
    to?: CallHierarchyItem
    fromSpans?: Array<{ start?: number }>
  }>,
  direction: 'incoming' | 'outgoing',
  ts: any,
  program: any,
  originSourceFile: any,
): { formatted: string; resultCount: number; fileCount: number } {
  const itemKey = direction === 'incoming' ? 'from' : 'to'
  const label = direction === 'incoming' ? 'incoming' : 'outgoing'
  const emptyMessage =
    direction === 'incoming'
      ? 'No incoming calls found (nothing calls this function)'
      : 'No outgoing calls found (this function calls nothing)'
  const validCalls = calls.filter(call => call[itemKey])
  if (validCalls.length === 0) {
    return { formatted: emptyMessage, resultCount: 0, fileCount: 0 }
  }

  const grouped = new Map<string, typeof validCalls>()
  for (const call of validCalls) {
    const item = call[itemKey]!
    const file = item.file
      ? toProjectRelativeIfPossible(item.file)
      : '<unknown>'
    const entries = grouped.get(file)
    if (entries) entries.push(call)
    else grouped.set(file, [call])
  }

  const lines = [
    `Found ${validCalls.length} ${label} call${validCalls.length === 1 ? '' : 's'}:`,
  ]
  for (const [file, entries] of grouped) {
    lines.push('', `${file}:`)
    for (const call of entries) {
      const item = call[itemKey]!
      const detail = item.containerName ? ` [${item.containerName}]` : ''
      let text = `  ${item.name || '(anonymous)'} (${formatKind(item.kind)}) - Line ${getLine(item, ts, program)}${detail}`
      const source =
        direction === 'outgoing'
          ? originSourceFile
          : item.file
            ? program.getSourceFile(item.file)
            : undefined
      const refs = (call.fromSpans ?? [])
        .map(span => {
          if (!source || typeof span.start !== 'number') return null
          const pos = ts.getLineAndCharacterOfPosition(source, span.start)
          return `${pos.line + 1}:${pos.character + 1}`
        })
        .filter(Boolean)
      if (refs.length > 0) {
        text +=
          direction === 'incoming'
            ? ` [calls at: ${refs.join(', ')}]`
            : ` [called from: ${refs.join(', ')}]`
      }
      lines.push(text)
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: validCalls.length,
    fileCount: grouped.size,
  }
}

export function runLspOperation({
  input,
  absPath,
  pos,
  ts,
  program,
  service,
  sourceFile,
}: Args): { formatted: string; resultCount: number; fileCount: number } {
  let formatted: string
  let resultCount = 0
  let fileCount = 0

  switch (input.operation) {
    case 'goToDefinition': {
      const defs = service.getDefinitionAtPosition?.(absPath, pos) ?? []
      const locations = defs
        .map((d: any) => {
          const defSourceFile = program.getSourceFile(d.fileName)
          if (!defSourceFile) return null
          const lc = ts.getLineAndCharacterOfPosition(
            defSourceFile,
            d.textSpan.start,
          )
          return {
            fileName: d.fileName,
            line0: lc.line,
            character0: lc.character,
          }
        })
        .filter(Boolean) as Array<{
        fileName: string
        line0: number
        character0: number
      }>
      const res = formatGoToDefinitionResult(locations)
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'goToImplementation': {
      const impls = service.getImplementationAtPosition?.(absPath, pos) ?? []
      const locations = impls
        .map((d: any) => {
          const defSourceFile = program.getSourceFile(d.fileName)
          if (!defSourceFile) return null
          const lc = ts.getLineAndCharacterOfPosition(
            defSourceFile,
            d.textSpan.start,
          )
          return {
            fileName: d.fileName,
            line0: lc.line,
            character0: lc.character,
          }
        })
        .filter(Boolean) as Array<{
        fileName: string
        line0: number
        character0: number
      }>
      const res = formatGoToDefinitionResult(locations)
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'findReferences': {
      const referencedSymbols = service.findReferences?.(absPath, pos) ?? []
      const refs: Array<{
        fileName: string
        line0: number
        character0: number
      }> = []
      for (const sym of referencedSymbols) {
        for (const ref of sym.references ?? []) {
          const refSource = program.getSourceFile(ref.fileName)
          if (!refSource) continue
          const lc = ts.getLineAndCharacterOfPosition(
            refSource,
            ref.textSpan.start,
          )
          refs.push({
            fileName: ref.fileName,
            line0: lc.line,
            character0: lc.character,
          })
        }
      }
      const res = formatFindReferencesResult(refs)
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'hover': {
      const info = service.getQuickInfoAtPosition?.(absPath, pos)
      let text: string | null = null
      let hoverLine0 = input.line - 1
      let hoverCharacter0 = input.character - 1
      if (info) {
        const parts: string[] = []
        const signature = ts.displayPartsToString(info.displayParts ?? [])
        if (signature) parts.push(signature)
        const doc = ts.displayPartsToString(info.documentation ?? [])
        if (doc) parts.push(doc)
        if (info.tags && info.tags.length > 0) {
          for (const tag of info.tags) {
            const tagText = ts.displayPartsToString(tag.text ?? [])
            parts.push(`@${tag.name}${tagText ? ` ${tagText}` : ''}`)
          }
        }
        text = parts.filter(Boolean).join('\n\n')
        const lc = ts.getLineAndCharacterOfPosition(
          sourceFile,
          info.textSpan.start,
        )
        hoverLine0 = lc.line
        hoverCharacter0 = lc.character
      }
      const res = formatHoverResult(text, hoverLine0, hoverCharacter0)
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'documentSymbol': {
      const tree = service.getNavigationTree?.(absPath)
      const lines: string[] = []
      let count = 0

      const kindLabel = (kind: string) => {
        const m = {
          class: 'Class',
          interface: 'Interface',
          enum: 'Enum',
          function: 'Function',
          method: 'Method',
          property: 'Property',
          var: 'Variable',
          let: 'Variable',
          const: 'Constant',
          module: 'Module',
          alias: 'Alias',
          type: 'Type',
        } as Record<string, string>
        return (
          m[kind] ?? (kind ? kind[0]!.toUpperCase() + kind.slice(1) : 'Unknown')
        )
      }

      const walk = (node: any, depth: number) => {
        const children: any[] = node?.childItems ?? []
        for (const child of children) {
          const span = child.spans?.[0]
          if (!span) continue
          const lc = ts.getLineAndCharacterOfPosition(sourceFile, span.start)
          const indent = '  '.repeat(depth)
          const label = kindLabel(child.kind)
          const detail = child.kindModifiers ? ` ${child.kindModifiers}` : ''
          lines.push(
            `${indent}${child.text} (${label})${detail} - Line ${lc.line + 1}`,
          )
          count += 1
          if (child.childItems && child.childItems.length > 0) {
            walk(child, depth + 1)
          }
        }
      }
      walk(tree, 0)

      const res = formatDocumentSymbolsResult(lines, count)
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'workspaceSymbol': {
      const items =
        service.getNavigateToItems?.('', 100, undefined, true, true) ?? []
      if (!items || items.length === 0) {
        formatted =
          'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
        resultCount = 0
        fileCount = 0
        break
      }

      const lines: string[] = [
        `Found ${items.length} symbol${items.length === 1 ? '' : 's'} in workspace:`,
      ]
      const wrappedItems: Array<{ fileName: string; item: any }> = items.map(
        (it: any) => ({
          fileName: it.fileName,
          item: it,
        }),
      )
      const grouped = groupLocationsByFile(wrappedItems)
      for (const [file, itemsInFile] of grouped) {
        lines.push(`\n${file}:`)
        for (const wrapper of itemsInFile) {
          const it = wrapper.item
          const sf = program.getSourceFile(it.fileName)
          if (!sf) continue
          const span = it.textSpan
          const lc = span
            ? ts.getLineAndCharacterOfPosition(sf, span.start)
            : { line: 0, character: 0 }
          const label = it.kind
            ? String(it.kind)[0]!.toUpperCase() + String(it.kind).slice(1)
            : 'Symbol'
          let line = `  ${it.name} (${label}) - Line ${lc.line + 1}`
          if (it.containerName) line += ` in ${it.containerName}`
          lines.push(line)
        }
      }
      formatted = lines.join('\n')
      resultCount = items.length
      fileCount = grouped.size
      break
    }
    case 'prepareCallHierarchy': {
      const res = formatPreparedCallHierarchy(
        service.prepareCallHierarchy?.(absPath, pos),
        ts,
        program,
      )
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'incomingCalls': {
      const res = formatCallHierarchyCalls(
        service.provideCallHierarchyIncomingCalls?.(absPath, pos) ?? [],
        'incoming',
        ts,
        program,
        sourceFile,
      )
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    case 'outgoingCalls': {
      const res = formatCallHierarchyCalls(
        service.provideCallHierarchyOutgoingCalls?.(absPath, pos) ?? [],
        'outgoing',
        ts,
        program,
        sourceFile,
      )
      formatted = res.formatted
      resultCount = res.resultCount
      fileCount = res.fileCount
      break
    }
    default: {
      formatted = `Error performing ${input.operation}: Unsupported operation`
      resultCount = 0
      fileCount = 0
    }
  }

  return { formatted, resultCount, fileCount }
}
