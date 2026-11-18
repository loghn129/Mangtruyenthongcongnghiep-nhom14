/* Nhà kính thông minh — ứng dụng chính: trạng thái, gọi API, bố cục trang, phím tắt. */
(() => {
  const { useState, useEffect, useRef, useCallback } = React;
  const { cx, Icon, Card, SectionHeader, Button, StatusDot, Kbd, useToasts, Toasts } = GH.ui;
  const { api, fmt1 } = GH.lib;
  const { AccountBar, PasswordDialog, HistoryPanel, AdminPanel } = GH.admin;
  const { DEV, DEVICES, DeviceIcon, TelemetryPanel, SparklinePanel, ConnectivityPanel, ConnectionCard,
    DeviceCard, TopologyPanel, TrendChart, ModbusLog, MaintenanceCard, GreenhousePanel } = GH.panels;

  const MAX_LOG = 500;
  const POLL_MS = 600;
  const TOAST_TITLE = { ok: 'Vận hành', warn: 'Cảnh báo an toàn', err: 'Lỗi truyền thông' };
  const sameRule = (a, b) => a && b && a.use === b.use && a.dir === b.dir && a.on === b.on && a.off === b.off;

  /** Thêm góc nhìn theo thiết bị lên trạng thái gốc của final_web.py (chế độ Tự động / Bằng tay dùng chung). */
  function normalize(d) {
    const ac = d.auto_cfg;
    const dev = (key, rules) => ({ on: d[key], auto: d.auto, off_at: d[key + '_off_at'], rules });
    d.devices = {
      pump: dev('pump', { t: { use: ac.pump.t.use, dir: 'high', on: d.t_on, off: d.t_off }, h: ac.pump.h }),
      fan: dev('fan', { t: ac.fan.t, h: ac.fan.h }),
    };
    d.config = { ...d.config, pump_id: d.config.relay_id, fan_id: d.config.relay_id, pump_channel: d.config.channel };
    return d;
  }
  /** Kiểm tra giống parse_rule() bên Python để báo lỗi ngay trên giao diện. */
  function ruleError(r, label) {
    if (r.dir === 'high' && !(r.off < r.on)) return `${label}: bật khi ≥ thì ngưỡng TẮT phải nhỏ hơn ngưỡng BẬT.`;
    if (r.dir === 'low' && !(r.on < r.off)) return `${label}: bật khi ≤ thì ngưỡng BẬT phải nhỏ hơn ngưỡng TẮT.`;
    return null;
  }

  // ======================= Trạng thái từ chương trình Python =======================
  function useGreenhouse(push) {
    const [s, setS] = useState(null);
    const [meta, setMeta] = useState(null);
    const [entries, setEntries] = useState([]);
    const [offline, setOffline] = useState(false);
    const [skew, setSkew] = useState(0);          // đồng hồ máy chủ − đồng hồ trình duyệt (giây)
    const seq = useRef(0);
    const first = useRef(true);

    const refresh = useCallback(async () => {
      const data = await api(`/api/state?since=${seq.current}`);
      setOffline(false);
      if (data.log_seq < seq.current) {             // chương trình Python vừa khởi động lại
        seq.current = 0;
        setEntries([]);
      }
      // Vòng poll và refresh() sau mỗi thao tác có thể chạy song song với cùng "since": chỉ nhận dòng chưa thấy
      const fresh = data.logs.filter(e => e.id > seq.current);
      seq.current = Math.max(seq.current, data.log_seq);
      if (fresh.length) {
        setEntries(prev => prev.concat(fresh).slice(-MAX_LOG));
        if (!first.current) {
          fresh.forEach(e => {
            if (!('hex' in e) && TOAST_TITLE[e.level]) push(TOAST_TITLE[e.level], e.text, e.level);
          });
        }
      }
      first.current = false;
      setSkew(data.now - Date.now() / 1000);
      setS(normalize(data));
      return data;
    }, [push]);

    useEffect(() => {
      let alive = true, timer = 0, hasMeta = false;
      const loop = async () => {
        try {
          await refresh();
          if (!hasMeta) { setMeta(await api('/api/info')); hasMeta = true; }
        } catch (e) {
          if (alive) setOffline(true);
        } finally {
          if (alive) timer = setTimeout(loop, POLL_MS);
        }
      };
      loop();
      return () => { alive = false; clearTimeout(timer); };
    }, [refresh]);

    return { s, setS, meta, entries, setEntries, offline, skew, refresh };
  }

  // ======================= Thanh điều hướng =======================
  const LINKS = [['#tong-quan', 'Tổng quan'], ['#dieu-khien', 'Điều khiển', 'operator'], ['#xu-huong', 'Xu hướng'], ['#nhat-ky', 'Nhật ký'],
    ['#lich-su', 'Lịch sử'], ['#quan-tri', 'Quản trị', 'admin']];
  const RANK = { viewer: 1, operator: 2, admin: 3 };
  const hasRole = (me, need) => !!me && RANK[me.role] >= RANK[need];

  function systemStatus(s, offline) {
    if (offline) return { tone: 'err', label: 'Offline', color: 'text-red-700' };
    if (!s) return { tone: 'idle', label: 'Connecting', color: 'text-zinc-600' };
    if (!s.connected) return { tone: 'idle', label: 'Standby', color: 'text-zinc-700' };
    return s.status === 'ok'
      ? { tone: 'ok', label: 'System Operational', color: 'text-emerald-700' }
      : { tone: 'warn', label: 'Degraded', color: 'text-amber-700' };
  }

  function Nav({ s, offline, me, onPassword, onLogout }) {
    const st = systemStatus(s, offline);
    return (
      <header className="sticky top-0 z-40 border-b border-zinc-200/60 bg-[#ffffff]/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
          <a href="#top" className="flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50">
            <span className="grid h-7 w-7 place-items-center rounded-lg border border-emerald-600/30 bg-emerald-600/10 text-emerald-700 shadow-[0_0_16px_-4px_rgba(16,185,129,0.36)]">
              <Icon name="Sprout" size={15} />
            </span>
            <span className="text-sm font-semibold tracking-tight text-zinc-900">Nhà kính thông minh</span>
          </a>
          <nav className="hidden items-center gap-0.5 xl:flex" aria-label="Mục chính">
            {LINKS.filter(l => !l[2] || hasRole(me, l[2])).map(([href, label]) => (
              <a key={href} href={href} className="rounded-md px-3 py-1.5 text-[13px] text-zinc-600 transition hover:bg-zinc-200/50 hover:text-zinc-900">{label}</a>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-2 whitespace-nowrap rounded-full border border-zinc-200 bg-zinc-50/60 px-3 py-1 font-mono text-[11px] text-zinc-600 md:inline-flex">
              <StatusDot tone={st.tone} pulse={st.tone === 'ok'} />
              {s && s.connected ? s.link : st.label.toUpperCase()}
            </span>
            <AccountBar me={me} onPassword={onPassword} onLogout={onLogout} />
          </div>
        </div>
      </header>
    );
  }

  // ======================= Hero =======================
  function Hero({ s, offline, meta, me }) {
    const st = systemStatus(s, offline);
    const quick = [
      ['Thermometer', 'T', s && s.temperature != null ? `${fmt1(s.temperature)}°C` : '—'],
      ['Droplet', 'RH', s && s.humidity != null ? `${fmt1(s.humidity)}%` : '—'],
      ...DEVICES.map(dev => [DEV[dev].icon, DEV[dev].short, s && s.devices[dev].on != null ? (s.devices[dev].on ? 'ON' : 'OFF') : '—', dev]),
    ];
    return (
      <section id="top" className="relative pb-4 pt-16 text-center sm:pt-24">
        <a href="#tong-quan"
          className="fade-up inline-flex max-w-full items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50/70 py-1 pl-2.5 pr-3 font-mono text-[11px] text-zinc-600 backdrop-blur transition hover:border-emerald-600/30 sm:text-[11.5px]">
          <StatusDot tone={st.tone} pulse={st.tone === 'ok'} />
          <span className="truncate">Nhà kính thông minh v{(meta && meta.version) || '1.0'}</span>
          <span className="text-zinc-300">•</span>
          <span className={cx('truncate', st.color)}>{st.label}</span>
        </a>

        <h1 className="fade-up mx-auto mt-7 max-w-4xl text-[31px] font-semibold leading-[1.04] tracking-[-0.04em] sm:text-6xl lg:text-7xl" style={{ animationDelay: '80ms' }}>
          <span className="bg-gradient-to-b from-zinc-950 via-zinc-800 to-zinc-500 bg-clip-text text-transparent">Nhà kính thông minh</span>
          <br />
          <span className="bg-gradient-to-r from-emerald-800 via-emerald-600 to-teal-700 bg-clip-text text-transparent">trên bus Modbus RTU</span>
        </h1>

        <p className="fade-up mx-auto mt-6 max-w-2xl text-[15px] leading-7 text-zinc-600 sm:text-base" style={{ animationDelay: '160ms' }}>
          Đọc cảm biến SRD-THT-12R, đóng cắt bơm 12V và quạt thông gió qua relay RS-485 — máy tính làm Modbus Master.{' '}
          <br className="hidden sm:block" />
          Luật trễ hai ngưỡng theo nhiệt độ và độ ẩm, phân quyền tài khoản, lưu lịch sử cảm biến.
        </p>

        <div className="fade-up mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center" style={{ animationDelay: '240ms' }}>
          <Button href={hasRole(me, 'operator') ? '#dieu-khien' : '#xu-huong'} variant="primary" size="lg" iconRight="ArrowRight">{hasRole(me, 'operator') ? 'Mở bảng điều khiển' : 'Xem xu hướng'}</Button>
          <Button href="#lich-su" variant="ghost" size="lg" icon="History">Lịch sử cảm biến</Button>
        </div>

        <div className="fade-up mx-auto mt-12 grid max-w-2xl grid-cols-2 gap-2 sm:grid-cols-4" style={{ animationDelay: '320ms' }}>
          {quick.map(([icon, label, value, dev]) => (
            <div key={label} className="flex items-center justify-between gap-2 rounded-xl border border-zinc-200/70 bg-[#ffffff]/70 px-3 py-2.5 backdrop-blur">
              <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                {dev ? <DeviceIcon dev={dev} on={s && s.devices[dev].on} size={13} className={DEV[dev].text} /> : <Icon name={icon} size={13} />}
                {label}
              </span>
              <span className={cx('font-mono text-sm tabular-nums', value === 'ON' ? 'text-emerald-700' : 'text-zinc-900')}>{value}</span>
            </div>
          ))}
        </div>
      </section>
    );
  }

  function Skeleton({ className }) {
    return <div className={cx('shimmer rounded-2xl opacity-40', className)} />;
  }

  function Footer({ meta, me }) {
    return (
      <footer className="relative mt-8 border-t border-zinc-200/60">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-xs text-zinc-500 sm:px-6 md:flex-row md:items-center md:justify-between">
          <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-2', !hasRole(me, 'operator') && 'invisible')}>
            <span className="inline-flex items-center gap-1.5 text-zinc-600"><Icon name="Keyboard" size={14} />Phím tắt</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>A</Kbd>Tự động</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>M</Kbd>Bằng tay</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>Space</Kbd>Bơm</span>
            <span className="inline-flex items-center gap-1.5"><Kbd>F</Kbd>Quạt</span>
          </div>
          <p className="font-mono text-[11px]">Mạng truyền thông công nghiệp · Modbus RTU qua USB-RS485 · v{(meta && meta.version) || '1.0'}</p>
        </div>
      </footer>
    );
  }

  // ======================= Ứng dụng =======================
  const RULE_LABEL = { t: 'nhiệt độ', h: 'độ ẩm' };

  function App() {
    const [toasts, push, dismiss] = useToasts();
    const { s, setS, meta, entries, setEntries, offline, skew, refresh } = useGreenhouse(push);
    const [form, setForm] = useState(null);
    const [ports, setPorts] = useState([]);
    const [busy, setBusy] = useState(false);
    const [maintBusy, setMaintBusy] = useState(false);
    const [me, setMe] = useState(null);
    const [pwOpen, setPwOpen] = useState(false);
    const [pending, setPending] = useState({});
    const [drafts, setDrafts] = useState({});          // { pump: { t: rule, h: rule }, fan: {...} } đang chỉnh, chưa xác nhận
    const [ruleErr, setRuleErr] = useState({});
    const [intervalDraft, setIntervalDraft] = useState(null);
    const timers = useRef({});
    const latest = useRef(null);
    const draftsRef = useRef({});
    latest.current = s;
    draftsRef.current = drafts;

    const loadPorts = useCallback(async announce => {
      try {
        const { ports: list } = await api('/api/ports');
        setPorts(list);
        setForm(f => {
          if (!f || list.some(p => p.device === f.port)) return f;
          const pick = list.find(p => !/bluetooth/i.test(p.description)) || list[0];   // bộ USB-RS485 không phải cổng Bluetooth
          return pick ? { ...f, port: pick.device } : f;
        });
        if (announce) push('Danh sách cổng COM', list.length ? `Tìm thấy ${list.length} cổng.` : 'Chưa thấy cổng nào — kiểm tra cáp và driver CH340 / CP210x.', 'info');
      } catch (e) {
        push('Không đọc được cổng COM', e.message, 'err');
      }
    }, [push]);

    // Lần đầu: điền form theo cấu hình máy chủ. Khi đang kết nối: form bám theo cấu hình thật (đổi ID / baud trên web)
    useEffect(() => {
      if (!s) return;
      if (!form) { setForm({ ...s.config }); loadPorts(false); }
      else if (s.connected) {
        const c = s.config;
        if (['port', 'baud', 'sht20_id', 'relay_id', 'channel', 'fan_channel', 'relay_mode'].some(k => form[k] !== c[k])) setForm({ ...c });
      }
    }, [s, form, loadPorts]);

    // Bỏ bản nháp khi máy chủ đã nhận đúng giá trị
    useEffect(() => {
      if (!s) return;
      setDrafts(dr => {
        let changed = false;
        const next = {};
        for (const dev of Object.keys(dr)) {
          for (const k of Object.keys(dr[dev])) {
            const keep = timers.current[dev + k] || ruleErr[dev] || !sameRule(dr[dev][k], s.devices[dev].rules[k]);
            if (keep) (next[dev] = next[dev] || {})[k] = dr[dev][k]; else changed = true;
          }
        }
        return changed ? next : dr;
      });
      if (intervalDraft != null && !timers.current.interval && s.interval === intervalDraft) setIntervalDraft(null);
    }, [s, ruleErr, intervalDraft]);

    useEffect(() => { api('/api/me').then(setMe).catch(() => {}); }, []);
    const canOp = hasRole(me, 'operator'), isAdmin = hasRole(me, 'admin');
    const closePw = useCallback(() => setPwOpen(false), []);
    const logout = async () => {
      try { await api('/api/logout', {}); } catch (e) { /* vẫn quay về trang đăng nhập */ }
      location.href = '/login';
    };

    const after = () => refresh().catch(() => {});
    const currentInterval = () => (intervalDraft != null ? intervalDraft : latest.current.interval);

    const onConnect = async () => {
      if (!s || busy) return;
      setBusy(true);
      try {
        if (s.connected) {
          await api('/api/disconnect', {});
          push('Đã ngắt kết nối', 'Bơm và quạt đã được gửi lệnh tắt trước khi đóng cổng.', 'info');
        } else {
          const r = await api('/api/connect', {
            ...form, link: 'COM', t_on: s.t_on, t_off: s.t_off, interval: currentInterval(), auto_cfg: s.auto_cfg,
          });
          push('Đã kết nối', `${r.message} — bắt đầu đọc SRD-THT-12R.`, 'ok');
        }
      } catch (e) {
        push('Không thực hiện được', e.message, 'err');
      } finally {
        setBusy(false);
        after();
      }
    };

    // Chế độ Tự động / Bằng tay dùng chung cho bơm và quạt (giống final_web.py)
    const setMode = async auto => {
      const cur = latest.current;
      if (cur) setS({ ...cur, auto, devices: { pump: { ...cur.devices.pump, auto }, fan: { ...cur.devices.fan, auto } } });
      try { await api('/api/mode', { auto }); }
      catch (e) { push('Không đổi được chế độ', e.message, 'err'); }
      after();
    };

    const onToggle = async (dev, want) => {
      const cur = latest.current;
      if (!cur || !cur.connected) { push('Chưa kết nối', 'Hãy kết nối bus RS-485 ở mục Điều khiển trước.', 'warn'); return; }
      if (cur.auto) { push('Đang ở chế độ Tự động', 'Chọn “Bằng tay” (phím M) để bật / tắt trực tiếp.', 'warn'); return; }
      setPending(p => ({ ...p, [dev]: want }));
      try { await api(`/api/${dev}`, { on: want }); }
      catch (e) { push(`Không điều khiển được ${DEV[dev].short.toLowerCase()}`, e.message, 'err'); }
      finally {
        setPending(p => { const n = { ...p }; delete n[dev]; return n; });
        after();
      }
    };
    const toggleByKey = dev => {
      const cur = latest.current;
      if (!cur) return;
      const on = pending[dev] != null ? pending[dev] : cur.devices[dev].on;
      onToggle(dev, on !== true);
    };

    /** Gửi luật đã chỉnh: ngưỡng nhiệt độ của bơm qua /api/settings (t_on / t_off), còn lại qua /api/autocfg. */
    const sendRule = async (dev, k, rule) => {
      const cur = latest.current;
      if (dev === 'pump' && k === 't' && (rule.on !== cur.t_on || rule.off !== cur.t_off)) {
        await api('/api/settings', { t_on: rule.on, t_off: rule.off, interval: currentInterval() });
      }
      const cfg = JSON.parse(JSON.stringify(cur.auto_cfg));
      const dr = draftsRef.current;
      for (const d of DEVICES) for (const key of ['t', 'h']) {
        const r = (dr[d] && dr[d][key]) || (d === dev && key === k ? rule : null);
        if (!r) continue;
        cfg[d][key] = d === 'pump' && key === 't' ? { use: r.use } : { use: r.use, dir: r.dir, on: r.on, off: r.off };
      }
      await api('/api/autocfg', cfg);
    };

    const onRule = (dev, k, rule) => {
      setDrafts(d => ({ ...d, [dev]: { ...(d[dev] || {}), [k]: rule } }));
      const key = dev + k;
      clearTimeout(timers.current[key]);
      timers.current[key] = null;
      const err = ruleError(rule, `${DEV[dev].short} · ${RULE_LABEL[k]}`);
      setRuleErr(e => ({ ...e, [dev]: err }));
      if (err) return;
      timers.current[key] = setTimeout(async () => {
        try { await sendRule(dev, k, rule); }
        catch (e) { setRuleErr(er => ({ ...er, [dev]: e.message })); }
        timers.current[key] = null;
        after();
      }, 450);
    };

    const onInterval = v => {
      setIntervalDraft(v);
      clearTimeout(timers.current.interval);
      timers.current.interval = setTimeout(async () => {
        const cur = latest.current;
        try { await api('/api/settings', { t_on: cur.t_on, t_off: cur.t_off, interval: v }); }
        catch (e) { push('Chu kỳ đọc không hợp lệ', e.message, 'err'); }
        timers.current.interval = null;
        after();
      }, 400);
    };

    // Đổi ID / baudrate: thao tác ghi cấu hình vào thiết bị -> hỏi xác nhận trước
    const maintenance = async (question, path, body) => {
      if (!window.confirm(question)) return;
      setMaintBusy(true);
      try {
        await api(path, body);      // kết quả chi tiết đã có trong nhật ký -> hiện thành thông báo ở lần poll kế tiếp
      } catch (e) {
        push('Không thực hiện được', e.message, 'err');
      } finally {
        setMaintBusy(false);
        after();
      }
    };
    const onChangeId = (device, newId) => maintenance(
      `Ghi ID mới ${newId} vào ${device === 'sht20' ? 'cảm biến SRD-THT-12R' : 'module relay'}?\nThiết bị sẽ chỉ trả lời ở ID mới.`,
      '/api/change_id', { device, new_id: newId });

    // Phím tắt: A / M chế độ, Space bơm, F quạt
    useEffect(() => {
      const onKey = e => {
        if (!canOp || pwOpen) return;
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        const t = e.target, tag = (t.tagName || '').toLowerCase();
        if (['input', 'select', 'textarea'].includes(tag) || t.isContentEditable) return;
        if (e.code === 'Space' && tag === 'button') return;     // để nút đang được chọn bằng Tab hoạt động như thường
        const k = e.key.toLowerCase();
        if (k === 'a') setMode(true);
        else if (k === 'm') setMode(false);
        else if (e.code === 'Space') { e.preventDefault(); toggleByKey('pump'); }
        else if (k === 'f') toggleByKey('fan');
      };
      // Bỏ focus sau khi bấm chuột để phím Space luôn điều khiển bơm
      const onClick = e => { const b = e.target.closest && e.target.closest('button'); if (b && e.detail > 0) b.blur(); };
      window.addEventListener('keydown', onKey);
      document.addEventListener('click', onClick);
      return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
    });

    return (
      <div className="relative z-[1] min-h-screen overflow-x-clip">
        <div className="bg-glow" aria-hidden="true" />
        <Nav s={s} offline={offline} me={me} onPassword={() => setPwOpen(true)} onLogout={logout} />
        {offline && (
          <div role="alert" className="sticky top-14 z-30 border-b border-red-500/20 bg-red-50 px-4 py-2 text-center text-xs text-red-800 backdrop-blur">
            <Icon name="ServerCrash" size={14} className="mr-1.5 inline -translate-y-px" />
            Mất liên lạc với chương trình Python — đang thử lại…
          </div>
        )}

        <main className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <Hero s={s} offline={offline} meta={meta} me={me} />

          <section className="py-16 sm:py-20" id="tong-quan" aria-labelledby="h-tong-quan">
            <SectionHeader id="h-tong-quan" index="01" eyebrow="Tổng quan" title="Tín hiệu sống từ nhà kính"
              desc="Số đo cảm biến, lưu lượng khung Modbus và trạng thái relay — cập nhật mỗi chu kỳ đọc." />
            <div className="grid gap-4 md:grid-cols-3">
              <TelemetryPanel s={s} offline={offline} skew={skew} />
              <SparklinePanel history={s ? s.history : []} />
              <ConnectivityPanel s={s} />
            </div>
            <GreenhousePanel s={s} pending={pending} onToggle={onToggle} readOnly={!canOp} />
          </section>

          {canOp && <section className="pb-16 sm:pb-20" id="dieu-khien" aria-labelledby="h-dieu-khien">
            <SectionHeader id="h-dieu-khien" index="02" eyebrow="Điều khiển" title="Bơm & quạt thông gió"
              desc="Tự động: mỗi thiết bị bật khi một luật nhiệt độ / độ ẩm đạt ngưỡng, tắt khi mọi luật về vùng tắt. Bằng tay: bơm tự tắt sau thời gian tối đa."
              right={(
                <div className="flex gap-2">
                  <Button size="sm" variant={s && s.auto ? 'primary' : 'ghost'} icon="Bot" disabled={!s} onClick={() => setMode(true)}>Tự động</Button>
                  <Button size="sm" variant={s && !s.auto ? 'primary' : 'ghost'} icon="Hand" disabled={!s} onClick={() => setMode(false)}>Bằng tay</Button>
                </div>
              )} />
            {s && form ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <ConnectionCard s={s} meta={meta} form={form} setForm={setForm} ports={ports} busy={busy}
                  onRefreshPorts={() => loadPorts(true)} onConnect={onConnect}
                  interval={intervalDraft != null ? intervalDraft : s.interval} onInterval={onInterval} />
                {DEVICES.map(dev => (
                  <DeviceCard key={dev} dev={dev} s={s} meta={meta} skew={skew} pending={pending[dev]} drafts={drafts[dev]}
                    error={ruleErr[dev]} onMode={setMode} onToggle={onToggle} onRule={onRule} />
                ))}
                <TopologyPanel s={s} pending={pending} onToggle={onToggle} />
                {isAdmin && <MaintenanceCard s={s} meta={meta} busy={maintBusy} onChangeId={onChangeId} />}
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                <Skeleton className="h-[560px] lg:row-span-2" /><Skeleton className="h-[420px]" /><Skeleton className="h-[420px]" /><Skeleton className="h-[260px] lg:col-span-2" />
              </div>
            )}
          </section>}

          <section className="pb-16 sm:pb-20" id="xu-huong" aria-labelledby="h-xu-huong">
            <SectionHeader id="h-xu-huong" index="03" eyebrow="Xu hướng" title="Nhiệt độ, độ ẩm và chu kỳ chạy"
              desc="Rê chuột để xem từng mẫu. Dải màu bên dưới là thời gian bơm và quạt hoạt động." />
            {s ? <TrendChart s={s} /> : <Skeleton className="h-[420px]" />}
          </section>

          <section className="pb-16" id="nhat-ky" aria-labelledby="h-nhat-ky">
            <SectionHeader id="h-nhat-ky" index="04" eyebrow="Nhật ký" title="Nhật ký Modbus"
              desc="Sự kiện vận hành và khung TX / RX trên bus — nhấp một khung để giải mã từng byte." />
            <ModbusLog entries={entries} s={s} meta={meta} onClear={() => setEntries([])} />
          </section>

          <section className="pb-16" id="lich-su" aria-labelledby="h-lich-su">
            <SectionHeader id="h-lich-su" index="05" eyebrow="Lịch sử" title="Lịch sử cảm biến"
              desc="Dữ liệu lưu mỗi 30 giây trong cơ sở dữ liệu, giữ 30 ngày. Có thể tải về dạng CSV." />
            <HistoryPanel />
          </section>

          {isAdmin && (
            <section className="pb-16" id="quan-tri" aria-labelledby="h-quan-tri">
              <SectionHeader id="h-quan-tri" index="06" eyebrow="Quản trị" title="Tài khoản và hoạt động"
                desc="Duyệt yêu cầu cấp tài khoản, phân quyền người dùng và xem ai đã thao tác gì." />
              <AdminPanel me={me} minLen={(meta && meta.min_password) || 8} push={push} />
            </section>
          )}
        </main>

        <Footer meta={meta} me={me} />
        {pwOpen && <PasswordDialog minLen={(meta && meta.min_password) || 8} onClose={closePw} push={push} />}
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  class ErrorBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null }; }
    static getDerivedStateFromError(error) { return { error }; }
    componentDidCatch(error, info) { console.error(error, info); }
    render() {
      if (!this.state.error) return this.props.children;
      return (
        <div className="grid min-h-screen place-items-center p-6">
          <Card className="max-w-lg p-6">
            <div className="font-mono text-xs uppercase tracking-widest text-red-700">Lỗi giao diện</div>
            <p className="mt-3 text-sm text-zinc-700">Giao diện gặp lỗi khi hiển thị. Chương trình Python vẫn chạy bình thường.</p>
            <pre className="scroll-thin mt-4 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-xs text-red-800">{String(this.state.error)}</pre>
            <Button className="mt-4" variant="ghost" icon="RotateCcw" onClick={() => location.reload()}>Tải lại trang</Button>
          </Card>
        </div>
      );
    }
  }

  ReactDOM.createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);
})();
