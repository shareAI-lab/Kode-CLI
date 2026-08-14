import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs'

const PERMISSION_ERROR_CODES = new Set(['EACCES', 'EPERM', 'EROFS'])

function isPermissionError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    PERMISSION_ERROR_CODES.has((error as NodeJS.ErrnoException).code ?? '')
  )
}

export function safeMkdir(dir: string): boolean {
  if (existsSync(dir)) return true
  try {
    mkdirSync(dir, { recursive: true })
    return true
  } catch (error) {
    if (isPermissionError(error)) {
      return false
    }
    throw error
  }
}

export function safeWriteFile(
  path: string,
  data: string,
  encoding: BufferEncoding = 'utf8',
): boolean {
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmpPath, data, encoding)
    renameSync(tmpPath, path)
    return true
  } catch (error) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // ignore
    }
    if (isPermissionError(error)) {
      return false
    }
    throw error
  }
}

export function safeAppendFile(
  path: string,
  data: string,
  encoding: BufferEncoding = 'utf8',
): boolean {
  try {
    appendFileSync(path, data, { encoding })
    return true
  } catch (error) {
    if (isPermissionError(error)) {
      return false
    }
    throw error
  }
}
