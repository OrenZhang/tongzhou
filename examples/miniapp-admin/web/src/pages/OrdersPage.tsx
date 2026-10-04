import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { usePagedList } from '../usePagedList';
import { Badge, Empty, Modal, Pagination } from '../components';
import { fenToYuan, ORDER_STATUS, ORDER_TONE } from '../format';

interface OrderRow {
  id: number;
  order_no: string;
  status: string;
  total_cents: number;
  created_at: string;
  user_nickname: string;
}

interface OrderDetail {
  order: {
    id: number;
    order_no: string;
    status: string;
    total_cents: number;
    address: string;
    remark: string;
    created_at: string;
    updated_at: string;
    user_nickname: string;
    user_phone: string | null;
  };
  items: { id: number; product_name: string; price_cents: number; quantity: number }[];
}

// 与后端一致的合法状态流转
const NEXT_ACTIONS: Record<string, { to: string; label: string; danger?: boolean }[]> = {
  pending: [
    { to: 'paid', label: '标记已支付' },
    { to: 'cancelled', label: '取消订单', danger: true },
  ],
  paid: [
    { to: 'shipped', label: '发货' },
    { to: 'cancelled', label: '取消订单', danger: true },
  ],
  shipped: [{ to: 'completed', label: '确认完成' }],
  completed: [],
  cancelled: [],
};

export default function OrdersPage() {
  const [status, setStatus] = useState('');
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload } = usePagedList<OrderRow>('/api/orders', { status });
  const [kwInput, setKwInput] = useState('');
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [detailError, setDetailError] = useState('');
  const [actionError, setActionError] = useState('');

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  async function openDetail(id: number) {
    setDetailId(id);
    setDetail(null);
    setDetailError('');
    setActionError('');
    try {
      const d = await api.get<OrderDetail>(`/api/orders/${id}`);
      setDetail(d);
    } catch (err) {
      setDetailError(errorText(err));
    }
  }

  async function transition(to: string, label: string) {
    if (!detail) return;
    if (!window.confirm(`确定对订单 ${detail.order.order_no} 执行「${label}」吗？`)) return;
    setActionError('');
    try {
      await api.patch(`/api/orders/${detail.order.id}/status`, { status: to });
      await openDetail(detail.order.id);
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>订单管理</h2>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input placeholder="搜索订单号" value={kwInput} onChange={(e) => setKwInput(e.target.value)} style={{ width: 220 }} />
            <button className="btn" type="submit">
              搜索
            </button>
            {keyword && (
              <button
                className="btn btn-ghost"
                type="button"
                onClick={() => {
                  setKwInput('');
                  setKeyword('');
                }}
              >
                清除
              </button>
            )}
          </form>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(ORDER_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword || status ? '没有符合条件的订单' : '暂无订单'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>用户</th>
                <th>金额</th>
                <th>状态</th>
                <th>下单时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_no}</td>
                  <td>{o.user_nickname}</td>
                  <td>{fenToYuan(o.total_cents)}</td>
                  <td>
                    <Badge text={ORDER_STATUS[o.status] ?? o.status} tone={ORDER_TONE[o.status] ?? 'gray'} />
                  </td>
                  <td className="muted">{o.created_at}</td>
                  <td>
                    <button className="btn btn-sm" onClick={() => void openDetail(o.id)}>
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </div>

      {detailId !== null && (
        <Modal title={`订单详情 #${detailId}`} onClose={() => setDetailId(null)} wide>
          {detailError ? (
            <div className="alert">{detailError}</div>
          ) : !detail ? (
            <Empty text="加载中…" />
          ) : (
            <div>
              {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
              <table style={{ marginBottom: 14 }}>
                <tbody>
                  <tr>
                    <th style={{ width: 90 }}>订单号</th>
                    <td>{detail.order.order_no}</td>
                    <th style={{ width: 90 }}>状态</th>
                    <td>
                      <Badge text={ORDER_STATUS[detail.order.status] ?? detail.order.status} tone={ORDER_TONE[detail.order.status] ?? 'gray'} />
                    </td>
                  </tr>
                  <tr>
                    <th>下单用户</th>
                    <td>
                      {detail.order.user_nickname}（{detail.order.user_phone ?? '未绑定手机'}）
                    </td>
                    <th>金额</th>
                    <td>{fenToYuan(detail.order.total_cents)}</td>
                  </tr>
                  <tr>
                    <th>收货地址</th>
                    <td colSpan={3}>{detail.order.address || '-'}</td>
                  </tr>
                  <tr>
                    <th>备注</th>
                    <td colSpan={3}>{detail.order.remark || '-'}</td>
                  </tr>
                  <tr>
                    <th>下单时间</th>
                    <td className="muted">{detail.order.created_at}</td>
                    <th>更新时间</th>
                    <td className="muted">{detail.order.updated_at}</td>
                  </tr>
                </tbody>
              </table>
              <table style={{ marginBottom: 14 }}>
                <thead>
                  <tr>
                    <th>商品</th>
                    <th>单价</th>
                    <th>数量</th>
                    <th>小计</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((it) => (
                    <tr key={it.id}>
                      <td>{it.product_name}</td>
                      <td>{fenToYuan(it.price_cents)}</td>
                      <td>{it.quantity}</td>
                      <td>{fenToYuan(it.price_cents * it.quantity)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row-actions">
                {NEXT_ACTIONS[detail.order.status]?.map((a) => (
                  <button key={a.to} className={`btn ${a.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => void transition(a.to, a.label)}>
                    {a.label}
                  </button>
                ))}
                {NEXT_ACTIONS[detail.order.status]?.length === 0 && <span className="muted">订单已完结，无可执行操作</span>}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
