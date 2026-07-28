export interface SSEEvent {
  event: string;
  data: any;
}

function parseSSE(chunk: string): SSEEvent | null {
  let event = 'message';
  let data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7);
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data: { text: data } };
  }
}

/** 读取 SSE 流，逐事件回调。 */
export async function readSSE(resp: Response, onEvent: (ev: SSEEvent) => void): Promise<void> {
  const reader = resp.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const ev = parseSSE(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
      if (ev) onEvent(ev);
    }
  }
}