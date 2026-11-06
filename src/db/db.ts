import Dexie, { type Table } from 'dexie';
import type {
  Account,
  Budget,
  Category,
  CategoryRule,
  FundQuote,
  Goal,
  Holding,
  ImportBatch,
  ReviewCard,
  Setting,
  Transaction,
} from '../types';

/**
 * Dexie schema。
 *
 * 关于「去重唯一复合索引」的工程裁定：
 * 架构文档写了 `&[dedupe_key+source]`（唯一），同时又要求"命中重复时照常写入并置
 * dedupe_status='suspected' 交给用户裁决，绝不静默丢弃"。这两条在 Dexie 里互斥：
 * 唯一索引会让第二笔写入抛 ConstraintError，整批事务回滚。
 * 因此这里用**非唯一**复合索引 `[dedupe_key+source]`，把"唯一性"下沉到导入管线的
 * 单事务读校验里 —— 语义等价（同文件二次导入 inserted=0），且不丢数据。
 * 详见 docs/02-arch.md §2.3-a 与 §3.1。
 */
/**
 * 用户对跨平台配对的**否定裁决**（「这两条不是同一笔」）。
 *
 * 为什么单独一张表而不是给交易打 flag：否定的对象是「一对 id」，不属于任何一笔
 * 交易自己；塞在交易上，任何一边被删掉/合并，另一半就会变成悬空引用。
 */
export interface PairDismissal {
  /** `[a, b].sort().join('|')` —— 排序保证 (a,b) 与 (b,a) 命中同一条记录。 */
  id: string;
  created_at: string;
}

export class LedgerDatabase extends Dexie {
  transactions!: Table<Transaction, string>;
  accounts!: Table<Account, string>;
  categories!: Table<Category, string>;
  rules!: Table<CategoryRule, string>;
  holdings!: Table<Holding, string>;
  quotes!: Table<FundQuote, string>;
  goals!: Table<Goal, string>;
  budgets!: Table<Budget, string>;
  batches!: Table<ImportBatch, string>;
  settings!: Table<Setting, string>;
  reviews!: Table<ReviewCard, string>;
  pair_dismissals!: Table<PairDismissal, string>;

  constructor(name = 'money_time_ledger') {
    super(name);

    this.version(1).stores({
      transactions: `id, occurred_date, month_key, category_l1, category_l2, account_id, direction,
        source, external_id, import_batch_id, [dedupe_key+source],
        [month_key+direction], [month_key+category_l1], [month_key+category_l2],
        [occurred_date+direction], [category_l2+occurred_date],
        [import_batch_id+dedupe_status], [account_id+occurred_date], *flags`,
      accounts: 'id, kind, sort',
      categories: 'id, [l1_id+sort], direction_scope, archived',
      rules: 'id, kind, source, priority, enabled',
      holdings: 'id, &fund_code, closed_at',
      quotes: 'id, fund_code, [fund_code+quote_at], nav_date',
      goals: 'id, status',
      settings: 'key',
      batches: 'id, created_at, source',
    });

    // v2：新增预算与复盘快照表；顺带做两件数据治理
    // ① 回填索引字段（老数据可能只有 occurred_at）
    // ② 清除"月份汇总行"——汇总只计算不存储，任何写路径都不得留下汇总行
    this.version(2)
      .stores({
        budgets: 'id, month_key',
        reviews: 'id, month_key',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Transaction>('transactions')
          .toCollection()
          .modify((row) => {
            const iso = row.occurred_at ?? '';
            if (iso.length >= 10) {
              if (!row.occurred_date) row.occurred_date = iso.slice(0, 10);
              if (!row.month_key) row.month_key = iso.slice(0, 7);
            }
          });
        const summaryPattern = /(小计|合计|总计|汇总)/;
        await tx
          .table<Transaction>('transactions')
          .filter((row) => row.source === 'legacy_xlsx' && !!row.counterparty && summaryPattern.test(row.counterparty))
          .delete();
      });

    // v3：跨平台对账的否定裁决表。只加表，不动既有任何表的 schema。
    // 注意：这张表**刻意不进备份**（backup.ts 的 TABLE_NAMES 是硬编码清单，
    // 不会自动收新表）。对账裁决是「本机工作状态」：另一台设备上可能没有
    // 其中任何一笔交易，同步过去只会留下一堆指向不存在 id 的悬空记录。
    this.version(3).stores({
      pair_dismissals: 'id, created_at',
    });

    // v4：持仓加平台维度。用户诉求「同一只基金在支付宝和天天基金各有一笔，
    // 要区分开打标签，且同平台下次导入覆盖不冲突」。
    // 唯一性从 &fund_code（全表唯一）改成 &[platform+fund_code]（同平台内唯一）：
    // - 跨平台同代码 → 两行独立持仓（成本、份额互不影响）；
    // - 同平台同代码 → 仍然唯一，重复导入走幂等覆盖而不是报 ConstraintError。
    // 旧数据回填 platform='manual'：v3 之前持仓只能手动录入，不存在歧义。
    // quotes 表不动：净值/金价按代码查询，同一标的在不同平台价格相同，天然共用。
    this.version(4)
      .stores({
        holdings: 'id, fund_code, closed_at, &[platform+fund_code]',
      })
      .upgrade(async (tx) => {
        await tx
          .table<Holding>('holdings')
          .toCollection()
          .modify((row) => {
            if (!row.platform) row.platform = 'manual';
          });
      });
  }
}

export const db = new LedgerDatabase();

/** 测试用：在独立数据库名上建实例，避免用例互相污染。 */
export function createTestDb(name: string): LedgerDatabase {
  return new LedgerDatabase(name);
}
