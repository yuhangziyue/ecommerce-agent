/**
 * 服务端环境变量解析。
 *
 * 单独成文件而不是塞在 `server.ts` 里：那个文件在模块加载时就会 `main()` 起服务，
 * 测试一 import 就会真的尝试连库并 `process.exit`。**纯函数不该被入口的副作用绑架。**
 */

/**
 * 解析流式脱敏的滞后窗口。
 *
 * 空 / 非法 → `undefined`（走缺省 40）；**`0` 是合法值**，表示关闭滞后。
 * 注意不能写 `Number(raw) || undefined` —— 那恰好把 0 吃掉，
 * 而 0 是唯一一个有人会专门去设的值。
 */
export function parseSafetyLag(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}
