import { SOURCE_LABEL, SOURCE_SHORT_LABEL, type Source, type Transaction } from '../types';

/**
 * 凭据来源（provenance）。
 *
 * 用户的问题很具体：「这些账单标记来源，是源于微信 CSV 凭证、自制表格、截图识别，
 * 还是几个来源结合得出的」。要能回答它，光有 `source` 不够——`source` 只记得住
 * 「第一次是谁把它带进来的」，记不住「后来有没有第二个来源确认过同一笔」。
 *
 * 所以约定：
 * - `source` 只写一次，入库后不再改（它是凭证归属，不是状态）；
 * - `source_refs` 是来源集合，可增长；缺省等于 `[source]`；
 * - 界面读来源一律走 `provenanceOf()`，不要在页面里直接读 `tx.source`——
 *   否则一旦有了多来源，页面就会显示成「只来自第一次那个来源」，这是静默错，
 *   用户看不出来。
 */

/** 去重并保持顺序：先来的排在前面，来源顺序本身携带「先微信、后截图确认」的信息。 */
export function mergeSources(a: readonly Source[], b: readonly Source[]): Source[] {
  const out: Source[] = [];
  for (const item of [...a, ...b]) if (!out.includes(item)) out.push(item);
  return out;
}

/** 实际来源集合；老数据没有 `source_refs` 时回落成单个 `source`。 */
export function provenanceOf(tx: Pick<Transaction, 'source' | 'source_refs'>): Source[] {
  const refs = tx.source_refs ?? [];
  return refs.length > 0 ? mergeSources(refs, []) : [tx.source];
}

export function isMultiSource(tx: Pick<Transaction, 'source' | 'source_refs'>): boolean {
  return provenanceOf(tx).length > 1;
}

/** 列表内两字标签，如「微信」「微信+截图」。 */
export function provenanceShortLabel(tx: Pick<Transaction, 'source' | 'source_refs'>): string {
  return provenanceOf(tx)
    .map((source) => SOURCE_SHORT_LABEL[source])
    .join('+');
}

/** 提示框/详情里的全称，如「微信账单、截图识别」。 */
export function provenanceLongLabel(tx: Pick<Transaction, 'source' | 'source_refs'>): string {
  return provenanceOf(tx)
    .map((source) => SOURCE_LABEL[source])
    .join('、');
}

export interface SourceCount {
  source: Source;
  count: number;
}

/**
 * 按来源统计笔数，供流水页头部展示「这批账由哪些凭证构成」。
 *
 * 多来源的记录会在**每个**来源下各计一次：它确实同时由这两个来源确认，
 * 只算给其中一个会低估另一个来源的覆盖度。因此各来源笔数之和可能大于总笔数，
 * 调用方必须在文案上体现（界面上写「来源覆盖」而不是「来源分布」）。
 */
export function sourceBreakdown(txs: readonly Transaction[]): SourceCount[] {
  const counter = new Map<Source, number>();
  for (const tx of txs) {
    for (const source of provenanceOf(tx)) {
      counter.set(source, (counter.get(source) ?? 0) + 1);
    }
  }
  const order: Source[] = ['wechat', 'alipay', 'bank', 'legacy_xlsx', 'ocr', 'manual'];
  return [...counter.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return order.indexOf(a.source) - order.indexOf(b.source);
    });
}
