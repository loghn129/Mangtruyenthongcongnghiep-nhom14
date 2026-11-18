/* Nhà kính thông minh — thành phần giao diện cơ bản (thẻ, nút, công tắc, thanh trượt, thông báo). */
(() => {
  const { useState, useEffect, useRef, useCallback } = React;
  const L = window.LucideReact;
  const { num, clamp } = GH.lib;

  const cx = (...a) => a.filter(Boolean).join(' ');

  function Icon({ name, ...props }) {
    const C = L[name] || L.Circle;
    return <C aria-hidden="true" strokeWidth={1.75} {...props} />;
  }

  // Thẻ bề mặt: vệt sáng theo con trỏ (CSS .card::before), lift = nâng nhẹ khi rê chuột
  function Card({ as: Tag = 'div', className, children, lift = false, ...rest }) {
    const ref = useRef(null);
    const onMove = e => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    };
    return (
      <Tag ref={ref} onMouseMove={onMove}
        className={cx('card relative min-w-0 rounded-2xl border border-zinc-200/60 bg-surface', lift && 'lift', className)} {...rest}>
        {children}
      </Tag>
    );
  }

  function CardHeader({ icon, title, kicker, right, className }) {
    return (
      <div className={cx('flex items-start justify-between gap-3', className)}>
        <div className="flex min-w-0 items-center gap-3">
          {icon && (
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-200 bg-zinc-50/70 text-emerald-700">
              {typeof icon === 'string' ? <Icon name={icon} size={16} /> : icon}
            </span>
          )}
          <div className="min-w-0">
            {kicker && <div className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-zinc-500">{kicker}</div>}
            <h3 className="truncate text-sm font-medium text-zinc-900">{title}</h3>
          </div>
        </div>
        {right}
      </div>
    );
  }

  function SectionHeader({ id, index, eyebrow, title, desc, right }) {
    return (
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-emerald-600/90">
            <span className="text-zinc-400">{index} /</span> {eyebrow}
          </div>
          <h2 id={id} className="mt-2 text-2xl font-semibold tracking-tight text-zinc-950 sm:text-[28px]">{title}</h2>
          {desc && <p className="mt-1.5 max-w-2xl text-sm leading-6 text-zinc-600">{desc}</p>}
        </div>
        {right}
      </header>
    );
  }

  const BTN = {
    primary: 'bg-emerald-600 text-zinc-50 hover:bg-emerald-700 shadow-[0_0_0_1px_rgba(16,185,129,0.24),0_8px_24px_-8px_rgba(16,185,129,0.33)] hover:shadow-[0_0_0_1px_rgba(16,185,129,.45),0_0_36px_-4px_rgba(16,185,129,0.45)]',
    ghost: 'border border-zinc-200 bg-zinc-50/40 text-zinc-800 hover:border-zinc-400 hover:bg-zinc-100/70',
    danger: 'border border-red-500/30 bg-red-500/10 text-red-800 hover:border-red-600/60 hover:bg-red-500/15',
    subtle: 'text-zinc-600 hover:bg-zinc-200/60 hover:text-zinc-900',
  };
  /** href -> thẻ <a>; icon / iconRight: tên icon Lucide hoặc phần tử React */
  function Button({ variant = 'ghost', size = 'md', icon, iconRight, className, children, type = 'button', ...rest }) {
    const sz = size === 'sm' ? 'h-8 px-3 text-xs gap-1.5' : size === 'lg' ? 'h-11 px-5 text-sm gap-2' : 'h-9 px-4 text-sm gap-2';
    const isz = size === 'sm' ? 14 : 16;
    const ic = v => (typeof v === 'string' ? <Icon name={v} size={isz} /> : v);
    const Tag = rest.href ? 'a' : 'button';
    return (
      <Tag type={Tag === 'button' ? type : undefined}
        className={cx('group/btn inline-flex select-none items-center justify-center rounded-lg font-medium transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#ffffff]',
          'disabled:pointer-events-none disabled:opacity-40', sz, BTN[variant], className)} {...rest}>
        {icon && ic(icon)}
        {children}
        {iconRight && <span className="transition-transform group-hover/btn:translate-x-0.5">{ic(iconRight)}</span>}
      </Tag>
    );
  }

  /** options: [{ value, label, icon?, disabled? }] */
  function Segmented({ value, options, onChange, disabled, size = 'md', full, label }) {
    return (
      <div role="radiogroup" aria-label={label}
        className={cx('rounded-lg border border-zinc-200 bg-zinc-100/80 p-0.5', full ? 'flex w-full' : 'inline-flex', disabled && 'opacity-50')}>
        {options.map(o => {
          const active = o.value === value;
          return (
            <button key={o.value} type="button" role="radio" aria-checked={active} disabled={disabled || o.disabled}
              onClick={() => !active && onChange(o.value)}
              className={cx('inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors',
                size === 'sm' ? 'px-2.5 py-1 text-[11.5px]' : 'px-3 py-1.5 text-xs', full && 'flex-1',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/50 disabled:cursor-not-allowed',
                active ? 'bg-white text-zinc-950 shadow-sm ring-1 ring-zinc-200' : 'text-zinc-600 hover:text-zinc-800')}>
              {o.icon && <Icon name={o.icon} size={13} className={active ? 'text-emerald-700' : ''} />}
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  function Toggle({ checked, onChange, disabled, pending, label }) {
    return (
      <button type="button" role="switch" aria-checked={checked === true} aria-label={label} disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative h-7 w-12 shrink-0 rounded-full border transition-all duration-300',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600/60 disabled:cursor-not-allowed disabled:opacity-40',
          checked ? 'border-emerald-600/50 bg-emerald-500/25 shadow-[0_0_18px_-2px_rgba(16,185,129,0.36)]' : 'border-zinc-300 bg-zinc-100',
          pending && 'animate-pulse')}>
        <span className={cx('absolute left-0.5 top-0.5 h-[22px] w-[22px] rounded-full transition-all duration-300',
          checked ? 'translate-x-5 bg-emerald-700' : 'bg-zinc-500')} />
      </button>
    );
  }

  const TONE = { ok: 'bg-emerald-600', warn: 'bg-amber-600', err: 'bg-red-500', idle: 'bg-zinc-500', info: 'bg-sky-600' };
  function StatusDot({ tone = 'idle', pulse, className }) {
    return (
      <span className={cx('relative inline-flex h-2 w-2 shrink-0', className)}>
        {pulse && <span className={cx('absolute inline-flex h-full w-full animate-ping rounded-full opacity-70', TONE[tone])} />}
        <span className={cx('relative inline-flex h-2 w-2 rounded-full', TONE[tone])} />
      </span>
    );
  }

  /** Trạng thái thiết bị: true = chạy, false = tắt, null = chưa rõ */
  function StateChip({ on, className }) {
    const tone = on === true ? 'ok' : on === false ? 'idle' : 'warn';
    return (
      <span className={cx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 font-mono text-[11px]',
        on === true ? 'border-emerald-600/30 bg-emerald-600/10 text-emerald-800'
          : on === false ? 'border-zinc-300/80 bg-zinc-100 text-zinc-600' : 'border-amber-600/30 bg-amber-600/10 text-amber-800', className)}>
        <StatusDot tone={tone} pulse={on === true} />
        {on === true ? 'ĐANG CHẠY' : on === false ? 'ĐÃ TẮT' : 'CHƯA RÕ'}
      </span>
    );
  }

  function Slider({ label, value, min, max, step, unit = '', onChange, disabled, accent }) {
    const p = `${clamp((value - min) / (max - min), 0, 1) * 100}%`;
    return (
      <label className={cx('block', disabled && 'opacity-60')}>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-zinc-600">{label}</span>
          <span className={cx('font-mono text-[13px]', accent || 'text-zinc-900')}>{num(value)}{unit}</span>
        </div>
        <input type="range" className="range mt-2.5 w-full" style={{ '--p': p }} min={min} max={max} step={step}
          value={value} disabled={disabled} onChange={e => onChange(+e.target.value)} />
      </label>
    );
  }

  function Field({ label, htmlFor, hint, children, className }) {
    return (
      <div className={className}>
        <label htmlFor={htmlFor} className="mb-1.5 block text-[11.5px] font-medium text-zinc-600">{label}</label>
        {children}
        {hint && <p className="mt-1.5 text-[11px] leading-5 text-zinc-500">{hint}</p>}
      </div>
    );
  }

  const INPUT = 'h-9 w-full min-w-0 truncate rounded-lg border border-zinc-200 bg-zinc-50/70 px-3 font-mono text-[13px] text-zinc-900 outline-none transition '
    + 'focus:border-emerald-600/50 focus:ring-2 focus:ring-emerald-600/20 disabled:cursor-not-allowed disabled:opacity-50';

  function Stepper({ id, value, min, max, onChange, disabled }) {
    const set = v => onChange(clamp(Math.round(+v || min), min, max));
    return (
      <div className={cx('flex h-9 items-stretch overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/70', disabled && 'opacity-50')}>
        <button type="button" aria-label="Giảm" disabled={disabled || value <= min} onClick={() => set(value - 1)}
          className="w-8 text-zinc-600 transition hover:bg-zinc-200/70 hover:text-zinc-900 disabled:cursor-not-allowed disabled:hover:bg-transparent">−</button>
        <input id={id} type="number" inputMode="numeric" min={min} max={max} value={value} disabled={disabled}
          onChange={e => onChange(e.target.value === '' ? '' : +e.target.value)} onBlur={e => set(e.target.value)}
          className="w-full min-w-0 bg-transparent text-center font-mono text-[13px] text-zinc-900 outline-none [appearance:textfield] disabled:cursor-not-allowed [&::-webkit-inner-spin-button]:appearance-none" />
        <button type="button" aria-label="Tăng" disabled={disabled || value >= max} onClick={() => set(value + 1)}
          className="w-8 text-zinc-600 transition hover:bg-zinc-200/70 hover:text-zinc-900 disabled:cursor-not-allowed disabled:hover:bg-transparent">+</button>
      </div>
    );
  }

  const Kbd = ({ children }) => (
    <kbd className="inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-zinc-300 bg-zinc-100 px-1.5 font-mono text-[10.5px] text-zinc-700 shadow-[inset_0_-1px_0_rgba(255,255,255,.9)]">
      {children}
    </kbd>
  );

  // ---------- Thông báo nổi ----------
  const TOAST = {
    ok: ['CircleCheck', 'text-emerald-700', 'border-emerald-600/25'],
    info: ['Info', 'text-sky-700', 'border-zinc-300'],
    warn: ['TriangleAlert', 'text-amber-700', 'border-amber-600/30'],
    err: ['CircleX', 'text-red-700', 'border-red-500/30'],
  };
  function useToasts() {
    const [toasts, setToasts] = useState([]);
    const last = useRef({ key: '', at: 0 });
    const push = useCallback((title, message = '', kind = 'info') => {
      const key = kind + title + String(message).replace(/\(\d+\/\d+\)/g, '');
      const now = performance.now();
      if (key === last.current.key && now - last.current.at < 10000) return;   // gộp lỗi lặp lại
      last.current = { key, at: now };
      const id = now + Math.random();
      setToasts(t => [...t.slice(-3), { id, title, message, kind }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 5000);
    }, []);
    const dismiss = useCallback(id => setToasts(t => t.filter(x => x.id !== id)), []);
    return [toasts, push, dismiss];
  }
  function Toasts({ toasts, onDismiss }) {
    return (
      <div aria-live="polite" className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:right-6 sm:w-[380px]">
        {toasts.map(t => {
          const [icon, color, border] = TOAST[t.kind] || TOAST.info;
          return (
            <div key={t.id} role="status"
              className={cx('fade-up pointer-events-auto flex w-full items-start gap-3 rounded-xl border bg-[#ffffff]/95 p-3.5 shadow-2xl shadow-zinc-900/10 backdrop-blur', border)}>
              <Icon name={icon} size={18} className={cx('mt-0.5 shrink-0', color)} />
              <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-zinc-900">{t.title}</div>
                {t.message && <p className="mt-0.5 break-words text-xs leading-5 text-zinc-600">{t.message}</p>}
              </div>
              <button type="button" aria-label="Đóng" onClick={() => onDismiss(t.id)} className="text-zinc-500 transition hover:text-zinc-800">
                <Icon name="X" size={14} />
              </button>
            </div>
          );
        })}
      </div>
    );
  }

  /** Re-render định kỳ (đồng hồ đếm ngược, thời gian hoạt động). */
  function useNow(ms = 1000) {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
      const t = setInterval(() => setNow(Date.now()), ms);
      return () => clearInterval(t);
    }, [ms]);
    return now;
  }

  GH.ui = { cx, Icon, Card, CardHeader, SectionHeader, Button, Segmented, Toggle, StatusDot, StateChip, Slider, Field, INPUT, Stepper, Kbd, useToasts, Toasts, useNow };
})();
