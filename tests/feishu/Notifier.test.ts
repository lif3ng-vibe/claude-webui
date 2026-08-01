import { describe, it, expect } from 'vitest';
import { Notifier } from '../../src/feishu/Notifier.js';
import type { FeishuSender } from '../../src/feishu/types.js';

function mockSender(): { sender: FeishuSender; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const sender: FeishuSender = {
    sendCard: async (type, id, card) => {
      calls.push({ m: 'sendCard', type, id, card });
      return 'msg_1';
    },
    patchCard: async (id, card) => {
      calls.push({ m: 'patchCard', id, card });
    },
    sendText: async (type, id, text) => {
      calls.push({ m: 'sendText', type, id, text });
    },
  };
  return { sender, calls };
}

describe('Notifier', () => {
  it('chatIdForNotify 优先（chat_id）', async () => {
    const { sender, calls } = mockSender();
    const n = new Notifier(sender, { chatIdForNotify: 'oc_g', fallbackOpenId: 'ou_x' });
    await n.notify({ text: 'hi' });
    expect(calls[0]).toMatchObject({ m: 'sendText', type: 'chat_id', id: 'oc_g', text: 'hi' });
  });

  it('无 chatId 用 fallbackOpenId（open_id）', async () => {
    const { sender, calls } = mockSender();
    const n = new Notifier(sender, { fallbackOpenId: 'ou_x' });
    await n.notify({ text: 'hi' });
    expect(calls[0]).toMatchObject({ m: 'sendText', type: 'open_id', id: 'ou_x' });
  });

  it('都无目标 → 不发送，返回 false', async () => {
    const { sender, calls } = mockSender();
    const n = new Notifier(sender, {});
    const ok = await n.notify({ text: 'hi' });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('card 优先于 text', async () => {
    const { sender, calls } = mockSender();
    const n = new Notifier(sender, { fallbackOpenId: 'ou_x' });
    await n.notify({ card: { elements: [] }, text: 'hi' });
    expect(calls[0].m).toBe('sendCard');
  });
});
