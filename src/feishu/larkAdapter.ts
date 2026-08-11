// lark（飞书）SDK 适配层：把飞书 API 封装成项目内部的 FeishuSender + 长连接监听器。
// 用 `as any` 规避 SDK 巨大的生成类型，保持本层薄；逻辑都在已测的 Bot/formatter/commands 里。
import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuApp } from './feishuConfig.js';
import type { FeishuSender } from './types.js';
import type { BotMessageEvent, CardActionEvent } from './Bot.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = any;

/** 域名映射到 SDK 枚举（国内 feishu / 国际 lark）。 */
function domainOf(domain: 'feishu' | 'lark'): unknown {
  const d = (lark as AnyClient).Domain;
  return domain === 'lark' ? d?.Lark : d?.Feishu;
}

/** 建 lark API client（发消息 / 更新消息用）。 */
export function newLarkClient(cfg: FeishuApp): AnyClient {
  const Client = (lark as AnyClient).Client;
  return new Client({ appId: cfg.appId, appSecret: cfg.appSecret, domain: domainOf(cfg.domain) });
}

/**
 * best-effort 读取应用名（机器人显示名）。飞书「获取应用信息」API 对自建应用
 * 读自己通常权限不足——读到返回名字，读不到（403/无权限）返回 undefined（回退备注名）。
 */
export async function getBotName(client: AnyClient, appId: string): Promise<string | undefined> {
  try {
    const resp = await client.request({
      method: 'GET',
      url: `/open-apis/application/v6/applications/${appId}`,
      params: { lang: 'zh_cn' },
    });
    if (resp?.code !== 0) return undefined;
    const name = resp?.data?.app_name;
    if (typeof name === 'string' && name) return name;
    if (name && typeof name === 'object') {
      const n = name as Record<string, string>;
      return n.zh_cn || n.en_us || Object.values(n)[0];
    }
    return undefined;
  } catch {
    /* 权限不足 / 网络错误：忽略，回退备注名 */
    return undefined;
  }
}

/** 用 lark client 实现 FeishuSender（发卡片 / 更新卡片 / 发文本）。 */
export function createFeishuSender(client: AnyClient): FeishuSender {
  return {
    async sendCard(receiveIdType, receiveId, card) {
      const resp = await client.im.message.create({
        data: { receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) },
        params: { receive_id_type: receiveIdType },
      });
      if (resp.code !== 0) throw new Error(`feishu sendCard: ${resp.code} ${resp.msg}`);
      return (resp.data?.message_id as string | undefined) ?? '';
    },
    async patchCard(messageId, card) {
      const resp = await client.im.message.patch({
        data: { content: JSON.stringify(card) },
        // SDK 1.72：路径参数 message_id 必须走 path（旧版用 params 会被当 query，
        // 导致 fillApiPath 报 "request miss message_id path argument"，卡片永不更新）。
        path: { message_id: messageId },
      });
      if (resp.code !== 0) throw new Error(`feishu patchCard: ${resp.code} ${resp.msg}`);
    },
    async sendText(receiveIdType, receiveId, text) {
      const resp = await client.im.message.create({
        data: { receive_id: receiveId, msg_type: 'text', content: JSON.stringify({ text }) },
        params: { receive_id_type: receiveIdType },
      });
      if (resp.code !== 0) throw new Error(`feishu sendText: ${resp.code} ${resp.msg}`);
    },
  };
}

/**
 * 长连接监听器：start 用 lark.ws.Client 注册 im.message.receive_v1，把事件解析成 BotMessageEvent；
 * stop 关连接。handler 由 Bot.start 传入（即 Bot.handleMessage 的包装）。
 */
export function createFeishuListener(
  cfg: FeishuApp,
  onMessage: (ev: BotMessageEvent) => void,
  onCardAction?: (ev: CardActionEvent) => void,
): { start: () => Promise<void>; stop: () => Promise<void> } {
  const eventDispatcher = new (lark as AnyClient).EventDispatcher({}).register({
    'im.message.receive_v1': async (data: AnyClient) => {
      const openId: string = data?.sender?.sender_id?.open_id ?? '';
      const chatId: string | undefined = data?.message?.chat_id;
      const msgType: string = data?.message?.message_type ?? '';
      let text = '';
      if (msgType === 'text') {
        try {
          text = JSON.parse(data?.message?.content ?? '{}').text ?? '';
        } catch {
          text = '';
        }
      }
      const mentions = Array.isArray(data?.message?.mentions) ? data.message.mentions : [];
      onMessage({ openId, chatId, text, isMention: mentions.length > 0 });
    },
    // 卡片按钮点击（/sessions「进入会话」等）。需后台订阅 card.action.trigger（长连接方式）。
    'card.action.trigger': async (data: AnyClient) => {
      if (!onCardAction) return;
      onCardAction({
        value: data?.action?.value,
        openId: data?.operator?.open_id ?? '',
        chatId: data?.context?.open_chat_id ?? data?.open_chat_id,
      });
    },
  });
  // SDK 1.24+：长连接客户端改为顶层 WSClient（旧 lark.ws.Client 已移除），
  // eventDispatcher 由构造器迁到 start({}) 传入。
  const wsClient = new (lark as AnyClient).WSClient({
    appId: cfg.appId,
    appSecret: cfg.appSecret,
    loggerLevel: (lark as AnyClient).LoggerLevel?.info,
  });
  return {
    start: async () => {
      await wsClient.start({ eventDispatcher });
    },
    stop: async () => {
      try {
        wsClient.close({});
      } catch {
        /* 已关闭 */
      }
    },
  };
}
