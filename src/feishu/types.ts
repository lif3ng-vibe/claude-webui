/** 飞书「消息卡片」（交互卡片）JSON 骨架。具体元素由 formatter 按飞书卡片协议构造。 */
export interface FeishuCard {
  /** 卡片整体配置（如是否可更新、宽屏自适应等）。 */
  config?: Record<string, unknown>;
  /** 卡片头部（标题 + 模板色）。 */
  header?: Record<string, unknown>;
  /** 卡片正文元素（markdown / divider / 折叠块 / column_set 等）。 */
  elements?: unknown[];
}

/**
 * 飞书发消息封装。Bot 用 lark client 实现一个 adapter；
 * 测试注入 fake，不发真实网络。
 */
export interface FeishuSender {
  /** 发卡片，返回 message_id。receiveIdType: 'open_id'（发给个人）或 'chat_id'（发到会话）。 */
  sendCard(receiveIdType: 'open_id' | 'chat_id', receiveId: string, card: FeishuCard): Promise<string>;
  /** 更新（patch）已发卡片的内容（增量流式刷新用）。 */
  patchCard(messageId: string, card: FeishuCard): Promise<void>;
  /** 发纯文本消息。 */
  sendText(receiveIdType: 'open_id' | 'chat_id', receiveId: string, text: string): Promise<void>;
}
