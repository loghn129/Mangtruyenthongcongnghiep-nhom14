/* Nhà kính thông minh — các khối chức năng: telemetry, API, sparkline, giao thức, kết nối, thiết bị, sơ đồ bus, biểu đồ, nhật ký Modbus. */
(() => {
  const { useState, useEffect, useRef } = React;
  const { cx, Icon, Card, CardHeader, Button, Segmented, Toggle, StatusDot, StateChip, Slider, Field, INPUT, Stepper, useNow } = GH.ui;
  const { fmt1, num, clock, duration, hx, frameTag, decodeFrame } = GH.lib;

  // Màu dữ liệu: nhiệt độ = emerald (màu nhấn), độ ẩm = trung tính, bơm = sky (nước), quạt = violet
  const DEV = {
    pump: { icon: 'Droplets', name: 'Bơm 12V', short: 'Bơm', key: 'Space', stroke: '#0284c7', text: 'text-sky-700', bg: 'bg-sky-600', idx: 3 },
    fan: { icon: 'Fan', name: 'Quạt thông gió', short: 'Quạt', key: 'F', stroke: '#7c3aed', text: 'text-violet-700', bg: 'bg-violet-600', idx: 4 },
  };
  const DEVICES = ['pump', 'fan'];
  // Mỗi thiết bị có 2 luật (khớp auto_cfg bên Python): t = nhiệt độ, h = độ ẩm; rule = { use, dir: 'high' | 'low', on, off }
  const SRC = {
    t: { label: 'nhiệt độ', unit: '°C', sym: 'T', min: 0, max: 60, step: 0.5, icon: 'Thermometer' },
    h: { label: 'độ ẩm', unit: '%', sym: 'RH', min: 0, max: 100, step: 1, icon: 'Droplet' },
  };
  const valueOf = (s, key) => (key === 't' ? s.temperature : s.humidity);
  /** 'on' | 'off' | 'hold' | 'unknown' — giống rule_vote() bên Python */
  function zoneOf(r, v) {
    if (v == null) return 'unknown';
    if (r.dir === 'high') return v >= r.on ? 'on' : v <= r.off ? 'off' : 'hold';
    return v <= r.on ? 'on' : v >= r.off ? 'off' : 'hold';
  }
  const activeRules = d => ['t', 'h'].filter(k => d.rules[k].use).map(k => ({ key: k, rule: d.rules[k] }));

  function DeviceIcon({ dev, on, size = 18, className }) {
    const spin = dev === 'fan' && on;
    return (
      <Icon name={DEV[dev].icon} size={size}
        className={cx(spin && 'animate-spin', dev === 'pump' && on && 'drip', className)}
        style={spin ? { animationDuration: '1.1s' } : undefined} />
    );
  }

  function narrative(s, offline) {
    if (offline) return 'Không liên lạc được với chương trình Python — kiểm tra cửa sổ đang chạy final_web.py.';
    if (!s) return 'Đang tải trạng thái…';
    if (!s.connected) return 'Hệ thống đang nghỉ. Chọn cổng COM ở mục Điều khiển rồi nhấn Kết nối để bắt đầu đọc cảm biến.';
    if (s.status === 'error') return 'Không nhận được phản hồi hợp lệ — kiểm tra dây A/B, ID Slave và tốc độ baud.';
    if (s.temperature == null) return 'Đang chờ khung phản hồi đầu tiên từ SRD-THT-12R…';
    if (!s.auto) return `Chế độ bằng tay — bơm ${s.pump ? 'đang chạy' : 'đang tắt'}, quạt ${s.fan ? 'đang chạy' : 'đang tắt'}; bộ điều khiển tự động tạm nghỉ.`;
    return DEVICES.map(dev => {
      const rules = activeRules(s.devices[dev]);
      if (!rules.length) return `${DEV[dev].short}: không có luật nào, giữ nguyên`;
      return `${DEV[dev].short}: ` + rules.map(({ key, rule }) => {
        const src = SRC[key], zone = zoneOf(rule, valueOf(s, key));
        return zone === 'on' ? `${src.label} đạt ngưỡng bật ${num(rule.on)}${src.unit}`
          : zone === 'off' ? `${src.label} qua ngưỡng tắt ${num(rule.off)}${src.unit}`
            : `${src.label} trong vùng trễ`;
      }).join(', ');
    }).join(' · ') + '.';
  }

  // ======================= Box 1 · Telemetry =======================
  function Tile({ icon, label, value, unit, tone }) {
    return (
      <div className="rounded-xl border border-zinc-200/70 bg-zinc-50/50 px-3 py-2.5 transition-colors hover:border-zinc-300">
        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500"><Icon name={icon} size={12} />{label}</div>
        <div className={cx('mt-1 truncate font-mono text-[15px] tabular-nums', tone || 'text-zinc-900')}>
          {value}{unit && <span className="ml-1 text-[11px] text-zinc-500">{unit}</span>}
        </div>
      </div>
    );
  }

  function TempGauge({ s }) {
    const T = s && s.temperature;
    const marks = DEVICES.filter(dev => s && s.devices[dev].rules.t.use)
      .flatMap(dev => ['on', 'off'].map(k => ({ dev, k, v: s.devices[dev].rules.t[k] })));
    const vals = marks.map(m => m.v).concat(T == null ? [] : [T]);
    const lo = Math.floor((vals.length ? Math.min(...vals) : 20) - 5), hi = Math.ceil((vals.length ? Math.max(...vals) : 35) + 5);
    const pct = v => `${Math.min(100, Math.max(0, (v - lo) / (hi - lo) * 100))}%`;
    return (
      <div className="mt-6">
        <div className="relative h-1.5 rounded-full bg-gradient-to-r from-sky-500/40 via-emerald-600/40 to-red-500/50">
          {marks.map(m => (
            <span key={m.dev + m.k} title={`${DEV[m.dev].short} ${m.k === 'on' ? 'bật' : 'tắt'} ${num(m.v)} °C`}
              className={cx('absolute top-1/2 h-3 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full', m.k === 'on' ? DEV[m.dev].bg : 'bg-zinc-50 ring-1 ring-inset ring-zinc-600')}
              style={{ left: pct(m.v), ...(m.k === 'off' ? { boxShadow: `inset 0 0 0 1px ${DEV[m.dev].stroke}` } : {}) }} />
          ))}
          {T != null && (
            <span className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-zinc-50 bg-zinc-950 shadow-[0_0_14px_rgba(0,0,0,.22)] transition-[left] duration-700"
              style={{ left: pct(T) }} />
          )}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[10.5px] text-zinc-400"><span>{lo}°C</span><span>{hi}°C</span></div>
      </div>
    );
  }

  function TelemetryPanel({ s, offline, skew }) {
    const live = s && s.connected && s.status === 'ok';
    const errRate = s && s.tx ? (s.err / s.tx) * 100 : null;
    return (
      <Card lift className="flex flex-col p-5 sm:p-6 md:col-span-2">
        <CardHeader icon="Activity" kicker="Telemetry · SRD-THT-12R" title="Thông số thời gian thực"
          right={(
            <span className={cx('inline-flex items-center gap-2 rounded-full border px-2.5 py-1 font-mono text-[10.5px] tracking-wider',
              live ? 'border-emerald-600/30 bg-emerald-600/10 text-emerald-700' : 'border-zinc-200 text-zinc-500')}>
              <StatusDot tone={live ? 'ok' : s && s.status === 'error' ? 'err' : 'idle'} pulse={live} />
              {live ? 'LIVE' : s && s.connected ? 'ERROR' : 'IDLE'}
            </span>
          )} />

        <div className="mt-6 grid flex-1 gap-6 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
              <div>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500"><Icon name="Thermometer" size={13} />Nhiệt độ</div>
                <div className="mt-1 font-mono text-5xl font-medium tracking-tight text-zinc-950 tabular-nums sm:text-6xl">
                  {fmt1(s && s.temperature)}<span className="ml-1 text-xl text-zinc-500">°C</span>
                </div>
                <div className="mt-1 font-mono text-[10.5px] text-zinc-400">RAW {s && s.raw_temp != null ? hx(s.raw_temp, 4) : '——'}</div>
              </div>
              <div>
                <div className="flex items-center gap-1.5 text-xs text-zinc-500"><Icon name="Droplet" size={13} />Độ ẩm</div>
                <div className="mt-1 font-mono text-3xl font-medium text-zinc-800 tabular-nums">
                  {fmt1(s && s.humidity)}<span className="ml-1 text-base text-zinc-500">%RH</span>
                </div>
                <div className="mt-1 font-mono text-[10.5px] text-zinc-400">RAW {s && s.raw_hum != null ? hx(s.raw_hum, 4) : '——'}</div>
              </div>
            </div>
            <TempGauge s={s} />
          </div>

          <div className="grid grid-cols-2 content-start gap-2">
            <Tile icon="Gauge" label="Baudrate" value={s ? s.config.baud : '—'} unit="bps" />
            <Tile icon="RefreshCw" label="Chu kỳ đọc" value={s ? num(s.interval) : '—'} unit="s" />
            <Tile icon="ArrowDownUp" label="TX / RX" value={s ? `${s.tx} / ${s.rx}` : '—'} />
            <Tile icon="TriangleAlert" label="Tỉ lệ lỗi" value={errRate == null ? '—' : errRate.toFixed(1)} unit="%"
              tone={errRate > 5 ? 'text-red-700' : undefined} />
            <Tile icon={s && s.auto ? 'Bot' : 'Hand'} label="Chế độ" value={s ? (s.auto ? 'Tự động' : 'Bằng tay') : '—'}
              tone={s && s.auto ? 'text-emerald-700' : undefined} />
            <Tile icon="History" label="Cập nhật" value={(s && s.updated) || '—'} />
          </div>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-zinc-200/60 pt-4 sm:flex-row sm:items-center">
          <div className="flex shrink-0 flex-wrap gap-2">
            {DEVICES.map(dev => {
              const d = s && s.devices[dev];
              return (
                <span key={dev} className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50/60 py-1 pl-2 pr-1">
                  <DeviceIcon dev={dev} on={d && d.on} size={14} className={DEV[dev].text} />
                  <span className="text-xs text-zinc-700">{DEV[dev].short}</span>
                  <StateChip on={d ? d.on : null} />
                </span>
              );
            })}
          </div>
          <p className="text-xs leading-5 text-zinc-600">{narrative(s, offline)}</p>
        </div>
      </Card>
    );
  }

  // ======================= Box 3 · Sparkline =======================
  function SparklinePanel({ history }) {
    const W = 300, H = 96;
    const last = history.length ? history[history.length - 1][0] : 0;
    const pts = history.filter(p => p[0] >= last - 300000);
    let body = null;
    if (pts.length > 1) {
      const t0 = pts[0][0], span = Math.max(1, last - t0);
      const temps = pts.map(p => p[1]);
      let lo = Math.min(...temps), hi = Math.max(...temps);
      if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
      const x = t => ((t - t0) / span) * W;
      const y = v => 86 - ((v - lo) / (hi - lo)) * 72;
      const yh = v => 86 - (v / 100) * 72;
      const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
      const hum = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${yh(p[2]).toFixed(1)}`).join('');
      const end = pts[pts.length - 1];
      body = (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-28 w-full overflow-visible">
          <defs>
            <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#059669" stopOpacity=".28" /><stop offset="1" stopColor="#059669" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={hum} fill="none" stroke="#a1a1aa" strokeWidth="1" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity=".7" />
          <path d={`${line}L${W} ${H}L0 ${H}Z`} fill="url(#spark-fill)" className="fade-up" />
          <path d={line} pathLength="1" fill="none" stroke="#059669" strokeWidth="1.75" vectorEffect="non-scaling-stroke"
            className="draw" style={{ filter: 'drop-shadow(0 0 6px rgba(16,185,129,0.33))' }} />
          <circle cx={x(end[0])} cy={y(end[1])} r="3" fill="#059669" />
          <circle cx={x(end[0])} cy={y(end[1])} r="3" fill="none" stroke="#059669" className="animate-ping" style={{ transformOrigin: `${x(end[0])}px ${y(end[1])}px` }} />
        </svg>
      );
    }
    const delta = pts.length > 1 ? pts[pts.length - 1][1] - pts[0][1] : null;
    return (
      <Card lift className="flex flex-col p-5 sm:p-6">
        <CardHeader icon="ChartSpline" kicker="5 phút gần nhất" title="Xu hướng nhiệt độ"
          right={delta != null && (
            <span className={cx('inline-flex items-center gap-1 font-mono text-xs', delta > 0.05 ? 'text-amber-700' : delta < -0.05 ? 'text-sky-700' : 'text-zinc-600')}>
              <Icon name={delta > 0.05 ? 'TrendingUp' : delta < -0.05 ? 'TrendingDown' : 'Minus'} size={14} />
              {delta > 0 ? '+' : ''}{delta.toFixed(1)}°
            </span>
          )} />
        <div className="mt-4 flex flex-1 items-end">
          {body || (
            <div className="grid h-28 w-full place-items-center rounded-xl border border-dashed border-zinc-200 text-xs text-zinc-400">
              Chưa có dữ liệu
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between font-mono text-[10.5px] text-zinc-500">
          <span className="inline-flex items-center gap-1.5"><i className="h-[2px] w-3 rounded bg-emerald-600" />T</span>
          <span className="inline-flex items-center gap-1.5"><i className="h-px w-3 border-t border-dashed border-zinc-500" />RH</span>
          <span>{pts.length} mẫu</span>
        </div>
      </Card>
    );
  }

  // ======================= Box 4 · Giao thức / kiến trúc =======================
  function ConnectivityPanel({ s }) {
    const on = !!(s && s.connected);
    const baud = s ? s.config.baud : 9600;
    const items = [
      { icon: 'Cable', label: 'RS-485', detail: `${baud} · 8N1`, live: on },
      { icon: 'Binary', label: 'Modbus RTU', detail: 'FC01 03 05 06 10', live: on },
      { icon: 'ShieldCheck', label: 'CRC-16', detail: 'poly 0xA001', live: on },
      { icon: 'Database', label: 'SQLite', detail: 'Lịch sử · tài khoản', live: true },
      { icon: 'Cpu', label: 'pymodbus', detail: 'Master', live: on },
      { icon: 'Router', label: 'Edge · LAN', detail: '0.0.0.0:5000', live: true },
    ];
    return (
      <Card lift className="flex flex-col p-5 sm:p-6 md:col-span-3">
        <CardHeader icon="Network" kicker="Stack" title="Kiến trúc & giao thức" />
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {items.map(it => (
            <div key={it.label} className="group/b flex items-center gap-2.5 rounded-lg border border-zinc-200/80 bg-zinc-50/50 px-2.5 py-2 transition hover:border-emerald-600/30">
              <Icon name={it.icon} size={15} className="shrink-0 text-zinc-600 transition group-hover/b:text-emerald-700" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-zinc-800">{it.label}</div>
                <div className="truncate font-mono text-[10px] text-zinc-500">{it.detail}</div>
              </div>
              <StatusDot tone={it.live ? 'ok' : 'idle'} />
            </div>
          ))}
        </div>
        <p className="mt-4 font-mono text-[10.5px] leading-5 text-zinc-500">
          Trình duyệt <span className="text-zinc-300">→</span> Flask <span className="text-zinc-300">→</span> pymodbus <span className="text-zinc-300">→</span> USB-RS485 <span className="text-zinc-300">→</span> Slave
        </p>
      </Card>
    );
  }

  // ======================= Kết nối bus =======================

  function ConnectionCard({ s, meta, form, setForm, ports, onRefreshPorts, onConnect, busy, interval, onInterval }) {
    const locked = !!(s && s.connected) || busy;
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
    const listed = ports.some(p => p.device === form.port);
    return (
      <Card className="p-5 sm:p-6 lg:row-span-2">
        <CardHeader icon="Plug" kicker="USB-RS485" title="Kết nối bus RS-485"
          right={s && s.connected && <span className="font-mono text-[11px] text-emerald-700">{s.link}</span>} />
        <div className="mt-5 space-y-4">
          <Field label="Cổng COM" htmlFor="port">
            <div className="flex gap-2">
              <select id="port" className={cx(INPUT, 'cursor-pointer')} value={form.port} disabled={locked} onChange={e => set('port', e.target.value)}>
                {!ports.length && <option value="">Không tìm thấy cổng COM nào</option>}
                {!listed && form.port && ports.length > 0 && <option value={form.port}>{form.port} (không thấy)</option>}
                {ports.map(p => <option key={p.device} value={p.device}>{p.device} — {p.description}</option>)}
              </select>
              <Button size="md" className="w-9 shrink-0 !px-0" aria-label="Làm mới danh sách cổng COM" title="Làm mới"
                disabled={locked} onClick={onRefreshPorts}><Icon name="RefreshCw" size={15} /></Button>
            </div>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Baudrate">
              <div id="baud" className={cx(INPUT, 'flex items-center justify-between bg-zinc-100/60')}>{form.baud}<span className="font-sans text-[10.5px] text-zinc-500">cố định</span></div>
            </Field>
            <Field label="ID cảm biến SRD-THT-12R" htmlFor="sid">
              <Stepper id="sid" value={form.sht20_id} min={1} max={247} disabled={locked} onChange={v => set('sht20_id', v)} />
            </Field>
          </div>

          <div className="rounded-xl border border-zinc-200/70 bg-zinc-50/40 p-3">
            <div className="mb-2.5 flex items-center gap-2 text-xs font-medium text-zinc-700">
              <Icon name="CircuitBoard" size={14} className="text-emerald-700" />Module relay (bơm + quạt)
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Field label="ID relay" htmlFor="relay-id">
                <Stepper id="relay-id" value={form.relay_id} min={1} max={255} disabled={locked} onChange={v => set('relay_id', v)} />
              </Field>
              <Field label="Kênh bơm" htmlFor="pump-ch">
                <Stepper id="pump-ch" value={form.channel} min={1} max={32} disabled={locked} onChange={v => set('channel', v)} />
              </Field>
              <Field label="Kênh quạt" htmlFor="fan-ch">
                <Stepper id="fan-ch" value={form.fan_channel} min={1} max={32} disabled={locked} onChange={v => set('fan_channel', v)} />
              </Field>
            </div>
          </div>

          <Field label="Kiểu module relay">
            <Segmented full value={form.relay_mode} disabled={locked} onChange={v => set('relay_mode', v)} label="Kiểu relay"
              options={[{ value: 'coil', label: 'coil · FC05' }, { value: 'reg', label: 'reg · FC06' }]} />
          </Field>

          <Slider label="Chu kỳ đọc cảm biến" value={interval} min={0.5} max={10} step={0.5} unit=" s" onChange={onInterval} />

          <Button variant={s && s.connected ? 'danger' : 'primary'} size="lg" className="w-full" disabled={busy || !s}
            icon={busy ? <Icon name="LoaderCircle" size={16} className="animate-spin" /> : s && s.connected ? 'Unplug' : 'Plug'} onClick={onConnect}>
            {busy ? (s && s.connected ? 'Đang ngắt…' : 'Đang kết nối…') : s && s.connected ? 'Ngắt kết nối' : 'Kết nối'}
          </Button>
        </div>
      </Card>
    );
  }

  // ======================= Thẻ thiết bị (bơm / quạt) =======================
  /** Đổi chiều luật: hoán đổi ngưỡng khi cần để giữ điều kiện (high: tắt < bật, low: bật < tắt). */
  function withDir(rule, dir) {
    const r = { ...rule, dir };
    if ((dir === 'high' && !(r.off < r.on)) || (dir === 'low' && !(r.on < r.off))) [r.on, r.off] = [r.off, r.on];
    return r;
  }

  function RuleRow({ k, rule, fixedDir, value, accent, onChange }) {
    const src = SRC[k], high = rule.dir === 'high';
    const zone = zoneOf(rule, value);
    const zoneText = { on: 'đạt điều kiện BẬT', off: 'đạt điều kiện TẮT', hold: 'vùng trễ — giữ nguyên', unknown: 'chưa có số đo' }[zone];
    return (
      <div className={cx('rounded-xl border px-3 py-3 transition-colors',
        rule.use ? 'border-zinc-200 bg-white' : 'border-dashed border-zinc-200 bg-zinc-50/50')}>
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex min-w-0 cursor-pointer items-center gap-2 whitespace-nowrap text-[12.5px] font-medium text-zinc-800">
            <input type="checkbox" checked={rule.use} onChange={e => onChange({ ...rule, use: e.target.checked })}
              className="h-3.5 w-3.5 rounded accent-emerald-600" />
            <Icon name={src.icon} size={13} className="text-zinc-500" />Theo {src.label}
          </label>
          {fixedDir
            ? <span className="shrink-0 font-mono text-[10.5px] text-zinc-500">bật khi cao</span>
            : (
              <span className="inline-flex shrink-0 items-center gap-1.5">
                <span className="text-[10.5px] text-zinc-500">bật khi</span>
                <Segmented size="sm" value={rule.dir} disabled={!rule.use} label={`Chiều luật ${src.label}`}
                  onChange={dir => onChange(withDir(rule, dir))}
                  options={[{ value: 'high', label: 'cao' }, { value: 'low', label: 'thấp' }]} />
              </span>
            )}
        </div>
        {rule.use && (
          <div className="mt-3 space-y-3">
            <Slider label={`Bật khi ${src.sym} ${high ? '≥' : '≤'}`} value={rule.on} min={src.min} max={src.max} step={src.step}
              unit={` ${src.unit}`} accent={accent} onChange={v => onChange({ ...rule, on: v })} />
            <Slider label={`Tắt khi ${src.sym} ${high ? '≤' : '≥'}`} value={rule.off} min={src.min} max={src.max} step={src.step}
              unit={` ${src.unit}`} onChange={v => onChange({ ...rule, off: v })} />
            <p className="font-mono text-[11px] text-zinc-500">Hiện tại {fmt1(value)} {src.unit} · {zoneText}</p>
          </div>
        )}
      </div>
    );
  }

  function DeviceCard({ dev, s, meta, skew, pending, drafts, error, onMode, onToggle, onRule }) {
    const now = useNow(1000);
    const d = s.devices[dev], info = DEV[dev];
    const on = pending != null ? pending : d.on;
    const canToggle = s.connected && !s.auto;
    const remaining = d.off_at ? d.off_at - (now / 1000 + skew) : null;
    const channel = dev === 'pump' ? s.config.channel : s.config.fan_channel;
    const maxOn = meta ? (dev === 'pump' ? meta.max_pump_seconds : meta.max_fan_seconds) : null;
    return (
      <Card className="flex flex-col p-5 sm:p-6">
        <CardHeader kicker={`Relay ID ${s.config.relay_id} · K${channel}`} title={info.name}
          icon={<DeviceIcon dev={dev} on={on} size={16} className={info.text} />}
          right={<StateChip on={on} />} />

        <div className="mt-5">
          <Segmented full value={s.auto ? 'auto' : 'manual'} onChange={v => onMode(v === 'auto')} label="Chế độ (chung cho bơm và quạt)"
            options={[{ value: 'auto', label: 'Tự động', icon: 'Bot' }, { value: 'manual', label: 'Bằng tay', icon: 'Hand' }]} />
          <p className="mt-1.5 text-[11px] text-zinc-500">Chế độ dùng chung cho bơm và quạt.</p>
        </div>

        <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-zinc-200/70 bg-zinc-50/50 px-3.5 py-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-zinc-900">Công tắc {info.short.toLowerCase()}</div>
            <p className="mt-0.5 text-[11.5px] leading-5 text-zinc-500">
              {!s.connected ? 'Kết nối bus RS-485 để điều khiển.'
                : s.auto ? 'Bộ điều khiển tự động đang quyết định.'
                  : remaining != null && on ? <span className="font-mono text-amber-800">Tự tắt sau {duration(remaining)}</span>
                    : <>Nhấn công tắc hoặc phím <span className="font-mono text-zinc-700">{info.key}</span>.</>}
            </p>
          </div>
          <Toggle checked={on === true} disabled={!canToggle} pending={pending != null} label={`Bật / tắt ${info.name}`}
            onChange={v => onToggle(dev, v)} />
        </div>

        <div className={cx('mt-4 space-y-2.5 transition-opacity', !s.auto && 'opacity-70 hover:opacity-100')}>
          <div>
            <div className="text-[11.5px] font-medium text-zinc-600">Luật tự động</div>
            <div className="text-[10.5px] text-zinc-400">BẬT khi một luật đạt · TẮT khi mọi luật về vùng tắt</div>
          </div>
          {['t', 'h'].map(k => (
            <RuleRow key={k} k={k} rule={(drafts && drafts[k]) || d.rules[k]} fixedDir={dev === 'pump' && k === 't'}
              value={valueOf(s, k)} accent={info.text} onChange={r => onRule(dev, k, r)} />
          ))}
          {error && <p className="font-mono text-[11px] leading-5 text-red-700">{error}</p>}
        </div>

        <dl className="mt-auto grid grid-cols-3 gap-2 border-t border-zinc-200/60 pt-4 text-[11px]">
          <div><dt className="text-zinc-500">Kênh relay</dt><dd className="mt-0.5 font-mono text-zinc-800">K{channel} · địa chỉ {channel - 1}</dd></div>
          <div><dt className="text-zinc-500">Hẹn giờ tay</dt><dd className="mt-0.5 font-mono text-zinc-800">{maxOn == null ? '—' : maxOn ? duration(maxOn) : 'không'}</dd></div>
          <div><dt className="text-zinc-500">Mất cảm biến</dt><dd className="mt-0.5 font-mono text-zinc-800">TẮT</dd></div>
        </dl>
      </Card>
    );
  }

  // ======================= Bảo trì: đổi ID =======================
  function MaintenanceCard({ s, meta, onChangeId, busy }) {
    const [dev, setDev] = useState('sht20');
    const [newId, setNewId] = useState(3);
    const off = !s.connected || busy;
    const curId = dev === 'sht20' ? s.config.sht20_id : s.config.relay_id;
    const hex = v => `0x${Number(v).toString(16).toUpperCase().padStart(4, '0')}`;
    const label = dev === 'sht20' ? 'cảm biến SRD-THT-12R' : 'module relay';
    return (
      <Card className="p-5 sm:p-6 md:col-span-2 lg:col-span-3">
        <CardHeader icon="Wrench" kicker="Cấu hình Slave · chỉ Quản trị" title="Đổi địa chỉ ID thiết bị"
          right={!s.connected && <span className="font-mono text-[11px] text-zinc-400">cần kết nối bus</span>} />
        <div className="mt-5 grid items-end gap-3 md:grid-cols-[1.4fr_1fr_1fr_auto]">
          <Field label="Thiết bị">
            <Segmented full size="sm" value={dev} onChange={setDev} label="Thiết bị đổi ID"
              options={[{ value: 'sht20', label: 'Cảm biến' }, { value: 'relay', label: 'Module relay' }]} />
          </Field>
          <Field label="ID hiện tại"><div className={cx(INPUT, 'flex items-center bg-zinc-100/60')}>{curId}</div></Field>
          <Field label="ID mới" htmlFor="new-id">
            <Stepper id="new-id" value={newId} min={1} max={dev === 'sht20' ? 247 : 255} onChange={setNewId} disabled={off} />
          </Field>
          <Button variant="ghost" icon="PenLine" disabled={off || newId === curId} onClick={() => onChangeId(dev, newId)}>Đổi ID → {newId}</Button>
        </div>
        <p className="mt-3 text-[11.5px] leading-5 text-zinc-500">
          {dev === 'sht20'
            ? `FC06 ghi thanh ghi ${meta ? hex(meta.sensor_id_register) : ''}. Theo manual, ID mới chỉ có hiệu lực sau khi tắt/bật lại nguồn cảm biến; sau đó bấm Ngắt kết nối rồi Kết nối lại với ID mới.`
            : `FC10 ghi thanh ghi ${meta ? hex(meta.relay_id_register) : ''}${meta && meta.relay_id_broadcast ? ' tới địa chỉ broadcast 0x00: mọi module relay trên bus đều nhận lệnh, nên chỉ để MỘT module relay khi đổi.' : ' tới ID hiện tại.'}`}
        </p>
      </Card>
    );
  }

  // ======================= Mô hình nhà kính (minh hoạ, chạy theo trạng thái thật) =======================
  const NOZZLES = [215, 295, 375, 455, 535];
  const PLANTS = [205, 295, 385, 475];

  function Plant({ x, sway, delay }) {
    return (
      <g transform={`translate(${x} 0)`}>
        <g className={sway ? 'gh-sway' : undefined} style={{ animationDelay: `${delay}s` }}>
          <path d="M0 338 C -2 318 2 300 0 286" stroke="#15803d" strokeWidth="3" fill="none" strokeLinecap="round" />
          <ellipse cx="-14" cy="318" rx="15" ry="7" fill="#22c55e" transform="rotate(-28 -14 318)" />
          <ellipse cx="14" cy="310" rx="15" ry="7" fill="#16a34a" transform="rotate(28 14 310)" />
          <ellipse cx="-11" cy="296" rx="12" ry="6" fill="#4ade80" transform="rotate(-38 -11 296)" />
          <ellipse cx="11" cy="290" rx="12" ry="6" fill="#22c55e" transform="rotate(38 11 290)" />
          <ellipse cx="0" cy="282" rx="6" ry="10" fill="#86efac" />
        </g>
        <path d="M-22 336 H22 L17 372 H-17 Z" fill="#c2794e" />
        <rect x="-24" y="332" width="48" height="8" rx="2" fill="#a8613a" />
      </g>
    );
  }

  function GreenhousePanel({ s, pending, onToggle, readOnly }) {
    const pumpOn = pending.pump != null ? pending.pump : s && s.pump === true;
    const fanOn = pending.fan != null ? pending.fan : s && s.fan === true;
    const can = !!(s && s.connected && !s.auto && !readOnly);
    const T = s && s.temperature, H = s && s.humidity;
    const heat = T == null ? 0 : Math.min(0.2, Math.max(0, (T - 27) / 40));
    const press = (dev, on) => e => {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (can) onToggle(dev, !on);
    };
    const hit = (dev, on, label) => ({
      role: 'button', tabIndex: can ? 0 : -1, 'aria-label': `${label}: ${on ? 'đang chạy' : 'đã tắt'}`,
      onClick: press(dev, on), onKeyDown: press(dev, on), style: { cursor: can ? 'pointer' : 'default', outline: 'none' },
    });
    return (
      <Card className="mt-4 overflow-hidden p-5 sm:p-6">
        <CardHeader icon="Warehouse" kicker="Mô phỏng · chạy theo trạng thái thật" title="Mô hình nhà kính"
          right={(
            <div className="flex flex-wrap justify-end gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 font-mono text-[11px] text-zinc-700">
                <Icon name="Thermometer" size={12} />{fmt1(T)} °C</span>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2.5 py-1 font-mono text-[11px] text-zinc-700">
                <Icon name="Droplet" size={12} />{fmt1(H)} %</span>
            </div>
          )} />

        <div className="relative mt-4 overflow-hidden rounded-xl border border-zinc-200/70">
          <svg viewBox="0 0 760 430" className="block h-auto w-full" role="img"
            aria-label={`Nhà kính: quạt ${fanOn ? 'đang chạy' : 'tắt'}, bơm phun sương ${pumpOn ? 'đang chạy' : 'tắt'}`}>
            <defs>
              <linearGradient id="gh-sky" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#e0f2fe" /><stop offset="1" stopColor="#f0fdf4" />
              </linearGradient>
              <linearGradient id="gh-glass" x1="0" x2="1" y1="0" y2="1">
                <stop offset="0" stopColor="#ffffff" stopOpacity=".55" /><stop offset=".5" stopColor="#d1fae5" stopOpacity=".18" />
                <stop offset="1" stopColor="#ffffff" stopOpacity=".4" />
              </linearGradient>
              <linearGradient id="gh-wall" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#f5f3ff" /><stop offset="1" stopColor="#ede9fe" />
              </linearGradient>
              <radialGradient id="gh-mist" cx=".5" cy=".5" r=".5">
                <stop offset="0" stopColor="#bae6fd" stopOpacity=".9" /><stop offset="1" stopColor="#bae6fd" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Trời, mặt trời, nền đất */}
            <rect width="760" height="430" fill="url(#gh-sky)" />
            <g transform="translate(690 62)">
              <g className="gh-spin-slow">
                {[0, 45, 90, 135, 180, 225, 270, 315].map(a => (
                  <rect key={a} x="-2" y="-46" width="4" height="12" rx="2" fill="#fcd34d" transform={`rotate(${a})`} />
                ))}
              </g>
              <circle r="26" fill="#fde68a" /><circle r="18" fill="#fcd34d" />
            </g>
            <rect y="380" width="760" height="50" fill="#e7e5e4" />
            <rect y="380" width="760" height="6" fill="#d6d3d1" />

            {/* Bể nước + bơm + ống dẫn lên trần */}
            <g {...hit('pump', pumpOn, 'Bơm phun sương')}>
              <rect x="34" y="296" width="70" height="84" rx="8" fill="#f8fafc" stroke="#94a3b8" strokeWidth="2.5" />
              <rect x="38" y="318" width="62" height="58" rx="5" fill="#7dd3fc" opacity=".75" />
              <path d="M38 322 q 8 -5 15 0 t 15 0 t 15 0 t 15 0" stroke="#e0f2fe" strokeWidth="2" fill="none" className={pumpOn ? 'gh-wave' : undefined} />
              <text x="69" y="290" textAnchor="middle" className="fill-zinc-500 font-mono" fontSize="10">BỂ NƯỚC</text>
              <rect x="106" y="346" width="30" height="34" rx="5" fill={pumpOn ? '#0284c7' : '#64748b'} />
              <circle cx="121" cy="363" r="7" fill="#e2e8f0" />
              <circle cx="121" cy="356" r="2.5" fill={pumpOn ? '#4ade80' : '#cbd5e1'} className={pumpOn ? 'gh-blink' : undefined} />
              <path d="M121 346 V 166 H 175" stroke="#94a3b8" strokeWidth="7" fill="none" strokeLinejoin="round" strokeLinecap="round" />
              {pumpOn && <path d="M121 346 V 166 H 175" stroke="#38bdf8" strokeWidth="3" fill="none" strokeDasharray="6 8" className="gh-flow" />}
            </g>

            {/* Khung nhà kính: tường sau, mái kính */}
            <rect x="150" y="150" width="460" height="230" fill="url(#gh-wall)" />
            <rect x="150" y="150" width="460" height="230" fill="#fb923c" opacity={heat} style={{ transition: 'opacity 1s' }} />
            <polygon points="140,152 380,74 620,152" fill="#ecfdf5" opacity=".85" />
            <polygon points="140,152 380,74 620,152" fill="url(#gh-glass)" stroke="#94a3b8" strokeWidth="5" strokeLinejoin="round" />
            {[220, 300, 460, 540].map(x => <line key={x} x1={x} y1={152 - (x < 380 ? (x - 140) : (620 - x)) * 0.325} x2={x} y2="152" stroke="#cbd5e1" strokeWidth="2.5" />)}
            <line x1="380" y1="74" x2="380" y2="152" stroke="#cbd5e1" strokeWidth="2.5" />

            {/* Cây trồng (lay nhẹ khi quạt chạy) */}
            <rect x="170" y="368" width="420" height="12" rx="3" fill="#a16207" opacity=".35" />
            {PLANTS.map((x, i) => <Plant key={x} x={x} sway={fanOn} delay={i * 0.25} />)}

            {/* Cảm biến SRD-THT-12R trên tường sau */}
            <g transform="translate(168 182)">
              <rect width="78" height="52" rx="6" fill="#f4f4f5" stroke="#a1a1aa" strokeWidth="1.5" />
              {[8, 16, 24, 32].map(y => <rect key={y} x="8" y={y} width="28" height="3" rx="1.5" fill="#d4d4d8" />)}
              <rect x="44" y="8" width="26" height="22" rx="2" fill="#fafafa" stroke="#e4e4e7" />
              <rect x="70" y="18" width="10" height="16" rx="1.5" fill="#22c55e" />
              <circle cx="14" cy="44" r="3" fill={s && s.connected ? '#22c55e' : '#a1a1aa'} className={s && s.connected ? 'gh-blink' : undefined} />
              <text x="39" y="66" textAnchor="middle" className="fill-zinc-500 font-mono" fontSize="10">SRD-THT-12R</text>
            </g>
            <g transform="translate(256 190)">
              <rect width="96" height="38" rx="8" fill="#ffffff" stroke="#e4e4e7" />
              <text x="10" y="16" className="fill-zinc-900 font-mono" fontSize="12" fontWeight="600">{fmt1(T)} °C</text>
              <text x="10" y="31" className="fill-zinc-500 font-mono" fontSize="11">{fmt1(H)} %RH</text>
            </g>

            {/* Ống phun sương trên trần + vòi + giọt nước */}
            <g {...hit('pump', pumpOn, 'Bơm phun sương')}>
              <line x1="172" y1="166" x2="588" y2="166" stroke="#94a3b8" strokeWidth="7" strokeLinecap="round" />
              {pumpOn && <line x1="172" y1="166" x2="588" y2="166" stroke="#38bdf8" strokeWidth="3" strokeDasharray="6 8" className="gh-flow" />}
              {NOZZLES.map(x => <path key={x} d={`M${x - 5} 169 h10 l-2 9 h-6 z`} fill="#64748b" />)}
            </g>
            {pumpOn && NOZZLES.map((x, n) => (
              <g key={x}>
                <ellipse cx={x} cy="225" rx="50" ry="40" fill="url(#gh-mist)" className="gh-mist" style={{ animationDelay: `${n * 0.3}s` }} />
                {[-18, -12, -6, 0, 6, 12, 18].map((dx, i) => (
                  <ellipse key={dx} cx={x + dx} cy="182" rx="2.4" ry="3.6" fill="#0ea5e9" className="gh-drop"
                    style={{ animationDelay: `${(i * 0.19 + n * 0.13) % 1.3}s`, '--dx': `${dx * 1.8}px` }} />
                ))}
              </g>
            ))}

            {/* Quạt thông gió trên tường phải + luồng gió */}
            <g {...hit('fan', fanOn, 'Quạt thông gió')} transform="translate(560 214)">
              <rect x="-36" y="-36" width="72" height="72" rx="9" fill="#27272a" />
              <circle r="30" fill="#3f3f46" />
              <g className={fanOn ? 'gh-spin' : undefined}>
                {[0, 72, 144, 216, 288].map(a => (
                  <path key={a} d="M0 0 C 8 -6 14 -20 4 -27 C -4 -22 -6 -10 0 0 Z" fill="#a1a1aa" transform={`rotate(${a})`} />
                ))}
              </g>
              <circle r="8" fill="#16a34a" /><circle r="3.5" fill="#fef08a" />
              <circle cx="27" cy="-27" r="3" fill={fanOn ? '#4ade80' : '#71717a'} className={fanOn ? 'gh-blink' : undefined} />
            </g>
            {fanOn && [196, 214, 232].map((y, i) => (
              <path key={y} d={`M626 ${y} q 22 -8 44 0 t 44 0`} stroke="#7dd3fc" strokeWidth="3" fill="none" strokeLinecap="round"
                strokeDasharray="18 22" className="gh-air" style={{ animationDelay: `${i * 0.2}s` }} />
            ))}

            {/* Kính mặt trước (phản chiếu) + khung nhôm */}
            <rect x="150" y="152" width="460" height="228" fill="url(#gh-glass)" />
            <path d="M190 160 L 250 372 M 214 160 L 274 372" stroke="#ffffff" strokeWidth="6" opacity=".35" />
            <path d="M470 160 L 530 372" stroke="#ffffff" strokeWidth="10" opacity=".22" />
            <rect x="146" y="150" width="468" height="232" fill="none" stroke="#94a3b8" strokeWidth="6" rx="3" />
            <line x1="380" y1="152" x2="380" y2="380" stroke="#cbd5e1" strokeWidth="3" />
            <line x1="150" y1="262" x2="610" y2="262" stroke="#cbd5e1" strokeWidth="2" opacity=".7" />
          </svg>

          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-1.5">
            {[['pump', 'Bơm phun sương', pumpOn], ['fan', 'Quạt thông gió', fanOn]].map(([dev, label, on]) => (
              <span key={dev} className={cx('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur',
                on ? 'border-emerald-600/30 bg-emerald-50/90 text-emerald-800' : 'border-zinc-200 bg-white/90 text-zinc-600')}>
                <DeviceIcon dev={dev} on={on} size={12} />{label} · {on ? 'BẬT' : 'TẮT'}
              </span>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          Hình minh hoạ để hình dung, chạy theo trạng thái thật của bơm, quạt và cảm biến.
          {readOnly ? '' : can ? ' Nhấp vào quạt hoặc bơm / ống phun để bật, tắt.' : s && s.connected ? ' Chuyển sang Bằng tay để bật / tắt bằng cách nhấp vào hình.' : ' Kết nối bus RS-485 để mô hình chạy theo thiết bị thật.'}
        </p>
      </Card>
    );
  }

  // ======================= Sơ đồ bus =======================
  function BusNode({ icon, title, sub, tag, live, children, onClick, active, iconNode }) {
    const Tag = onClick ? 'button' : 'div';
    return (
      <li className="relative">
        <span className="absolute -left-[15px] top-[22px] h-px w-[15px] bg-zinc-300" />
        <span className={cx('absolute -left-[18px] top-[19px] h-1.5 w-1.5 rounded-full', live ? 'bg-emerald-600 shadow-[0_0_8px_#059669]' : 'bg-zinc-400')} />
        <Tag type={onClick ? 'button' : undefined} onClick={onClick}
          className={cx('flex w-full items-center gap-3 rounded-xl border bg-zinc-50/50 px-3 py-2.5 text-left transition',
            active ? 'border-emerald-600/30 shadow-[0_0_24px_-10px_rgba(16,185,129,0.36)]' : 'border-zinc-200/80',
            onClick && 'cursor-pointer hover:border-emerald-600/40 hover:bg-zinc-100/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50')}>
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-zinc-100 text-zinc-700">
            {iconNode || <Icon name={icon} size={16} />}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-zinc-900">{title}</span>
            <span className="block truncate font-mono text-[10.5px] text-zinc-500">{sub}</span>
          </span>
          {tag}
        </Tag>
        {children}
      </li>
    );
  }

  function TopologyPanel({ s, pending, onToggle }) {
    const live = s.connected && s.status === 'ok';
    const cfg = s.config;
    const relays = {};
    DEVICES.forEach(dev => { (relays[cfg[`${dev}_id`]] = relays[cfg[`${dev}_id`]] || []).push(dev); });
    const mono = t => <span className="shrink-0 rounded border border-zinc-200 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{t}</span>;
    return (
      <Card className="p-5 sm:p-6 lg:col-span-2">
        <CardHeader icon="Workflow" kicker="Multi-drop · A+ / B−" title="Sơ đồ bus RS-485"
          right={<span className="hidden font-mono text-[11px] text-zinc-500 sm:inline">nhấp thiết bị để bật / tắt (Bằng tay)</span>} />
        <div className="relative mt-5 pl-7">
          <div className={cx('absolute bottom-6 left-[13px] top-5 w-[2px] rounded-full', live ? 'bus-live' : 'bg-zinc-200')} />
          <ul className="space-y-2.5">
            <BusNode icon="Server" live={live} title="Máy chủ Flask · pymodbus" sub={`Modbus Master · ${location.host}`} tag={mono('MASTER')} />
            <BusNode icon="Usb" live={live} title={`USB-RS485 · ${s.connected ? s.link : cfg.port || '—'}`} sub={`${cfg.baud} bps · 8N1 · ${s.connected ? 'đang mở' : 'đóng'}`} tag={mono('BRIDGE')} />
            <BusNode icon="Thermometer" live={live} title={`Cảm biến SRD-THT-12R · ID ${cfg.sht20_id}`}
              sub={s.temperature == null ? 'chưa có số đo' : `${fmt1(s.temperature)} °C · ${fmt1(s.humidity)} %RH`} tag={mono('SLAVE')} />
            {Object.keys(relays).map(id => (
              <BusNode key={id} icon="CircuitBoard" live={live} title={`Module relay · ID ${id}`} sub="Bơm + quạt" tag={mono('SLAVE')}>
                <ul className="ml-7 mt-2.5 space-y-2 border-l border-dashed border-zinc-200 pl-4">
                  {relays[id].map(dev => {
                    const d = s.devices[dev];
                    const on = pending[dev] != null ? pending[dev] : d.on;
                    const can = s.connected && !s.auto;
                    return (
                      <li key={dev} className="relative">
                        <span className="absolute -left-4 top-[22px] h-px w-4 border-t border-dashed border-zinc-300" />
                        <button type="button" disabled={!can} onClick={() => onToggle(dev, !on)}
                          aria-label={`${DEV[dev].name}, kênh ${cfg[`${dev}_channel`]}: ${on ? 'đang chạy' : on === false ? 'đã tắt' : 'chưa rõ'}`}
                          title={can ? `Nhấp để ${on ? 'tắt' : 'bật'}` : d.auto ? 'Đang ở chế độ Tự động' : 'Chưa kết nối'}
                          className={cx('flex w-full items-center gap-3 rounded-xl border bg-zinc-50/50 px-3 py-2.5 text-left transition',
                            on ? 'border-emerald-600/30 shadow-[0_0_24px_-10px_rgba(16,185,129,0.36)]' : 'border-zinc-200/80',
                            can ? 'cursor-pointer hover:border-emerald-600/40 hover:bg-zinc-100/70' : 'cursor-default',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50')}>
                          <span className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-lg border bg-zinc-100', on ? 'border-emerald-600/30' : 'border-zinc-200')}>
                            <DeviceIcon dev={dev} on={on} size={16} className={DEV[dev].text} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-medium text-zinc-900">K{cfg[`${dev}_channel`]} · {DEV[dev].name}</span>
                            <span className="block truncate font-mono text-[10.5px] text-zinc-500">{d.auto ? 'AUTO' : 'MANUAL'} · 12V DC</span>
                          </span>
                          <StateChip on={on} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </BusNode>
            ))}
          </ul>
        </div>
      </Card>
    );
  }

  // ======================= Biểu đồ xu hướng =======================
  const RANGES = [{ value: 60, label: '1 phút' }, { value: 300, label: '5 phút' }, { value: 900, label: '15 phút' }, { value: 0, label: 'Toàn bộ' }];
  const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(v => v * 1000);

  function niceStep(span) {
    const raw = span / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / p;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * p;
  }

  function TrendChart({ s }) {
    const history = s.history;
    const [range, setRange] = useState(300);
    const [showHum, setShowHum] = useState(true);
    const [hover, setHover] = useState(null);
    const wrap = useRef(null);
    const [W, setW] = useState(760);
    useEffect(() => {
      const ro = new ResizeObserver(es => setW(Math.max(280, Math.round(es[0].contentRect.width))));
      ro.observe(wrap.current);
      return () => ro.disconnect();
    }, []);

    const H = W < 560 ? 250 : 320;
    const P = { l: 40, r: showHum ? 38 : 12, t: 12, b: 52 };
    const plotB = H - P.b;
    const last = history.length ? history[history.length - 1][0] : Date.now();
    const pts = range ? history.filter(p => p[0] >= last - range * 1000) : history;
    const t0 = range ? last - range * 1000 : (pts.length ? pts[0][0] : last - 60000);
    const span = Math.max(1000, last - t0);
    const gap = Math.max(3 * s.interval * 1000, 8000);

    const thr = DEVICES.flatMap(dev => activeRules(s.devices[dev])
      .filter(({ key }) => key === 't' || showHum)
      .flatMap(({ key, rule }) => ['on', 'off'].map(k => ({ dev: dev + key, color: dev, k, v: rule[k], hum: key === 'h' }))));
    const tVals = pts.map(p => p[1]).concat(thr.filter(t => !t.hum).map(t => t.v));
    let lo = tVals.length ? Math.min(...tVals) : 20, hi = tVals.length ? Math.max(...tVals) : 35;
    const padY = Math.max(1, (hi - lo) * 0.12);
    lo = Math.floor(lo - padY); hi = Math.ceil(hi + padY);

    const x = t => P.l + ((t - t0) / span) * (W - P.l - P.r);
    const y = v => P.t + ((hi - v) / (hi - lo)) * (plotB - P.t);
    const yh = v => P.t + ((100 - v) / 100) * (plotB - P.t);

    // Nhãn ngưỡng: xếp theo chiều dọc, đẩy xuống khi hai nhãn sát nhau (vd bơm tắt 30° và quạt bật 30°)
    const thrLines = thr.map(t => ({ ...t, yy: t.hum ? yh(t.v) : y(t.v) })).sort((a, b) => a.yy - b.yy);
    thrLines.forEach((t, i) => { t.ly = i && t.yy - 4 - thrLines[i - 1].ly < 11 ? thrLines[i - 1].ly + 11 : t.yy - 4; });

    const segs = [];
    pts.forEach((p, i) => {
      if (!i || p[0] - pts[i - 1][0] > gap) segs.push([]);
      segs[segs.length - 1].push(p);
    });
    const path = (get, yf) => segs.map(sg => 'M' + sg.map(p => `${x(p[0]).toFixed(1)} ${yf(get(p)).toFixed(1)}`).join('L')).join('');
    const tLine = path(p => p[1], y);
    const hLine = path(p => p[2], yh);
    const area = segs.map(sg => `M${x(sg[0][0]).toFixed(1)} ${plotB}L` + sg.map(p => `${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('L')
      + `L${x(sg[sg.length - 1][0]).toFixed(1)} ${plotB}Z`).join('');

    const lanes = DEVICES.map((dev, li) => {
      const k = DEV[dev].idx, rects = [];
      pts.forEach((p, i) => {
        if (!p[k]) return;
        const nx = pts[i + 1];
        const x0 = x(p[0]), x1 = nx && nx[0] - p[0] <= gap ? x(nx[0]) : x0 + 2;
        const prev = rects[rects.length - 1];
        if (prev && Math.abs(prev[1] - x0) < 0.5) prev[1] = x1; else rects.push([x0, x1]);
      });
      return { dev, y: plotB + 24 + li * 11, rects };
    });

    const tStep = STEPS.find(st => span / st <= 6) || STEPS[STEPS.length - 1];
    const xTicks = [];
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= last; t += tStep) xTicks.push(t);
    const yStep = niceStep(hi - lo), yTicks = [];
    for (let v = Math.ceil(lo / yStep) * yStep; v <= hi + 1e-9; v += yStep) yTicks.push(+v.toFixed(2));

    const onMove = e => {
      if (!pts.length) return;
      const r = e.currentTarget.getBoundingClientRect();
      const t = t0 + ((e.clientX - r.left) * (W / r.width) - P.l) / (W - P.l - P.r) * span;
      let a = 0, b = pts.length - 1;
      while (b - a > 1) { const m = (a + b) >> 1; if (pts[m][0] < t) a = m; else b = m; }
      setHover(Math.abs(pts[a][0] - t) < Math.abs(pts[b][0] - t) ? a : b);
    };
    const hp = hover != null && pts[hover];

    const temps = pts.map(p => p[1]);
    const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const duty = k => (pts.length ? `${Math.round((pts.filter(p => p[k]).length / pts.length) * 100)} %` : '—');
    const stats = [
      ['Thấp nhất', temps.length ? `${fmt1(Math.min(...temps))} °C` : '—'],
      ['Cao nhất', temps.length ? `${fmt1(Math.max(...temps))} °C` : '—'],
      ['Trung bình', temps.length ? `${fmt1(avg(temps))} °C` : '—'],
      ['Độ ẩm TB', pts.length ? `${fmt1(avg(pts.map(p => p[2])))} %` : '—'],
      ['Bơm chạy', duty(3)],
      ['Quạt chạy', duty(4)],
    ];

    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600">
            <span className="inline-flex items-center gap-1.5"><i className="h-[2px] w-4 rounded bg-emerald-600" />Nhiệt độ</span>
            <button type="button" onClick={() => setShowHum(v => !v)} aria-pressed={showHum}
              className={cx('inline-flex items-center gap-1.5 rounded transition hover:text-zinc-800', !showHum && 'opacity-40 line-through')}>
              <i className="w-4 border-t border-dashed border-zinc-600" />Độ ẩm (0–100 %)
            </button>
            {DEVICES.map(dev => (
              <span key={dev} className="inline-flex items-center gap-1.5"><i className={cx('h-2 w-4 rounded-sm opacity-70', DEV[dev].bg)} />{DEV[dev].short} chạy</span>
            ))}
            <span className="inline-flex items-center gap-1.5"><i className="w-4 border-t border-dashed border-zinc-500" />Ngưỡng</span>
          </div>
          <Segmented size="sm" value={range} onChange={setRange} label="Khoảng thời gian" options={RANGES} />
        </div>

        <div ref={wrap} className="relative mt-4" onMouseLeave={() => setHover(null)}>
          <svg viewBox={`0 0 ${W} ${H}`} className="block w-full select-none" style={{ height: H }} onMouseMove={onMove}
            role="img" aria-label="Biểu đồ nhiệt độ, độ ẩm và thời gian bơm, quạt chạy">
            <defs>
              <linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#059669" stopOpacity=".22" /><stop offset="1" stopColor="#059669" stopOpacity="0" />
              </linearGradient>
            </defs>
            {yTicks.map(v => (
              <g key={v}>
                <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="#e4e4e7" strokeDasharray="2 4" />
                <text x={P.l - 8} y={y(v) + 3.5} textAnchor="end" className="fill-zinc-500 font-mono" fontSize="10">{v}°</text>
              </g>
            ))}
            {showHum && [0, 50, 100].map(v => (
              <text key={v} x={W - P.r + 6} y={yh(v) + 3.5} className="fill-zinc-400 font-mono" fontSize="10">{v}%</text>
            ))}
            {xTicks.map(t => (
              <text key={t} x={x(t)} y={plotB + 14} textAnchor="middle" className="fill-zinc-500 font-mono" fontSize="10">{clock(t)}</text>
            ))}
            {thrLines.map(t => (
              <g key={t.dev + t.k}>
                <line x1={P.l} x2={W - P.r} y1={t.yy} y2={t.yy} stroke={DEV[t.color].stroke} strokeOpacity={t.k === 'on' ? 0.75 : 0.4}
                  strokeDasharray={t.k === 'on' ? '6 4' : '2 4'} />
                <text x={W - P.r - 4} y={t.ly} textAnchor="end" fill={DEV[t.color].stroke} fillOpacity=".85" className="font-mono" fontSize="9.5"
                  stroke="#ffffff" strokeWidth="3" paintOrder="stroke">
                  {DEV[t.color].short} {t.k === 'on' ? 'bật' : 'tắt'} {num(t.v)}{t.hum ? '%' : '°'}
                </text>
              </g>
            ))}
            {showHum && <path d={hLine} fill="none" stroke="#71717a" strokeOpacity=".6" strokeWidth="1.25" strokeDasharray="4 3" />}
            <path d={area} fill="url(#trend-fill)" />
            <path d={tLine} fill="none" stroke="#059669" strokeWidth="2" strokeLinejoin="round" style={{ filter: 'drop-shadow(0 0 6px rgba(16,185,129,0.27))' }} />
            {lanes.map(l => (
              <g key={l.dev}>
                <text x={P.l - 8} y={l.y + 5} textAnchor="end" className="fill-zinc-500 font-mono" fontSize="9">{DEV[l.dev].short}</text>
                <rect x={P.l} y={l.y} width={W - P.l - P.r} height="6" rx="3" fill="#f4f4f5" />
                {l.rects.map(([a, b], i) => <rect key={i} x={a} y={l.y} width={Math.max(2, b - a)} height="6" rx="3" fill={DEV[l.dev].stroke} fillOpacity=".75" />)}
              </g>
            ))}
            {hp && (
              <g>
                <line x1={x(hp[0])} x2={x(hp[0])} y1={P.t} y2={plotB} stroke="#a1a1aa" />
                <circle cx={x(hp[0])} cy={y(hp[1])} r="4" fill="#ffffff" stroke="#059669" strokeWidth="2" />
                {showHum && <circle cx={x(hp[0])} cy={yh(hp[2])} r="3" fill="#ffffff" stroke="#71717a" strokeWidth="1.5" />}
              </g>
            )}
          </svg>
          {hp && (
            <div className="pointer-events-none absolute top-2 z-10 w-44 rounded-lg border border-zinc-200 bg-[#fafafa]/95 p-2.5 font-mono text-[11px] shadow-xl shadow-zinc-900/10 backdrop-blur"
              style={{ left: `clamp(0px, calc(${(x(hp[0]) / W) * 100}% + 12px), calc(100% - 11rem))` }}>
              <div className="text-zinc-500">{clock(hp[0])}</div>
              <div className="mt-1 flex justify-between"><span className="text-zinc-600">T</span><span className="text-emerald-700">{fmt1(hp[1])} °C</span></div>
              <div className="flex justify-between"><span className="text-zinc-600">RH</span><span className="text-zinc-800">{fmt1(hp[2])} %</span></div>
              {DEVICES.map(dev => (
                <div key={dev} className="flex justify-between"><span className="text-zinc-600">{DEV[dev].short}</span>
                  <span className={hp[DEV[dev].idx] ? DEV[dev].text : 'text-zinc-500'}>{hp[DEV[dev].idx] ? 'BẬT' : 'TẮT'}</span></div>
              ))}
            </div>
          )}
          {!pts.length && (
            <div className="absolute inset-0 grid place-items-center text-sm text-zinc-500">Chưa có dữ liệu — hãy kết nối để bắt đầu.</div>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {stats.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-zinc-200/70 bg-zinc-50/40 px-3 py-2">
              <dt className="text-[11px] text-zinc-500">{k}</dt>
              <dd className="mt-0.5 font-mono text-sm text-zinc-900">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    );
  }

  // ======================= Nhật ký Modbus =======================
  const LEVEL = { info: ['Thông tin', 'text-sky-700'], ok: ['Vận hành', 'text-emerald-700'], warn: ['Cảnh báo', 'text-amber-700'], err: ['Lỗi', 'text-red-700'] };
  const ROLE = {
    id: 'border-sky-600/30 bg-sky-600/10 text-sky-800', fc: 'border-violet-600/30 bg-violet-600/10 text-violet-800',
    addr: 'border-zinc-400 bg-zinc-200/60 text-zinc-800', data: 'border-emerald-600/30 bg-emerald-600/10 text-emerald-800',
    crc: 'border-zinc-300 bg-zinc-100 text-zinc-500',
  };
  const isFrameErr = e => 'hex' in e && (!e.hex || (parseInt(e.hex.split(' ')[1], 16) & 0x80));

  function Decode({ hex, dir, meta }) {
    const d = decodeFrame(hex, dir, meta);
    if (!d) return <div className="px-3 pb-3 text-xs text-zinc-500">Khung quá ngắn để giải mã.</div>;
    const role = d.b.map(() => 'data');
    d.f.forEach(f => { for (let i = f.a; i < f.z; i++) role[i] = f.role; });
    return (
      <div className="fade-up mx-2 mb-2 rounded-lg border border-zinc-200 bg-zinc-50/70 p-3">
        <div className="flex flex-wrap gap-1">
          {d.b.map((v, i) => (
            <span key={i} className={cx('rounded border px-1.5 py-0.5 font-mono text-[11px]', ROLE[role[i]])}>{v.toString(16).toUpperCase().padStart(2, '0')}</span>
          ))}
        </div>
        <dl className="mt-3 grid gap-x-4 gap-y-1 text-[11.5px] sm:grid-cols-[150px_1fr]">
          {d.f.map((f, i) => (
            <React.Fragment key={i}>
              <dt className="text-zinc-500">{f.label}</dt>
              <dd className="font-mono text-zinc-800">{f.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      </div>
    );
  }

  function ModbusLog({ entries, s, meta, onClear }) {
    const [filter, setFilter] = useState('all');
    const [follow, setFollow] = useState(true);
    const [open, setOpen] = useState(null);
    const listRef = useRef(null);
    const shown = entries.filter(e => filter === 'all' || (filter === 'event' ? !('hex' in e)
      : filter === 'frame' ? 'hex' in e : e.level === 'err' || isFrameErr(e)));
    useEffect(() => {
      if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
    }, [shown.length, follow, filter]);
    const onScroll = e => {
      const el = e.currentTarget;
      setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
    };
    return (
      <Card className="p-5 sm:p-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <Segmented size="sm" value={filter} onChange={setFilter} label="Lọc nhật ký"
            options={[{ value: 'all', label: 'Tất cả' }, { value: 'event', label: 'Sự kiện' }, { value: 'frame', label: 'Khung TX/RX' }, { value: 'err', label: 'Lỗi' }]} />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex gap-3 font-mono text-[11px] text-zinc-500">
              <span>TX <b className="font-medium text-zinc-800">{s ? s.tx : 0}</b></span>
              <span>RX <b className="font-medium text-zinc-800">{s ? s.rx : 0}</b></span>
              <span>LỖI <b className={cx('font-medium', s && s.err ? 'text-red-700' : 'text-zinc-800')}>{s ? s.err : 0}</b></span>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
              <input type="checkbox" checked={follow} onChange={e => setFollow(e.target.checked)} className="h-3.5 w-3.5 rounded accent-emerald-600" />Tự cuộn
            </label>
            <Button size="sm" variant="ghost" icon="Trash2" onClick={onClear}>Xóa</Button>
          </div>
        </div>

        <ol ref={listRef} onScroll={onScroll}
          className="scroll-thin mt-4 h-[420px] overflow-y-auto rounded-xl border border-zinc-200/80 bg-[#fafafa] py-1 font-mono text-[11.5px]">
          {!shown.length && <li className="grid h-full place-items-center text-zinc-400">Chưa có mục nào.</li>}
          {shown.map(e => {
            if ('hex' in e) {
              const tx = e.level === 'tx', none = !e.hex, isOpen = open === e.id;
              return (
                <li key={e.id}>
                  <button type="button" disabled={none} onClick={() => setOpen(isOpen ? null : e.id)} aria-expanded={isOpen}
                    className={cx('grid w-full grid-cols-[64px_44px_1fr] items-center gap-2 px-3 py-1 text-left transition sm:grid-cols-[64px_44px_1fr_150px]',
                      !none && 'hover:bg-zinc-100/80', isOpen && 'bg-zinc-100/80')}>
                    <time className="text-zinc-400">{e.t}</time>
                    <span className={tx ? 'text-sky-700' : none ? 'text-red-700' : 'text-emerald-700'}>{tx ? 'TX →' : 'RX ←'}</span>
                    <code className={cx('truncate', none ? 'text-red-700/80' : 'text-zinc-700')}>{none ? '(không phản hồi — timeout)' : e.hex}</code>
                    <span className="hidden truncate text-right text-zinc-500 sm:block">{frameTag(e.hex)}</span>
                  </button>
                  {isOpen && <Decode hex={e.hex} dir={tx ? 'tx' : 'rx'} meta={meta} />}
                </li>
              );
            }
            const [lv, color] = LEVEL[e.level] || [e.level, 'text-zinc-600'];
            return (
              <li key={e.id} className="grid grid-cols-[64px_72px_1fr] gap-2 px-3 py-1 font-sans text-[12px]">
                <time className="font-mono text-[11.5px] text-zinc-400">{e.t}</time>
                <span className={cx('font-mono text-[11px]', color)}>{lv}</span>
                <span className="text-zinc-700">{e.text}</span>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-[11px] text-zinc-400">Khung RX được dựng lại từ kết quả pymodbus (thư viện không trả khung thô). Nhấp một khung để giải mã từng byte.</p>
      </Card>
    );
  }

  GH.panels = { DEV, DEVICES, DeviceIcon, TelemetryPanel, SparklinePanel, ConnectivityPanel, ConnectionCard, DeviceCard, TopologyPanel, TrendChart, ModbusLog, MaintenanceCard, GreenhousePanel };
})();
