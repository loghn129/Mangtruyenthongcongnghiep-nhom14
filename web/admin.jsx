/* Nhà kính thông minh — tài khoản, lịch sử cảm biến và quản trị. */
(() => {
  const { useState, useEffect, useRef, useCallback } = React;
  const { cx, Icon, Card, CardHeader, Button, Segmented, Field, INPUT } = GH.ui;
  const { api, fmt1, pad2 } = GH.lib;

  const ROLE_LABEL = { viewer: 'Chỉ xem', operator: 'Điều khiển', admin: 'Quản trị' };
  const ROLES = Object.keys(ROLE_LABEL);

  function RoleSelect({ value, onChange, disabled, label }) {
    return (
      <select aria-label={label} className={cx(INPUT, 'w-auto cursor-pointer font-sans text-xs')} value={value} disabled={disabled}
        onChange={e => onChange(e.target.value)}>
        {ROLES.map(r => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>
    );
  }

  // ======================= Thanh tài khoản + đổi mật khẩu =======================
  function AccountBar({ me, onPassword, onLogout }) {
    if (!me) return null;
    return (
      <div className="flex items-center gap-1">
        <span className="hidden items-center gap-1.5 whitespace-nowrap rounded-full border border-zinc-200 bg-white px-2.5 py-1 text-[11.5px] text-zinc-700 sm:inline-flex">
          <Icon name="CircleUser" size={13} className="text-emerald-700" />
          <b className="font-medium">{me.user}</b><span className="text-zinc-400">·</span>{ROLE_LABEL[me.role] || me.role}
        </span>
        <Button size="sm" variant="subtle" className="w-8 !px-0" aria-label="Đổi mật khẩu" title="Đổi mật khẩu" onClick={onPassword}><Icon name="KeyRound" size={15} /></Button>
        <Button size="sm" variant="subtle" className="w-8 !px-0" aria-label="Đăng xuất" title="Đăng xuất" onClick={onLogout}><Icon name="LogOut" size={15} /></Button>
      </div>
    );
  }

  function PasswordDialog({ minLen, onClose, push }) {
    const [form, setForm] = useState({ old: '', pw: '', pw2: '' });
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const set = k => e => setForm(f => ({ ...f, [k]: e.target.value }));
    useEffect(() => {
      const onKey = e => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const submit = async e => {
      e.preventDefault();
      if (form.pw.length < minLen) { setError(`Mật khẩu mới phải có ít nhất ${minLen} ký tự.`); return; }
      if (form.pw !== form.pw2) { setError('Hai ô mật khẩu mới không giống nhau.'); return; }
      setBusy(true);
      try {
        await api('/api/password', { old: form.old, new: form.pw });
        push('Đã đổi mật khẩu', '', 'ok');
        onClose();
      } catch (x) { setError(x.message); setBusy(false); }
    };
    return (
      <div className="fixed inset-0 z-50 grid place-items-center bg-zinc-900/30 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Đổi mật khẩu"
        onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <form onSubmit={submit} className="fade-up w-full max-w-sm space-y-3 rounded-2xl border border-zinc-200 bg-white p-5 shadow-2xl shadow-zinc-900/10">
          <h3 className="text-base font-semibold text-zinc-900">Đổi mật khẩu</h3>
          <Field label="Mật khẩu hiện tại" htmlFor="pw-old"><input id="pw-old" type="password" autoFocus required autoComplete="current-password" className={INPUT} value={form.old} onChange={set('old')} /></Field>
          <Field label={`Mật khẩu mới (từ ${minLen} ký tự)`} htmlFor="pw-new"><input id="pw-new" type="password" required autoComplete="new-password" className={INPUT} value={form.pw} onChange={set('pw')} /></Field>
          <Field label="Nhập lại mật khẩu mới" htmlFor="pw-new2"><input id="pw-new2" type="password" required autoComplete="new-password" className={INPUT} value={form.pw2} onChange={set('pw2')} /></Field>
          {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Huỷ</Button>
            <Button variant="primary" type="submit" disabled={busy}>Đổi mật khẩu</Button>
          </div>
        </form>
      </div>
    );
  }

  // ======================= Lịch sử cảm biến (SQLite) =======================
  const HISTORY_RANGES = [{ value: 60, label: '1 giờ' }, { value: 1440, label: '24 giờ' }, { value: 10080, label: '7 ngày' }, { value: 43200, label: '30 ngày' }];

  function timeText(ms, withDate) {
    const d = new Date(ms), hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return withDate ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${hm}` : hm;
  }

  function HistoryPanel() {
    const [minutes, setMinutes] = useState(1440);
    const [points, setPoints] = useState(null);
    const [error, setError] = useState('');
    const [hover, setHover] = useState(null);
    const [W, setW] = useState(760);
    const wrap = useRef(null);

    useEffect(() => {
      let alive = true;
      const load = () => api(`/api/history?minutes=${minutes}`)
        .then(r => { if (alive) { setPoints(r.points); setError(''); } })
        .catch(e => { if (alive) setError(e.message); });
      setHover(null);
      load();
      const t = setInterval(load, 60000);
      return () => { alive = false; clearInterval(t); };
    }, [minutes]);
    useEffect(() => {
      const ro = new ResizeObserver(es => setW(Math.max(280, Math.round(es[0].contentRect.width))));
      ro.observe(wrap.current);
      return () => ro.disconnect();
    }, []);

    const pts = points || [], H = 260, P = { l: 40, r: 38, t: 12, b: 48 }, plotB = H - P.b;
    const t1 = Date.now(), t0 = t1 - minutes * 60000;
    const temps = pts.map(p => p[1]).filter(v => v != null);
    const lo = temps.length ? Math.floor(Math.min(...temps) - 1) : 20, hi = temps.length ? Math.ceil(Math.max(...temps) + 1) : 40;
    const x = t => P.l + ((t - t0) / (t1 - t0)) * (W - P.l - P.r);
    const y = v => P.t + ((hi - v) / (hi - lo)) * (plotB - P.t);
    const yh = v => P.t + ((100 - v) / 100) * (plotB - P.t);
    const gap = Math.max(120000, (minutes * 60000) / 300);    // không nối qua khoảng mất dữ liệu
    const line = (i, f) => pts.map((p, n) => `${n && p[0] - pts[n - 1][0] <= gap ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${f(p[i]).toFixed(1)}`).join('');
    const lanes = [[3, 'Bơm', '#0284c7'], [4, 'Quạt', '#7c3aed']];
    const withDate = minutes > 1440;
    const tickCount = W < 560 ? 4 : 7;
    const ticks = Array.from({ length: tickCount }, (_, i) => t0 + ((t1 - t0) * i) / (tickCount - 1));
    const onMove = e => {
      if (!pts.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = t0 + (((e.clientX - r.left) * (W / r.width) - P.l) / (W - P.l - P.r)) * (t1 - t0);
      setHover(pts.reduce((best, p, i) => (Math.abs(p[0] - t) < Math.abs(pts[best][0] - t) ? i : best), 0));
    };
    const hp = hover != null && pts[hover];
    const avg = temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null;
    const stats = [['Số mẫu', pts.length], ['Thấp nhất', temps.length ? `${fmt1(Math.min(...temps))} °C` : '—'],
      ['Cao nhất', temps.length ? `${fmt1(Math.max(...temps))} °C` : '—'], ['Trung bình', avg == null ? '—' : `${fmt1(avg)} °C`]];

    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Segmented size="sm" value={minutes} onChange={setMinutes} label="Khoảng thời gian lịch sử" options={HISTORY_RANGES} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" icon="Download" href="/api/history.csv?hours=24" download>CSV 24 giờ</Button>
            <Button size="sm" variant="ghost" icon="Download" href="/api/history.csv?hours=168" download>CSV 7 ngày</Button>
          </div>
        </div>
        <div ref={wrap} className="relative mt-4" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full select-none" style={{ height: H }} onMouseMove={onMove} role="img" aria-label="Biểu đồ lịch sử nhiệt độ và độ ẩm">
            {[0, 0.25, 0.5, 0.75, 1].map(f => {
              const v = lo + (hi - lo) * f;
              return (
                <g key={f}>
                  <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#e4e4e7" strokeDasharray="2 4" />
                  <text x={P.l - 8} y={y(v) + 3.5} textAnchor="end" className="fill-zinc-500 font-mono" fontSize="10">{v.toFixed(0)}°</text>
                  <text x={W - P.r + 6} y={yh(f * 100) + 3.5} className="fill-zinc-400 font-mono" fontSize="10">{f * 100}%</text>
                </g>
              );
            })}
            {ticks.map((t, i) => (
              <text key={i} x={x(t)} y={plotB + 14} textAnchor={i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'} className="fill-zinc-500 font-mono" fontSize="10">{timeText(t, withDate)}</text>
            ))}
            <path d={line(2, yh)} fill="none" stroke="#71717a" strokeOpacity=".7" strokeWidth="1.25" strokeDasharray="4 3" />
            <path d={line(1, y)} fill="none" stroke="#059669" strokeWidth="2" strokeLinejoin="round" />
            {lanes.map(([k, label, color], li) => (
              <g key={k}>
                <text x={P.l - 8} y={plotB + 27 + li * 11} textAnchor="end" className="fill-zinc-500 font-mono" fontSize="9">{label}</text>
                <rect x={P.l} y={plotB + 22 + li * 11} width={W - P.l - P.r} height="6" rx="3" fill="#f4f4f5" />
                {pts.map((p, n) => p[k] ? <rect key={n} x={x(p[0])} y={plotB + 22 + li * 11} height="6" fill={color} fillOpacity=".75"
                  width={Math.max(1.5, pts[n + 1] && pts[n + 1][0] - p[0] <= gap ? x(pts[n + 1][0]) - x(p[0]) : 1.5)} /> : null)}
              </g>
            ))}
            {hp && <line x1={x(hp[0])} x2={x(hp[0])} y1={P.t} y2={plotB} stroke="#a1a1aa" />}
          </svg>
          {hp && (
            <div className="pointer-events-none absolute top-2 z-10 w-44 rounded-lg border border-zinc-200 bg-white/95 p-2.5 font-mono text-[11px] shadow-xl shadow-zinc-900/10"
              style={{ left: `clamp(0px, calc(${(x(hp[0]) / W) * 100}% + 12px), calc(100% - 11rem))` }}>
              <div className="text-zinc-500">{timeText(hp[0], true)}</div>
              <div className="mt-1 flex justify-between"><span>T</span><span className="text-emerald-700">{fmt1(hp[1])} °C</span></div>
              <div className="flex justify-between"><span>RH</span><span>{fmt1(hp[2])} %</span></div>
              <div className="flex justify-between"><span>Bơm / Quạt</span><span>{hp[3] ? 'BẬT' : 'TẮT'} / {hp[4] ? 'BẬT' : 'TẮT'}</span></div>
            </div>
          )}
          {!pts.length && <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">{error || (points ? 'Chưa có dữ liệu trong khoảng này.' : 'Đang tải…')}</div>}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {stats.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-zinc-200/70 bg-zinc-50/40 px-3 py-2">
              <dt className="text-[11px] text-zinc-500">{k}</dt><dd className="mt-0.5 font-mono text-sm text-zinc-900">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  // ======================= Quản trị =======================
  function SignupsCard({ signups, reload, push }) {
    const [roles, setRoles] = useState({});
    const act = async (s, action) => {
      try {
        const r = await api('/api/signups', { id: s.id, action, role: roles[s.id] || 'viewer' });
        push('Yêu cầu tài khoản', r.message, 'ok');
      } catch (e) { push('Không thực hiện được', e.message, 'err'); }
      reload();
    };
    return (
      <Card className="p-5 sm:p-6">
        <CardHeader icon="UserPlus" kicker={`${signups.length} yêu cầu đang chờ`} title="Yêu cầu cấp tài khoản" />
        <ul className="mt-4 space-y-2">
          {!signups.length && <li className="rounded-xl border border-dashed border-zinc-200 p-4 text-center text-xs text-zinc-500">Không có yêu cầu nào.</li>}
          {signups.map(s => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-200/70 bg-zinc-50/40 p-3">
              <div className="min-w-[120px] flex-1">
                <div className="truncate text-[13px] font-medium text-zinc-900">{s.name}</div>
                <div className="truncate font-mono text-[10.5px] text-zinc-500">{s.created} · {s.ip}</div>
              </div>
              <RoleSelect label={`Vai trò cho ${s.name}`} value={roles[s.id] || 'viewer'} onChange={v => setRoles(r => ({ ...r, [s.id]: v }))} />
              <Button size="sm" variant="primary" icon="Check" onClick={() => act(s, 'approve')}>Duyệt</Button>
              <Button size="sm" variant="danger" icon="X" onClick={() => act(s, 'reject')}>Từ chối</Button>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  function UsersCard({ me, minLen, push, version }) {
    const [users, setUsers] = useState([]);
    const [form, setForm] = useState({ name: '', password: '', role: 'viewer' });
    const [resetting, setResetting] = useState(null);
    const [newPw, setNewPw] = useState('');
    const reload = useCallback(() => api('/api/users').then(r => setUsers(r.users)).catch(e => push('Không tải được tài khoản', e.message, 'err')), [push]);
    useEffect(() => { reload(); }, [reload, version]);     // version tăng khi vừa duyệt một yêu cầu
    const act = async body => {
      try {
        const r = await api('/api/users', body);
        push('Tài khoản', r.message, 'ok');
        await reload();
        return true;
      } catch (e) { push('Không thực hiện được', e.message, 'err'); await reload(); return false; }
    };
    const add = async e => {
      e.preventDefault();
      if (await act({ action: 'add', ...form })) setForm({ name: '', password: '', role: 'viewer' });
    };
    const savePw = async (e, name) => {
      e.preventDefault();
      if (await act({ action: 'password', name, password: newPw })) { setResetting(null); setNewPw(''); }
    };
    return (
      <Card className="p-5 sm:p-6">
        <CardHeader icon="Users" kicker={`${users.length} tài khoản`} title="Quản lý tài khoản" />
        <ul className="mt-4 space-y-2">
          {users.map(u => (
            <li key={u.name} className="rounded-xl border border-zinc-200/70 bg-zinc-50/40 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-[110px] flex-1">
                  <div className="truncate text-[13px] font-medium text-zinc-900">{u.name}{me && u.name === me.user && <span className="ml-1.5 text-[11px] font-normal text-emerald-700">(bạn)</span>}</div>
                  <div className="truncate font-mono text-[10.5px] text-zinc-500">{u.created || '—'}</div>
                </div>
                <RoleSelect label={`Vai trò của ${u.name}`} value={u.role} onChange={role => act({ action: 'role', name: u.name, role })} />
                <Button size="sm" variant="ghost" className="w-8 !px-0" aria-label={`Đặt lại mật khẩu của ${u.name}`} title="Đặt lại mật khẩu"
                  onClick={() => { setResetting(resetting === u.name ? null : u.name); setNewPw(''); }}><Icon name="KeyRound" size={14} /></Button>
                <Button size="sm" variant="danger" className="w-8 !px-0" aria-label={`Xóa tài khoản ${u.name}`} title="Xóa tài khoản" disabled={me && u.name === me.user}
                  onClick={() => { if (window.confirm(`Xóa tài khoản ${u.name}?`)) act({ action: 'delete', name: u.name }); }}><Icon name="Trash2" size={14} /></Button>
              </div>
              {resetting === u.name && (
                <form className="mt-2 flex gap-2" onSubmit={e => savePw(e, u.name)}>
                  <input type="password" autoFocus required minLength={minLen} autoComplete="new-password" aria-label={`Mật khẩu mới của ${u.name}`}
                    placeholder={`Mật khẩu mới (từ ${minLen} ký tự)`} className={cx(INPUT, 'font-sans')} value={newPw} onChange={e => setNewPw(e.target.value)} />
                  <Button variant="primary" type="submit">Lưu</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
        <form onSubmit={add} className="mt-4 grid gap-2 border-t border-zinc-200/60 pt-4 sm:grid-cols-2">
          <Field label="Tên đăng nhập" htmlFor="nu-name"><input id="nu-name" required maxLength={32} autoComplete="off" className={INPUT} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></Field>
          <Field label={`Mật khẩu (từ ${minLen} ký tự)`} htmlFor="nu-pw"><input id="nu-pw" type="password" required minLength={minLen} autoComplete="new-password" className={INPUT} value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></Field>
          <div className="flex items-center justify-between gap-2 sm:col-span-2">
            <RoleSelect label="Vai trò tài khoản mới" value={form.role} onChange={role => setForm(f => ({ ...f, role }))} />
            <Button variant="primary" icon="UserPlus" type="submit">Thêm tài khoản</Button>
          </div>
        </form>
      </Card>
    );
  }

  function EventsCard({ push }) {
    const [events, setEvents] = useState([]);
    const reload = useCallback(() => api('/api/events?limit=100').then(r => setEvents(r.events)).catch(e => push('Không tải được nhật ký', e.message, 'err')), [push]);
    useEffect(() => { reload(); }, [reload]);
    return (
      <Card className="p-5 sm:p-6 lg:col-span-2">
        <CardHeader icon="ScrollText" kicker="100 sự kiện gần nhất" title="Nhật ký hoạt động"
          right={<Button size="sm" variant="ghost" icon="RefreshCw" onClick={reload}>Tải lại</Button>} />
        <ol className="scroll-thin mt-4 h-[340px] divide-y divide-zinc-200/60 overflow-y-auto rounded-xl border border-zinc-200/80 bg-[#fafafa]">
          {!events.length && <li className="p-6 text-center text-xs text-zinc-500">Chưa có sự kiện.</li>}
          {events.map((e, i) => (
            <li key={i} className="grid gap-x-3 gap-y-0.5 px-3 py-2 text-xs sm:grid-cols-[150px_110px_1fr]">
              <time className="font-mono text-[11px] text-zinc-500">{e.t}</time>
              <span className="truncate font-medium text-zinc-800">{e.user}</span>
              <span className="min-w-0">
                <span className={cx('mr-1.5 inline-block h-1.5 w-1.5 -translate-y-px rounded-full', e.ok ? 'bg-emerald-600' : 'bg-red-500')} />
                <span className="text-zinc-800">{e.action}</span>
                {e.detail && <span className="ml-1.5 break-all font-mono text-[10.5px] text-zinc-500">{e.detail}</span>}
                {e.ip && <span className="ml-1.5 font-mono text-[10.5px] text-zinc-400">{e.ip}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Card>
    );
  }

  function AdminPanel({ me, minLen, push }) {
    const [signups, setSignups] = useState([]);
    const [version, setVersion] = useState(0);
    const reload = useCallback(() => api('/api/signups').then(r => setSignups(r.signups)).catch(() => {}), []);
    useEffect(() => {
      reload();
      const t = setInterval(reload, 30000);
      return () => clearInterval(t);
    }, [reload]);
    return (
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <UsersCard me={me} minLen={minLen} push={push} version={version} />
        <SignupsCard signups={signups} reload={() => { reload(); setVersion(v => v + 1); }} push={push} />
        <EventsCard push={push} />
      </div>
    );
  }

  GH.admin = { AccountBar, PasswordDialog, HistoryPanel, AdminPanel };
})();
