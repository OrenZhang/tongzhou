'use strict';
const config = require('./config');
const { hashPassword } = require('./util/password');
const { nowStr } = require('./db');

// 可复现实验数据的伪随机数（固定种子）
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '林', '何', '郭'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '艳', '勇', '军', '杰', '娟', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英'];
const STREETS = ['中山路', '解放大道', '人民路', '建设路', '和平街', '学府路', '滨江路', '朝阳街'];
const CITIES = ['杭州市', '上海市', '北京市', '成都市', '武汉市', '深圳市', '南京市'];

function seed(db) {
  const hasAdmin = db.prepare('SELECT COUNT(*) AS c FROM admins').get().c > 0;
  if (hasAdmin) return false;

  // 生产模式：必须显式设置密码才初始化，且只建账号、不生成合成演示数据；
  // 未设置时拒绝创建默认密码账号，直接跳过初始化
  if (config.env === 'production') {
    if (!config.adminPassword) {
      console.warn('[miniapp-admin] 生产模式未设置 ADMIN_PASSWORD，跳过初始化（不创建默认密码账号与演示数据）');
      return false;
    }
    const ins = db.prepare('INSERT INTO admins (username, password_hash, name, role) VALUES (?,?,?,?)');
    ins.run('admin', hashPassword(config.adminPassword), '系统管理员', 'admin');
    if (config.operatorPassword) ins.run('operator', hashPassword(config.operatorPassword), '运营小王', 'operator');
    return true;
  }

  const rnd = mulberry32(20261004);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const int = (min, max) => min + Math.floor(rnd() * (max - min + 1));

  // 1. 管理员账号
  const insAdmin = db.prepare('INSERT INTO admins (username, password_hash, name, role) VALUES (?,?,?,?)');
  insAdmin.run('admin', hashPassword(config.adminPassword), '系统管理员', 'admin');
  insAdmin.run('operator', hashPassword(config.operatorPassword), '运营小王', 'operator');

  // 2. 用户
  const insUser = db.prepare('INSERT INTO users (openid, nickname, phone, status, created_at) VALUES (?,?,?,?,?)');
  const usedNames = new Set();
  for (let i = 0; i < 36; i++) {
    let nickname;
    do {
      nickname = pick(SURNAMES) + pick(GIVEN);
    } while (usedNames.has(nickname));
    usedNames.add(nickname);
    const openid = `o${String(i + 1).padStart(3, '0')}${Math.floor(rnd() * 1e12).toString(16).padStart(10, '0')}`;
    const phone = rnd() > 0.15 ? `1${pick(['30', '35', '37', '38', '50', '55', '58', '66', '77', '80', '85', '86', '88', '99'])}${String(int(10000000, 99999999))}` : null;
    const status = i === 4 || i === 11 ? 'disabled' : 'active';
    const created = new Date(Date.now() - int(0, 45) * 86400e3 - int(0, 86399) * 1000);
    insUser.run(openid, nickname, phone, status, nowStr(created));
  }

  // 3. 分类
  const insCat = db.prepare('INSERT INTO categories (name, sort, status) VALUES (?,?,?)');
  const cats = ['数码配件', '家居生活', '食品饮料', '服饰鞋包', '美妆个护', '图书文具'];
  const catIds = cats.map((name, i) => Number(insCat.run(name, (i + 1) * 10, 'on').lastInsertRowid));

  // 4. 商品
  const insProduct = db.prepare(
    'INSERT INTO products (category_id, name, description, price_cents, stock, cover, status, sales_count) VALUES (?,?,?,?,?,?,?,?)'
  );
  const productNames = {
    0: ['快充数据线 1.5m', '无线蓝牙耳机', '磁吸手机壳', '桌面手机支架'],
    1: ['北欧风马克杯', '颈椎按摩靠枕', '香薰蜡烛礼盒', '折叠收纳箱'],
    2: ['手冲挂耳咖啡 10包', '每日坚果混合装', '柠檬蜂蜜茶', '黑巧克力礼盒'],
    3: ['基础款纯棉 T 恤', '轻便跑步鞋', '防泼水双肩包', '加绒连帽卫衣'],
    4: ['保湿补水面膜 5片', '氨基酸洁面乳', '植物精油护手霜', '温和卸妆水'],
    5: ['高效能人士笔记本', '钢笔礼盒套装', '时间管理手册', '素描本 A4'],
  };
  const covers = ['🎧', '☕', '🧴', '👟', '📚', '🕯️', '🥜', '🍫', '👕', '🎒', '🖊️', '🧢'];
  const productIds = [];
  for (let c = 0; c < catIds.length; c++) {
    for (const name of productNames[c]) {
      const priceCents = int(99, 2999) * 10 + 90;
      const stock = int(0, 500);
      const status = rnd() > 0.25 ? 'on' : 'off';
      const sales = int(0, 800);
      const id = Number(
        insProduct.run(catIds[c], name, `${name}，合成演示商品，支持七天无理由退换。`, priceCents, stock, pick(covers), status, sales).lastInsertRowid
      );
      productIds.push({ id, name, priceCents });
    }
  }

  // 5. 订单（近 10 天，各状态分布）
  const insOrder = db.prepare(
    'INSERT INTO orders (order_no, user_id, status, total_cents, address, remark, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)'
  );
  const insItem = db.prepare('INSERT INTO order_items (order_id, product_id, product_name, price_cents, quantity) VALUES (?,?,?,?,?)');
  const userRows = db.prepare('SELECT id, nickname FROM users').all();
  const statusPool = [
    ...Array(8).fill('pending'),
    ...Array(10).fill('paid'),
    ...Array(10).fill('shipped'),
    ...Array(16).fill('completed'),
    ...Array(4).fill('cancelled'),
  ];
  for (let i = 0; i < statusPool.length; i++) {
    const status = statusPool[i];
    const user = pick(userRows);
    const itemCount = int(1, 3);
    let total = 0;
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      const p = pick(productIds);
      const qty = int(1, 2);
      total += p.priceCents * qty;
      items.push({ ...p, qty });
    }
    const created = new Date(Date.now() - int(0, 9) * 86400e3 - int(0, 86399) * 1000);
    const orderNo = `MO${created.getFullYear()}${String(created.getMonth() + 1).padStart(2, '0')}${String(created.getDate()).padStart(2, '0')}${String(100000 + i)}`;
    const address = `${pick(CITIES)}${pick(STREETS)}${int(1, 200)}号${int(1, 30)}栋${int(101, 2504)}室`;
    const remark = rnd() > 0.8 ? '请放快递柜' : '';
    const t = nowStr(created);
    const orderId = Number(insOrder.run(orderNo, user.id, status, total, address, remark, t, t).lastInsertRowid);
    for (const it of items) insItem.run(orderId, it.id, it.name, it.priceCents, it.qty);
  }

  // 6. 公告
  const insAnn = db.prepare('INSERT INTO announcements (title, content, status, published_at) VALUES (?,?,?,?)');
  insAnn.run('小程序 v1.2 版本上线公告', '本次更新：新增订单物流跟踪、优化首页加载速度、修复已知问题。感谢大家的支持！', 'published', new Date(Date.now() - 3 * 86400e3).toISOString());
  insAnn.run('国庆假期发货安排', '10 月 1 日至 10 月 3 日仓库休假，期间订单将于 10 月 4 日起陆续发出，敬请谅解。', 'published', new Date(Date.now() - 1 * 86400e3).toISOString());
  insAnn.run('会员积分规则调整预告', '积分获取规则将于下月调整，详情请关注后续公告。', 'draft', null);
  insAnn.run('商品上新：冬季保暖系列', '冬季保暖系列新品即将上架，敬请期待。', 'draft', null);

  return true;
}

module.exports = { seed };
