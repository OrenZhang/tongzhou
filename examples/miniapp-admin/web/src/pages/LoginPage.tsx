import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { errorText } from '../api';

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>小程序运营后台</h1>
        <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>
          请使用管理员或运营账号登录
        </p>
        <label className="field">
          <span className="field-label">用户名</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label className="field">
          <span className="field-label">密码</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="muted small" style={{ margin: 0 }}>
          演示账号：admin / Admin@123456（管理员）、operator / Operator@123456（运营）
        </p>
      </form>
    </div>
  );
}
