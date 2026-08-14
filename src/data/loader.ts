import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = path.dirname(fileURLToPath(import.meta.url));

// ============ 领域类型 ============

export type OrderStatus =
  | 'pending'
  | 'paid'
  | 'shipped'
  | 'delivered'
  | 'refunded'
  | 'cancelled';

export interface OrderItem {
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  orderId: string;
  phone: string;
  customerName: string;
  items: OrderItem[];
  totalAmount: number;
  status: OrderStatus;
  createTime: string;
  tracking?: { company: string; number: string };
  address?: string;
}

export interface Product {
  /** 主键是 productId，不是 id —— v0.2 之前 product-search 误取 p.id 导致 metadata 全是 undefined */
  productId: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  description: string;
  rating: number;
}

export interface Faq {
  id: number;
  question: string;
  answer: string;
  category: string;
}

// ============ 缓存加载 ============

interface CacheSlot<T> {
  file: string;
  data: T[] | null;
}

const slots = {
  orders: { file: 'orders.json', data: null } as CacheSlot<Order>,
  products: { file: 'products.json', data: null } as CacheSlot<Product>,
  faqs: { file: 'faqs.json', data: null } as CacheSlot<Faq>,
};

let diskReads = 0;

function load<T>(slot: CacheSlot<T>): T[] {
  if (slot.data === null) {
    const raw = fs.readFileSync(path.join(DATA_DIR, slot.file), 'utf-8');
    slot.data = JSON.parse(raw) as T[];
    diskReads++;
  }
  // 返回深拷贝：工具内部对结果的任何修改都不该污染进程级缓存
  return structuredClone(slot.data);
}

export function loadOrders(): Order[] {
  return load(slots.orders);
}

export function loadProducts(): Product[] {
  return load(slots.products);
}

export function loadFaqs(): Faq[] {
  return load(slots.faqs);
}

// ============ 测试辅助（生产路径不调用） ============

/** 清空缓存与读盘计数，供测试隔离用例 */
export function __resetCache(): void {
  slots.orders.data = null;
  slots.products.data = null;
  slots.faqs.data = null;
  diskReads = 0;
}

/** 自上次 __resetCache 以来的真实读盘次数 */
export function __diskReads(): number {
  return diskReads;
}
