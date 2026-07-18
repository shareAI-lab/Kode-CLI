import { Message, Timeline, Snapshot, AgentInfo, ToolCallRecord, AgentChannel } from '../../core/types';
import { TodoSnapshot } from '../../core/todo';
import { logger } from '../../utils/logger';
import {
  Store,
  HistoryWindow,
  CompressionRecord,
  RecoveredFile,
  MediaCacheRecord,
} from './types';

/**
 * 目录结构规范：
 *
 * {baseDir}/{agentId}/
 * ├── runtime/              # 运行时状态（带 WAL 保护）
 * │   ├── messages.json
 * │   ├── messages.wal
 * │   ├── tool-calls.json
 * │   ├── tool-calls.wal
 * │   └── todos.json
 * ├── events/              # 事件流（按通道分离，带 WAL）
 * │   ├── progress.log
 * │   ├── progress.wal
 * │   ├── control.log
 * │   ├── control.wal
 * │   ├── monitor.log
 * │   └── monitor.wal
 * ├── history/             # 历史归档
 * │   ├── windows/
 * │   │   └── {timestamp}.json
 * │   ├── compressions/
 * │   │   └── {timestamp}.json
 * │   └── recovered/
 * │       └── {filename}_{timestamp}.txt
 * ├── snapshots/           # 快照
 * │   └── {snapshotId}.json
 * └── meta.json           # 元信息
 */

interface BufferedWriter {
  timer?: NodeJS.Timeout;
  buffer: string[];
  flushing: string[];
  walWriting?: Promise<void>;
  recovered?: boolean;
}

interface ChannelWriters {
  progress: BufferedWriter;
  control: BufferedWriter;
  monitor: BufferedWriter;
}

export class JSONStore implements Store {
  private eventWriters = new Map<string, ChannelWriters>();
  private walQueue = new Map<string, Promise<void>>();
  private walRecovered = new Set<string>();
  private infoWriteQueue = new Map<string, Promise<void>>();

  constructor(private baseDir: string, private flushIntervalMs = 50) {
    // 启动时主动扫描并恢复所有 WAL
    void this.recoverAllWALs();
  }

  // ========== 路径管理 ==========

  private getAgentDir(agentId: string): string {
    const path = require('path');
    return path.join(this.baseDir, agentId);
  }

  private getRuntimePath(agentId: string, file: string): string {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(this.baseDir, agentId, 'runtime');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, file);
  }

  private getEventsPath(agentId: string, file: string): string {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(this.baseDir, agentId, 'events');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, file);
  }

  private getHistoryDir(agentId: string, subdir: string): string {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(this.baseDir, agentId, 'history', subdir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getMediaCachePath(agentId: string): string {
    return this.getRuntimePath(agentId, 'media-cache.json');
  }

  private getSnapshotsDir(agentId: string): string {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(this.baseDir, agentId, 'snapshots');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  private getMetaPath(agentId: string): string {
    const path = require('path');
    return path.join(this.baseDir, agentId, 'meta.json');
  }

  private async writeFileSafe(filePath: string, data: string): Promise<void> {
    const fsp = require('fs').promises;
    const path = require('path');
    try {
      await fsp.writeFile(filePath, data, 'utf-8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, data, 'utf-8');
    }
  }

  private async appendFileSafe(filePath: string, data: string): Promise<void> {
    const fsp = require('fs').promises;
    const path = require('path');
    try {
      await fsp.appendFile(filePath, data, 'utf-8');
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.appendFile(filePath, data, 'utf-8');
    }
  }

  private async renameSafe(tmpPath: string, destPath: string): Promise<void> {
    const fs = require('fs');
    const fsp = fs.promises;
    const path = require('path');
    try {
      await fsp.rename(tmpPath, destPath);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
      await fsp.mkdir(path.dirname(destPath), { recursive: true });
      await fsp.rename(tmpPath, destPath);
    }
  }

  // ========== 运行时状态管理（带 WAL） ==========

  async saveMessages(agentId: string, messages: Message[]): Promise<void> {
    await this.saveWithWal(agentId, 'messages', messages);
  }

  async loadMessages(agentId: string): Promise<Message[]> {
    return await this.loadWithWal(agentId, 'messages') || [];
  }

  async saveToolCallRecords(agentId: string, records: ToolCallRecord[]): Promise<void> {
    await this.saveWithWal(agentId, 'tool-calls', records);
  }

  async loadToolCallRecords(agentId: string): Promise<ToolCallRecord[]> {
    return await this.loadWithWal(agentId, 'tool-calls') || [];
  }

  async saveTodos(agentId: string, snapshot: TodoSnapshot): Promise<void> {
    const path = this.getRuntimePath(agentId, 'todos.json');
    await this.writeFileSafe(path, JSON.stringify(snapshot, null, 2));
  }

  async loadTodos(agentId: string): Promise<TodoSnapshot | undefined> {
    const fs = require('fs').promises;
    try {
      const data = await fs.readFile(this.getRuntimePath(agentId, 'todos.json'), 'utf-8');
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  // ========== 统一的 WAL 读写策略 ==========

  private async saveWithWal<T>(agentId: string, name: string, data: T): Promise<void> {
    const fs = require('fs');
    const path = this.getRuntimePath(agentId, `${name}.json`);
    const walPath = this.getRuntimePath(agentId, `${name}.wal`);

    // 1. Write to WAL first
    const walData = JSON.stringify({ data, timestamp: Date.now() });
    await this.queueWalWrite(agentId, name, async () => {
      await this.writeFileSafe(walPath, walData);
    });

    // 2. Write to main file (atomic: tmp + rename)
    const tmp = `${path}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    await this.writeFileSafe(tmp, payload);
    try {
      await this.renameSafe(tmp, path);
    } catch (err: any) {
      if (err?.code === 'ENOENT' && !fs.existsSync(tmp)) {
        await this.writeFileSafe(tmp, payload);
        await this.renameSafe(tmp, path);
      } else {
        throw err;
      }
    }

    // 3. Remove WAL after successful write
    if (fs.existsSync(walPath)) {
      await fs.promises.unlink(walPath).catch(() => undefined);
    }
  }

  private async loadWithWal<T>(agentId: string, name: string): Promise<T | undefined> {
    const fs = require('fs');
    const path = this.getRuntimePath(agentId, `${name}.json`);
    const walPath = this.getRuntimePath(agentId, `${name}.wal`);

    // 1. Check and recover from WAL if exists
    if (fs.existsSync(walPath)) {
      try {
        const walData = JSON.parse(await fs.promises.readFile(walPath, 'utf-8'));
        if (walData.data !== undefined) {
          // Recover from WAL
          const tmp = `${path}.tmp`;
          await this.writeFileSafe(tmp, JSON.stringify(walData.data, null, 2));
          await this.renameSafe(tmp, path);
          await fs.promises.unlink(walPath).catch(() => undefined);
        }
      } catch (err) {
        logger.error(`Failed to recover ${name} from WAL:`, err);
      }
    }

    // 2. Load from main file
    try {
      const data = await fs.promises.readFile(path, 'utf-8');
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  private async queueWalWrite(agentId: string, name: string, write: () => Promise<void>): Promise<void> {
    const key = `${agentId}:${name}`;

    // 链式追加，确保顺序执行
    const previous = this.walQueue.get(key) || Promise.resolve();
    const next = previous
      .then(() => write())  // 前一个成功后执行
      .catch((err) => {
        // 即使前一个失败，也尝试当前写入
        logger.error(`[WAL] Previous write failed for ${key}, attempting current write:`, err);
        return write();
      });

    this.walQueue.set(key, next);

    try {
      await next;
    } catch (err) {
      // 记录但不阻塞调用者
      logger.error(`[WAL] Write failed for ${key}:`, err);
      throw err; // 重新抛出让调用者处理
    } finally {
      // 清理完成的 promise（避免内存泄漏）
      if (this.walQueue.get(key) === next) {
        this.walQueue.delete(key);
      }
    }
  }

  // ========== WAL 主动恢复 ==========

  /**
   * Store 初始化时主动恢复所有 WAL 文件
   */
  private async recoverAllWALs(): Promise<void> {
    const fs = require('fs').promises;
    const path = require('path');

    try {
      const agentDirs = await fs.readdir(this.baseDir).catch(() => []);

      for (const agentId of agentDirs) {
        const agentDir = path.join(this.baseDir, agentId);
        const stat = await fs.stat(agentDir).catch(() => null);
        if (!stat?.isDirectory()) continue;

        // 恢复运行时 WAL
        await this.recoverRuntimeWAL(agentId, 'messages');
        await this.recoverRuntimeWAL(agentId, 'tool-calls');

        // 恢复事件 WAL
        await this.recoverEventWALFile(agentId, 'progress');
        await this.recoverEventWALFile(agentId, 'control');
        await this.recoverEventWALFile(agentId, 'monitor');
      }

      if (agentDirs.length > 0) {
        logger.log(`[Store] WAL recovery completed for ${agentDirs.length} agents`);
      }
    } catch (err) {
      logger.error('[Store] WAL recovery failed:', err);
    }
  }

  /**
   * 恢复运行时数据的 WAL
   */
  private async recoverRuntimeWAL(agentId: string, name: string): Promise<void> {
    const fs = require('fs');
    const fsp = fs.promises;
    const walKey = `${agentId}:${name}`;

    if (this.walRecovered.has(walKey)) return;
    this.walRecovered.add(walKey);

    const path = this.getRuntimePath(agentId, `${name}.json`);
    const walPath = this.getRuntimePath(agentId, `${name}.wal`);

    if (!fs.existsSync(walPath)) return;

    try {
      const walData = JSON.parse(await fsp.readFile(walPath, 'utf-8'));
      if (walData.data !== undefined) {
        const tmp = `${path}.tmp`;
        await fsp.writeFile(tmp, JSON.stringify(walData.data, null, 2), 'utf-8');
        await fsp.rename(tmp, path);
        await fsp.unlink(walPath);
        logger.log(`[Store] Recovered ${name} from WAL for ${agentId}`);
      }
    } catch (err) {
      logger.error(`[Store] Failed to recover ${name} WAL for ${agentId}:`, err);
      // 重命名损坏的 WAL 以便人工检查
      await fsp.rename(walPath, `${walPath}.corrupted`).catch(() => {});
    }
  }

  /**
   * 恢复事件流的 WAL
   */
  private async recoverEventWALFile(agentId: string, channel: AgentChannel): Promise<void> {
    const walKey = `${agentId}:${channel}`;
    if (this.walRecovered.has(walKey)) return;
    this.walRecovered.add(walKey);

    const fs = require('fs');
    const fsp = fs.promises;
    const walPath = this.getEventsPath(agentId, `${channel}.wal`);

    if (!fs.existsSync(walPath)) return;

    try {
      const data = await fsp.readFile(walPath, 'utf-8');
      const lines = data.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const payload = lines.join('\n') + '\n';
        await fsp.appendFile(this.getEventsPath(agentId, `${channel}.log`), payload);
        await fsp.unlink(walPath);
        logger.log(`[Store] Recovered ${lines.length} events from ${channel} WAL for ${agentId}`);
      }
    } catch (err) {
      logger.error(`[Store] Failed to recover ${channel} WAL for ${agentId}:`, err);
      await fsp.rename(walPath, `${walPath}.corrupted`).catch(() => {});
    }
  }

  // ========== 事件流管理（按通道缓冲 + WAL） ==========

  async appendEvent(agentId: string, timeline: Timeline): Promise<void> {
    const entry = JSON.stringify(timeline);
    const channel = timeline.event.channel as AgentChannel;
    await this.recoverEventWal(agentId, channel);
    const writers = this.getEventWriters(agentId);
    const writer = writers[channel];
    writer.buffer.push(entry);
    await this.writeEventWal(agentId, channel, writer);
    if (!writer.timer) {
      writer.timer = setTimeout(() => {
        void this.flushEvents(agentId, channel);
      }, this.flushIntervalMs);
    }
  }

  async *readEvents(agentId: string, opts?: { since?: any; channel?: AgentChannel }): AsyncIterable<Timeline> {
    const channels = opts?.channel ? [opts.channel] : (['progress', 'control', 'monitor'] as AgentChannel[]);

    for (const channel of channels) {
      await this.recoverEventWal(agentId, channel);
      await this.flushEvents(agentId, channel);
      const fs = require('fs');
      const readline = require('readline');
      const path = this.getEventsPath(agentId, `${channel}.log`);
      if (!fs.existsSync(path)) continue;

      const stream = fs.createReadStream(path, { encoding: 'utf-8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as Timeline;
          if (opts?.since && event.bookmark.seq <= opts.since.seq) continue;
          yield event;
        } catch {
          // skip corrupted lines
        }
      }
    }
  }

  private getEventWriters(agentId: string): ChannelWriters {
    let writers = this.eventWriters.get(agentId);
    if (!writers) {
      writers = {
        progress: { buffer: [], flushing: [] },
        control: { buffer: [], flushing: [] },
        monitor: { buffer: [], flushing: [] },
      };
      this.eventWriters.set(agentId, writers);
    }
    return writers;
  }

  private async flushEvents(agentId: string, channel: AgentChannel): Promise<void> {
    const writers = this.eventWriters.get(agentId);
    if (!writers) return;
    const writer = writers[channel];
    if (!writer) return;

    if (writer.timer) {
      clearTimeout(writer.timer);
      writer.timer = undefined;
    }

    if (writer.buffer.length > 0) {
      writer.flushing.push(...writer.buffer);
      writer.buffer = [];
    }

    if (writer.flushing.length === 0) {
      await this.writeEventWal(agentId, channel, writer);
      return;
    }

    const payload = writer.flushing.join('\n') + '\n';
    await this.appendFileSafe(this.getEventsPath(agentId, `${channel}.log`), payload);
    writer.flushing = [];
    await this.writeEventWal(agentId, channel, writer);
  }

  private async recoverEventWal(agentId: string, channel: AgentChannel): Promise<void> {
    const walKey = `${agentId}:${channel}`;
    if (this.walRecovered.has(walKey)) return;

    const writers = this.getEventWriters(agentId);
    const writer = writers[channel];
    writer.recovered = true;
    this.walRecovered.add(walKey);

    const fs = require('fs');
    const fsp = fs.promises;
    const walPath = this.getEventsPath(agentId, `${channel}.wal`);
    if (!fs.existsSync(walPath)) return;

    try {
      const data = await fsp.readFile(walPath, 'utf-8');
      const lines = data.split('\n').filter(Boolean);
      if (lines.length > 0) {
        const payload = lines.join('\n') + '\n';
        await fsp.appendFile(this.getEventsPath(agentId, `${channel}.log`), payload);
      }
      await fsp.unlink(walPath);
    } catch {
      // WAL corrupted, keep it for manual inspection
    }
  }

  private async writeEventWal(agentId: string, channel: AgentChannel, writer: BufferedWriter): Promise<void> {
    const fs = require('fs');
    const walPath = this.getEventsPath(agentId, `${channel}.wal`);
    const schedule = async () => {
      const entries = [...writer.flushing, ...writer.buffer];
      if (entries.length > 0) {
        await this.writeFileSafe(walPath, entries.join('\n') + '\n');
      } else if (fs.existsSync(walPath)) {
        await fs.promises.unlink(walPath).catch(() => undefined);
      }
    };
    writer.walWriting = (writer.walWriting || Promise.resolve()).then(schedule, schedule);
    await writer.walWriting;
  }

  // ========== 历史与压缩管理 ==========

  async saveHistoryWindow(agentId: string, window: HistoryWindow): Promise<void> {
    const path = require('path');
    const dir = this.getHistoryDir(agentId, 'windows');
    const filePath = path.join(dir, `${window.timestamp}.json`);
    await this.writeFileSafe(filePath, JSON.stringify(window, null, 2));
  }

  async loadHistoryWindows(agentId: string): Promise<HistoryWindow[]> {
    const fs = require('fs').promises;
    const path = require('path');
    try {
      const dir = this.getHistoryDir(agentId, 'windows');
      const files = await fs.readdir(dir);
      const windows: HistoryWindow[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(dir, file), 'utf-8');
          windows.push(JSON.parse(data));
        }
      }
      return windows.sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    }
  }

  async saveCompressionRecord(agentId: string, record: CompressionRecord): Promise<void> {
    const path = require('path');
    const dir = this.getHistoryDir(agentId, 'compressions');
    const filePath = path.join(dir, `${record.timestamp}.json`);
    await this.writeFileSafe(filePath, JSON.stringify(record, null, 2));
  }

  async loadCompressionRecords(agentId: string): Promise<CompressionRecord[]> {
    const fs = require('fs').promises;
    const path = require('path');
    try {
      const dir = this.getHistoryDir(agentId, 'compressions');
      const files = await fs.readdir(dir);
      const records: CompressionRecord[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(dir, file), 'utf-8');
          records.push(JSON.parse(data));
        }
      }
      return records.sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    }
  }

  async saveRecoveredFile(agentId: string, file: RecoveredFile): Promise<void> {
    const path = require('path');
    const dir = this.getHistoryDir(agentId, 'recovered');
    const safePath = file.path.replace(/[\/\\]/g, '_');
    const filePath = path.join(dir, `${safePath}_${file.timestamp}.txt`);
    const header = `# Recovered: ${file.path}\n# Timestamp: ${file.timestamp}\n# Mtime: ${file.mtime}\n\n`;
    await this.writeFileSafe(filePath, header + file.content);
  }

  async loadRecoveredFiles(agentId: string): Promise<RecoveredFile[]> {
    const fs = require('fs').promises;
    const path = require('path');
    try {
      const dir = this.getHistoryDir(agentId, 'recovered');
      const files = await fs.readdir(dir);
      const recovered: RecoveredFile[] = [];
      for (const file of files) {
        const data = await fs.readFile(path.join(dir, file), 'utf-8');
        const lines = data.split('\n');
        const pathMatch = lines[0]?.match(/# Recovered: (.+)/);
        const tsMatch = lines[1]?.match(/# Timestamp: (\d+)/);
        const mtimeMatch = lines[2]?.match(/# Mtime: (\d+)/);
        if (pathMatch && tsMatch && mtimeMatch) {
          recovered.push({
            path: pathMatch[1],
            content: lines.slice(4).join('\n'),
            mtime: parseInt(mtimeMatch[1]),
            timestamp: parseInt(tsMatch[1]),
          });
        }
      }
      return recovered.sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    }
  }

  async saveMediaCache(agentId: string, records: MediaCacheRecord[]): Promise<void> {
    const fs = require('fs').promises;
    const filePath = this.getMediaCachePath(agentId);
    await fs.writeFile(filePath, JSON.stringify(records, null, 2), 'utf-8');
  }

  async loadMediaCache(agentId: string): Promise<MediaCacheRecord[]> {
    const fs = require('fs').promises;
    const filePath = this.getMediaCachePath(agentId);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? (parsed as MediaCacheRecord[]) : [];
    } catch {
      return [];
    }
  }

  // ========== 快照管理 ==========

  async saveSnapshot(agentId: string, snapshot: Snapshot): Promise<void> {
    const path = require('path');
    const dir = this.getSnapshotsDir(agentId);
    const filePath = path.join(dir, `${snapshot.id}.json`);
    await this.writeFileSafe(filePath, JSON.stringify(snapshot, null, 2));
  }

  async loadSnapshot(agentId: string, snapshotId: string): Promise<Snapshot | undefined> {
    const fs = require('fs').promises;
    const path = require('path');
    try {
      const dir = this.getSnapshotsDir(agentId);
      const data = await fs.readFile(path.join(dir, `${snapshotId}.json`), 'utf-8');
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  async listSnapshots(agentId: string): Promise<Snapshot[]> {
    const fs = require('fs').promises;
    const path = require('path');
    try {
      const dir = this.getSnapshotsDir(agentId);
      const files = await fs.readdir(dir);
      const snapshots: Snapshot[] = [];
      for (const file of files) {
        if (file.endsWith('.json')) {
          const data = await fs.readFile(path.join(dir, file), 'utf-8');
          snapshots.push(JSON.parse(data));
        }
      }
      return snapshots;
    } catch {
      return [];
    }
  }

  // ========== 元数据管理 ==========

  async saveInfo(agentId: string, info: AgentInfo): Promise<void> {
    const previous = this.infoWriteQueue.get(agentId) || Promise.resolve();
    const write = async () => {
      const fs = require('fs');
      const metaPath = this.getMetaPath(agentId);
      const tmpPath = `${metaPath}.tmp.${process.pid}.${Date.now()}`;

      try {
        await this.writeFileSafe(tmpPath, JSON.stringify(info, null, 2));
        await this.renameSafe(tmpPath, metaPath);
      } finally {
        await fs.promises.unlink(tmpPath).catch(() => undefined);
      }
    };
    const next = previous.then(write, write);

    this.infoWriteQueue.set(agentId, next);
    try {
      await next;
    } finally {
      if (this.infoWriteQueue.get(agentId) === next) {
        this.infoWriteQueue.delete(agentId);
      }
    }
  }

  async loadInfo(agentId: string): Promise<AgentInfo | undefined> {
    const fs = require('fs').promises;
    try {
      const pendingWrite = this.infoWriteQueue.get(agentId);
      if (pendingWrite) await pendingWrite;

      const data = await fs.readFile(this.getMetaPath(agentId), 'utf-8');
      return JSON.parse(data);
    } catch {
      return undefined;
    }
  }

  // ========== 生命周期管理 ==========

  async exists(agentId: string): Promise<boolean> {
    const fs = require('fs').promises;
    try {
      await fs.access(this.getAgentDir(agentId));
      return true;
    } catch {
      return false;
    }
  }

  async delete(agentId: string): Promise<void> {
    const fs = require('fs').promises;
    await fs.rm(this.getAgentDir(agentId), { recursive: true, force: true });
  }

  async list(prefix?: string): Promise<string[]> {
    const fs = require('fs').promises;
    try {
      const dirs = await fs.readdir(this.baseDir);
      return prefix ? dirs.filter((d: string) => d.startsWith(prefix)) : dirs;
    } catch {
      return [];
    }
  }
}
