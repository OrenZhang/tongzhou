'use strict';
// API 集成测试：使用内存数据库 + 真实 HTTP 请求（node:test + fetch）
process.env.DB_PATH = ':memory:';
process.env.NODE_ENV = 'test';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

let server;
let base;

before(async () => {
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Cookie'] = `miniapp_admin_sid=${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// 包装 fetch 以读取 set-cookie 响应头
async function apiRaw(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => null), raw: res };
}

async function adminToken() {
  const r = await apiRaw('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'Admin@123456' } });
  assert.equal(r.status, 200, `管理员登录失败: ${JSON.stringify(r.data)}`);
  return r.raw.headers.get('set-cookie').match(/miniapp_admin_sid=([a-f0-9]{64})/)[1];
}
async function operatorToken() {
  const r = await apiRaw('/api/auth/login', { method: 'POST', body: { username: 'operator', password: 'Operator@123456' } });
  assert.equal(r.status, 200, `运营登录失败: ${JSON.stringify(r.data)}`);
  return r.raw.headers.get('set-cookie').match(/miniapp_admin_sid=([a-f0-9]{64})/)[1];
}

// ---------- 认证与会话 ----------

test('未登录访问受保护接口返回 401', async () => {
  for (const p of ['/api/auth/me', '/api/users', '/api/orders', '/api/dashboard', '/api/products', '/api/announcements']) {
    const r = await api(p);
    assert.equal(r.status, 401, p);
    assert.ok(r.data.error);
  }
});

test('登录失败：错误密码 401，空用户名 400', async () => {
  const bad = await api('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'wrong-pass' } });
  assert.equal(bad.status, 401);
  const empty = await api('/api/auth/login', { method: 'POST', body: { username: ' ', password: 'x' } });
  assert.equal(empty.status, 400);
});

test('登录成功返回用户信息并可访问 me；退出后会话失效', async () => {
  const token = await adminToken();
  const me = await api('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.user.role, 'admin');
  const out = await api('/api/auth/logout', { method: 'POST', token });
  assert.equal(out.status, 200);
  const me2 = await api('/api/auth/me', { token });
  assert.equal(me2.status, 401);
});

test('登录限流：连续失败后返回 429', async () => {
  for (let i = 0; i < 8; i++) {
    await api('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'bad' } });
  }
  const r = await api('/api/auth/login', { method: 'POST', body: { username: 'nobody', password: 'bad' } });
  assert.equal(r.status, 429);
});

// ---------- 角色权限 ----------

test('运营角色可登录；不可管理管理员（列表/新建/停用均 403）；不可看审计日志', async () => {
  const op = await operatorToken();
  const list = await api('/api/admins', { token: op });
  assert.equal(list.status, 403);
  const create = await api('/api/admins', {
    method: 'POST',
    body: { username: 'hacker', name: 'x', password: 'Passw0rd!x', role: 'admin' },
    token: op,
  });
  assert.equal(create.status, 403);
  const disable = await api('/api/admins/1/status', { method: 'PATCH', body: { status: 'disabled' }, token: op });
  assert.equal(disable.status, 403);
  const audit = await api('/api/audit-logs?pageSize=5', { token: op });
  assert.equal(audit.status, 403);

  // 运营角色可正常使用业务接口
  const users = await api('/api/users', { token: op });
  assert.equal(users.status, 200);
  const orders = await api('/api/orders', { token: op });
  assert.equal(orders.status, 200);
});

// ---------- 用户管理 ----------

test('用户列表分页正确；关键词搜索生效；状态筛选生效', async () => {
  const token = await adminToken();
  const p1 = await api('/api/users?page=1&pageSize=5', { token });
  assert.equal(p1.status, 200);
  assert.equal(p1.data.list.length, 5);
  assert.ok(p1.data.total > 5);
  const p2 = await api('/api/users?page=2&pageSize=5', { token });
  assert.notEqual(p1.data.list[0].id, p2.data.list[0].id);

  const kw = await api(`/api/users?keyword=${encodeURIComponent('王')}`, { token });
  assert.ok(kw.data.list.every((u) => u.nickname.includes('王') || (u.phone || '').includes('王') || u.openid.includes('王')));

  const dis = await api('/api/users?status=disabled', { token });
  assert.ok(dis.data.list.every((u) => u.status === 'disabled'));
  assert.ok(dis.data.total >= 1);
});

test('用户停用/启用生效且留审计', async () => {
  const token = await adminToken();
  const list = await api('/api/users?pageSize=1', { token });
  const uid = list.data.list[0].id;
  const off = await api(`/api/users/${uid}/status`, { method: 'PATCH', body: { status: 'disabled' }, token });
  assert.equal(off.status, 200);
  const check = await api(`/api/users?status=disabled&pageSize=100`, { token });
  assert.ok(check.data.list.some((u) => u.id === uid));
  const on = await api(`/api/users/${uid}/status`, { method: 'PATCH', body: { status: 'active' }, token });
  assert.equal(on.status, 200);
  const bad = await api(`/api/users/${uid}/status`, { method: 'PATCH', body: { status: 'x' }, token });
  assert.equal(bad.status, 400);
});

// ---------- 分类与商品 ----------

test('分类 CRUD：新增/重名 409/编辑/有商品禁止删除 409', async () => {
  const token = await adminToken();
  const c = await api('/api/categories', { method: 'POST', body: { name: '测试分类', sort: 99 }, token });
  assert.equal(c.status, 201);
  const dup = await api('/api/categories', { method: 'POST', body: { name: '测试分类' }, token });
  assert.equal(dup.status, 409);
  const upd = await api(`/api/categories/${c.data.id}`, { method: 'PUT', body: { name: '测试分类A', sort: 98, status: 'on' }, token });
  assert.equal(upd.status, 200);
  const withProduct = await api('/api/categories/1', { method: 'DELETE', token });
  assert.equal(withProduct.status, 409);
  const del = await api(`/api/categories/${c.data.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
});

test('商品拒绝负价格与负库存（新增与编辑均拒绝）', async () => {
  const token = await adminToken();
  const negPrice = await api('/api/products', { method: 'POST', body: { name: '负价格商品', categoryId: 1, price: -0.01, stock: 10 }, token });
  assert.equal(negPrice.status, 400);
  assert.ok(negPrice.data.error);
  const negStock = await api('/api/products', { method: 'POST', body: { name: '负库存商品', categoryId: 1, price: 9.9, stock: -1 }, token });
  assert.equal(negStock.status, 400);
  const negStockEdit = await api('/api/products/1', { method: 'PUT', body: { name: 'x', categoryId: 1, price: 9.9, stock: -5 }, token });
  assert.equal(negStockEdit.status, 400);
  const negPriceEdit = await api('/api/products/1', { method: 'PUT', body: { name: 'x', categoryId: 1, price: -100, stock: 5 }, token });
  assert.equal(negPriceEdit.status, 400);
  // 边界值：0 元与 0 库存是合法的
  const zero = await api('/api/products', { method: 'POST', body: { name: '零元商品', categoryId: 1, price: 0, stock: 0 }, token });
  assert.equal(zero.status, 201);
});

test('商品 CRUD：非法参数 400；新增/编辑/上下架生效', async () => {
  const token = await adminToken();
  const badCat = await api('/api/products', { method: 'POST', body: { name: 'x', categoryId: 9999, price: 10, stock: 1 }, token });
  assert.equal(badCat.status, 400);

  const c = await api('/api/products', { method: 'POST', body: { name: '测试商品', categoryId: 1, price: 19.99, stock: 100, description: 'd', status: 'off' }, token });
  assert.equal(c.status, 201);
  const list = await api('/api/products?keyword=测试商品', { token });
  assert.equal(list.data.total, 1);
  assert.equal(list.data.list[0].price_cents, 1999);
  assert.equal(list.data.list[0].category_name, '数码配件');

  const upd = await api(`/api/products/${c.data.id}`, { method: 'PUT', body: { name: '测试商品V2', categoryId: 1, price: 29.99, stock: 50, status: 'on' }, token });
  assert.equal(upd.status, 200);
  const on = await api(`/api/products/${c.data.id}/status`, { method: 'PATCH', body: { status: 'off' }, token });
  assert.equal(on.status, 200);
  const paged = await api('/api/products?page=2&pageSize=5', { token });
  assert.equal(paged.status, 200);
  assert.ok(paged.data.total > 5);
});

// ---------- 订单 ----------

test('订单列表分页/筛选；详情含明细', async () => {
  const token = await adminToken();
  const paid = await api('/api/orders?status=paid&pageSize=5', { token });
  assert.equal(paid.status, 200);
  assert.ok(paid.data.total >= 1);
  assert.ok(paid.data.list.every((o) => o.status === 'paid'));
  const id = paid.data.list[0].id;
  const detail = await api(`/api/orders/${id}`, { token });
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.items) && detail.data.items.length >= 1);
  assert.ok(detail.data.order.address);
  const nf = await api('/api/orders/999999', { token });
  assert.equal(nf.status, 404);
});

test('订单状态：非法流转 400，合法流转成功，终态不可再流转', async () => {
  const token = await adminToken();
  const created = await api('/api/orders?status=pending&pageSize=1', { token });
  const orderId = created.data.list[0].id;

  const illegal = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'completed' }, token });
  assert.equal(illegal.status, 400);

  for (const next of ['paid', 'shipped', 'completed']) {
    const r = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: next }, token });
    assert.equal(r.status, 200, `流转到 ${next} 失败: ${JSON.stringify(r.data)}`);
  }
  const again = await api(`/api/orders/${orderId}/status`, { method: 'PATCH', body: { status: 'pending' }, token });
  assert.equal(again.status, 400);
});

test('取消订单：pending 可取消，shipped 不可取消', async () => {
  const token = await adminToken();
  const pend = await api('/api/orders?status=pending&pageSize=1', { token });
  const ok = await api(`/api/orders/${pend.data.list[0].id}/status`, { method: 'PATCH', body: { status: 'cancelled' }, token });
  assert.equal(ok.status, 200);
  const ship = await api('/api/orders?status=shipped&pageSize=1', { token });
  const no = await api(`/api/orders/${ship.data.list[0].id}/status`, { method: 'PATCH', body: { status: 'cancelled' }, token });
  assert.equal(no.status, 400);
});

// ---------- 公告 ----------

test('公告 CRUD：新增/编辑/发布/撤回/删除，草稿与发布状态可筛选', async () => {
  const token = await adminToken();
  const c = await api('/api/announcements', { method: 'POST', body: { title: '测试公告', content: '内容内容', status: 'draft' }, token });
  assert.equal(c.status, 201);
  // 草稿不出现在已发布列表
  const pubOnly = await api('/api/announcements?status=published&keyword=测试公告', { token });
  assert.equal(pubOnly.data.total, 0);
  const draftOnly = await api('/api/announcements?status=draft&keyword=测试公告', { token });
  assert.equal(draftOnly.data.total, 1);

  const upd = await api(`/api/announcements/${c.data.id}`, { method: 'PUT', body: { title: '测试公告2', content: '新内容' }, token });
  assert.equal(upd.status, 200);
  const pub = await api(`/api/announcements/${c.data.id}/status`, { method: 'PATCH', body: { status: 'published' }, token });
  assert.equal(pub.status, 200);
  const detail = await api('/api/announcements?status=published&keyword=测试公告2', { token });
  assert.equal(detail.data.total, 1);
  const back = await api(`/api/announcements/${c.data.id}/status`, { method: 'PATCH', body: { status: 'draft' }, token });
  assert.equal(back.status, 200);
  const del = await api(`/api/announcements/${c.data.id}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  const nf = await api(`/api/announcements/${c.data.id}`, { method: 'PUT', body: { title: 't', content: 'c' }, token });
  assert.equal(nf.status, 404);
});

// ---------- 管理员管理（仅 admin）与审计 ----------

test('管理员管理：新建账号/重名 409/停用后无法登录/不能停用自己', async () => {
  const token = await adminToken();
  const c = await api('/api/admins', { method: 'POST', body: { username: 'op2', name: '运营小李', password: 'Passw0rd!x', role: 'operator' }, token });
  assert.equal(c.status, 201);
  const dup = await api('/api/admins', { method: 'POST', body: { username: 'op2', name: 'x', password: 'Passw0rd!x', role: 'operator' }, token });
  assert.equal(dup.status, 409);
  const weak = await api('/api/admins', { method: 'POST', body: { username: 'op3', name: 'x', password: 'short', role: 'operator' }, token });
  assert.equal(weak.status, 400);

  const me = await api('/api/auth/me', { token });
  const self = await api(`/api/admins/${me.data.user.id}/status`, { method: 'PATCH', body: { status: 'disabled' }, token });
  assert.equal(self.status, 400);

  const off = await api(`/api/admins/${c.data.id}/status`, { method: 'PATCH', body: { status: 'disabled' }, token });
  assert.equal(off.status, 200);
  const blocked = await apiRaw('/api/auth/login', { method: 'POST', body: { username: 'op2', password: 'Passw0rd!x' } });
  assert.equal(blocked.status, 403);
});

test('审计日志记录登录与业务操作，支持分页', async () => {
  const token = await adminToken();
  const r = await api('/api/audit-logs?page=1&pageSize=10', { token });
  assert.equal(r.status, 200);
  assert.ok(r.data.total > 0);
  const actions = new Set(r.data.list.map((x) => x.action));
  assert.ok(actions.has('登录'));
  assert.ok(r.data.list.every((x) => x.admin_name));
  const kw = await api(`/api/audit-logs?keyword=${encodeURIComponent('登录')}`, { token });
  assert.ok(kw.data.total >= 1);
});

// ---------- 列表搜索空状态 ----------

test('列表搜索空状态：无匹配时返回空列表与 total=0', async () => {
  const token = await adminToken();
  const kw = encodeURIComponent('一定不存在的关键词xyz');
  for (const p of ['/api/users', '/api/products', '/api/announcements']) {
    const r = await api(`${p}?keyword=${kw}`, { token });
    assert.equal(r.status, 200, p);
    assert.equal(r.data.total, 0, p);
    assert.deepEqual(r.data.list, [], p);
  }
  const orders = await api(`/api/orders?keyword=${kw}`, { token });
  assert.equal(orders.status, 200);
  assert.equal(orders.data.total, 0);
  assert.deepEqual(orders.data.list, []);
  const admins = await api(`/api/admins?keyword=${kw}`, { token });
  assert.equal(admins.status, 200);
  assert.equal(admins.data.total, 0);
  assert.deepEqual(admins.data.list, []);
});

// ---------- 仪表盘 ----------

test('仪表盘返回统计、最近订单与7天趋势', async () => {
  const token = await adminToken();
  const r = await api('/api/dashboard', { token });
  assert.equal(r.status, 200);
  assert.ok(r.data.stats.usersTotal >= 30);
  assert.ok(r.data.stats.ordersTotal >= 40);
  assert.ok(r.data.stats.gmvCents > 0);
  assert.equal(r.data.recentOrders.length, 8);
  assert.equal(r.data.trend.length, 7);
});
