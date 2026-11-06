import type { ImportFile } from '../base';

/**
 * XLSX 读取。
 * 关键：`cellFormula: false` —— 只读**计算结果值**，不解析公式（PRD Q5）。
 * xlsx 体积大，只在真正导入表格时动态 import()，不进首屏。
 */

export interface SheetTable {
  name: string;
  rows: string[][];
}

export interface ReadTablesOptions {
  /**
   * 是否保留空行。默认 false（老调用方的行为不变）。
   * 微信账单设为 true：真实表头在第 18 行，中间有 2 个空行，
   * 丢掉空行会让 issue 里的行号比 Excel 行号小 2，用户按行号回查会找错位置。
   */
  keepBlankRows?: boolean;
}

export async function readWorkbookTables(file: ImportFile, options: ReadTablesOptions = {}): Promise<SheetTable[]> {
  const XLSX = await import('xlsx');
  const buffer = await file.readArrayBuffer();
  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: 'array',
    cellFormula: false,
    cellDates: false,
    cellNF: false,
    cellText: true,
    cellStyles: false,
  });
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
      blankrows: options.keepBlankRows ?? false,
    });
    const rows = matrix.map((row) =>
      (Array.isArray(row) ? row : []).map((cell) => (cell === null || cell === undefined ? '' : String(cell).trim())),
    );
    return { name, rows };
  });
}
