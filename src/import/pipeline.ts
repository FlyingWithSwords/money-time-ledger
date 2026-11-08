import { nanoid } from 'nanoid';
import { db } from '../db';
import { SETTING_KEYS } from '../db/settingKeys';
import * as categoryRepo from '../db/repos/categoryRepo';
import * as ruleRepo from '../db/repos/ruleRepo';
import { classify, ensureCategory } from '../domain/classify';
import { deriveDateFields, nowIso } from '../domain/date';
import { LedgerError } from '../domain/errors';
import { detectWhitelistedIncome, type IncomeSource } from '../domain/incomeSource';
import { detectInvestPrincipal, INVEST_PRINCIPAL_FLAG } from '../domain/investPrincipal';
import { asCents, centsToYuan, sumCents } from '../domain/money';
import type { Cents, ImportBatch, ImportIssue, PaymentChannel, Source, Transaction } from '../types';
import type { ImportFile, MonthlyFileTotal, Parser, ParseOutcome } from './base';
import { sourceOfParser } from './base';
import { buildKeys, createSeqTracker } from './dedupe';
import { normalizeRow } from './normalize';
import { detectParser } from './parsers';
import { locateDiff, reconcile, type ReconcileResult, type UnmatchedHint } from './reconcile';
import { sha1Hex } from './hash';

/**
 * 幂等导入编排（02-arch.md §3.1）：
 * parse → normalize → classify → dedupe → persist（单事务）→ reconcile → 写 ImportBatch。
 * 重复绝不静默丢弃：命中 dedupe_key 的照常写入并置 suspected，由用户裁决。
 */

export interface ImportOptions {
  parser?: Parser;
  headerMap?: Record<string, string>;
  source?: Source;
  defaultYear?: number;
  fileName?: string;
  /** OCR 等需要人工确认的路径：把已解析（并可能被用户改过）的结果直接交给管线 */
  preParsed?: ParseOutcome;
}

export interface ImportReport {
  batchId: string;
  parserId: string;
  source: Source;
  parsedRows: number;
  insertedRows: number;
  duplicateRows: number;
  failedRows: number;
  sumExpense: Cents;
  sumIncome: Cents;
  sumRefund: Cents;
  /** 被识别为投资本金、改判为不计收支的笔数与金额（已从 sumExpense 里剔除） */
  investRows: number;
  investCents: Cents;
  /** 命中所设置里确认过的收入来源、由转账/支出改判为收入的笔数与金额 */
  incomeRows: number;
  incomeCents: Cents;
  fileTotal?: { expense?: Cents; income?: Cents; count?: number };
  diffExpense: Cents | null;
  /**
   * 收入侧差额。工资改判之后必须能看见它：
   * 只报支出侧差异的话，一份「收入多算了 8000」的账单会显示成对平。
   */
  diffIncome: Cents | null;
  reconciled: boolean;
  comparable: boolean;
  issues: ImportIssue[];
  /** info 级说明：汇总表跳过、差异定位到哪个月等。不参与失败计数。 */
  notes: string[];
  /** 表内逐月合计；交给 locateDiff 做月级定位（单笔金额匹配只是兜底） */
  fileMonthly: MonthlyFileTotal[];
  /** 差异诊断：月级优先，月级全对才降级到单笔线索；对平或无差异时为 null */
  diffHint: UnmatchedHint | null;
  pendingUncategorized: number;
}

const CHANNEL_ACCOUNT: Record<string, string> = {
  huabei: 'acc_huabei',
  wechat: 'acc_wechat',
  alipay: 'acc_alipay',
  card: 'acc_card',
  cash: 'acc_cash',
  unknown: 'acc_cash',
};

export function accountForChannel(channel: PaymentChannel | string): string {
  return CHANNEL_ACCOUNT[channel] ?? 'acc_cash';
}

export async function runImport(file: ImportFile, opts: ImportOptions = {}): Promise<ImportReport> {
  const parser = opts.parser ?? (await detectParser(file));
  if (!parser) {
    throw new LedgerError('PARSE_FAILED', '认不出这个文件格式：支持微信/支付宝 CSV、支付宝 XLSX、旧 Excel、账单截图');
  }
  const source = opts.source ?? sourceOfParser(parser.id);
  const text = await file.readText().catch(() => '');
  const fileHash = sha1Hex(`${file.name}|${file.size}|${text.slice(0, 4096)}`).slice(0, 24);

  const outcome = opts.preParsed ?? (await parser.parse(file, { headerMap: opts.headerMap, defaultYear: opts.defaultYear }));
  const [rules, categories, incomeSetting] = await Promise.all([
    ruleRepo.loadForClassify(),
    categoryRepo.list(),
    db.settings.get(SETTING_KEYS.incomeSources),
  ]);
  const ctx = { rules, categories };
  /** 用户在设置里勾选过的收入来源；为空 = 不做任何方向改判，行为与旧版完全一致 */
  const incomeSources: IncomeSource[] = Array.isArray(incomeSetting?.value)
    ? (incomeSetting.value as IncomeSource[])
    : [];

  const importedAt = nowIso();
  const batchId = `batch:${nanoid(10)}`;
  const nextSeq = createSeqTracker();
  const issues: ImportIssue[] = [...outcome.issues];
  const drafts: Transaction[] = [];
  let failed = 0;
  let pending = 0;
  /** 「交易关闭」的行数：钱没实际动过，方向已被判成 transfer，汇总一条提示给用户 */
  let closedRows = 0;
  let closedCents = 0;
  /** 退款冲正原本记在支出/收入侧的金额，只看文件合计口径决定要不要拿去还原毛额 */
  let refundOnExpenseCents = 0;
  let refundOnIncomeCents = 0;
  let neutralRows = 0;
  let neutralCents = 0;
  /** 买基金/理财/黄金的本金：文件里记成支出，但它是资产转换，入账改判 transfer */
  let investRows = 0;
  let investCents = 0;
  /** 用户确认过的收入来源（工资/补贴）：命中则把 transfer/支出改判成收入 */
  let incomeRows = 0;
  let incomeCents = 0;
  /** 被改判的行（draft id），对账时按文件支出侧加回 */
  const excludedDraftIds = new Set<string>();
  /** 被改判成收入的行（draft id），对账时从文件收入侧剔除 */
  const incomeDraftIds = new Set<string>();

  const defaultYear = opts.defaultYear ?? new Date().getFullYear();

  for (const raw of outcome.rows) {
    if (parser.isSummaryRow?.(raw)) {
      issues.push({ row: raw.rowIndex, reason: '汇总行已跳过（汇总只计算不存储）', raw: raw.raw });
      continue;
    }
    const normalized = normalizeRow(raw, { fieldMap: outcome.headerMap, defaultYear });
    const blocking = normalized.issues.filter((issue) => issue.reason.includes('无法解析'));
    if (blocking.length > 0 || !normalized.row) {
      failed += 1;
      issues.push(...blocking);
      continue;
    }
    // 非致命提示（如金额为 0）保留在 issues 里，不阻塞入库
    issues.push(...normalized.issues.filter((issue) => !issue.reason.includes('无法解析')));

    const row = normalized.row;
    const isClosed = row.status_text?.includes('交易关闭') ?? false;
    if (isClosed) {
      closedRows += 1;
      closedCents += row.amount_cents;
    }
    if (row.direction === 'transfer' && row.declared_direction === 'neutral') {
      neutralRows += 1;
      neutralCents += row.amount_cents;
    }
    if (row.direction === 'refund') {
      // 按「收/支」原值还原：退款冲正原本占的是哪一侧，对账就在哪一侧加回去
      if (row.declared_direction === 'expense') refundOnExpenseCents += row.amount_cents;
      else if (row.declared_direction === 'income') refundOnIncomeCents += row.amount_cents;
    }
    const classified = classify(
      {
        counterparty: row.counterparty,
        note: row.note,
        amount_cents: row.amount_cents,
        direction: row.direction,
        occurred_at: row.occurred_at,
        channel: row.payment_channel,
      },
      ctx,
    );
    /**
     * 买基金/理财/黄金的本金：账单里记成「支出」，但钱只是从现金变成持仓，不是消费。
     * 改判 transfer 后它既不进支出也不进收入，趋势页的「整体收益 = 现金流 + 浮盈」
     * 才不会把本金按支出扣一遍、又只加浮盈 —— 那等于重复扣本金。
     *
     * 注意：dedupe_key 由**原始** direction 参与计算（buildKeys 在下面用 row 调用），
     * 改动只影响 draft.direction。否则同一份账单重复导入会算出不同的指纹，
     * 每一次都变成"新记录"，账本里出现成倍的本金支出。
     */
    const invest = detectInvestPrincipal({
      direction: row.direction,
      counterparty: row.counterparty,
      note: row.note,
    });
    /**
     * 工资/补贴：只认用户在设置里确认过的来源。
     *
     * 优先级低于投资本金——两者同时命中说明摘要里既有「基金」又有「工资」
     * （理财产品的宣传语、或者「工资到账后自动转入余额宝」），那种情况钱确实变成了持仓，
     * 不能因为摘要带「工资」就判成收入。
     */
    const incomeHit = invest.matched
      ? null
      : detectWhitelistedIncome(
          { direction: row.direction, counterparty: row.counterparty, note: row.note },
          incomeSources,
        );
    if (invest.matched) {
      investRows += 1;
      investCents += row.amount_cents;
    } else if (incomeHit) {
      incomeRows += 1;
      incomeCents += row.amount_cents;
    } else if (classified.l1 === 'other' && classified.l2 === 'pending') {
      pending += 1;
    }
    // 白名单里的分类可能已被用户在分类页删掉：收敛到真实存在的分类，收敛不了就沿用判定链结果
    const incomeCategory = incomeHit ? ensureCategory(incomeHit.l1, incomeHit.l2, ctx) : null;

    const seq = nextSeq(row);
    const keys = buildKeys(row, source, seq);
    const fields = deriveDateFields(row.occurred_at);
    const draftId = nanoid(12);
    if (invest.matched) excludedDraftIds.add(draftId);
    if (incomeHit) incomeDraftIds.add(draftId);

    drafts.push({
      id: draftId,
      external_id: keys.external_id,
      dedupe_key: keys.dedupe_key,
      source,
      direction: invest.matched ? 'transfer' : incomeHit ? 'income' : row.direction,
      amount_cents: row.amount_cents,
      occurred_at: row.occurred_at,
      occurred_date: fields.occurred_date,
      month_key: fields.month_key,
      category_l1: incomeCategory?.l1 ?? classified.l1,
      category_l2: incomeCategory?.l2 ?? classified.l2,
      account_id: accountForChannel(row.payment_channel),
      payment_channel: row.payment_channel,
      counterparty: row.counterparty,
      note: row.note,
      flags: invest.matched ? [INVEST_PRINCIPAL_FLAG] : [],
      manual_edited: false,
      category_locked: false,
      dedupe_status: 'clean',
      import_batch_id: batchId,
      imported_at: importedAt,
      created_at: importedAt,
      updated_at: importedAt,
    });
  }

  const rowsForReconcile = drafts.map((draft) => ({
    amount_cents: draft.amount_cents,
    direction: draft.direction,
    occurred_date: draft.occurred_date,
    excluded: excludedDraftIds.has(draft.id),
    excluded_income: incomeDraftIds.has(draft.id),
  }));

  const result = await db.transaction('rw', db.transactions, db.batches, db.settings, async () => {
    let inserted = 0;
    let duplicates = 0;
    for (const draft of drafts) {
      const existing = await db.transactions
        .where('[dedupe_key+source]')
        .equals([draft.dedupe_key, draft.source])
        .first();
      if (existing) {
        draft.dedupe_status = 'suspected';
        draft.duplicate_of = existing.id;
        duplicates += 1;
      } else {
        inserted += 1;
      }
    }
    if (drafts.length > 0) await db.transactions.bulkAdd(drafts);

    // 文件合计按发生额统计时才把退款还原成毛额；没声明口径就保持原样（旧表行为不变）
    const grossRefund = outcome.fileTotal?.totalsIncludeRefund === true;
    const rec: ReconcileResult = reconcile({
      fileExpense: outcome.fileTotal?.expense,
      fileIncome: outcome.fileTotal?.income,
      refundOnExpense: grossRefund ? (refundOnExpenseCents as Cents) : undefined,
      refundOnIncome: grossRefund ? (refundOnIncomeCents as Cents) : undefined,
      rows: rowsForReconcile,
    });

    const batch: ImportBatch = {
      id: batchId,
      source,
      file_name: opts.fileName ?? file.name,
      file_hash: fileHash,
      file_total_expense_cents: outcome.fileTotal?.expense,
      file_total_income_cents: outcome.fileTotal?.income,
      parsed_rows: outcome.rows.length,
      inserted_rows: inserted,
      duplicate_rows: duplicates,
      failed_rows: failed,
      sum_expense_cents: rec.sumExpense,
      sum_income_cents: rec.sumIncome,
      sum_refund_cents: rec.sumRefund,
      diff_expense_cents: (rec.diffExpense ?? 0) as Cents,
      reconciled: rec.comparable ? rec.reconciled : false,
      issues,
      created_at: importedAt,
    };
    await db.batches.put(batch);

    const versionRow = await db.settings.get(SETTING_KEYS.dataVersion);
    const version = Number(versionRow?.value ?? 1) + 1;
    await db.settings.put({ key: SETTING_KEYS.dataVersion, value: version });

    return { inserted, duplicates, rec, batch };
  });

  // info 级说明：口径解释，不算失败。与 issues 分开，避免把正常情况记成错误。
  const notes: string[] = [...(outcome.notes ?? [])];
  if (closedRows > 0) {
    notes.push(
      `已把 ${closedRows} 笔「交易关闭」（合计 ${centsToYuan(closedCents as Cents)} 元）按不计收支处理：钱没有实际变动，不计入支出`,
    );
  }
  if (investRows > 0) {
    notes.push(
      `已把 ${investRows} 笔买基金/理财/黄金的本金（合计 ${centsToYuan(investCents as Cents)} 元）按不计收支处理：钱从现金变成持仓，不是消费，所以不计入支出。这些记录在流水里仍可见，标记为「投资本金」`,
    );
  }
  if (incomeRows > 0) {
    notes.push(
      `已把 ${incomeRows} 笔命中「${incomeSources
        .map((source) => source.label)
        .slice(0, 3)
        .join('、')}」等收入来源的记录（合计 ${centsToYuan(incomeCents as Cents)} 元）按收入入账：账单里的「收/支」写的是不计收支，但钱确实是工资或补贴。对账已按文件口径剔除这部分，不会显示差额`,
    );
  }
  const refundRows = drafts.filter((draft) => draft.direction === 'refund');
  if (refundRows.length > 0) {
    const refundSum = sumCents(refundRows.map((draft) => draft.amount_cents));
    notes.push(
      `退款冲正 ${refundRows.length} 笔 ${centsToYuan(refundSum)} 元：其中原本记在支出侧 ${centsToYuan(refundOnExpenseCents as Cents)} 元、收入侧 ${centsToYuan(refundOnIncomeCents as Cents)} 元；退款不计收入也不计支出`,
    );
  }
  if (outcome.fileTotal?.neutral !== undefined) {
    // 只比「收/支」原本就写着不计收支/中性交易的行：
    // 交易关闭里那 2 笔原本写「支出」的，钱退回了支出侧，不属于文件的「不计收支」口径
    const neutralSum = asCents(neutralCents);
    notes.push(
      neutralSum === outcome.fileTotal.neutral
        ? `不计收支/中性交易与文件声明一致：${neutralRows} 笔 ${centsToYuan(neutralSum)} 元`
        : `不计收支/中性交易与文件声明不一致：文件 ${centsToYuan(outcome.fileTotal.neutral)} 元，明细 ${centsToYuan(neutralSum)} 元（${neutralRows} 笔），请核对原始账单`,
    );
  }

  return {
    batchId,
    parserId: parser.id,
    source,
    parsedRows: outcome.rows.length,
    insertedRows: result.inserted,
    duplicateRows: result.duplicates,
    failedRows: failed,
    sumExpense: result.rec.sumExpense,
    sumIncome: result.rec.sumIncome,
    sumRefund: result.rec.sumRefund,
    investRows,
    investCents: asCents(investCents),
    incomeRows,
    incomeCents: asCents(incomeCents),
    fileTotal: outcome.fileTotal,
    diffExpense: result.rec.diffExpense,
    diffIncome: result.rec.diffIncome,
    reconciled: result.rec.reconciled,
    comparable: result.rec.comparable,
    issues,
    notes,
    fileMonthly: outcome.fileTotal?.monthly ?? [],
    diffHint:
      result.rec.diffExpense !== null && result.rec.diffExpense !== 0
        ? locateDiff(rowsForReconcile, result.rec.diffExpense, {
            fileMonthly: outcome.fileTotal?.monthly ?? [],
          })
        : null,
    pendingUncategorized: pending,
  };
}

/** 撤销本次导入：批量软删该 batch 的记录（可再恢复），并标记批次已撤销。 */
export async function undoImport(batchId: string): Promise<number> {
  const now = nowIso();
  const count = await db.transaction('rw', db.transactions, db.batches, db.settings, async () => {
    const rows = await db.transactions.where('import_batch_id').equals(batchId).toArray();
    const nowRows = rows.filter((row) => !row.deleted_at);
    await db.transactions.bulkUpdate(
      nowRows.map((row) => ({ key: row.id, changes: { deleted_at: now, updated_at: now } })),
    );
    await db.batches.update(batchId, { undone_at: now });
    const versionRow = await db.settings.get(SETTING_KEYS.dataVersion);
    await db.settings.put({ key: SETTING_KEYS.dataVersion, value: Number(versionRow?.value ?? 1) + 1 });
    return nowRows.length;
  });
  return count;
}
