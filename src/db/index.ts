/**
 * 数据层入口。统一从这里导出，避免各处写 `../db/db` 这种实现细节路径。
 */
export { db, LedgerDatabase, createTestDb } from './db';
