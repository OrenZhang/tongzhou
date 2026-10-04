import { useEffect, useState } from 'react';
import { api, errorText } from '../api';
import { fenToYuan, ORDER_STATUS, ORDER_TONE } from '../format';
import { Badge, Empty } from '../components';

interface DashboardData {
  stats: {
    usersTotal: number;
    usersToday: number;
    usersDisabled: number;
    ordersTotal: number;
    ordersToday: number;
    pendingShip: number;
    gmvCents: number;
    gmvTodayCents: number;
    productsOn: number;
  };
  recentOrders: {
    id: number;
    order_no: string;
    status: string;
    total_cents: number;
    created_at: string;
    user_nickname: string;
  }[];
  trend: { date: string; order_count: number; gmv_cents: number }[];
}

export default function DashboardPage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<DashboardData>('/api/dashboard')
      .then(setData)
      .catch((err) => setError(errorText(err)));
  }, []);

  if (error) return <div className="alert">{error}</div>;
  if (!data) return <div className="empty">加载中…</div>;

  const { stats } = data;
  const maxGmv = Math.max(...data.trend.map((t) => t.gmv_cents), 1);

  return (
    <div>
      <div className="page-head">
        <h2>仪表盘</h2>
      </div>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="muted">用户总数</span>
          <div className="stat-value">{stats.usersTotal}</div>
          <div className="stat-sub">今日新增 {stats.usersToday} · 停用 {stats.usersDisabled}</div>
        </div>
        <div className="stat-card">
          <span className="muted">订单总数</span>
          <div className="stat-value">{stats.ordersTotal}</div>
          <div className="stat-sub">今日新增 {stats.ordersToday}</div>
        </div>
        <div className="stat-card">
          <span className="muted">成交额（GMV）</span>
          <div className="stat-value">{fenToYuan(stats.gmvCents)}</div>
          <div className="stat-sub">今日 {fenToYuan(stats.gmvTodayCents)}</div>
        </div>
        <div className="stat-card">
          <span className="muted">待发货订单</span>
          <div className="stat-value">{stats.pendingShip}</div>
          <div className="stat-sub">上架中商品 {stats.productsOn}</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 10 }}>近 7 天订单趋势</h3>
        <div className="trend">
          {data.trend.map((t) => (
            <div className="trend-col" key={t.date} title={`${t.date}：${t.order_count} 单 / ${fenToYuan(t.gmv_cents)}`}>
              <div className="trend-bar" style={{ height: `${Math.max(2, Math.round((t.gmv_cents / maxGmv) * 100))}%` }} />
              <span>{t.date}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 10 }}>最近订单</h3>
        {data.recentOrders.length === 0 ? (
          <Empty />
        ) : (
          <table>
            <thead>
              <tr>
                <th>订单号</th>
                <th>用户</th>
                <th>金额</th>
                <th>状态</th>
                <th>下单时间</th>
              </tr>
            </thead>
            <tbody>
              {data.recentOrders.map((o) => (
                <tr key={o.id}>
                  <td>{o.order_no}</td>
                  <td>{o.user_nickname}</td>
                  <td>{fenToYuan(o.total_cents)}</td>
                  <td>
                    <Badge text={ORDER_STATUS[o.status] ?? o.status} tone={ORDER_TONE[o.status] ?? 'gray'} />
                  </td>
                  <td className="muted">{o.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
