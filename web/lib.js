/* Nhà kính thông minh — tiện ích dùng chung (không phụ thuộc React): gọi API, định dạng số, giải mã khung Modbus, tô màu code. */
(() => {
  const GH = (window.GH = window.GH || {});

  // ---------- Gọi API của chương trình Python ----------
  async function api(path, body) {
    const opt = body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(path, opt);
    if (res.status === 401) { location.href = '/login'; throw new Error('Phiên đăng nhập đã hết hạn'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.message || `Lỗi ${res.status}`);
    return data;
  }

  // ---------- Định dạng ----------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const pad2 = n => String(n).padStart(2, '0');
  const fmt1 = v => (v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(1));
  const num = v => String(+(+v).toFixed(1));
  const clock = ms => { const d = new Date(ms); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  function duration(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${pad2(m)}:${pad2(s)}` : `${pad2(m)}:${pad2(s)}`;
  }
  const hx = (v, n = 2) => '0x' + v.toString(16).toUpperCase().padStart(n, '0');

  // ---------- Luật tự động (khớp rule_wants() bên Python) ----------
  const isRising = rule => rule.on > rule.off;
  function ruleZone(rule, value) {
    if (value == null) return 'unknown';
    if (isRising(rule)) return value >= rule.on ? 'on' : value <= rule.off ? 'off' : 'hold';
    return value <= rule.on ? 'on' : value >= rule.off ? 'off' : 'hold';
  }

  // ---------- Modbus RTU ----------
  function crc16(bytes) {
    let crc = 0xFFFF;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >> 1) ^ 0xA001 : crc >> 1;
    }
    return crc;
  }
  const FC_SHORT = { 1: 'FC01 · đọc coil', 3: 'FC03 · đọc holding', 4: 'FC04 · đọc input', 5: 'FC05 · ghi coil', 6: 'FC06 · ghi thanh ghi', 16: 'FC10 · ghi nhiều thanh ghi' };
  const FC_NAME = { 1: 'Read Coils', 3: 'Read Holding Registers', 4: 'Read Input Registers', 5: 'Write Single Coil', 6: 'Write Single Register', 16: 'Write Multiple Registers' };
  const EXC_NAME = { 1: 'Illegal Function', 2: 'Illegal Data Address', 3: 'Illegal Data Value', 4: 'Slave Device Failure' };

  function frameTag(hex) {
    if (!hex) return '';
    const fc = parseInt(hex.split(' ')[1], 16);
    return fc & 0x80 ? `Exception · FC${pad2(fc & 0x7f)}` : (FC_SHORT[fc] || `FC ${hx(fc)}`);
  }

  /** Tách khung thành các trường {a, z, role, label, value}; meta = /api/info (hệ số chia, giá trị relay). */
  function decodeFrame(hex, dir, meta) {
    const b = hex.trim().split(/\s+/).map(x => parseInt(x, 16)), n = b.length;
    if (n < 4) return null;
    const m = meta || {};
    const w = i => (b[i] << 8) | b[i + 1];
    const f = [{ a: 0, z: 1, role: 'id', label: 'Slave ID', value: `${b[0]}` }];
    const fc = b[1];
    if (fc & 0x80) {
      f.push({ a: 1, z: 2, role: 'fc', label: 'Function', value: `${hx(fc)} · Exception của FC${pad2(fc & 0x7f)}` });
      f.push({ a: 2, z: 3, role: 'data', label: 'Mã lỗi', value: `${hx(b[2])} · ${EXC_NAME[b[2]] || 'Không xác định'}` });
    } else {
      f.push({ a: 1, z: 2, role: 'fc', label: 'Function', value: `${hx(fc)} · ${FC_NAME[fc] || 'Không rõ'}` });
      if ((dir === 'tx' || fc === 5 || fc === 6 || fc === 16) && n >= 8) {
        const addr = w(2), v = w(4);
        const isCoil = fc === 1 || fc === 5;
        f.push({ a: 2, z: 4, role: 'addr', label: isCoil ? 'Địa chỉ coil' : 'Địa chỉ thanh ghi',
          value: `${hx(addr, 4)} (${addr})${fc === 1 || fc === 5 || fc === 6 ? ` · kênh ${addr + 1}` : ''}` });
        let label = 'Số lượng', value = `${v}`;
        if (fc === 5) { label = 'Giá trị'; value = v === 0xFF00 ? 'ON · 0xFF00' : v === 0 ? 'OFF · 0x0000' : hx(v, 4); }
        else if (fc === 6) {
          label = 'Giá trị';
          value = `${hx(v, 4)} (${v})${v === m.relay_on_value ? ' · lệnh BẬT relay' : v === m.relay_off_value ? ' · lệnh TẮT relay' : ''}`;
        }
        f.push({ a: 4, z: 6, role: 'data', label, value });
      } else if (dir === 'rx') {
        const bc = b[2];
        f.push({ a: 2, z: 3, role: 'addr', label: 'Số byte dữ liệu', value: `${bc}` });
        if (fc === 1) {
          const bits = [];
          for (let i = 0; i < Math.min(8, bc * 8); i++) bits.push((b[3 + (i >> 3)] >> (i & 7)) & 1);
          f.push({ a: 3, z: 3 + bc, role: 'data', label: 'Trạng thái coil', value: `${bits.join(' ')} · relay ${bits[0] ? 'BẬT' : 'TẮT'}` });
        } else {
          for (let i = 0; i + 1 < bc; i += 2) {
            const v = w(3 + i);
            let note = '';
            if (i === 0 && m.temp_divisor) note = ` → nhiệt độ ${fmt1((v & 0x8000 ? v - 0x10000 : v) / m.temp_divisor + m.temp_offset)} °C`;
            if (i === 2 && m.humi_divisor) note = ` → độ ẩm ${fmt1(v / m.humi_divisor + m.humi_offset)} %RH`;
            f.push({ a: 3 + i, z: 5 + i, role: 'data', label: `Thanh ghi ${i / 2 + 1}`, value: `${hx(v, 4)} = ${v}${note}` });
          }
        }
      }
    }
    const crc = (b[n - 1] << 8) | b[n - 2];
    const ok = crc16(b.slice(0, n - 2)) === crc;
    f.push({ a: n - 2, z: n, role: 'crc', label: 'CRC-16', value: `${hx(crc, 4)} · ${ok ? 'hợp lệ' : 'SAI'} · byte thấp gửi trước` });
    return { b, f };
  }

  GH.lib = { api, clamp, pad2, fmt1, num, clock, duration, hx, isRising, ruleZone, crc16, frameTag, decodeFrame };
})();
