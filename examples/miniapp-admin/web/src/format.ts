// 金额以“分”存储，展示时换算为元
export function fenToYuan(cents: number | null | undefined): string {
  return `¥${(Number(cents ?? 0) / 100).toFixed(2)}`;
}

export const ORDER_STATUS: Record<string, string> = {
  pending: '待支付',
  paid: '待发货',
  shipped: '已发货',
  completed: '已完成',
  cancelled: '已取消',
};

export const USER_STATUS: Record<string, string> = { active: '正常', disabled: '已停用' };

export const ONOFF: Record<string, string> = { on: '上架中', off: '已下架' };

export const ANN_STATUS: Record<string, string> = { draft: '草稿', published: '已发布' };

export const ROLE_TEXT: Record<string, string> = { admin: '管理员', operator: '运营' };

export const ORDER_TONE: Record<string, string> = {
  pending: 'orange',
  paid: 'blue',
  shipped: 'blue',
  completed: 'green',
  cancelled: 'gray',
};
