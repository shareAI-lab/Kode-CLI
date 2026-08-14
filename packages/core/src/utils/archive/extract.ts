import { Inflate, Unzip } from 'fflate'
import type {
  AsyncFlateStreamHandler,
  FlateError,
  UnzipFile,
  UnzipDecoder,
} from 'fflate'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export type ExtractArchiveOptions = {
  stripComponents?: number
  filter?: (entryPath: string) => boolean
  limits?: Partial<ArchiveExtractionLimits>
}

export type ArchiveExtractionLimits = {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxExtractedBytes: number
}

export const DEFAULT_ARCHIVE_EXTRACTION_LIMITS: ArchiveExtractionLimits = {
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxExtractedBytes: 512 * 1024 * 1024,
}

function positiveLimit(
  name: keyof ArchiveExtractionLimits,
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (Number.isSafeInteger(value) && value > 0) return value
  throw new Error(`Archive extraction limit ${name} must be a positive integer`)
}

function resolveLimits(
  options: ExtractArchiveOptions,
): ArchiveExtractionLimits {
  return {
    maxArchiveBytes: positiveLimit(
      'maxArchiveBytes',
      options.limits?.maxArchiveBytes,
      DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxArchiveBytes,
    ),
    maxEntries: positiveLimit(
      'maxEntries',
      options.limits?.maxEntries,
      DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxEntries,
    ),
    maxEntryBytes: positiveLimit(
      'maxEntryBytes',
      options.limits?.maxEntryBytes,
      DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxEntryBytes,
    ),
    maxExtractedBytes: positiveLimit(
      'maxExtractedBytes',
      options.limits?.maxExtractedBytes,
      DEFAULT_ARCHIVE_EXTRACTION_LIMITS.maxExtractedBytes,
    ),
  }
}

function validateOutputPathHierarchy(
  outputPath: string,
  isDirectory: boolean,
  fileOutputPaths: Set<string>,
  requiredDirectories: Set<string>,
): void {
  const parts = outputPath.split('/')
  let parent = ''
  for (let index = 0; index < parts.length - 1; index += 1) {
    parent = parent ? `${parent}/${parts[index]}` : parts[index]!
    if (fileOutputPaths.has(pathCollisionKey(parent))) {
      throw new Error(
        `Archive output path conflicts with file ancestor: ${outputPath}`,
      )
    }
    requiredDirectories.add(pathCollisionKey(parent))
  }

  if (!isDirectory && requiredDirectories.has(pathCollisionKey(outputPath))) {
    throw new Error(
      `Archive file conflicts with an existing directory path: ${outputPath}`,
    )
  }

  if (isDirectory) requiredDirectories.add(pathCollisionKey(outputPath))
  else fileOutputPaths.add(pathCollisionKey(outputPath))
}

/**
 * Default APFS (macOS) and NTFS (Windows) file systems fold case, so entries
 * that differ only by case collide on disk. Fold the comparison key on those
 * platforms while keeping case-sensitive checks elsewhere.
 */
function pathCollisionKey(path: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? path.toLowerCase()
    : path
}

function assertArchiveSize(byteLength: number, maxArchiveBytes: number): void {
  if (byteLength > maxArchiveBytes) {
    throw new Error(
      `Archive size ${byteLength} exceeds limit ${maxArchiveBytes} bytes`,
    )
  }
}

function maxTarContainerBytes(limits: ArchiveExtractionLimits): number {
  // TAR adds a 512-byte header and up to 511 bytes of padding per entry, plus
  // end markers. Keep that metadata budget separate from extracted file bytes
  // while still imposing a hard decompression ceiling.
  const metadataBytes = Math.min(
    limits.maxExtractedBytes,
    limits.maxEntries > Math.floor(limits.maxExtractedBytes / 1024)
      ? limits.maxExtractedBytes
      : limits.maxEntries * 1024,
  )
  const remaining = Number.MAX_SAFE_INTEGER - limits.maxExtractedBytes
  if (metadataBytes + 1024 > remaining) return Number.MAX_SAFE_INTEGER
  return limits.maxExtractedBytes + metadataBytes + 1024
}

function readArchiveFile(path: string, maxArchiveBytes: number): Buffer {
  const size = statSync(path).size
  assertArchiveSize(size, maxArchiveBytes)
  const data = readFileSync(path)
  // Re-check in case the file changed between stat and read.
  assertArchiveSize(data.byteLength, maxArchiveBytes)
  return data
}

function normalizeArchivePath(rawPath: string): string {
  const withoutNull = rawPath.split('\0')[0] ?? ''
  const withSlashes = withoutNull.replace(/\\/g, '/')
  const noLeadingSlash = withSlashes.replace(/^\/+/, '')
  const noDrivePrefix = noLeadingSlash.replace(/^[A-Za-z]:\//, '')
  const parts = noDrivePrefix.split('/').filter(Boolean)
  for (const part of parts) {
    if (part === '.' || part === '..') {
      throw new Error(`Unsafe archive path: ${rawPath}`)
    }
  }
  return parts.join('/')
}

function stripLeadingComponents(
  normalizedPath: string,
  stripComponents: number,
): string | null {
  if (stripComponents <= 0) return normalizedPath
  const parts = normalizedPath.split('/').filter(Boolean)
  if (parts.length <= stripComponents) return null
  return parts.slice(stripComponents).join('/')
}

function safeDestinationPath(destDir: string, entryPath: string): string {
  if (!entryPath) {
    throw new Error('Entry path is empty')
  }
  if (isAbsolute(entryPath)) {
    throw new Error(`Absolute archive path is not allowed: ${entryPath}`)
  }
  const resolvedDestDir = resolve(destDir)
  const outPath = resolve(resolvedDestDir, entryPath)
  if (
    outPath !== resolvedDestDir &&
    !outPath.startsWith(resolvedDestDir + sep)
  ) {
    throw new Error(`Archive entry escapes destination: ${entryPath}`)
  }
  return outPath
}

/**
 * Streaming deflate decoder for ZIP entries that aborts as soon as the
 * decompressed byte count exceeds the entry budget. fflate's fixed-buffer
 * inflate silently truncates overflowing output, which would let an entry with
 * a lying declared size pass through with partial content.
 */
function createBoundedInflateDecoder(maxEntryBytes: number): {
  new (filename: string, size?: number, originalSize?: number): UnzipDecoder
  compression: number
} {
  return class BoundedInflateDecoder implements UnzipDecoder {
    static compression = 8
    private readonly inflate = new Inflate()
    private readonly budget: number
    private outputBytes = 0
    private failed = false
    ondata: (
      err: FlateError | null,
      data: Uint8Array | null,
      final: boolean,
    ) => void = () => {}

    constructor(_filename: string, _size?: number, originalSize?: number) {
      this.budget =
        Number.isSafeInteger(originalSize) && (originalSize as number) > 0
          ? Math.min(originalSize as number, maxEntryBytes)
          : maxEntryBytes
    }

    push(chunk: Uint8Array, final: boolean): void {
      if (this.failed) return
      this.inflate.ondata = (data, done) => {
        if (this.failed) return
        if (data) {
          this.outputBytes += data.byteLength
          if (this.outputBytes > this.budget) {
            this.failed = true
            // fflate's stream handler passes null data alongside an error;
            // widen the payload type to model that at runtime.
            this.ondata(
              new Error(
                `Archive entry exceeds decompressed size budget of ${this.budget} bytes`,
              ) as FlateError,
              null,
              done,
            )
            return
          }
        }
        this.ondata(null, data, done)
      }
      this.inflate.push(chunk, final)
    }
  }
}

export async function extractZipBuffer(
  zipData: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  const stripComponents = options.stripComponents ?? 0
  const filter = options.filter
  const limits = resolveLimits(options)
  assertArchiveSize(zipData.byteLength, limits.maxArchiveBytes)

  let entryCount = 0
  let extractedBytes = 0
  const selectedEntries = new Map<
    string,
    { outputPath: string; isDirectory: boolean }
  >()
  const entryData = new Map<string, Buffer>()
  const selectedOutputPaths = new Set<string>()
  const fileOutputPaths = new Set<string>()
  const requiredDirectories = new Set<string>()

  const unzip = new Unzip((file: UnzipFile) => {
    entryCount += 1
    if (entryCount > limits.maxEntries) {
      throw new Error(`Archive entry count exceeds limit ${limits.maxEntries}`)
    }

    const normalized = normalizeArchivePath(file.name)
    const stripped = stripLeadingComponents(normalized, stripComponents)
    if (!stripped || (filter && !filter(stripped))) return

    const isDirectory = file.name.endsWith('/') || stripped.endsWith('/')

    // The central-directory sizes can be missing for streamed archives;
    // declared sizes are a pre-check only, actual bytes are enforced by the
    // bounded decoder below.
    const declaredBytes = file.originalSize
    if (declaredBytes !== undefined) {
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error(`Invalid archive entry size: ${file.name}`)
      }
      if (!isDirectory && declaredBytes > limits.maxEntryBytes) {
        throw new Error(
          `Archive entry ${file.name} exceeds limit ${limits.maxEntryBytes} bytes`,
        )
      }
    }

    if (selectedOutputPaths.has(pathCollisionKey(stripped))) {
      throw new Error(`Duplicate archive output path: ${stripped}`)
    }
    validateOutputPathHierarchy(
      stripped,
      isDirectory,
      fileOutputPaths,
      requiredDirectories,
    )
    selectedOutputPaths.add(pathCollisionKey(stripped))
    selectedEntries.set(file.name, {
      outputPath: stripped,
      isDirectory,
    })

    let data: Buffer | null = null
    file.ondata = (err, chunk, final) => {
      if (err) {
        throw new Error(
          `Archive entry ${file.name} failed to decompress: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
      if (chunk && chunk.byteLength > 0) {
        if (!isDirectory) {
          extractedBytes += chunk.byteLength
          if (extractedBytes > limits.maxExtractedBytes) {
            throw new Error(
              `Archive extracted data exceeds limit ${limits.maxExtractedBytes} bytes`,
            )
          }
          data = data ? Buffer.concat([data, chunk]) : Buffer.from(chunk)
        }
      }
      if (final && !isDirectory) {
        entryData.set(file.name, data ?? Buffer.alloc(0))
      }
    }
    file.start()
  })

  unzip.register(createBoundedInflateDecoder(limits.maxEntryBytes))
  unzip.push(zipData, true)

  mkdirSync(destDir, { recursive: true })

  for (const [rawName, contents] of entryData) {
    const selected = selectedEntries.get(rawName)
    if (!selected) continue
    const outputPath = safeDestinationPath(destDir, selected.outputPath)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, contents)
  }

  for (const [, selected] of selectedEntries) {
    if (!selected.isDirectory) continue
    const outputPath = safeDestinationPath(destDir, selected.outputPath)
    mkdirSync(outputPath, { recursive: true })
  }
}

export async function extractZipFile(
  zipPath: string,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  const data = readArchiveFile(zipPath, resolveLimits(options).maxArchiveBytes)
  await extractZipBuffer(new Uint8Array(data), destDir, options)
}

function decodeTarString(buf: Buffer, start: number, end: number): string {
  const slice = buf.subarray(start, end)
  const nul = slice.indexOf(0)
  const trimmed = (nul === -1 ? slice : slice.subarray(0, nul))
    .toString('utf8')
    .trim()
  return trimmed
}

function parseTarOctal(buf: Buffer, start: number, end: number): number {
  const raw = decodeTarString(buf, start, end)
  if (!raw) return 0
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar numeric field: ${raw}`)
  }
  const parsed = Number.parseInt(raw, 8)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid tar numeric field: ${raw}`)
  }
  return parsed
}

function assertTarHeaderChecksum(header: Buffer): void {
  const expected = parseTarOctal(header, 148, 156)
  let actual = 0
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!
  }
  if (expected !== actual) throw new Error('Invalid tar header checksum')
}

function isAllZero(block: Buffer): boolean {
  for (let i = 0; i < block.length; i++) {
    if (block[i] !== 0) return false
  }
  return true
}

function parsePaxHeader(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const lenRaw = data.subarray(offset, space).toString('utf8')
    const recordLen = Number.parseInt(lenRaw, 10)
    if (!Number.isFinite(recordLen) || recordLen <= 0) break
    const record = data.subarray(
      offset + (space - offset) + 1,
      offset + recordLen,
    )
    const recordStr = record.toString('utf8')
    const eq = recordStr.indexOf('=')
    if (eq !== -1) {
      const key = recordStr.slice(0, eq).trim()
      const value = recordStr
        .slice(eq + 1)
        .replace(/\n$/, '')
        .trim()
      if (key) out[key] = value
    }
    offset += recordLen
  }
  return out
}

export async function extractTarGzBuffer(
  tarGzData: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  const limits = resolveLimits(options)
  assertArchiveSize(tarGzData.byteLength, limits.maxArchiveBytes)
  const maxTarBytes = maxTarContainerBytes(limits)
  let tarData: Buffer
  try {
    tarData = gunzipSync(Buffer.from(tarGzData), {
      maxOutputLength: maxTarBytes,
    })
  } catch (error) {
    throw new Error(
      `Failed to decompress tar.gz within ${maxTarBytes} bytes: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  await extractTarBufferData(new Uint8Array(tarData), destDir, options, false)
}

export async function extractTarGzFile(
  tarGzPath: string,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  const data = readArchiveFile(
    tarGzPath,
    resolveLimits(options).maxArchiveBytes,
  )
  await extractTarGzBuffer(new Uint8Array(data), destDir, options)
}

export async function extractTarBuffer(
  tarData: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions = {},
): Promise<void> {
  await extractTarBufferData(tarData, destDir, options, true)
}

async function extractTarBufferData(
  tarData: Uint8Array,
  destDir: string,
  options: ExtractArchiveOptions,
  enforceArchiveInputLimit: boolean,
): Promise<void> {
  const stripComponents = options.stripComponents ?? 0
  const filter = options.filter
  const limits = resolveLimits(options)
  if (enforceArchiveInputLimit) {
    assertArchiveSize(tarData.byteLength, limits.maxArchiveBytes)
  }
  assertArchiveSize(tarData.byteLength, maxTarContainerBytes(limits))

  const buf = Buffer.from(tarData)
  let offset = 0
  let entryCount = 0
  let extractedBytes = 0

  let pendingLongPath: string | null = null
  let pendingPax: Record<string, string> | null = null
  const entries: Array<{
    outputPath: string
    type: 'directory' | 'file'
    mode: number
    content: Buffer
  }> = []
  const outputPaths = new Set<string>()
  const fileOutputPaths = new Set<string>()
  const requiredDirectories = new Set<string>()

  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    offset += 512

    if (isAllZero(header)) {
      break
    }
    assertTarHeaderChecksum(header)
    entryCount += 1
    if (entryCount > limits.maxEntries) {
      throw new Error(`Archive entry count exceeds limit ${limits.maxEntries}`)
    }

    const name = decodeTarString(header, 0, 100)
    const mode = parseTarOctal(header, 100, 108)
    const size = parseTarOctal(header, 124, 136)
    const typeflag = decodeTarString(header, 156, 157) || '0'
    const prefix = decodeTarString(header, 345, 500)

    const rawPathFromHeader = prefix ? `${prefix}/${name}` : name

    const contentStart = offset
    const contentEnd = offset + size
    if (contentEnd > buf.length) {
      throw new Error('Truncated tar archive')
    }
    if (size > limits.maxEntryBytes) {
      throw new Error(
        `Archive entry ${rawPathFromHeader} exceeds limit ${limits.maxEntryBytes} bytes`,
      )
    }

    const content = buf.subarray(contentStart, contentEnd)
    offset += Math.ceil(size / 512) * 512

    if (typeflag === 'L') {
      pendingLongPath = content.toString('utf8').replace(/\0.*$/, '').trim()
      continue
    }

    if (typeflag === 'x') {
      pendingPax = parsePaxHeader(content)
      continue
    }

    let entryPath = pendingLongPath ?? rawPathFromHeader
    pendingLongPath = null

    if (pendingPax?.path) {
      entryPath = pendingPax.path
    }
    pendingPax = null

    const normalized = normalizeArchivePath(entryPath)
    const stripped = stripLeadingComponents(normalized, stripComponents)
    if (!stripped) continue
    if (filter && !filter(stripped)) continue

    const isDirectory = typeflag === '5'
    const isFile = typeflag === '0' || typeflag === '\0'
    if (!isDirectory && !isFile) continue

    if (outputPaths.has(pathCollisionKey(stripped))) {
      throw new Error(`Duplicate archive output path: ${stripped}`)
    }
    validateOutputPathHierarchy(
      stripped,
      isDirectory,
      fileOutputPaths,
      requiredDirectories,
    )
    outputPaths.add(pathCollisionKey(stripped))

    if (isDirectory) {
      entries.push({
        outputPath: stripped,
        type: 'directory',
        mode,
        content: Buffer.alloc(0),
      })
      continue
    }

    extractedBytes += size
    if (extractedBytes > limits.maxExtractedBytes) {
      throw new Error(
        `Archive extracted data exceeds limit ${limits.maxExtractedBytes} bytes`,
      )
    }
    entries.push({ outputPath: stripped, type: 'file', mode, content })
  }

  mkdirSync(destDir, { recursive: true })
  for (const entry of entries) {
    const outputPath = safeDestinationPath(destDir, entry.outputPath)
    if (entry.type === 'directory') {
      mkdirSync(outputPath, { recursive: true })
      continue
    }

    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, entry.content)
    if (entry.mode && process.platform !== 'win32') {
      try {
        chmodSync(outputPath, entry.mode & 0o777)
      } catch {
        // Extraction succeeded; mode preservation is best-effort across filesystems.
      }
    }
  }
}
