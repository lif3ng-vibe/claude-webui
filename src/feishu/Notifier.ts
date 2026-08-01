import type { FeishuCard, FeishuSender } from './types.js';

export interface NotifierOpts {
  /** 通知目标会话（群）chat_id；不填则发给 fallbackOpenId 单聊。 */
  chatIdForNotify?: string;
  /** 兜底收件人 open_id（chatIdForNotify 缺失时用）。 */
  fallbackOpenId?: string;
}

/**
 * 飞书「通知」封装：把本地任务完成/出错推到**固定目标**（配置的群或本人单聊）。
 * 区别：Bot 的续接回复发给触发者本人（直接用 sender），Notifier 发给配置目标。
 */
export class Notifier {
  constructor(private readonly sender: FeishuSender, private readonly opts: NotifierOpts) {}

  /** 推送通知（card 优先于 text）。无可用目标则跳过，返回 false。 */
  async notify(msg: { card?: FeishuCard; text?: string }): Promise<boolean> {
    const t = this.target();
    if (!t) return false;
    if (msg.card) await this.sender.sendCard(t.type, t.id, msg.card);
    else if (msg.text != null) await this.sender.sendText(t.type, t.id, msg.text);
    return true;
  }

  private target(): { type: 'open_id' | 'chat_id'; id: string } | null {
    if (this.opts.chatIdForNotify) return { type: 'chat_id', id: this.opts.chatIdForNotify };
    if (this.opts.fallbackOpenId) return { type: 'open_id', id: this.opts.fallbackOpenId };
    return null;
  }
}
