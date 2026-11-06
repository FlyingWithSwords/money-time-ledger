import type { Source } from '../types';
import { sha1Hex } from './hash';
import type { NormalizedRow } from './base';
import { normalizeText } from '../domain/classify';

/**
 * 幂等去重（02-arch.md §2.3-a）。
 * - 有平台单号 → external_id = 'p' + sha1(source|txn_no)，与文件重排无关
 * - 无单号 → dedupe_key = sha1(source|分钟级时间|金额|方向|对手方|seq)
 *   seq = 同批次内该四元组第 n 次出现（按文件行序累加），
 *   加 seq 才能让"同天同分钟同额的两笔真实交易"不被误杀。
 * - 去重只在同一 source 内做（微信与支付宝各一笔同额不算重复）
 */

export interface KeyPair {
  external_id: string;
  dedupe_key: string;
}

export function buildKeys(row: NormalizedRow, source: Source, seq: number): KeyPair {
  if (row.txn_no) {
    const hashed = sha1Hex(`${source}|${row.txn_no}`).slice(0, 16);
    return { external_id: `p${hashed}`, dedupe_key: hashed };
  }
  const fingerprint = sha1Hex(
    [
      source,
      row.occurred_at.slice(0, 16),
      row.amount_cents,
      row.direction,
      normalizeText(row.counterparty ?? ''),
      seq,
    ].join('|'),
  ).slice(0, 24);
  return { external_id: `g${fingerprint.slice(0, 16)}`, dedupe_key: fingerprint };
}

/** 同批次内 seq 生成器：四元组（时间/金额/方向/对手方）→ 出现次数。 */
export function createSeqTracker(): (row: NormalizedRow) => number {
  const counters = new Map<string, number>();
  return (row: NormalizedRow): number => {
    const key = [
      row.occurred_at.slice(0, 16),
      row.amount_cents,
      row.direction,
      normalizeText(row.counterparty ?? ''),
    ].join('|');
    const next = (counters.get(key) ?? 0) + 1;
    counters.set(key, next);
    return next;
  };
}

export interface DedupeVerdict {
  duplicate: boolean;
  existingId?: string;
}

export interface DedupeResolveAction {
  id: string;
  action: 'keep' | 'discard';
}
