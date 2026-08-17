declare module 'shell-quote' {
  export type ControlOperator =
    | '&&'
    | '||'
    | ';'
    | ';;'
    | '|'
    | '&'
    | '>&'
    | '>'
    | '>>'
    | '<'
    | '<<'
    | '('
    | ')'
    | 'glob'

  export type ParseEntry =
    string | { op: ControlOperator; pattern?: string } | { comment: string }

  export function parse(
    command: string,
    env?: Record<string, string> | ((varName: string) => string | undefined),
  ): ParseEntry[]

  export function quote(args: Array<string | number | boolean | null>): string
}

declare module 'turndown' {
  type RuleFilter =
    | string
    | string[]
    | ((node: {
        nodeName: string
        nodeType: number
        getAttribute(name: string): string | null
      }) => boolean)

  type ReplacementFunction = (
    content: string,
    node: {
      nodeName: string
      nodeType: number
      getAttribute(name: string): string | null
    },
  ) => string

  type TurndownOptions = {
    headingStyle?: 'setext' | 'atx'
    hr?: string
    bulletListMarker?: '-' | '+' | '*'
    codeBlockStyle?: 'indented' | 'fenced'
    fence?: '```' | '~~~'
    emDelimiter?: '_' | '*'
    strongDelimiter?: '**' | '__'
  }

  export default class TurndownService {
    constructor(options?: TurndownOptions)
    addRule(
      key: string,
      rule: { filter: RuleFilter; replacement: ReplacementFunction },
    ): this
    turndown(html: string): string
  }
}

declare module 'semver' {
  export function gt(version: string, other: string): boolean
  export function satisfies(version: string, range: string): boolean

  const semver: {
    gt: typeof gt
    satisfies: typeof satisfies
  }
  export default semver
}

declare module 'debug' {
  export interface Debugger {
    (formatter: string, ...args: unknown[]): void
    enabled: boolean
    namespace: string
  }

  export default function debug(namespace: string): Debugger
}
