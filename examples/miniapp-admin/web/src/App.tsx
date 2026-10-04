import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { ROLE_TEXT } from './format';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import UsersPage from './pages/UsersPage';
import CategoriesPage from './pages/CategoriesPage';
import ProductsPage from './pages/ProductsPage';
import OrdersPage from './pages/OrdersPage';
import AnnouncementsPage from './pages/AnnouncementsPage';
import AdminsPage from './pages/AdminsPage';
import AuditLogsPage from './pages/AuditLogsPage';

function Shell() {
  const { user, logout } = useAuth();
  const isAdmin = user?.role === 'admin';
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">小程序运营后台</div>
        <nav>
          <NavLink to="/" end>
            仪表盘
          </NavLink>
          <NavLink to="/users">用户管理</NavLink>
          <NavLink to="/categories">商品分类</NavLink>
          <NavLink to="/products">商品管理</NavLink>
          <NavLink to="/orders">订单管理</NavLink>
          <NavLink to="/announcements">公告管理</NavLink>
          {isAdmin && <NavLink to="/admins">管理员</NavLink>}
          {isAdmin && <NavLink to="/audit">审计日志</NavLink>}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">
            {user?.name}（{ROLE_TEXT[user?.role ?? 'operator']}）
          </span>
          <button
            className="btn"
            onClick={() => {
              void logout();
            }}
          >
            退出登录
          </button>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/users" element={<UsersPage />} />
            <Route path="/categories" element={<CategoriesPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/announcements" element={<AnnouncementsPage />} />
            {isAdmin && <Route path="/admins" element={<AdminsPage />} />}
            {isAdmin && <Route path="/audit" element={<AuditLogsPage />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function Root() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash">加载中…</div>;
  if (!user) return <LoginPage />;
  return <Shell />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Root />
      </BrowserRouter>
    </AuthProvider>
  );
}
