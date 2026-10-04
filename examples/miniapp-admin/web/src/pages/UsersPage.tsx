import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { usePagedList } from '../usePagedList';
import { Badge, Empty, Pagination } from '../components';
import { USER_STATUS } from '../format';

interface User {
  id: number;
  openid: string;
  nickname: string;
  phone: string | null;
  status: 'active' | 'disabled';
  created_at: string;
}

export default function UsersPage() {
  const [status, setStatus] = useState('');
  const listState = usePagedList<User>('/api/users', { status });
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload } = listState;
  const [kwInput, setKwInput] = useState('');
  const [actionError, setActionError] = useState('');

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  async function toggleStatus(u: User) {
    setActionError('');
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !window.confirm(`确定停用用户「${u.nickname}」吗？`)) return;
    try {
      await api.patch(`/api/users/${u.id}/status`, { status: next });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>用户管理</h2>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input
              placeholder="搜索昵称 / 手机 / openid"
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              style={{ width: 240 }}
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
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已停用</option>
          </select>
        </div>
        {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword || status ? '没有符合条件的用户' : '暂无用户'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>昵称</th>
                <th>openid</th>
                <th>手机</th>
                <th>状态</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td>
                  <td>{u.nickname}</td>
                  <td className="muted">{u.openid}</td>
                  <td>{u.phone ?? <span className="muted">未绑定</span>}</td>
                  <td>
                    <Badge text={USER_STATUS[u.status] ?? u.status} tone={u.status === 'active' ? 'green' : 'red'} />
                  </td>
                  <td className="muted">{u.created_at}</td>
                  <td>
                    <button className={`btn btn-sm ${u.status === 'active' ? 'btn-danger' : ''}`} onClick={() => void toggleStatus(u)}>
                      {u.status === 'active' ? '停用' : '启用'}
                    </button>
                  </td>
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
