/**
 * 结构化返回协议（v0.13）。
 *
 * 工具产出**两份东西，给两个受众**：
 * - `content`  给模型看 —— 自然语言，模型据此组织回复
 * - `artifact` 给调用方看 —— 结构化，App 直接渲染卡片
 *
 * 关键约束：**artifact 不经过模型**。它从工具直接流到 SSE 与响应体，
 * 中间不被复述、不被改写。v0.13 之前调用方想渲染商品卡只能去正则解析
 * 模型生成的中文（「售价 299 元」/「售价￥299」/「299元」），模型换个说法就崩。
 */

export interface ProductCard {
  productId: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  rating: number;
  description: string;
  /** 是否有货 —— 前端常用，避免每个调用方各自判断 stock > 0 */
  inStock: boolean;
}

export interface OrderCard {
  orderId: string;
  status: string;
  statusLabel: string;
  totalAmount: number;
  createTime: string;
  items: Array<{ name: string; quantity: number; price: number }>;
  tracking: { company: string; number: string } | null;
}

export interface RefundTicketCard {
  refundId: string;
  orderId: string;
  amount: number;
  reason: string;
  /** 是否为重复提交返回的原工单 */
  duplicated: boolean;
}

export interface FlowStatusCard {
  flowId: string;
  orderId: string;
  state: string;
  stateLabel: string;
  availableEvents: string[];
  transitions: Array<{ to: string; toLabel: string; event: string; actor: string; at: number }>;
}

export interface CouponCard {
  couponId: string;
  name: string;
  /** 满减门槛（元），0 表示无门槛 */
  threshold: number;
  /** 减免金额（元） */
  discount: number;
  expiresAt: string;
  /** 对本次订单是否可用 */
  applicable: boolean;
  /** 不可用的原因，可用时为 null */
  reason: string | null;
}

export interface CouponPlan {
  coupons: CouponCard[];
  /** 最优可用组合（本项目规则：不可叠加，取减免最大的一张） */
  best: CouponCard | null;
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
}

export interface InvoiceCard {
  invoiceId: string;
  orderId: string;
  amount: number;
  title: string;
  taxNumber: string | null;
  type: 'personal' | 'company';
  status: 'issued' | 'pending';
}

export interface MembershipCard {
  userId: string;
  level: 'bronze' | 'silver' | 'gold' | 'platinum';
  levelLabel: string;
  points: number;
  /** 升到下一级还差多少积分，已是最高级时为 null */
  pointsToNextLevel: number | null;
  benefits: string[];
  discountRate: number;
}

export interface LogisticsCard {
  orderId: string;
  issue: string;
  daysSinceOrder: number;
  tracking: { company: string; number: string } | null;
  hasIssue: boolean;
}

/** 判别联合 —— 调用方按 `type` 收窄，拿到的 `data` 自动是对应类型 */
export type ToolArtifact =
  | { type: 'product_list'; data: { products: ProductCard[]; total: number; truncated: boolean } }
  | { type: 'order_card'; data: OrderCard }
  | { type: 'refund_ticket'; data: RefundTicketCard }
  | { type: 'flow_status'; data: FlowStatusCard }
  | { type: 'coupon_plan'; data: CouponPlan }
  | { type: 'invoice'; data: InvoiceCard }
  | { type: 'membership'; data: MembershipCard }
  | { type: 'logistics'; data: LogisticsCard };

/**
 * 列表类 artifact 的条数上限。
 *
 * 不设上限的话，一次「查所有商品」能让单个 SSE 帧膨胀到几百 KB ——
 * 而 SSE 帧是不可分割的，撑爆就是整条流中断。截断时**必须置 `truncated`**，
 * 否则调用方会把「前 20 条」当成「全部」。
 */
export const MAX_LIST_ITEMS = 20;
