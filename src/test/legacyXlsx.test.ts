import { describe, expect, it } from 'vitest';
import { detectMonthSeparator, detectTableTotals, parseLegacySheet, parseLegacyTables } from '../import/parsers/legacyXlsx';
import type { SheetTable } from '../import/parsers/xlsxReader';

const sheet: SheetTable = {
  name: '2025',
  rows: [
    ['日期', '项目', '金额', '备注'],
    ['8月', '', '', ''],
    ['2日', '午餐', '15.00', ''],
    ['2日', '晚餐', '18.00', ''],
    ['', '地铁', '5.00', '同日多笔，日期空白'],
    ['8月小计', '', '38.00', ''],
    ['12月', '', '', ''],
    ['31日', '聚餐', '100.00', ''],
    ['1月', '', '', ''],
    ['3日', '午餐', '12.00', '跨年'],
    ['1月合计', '', '12.00', ''],
  ],
};

describe('legacyXlsx: 旧表还原', () => {
  it('识别月份分隔行', () => {
    expect(detectMonthSeparator(['8月', '', ''])).toBe(8);
    expect(detectMonthSeparator(['12月份'])).toBe(12);
    expect(detectMonthSeparator(['8月小计', ''])).toBeNull();
    expect(detectMonthSeparator(['2日', '午餐', '15.00'])).toBeNull();
  });

  it('月份切段 + 向下填充 + 跨年 + 汇总行跳过', () => {
    const { rows, issues } = parseLegacySheet(sheet, { defaultYear: 2025 });
    const dates = rows.map((row) => row.cells['日期']);
    expect(dates).toEqual(['2025-08-02', '2025-08-02', '2025-08-02', '2025-12-31', '2026-01-03']);
    expect(rows[2].cells['项目']).toBe('地铁');
    // 汇总行不会变成明细；只会作为 issue 提示
    expect(rows.some((row) => row.cells['项目']?.includes('小计'))).toBe(false);
    expect(issues.some((issue) => issue.reason.includes('汇总行已跳过'))).toBe(true);
  });

  it('负数金额还原为退款方向，不写负数', () => {
    const withRefund: SheetTable = {
      name: '2025',
      rows: [
        ['日期', '项目', '金额', '备注'],
        ['4月', '', '', ''],
        ['18日', '退货运费', '-12.49', ''],
      ],
    };
    const { rows } = parseLegacySheet(withRefund, { defaultYear: 2025 });
    expect(rows).toHaveLength(1);
    expect(rows[0].cells['收支']).toBe('退款');
    expect(rows[0].cells['金额']).toBe('12.49');
  });

  it('多表拼接并保留 sheet 名到 raw，便于定位', () => {
    const outcome = parseLegacyTables([sheet, { name: '2024', rows: [['日期', '金额'], ['5月', ''], ['1日', '8.80']] }], {
      defaultYear: 2024,
    });
    expect(outcome.rows.length).toBe(6);
    expect(outcome.rows[0].raw).toContain('2025');
  });

  it('分隔行却在金额列上有值 → 不静默吞掉，必须留 notes 提示', () => {
    const ambiguous: SheetTable = {
      name: '2025',
      rows: [
        ['日期', '项目', '金额', '备注'],
        ['1月', '午餐', '15.00', ''],
        ['2日', '晚餐', '20.00', ''],
      ],
    };
    const { rows, issues, notes } = parseLegacySheet(ambiguous, { defaultYear: 2025 });
    // 仍然按分隔行处理（该行不入库），但必须让用户看见这 15.00 没进账
    expect(rows).toHaveLength(1);
    expect(rows[0].cells['金额']).toBe('20.00');
    expect(issues).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('15.00');
    expect(notes[0]).toContain('未入库');
  });

  it('累计式汇总表取最后一个非零值，不拿 1 月的数字当全年', () => {
    const cumulative = [
      ['年份', '月份', '月支出', '年支出'],
      ['2023', '1', '1244.06', '1244.06'],
      ['', '2', '1031.98', '2276.04'],
      ['', '3', '729.47', '3005.51'],
    ];
    expect(detectTableTotals(cumulative).expense).toBe(300551);
  });

  it('收支混排表：独立「收/支」列必须逐行决定方向', () => {
    const mixed: SheetTable = {
      name: '2023流水',
      rows: [
        ['日期', '项目', '金额', '收/支'],
        ['3月', '', '', ''],
        ['1日', '工资', '8000.00', '收入'],
        ['2日', '午餐', '15.00', '支出'],
        ['3日', '退货', '12.49', '退款'],
      ],
    };
    const { rows } = parseLegacySheet(mixed, { defaultYear: 2023 });
    expect(rows.map((row) => row.cells['收支'])).toEqual(['收入', '支出', '退款']);
    expect(rows.map((row) => row.cells['金额'])).toEqual(['8000.00', '15.00', '12.49']);
  });

  it('「收/支」列认不出的值 → 沿用默认但必须留 note，不静默', () => {
    const mixed: SheetTable = {
      name: '2023流水',
      rows: [
        ['日期', '项目', '金额', '收/支'],
        ['3月', '', '', ''],
        ['1日', '工资', '8000.00', '收入'],
        ['2日', '杂项', '20.00', '其他'],
      ],
    };
    const { rows, notes } = parseLegacySheet(mixed, { defaultYear: 2023 });
    expect(rows).toHaveLength(2);
    expect(rows[1].cells['收支']).toBe('支出');
    expect(notes.some((note) => note.includes('其他') && note.includes('请核对'))).toBe(true);
  });
});
