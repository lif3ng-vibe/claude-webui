import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { parseStreamJsonLine, streamChildEvents } from '../../src/claude/Runner.js';

describe('parseStreamJsonLine', () => {
  it('解析合法 JSON 行', () => {
    expect(parseStreamJsonLine('{"type":"assistant"}')).toEqual({ ok: true, data: { type: 'assistant' } });
  });
  it('空行返回 ok:false', () => {
    expect(parseStreamJsonLine('   ')).toEqual({ ok: false });
  });
  it('无法解析的行返回 ok:false', () => {
    expect(parseStreamJsonLine('{not json')).toEqual({ ok: false });
  });
});

describe('streamChildEvents', () => {
  it('把子进程的 stdout 行解析为 stream-json，转发 stderr，最后发 exit', async () => {
    const script =
      "process.stdout.write(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'hi'}]}})+'\\n');" +
      "process.stderr.write('warn\\n');";
    const child = spawn(process.execPath, ['-e', script]);
    const events: Array<{ type: string; data?: unknown; text?: string; code?: number | null }> = [];
    for await (const e of streamChildEvents(child)) {
      events.push(e as any);
    }
    expect(events.some((e) => e.type === 'stream-json' && (e.data as any)?.type === 'assistant')).toBe(true);
    expect(events.some((e) => e.type === 'stderr' && e.text === 'warn')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'exit', code: 0 });
  });

  it('可在中途用 AbortSignal 终止子进程', async () => {
    const script = "setInterval(()=>process.stdout.write(JSON.stringify({type:'tick'})+'\\n'),10);";
    const child = spawn(process.execPath, ['-e', script]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const events: any[] = [];
    for await (const e of streamChildEvents(child, ac.signal)) events.push(e);
    expect(events.at(-1)).toEqual({ type: 'exit', code: null });
  });
});