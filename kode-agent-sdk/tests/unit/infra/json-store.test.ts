import fs from 'fs';
import path from 'path';
import { JSONStore } from '../../../src/infra/store';
import { Message } from '../../../src/core/types';
import { TestRunner, expect } from '../../helpers/utils';
import { TEST_ROOT } from '../../helpers/fixtures';

const runner = new TestRunner('JSONStore');

function createDir(name: string): string {
  const dir = path.join(TEST_ROOT, 'json-store', `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const sampleMessage: Message = {
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
};

runner
  .test('保存与加载运行时数据', async () => {
    const dir = createDir('runtime');
    const store = new JSONStore(dir);

    await store.saveMessages('agent', [sampleMessage]);
    const loadedMessages = await store.loadMessages('agent');
    expect.toEqual(loadedMessages.length, 1);

    const now = Date.now();
    await store.saveToolCallRecords('agent', [
      {
        id: 'tool-1',
        name: 'fs_read',
        input: {},
        state: 'COMPLETED',
        approval: { required: false },
        result: { ok: true },
        createdAt: now,
        updatedAt: now,
        auditTrail: [],
      },
    ]);
    const records = await store.loadToolCallRecords('agent');
    expect.toEqual(records.length, 1);

    await store.saveTodos('agent', { todos: [], version: 1, updatedAt: Date.now() });
    const todos = await store.loadTodos('agent');
    expect.toBeTruthy(todos);
  })

  .test('事件流Append并可读取', async () => {
    const dir = createDir('events');
    const store = new JSONStore(dir);
    const event = {
      cursor: 0,
      bookmark: { seq: 0, timestamp: Date.now() },
      event: { channel: 'progress', type: 'text_chunk', delta: 'hello', step: 1 },
    } as any;

    await store.appendEvent('agent', event);

    const events: any[] = [];
    for await (const entry of store.readEvents('agent')) {
      events.push(entry);
    }

    expect.toEqual(events.length, 1);
    expect.toEqual(events[0].event.type, 'text_chunk');
  })

  .test('历史窗口与压缩记录持久化', async () => {
    const dir = createDir('history');
    const store = new JSONStore(dir);
    const timestamp = Date.now();

    await store.saveHistoryWindow('agent', {
      id: 'window',
      messages: [sampleMessage],
      events: [],
      stats: { messageCount: 1, eventCount: 0, tokenCount: 10 },
      timestamp,
    });

    const windows = await store.loadHistoryWindows('agent');
    expect.toEqual(windows.length, 1);

    await store.saveCompressionRecord('agent', {
      id: 'comp',
      windowId: 'window',
      config: { model: 'mock', prompt: 'summary', threshold: 100 },
      summary: 'summary',
      ratio: 0.5,
      recoveredFiles: [],
      timestamp,
    });

    const records = await store.loadCompressionRecords('agent');
    expect.toEqual(records.length, 1);

    await store.saveRecoveredFile('agent', {
      path: 'note.md',
      content: '# note',
      mtime: timestamp,
      timestamp,
    });

    const recovered = await store.loadRecoveredFiles('agent');
    expect.toEqual(recovered.length, 1);
  })

  .test('快照与元信息管理', async () => {
    const dir = createDir('meta');
    const store = new JSONStore(dir);

    await store.saveSnapshot('agent', {
      id: 'snap-1',
      createdAt: Date.now(),
      metadata: {},
      messages: [sampleMessage],
    } as any);

    const snapshot = await store.loadSnapshot('agent', 'snap-1');
    expect.toBeTruthy(snapshot);

    await store.saveInfo('agent', {
      agentId: 'agent',
      templateId: 'tpl',
      createdAt: new Date().toISOString(),
      lineage: [],
      configVersion: 'test',
      messageCount: 0,
      lastSfpIndex: 0,
      metadata: {},
    });
    const info = await store.loadInfo('agent');
    expect.toEqual(info?.templateId, 'tpl');

    expect.toEqual(await store.exists('agent'), true);
    expect.toContain((await store.list()).join(','), 'agent');

    await store.delete('agent');
    expect.toEqual(await store.exists('agent'), false);
  })

  .test('元信息读取会等待同一 Agent 的在途写入', async () => {
    const dir = createDir('meta-pending-write');
    const store = new JSONStore(dir);
    const mutableStore = store as any;
    const writeFileSafe = mutableStore.writeFileSafe.bind(store);
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });

    mutableStore.writeFileSafe = async (filePath: string, data: string) => {
      if (filePath.includes('meta.json.tmp.')) await writeGate;
      await writeFileSafe(filePath, data);
    };

    const savePromise = store.saveInfo('agent', {
      agentId: 'agent',
      templateId: 'pending-template',
      createdAt: new Date().toISOString(),
      lineage: [],
      configVersion: 'test',
      messageCount: 0,
      lastSfpIndex: 0,
      metadata: {},
    });
    const loadPromise = store.loadInfo('agent');

    await new Promise(resolve => setTimeout(resolve, 10));
    releaseWrite();
    await savePromise;

    const info = await loadPromise;
    expect.toEqual(info?.templateId, 'pending-template');
  });

export async function run() {
  return await runner.run();
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
