import { minimatch } from 'minimatch'

import { PRODUCT_NAME } from '#core/constants/product'
import type { Tool, ToolUseContext } from '#core/tooling/Tool'
import type { ToolPermissionContext } from '#core/types/toolPermissionContext'

import { getPermissionKey } from '../permissionKey'
import type { PermissionResult } from '../types'

// Preapproved WebFetch hosts/paths to reduce permission prompts for common documentation sites.
const WEBFETCH_PREAPPROVED_HOSTS_AND_PATHS = new Set<string>([
  'modelcontextprotocol.io',
  'docs.python.org',
  'en.cppreference.com',
  'docs.oracle.com',
  'learn.microsoft.com',
  'developer.mozilla.org',
  'go.dev',
  'pkg.go.dev',
  'www.php.net',
  'docs.swift.org',
  'kotlinlang.org',
  'ruby-doc.org',
  'doc.rust-lang.org',
  'www.typescriptlang.org',
  'react.dev',
  'angular.io',
  'vuejs.org',
  'nextjs.org',
  'expressjs.com',
  'nodejs.org',
  'bun.sh',
  'jquery.com',
  'getbootstrap.com',
  'tailwindcss.com',
  'd3js.org',
  'threejs.org',
  'redux.js.org',
  'webpack.js.org',
  'jestjs.io',
  'reactrouter.com',
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pandas.pydata.org',
  'numpy.org',
  'www.tensorflow.org',
  'pytorch.org',
  'scikit-learn.org',
  'matplotlib.org',
  'requests.readthedocs.io',
  'jupyter.org',
  'laravel.com',
  'symfony.com',
  'wordpress.org',
  'docs.spring.io',
  'hibernate.org',
  'tomcat.apache.org',
  'gradle.org',
  'maven.apache.org',
  'asp.net',
  'dotnet.microsoft.com',
  'nuget.org',
  'blazor.net',
  'reactnative.dev',
  'docs.flutter.dev',
  'developer.apple.com',
  'developer.android.com',
  'keras.io',
  'spark.apache.org',
  'huggingface.co',
  'www.kaggle.com',
  'www.mongodb.com',
  'redis.io',
  'www.postgresql.org',
  'dev.mysql.com',
  'www.sqlite.org',
  'graphql.org',
  'prisma.io',
  'docs.aws.amazon.com',
  'cloud.google.com',
  'kubernetes.io',
  'www.docker.com',
  'www.terraform.io',
  'www.ansible.com',
  'vercel.com/docs',
  'docs.netlify.com',
  'devcenter.heroku.com/',
  'cypress.io',
  'selenium.dev',
  'docs.unity.com',
  'docs.unrealengine.com',
  'git-scm.com',
  'nginx.org',
  'httpd.apache.org',
])

function isPreapprovedWebFetchUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    const hostname = parsed.hostname
    const pathname = parsed.pathname
    for (const entry of WEBFETCH_PREAPPROVED_HOSTS_AND_PATHS) {
      if (entry.includes('/')) {
        const [entryHost, ...rest] = entry.split('/')
        const entryPath = `/${rest.join('/')}`
        if (hostname === entryHost && pathname.startsWith(entryPath))
          return true
        continue
      }
      if (hostname === entry) return true
    }
  } catch {
    return false
  }

  return false
}

export function checkWebPermission(args: {
  tool: Tool
  input: Record<string, unknown>
  context: ToolUseContext
  assistantMessage: unknown
  effectiveAllowedTools: string[]
  effectiveDeniedTools: string[]
  effectiveAskedTools: string[]
  effectiveToolPermissionContext: ToolPermissionContext
}): PermissionResult {
  if (args.tool.name === 'WebSearch') {
    const permissionKey = getPermissionKey(args.tool, args.input, null)
    const matchesWebSearchRule = (rule: string): boolean =>
      rule === args.tool.name || rule === permissionKey

    const deniedRule = args.effectiveDeniedTools.find(matchesWebSearchRule)
    if (deniedRule) {
      return {
        result: false,
        message: `Permission to use ${args.tool.name} has been denied.`,
        shouldPromptUser: false,
        decisionReason: deniedRule,
      }
    }
    const askedRule = args.effectiveAskedTools.find(matchesWebSearchRule)
    if (askedRule) {
      return {
        result: false,
        message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
        decisionReason: askedRule,
      }
    }
    if (args.effectiveAllowedTools.some(matchesWebSearchRule)) {
      return { result: true }
    }

    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
      decisionReason: 'No allow rule matched',
    }
  }

  if (args.tool.name === 'WebFetch') {
    const url = typeof args.input.url === 'string' ? args.input.url : ''
    if (url && isPreapprovedWebFetchUrl(url)) {
      return { result: true }
    }
  }

  const permissionKey = getPermissionKey(args.tool, args.input, null)
  const openParenIndex = permissionKey.indexOf('(')
  const actualRuleContent =
    openParenIndex !== -1 && permissionKey.endsWith(')')
      ? permissionKey.slice(openParenIndex + 1, -1)
      : ''
  const actualHostname = actualRuleContent.startsWith('domain:')
    ? actualRuleContent.slice('domain:'.length)
    : null

  const matchesWebFetchRule = (rule: string): boolean => {
    if (rule === args.tool.name) return true
    const open = rule.indexOf('(')
    if (open === -1 || !rule.endsWith(')')) return false
    const name = rule.slice(0, open)
    if (name !== args.tool.name) return false
    const ruleContent = rule.slice(open + 1, -1).trim()
    if (!ruleContent) return false
    if (ruleContent.startsWith('domain:') && actualHostname !== null) {
      const hostPattern = ruleContent.slice('domain:'.length).trim()
      if (!hostPattern) return false
      return minimatch(actualHostname, hostPattern, { nocase: true, dot: true })
    }
    return ruleContent === actualRuleContent
  }

  const deniedRule = args.effectiveDeniedTools.find(matchesWebFetchRule)
  if (deniedRule) {
    return {
      result: false,
      message: `Permission to use ${args.tool.name} has been denied.`,
      shouldPromptUser: false,
      decisionReason: deniedRule,
    }
  }
  const askedRule = args.effectiveAskedTools.find(matchesWebFetchRule)
  if (askedRule) {
    return {
      result: false,
      message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
      decisionReason: askedRule,
    }
  }
  if (args.effectiveAllowedTools.some(matchesWebFetchRule)) {
    return { result: true }
  }

  return {
    result: false,
    message: `${PRODUCT_NAME} requested permissions to use ${args.tool.name}, but you haven't granted it yet.`,
    decisionReason: 'No allow rule matched',
  }
}
