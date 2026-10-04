import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { Badge, Empty, Field, FormError, Modal } from '../components';
import { ONOFF } from '../format';

interface Category {
  id: number;
  name: string;
  sort: number;
  status: 'on' | 'off';
  product_count: number;
}

interface CategoryForm {
  name: string;
  sort: string;
  status: 'on' | 'off';
}

const EMPTY_FORM: CategoryForm = { name: '', sort: '0', status: 'on' };

export default function CategoriesPage() {
  const [list, setList] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CategoryForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    api
      .get<{ list: Category[] }>('/api/categories')
      .then((d) => setList(d.list))
      .catch((err) => setError(errorText(err)))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError('');
    setCreating(true);
  }

  function openEdit(c: Category) {
    setForm({ name: c.name, sort: String(c.sort), status: c.status });
    setFormError('');
    setEditing(c);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const body = { name: form.name.trim(), sort: Number(form.sort) || 0, status: form.status };
      if (editing) {
        await api.put(`/api/categories/${editing.id}`, body);
        setEditing(null);
      } else {
        await api.post('/api/categories', body);
        setCreating(false);
      }
      load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(c: Category) {
    setActionError('');
    try {
      await api.patch(`/api/categories/${c.id}/status`, { status: c.status === 'on' ? 'off' : 'on' });
      load();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  async function remove(c: Category) {
    setActionError('');
    if (!window.confirm(`确定删除分类「${c.name}」吗？`)) return;
    try {
      await api.del(`/api/categories/${c.id}`);
      load();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  const modalOpen = creating || editing !== null;

  return (
    <div>
      <div className="page-head">
        <h2>商品分类</h2>
        <button className="btn btn-primary" onClick={openCreate}>
          新增分类
        </button>
      </div>
      <div className="card">
        {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text="暂无分类，点击右上角新增" />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>名称</th>
                <th>排序</th>
                <th>商品数</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>{c.name}</td>
                  <td>{c.sort}</td>
                  <td>{c.product_count}</td>
                  <td>
                    <Badge text={ONOFF[c.status] ?? c.status} tone={c.status === 'on' ? 'green' : 'gray'} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => openEdit(c)}>
                        编辑
                      </button>
                      <button className="btn btn-sm" onClick={() => void toggleStatus(c)}>
                        {c.status === 'on' ? '下架' : '上架'}
                      </button>
                      <button className="btn btn-sm btn-danger" disabled={c.product_count > 0} onClick={() => void remove(c)}>
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {modalOpen && (
        <Modal title={editing ? '编辑分类' : '新增分类'} onClose={() => (editing ? setEditing(null) : setCreating(false))}>
          <form onSubmit={submit}>
            <Field label="分类名称">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={30} required />
            </Field>
            <Field label="排序（数字越小越靠前）">
              <input type="number" min={0} value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })} />
            </Field>
            <Field label="状态">
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'on' | 'off' })}>
                <option value="on">上架</option>
                <option value="off">下架</option>
              </select>
            </Field>
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
