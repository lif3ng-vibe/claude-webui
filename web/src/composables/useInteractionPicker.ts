import { ref, computed } from 'vue';
import { useDisplayStore } from '../stores/display';

/**
 * 交互浮层：从最近一次 assistant 回复文本里启发式抽出可点选的"快速回复"
 * （选项列表 / 是·否 / 继续）。headless（-p）模式没有结构化多选事件，只能对文本近似抽取。
 *
 * 显示与否由 display.quickReply 开关控制（useStorage → localStorage，同源多窗口经 storage 事件同步）：
 * 开启后所有会话窗口（SessionsView / SessionPage）都显示，关闭后都隐藏。
 */
export interface Interaction {
  label: string;
  payload: string;
  hint?: string;
}
export interface InteractionSet {
  title: string;
  actions: Interaction[];
}
interface OptionItem {
  marker: string;
  text: string;
}

/** 从 assistant 的 content（string 或 blocks）取出纯文本（拼接 text 块）。 */
export function textOfContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return (c as Array<{ type?: string; text?: string }>)
      .filter((b) => b?.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
  }
  return '';
}

/**
 * 启发式抽出"选项"：连续列表项（1./1)/a./-/* 等，同一风格，2–8 项、每项 ≤140 字），
 * 且其上方 3 行内是问句/选择提示（? / 选择 / which / …）。取最后一个符合条件的片段。
 */
function extractOptions(text: string): OptionItem[] {
  if (!text) return [];
  const lines = text.split('\n');
  const itemRe = /^\s*(\d{1,2}[.)]|\d{1,2}、|[a-zA-Z][.)]|[-*•])\s+(.+)$/;
  const cat = (m: string): string => (/^\d/.test(m) ? 'n' : /^[a-zA-Z]/.test(m) ? 'l' : 'b');
  const choiceRe = /[?？]|选择|选项|你想|哪个|哪一|which|option|pick|choose|还是|prefer/i;
  let best: OptionItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m0 = lines[i].match(itemRe);
    if (!m0) continue;
    const run: OptionItem[] = [];
    const style = cat(m0[1]);
    let j = i;
    for (; j < lines.length; j++) {
      const m = lines[j].match(itemRe);
      if (!m || cat(m[1]) !== style || m[2].trim().length > 140) break;
      run.push({ marker: m[1], text: m[2].trim() });
    }
    if (run.length >= 2 && run.length <= 8) {
      const ctx = lines.slice(Math.max(0, i - 3), i).join(' ');
      if (choiceRe.test(ctx) && run.length > best.length) best = run;
    }
    i = j - 1;
  }
  return best;
}

/** 是/否问句：含问号 + 是否/要不要/should I 之类。 */
function isYesNoQuestion(text: string): boolean {
  return /[?？]/.test(text) && /(是否|要不要|能不能|可不可以|确认一下|确认吗|确定吗|确定|应该|shall|should i|do you want|would you|can you|may i|is it ok|ok\?)/i.test(text);
}

/** 继续/确认提示：含问号 + 继续/proceed/continue，且不是是/否。 */
function isContinuePrompt(text: string): boolean {
  return !isYesNoQuestion(text) && /[?？]/.test(text) && /(继续吗|继续|proceed|continue|go on|carry on)/i.test(text);
}

/** 按优先级抽取交互：选项 > 是/否 > 继续。 */
export function extractInteractions(text: string): InteractionSet | null {
  const opts = extractOptions(text);
  if (opts.length) {
    return {
      title: 'Claude 给出的选项（点选直接发送）',
      actions: opts.map((o) => ({ label: `${o.marker}  ${o.text}`, payload: o.text, hint: '选项' })),
    };
  }
  if (isYesNoQuestion(text)) {
    return { title: 'Claude 在问 · 是/否', actions: [{ label: '是', payload: '是', hint: 'yes' }, { label: '否', payload: '否', hint: 'no' }] };
  }
  if (isContinuePrompt(text)) {
    return { title: '继续？', actions: [{ label: '继续', payload: '继续', hint: 'continue' }] };
  }
  return null;
}

/**
 * 用法：在有 resume 流的会话窗口（SessionsView / SessionPage）setup 里调用，
 * 传入"发送"回调（点选项时直发，跳过确认）。
 */
export function useInteractionPicker(send: (payload: string) => void) {
  const display = useDisplayStore();
  const lastAssistantText = ref('');
  const lastInteractions = ref<InteractionSet | null>(null);
  // 开关关时 picker 立即变 null（computed 依赖 display.quickReply，跨窗口经 storage 事件同步）。
  const picker = computed<InteractionSet | null>(() => (display.quickReply ? lastInteractions.value : null));
  return {
    picker,
    captureAssistant(content: unknown): void {
      lastAssistantText.value = textOfContent(content);
    },
    reset(): void {
      lastAssistantText.value = '';
      lastInteractions.value = null;
    },
    finalize(): void {
      lastInteractions.value = extractInteractions(lastAssistantText.value);
    },
    onPick(payload: string): void {
      lastInteractions.value = null;
      send(payload);
    },
    close(): void {
      lastInteractions.value = null;
    },
  };
}
