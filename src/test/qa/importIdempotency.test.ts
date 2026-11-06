import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../db/db';
import { ensureSeeded } from '../../db/seed';
import { totalsOf } from '../../domain/aggregate';
import { locateDiff, reconcile } from '../../import/reconcile';
import { runImport, undoImport } from '../../import/pipeline';
import { makeImportFile, WECHAT_CSV } from '../fixtures';

/**
 * QA-2：幂等、对账、批次撤销。
 */

const HEADER =
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';

function wechatCsv(rows: string[], footer: string[]): string {
  return ['微信支付账单明细', '微信昵称：[测试]', HEADER, ...rows, ...footer].join('\n');
}

async function resetDb(): Promise<void> {
  await db.delete();
  await db.open();
  await ensureSeeded(db);
}

describe('QA-2 幂等与对账', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('同文件二次导入：inserted = 0，重复项进「待裁决」而不是静默丢弃', async () => {
    const first = await runImport(makeImportFile('wechat-a.csv', WECHAT_CSV));
    const second = await runImport(makeImportFile('wechat-a.csv', WECHAT_CSV));

    expect(first.insertedRows).toBe(3);
    expect(second.insertedRows, '第二次不得新增有效笔数').toBe(0);
    expect(second.duplicateRows).toBe(3);

    const rows = await db.transactions.toArray();
    expect(rows.filter((row) => row.dedupe_status === 'clean')).toHaveLength(3);
    expect(rows.filter((row) => row.dedupe_status === 'suspected')).toHaveLength(3);
    // 疑似重复必须能定位到原单，供裁决页展示
    expect(rows.filter((row) => row.dedupe_status === 'suspected').every((row) => Boolean(row.duplicate_of))).toBe(true);
  });

  it('差一分必须报差异并精确到分（不得四舍五入抹平）', async () => {
    const csv = wechatCsv(
      [
        '2026-10-01 12:31:00,商户消费,美团,午餐,支出,¥15.00,花呗,支付成功,2001,M1,',
        '2026-10-01 12:35:00,商户消费,青桔,骑行,支出,¥0.04,零钱,支付成功,2002,M2,',
      ],
      ['共 2 笔记录', '支出：15.05元'], // 文件声明合计比明细多 1 分
    );
    const report = await runImport(makeImportFile('wechat-diff.csv', csv));
    expect(report.sumExpense).toBe(1504);
    expect(report.diffExpense, '差异必须精确为 1 分').toBe(1);
    expect(report.reconciled).toBe(false);
  });

  it('差异等于某笔金额时能定位到行与日期', () => {
    const rows = [
      { amount_cents: 1500 as never, direction: 'expense' as const, occurred_date: '2026-10-01' },
      { amount_cents: 2500 as never, direction: 'expense' as const, occurred_date: '2026-10-02' },
    ];
    // 文件只声明 15.00，明细里却有一笔 25.00 → 差异 -2500，应定位到那笔 25.00
    const result = reconcile({ fileExpense: 1500 as never, rows });
    expect(result.diffExpense).toBe(-2500);
    const hint = locateDiff(rows, result.diffExpense!);
    expect(hint.candidates).toHaveLength(1);
    expect(hint.message).toContain('25.00');
    expect(hint.message).toContain('2026-10-02');
  });

  it('批次撤销：只软删本批次，不影响其它批次', async () => {
    const batchA = await runImport(makeImportFile('wechat-a.csv', WECHAT_CSV));
    const batchB = await runImport(
      makeImportFile(
        'wechat-b.csv',
        wechatCsv(
          [
            '2026-11-02 08:00:00,商户消费,星巴克,咖啡,支出,¥30.00,花呗,支付成功,3001,M9,',
            '2026-11-03 09:00:00,商户消费,地铁,通勤,支出,¥5.00,零钱,支付成功,3002,M10,',
          ],
          ['共 2 笔记录', '支出：35.00元'],
        ),
      ),
    );

    const removed = await undoImport(batchA.batchId);
    expect(removed).toBe(3);

    const rows = await db.transactions.toArray();
    const a = rows.filter((row) => row.import_batch_id === batchA.batchId);
    const b = rows.filter((row) => row.import_batch_id === batchB.batchId);
    expect(a.every((row) => Boolean(row.deleted_at))).toBe(true);
    expect(b.every((row) => !row.deleted_at)).toBe(true);
    // 撤销后统计只剩 B 批次
    expect(totalsOf(rows).expense_cents).toBe(3500);
    expect(totalsOf(rows).count).toBe(2);
  });
});
