export function emptyDirectoryCompletionMessage(directory: string): string {
  const label = directory.trim() || 'this directory'
  return `No files in ${label}`
}
