import {
  loadOrders,
  loadProducts,
  loadFaqs,
  __resetCache,
  __diskReads,
} from '../src/data/loader.js';

describe('data loader', () => {
  beforeEach(() => __resetCache());

  it('同一份数据只读磁盘一次（连续 3 次调用）', () => {
    loadOrders();
    loadOrders();
    loadOrders();
    expect(__diskReads()).toBe(1);
  });

  it('三份数据各自独立缓存', () => {
    loadOrders();
    loadProducts();
    loadFaqs();
    loadOrders();
    loadProducts();
    loadFaqs();
    expect(__diskReads()).toBe(3);
  });

  it('返回的数据条数与结构正确', () => {
    expect(loadOrders()).toHaveLength(10);
    expect(loadProducts()).toHaveLength(20);
    expect(loadFaqs()).toHaveLength(15);

    expect(loadOrders()[0]).toHaveProperty('orderId');
    expect(loadOrders()[0]).toHaveProperty('status');
    // 主键字段名是 productId 而非 id —— product-search 曾误取 p.id
    expect(loadProducts()[0]).toHaveProperty('productId');
    expect(loadProducts()[0]).not.toHaveProperty('id');
    expect(loadFaqs()[0]).toHaveProperty('question');
  });

  it('返回副本：调用方修改不污染缓存', () => {
    const first = loadOrders();
    first[0].status = 'refunded';
    first[0].totalAmount = -1;

    const second = loadOrders();
    expect(second[0].status).not.toBe('refunded');
    expect(second[0].totalAmount).not.toBe(-1);
  });

  it('__resetCache 后会重新读盘', () => {
    loadOrders();
    expect(__diskReads()).toBe(1);
    __resetCache();
    loadOrders();
    expect(__diskReads()).toBe(1); // 计数器随 reset 归零，重新读了一次
  });
});
