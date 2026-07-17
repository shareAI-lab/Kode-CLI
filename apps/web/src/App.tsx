import React from 'react'
import { CalendarClock, Menu, MessagesSquare, Settings } from 'lucide-react'

import { useChat } from './hooks/useChat'
import { useRuntimeClient } from './hooks/useRuntimeClient'
import { useWorkspaces } from './hooks/useWorkspaces'
import { Sidebar } from './components/Sidebar'
import { ThemeToggle } from './components/ThemeToggle'
import { PermissionModal } from './components/PermissionModal'
import { Button } from './components/ui/button'
import { Sheet, SheetContent, SheetTrigger } from './components/ui/sheet'
import { cn } from './lib/utils'
import { runtimeStatusCompactLabel } from './lib/runtimePresentation'
import {
  clearToken,
  consumeTokenFromUrl,
  loadTokenFromStorage,
  persistToken,
} from './lib/token'
import { ChatPage } from './pages/Chat'
import { ConnectPage } from './pages/Connect'
import { SchedulesPage } from './pages/Schedules'
import { SettingsPage } from './pages/Settings'

type View = 'chat' | 'schedules' | 'settings'

const TERMINAL_VIEWS: readonly {
  value: View
  label: string
  icon: typeof MessagesSquare
}[] = [
  { value: 'chat', label: 'Chat', icon: MessagesSquare },
  { value: 'schedules', label: 'Schedules', icon: CalendarClock },
  { value: 'settings', label: 'Settings', icon: Settings },
]

function runtimeStatusDotLabel(args: {
  runtimeAttached: boolean
  runtimeStatus: string
  running: boolean
}): string {
  return [
    args.runtimeStatus,
    args.runtimeAttached ? 'runtime attached' : 'runtime detached',
    args.running ? 'agent running' : 'agent idle',
  ].join(' | ')
}

function getInitialToken(): string {
  return consumeTokenFromUrl() || loadTokenFromStorage()
}

function baseUrlForClient(): string {
  if (typeof window !== 'undefined' && window.location) {
    return window.location.origin
  }
  return 'http://127.0.0.1:3000'
}

export default function App() {
  const [token, setToken] = React.useState(getInitialToken)
  const [view, setView] = React.useState<View>('chat')
  const [mobileSidebarOpen, setMobileSidebarOpen] = React.useState(false)

  const {
    workspaces,
    workspaceId,
    setWorkspaceId,
    loading: workspacesLoading,
  } = useWorkspaces({ token })

  const { client, restartClient, runtimeAttached, runtimeStatus } =
    useRuntimeClient({
      baseUrl: baseUrlForClient(),
      token,
      workspaceId,
    })

  const chat = useChat({
    client,
    resetKey: workspaceId ?? 'none',
    onNewSession: restartClient,
  })

  const currentWorkspace =
    workspaces.find(w => w.id === workspaceId) ??
    workspaces.find(w => w.isCurrent) ??
    workspaces[0] ??
    null

  const selectedSession =
    chat.sessions.find(s => s.sessionId === chat.selectedSessionId) ?? null
  const selectedSessionTitle =
    selectedSession?.customTitle ||
    selectedSession?.slug ||
    (chat.selectedSessionId ? 'Chat' : 'New session')

  if (!token) {
    return (
      <ConnectPage
        token={token}
        onTokenChange={setToken}
        onSave={() => {
          const next = token.trim()
          if (!next) return
          persistToken(next)
          setToken(next)
        }}
      />
    )
  }

  const sidebar = (
    <Sidebar
      workspaces={workspaces}
      workspaceId={workspaceId}
      onSelectWorkspace={id => {
        setWorkspaceId(id)
        restartClient()
      }}
      sessions={chat.sessions}
      selectedSessionId={chat.selectedSessionId}
      onSelectSession={id => {
        void chat.selectSession(id)
        setView('chat')
        setMobileSidebarOpen(false)
      }}
      onNewSession={() => {
        chat.startNewSession()
        setView('chat')
        setMobileSidebarOpen(false)
      }}
    />
  )
  const runtimeDotLabel = runtimeStatusDotLabel({
    runtimeAttached,
    runtimeStatus: runtimeStatusCompactLabel(runtimeStatus),
    running: chat.sending,
  })

  return (
    <div className="kode-web-root bg-background text-foreground">
      <div className="grid h-full grid-cols-1 lg:grid-cols-[304px_minmax(0,1fr)]">
        <div className="hidden lg:block">{sidebar}</div>

        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <div className="flex min-h-14 items-center gap-2 border-b border-[hsl(var(--kode-terminal-border))] bg-[hsl(var(--kode-terminal-panel))] px-3 py-2 font-mono text-[hsl(var(--kode-terminal-text))] shadow-sm shadow-black/20">
            <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
              <SheetTrigger asChild className="lg:hidden">
                <Button variant="ghost" size="icon" aria-label="Open sidebar">
                  <Menu className="h-4 w-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[min(304px,100vw)] p-0">
                {sidebar}
              </SheetContent>
            </Sheet>

            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">
                {selectedSessionTitle}
              </div>
              <div className="truncate text-xs text-[hsl(var(--kode-terminal-muted))]">
                {workspacesLoading
                  ? 'Loading workspaces...'
                  : (currentWorkspace?.path ?? 'No workspace')}
              </div>
            </div>

            <div
              className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[hsl(var(--kode-terminal-border))] bg-[hsl(var(--kode-terminal-bg))] p-1 text-[hsl(var(--kode-terminal-muted))]"
              role="group"
              aria-label="View"
            >
              {TERMINAL_VIEWS.map(item => {
                const active = view === item.value
                const Icon = item.icon

                return (
                  <button
                    key={item.value}
                    type="button"
                    className={cn(
                      'inline-flex h-8 min-w-8 items-center justify-center gap-2 rounded-[4px] px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/20 sm:px-3',
                      active
                        ? 'bg-[hsl(var(--kode-terminal-elevated))] text-[hsl(var(--kode-terminal-text))]'
                        : 'text-[hsl(var(--kode-terminal-muted))] hover:bg-[hsl(var(--kode-terminal-elevated))] hover:text-[hsl(var(--kode-terminal-text))]',
                    )}
                    aria-pressed={active}
                    aria-label={item.label}
                    onClick={() => setView(item.value)}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="hidden sm:inline">{item.label}</span>
                  </button>
                )
              })}
            </div>

            <div
              className={cn(
                'h-2 w-2 shrink-0 rounded-full',
                runtimeAttached ? 'bg-emerald-500' : 'bg-muted-foreground/40',
              )}
              aria-label={runtimeDotLabel}
              role="status"
              title={runtimeDotLabel}
            />
            <ThemeToggle />
          </div>

          <div className="min-h-0 flex-1">
            {view === 'settings' ? (
              <SettingsPage
                token={token}
                onTokenChange={t => {
                  persistToken(t)
                  setToken(t)
                }}
                onTokenClear={() => {
                  clearToken()
                  setToken('')
                }}
              />
            ) : view === 'schedules' ? (
              <SchedulesPage
                client={client}
                sessionId={chat.selectedSessionId}
                sessions={chat.sessions}
                onSelectSession={id => {
                  void chat.selectSession(id)
                }}
                onNewSession={() => {
                  chat.startNewSession()
                }}
              />
            ) : (
              <ChatPage
                events={chat.events}
                input={chat.input}
                onInputChange={chat.setInput}
                onPasteText={chat.insertPastedText}
                onSend={() => void chat.send()}
                onCancel={chat.cancel}
                disabled={!client}
                sending={chat.sending}
                permissionRequest={chat.permissionRequest}
                runtimeAttached={runtimeAttached}
                runtimeStatus={runtimeStatus}
                sessionKey={chat.selectedSessionId}
                sessionTitle={selectedSessionTitle}
                workspacePath={currentWorkspace?.path ?? null}
              />
            )}
          </div>
        </div>
      </div>

      <PermissionModal
        request={chat.permissionRequest}
        onAllowOnce={id => {
          if (!client) return
          void client.approveToolUse(id, { decision: 'allow_once' })
          chat.clearPermissionRequest()
        }}
        onAllowAlways={id => {
          if (!client) return
          void client.approveToolUse(id, { decision: 'allow_always' })
          chat.clearPermissionRequest()
        }}
        onDeny={(id, reason) => {
          if (!client) return
          void client.denyToolUse(id, reason)
          chat.clearPermissionRequest()
        }}
      />
    </div>
  )
}

export const __appForTests = {
  terminalViews: TERMINAL_VIEWS.map(({ value, label }) => ({ value, label })),
  runtimeStatusDotLabel,
}
