import React from 'react'

import { Button } from '../components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card'
import { Input } from '../components/ui/input'

function canSaveToken(token: string): boolean {
  return token.trim().length > 0
}

export function ConnectPage(props: {
  token: string
  onTokenChange: (token: string) => void
  onSave: () => void
}) {
  const saveEnabled = canSaveToken(props.token)

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto flex min-h-screen max-w-xl flex-col justify-center p-6">
        <Card>
          <CardHeader>
            <CardTitle>Connect to Kode Server</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4"
              onSubmit={event => {
                event.preventDefault()
                if (saveEnabled) props.onSave()
              }}
            >
              <div className="text-sm text-muted-foreground">
                Paste your daemon token to connect.
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="daemon-token">
                  Daemon token
                </label>
                <Input
                  id="daemon-token"
                  name="kode-daemon-token"
                  type="password"
                  autoComplete="new-password"
                  spellCheck={false}
                  value={props.token}
                  onChange={e => props.onTokenChange(e.target.value)}
                  placeholder="Paste daemon token"
                  aria-describedby="daemon-token-hint"
                />
                <p
                  id="daemon-token-hint"
                  className="text-xs text-muted-foreground"
                >
                  Stored in sessionStorage for this browser session only.
                </p>
              </div>
              <Button type="submit" disabled={!saveEnabled}>
                Save Token
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

export const __connectPageForTests = { canSaveToken }
