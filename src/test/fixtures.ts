import type { Category } from '../types';
import { buildCategorySeed } from '../domain/categoryTree';
import type { ImportFile } from '../import/base';

export function buildCategories(): Category[] {
  return buildCategorySeed().map((row) => ({ ...row, builtin: true, archived: false }));
}

export function makeImportFile(name: string, content: string, type = 'text/csv'): ImportFile {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    size: bytes.length,
    type,
    readArrayBuffer: async () => bytes.slice().buffer as ArrayBuffer,
    readText: async () => content,
  };
}

export const WECHAT_CSV = [
  '微信支付账单明细',
  '微信昵称：[测试]',
  '----------------------微信支付账单明细列表--------------------',
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  '2026-10-01 12:31:00,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,1001,M1,',
  '2026-10-01 12:35:00,商户消费,青桔,骑行,支出,¥0.04,零钱,支付成功,1002,M2,',
  '2026-10-02 09:00:00,转账,张三,红包,收入,¥20.00,零钱,已存入零钱,1003,M3,',
  '共 3 笔记录',
  '收入：20.00元',
  '支出：15.04元',
].join('\n');
