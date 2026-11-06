/**
 * 分类树单一事实来源：种子数据与判定链共用，避免两处清单漂移。
 * 一级固定 10 个（支出侧）+ 6 个（收入侧）；二级固定清单；未识别固定 other.pending。
 */

export interface L2Def {
  id: string;
  name: string;
}

export interface L1Def {
  id: string;
  name: string;
  icon: string;
  scope: 'expense' | 'income';
  l2: L2Def[];
}

export const EXPENSE_TREE: L1Def[] = [
  {
    id: 'food',
    name: '餐饮',
    icon: '🍜',
    scope: 'expense',
    l2: [
      { id: 'breakfast', name: '早餐' },
      { id: 'lunch', name: '午餐' },
      { id: 'dinner', name: '晚餐' },
      { id: 'night_snack', name: '夜宵' },
      { id: 'delivery_fee', name: '外卖配送费' },
      { id: 'drink', name: '饮料咖啡' },
      { id: 'snack', name: '零食' },
      { id: 'gathering', name: '聚餐' },
      { id: 'grocery', name: '买菜' },
      { id: 'other', name: '其他餐饮' },
    ],
  },
  {
    id: 'transport',
    name: '交通',
    icon: '🚌',
    scope: 'expense',
    l2: [
      { id: 'metro', name: '地铁' },
      { id: 'bus', name: '公交' },
      { id: 'bike', name: '共享单车' },
      { id: 'taxi', name: '打车' },
      { id: 'train', name: '火车机票' },
      { id: 'parking', name: '停车' },
      { id: 'other', name: '其他交通' },
    ],
  },
  {
    id: 'housing',
    name: '居住',
    icon: '🏠',
    scope: 'expense',
    l2: [
      { id: 'rent', name: '房租' },
      { id: 'utilities', name: '水电燃气' },
      { id: 'property', name: '物业' },
      { id: 'home_goods', name: '家居用品' },
      { id: 'repair', name: '维修' },
      { id: 'other', name: '其他居住' },
    ],
  },
  {
    id: 'telecom',
    name: '通讯',
    icon: '📱',
    scope: 'expense',
    l2: [
      { id: 'phone', name: '话费' },
      { id: 'data', name: '流量' },
      { id: 'broadband', name: '宽带' },
      { id: 'subscription', name: '会员订阅' },
      { id: 'other', name: '其他通讯' },
    ],
  },
  {
    id: 'shopping',
    name: '购物',
    icon: '🛒',
    scope: 'expense',
    l2: [
      { id: 'digital', name: '数码' },
      { id: 'clothing', name: '服饰' },
      { id: 'daily', name: '日用百货' },
      { id: 'beauty', name: '美妆个护' },
      { id: 'express', name: '快递运费' },
      { id: 'other', name: '其他购物' },
    ],
  },
  {
    id: 'medical',
    name: '医疗',
    icon: '💊',
    scope: 'expense',
    l2: [
      { id: 'clinic', name: '门诊' },
      { id: 'medicine', name: '药品' },
      { id: 'checkup', name: '体检' },
      { id: 'dental', name: '牙科' },
      { id: 'other', name: '其他医疗' },
    ],
  },
  {
    id: 'learning',
    name: '学习',
    icon: '📚',
    scope: 'expense',
    l2: [
      { id: 'book', name: '书籍' },
      { id: 'course', name: '课程' },
      { id: 'exam', name: '考试报名' },
      { id: 'software', name: '软件工具' },
      { id: 'print', name: '打印' },
      { id: 'other', name: '其他学习' },
    ],
  },
  {
    id: 'entertainment',
    name: '娱乐',
    icon: '🎮',
    scope: 'expense',
    l2: [
      { id: 'game', name: '游戏' },
      { id: 'video', name: '影视' },
      { id: 'show', name: '演出' },
      { id: 'travel', name: '旅行' },
      { id: 'fitness', name: '运动健身' },
      { id: 'other', name: '其他娱乐' },
    ],
  },
  {
    id: 'social',
    name: '人情',
    icon: '🎁',
    scope: 'expense',
    l2: [
      { id: 'redpacket', name: '红包' },
      { id: 'gift', name: '礼物' },
      { id: 'treat', name: '请客' },
      { id: 'wedding', name: '随礼' },
      { id: 'other', name: '其他人情' },
    ],
  },
  {
    id: 'other',
    name: '其他',
    icon: '🧾',
    scope: 'expense',
    l2: [
      { id: 'fee', name: '手续费' },
      { id: 'fine', name: '罚款' },
      { id: 'pending', name: '待分类' },
      { id: 'unknown', name: '未识别' },
    ],
  },
];

export const INCOME_TREE: L1Def[] = [
  {
    id: 'job',
    name: '接单报酬',
    icon: '💻',
    scope: 'income',
    l2: [
      { id: 'project', name: '项目结算' },
      { id: 'other', name: '其他接单' },
    ],
  },
  {
    id: 'salary',
    name: '实习工资',
    icon: '🏢',
    scope: 'income',
    l2: [
      { id: 'monthly', name: '月薪' },
      { id: 'bonus', name: '奖金' },
      { id: 'other', name: '其他工资' },
    ],
  },
  {
    id: 'allowance',
    name: '津贴补贴',
    icon: '🎫',
    scope: 'income',
    l2: [
      { id: 'meal', name: '餐补' },
      { id: 'traffic', name: '交通补' },
      { id: 'other', name: '其他补贴' },
    ],
  },
  {
    id: 'resale',
    name: '二手转卖',
    icon: '♻️',
    scope: 'income',
    l2: [
      { id: 'digital', name: '数码转卖' },
      { id: 'book', name: '书籍转卖' },
      { id: 'other', name: '其他转卖' },
    ],
  },
  {
    id: 'invest',
    name: '投资收益',
    icon: '📈',
    scope: 'income',
    l2: [
      { id: 'fund', name: '基金收益' },
      { id: 'interest', name: '利息' },
      { id: 'other', name: '其他收益' },
    ],
  },
  {
    id: 'income_other',
    name: '其他收入',
    icon: '💰',
    scope: 'income',
    l2: [{ id: 'other', name: '其他' }],
  },
];

export const ALL_TREES: L1Def[] = [...EXPENSE_TREE, ...INCOME_TREE];

/** 未识别兜底 */
export const OTHER_PENDING = 'other.pending';

export const INCOME_L1_IDS = new Set(INCOME_TREE.map((item) => item.id));
export const EXPENSE_L1_IDS = new Set(EXPENSE_TREE.map((item) => item.id));

export function isIncomeL1(id: string): boolean {
  return INCOME_L1_IDS.has(id);
}

export function isKnownL1(id: string): boolean {
  return INCOME_L1_IDS.has(id) || EXPENSE_L1_IDS.has(id);
}

/** 一级 → 名字 */
export function l1Name(id: string): string {
  const found = ALL_TREES.find((item) => item.id === id);
  return found ? found.name : id;
}

/** 一级 → 图标 */
export function l1Icon(id: string): string {
  const found = ALL_TREES.find((item) => item.id === id);
  return found ? found.icon : '🧾';
}

/** 一级 → 该一级的「其他」二级 ID */
export function otherL2Of(l1: string): string {
  return `${l1}.other`;
}

/** 全量分类种子（Category[] 结构），由 db/seed 消费 */
export function buildCategorySeed(): Array<{
  id: string;
  l1_id: string;
  l1_name: string;
  l2_id: string;
  l2_name: string;
  direction_scope: 'expense' | 'income';
  sort: number;
  icon: string;
}> {
  const rows: Array<{
    id: string;
    l1_id: string;
    l1_name: string;
    l2_id: string;
    l2_name: string;
    direction_scope: 'expense' | 'income';
    sort: number;
    icon: string;
  }> = [];
  for (const l1 of ALL_TREES) {
    l1.l2.forEach((l2, index) => {
      rows.push({
        id: `${l1.id}.${l2.id}`,
        l1_id: l1.id,
        l1_name: l1.name,
        l2_id: l2.id,
        l2_name: l2.name,
        direction_scope: l1.scope,
        sort: index,
        icon: l1.icon,
      });
    });
  }
  return rows;
}
