import { useEffect, useState, type FormEvent } from 'react';
import { api, errorText } from '../api';
import { usePagedList } from '../usePagedList';
import { Badge, Empty, Field, FormError, Modal, Pagination } from '../components';
import { fenToYuan, ONOFF } from '../format';

interface Product {
  id: number;
  category_id: number;
  category_name: string;
  name: string;
  description: string;
  price_cents: number;
  stock: number;
  cover: string;
  status: 'on' | 'off';
  sales_count: number;
}

interface Category {
  id: number;
  name: string;
}

interface ProductForm {
  name: string;
  categoryId: string;
  price: string;
  stock: string;
  description: string;
  cover: string;
  status: 'on' | 'off';
}

const EMPTY_FORM: ProductForm = { name: '', categoryId: '', price: '', stock: '0', description: '', cover: '', status: 'off' };

export default function ProductsPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [status, setStatus] = useState('');
  const { list, total, page, pageSize, keyword, setKeyword, setPage, loading, error, reload } = usePagedList<Product>('/api/products', {
    categoryId,
    status,
  });
  const [kwInput, setKwInput] = useState('');
  const [actionError, setActionError] = useState('');
  const [editing, setEditing] = useState<Product | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<ProductForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ list: Category[] }>('/api/categories')
      .then((d) => setCategories(d.list))
      .catch(() => setCategories([]));
  }, []);

  function search(e: FormEvent) {
    e.preventDefault();
    setKeyword(kwInput);
  }

  function openCreate() {
    setForm({ ...EMPTY_FORM, categoryId: categoryId || (categories[0] ? String(categories[0].id) : '') });
    setFormError('');
    setCreating(true);
  }

  function openEdit(p: Product) {
    setForm({
      name: p.name,
      categoryId: String(p.category_id),
      price: (p.price_cents / 100).toFixed(2),
      stock: String(p.stock),
      description: p.description,
      cover: p.cover,
      status: p.status,
    });
    setFormError('');
    setEditing(p);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError('');
    try {
      const price = Number(form.price);
      const stock = Number(form.stock);
      if (!Number.isFinite(price) || price < 0) throw new Error('价格必须为不小于 0 的数字');
      if (!Number.isInteger(stock) || stock < 0) throw new Error('库存必须为不小于 0 的整数');
      const body = {
        name: form.name.trim(),
        categoryId: Number(form.categoryId),
        price,
        stock,
        description: form.description.trim(),
        cover: form.cover.trim(),
        status: form.status,
      };
      if (editing) {
        await api.put(`/api/products/${editing.id}`, body);
        setEditing(null);
      } else {
        await api.post('/api/products', body);
        setCreating(false);
      }
      reload();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(p: Product) {
    setActionError('');
    try {
      await api.patch(`/api/products/${p.id}/status`, { status: p.status === 'on' ? 'off' : 'on' });
      reload();
    } catch (err) {
      setActionError(errorText(err));
    }
  }

  const modalOpen = creating || editing !== null;

  return (
    <div>
      <div className="page-head">
        <h2>商品管理</h2>
        <button className="btn btn-primary" onClick={openCreate}>
          新增商品
        </button>
      </div>
      <div className="card">
        <div className="toolbar">
          <form onSubmit={search} style={{ display: 'flex', gap: 10 }}>
            <input placeholder="搜索商品名称" value={kwInput} onChange={(e) => setKwInput(e.target.value)} style={{ width: 200 }} />
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
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部分类</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            <option value="on">上架中</option>
            <option value="off">已下架</option>
          </select>
        </div>
        {actionError && <div className="alert" style={{ marginBottom: 12 }}>{actionError}</div>}
        {error ? (
          <div className="alert">{error}</div>
        ) : loading ? (
          <Empty text="加载中…" />
        ) : list.length === 0 ? (
          <Empty text={keyword || categoryId || status ? '没有符合条件的商品' : '暂无商品，点击右上角新增'} />
        ) : (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>商品</th>
                <th>分类</th>
                <th>价格</th>
                <th>库存</th>
                <th>销量</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td>{p.id}</td>
                  <td>
                    {p.cover} {p.name}
                  </td>
                  <td className="muted">{p.category_name}</td>
                  <td>{fenToYuan(p.price_cents)}</td>
                  <td>{p.stock}</td>
                  <td>{p.sales_count}</td>
                  <td>
                    <Badge text={ONOFF[p.status] ?? p.status} tone={p.status === 'on' ? 'green' : 'gray'} />
                  </td>
                  <td>
                    <div className="row-actions">
                      <button className="btn btn-sm" onClick={() => openEdit(p)}>
                        编辑
                      </button>
                      <button className="btn btn-sm" onClick={() => void toggleStatus(p)}>
                        {p.status === 'on' ? '下架' : '上架'}
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
        <Modal title={editing ? '编辑商品' : '新增商品'} onClose={() => (editing ? setEditing(null) : setCreating(false))} wide>
          <form onSubmit={submit}>
            <Field label="商品名称">
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} required />
            </Field>
            <Field label="分类">
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} required>
                <option value="" disabled>
                  请选择分类
                </option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <div style={{ display: 'flex', gap: 12 }}>
              <Field label="价格（元）">
                <input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} required />
              </Field>
              <Field label="库存">
                <input type="number" min={0} step={1} value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} required />
              </Field>
              <Field label="状态">
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as 'on' | 'off' })}>
                  <option value="off">下架</option>
                  <option value="on">上架</option>
                </select>
              </Field>
            </div>
            <Field label="封面（表情或图片 URL，可留空）">
              <input value={form.cover} onChange={(e) => setForm({ ...form, cover: e.target.value })} maxLength={300} />
            </Field>
            <Field label="商品描述">
              <textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={2000} />
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
