import { describe, expect, test } from 'bun:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { ConnectPage, __connectPageForTests } from './Connect'

describe('ConnectPage', () => {
  test('requires a non-blank token before enabling submit', () => {
    expect(__connectPageForTests.canSaveToken('')).toBe(false)
    expect(__connectPageForTests.canSaveToken('   ')).toBe(false)
    expect(__connectPageForTests.canSaveToken('token')).toBe(true)
  })

  test('renders a labelled, password-protected token form', () => {
    const html = renderToStaticMarkup(
      React.createElement(ConnectPage, {
        token: '',
        onTokenChange: () => {},
        onSave: () => {},
      }),
    )

    expect(html).toContain('<form')
    expect(html).toContain('for="daemon-token"')
    expect(html).toContain('id="daemon-token"')
    expect(html).toContain('type="password"')
    expect(html).toContain('autoComplete="new-password"')
    expect(html).toContain('aria-describedby="daemon-token-hint"')
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Save Token<\/button>/)
  })
})
