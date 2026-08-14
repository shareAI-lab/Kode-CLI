import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type RecordedVoiceAudio = {
  bytes: Uint8Array
  mimeType: 'audio/wav'
  durationMs: number
}

export type ActiveVoiceRecording = {
  stop(): Promise<RecordedVoiceAudio>
  cancel(): Promise<void>
}

export type NativeVoicePlayback = {
  completed: Promise<void>
  /** Stops only the current local playback; it never changes the text turn. */
  stop(): void
}

export type ActiveVoicePCMPlayback = {
  write(bytes: Uint8Array): Promise<void>
  finish(): Promise<void>
  cancel(): Promise<void>
}

export class VoiceRuntimeError extends Error {
  override name = 'VoiceRuntimeError'
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024
const WAV_HEADER_BYTES = 44

/**
 * The recorder always writes a canonical 16-bit PCM WAV. An all-zero payload
 * means macOS delivered no microphone signal (commonly a denied permission or
 * an inactive input device), so sending it to ASR can produce a fabricated
 * transcript instead of a useful error.
 */
function hasPcm16WavSignal(bytes: Uint8Array): boolean {
  if (bytes.length <= WAV_HEADER_BYTES) return false
  for (let offset = WAV_HEADER_BYTES; offset + 1 < bytes.length; offset += 2) {
    if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) return true
  }
  return false
}

// A deliberately tiny Swift helper keeps microphone permission and AVFoundation
// out of the terminal renderer. It produces a standard 16 kHz mono PCM WAV:
// compact enough for MiMo's 10 MB input cap, and a broadly interoperable
// format. The WAV header is written manually: AVAudioFile's streaming writer
// emits a non-standard layout (JUNK/FLLR chunks, stale RIFF size) that MiMo's
// ASR endpoint rejects with HTTP 500.
const RECORDER_SOURCE = String.raw`
import AVFoundation
import Foundation

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

let arguments = CommandLine.arguments
guard arguments.count == 5, arguments[1] == "record", arguments[2] == "--path",
      let maximumSeconds = Double(arguments[4]), maximumSeconds > 0 else {
  emit(["event": "error", "message": "invalid recorder arguments"])
  exit(64)
}

let outputURL = URL(fileURLWithPath: arguments[3])
do {
  try FileManager.default.createDirectory(
    at: outputURL.deletingLastPathComponent(),
    withIntermediateDirectories: true
  )
  let engine = AVAudioEngine()
  let input = engine.inputNode
  let inputFormat = input.outputFormat(forBus: 0)
  guard let outputFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: 16_000,
    channels: 1,
    interleaved: true
  ), let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
    throw NSError(domain: "kode.voice", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to create an audio converter"])
  }
  let lock = NSLock()
  var pcmData = Data()
  var writtenFrames: AVAudioFramePosition = 0
  var tapError: Error?

  input.installTap(onBus: 0, bufferSize: 4_096, format: inputFormat) { buffer, _ in
    guard tapError == nil else { return }
    guard let converted = AVAudioPCMBuffer(
      pcmFormat: outputFormat,
      frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate) + 32
    ) else { return }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: converted, error: &error) { _, inputStatus in
      if supplied {
        inputStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return buffer
    }
    if status == .haveData, converted.frameLength > 0 {
      let frames = converted.int16ChannelData![0]
      let bytes = Data(bytes: frames, count: Int(converted.frameLength) * 2)
      lock.lock()
      pcmData.append(bytes)
      writtenFrames += AVAudioFramePosition(converted.frameLength)
      lock.unlock()
    } else if let error = error {
      tapError = error
    }
  }

  try engine.start()
  emit(["event": "ready"])

  // Keep the main run loop alive so AVAudioEngine keeps delivering tap
  // buffers; blocking the main thread with a semaphore stalls audio capture.
  var stopRequested = false
  DispatchQueue.global().async {
    _ = readLine()
    stopRequested = true
  }
  let startedAt = Date()
  while !stopRequested && Date().timeIntervalSince(startedAt) < maximumSeconds {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
  }
  input.removeTap(onBus: 0)
  engine.stop()
  if let error = tapError { throw error }
  lock.lock()
  let durationMs = Int((Double(writtenFrames) / outputFormat.sampleRate) * 1_000)
  lock.unlock()
  if durationMs <= 0 {
    throw NSError(domain: "kode.voice", code: 2, userInfo: [NSLocalizedDescriptionKey: "No microphone audio was captured"])
  }

  // Write a canonical 44-byte WAV header followed by the PCM payload.
  var sampleRate: UInt32 = 16_000
  var channels: UInt16 = 1
  var bitsPerSample: UInt16 = 16
  var byteRate = sampleRate * UInt32(channels) * UInt32(bitsPerSample / 8)
  var blockAlign = channels * UInt16(bitsPerSample / 8)
  var header = Data()
  func append(_ bytes: [UInt8]) { header.append(contentsOf: bytes) }
  append(Array("RIFF".utf8))
  var riffSize = UInt32(36 + pcmData.count).littleEndian
  withUnsafeBytes(of: &riffSize) { header.append(contentsOf: $0) }
  append(Array("WAVE".utf8))
  append(Array("fmt ".utf8))
  var fmtSize: UInt32 = 16
  withUnsafeBytes(of: &fmtSize) { header.append(contentsOf: $0) }
  var audioFormat: UInt16 = 1
  withUnsafeBytes(of: &audioFormat) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &channels) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &sampleRate) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &byteRate) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &blockAlign) { header.append(contentsOf: $0) }
  withUnsafeBytes(of: &bitsPerSample) { header.append(contentsOf: $0) }
  append(Array("data".utf8))
  var dataSize = UInt32(pcmData.count).littleEndian
  withUnsafeBytes(of: &dataSize) { header.append(contentsOf: $0) }

  try header.write(to: outputURL)
  let handle = try FileHandle(forWritingTo: outputURL)
  handle.seekToEndOfFile()
  handle.write(pcmData)
  try handle.close()
  emit(["event": "complete", "durationMs": durationMs])
} catch {
  emit(["event": "error", "message": error.localizedDescription])
  exit(1)
}
`

// The TTS API streams 24 kHz mono PCM16. A persistent AVAudioEngine process
// accepts framed PCM blocks on stdin, keeping native playback independent from
// an HTTP/provider implementation and allowing immediate cancellation.
const PCM_PLAYER_SOURCE = String.raw`
import AVFoundation
import Foundation

func emit(_ value: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func readExactly(_ handle: FileHandle, _ count: Int) -> Data? {
  var data = Data()
  while data.count < count {
    let next = handle.readData(ofLength: count - data.count)
    if next.isEmpty { return data.isEmpty ? nil : nil }
    data.append(next)
  }
  return data
}

let arguments = CommandLine.arguments
guard arguments.count == 5, arguments[1] == "play-pcm", arguments[2] == "--sample-rate",
      let sampleRate = Double(arguments[3]), sampleRate > 0, arguments[4] == "mono" else {
  emit(["event": "error", "message": "invalid PCM player arguments"])
  exit(64)
}

do {
  guard let format = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: sampleRate,
    channels: 1,
    interleaved: true
  ) else {
    throw NSError(domain: "kode.voice", code: 10, userInfo: [NSLocalizedDescriptionKey: "Unable to create PCM format"])
  }
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  engine.attach(player)
  engine.connect(player, to: engine.mainMixerNode, format: format)
  engine.prepare()
  try engine.start()
  let group = DispatchGroup()
  let capacity = DispatchSemaphore(value: 6)
  emit(["event": "ready"])

  while let header = readExactly(FileHandle.standardInput, 4) {
    let length =
      (Int(header[0]) << 24) |
      (Int(header[1]) << 16) |
      (Int(header[2]) << 8) |
      Int(header[3])
    if length <= 0 || length > 1_048_576 || length % 2 != 0 {
      throw NSError(domain: "kode.voice", code: 11, userInfo: [NSLocalizedDescriptionKey: "Invalid PCM frame length"])
    }
    guard let pcm = readExactly(FileHandle.standardInput, length),
          let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: AVAudioFrameCount(length / 2)
          ), let destination = buffer.int16ChannelData else {
      throw NSError(domain: "kode.voice", code: 12, userInfo: [NSLocalizedDescriptionKey: "Incomplete PCM audio frame"])
    }
    capacity.wait()
    buffer.frameLength = AVAudioFrameCount(length / 2)
    pcm.withUnsafeBytes { source in
      memcpy(destination.pointee, source.baseAddress!, length)
    }
    group.enter()
    player.scheduleBuffer(buffer) {
      capacity.signal()
      group.leave()
    }
    if !player.isPlaying { player.play() }
  }
  group.wait()
  player.stop()
  engine.stop()
  emit(["event": "complete"])
} catch {
  emit(["event": "error", "message": error.localizedDescription])
  exit(1)
}
`

function safeError(value: unknown, fallback: string): VoiceRuntimeError {
  const message = value instanceof Error ? value.message : String(value)
  return new VoiceRuntimeError(message.slice(0, 300) || fallback)
}

type VoiceHelperEvent = 'ready' | 'complete'

type VoiceHelperProtocol = {
  waitFor(event: VoiceHelperEvent): Promise<Record<string, unknown>>
  dispose(): void
}

/**
 * Observe a helper for its entire lifetime, rather than attaching a new line
 * listener for `ready` and later for `complete`. The latter loses a very fast
 * completion event between listeners, which makes the UI report a false
 * playback/capture failure.
 */
function observeHelper(
  child: ChildProcess,
  processLabel = 'Voice helper',
): VoiceHelperProtocol {
  let output = ''
  let terminalError: Error | null = null
  let disposed = false
  const received = new Map<VoiceHelperEvent, Record<string, unknown>>()
  const waiters = new Map<
    VoiceHelperEvent,
    Array<{
      resolve: (value: Record<string, unknown>) => void
      reject: (error: Error) => void
    }>
  >()
  const fail = (error: Error) => {
    if (terminalError || disposed) return
    terminalError = error
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(error)
    }
    waiters.clear()
  }
  const emit = (event: VoiceHelperEvent, value: Record<string, unknown>) => {
    if (received.has(event) || disposed) return
    received.set(event, value)
    for (const waiter of waiters.get(event) ?? []) waiter.resolve(value)
    waiters.delete(event)
  }
  const onData = (chunk: Buffer) => {
    output += chunk.toString('utf8')
    const lines = output.split('\n')
    output = lines.pop() ?? ''
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (parsed.event === 'error') {
          fail(new VoiceRuntimeError(`${processLabel} failed.`))
        } else if (parsed.event === 'ready' || parsed.event === 'complete') {
          emit(parsed.event, parsed)
        }
      } catch {
        // Ignore non-protocol stdout; it must never be shown to the user.
      }
    }
  }
  const onStderr = () => {
    // Keep the pipe drained but never retain potentially sensitive paths.
  }
  const onError = (error: Error) =>
    fail(safeError(error, `${processLabel} could not start.`))
  const onClose = (code: number | null) => {
    if (!received.has('complete')) {
      fail(
        new VoiceRuntimeError(
          code === 0
            ? `${processLabel} ended before it reported completion.`
            : `${processLabel} failed.`,
        ),
      )
    }
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    child.stdout?.off('data', onData)
    child.stderr?.off('data', onStderr)
    child.off('error', onError)
    child.off('close', onClose)
    const cancellation = new VoiceRuntimeError(`${processLabel} was stopped.`)
    for (const pending of waiters.values()) {
      for (const waiter of pending) waiter.reject(cancellation)
    }
    waiters.clear()
  }
  child.stdout?.on('data', onData)
  child.stderr?.on('data', onStderr)
  child.once('error', onError)
  child.once('close', onClose)
  return {
    waitFor(event) {
      const prior = received.get(event)
      if (prior) return Promise.resolve(prior)
      if (terminalError) return Promise.reject(terminalError)
      if (disposed)
        return Promise.reject(
          new VoiceRuntimeError(`${processLabel} was stopped.`),
        )
      return new Promise((resolve, reject) => {
        const pending = waiters.get(event) ?? []
        pending.push({ resolve, reject })
        waiters.set(event, pending)
      })
    },
    dispose,
  }
}

async function compileSwiftHelper(args: {
  directory: string
  name: string
  source: string
}): Promise<string> {
  const digest = createHash('sha256')
    .update(args.source)
    .digest('hex')
    .slice(0, 16)
  const sourcePath = join(
    args.directory,
    `kode-voice-${args.name}-${digest}.swift`,
  )
  const binaryPath = join(args.directory, `kode-voice-${args.name}-${digest}`)
  await writeFile(sourcePath, args.source, { encoding: 'utf8', mode: 0o600 })
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/swiftc',
      ['-O', '-framework', 'AVFoundation', sourcePath, '-o', binaryPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 4_096) stderr = stderr.slice(-4_096)
    })
    child.once('error', () =>
      reject(
        new VoiceRuntimeError(
          'Swift is required for native macOS voice support.',
        ),
      ),
    )
    child.once('close', code => {
      if (code === 0) resolve()
      else
        reject(
          new VoiceRuntimeError(
            'Could not prepare a native macOS voice helper.',
          ),
        )
    })
  })
  await chmod(binaryPath, 0o700)
  return binaryPath
}

const NATIVE_HELPER_CACHE_DIRECTORY = join(
  tmpdir(),
  'kode-voice-native-helpers',
)
const nativeHelperCompilations = new Map<string, Promise<string>>()

function helperDigest(source: string): string {
  return createHash('sha256').update(source).digest('hex').slice(0, 16)
}

async function ensureSecureHelperCacheDirectory(): Promise<void> {
  try {
    const details = await lstat(NATIVE_HELPER_CACHE_DIRECTORY)
    const currentUserId =
      typeof process.getuid === 'function' ? process.getuid() : undefined
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      (currentUserId !== undefined && details.uid !== currentUserId) ||
      (details.mode & 0o077) !== 0
    ) {
      throw new VoiceRuntimeError(
        'Native voice helper cache has unsafe permissions.',
      )
    }
  } catch (error) {
    if (error instanceof VoiceRuntimeError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT')
      throw safeError(error, 'Could not access the native voice helper cache.')
    await mkdir(NATIVE_HELPER_CACHE_DIRECTORY, { recursive: true, mode: 0o700 })
  }
  await chmod(NATIVE_HELPER_CACHE_DIRECTORY, 0o700)
}

async function cachedSwiftHelper(args: {
  name: string
  source: string
}): Promise<string> {
  const digest = helperDigest(args.source)
  const cacheKey = `${args.name}:${digest}`
  const previous = nativeHelperCompilations.get(cacheKey)
  if (previous) return previous

  const compilation = (async () => {
    await ensureSecureHelperCacheDirectory()
    const binaryPath = join(
      NATIVE_HELPER_CACHE_DIRECTORY,
      `kode-voice-${args.name}-${digest}`,
    )
    try {
      await access(binaryPath)
      return binaryPath
    } catch {
      // Build into a private sibling directory and rename only the completed
      // executable into the cache; callers never execute a partial compiler
      // output. Two Kode processes may produce the same deterministic helper,
      // which is safe because the source digest is part of the filename.
    }
    const buildDirectory = await mkdtemp(
      join(NATIVE_HELPER_CACHE_DIRECTORY, '.build-'),
    )
    await chmod(buildDirectory, 0o700)
    try {
      const compiledPath = await compileSwiftHelper({
        directory: buildDirectory,
        name: args.name,
        source: args.source,
      })
      await rename(compiledPath, binaryPath)
      await chmod(binaryPath, 0o700)
      return binaryPath
    } finally {
      await rm(buildDirectory, { recursive: true, force: true })
    }
  })()
  nativeHelperCompilations.set(cacheKey, compilation)
  try {
    return await compilation
  } catch (error) {
    nativeHelperCompilations.delete(cacheKey)
    throw error
  }
}

async function compileRecorder(): Promise<string> {
  return cachedSwiftHelper({ name: 'recorder', source: RECORDER_SOURCE })
}

async function compilePcmPlayer(): Promise<string> {
  return cachedSwiftHelper({ name: 'pcm-player', source: PCM_PLAYER_SOURCE })
}

export function isNativeVoiceSupported(): boolean {
  return process.platform === 'darwin'
}

/**
 * Verify the local native prerequisite without opening the microphone. This is
 * safe for diagnostics and CI on macOS; actual capture still requires a user
 * granted TCC microphone permission.
 */
export async function verifyMacOSVoiceRuntime(): Promise<void> {
  if (!isNativeVoiceSupported()) {
    throw new VoiceRuntimeError(
      'Voice recording is currently supported on macOS only.',
    )
  }
  await Promise.all([compileRecorder(), compilePcmPlayer()])
}

export async function startMacOSVoiceRecording(args: {
  maxRecordingSeconds: number
}): Promise<ActiveVoiceRecording> {
  if (!isNativeVoiceSupported()) {
    throw new VoiceRuntimeError(
      'Voice recording is currently supported on macOS only.',
    )
  }
  if (
    !Number.isSafeInteger(args.maxRecordingSeconds) ||
    args.maxRecordingSeconds < 1 ||
    args.maxRecordingSeconds > 180
  ) {
    throw new VoiceRuntimeError(
      'Voice recording duration must be from 1 to 180 seconds.',
    )
  }

  const directory = await mkdtemp(join(tmpdir(), 'kode-voice-'))
  await chmod(directory, 0o700)
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true })
  }
  let child: ChildProcess | null = null
  let protocol: VoiceHelperProtocol | null = null
  try {
    const helperPath = await compileRecorder()
    const audioPath = join(directory, 'recording.wav')
    const recorder = spawn(
      helperPath,
      ['record', '--path', audioPath, String(args.maxRecordingSeconds)],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    child = recorder
    const recorderProtocol = observeHelper(
      recorder,
      'Microphone recorder (check macOS microphone permission)',
    )
    protocol = recorderProtocol
    await recorderProtocol.waitFor('ready')
    let finished = false

    const stop = async (): Promise<RecordedVoiceAudio> => {
      if (finished)
        throw new VoiceRuntimeError('The recording is no longer active.')
      finished = true
      recorder.stdin?.end('\n')
      try {
        const complete = await recorderProtocol.waitFor('complete')
        const durationMs = complete.durationMs
        if (
          typeof durationMs !== 'number' ||
          !Number.isSafeInteger(durationMs) ||
          durationMs <= 0
        ) {
          throw new VoiceRuntimeError(
            'Microphone recording did not produce a valid duration.',
          )
        }
        const bytes = new Uint8Array(await readFile(audioPath))
        if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) {
          throw new VoiceRuntimeError(
            'Recorded audio exceeded the safe 10 MB upload limit.',
          )
        }
        if (!hasPcm16WavSignal(bytes)) {
          throw new VoiceRuntimeError(
            'No microphone signal was captured. Check macOS microphone permission and the selected input device.',
          )
        }
        return { bytes, mimeType: 'audio/wav', durationMs }
      } finally {
        recorderProtocol.dispose()
        await cleanup()
      }
    }

    const cancel = async () => {
      if (finished) return
      finished = true
      recorder.kill('SIGTERM')
      recorderProtocol.dispose()
      await cleanup()
    }
    return { stop, cancel }
  } catch (error) {
    child?.kill('SIGTERM')
    protocol?.dispose()
    await cleanup()
    throw safeError(error, 'Voice recorder could not be prepared.')
  }
}

export const __macOSVoiceForTests = {
  hasPcm16WavSignal,
}

function writePcmFrame(child: ChildProcess, bytes: Uint8Array): Promise<void> {
  if (
    bytes.length === 0 ||
    bytes.length > 1_048_576 ||
    bytes.length % 2 !== 0
  ) {
    return Promise.reject(
      new VoiceRuntimeError(
        'PCM audio frames must be non-empty even-sized blocks up to 1 MB.',
      ),
    )
  }
  const input = child.stdin
  if (!input || input.destroyed) {
    return Promise.reject(
      new VoiceRuntimeError('Native PCM player is no longer available.'),
    )
  }
  const frame = Buffer.allocUnsafe(4 + bytes.length)
  frame.writeUInt32BE(bytes.length, 0)
  Buffer.from(bytes).copy(frame, 4)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error | null) => {
      if (settled) return
      settled = true
      input.off('error', onError)
      if (error) reject(new VoiceRuntimeError('Native PCM playback failed.'))
      else resolve()
    }
    const onError = () => finish(new Error('write failed'))
    input.once('error', onError)
    input.write(frame, finish)
  })
}

/**
 * Starts bounded-queue PCM16 playback for MiMo's SSE TTS response. Callers
 * must finish or cancel exactly once; either path removes all temporary files.
 */
export async function startMacOSPCMPlayback(args: {
  sampleRate: number
}): Promise<ActiveVoicePCMPlayback> {
  if (!isNativeVoiceSupported()) {
    throw new VoiceRuntimeError(
      'Voice playback is currently supported on macOS only.',
    )
  }
  if (
    !Number.isSafeInteger(args.sampleRate) ||
    args.sampleRate < 8_000 ||
    args.sampleRate > 96_000
  ) {
    throw new VoiceRuntimeError(
      'PCM sample rate must be an integer from 8000 to 96000 Hz.',
    )
  }
  const directory = await mkdtemp(join(tmpdir(), 'kode-voice-pcm-'))
  await chmod(directory, 0o700)
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true })
  }
  let child: ChildProcess | null = null
  let protocol: VoiceHelperProtocol | null = null
  try {
    const helperPath = await compilePcmPlayer()
    const player = spawn(
      helperPath,
      ['play-pcm', '--sample-rate', String(args.sampleRate), 'mono'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    child = player
    const playerProtocol = observeHelper(player, 'Native PCM player')
    protocol = playerProtocol
    await playerProtocol.waitFor('ready')
    let finished = false
    return {
      write: bytes => {
        if (finished) {
          return Promise.reject(
            new VoiceRuntimeError('Native PCM player is no longer active.'),
          )
        }
        return writePcmFrame(player, bytes)
      },
      finish: async () => {
        if (finished) return
        finished = true
        player.stdin?.end()
        try {
          await playerProtocol.waitFor('complete')
        } finally {
          playerProtocol.dispose()
          await cleanup()
        }
      },
      cancel: async () => {
        if (finished) return
        finished = true
        player.kill('SIGTERM')
        playerProtocol.dispose()
        await cleanup()
      },
    }
  } catch (error) {
    child?.kill('SIGTERM')
    protocol?.dispose()
    await cleanup()
    throw safeError(error, 'Native PCM playback could not be prepared.')
  }
}

/** Start WAV playback without keeping a user-visible file. */
export async function startMacOSVoicePlayback(
  bytes: Uint8Array,
): Promise<NativeVoicePlayback> {
  if (!isNativeVoiceSupported()) {
    throw new VoiceRuntimeError(
      'Voice playback is currently supported on macOS only.',
    )
  }
  if (bytes.length === 0 || bytes.length > 24 * 1024 * 1024) {
    throw new VoiceRuntimeError(
      'Synthesized audio exceeded the safe playback limit.',
    )
  }
  const directory = await mkdtemp(join(tmpdir(), 'kode-voice-play-'))
  await chmod(directory, 0o700)
  const path = join(directory, 'reply.wav')
  try {
    await writeFile(path, bytes, { mode: 0o600 })
    const child = spawn('/usr/bin/afplay', [path], { stdio: 'ignore' })
    let stopped = false
    const completed = new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = async (error?: Error) => {
        if (settled) return
        settled = true
        try {
          await rm(directory, { recursive: true, force: true })
        } finally {
          if (error) reject(error)
          else resolve()
        }
      }
      child.once('error', () => {
        void finish(
          new VoiceRuntimeError('macOS audio playback could not start.'),
        )
      })
      child.once('close', code => {
        void finish(
          stopped || code === 0
            ? undefined
            : new VoiceRuntimeError('macOS audio playback failed.'),
        )
      })
    })
    return {
      completed,
      stop() {
        if (stopped) return
        stopped = true
        child.kill('SIGTERM')
      },
    }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

/** Play an already-synthesized WAV without keeping a user-visible file. */
export async function playMacOSVoiceAudio(bytes: Uint8Array): Promise<void> {
  const playback = await startMacOSVoicePlayback(bytes)
  await playback.completed
}
