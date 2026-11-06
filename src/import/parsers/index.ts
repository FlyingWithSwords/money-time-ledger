import type { ImportFile, Parser } from '../base';

/**
 * Parser 注册表。全部走动态 import()：
 * xlsx / papaparse / tesseract 都不进首屏 chunk。
 *
 * 顺序即优先级：微信 xlsx 必须排在支付宝 xlsx 之前——
 * 两者都是「表格 + 收/支 + 金额」，谁先认领谁负责，微信在前可保证不会被支付宝吞掉。
 */
export async function loadParsers(): Promise<Parser[]> {
  const [wechat, wechatXlsx, alipay, ocr, alipayXlsx, legacy] = await Promise.all([
    import('./wechatCsv'),
    import('./wechatXlsx'),
    import('./alipayCsv'),
    import('./ocr'),
    import('./alipayXlsx'),
    import('./legacyXlsx'),
  ]);
  return [
    wechat.wechatCsvParser,
    wechatXlsx.wechatXlsxParser,
    alipay.alipayCsvParser,
    ocr.ocrParser,
    alipayXlsx.alipayXlsxParser,
    legacy.legacyXlsxParser,
  ];
}

export async function detectParser(file: ImportFile): Promise<Parser | null> {
  const parsers = await loadParsers();
  for (const parser of parsers) {
    try {
      if (await parser.canHandle(file)) return parser;
    } catch {
      // 嗅探失败不影响下一个 parser
    }
  }
  return null;
}

export async function getParserById(id: string): Promise<Parser | null> {
  const parsers = await loadParsers();
  return parsers.find((parser) => parser.id === id) ?? null;
}
