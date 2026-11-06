/**
 * 领域层错误：类型化 code，UI 层据此决定文案与是否重试。
 * 任何失败都不得静默 —— 导入失败进 ImportBatch.issues，行情失败必显示降级来源与时戳。
 */

export type LedgerErrorCode =
  | 'PARSE_FAILED'
  | 'RECONCILE_FAILED'
  | 'QUOTE_UNAVAILABLE'
  | 'MONEY_INVALID'
  | 'VALIDATION_FAILED'
  | 'BACKUP_FAILED'
  | 'OCR_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'NOT_SUPPORTED';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly detail?: string;

  constructor(code: LedgerErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * 把任意异常折成 "Name: message" 文本。
 * 注意：浏览器抛的 `DOMException` 并非在所有环境里都是 `Error` 的子类
 * （jsdom 与部分 WebView 就是如此），所以不能只靠 `instanceof Error` 判断。
 */
function rawErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { name?: unknown; message?: unknown };
    if (typeof candidate.message === 'string') {
      const name = typeof candidate.name === 'string' ? candidate.name : '';
      return name ? `${name}: ${candidate.message}` : candidate.message;
    }
  }
  return String(error);
}

/** 把任意异常折叠成一句可显示的话，避免 UI 里出现 "undefined"。 */
export function describeError(error: unknown): string {
  if (error instanceof LedgerError) return error.message;

  const raw = rawErrorText(error);
  // 存储类异常原样抛给用户毫无意义（"The user denied permission to access the database"），
  // 换成能指导行动的话，并指向唯一的出路。
  if (/denied permission|not allowed to access|access is denied/i.test(raw)) {
    return '本地存储被当前环境拒绝，这笔没有存上。请用系统浏览器打开本页面后再试（预览面板、无痕模式会禁用存储）。';
  }
  if (/QuotaExceeded|quota/i.test(raw)) {
    return '本地存储空间已满，这笔没有存上。请先在设置页导出备份，再清理不需要的年份数据。';
  }
  if (error instanceof Error) return error.message;
  return raw;
}
