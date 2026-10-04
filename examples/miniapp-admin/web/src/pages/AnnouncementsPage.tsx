import { useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { usePagedList } from '../usePagedList';
import { Badge, Empty, Field, FormError, Modal, Pagination } from '../components';
import { ANN_STATUS } from '../format';

interface Announcement {
  id: number;
  title: string;
  content: string;
  status: 'draft' | 'published';
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AnnForm {
  title: string;
  content: string;
  status: 'draft' | 'published';
}

const EMPTY_FORM: AnnForm = { title: '', content: '', status: 'draft' };

export default function AnnouncementsPage() {
  const [status, setStatus] = useState('');
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload } = usePagedList<Announcement>('/api/announcements', {
    status,
  });
  const [kwInput, setKwInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<Announcement | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AnnForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError('');
    setCreating(true);
  }

  function openEdit(a: Announcement) {
    setForm({ title: a.title, content: a.content, status: a.status });
    setFormError('');
    setEditing(a);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const body = { title: form.title.trim(), content: form.content.trim(), status: form.status };
      if (editing) {
        await api.put(`/api/announcements/${editing.id}`, body);
        setEditing(null);
      } else {
        await api.post('/api/announcements', body);
        setCreating(false);
      }
      reload();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(a: Announcement) {
    setActionError('');
    const next = a.status === 'published' ? 'draft' : 'published';
    if (next === 'draft' && !window.confirm(`确定撤回公告「${a.title}」吗？撤回后对用户不可见。`)) return;
    try {
      await api.patch(`/api/announcements/${a.id}/status`, { status: next });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  async function remove(a: Announcement) {
    setActionError('');
    if (!window.confirm(`确定删除公告「${a.title}」吗？删除后不可恢复。`)) return;
    try {
      await api.del(`/api/announcements/${a.id}`);
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  const modalOpen = creating || editing !== null;

  return (
    <div>
      <div className="page-head">
        <h2>公告管理</h2>
        <button className="btn btn-primary" onClick={openCreate}>
          新增公告
        </button>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input placeholder="搜索标题 / 内容" value={kwInput} onChange={(e) => setKwInput(e.target.value)} style={{ width: 220 }} />
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
            <option value="published">已发布</option>
            <option value="draft">草稿</option>
          </select>
        </div>
        {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword || status ? '没有符合条件的公告' : '暂无公告，点击右上角新增'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>标题</th>
                <th>状态</th>
                <th>发布时间</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 200 }}>{a.title}</td>
                  <td>
                    <Badge text={ANN_STATUS[a.status] ?? a.status} tone={a.status === 'published' ? 'green' : 'gray'} />
                  </td>
                  <td className="muted">{a.published_at ? new Date(a.published_at).toLocaleString('zh-CN') : '-'}</td>
                  <td className="muted">{a.updated_at}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => openEdit(a)}>
                        编辑
                      </button>
                      <button className="btn btn-sm" onClick={() => void toggleStatus(a)}>
                        {a.status === 'published' ? '撤回' : '发布'}
                      </button>
                      <button className="btn btn-sm btn-danger" onClick={() => void remove(a)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
      </div>

      {modalOpen && (
        <Modal title={editing ? '编辑公告' : '新增公告'} onClose={() => (editing ? setEditing(null) : setCreating(false))} wide>
          <form onSubmit={submit}>
            <Field label="标题">
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={80} required />
            </Field>
            <Field label="内容">
              <textarea rows={6} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} maxLength={5000} required />
            </Field>
            {!editing && (
              <Field label="保存为">
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'draft' | 'published' })}>
                  <option value="draft">草稿（不在小程序展示）</option>
                  <option value="published">直接发布</option>
                </select>
              </Field>
            )}
            <FormError message={formError} />
            <div className="row-actions" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn" onClick={() => (editing ? setEditing(null) : setCreating(false))}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
