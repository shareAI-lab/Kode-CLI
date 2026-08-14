export function isDebugMode(): boolean {
  return (
    process.argv.includes('--debug-verbose') ||
    process.argv.includes('--mcp-debug') ||
    process.argv.some(
      arg => arg === '--debug' || arg === '-d' || arg.startsWith('--debug='),
    )
  )
}

export function isVerboseMode(): boolean {
  return process.argv.includes('--verbose')
}

export function isDebugVerboseMode(): boolean {
  return process.argv.includes('--debug-verbose')
}
