import { Box, Text } from 'ink'
import * as React from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import figures from 'figures'
import { getTheme } from '#core/utils/theme'
import {
  getGlobalConfigCached,
  type ModelPointerType,
  setModelPointer,
} from '#core/utils/config'
import { getModelManager, reloadModelManager } from '#core/utils/model'
import { useKeypress } from '#ui-ink/hooks/useKeypress'
import { useTerminalSize } from '#ui-ink/hooks/useTerminalSize'
import TextInput from '#ui-ink/components/TextInput'
import { Select } from '#ui-ink/components/CustomSelect/select'
import { ScreenFrame } from '#ui-ink/primitives/layout/ScreenFrame'
import { KEYPRESS_PRIORITY } from '#ui-ink/constants/keypressPriority'
import { ModelListManager } from './ModelListManager'
import { LoginScreen } from './LoginScreen'
import { useScopedIndexState } from '#ui-ink/hooks/useScopedIndexState'

type Props = {
  onClose: () => void
}

type MenuItem =
  | {
      type: 'pointer'
      pointer: ModelPointerType
      label: string
      description: string
    }
  | {
      type: 'action'
      id: 'connect-provider' | 'manage-models'
      label: string
      description: string
    }

const POINTER_ITEMS: Array<MenuItem & { type: 'pointer' }> = [
  {
    type: 'pointer',
    pointer: 'main',
    label: 'Main',
    description: 'Primary model for general tasks and conversations',
  },
  {
    type: 'pointer',
    pointer: 'task',
    label: 'Task',
    description: 'Model for TaskTool sub-agents and automation',
  },
  {
    type: 'pointer',
    pointer: 'compact',
    label: 'Compact',
    description:
      'Model used for context compression when nearing the context window',
  },
  {
    type: 'pointer',
    pointer: 'quick',
    label: 'Quick',
    description: 'Fast model for small operations and utilities',
  },
]

function clampIndex(value: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(value, length - 1))
}

function formatModelLabel(model: {
  name: string
  modelName: string
  provider: string
}): string {
  const provider = model.provider ? ` · ${model.provider}` : ''
  return `${model.name}${provider}`
}

export function ModelConfig({ onClose }: Props): React.ReactNode {
  const theme = getTheme()
  const config = getGlobalConfigCached()
  const modelManager = getModelManager()
  const { rows, columns } = useTerminalSize()
  const tightLayout = rows <= 18 || columns <= 72
  const compactLayout = tightLayout || rows <= 22
  const paddingY = tightLayout ? 0 : 1
  const gap = tightLayout ? 0 : 1
  const paddingX = tightLayout || compactLayout ? 1 : 2

  const [refreshKey, setRefreshKey] = useState(0)
  const [showModelListManager, setShowModelListManager] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [activePointer, setActivePointer] = useState<ModelPointerType | null>(
    null,
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCursorOffset, setSearchCursorOffset] = useState(0)
  const didCloseRef = useRef(false)

  const safeOnClose = useCallback(() => {
    if (didCloseRef.current) return
    didCloseRef.current = true
    onClose()
  }, [onClose])

  const models = useMemo(() => {
    void refreshKey
    const all = modelManager.getAvailableModels()
    return [...all].sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0))
  }, [modelManager, refreshKey])

  const menuItems: MenuItem[] = useMemo(
    () => [
      ...POINTER_ITEMS,
      {
        type: 'action',
        id: 'connect-provider',
        label: 'Connect provider',
        description: 'Sign in with OAuth or add an API-key model profile.',
      },
      {
        type: 'action',
        id: 'manage-models',
        label: 'Model Library',
        description: 'View, add, and delete model profiles',
      },
    ],
    [],
  )
  const [selectedIndex, setSelectedIndex] = useScopedIndexState({
    scope: 'model-config:pointers',
    itemCount: menuItems.length,
  })

  const closePointerPicker = useCallback(() => {
    setActivePointer(null)
    setSearchQuery('')
    setSearchCursorOffset(0)
  }, [])

  const setPointer = useCallback(
    (pointer: ModelPointerType, modelName: string) => {
      modelManager.setPointer(pointer, modelName)
      reloadModelManager()
      setRefreshKey(prev => prev + 1)
    },
    [modelManager],
  )

  const clearPointer = useCallback((pointer: ModelPointerType) => {
    setModelPointer(pointer, '')
    reloadModelManager()
    setRefreshKey(prev => prev + 1)
  }, [])

  useKeypress(
    (input, key) => {
      if (didCloseRef.current) return true

      if (showLogin) return undefined

      if (showModelListManager) {
        if (key.escape) {
          setShowModelListManager(false)
          setRefreshKey(prev => prev + 1)
          return true
        }
        return undefined
      }

      const inputChar = input.length === 1 ? input : ''
      const isUp = key.upArrow || inputChar === 'k'
      const isDown = key.downArrow || inputChar === 'j'
      const isHome = key.home
      const isEnd = key.end
      const isConfirm = key.return

      if (activePointer) {
        if (key.escape) {
          closePointerPicker()
          return true
        }
        if (key.ctrl && inputChar.toLowerCase() === 'd') {
          clearPointer(activePointer)
          closePointerPicker()
          return true
        }
        return undefined
      }

      if (key.escape) {
        safeOnClose()
        return true
      }

      if (isHome) {
        setSelectedIndex(0)
        return true
      }
      if (isEnd) {
        setSelectedIndex(menuItems.length - 1)
        return true
      }
      if (isUp) {
        setSelectedIndex(prev => clampIndex(prev - 1, menuItems.length))
        return true
      }
      if (isDown) {
        setSelectedIndex(prev => clampIndex(prev + 1, menuItems.length))
        return true
      }

      if (inputChar === 'c') {
        const item = menuItems[selectedIndex]
        if (item?.type === 'pointer') {
          clearPointer(item.pointer)
          return true
        }
      }

      if (isConfirm) {
        const item = menuItems[selectedIndex]
        if (!item) return true

        if (item.type === 'pointer') {
          if (models.length === 0) {
            setShowModelListManager(true)
            return true
          }
          setActivePointer(item.pointer)
          setSearchQuery('')
          setSearchCursorOffset(0)
          return true
        }

        if (item.type === 'action' && item.id === 'manage-models') {
          setShowModelListManager(true)
          return true
        }

        if (item.type === 'action' && item.id === 'connect-provider') {
          setShowLogin(true)
          return true
        }
      }
      return undefined
    },
    { isActive: true, priority: KEYPRESS_PRIORITY.FULLSCREEN_OVERLAY },
  )

  if (showModelListManager) {
    return (
      <ModelListManager
        onClose={() => {
          setShowModelListManager(false)
          setRefreshKey(prev => prev + 1)
        }}
      />
    )
  }

  if (showLogin) {
    const returnToModelConfig = () => {
      reloadModelManager()
      setRefreshKey(prev => prev + 1)
      setShowLogin(false)
    }

    return (
      <LoginScreen
        onDone={returnToModelConfig}
        onCancel={returnToModelConfig}
      />
    )
  }

  if (activePointer) {
    const currentValue = config.modelPointers?.[activePointer] || ''
    const query = searchQuery.trim().toLowerCase()
    const filtered = query
      ? models.filter(m => {
          const haystack =
            `${m.name} ${m.modelName} ${m.provider}`.toLowerCase()
          return haystack.includes(query)
        })
      : models

    const options = filtered.map(m => ({
      label: formatModelLabel(m),
      value: m.modelName,
    }))

    const reservedLines =
      (tightLayout ? 10 : compactLayout ? 12 : 14) + paddingY * 2 + gap * 4
    const availableForList = Math.max(3, rows - reservedLines - 2)
    const visibleOptionCount = Math.max(
      3,
      Math.min(12, options.length || 12, availableForList),
    )

    return (
      <ScreenFrame
        title={`Set ${activePointer} model`}
        paddingX={paddingX}
        paddingY={paddingY}
        gap={gap}
      >
        <Box flexDirection="column" gap={gap}>
          {!tightLayout && (
            <Text dimColor>
              Search and select the model profile to assign to this pointer.
            </Text>
          )}

          <Box flexDirection="column">
            <Text dimColor>Filter:</Text>
            <TextInput
              placeholder="Type to filter models…"
              value={searchQuery}
              onChange={value => {
                setSearchQuery(value)
                setSearchCursorOffset(value.length)
              }}
              columns={Math.max(1, Math.min(80, columns - 10))}
              cursorOffset={searchCursorOffset}
              onChangeCursorOffset={setSearchCursorOffset}
              showCursor={true}
              focus={true}
              disableCursorMovementForUpDownKeys={true}
            />
          </Box>

          {options.length > 0 ? (
            <Select
              focusScope={`model-config:${activePointer}`}
              options={options}
              defaultValue={currentValue || undefined}
              highlightText={query || undefined}
              visibleOptionCount={visibleOptionCount}
              onChange={value => {
                setPointer(activePointer, value)
                closePointerPicker()
              }}
            />
          ) : (
            <Text color={theme.warning}>
              No models match your filter. Try a different query.
            </Text>
          )}

          <Box marginTop={tightLayout ? 0 : 1}>
            <Text dimColor wrap="truncate-end">
              ↑/↓ navigate · Enter select · Esc back · Ctrl+D clear pointer
            </Text>
          </Box>
        </Box>
      </ScreenFrame>
    )
  }

  const selectedItem = menuItems[selectedIndex]

  return (
    <ScreenFrame
      title="Models"
      paddingX={paddingX}
      paddingY={paddingY}
      gap={gap}
    >
      <Box flexDirection="column" gap={gap}>
        <Text dimColor>
          Select role models, connect OAuth providers, and manage profiles.
        </Text>

        <Box flexDirection="column">
          {menuItems.map((item, index) => {
            const isSelected = index === selectedIndex
            const pointerValue =
              item.type === 'pointer'
                ? config.modelPointers?.[item.pointer]
                : ''
            const profile =
              item.type === 'pointer' && pointerValue
                ? models.find(m => m.modelName === pointerValue)
                : null
            const valueText =
              item.type === 'pointer'
                ? profile
                  ? `${profile.name} (${profile.provider})`
                  : pointerValue
                    ? pointerValue
                    : '(not set)'
                : ''

            return (
              <Box key={item.type === 'action' ? item.id : item.pointer}>
                <Text color={isSelected ? theme.kode : theme.secondaryText}>
                  {isSelected ? figures.pointer : ' '}
                </Text>
                <Text
                  color={isSelected ? theme.text : theme.secondaryText}
                  bold={isSelected}
                  wrap="truncate-end"
                >
                  {' '}
                  {item.label}
                  {item.type === 'pointer' ? `: ${valueText}` : ''}
                </Text>
              </Box>
            )
          })}
        </Box>

        {!tightLayout && selectedItem ? (
          <Box paddingLeft={2}>
            <Text dimColor wrap="truncate-end">
              {selectedItem.description}
            </Text>
          </Box>
        ) : null}

        <Box marginTop={tightLayout ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            ↑/↓ or j/k · Enter open · c clear pointer · Esc exit
          </Text>
        </Box>
      </Box>
    </ScreenFrame>
  )
}
