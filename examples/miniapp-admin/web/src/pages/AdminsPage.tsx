import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { usePagedList } from '../usePagedList';
import { useAuth } from '../auth';
import { Badge, Empty, Field, FormError, Modal, Pagination } from '../components';
import { ROLE_TEXT } from '../format';

interface AdminRow {
  id: number;
  username: string;
  name: string;
  role: 'admin' | 'operator';
  status: 'active' | 'disabled';
  created_at: string;
}

interface AdminForm {
  username: string;
  name: string;
  password: string;
  role: 'admin' | 'operator';
}

const EMPTY_FORM: AdminForm = { username: '', name: '', password: '', role: 'operator' };

export default function AdminsPage() {
  const { user: me } = useAuth();
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload } = usePagedList<AdminRow>('/api/admins');
  const [kwInput, setKwInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AdminForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetTarget, setResetTarget] = useState<AdminRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetError, setResetError] = useState('');

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      await api.post('/api/admins', {
        username: form.username.trim(),
        name: form.name.trim(),
        password: form.password,
        role: form.role,
      });
      setCreating(false);
      setForm(EMPTY_FORM);
      reload();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(a: AdminRow) {
    setActionError('');
    const next = a.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !window.confirm(`确定停用账号「${a.name}（${a.username}）」吗？其会话将立即失效。`)) return;
    try {
      await api.patch(`/api/admins/${a.id}/status`, { status: next });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  async function changeRole(a: AdminRow) {
    setActionError('');
    const next = a.role === 'admin' ? 'operator' : 'admin';
    if (!window.confirm(`确定将「${a.username}」的角色改为${ROLE_TEXT[next]}吗？`)) return;
    try {
      await api.patch(`/api/admins/${a.id}/role`, { role: next });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  function openReset(a: AdminRow) {
    setResetTarget(a);
    setNewPassword('');
    setResetError('');
  }

  async function submitReset(e: FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    setBusy(true);
    setResetError('');
    try {
      await api.put(`/api/admins/${resetTarget.id}/password`, { password: newPassword });
      setResetTarget(null);
      setNewPassword('');
    } catch (err) {
      setResetError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <h2>管理员与运营账号</h2>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>
          新增账号
        </button>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input placeholder="搜索用户名 / 姓名" value={kwInput} onChange={(e) => setKwInput(e.target.value)} style={{ width: 220 }} />
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
        {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword ? '没有符合条件的账号' : '暂无账号'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>用户名</th>
                <th>姓名</th>
                <th>角色</th>
                <th>状态</th>
                <th>创建时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => {
                const isSelf = a.id === me?.id;
                return (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>
                      {a.username} {isSelf && <span className="muted">（我）</span>}
                    </td>
                    <td>{a.name}</td>
                    <td>
                      <Badge text={ROLE_TEXT[a.role] ?? a.role} tone={a.role === 'admin' ? 'blue' : 'gray'} />
                    </td>
                    <td>
                      <Badge text={a.status === 'active' ? '正常' : '已停用'} tone={a.status === 'active' ? 'green' : 'red'} />
                    </td>
                    <td className="muted">{a.created_at}</td>
                    <td>
                      <div className="row-actions">
                        <button className="btn btn-sm" disabled={isSelf} onClick={() => void toggleStatus(a)}>
                          {a.status === 'active' ? '停用' : '启用'}
                        </button>
                        <button className="btn btn-sm" disabled={isSelf} onClick={() => void changeRole(a)}>
                          设为{ROLE_TEXT[a.role === 'admin' ? 'operator' : 'admin']}
                        </button>
                        <button className="btn btn-sm" onClick={() => openReset(a)}>
                          重置密码
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </div>

      {creating && (
        <Modal title="新增账号" onClose={() => setCreating(false)}>
          <form onSubmit={submit}>
            <Field label="用户名（字母、数字、下划线、点、横线）">
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} maxLength={30} required />
            </Field>
            <Field label="姓名">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={30} required />
            </Field>
            <Field label="初始密码（至少 8 位）">
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} minLength={8} required />
            </Field>
            <Field label="角色">
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'admin' | 'operator' })}>
                <option value="operator">运营（不可管理管理员、不可看审计日志）</option>
                <option value="admin">管理员（全部权限）</option>
              </select>
            </Field>
            <FormError message={formError} />
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setCreating(false)}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {resetTarget && (
        <Modal title={`重置密码：${resetTarget.name}（${resetTarget.username}）`} onClose={() => setResetTarget(null)}>
          <form onSubmit={submitReset}>
            <Field label="新密码（至少 8 位）">
              <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} minLength={8} required autoFocus />
            </Field>
            <p className="muted small">重置后该账号的所有登录会话将立即失效。</p>
            <FormError message={resetError} />
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => setResetTarget(null)}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '提交中…' : '重置'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
