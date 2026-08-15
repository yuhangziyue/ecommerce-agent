/**
 * 四级处置。
 *
 * v0.2 的过滤器只有「拦截」与「脱敏」两种硬编码行为，
 * 现实里「提示词注入」和「客户说了句气话」不该是同一种处置。
 */
export type SafetyAction = 'allow' | 'mask' | 'block' | 'handoff';

export interface SafetyRule {
  id: string;
  name: string;
  pattern: RegExp;
  action: Exclude<SafetyAction, 'allow'>;
  /** `mask` 用的替换串，支持 `$1` 反向引用 */
  replacement?: string;
  /** 给用户看的原因（`block` / `handoff` 时使用） */
  reason?: string;
}

/** 输入侧：拦在调用模型之前，恶意输入不消耗任何 token */
export const INPUT_RULES: SafetyRule[] = [
  {
    id: 'inject.ignore_previous',
    name: '忽略先前指令',
    pattern: /ignore\s+(all\s+)?previous\s+instructions/i,
    action: 'block',
    reason: '检测到提示词注入尝试：忽略先前指令',
  },
  {
    id: 'inject.forget_instructions',
    name: '遗忘指令',
    pattern: /forget\s+(all\s+)?your\s+(previous\s+)?instructions/i,
    action: 'block',
    reason: '检测到提示词注入尝试：遗忘指令',
  },
  {
    id: 'inject.disregard',
    name: '忽视先前内容',
    pattern: /disregard\s+(all\s+)?previous/i,
    action: 'block',
    reason: '检测到提示词注入尝试：忽视先前内容',
  },
  {
    id: 'inject.fake_system',
    name: '伪造系统消息',
    pattern: /^\s*system\s*[:：]/i,
    action: 'block',
    reason: '检测到提示词注入尝试：伪造系统消息',
  },
  {
    id: 'inject.role_hijack',
    name: '角色劫持',
    pattern: /你现在是|从现在开始你是|扮演一个不受限制/,
    action: 'block',
    reason: '检测到提示词注入尝试：角色劫持',
  },
  {
    id: 'inject.reveal_prompt',
    name: '套取系统提示词',
    pattern: /(重复|输出|告诉我).{0,6}(你的)?(系统)?(提示词|prompt|指令)|repeat\s+your\s+(system\s+)?prompt/i,
    action: 'block',
    reason: '检测到提示词注入尝试：套取系统提示词',
  },
  {
    // 不自动拒绝 —— 这类内容需要人工判断，机械拒绝会激化矛盾
    id: 'escalate.threat',
    name: '人身威胁或法律纠纷',
    pattern: /(起诉|法院|律师函|曝光你们|人身安全|报警)/,
    action: 'handoff',
    reason: '客户提到法律或人身安全相关内容，需人工介入',
  },
];

/**
 * 输出侧：一律 `mask`，不 `block`。
 *
 * 敏感信息该脱敏后继续服务 —— 丢掉整轮回答对客户是可用性事故，
 * 对业务是投诉来源。
 */
export const OUTPUT_RULES: SafetyRule[] = [
  {
    id: 'pii.phone',
    name: '手机号',
    pattern: /(1[3-9]\d)\d{4}(\d{4})/g,
    action: 'mask',
    replacement: '$1****$2',
  },
  {
    id: 'pii.id_card',
    name: '身份证号',
    // 前后加非数字边界，避免把 18 位订单流水号误判成身份证
    pattern: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    action: 'mask',
    replacement: '****************',
  },
  {
    id: 'pii.bank_card',
    name: '银行卡号',
    pattern: /(?<!\d)\d{16,19}(?!\d)/g,
    action: 'mask',
    replacement: '**** **** **** ****',
  },
  {
    id: 'pii.email',
    name: '邮箱',
    pattern: /([\w.+-]{1,3})[\w.+-]*@([\w-]+\.[\w.-]+)/g,
    action: 'mask',
    replacement: '$1***@$2',
  },
  {
    id: 'secret.api_key',
    name: 'API 密钥',
    pattern: /sk-[a-zA-Z0-9_-]{8,}/g,
    action: 'mask',
    replacement: 'sk-****',
  },
];

/**
 * 滞后窗口需要压住的字符数。
 *
 * 必须 ≥ 最长敏感模式的长度，否则跨块的模式会漏检。
 * 银行卡最长 19 位，邮箱可能更长 —— 取 40 留足余量。
 */
export const DEFAULT_SAFETY_LAG = 40;
