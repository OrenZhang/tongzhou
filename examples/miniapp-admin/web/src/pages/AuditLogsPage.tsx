import { useState, type FormEvent } from 'react';
import { usePagedList } from '../usePagedList';
import { Empty, Pagination } from '../components';

interface AuditLog {
  id: number;
  admin_name: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
  created_at: string;
}

export default function AuditLogsPage() {
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error } =
    usePagedList<AuditLog>('/api/audit-logs');
  const [kwInput, setKwInput] = useState('');

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  return (
    <div>
      <div className="page-head">
        <h2>审计日志</h2>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input
              placeholder="搜索操作人 / 动作 / 对象 / 详情"
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              style={{ width: 260 }}
            />
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
        </div>
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword ? '没有符合条件的日志' : '暂无审计日志'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象</th>
                <th>详情</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {list.map((l) => (
                <tr key={l.id}>
                  <td>{l.id}</td>
                  <td className="muted">{l.created_at}</td>
                  <td>{l.admin_name}</td>
                  <td>{l.action}</td>
                  <td>{l.target}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}>{l.detail}</td>
                  <td className="muted">{l.ip || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </div>
    </div>
  );
}
