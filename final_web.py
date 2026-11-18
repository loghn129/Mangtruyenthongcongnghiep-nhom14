"""
Nhà kính thông minh: đọc cảm biến Kongtrolink SRD-THT-12R, điều khiển bơm 12V và quạt 12V qua relay RS485.
Lệnh điều khiển, tài khoản, phân quyền, nhật ký hoạt động và lịch sử lấy từ newcode/light/changebaud.py.
Giao diện React (Tailwind + Lucide, tải từ CDN — máy mở trang web cần Internet) nằm trong thư mục web/ cạnh file này.

Chạy:  pip install flask pymodbus pyserial   ->   python final_web.py
Mở:    http://127.0.0.1:5000   (máy khác trong LAN: http://<IP máy>:5000)
Lần chạy đầu: mật khẩu tài khoản admin được in ra cửa sổ dòng lệnh. Quên mật khẩu: python final_web.py --reset-admin
"""
import copy
import csv
import inspect
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import struct
import threading
import time
from collections import deque
from datetime import datetime, timedelta
from contextlib import contextmanager

import serial.tools.list_ports
from flask import Flask, Response, g, jsonify, redirect, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash
from pymodbus.client import ModbusSerialClient

# ======================= CẤU HÌNH (giống final.py) =======================
PORT = "COM8"            # cổng USB-RS485 mặc định (đổi được trên giao diện)
BAUDRATE = 9600           # cố định cho cả cảm biến và relay (không chỉnh trên giao diện)
POLL_SECONDS = 2

# --- Cảm biến Kongtrolink SRD-THT-12R (theo manual hdsd_kronglink.docx) ---
SENSOR_ID = 1
SENSOR_FUNCTION = 3      # FC03: đọc holding register (như read_xy_md02.py)
SENSOR_ADDRESS = 0x0001  # đọc 2 thanh ghi từ địa chỉ 1: [0] = nhiệt độ, [1] = độ ẩm
TEMP_DIVISOR = 100       # nhiệt độ = raw / 100   (theo read_xy_md02.py)
HUMI_DIVISOR = 100       # độ ẩm    = raw / 100   (theo read_xy_md02.py)
TEMP_OFFSET = 0.0        # không cộng/trừ thêm
HUMI_OFFSET = 0.0

# --- Relay RS485 điều khiển bơm ---  (PHẢI đối chiếu manual của relay)
RELAY_ID = 2           # theo manual: địa chỉ mặc định của relay là 0xFF (255); khác SENSOR_ID
RELAY_MODE = "coil"      # "coil"     -> function 0x05 (ghi coil)
                         # "register" -> function 0x06 (ghi thanh ghi)
RELAY_ADDRESS = 0x0001   # kênh relay nối với bơm: bơm ở KÊNH 2 -> địa chỉ 1 (trên giao diện: kênh = địa chỉ + 1)
RELAY_ON_VALUE = 1       # chỉ dùng khi RELAY_MODE = "register"
RELAY_OFF_VALUE = 0

# --- Quạt 12V (cùng module relay với bơm) ---
FAN_CHANNEL = 1          # quạt ở KÊNH 1 của relay (địa chỉ 0); phải khác kênh bơm
MAX_FAN_SECONDS = 0      # chế độ bằng tay: tự tắt quạt sau tối đa N giây (0 = không giới hạn)

# --- Ngưỡng tự động mặc định (đều chỉnh được trên giao diện) ---
# Bơm: ngưỡng NHIỆT ĐỘ là T_ON / T_OFF ở phần "Chế độ tự động" ngay bên dưới (giữ nguyên như bản gốc)
PUMP_H_ON, PUMP_H_OFF = 40.0, 50.0   # bơm, luật độ ẩm (mặc định TẮT): BẬT khi RH <= 40, TẮT khi RH >= 50
FAN_T_ON, FAN_T_OFF = 30.0, 28.0     # quạt, luật nhiệt độ: BẬT khi T >= 30, TẮT khi T <= 28
FAN_H_ON, FAN_H_OFF = 80.0, 70.0     # quạt, luật độ ẩm (mặc định TẮT): BẬT khi RH >= 80, TẮT khi RH <= 70

# --- Đổi ID thiết bị ngay trên web (PHẢI đối chiếu manual của từng thiết bị) ---
SENSOR_ID_REGISTER = 0x0000   # SRD-THT-12R: thanh ghi 0x0000 = Slave ID (1–247), ghi bằng FC06; phải tắt/bật nguồn để áp dụng
# (baudrate của cảm biến nằm ở thanh ghi 0x0003: 0=4800, 1=9600, 2=14400, 3=19200, 4=38400, 5=56000, 6=57600, 7=115200)
RELAY_ID_REGISTER = 0x0000    # module relay (địa chỉ mặc định 0xFF): thanh ghi 0x0000 = địa chỉ thiết bị, ghi bằng FC10
RELAY_ID_BROADCAST = True     # theo manual relay: lệnh đổi ID gửi tới địa chỉ broadcast 0x00 (module nào trên bus cũng nhận!)
ID_CHANGE_SETTLE = 0.4        # giây chờ thiết bị ghi nhớ ID mới trước khi kiểm tra lại

# --- Tài khoản / phân quyền / lịch sử (lưu trong file SQLite cạnh file .py) ---
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.path.join(BASE_DIR, "data.db")        # tài khoản (mật khẩu đã băm), nhật ký hoạt động, lịch sử cảm biến
SECRET_FILE = os.path.join(BASE_DIR, "secret.key") # khoá ký cookie đăng nhập (tự tạo lần đầu, KHÔNG chia sẻ file này)
SESSION_HOURS = 12            # đăng nhập hết hạn sau bấy nhiêu giờ
COOKIE_SECURE = False         # đặt True khi chỉ truy cập qua HTTPS (ví dụ Cloudflare Tunnel) để cookie chỉ đi qua HTTPS
MIN_PASSWORD_LEN = 8
LOGIN_MAX_FAILS = 5           # sai quá số lần này -> khoá tài khoản đó tạm thời
LOGIN_LOCK_SECONDS = 300
HISTORY_SAVE_SECONDS = 30     # chu kỳ lưu nhiệt độ / độ ẩm vào cơ sở dữ liệu
READINGS_KEEP_DAYS = 30       # giữ lịch sử cảm biến bao nhiêu ngày
EVENTS_KEEP_DAYS = 180        # giữ nhật ký hoạt động bao nhiêu ngày
SIGNUP_KEEP_DAYS = 14         # yêu cầu cấp tài khoản không được duyệt sẽ tự xoá sau bấy nhiêu ngày
SIGNUP_MAX_PENDING = 20       # tối đa số yêu cầu đang chờ duyệt (chống spam)
SIGNUP_MAX_PER_IP_HOUR = 3    # mỗi IP được gửi tối đa bấy nhiêu yêu cầu / giờ

# --- Chế độ tự động (giao diện có thanh trượt ngưỡng) ---
T_ON = 32.0              # T >= ngưỡng -> BẬT bơm
T_OFF = 30.0             # T <= ngưỡng -> TẮT bơm (vùng trễ giữ nguyên trạng thái)
MIN_SWITCH_SECONDS = 5   # chống bật/tắt liên tục làm hỏng bơm và tiếp điểm relay
MAX_SENSOR_FAILS = 3     # mất cảm biến quá số lần này liên tiếp -> tắt bơm an toàn

# --- An toàn ---
MAX_PUMP_SECONDS = 600   # chế độ bằng tay: tự tắt bơm sau tối đa 10 phút, tránh bơm chạy khô/quên tắt
HISTORY_POINTS = 900     # số điểm giữ cho biểu đồ
WEB_PORT = 5000
# =========================================================

def default_auto_cfg():
    """Luật tự động mặc định. Bơm: luật nhiệt độ dùng ngưỡng T_ON/T_OFF gốc (chỉ lưu cờ dùng/không dùng)."""
    return {
        "pump": {"t": {"use": True},
                 "h": {"use": False, "dir": "low", "on": PUMP_H_ON, "off": PUMP_H_OFF}},
        "fan": {"t": {"use": True, "dir": "high", "on": FAN_T_ON, "off": FAN_T_OFF},
                "h": {"use": False, "dir": "high", "on": FAN_H_ON, "off": FAN_H_OFF}},
    }


def load_secret_key():
    """Khoá ký cookie: đọc từ secret.key, chưa có thì tạo ngẫu nhiên và lưu lại (giữ đăng nhập qua các lần khởi động lại)."""
    try:
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if len(key) >= 32:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    with open(SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    return key


WEB_DIR = os.path.join(BASE_DIR, "web")
app = Flask(__name__, static_folder=WEB_DIR, static_url_path="/static")
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=COOKIE_SECURE,
    PERMANENT_SESSION_LIFETIME=timedelta(hours=SESSION_HOURS),
)
client = None                        # ModbusSerialClient, tạo khi nhấn Kết nối trên giao diện
bus_lock = threading.RLock()          # RS485 chỉ cho một giao dịch tại một thời điểm
state_lock = threading.Lock()        # bảo vệ state / logs / history (đọc từ nhiều luồng HTTP)
connect_lock = threading.Lock()
stop_event = threading.Event()
read_now = threading.Event()         # đổi chế độ / ngưỡng -> đọc cảm biến ngay
worker = None

# pymodbus <3.10 dùng slave=, >=3.10 dùng device_id=
_UNIT_KW = "device_id" if "device_id" in inspect.signature(
    ModbusSerialClient.read_holding_registers).parameters else "slave"

state = {
    "connected": False, "link": "",
    "status": "idle", "status_text": "Chưa kết nối",     # idle | ok | error | lost
    "auto": False,                                        # final.py điều khiển tay -> mặc định Bằng tay
    "t_on": T_ON, "t_off": T_OFF, "interval": POLL_SECONDS,
    "temperature": None, "humidity": None,
    "raw_temp": None, "raw_hum": None,
    "pump": None, "pump_off_at": None, "updated": None,
    "fan": None, "fan_off_at": None, "auto_cfg": default_auto_cfg(),
    "tx": 0, "rx": 0, "err": 0,
    "config": {"link": "COM", "port": PORT, "baud": BAUDRATE, "sht20_id": SENSOR_ID,
               "relay_id": RELAY_ID, "channel": RELAY_ADDRESS + 1, "fan_channel": FAN_CHANNEL,
               "relay_mode": "reg" if RELAY_MODE == "register" else "coil"},
}
history = deque(maxlen=HISTORY_POINTS)   # [thời_gian_ms, nhiệt_độ, độ_ẩm, bơm_bật, quạt_bật]
logs = deque(maxlen=600)
log_seq = 0
last_switch = {"pump": float("-inf"), "fan": float("-inf")}
DEVICE_NAME = {"pump": "bơm", "fan": "quạt"}


# ======================= NHẬT KÝ =======================

def log(text, level="info", hex_frame=None):
    global log_seq
    with state_lock:
        log_seq += 1
        entry = {"id": log_seq, "t": datetime.now().strftime("%H:%M:%S"), "level": level, "text": text}
        if hex_frame is not None:
            entry["hex"] = hex_frame
        logs.append(entry)


def log_error(text):
    with state_lock:
        state["err"] += 1
        state["status"] = "error"
        state["status_text"] = "Lỗi truyền thông"
    log(text, "err")


def crc16(data: bytes) -> bytes:
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return data + bytes([crc & 0xFF, crc >> 8])


def rx_frame(tx: bytes, rr) -> bytes:
    """pymodbus không trả khung thô -> dựng lại khung RTU phản hồi để hiển thị trong nhật ký."""
    if rr is None:
        return b""
    code = getattr(rr, "exception_code", None)
    if code is not None:
        return crc16(bytes([tx[0], tx[1] | 0x80, code]))
    if rr.isError():
        return b""                                   # không phản hồi (timeout)
    if tx[1] in (3, 4):
        data = struct.pack(f">{len(rr.registers)}H", *rr.registers)
        return crc16(bytes([tx[0], tx[1], len(data)]) + data)
    if tx[1] == 1:                                    # FC01: dựng lại khung đọc coil
        count = struct.unpack(">H", tx[4:6])[0]
        data = bytearray((count + 7) // 8)
        for i, bit in enumerate(rr.bits[:count]):
            if bit:
                data[i >> 3] |= 1 << (i & 7)
        return crc16(bytes([tx[0], 1, len(data)]) + bytes(data))
    if tx[1] == 0x10:                                 # FC10: slave trả lại địa chỉ đầu + số thanh ghi
        return crc16(tx[:6])
    return tx                                         # FC05 / FC06: slave gửi lại đúng khung yêu cầu


def hex_text(frame: bytes) -> str:
    return " ".join(f"{b:02X}" for b in frame)


def transact(tx: bytes, call):
    """Một giao dịch Modbus trên bus: gọi hàm pymodbus, ghi TX/RX vào nhật ký."""
    with bus_lock:
        ensure_connected()
        rr = None
        try:
            rr = call()
        finally:
            rx = rx_frame(tx, rr)
            with state_lock:
                state["tx"] += 1
                state["rx"] += 1 if rx else 0
            log("", "tx", hex_text(tx))
            log("", "rx", hex_text(rx))       # chuỗi rỗng = slave không phản hồi
    if rr.isError():
        raise IOError(str(rr))
    return rr


# ======================= ĐIỀU KHIỂN (theo final.py) =======================

def ensure_connected():
    if client is None:
        raise ConnectionError("Chưa kết nối")
    if not client.connected and not client.connect():
        raise ConnectionError(f"Không mở được cổng {state['config']['port']}")


def read_sensor():
    with bus_lock:     # đọc ID cấu hình + giao dịch trong cùng một lần khoá (tránh lệch khi vừa đổi ID)
        sid = state["config"]["sht20_id"]
        reader = (client.read_input_registers if SENSOR_FUNCTION == 4
                  else client.read_holding_registers)
        tx = crc16(struct.pack(">BBHH", sid, SENSOR_FUNCTION, SENSOR_ADDRESS, 2))
        rr = transact(tx, lambda: reader(address=SENSOR_ADDRESS, count=2, **{_UNIT_KW: sid}))
    raw_t, raw_h = rr.registers
    t_signed = raw_t - 65536 if raw_t >= 32768 else raw_t
    t = round(t_signed / TEMP_DIVISOR + TEMP_OFFSET, 1)
    h = round(raw_h / HUMI_DIVISOR + HUMI_OFFSET, 1)
    return raw_t, raw_h, t, h


def device_channel(dev):
    cfg = state["config"]
    return cfg["channel"] if dev == "pump" else cfg["fan_channel"]


def set_device(dev, on: bool):
    """Bật/tắt một thiết bị nối vào relay: dev = "pump" (kênh bơm) hoặc "fan" (kênh quạt)."""
    with bus_lock:
        cfg = state["config"]
        rid, address = cfg["relay_id"], device_channel(dev) - 1
        if cfg["relay_mode"] == "coil":
            tx = crc16(struct.pack(">BBHH", rid, 5, address, 0xFF00 if on else 0x0000))
            transact(tx, lambda: client.write_coil(address, on, **{_UNIT_KW: rid}))
        else:
            value = RELAY_ON_VALUE if on else RELAY_OFF_VALUE
            tx = crc16(struct.pack(">BBHH", rid, 6, address, value))
            transact(tx, lambda: client.write_register(address, value, **{_UNIT_KW: rid}))
    with state_lock:
        state[dev] = on
        if not on:
            state[dev + "_off_at"] = None
    last_switch[dev] = time.monotonic()


def set_relay(on: bool):
    """Giữ tên hàm gốc: điều khiển BƠM."""
    set_device("pump", on)


def rule_vote(value, r):
    """Một luật có vùng trễ. True = BẬT, False = TẮT, None = vùng trễ (giữ nguyên trạng thái).
    dir "high": BẬT khi giá trị >= on, TẮT khi <= off.   dir "low": BẬT khi giá trị <= on, TẮT khi >= off."""
    if r["dir"] == "high":
        if value >= r["on"]:
            return True
        if value <= r["off"]:
            return False
    else:
        if value <= r["on"]:
            return True
        if value >= r["off"]:
            return False
    return None


def auto_device(dev, t, h):
    """Quyết định bật/tắt một thiết bị theo các luật đang dùng (nhiệt độ và/hoặc độ ẩm):
    BẬT khi BẤT KỲ luật nào đạt điều kiện BẬT; TẮT khi MỌI luật đang dùng đều ở vùng TẮT; còn lại giữ nguyên."""
    with state_lock:
        cfg = state["auto_cfg"][dev]
        t_rule = dict(cfg["t"])
        if dev == "pump":     # bơm: ngưỡng nhiệt độ lấy từ thanh trượt gốc (t_on / t_off), luôn "bật khi nóng"
            t_rule.update(dir="high", on=state["t_on"], off=state["t_off"])
        h_rule = dict(cfg["h"])
        current = state[dev]
    votes, parts = [], []
    for rule, value, label, unit in ((t_rule, t, "T", "°C"), (h_rule, h, "RH", "%")):
        if not rule["use"]:
            continue
        vote = rule_vote(value, rule)
        votes.append(vote)
        if vote is None:
            parts.append(f"{label} = {value:.1f} {unit}, vùng trễ")
        else:
            high = rule["dir"] == "high"
            op = ("≥" if high else "≤") if vote else ("≤" if high else "≥")
            parts.append(f"{label} = {value:.1f} {unit} {op} {rule['on' if vote else 'off']:g}")
    if not votes:
        return                # không luật nào được dùng -> giữ nguyên trạng thái
    if any(v is True for v in votes):
        want = True
    elif all(v is False for v in votes):
        want = False
    else:
        want = bool(current)
    if want == current:
        return
    if current is not None and time.monotonic() - last_switch[dev] < MIN_SWITCH_SECONDS:
        return
    set_device(dev, want)
    msg = f"Tự động {'BẬT' if want else 'TẮT'} {DEVICE_NAME[dev]} ({'; '.join(parts)})"
    log(msg, "ok")
    db_event("(tự động)", "Tự động " + DEVICE_NAME[dev], msg)


def auto_control(t, h=None):
    """Chế độ tự động cho quạt và bơm. Bơm với luật nhiệt độ mặc định chạy đúng như bản gốc:
    T >= t_on -> BẬT, T <= t_off -> TẮT, ở giữa giữ nguyên."""
    for dev in ("fan", "pump"):
        try:
            auto_device(dev, t, h)
        except Exception as e:
            log_error(f"Relay {DEVICE_NAME[dev]}: {type(e).__name__}: {e}")


# ======================= ĐỔI ID THIẾT BỊ =======================

def probe_id(dev, uid):
    """Thử đọc thiết bị ở ID uid; True nếu có phản hồi hợp lệ."""
    cfg = state["config"]
    try:
        if dev == "sht20":
            reader = (client.read_input_registers if SENSOR_FUNCTION == 4
                      else client.read_holding_registers)
            tx = crc16(struct.pack(">BBHH", uid, SENSOR_FUNCTION, SENSOR_ADDRESS, 2))
            transact(tx, lambda: reader(address=SENSOR_ADDRESS, count=2, **{_UNIT_KW: uid}))
        elif cfg["relay_mode"] == "coil":
            address = cfg["channel"] - 1
            tx = crc16(struct.pack(">BBHH", uid, 1, address, 1))
            transact(tx, lambda: client.read_coils(address, count=1, **{_UNIT_KW: uid}))
        else:
            address = cfg["channel"] - 1
            tx = crc16(struct.pack(">BBHH", uid, 3, address, 1))
            transact(tx, lambda: client.read_holding_registers(address, count=1, **{_UNIT_KW: uid}))
        return True
    except Exception:
        return False


def change_device_id(dev, new_id):
    """Ghi ID mới vào thiết bị rồi đọc lại để kiểm tra. Trả về (đã_áp_dụng, thông_báo).
    Giữ khoá bus suốt quá trình nên luồng đọc nền không chen vào giữa."""
    with bus_lock:
        ensure_connected()
        cfg = state["config"]
        key = "sht20_id" if dev == "sht20" else "relay_id"
        other = cfg["relay_id" if dev == "sht20" else "sht20_id"]
        old_id = cfg[key]
        name = "cảm biến SRD-THT-12R" if dev == "sht20" else "module relay"
        if new_id == old_id:
            raise ValueError(f"ID mới trùng ID hiện tại ({old_id})")
        if new_id == other:
            raise ValueError("ID mới trùng ID của thiết bị còn lại trên bus (SRD-THT-12R và relay phải khác ID)")
        if dev == "sht20":
            tx = crc16(struct.pack(">BBHH", old_id, 6, SENSOR_ID_REGISTER, new_id))
            send = lambda: client.write_register(SENSOR_ID_REGISTER, new_id, **{_UNIT_KW: old_id})
        else:
            unit = 0 if RELAY_ID_BROADCAST else old_id
            tx = crc16(struct.pack(">BBHHB", unit, 0x10, RELAY_ID_REGISTER, 1, 2) + struct.pack(">H", new_id))
            send = lambda: client.write_registers(RELAY_ID_REGISTER, [new_id], **{_UNIT_KW: unit})
        log(f"Đổi ID {name}: {old_id} → {new_id}", "warn")
        try:
            transact(tx, send)
        except Exception as e:     # broadcast có thể không có phản hồi -> vẫn kiểm tra lại bằng cách đọc ở ID mới
            log(f"Không nhận được phản hồi lệnh đổi ID ({type(e).__name__}: {e}) — kiểm tra lại ở ID mới", "warn")
        time.sleep(ID_CHANGE_SETTLE)
        if probe_id(dev, new_id):
            with state_lock:
                state["config"] = dict(state["config"], **{key: new_id})
            msg = f"Đã đổi ID {name}: {old_id} → {new_id} (thiết bị đã trả lời ở ID mới)"
            log(msg, "ok")
            return True, msg
        if probe_id(dev, old_id):
            msg = (f"Đã gửi lệnh nhưng {name} vẫn trả lời ở ID cũ {old_id}. Nếu thiết bị chỉ áp dụng ID mới sau khi "
                   f"cấp nguồn lại: tắt/bật nguồn {name}, bấm Ngắt kết nối rồi Kết nối lại với ID {new_id}.")
            log(msg, "warn")
            return False, msg
        msg = (f"Không thấy {name} trả lời ở cả ID cũ ({old_id}) lẫn ID mới ({new_id}) — kiểm tra nguồn / dây A-B; "
               f"nếu đã đổi thành công thì ngắt kết nối và kết nối lại với ID {new_id}.")
        log_error(msg)
        raise IOError(msg)


def background_loop():
    fails = 0
    next_read = 0.0
    try:
        while not stop_event.is_set():
            if read_now.is_set():
                read_now.clear()
                next_read = 0.0

            # --- đọc cảm biến ---
            if time.monotonic() >= next_read:
                next_read = time.monotonic() + state["interval"]
                try:
                    raw_t, raw_h, t, h = read_sensor()
                    fails = 0
                    if state["auto"]:
                        try:
                            auto_control(t, h)
                        except Exception as e:
                            log_error(f"Relay: {type(e).__name__}: {e}")
                    now = datetime.now()
                    with state_lock:
                        state.update(
                            temperature=t, humidity=h, raw_temp=raw_t, raw_hum=raw_h,
                            updated=now.strftime("%H:%M:%S"),
                            status="ok", status_text=f"Đã kết nối {state['link']}",
                        )
                        history.append([int(now.timestamp() * 1000), t, h, bool(state["pump"]), bool(state["fan"])])
                    save_reading(now, t, h)
                except Exception as e:
                    fails += 1
                    log_error(f"SRD-THT-12R: {type(e).__name__}: {e} ({fails}/{MAX_SENSOR_FAILS})")
                    if state["auto"] and fails >= MAX_SENSOR_FAILS:
                        for dev in ("pump", "fan"):
                            if state[dev] is not False:
                                try:
                                    set_device(dev, False)
                                    log(f"Mất tín hiệu cảm biến → TẮT {DEVICE_NAME[dev]} để an toàn", "warn")
                                except Exception as e2:
                                    log_error(f"Relay: không tắt được {DEVICE_NAME[dev]}: {e2}")

            # --- hẹn giờ tự tắt bơm ---
            off_at = state["pump_off_at"]
            if state["pump"] and off_at and time.time() >= off_at:
                try:
                    set_relay(False)
                    log(f"Hết {MAX_PUMP_SECONDS} s → tự TẮT bơm", "warn")
                except Exception as e:
                    log_error(f"Relay: {type(e).__name__}: {e}")

            # --- hẹn giờ tự tắt quạt (chỉ khi MAX_FAN_SECONDS > 0) ---
            off_at = state["fan_off_at"]
            if state["fan"] and off_at and time.time() >= off_at:
                try:
                    set_device("fan", False)
                    log("Hết thời gian hẹn → tự TẮT quạt", "warn")
                except Exception as e:
                    log_error(f"Relay: {type(e).__name__}: {e}")

            stop_event.wait(0.1)
    finally:
        off_ok = {}
        for dev in ("pump", "fan"):      # luôn tắt bơm và quạt khi ngắt kết nối
            try:
                set_device(dev, False)
                off_ok[dev] = True
                log(f"Đã TẮT {DEVICE_NAME[dev]} trước khi ngắt kết nối")
            except Exception as e:
                off_ok[dev] = False
                log_error(f"Không tắt được {DEVICE_NAME[dev]} khi ngắt kết nối: {e} → hãy ngắt nguồn {DEVICE_NAME[dev]} bằng tay!")
        client.close()
        with state_lock:
            state.update(connected=False,
                         pump=False if off_ok["pump"] else None, pump_off_at=None,
                         fan=False if off_ok["fan"] else None, fan_off_at=None,
                         status="idle", status_text="Chưa kết nối")
        log("Đã ngắt kết nối")


# ======================= KIỂM TRA DỮ LIỆU TỪ TRÌNH DUYỆT =======================

def get_int(data, key, lo, hi, label):
    try:
        value = int(data.get(key))
    except (TypeError, ValueError):
        value = None
    if value is None or not lo <= value <= hi:
        raise ValueError(f"{label} phải là số nguyên từ {lo} đến {hi}")
    return value


def get_settings(data):
    try:
        t_on, t_off, interval = float(data["t_on"]), float(data["t_off"]), float(data["interval"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Ngưỡng nhiệt độ và chu kỳ đọc phải là số")
    if not -40 <= t_off < t_on <= 125:
        raise ValueError("Cần -40 ≤ ngưỡng TẮT < ngưỡng BẬT ≤ 125 °C")
    if not 0.2 <= interval <= 3600:
        raise ValueError("Chu kỳ đọc phải từ 0.2 đến 3600 giây")
    return t_on, t_off, interval


def parse_rule(d, label, lo, hi):
    try:
        use, direction = bool(d["use"]), d["dir"]
        on, off = float(d["on"]), float(d["off"])
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"Ngưỡng {label} phải là số")
    if direction not in ("high", "low"):
        raise ValueError(f"Chiều tác động của {label} không hợp lệ")
    if not (lo <= on <= hi and lo <= off <= hi):
        raise ValueError(f"Ngưỡng {label} phải nằm trong khoảng {lo:g} … {hi:g}")
    if direction == "high" and not off < on:
        raise ValueError(f"{label}: bật khi ≥ thì ngưỡng TẮT phải nhỏ hơn ngưỡng BẬT")
    if direction == "low" and not on < off:
        raise ValueError(f"{label}: bật khi ≤ thì ngưỡng BẬT phải nhỏ hơn ngưỡng TẮT")
    return {"use": use, "dir": direction, "on": on, "off": off}


def parse_auto_cfg(data):
    try:
        pump, fan = data["pump"], data["fan"]
        pump_t_use = bool(pump["t"]["use"])
        pump_h, fan_t, fan_h = pump["h"], fan["t"], fan["h"]
    except (KeyError, TypeError):
        raise ValueError("Cấu hình tự động không hợp lệ")
    return {
        "pump": {"t": {"use": pump_t_use}, "h": parse_rule(pump_h, "độ ẩm của bơm", 0, 100)},
        "fan": {"t": parse_rule(fan_t, "nhiệt độ của quạt", -40, 125),
                "h": parse_rule(fan_h, "độ ẩm của quạt", 0, 100)},
    }


def describe_auto_cfg(cfg):
    def one(name, r):
        if not r["use"]:
            return f"{name} không dùng"
        high = r["dir"] == "high"
        return f"{name} BẬT {'≥' if high else '≤'} {r['on']:g} / TẮT {'≤' if high else '≥'} {r['off']:g}"
    pump_t = "nhiệt độ " + ("dùng (ngưỡng ở thẻ bơm)" if cfg["pump"]["t"]["use"] else "không dùng")
    return (f"Quạt: {one('nhiệt độ', cfg['fan']['t'])}; {one('độ ẩm', cfg['fan']['h'])} · "
            f"Bơm: {pump_t}; {one('độ ẩm', cfg['pump']['h'])}")


def reply(ok, message):
    return jsonify(ok=ok, message=message), 200 if ok else 400


# ======================= TÀI KHOẢN, PHÂN QUYỀN, NHẬT KÝ & LỊCH SỬ (SQLite) =======================

ROLE_RANK = {"viewer": 1, "operator": 2, "admin": 3}      # xem < điều khiển < quản trị
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{3,32}$")
PUBLIC_PATHS = {"/login", "/api/login", "/api/signup"}
ROUTE_ROLE = {                                              # quyền tối thiểu cho từng đường dẫn
    "/": "viewer", "/api/info": "viewer", "/api/state": "viewer", "/api/ports": "viewer", "/api/me": "viewer",
    "/api/history": "viewer", "/api/history.csv": "viewer", "/api/password": "viewer", "/api/logout": "viewer",
    "/api/pump": "operator", "/api/fan": "operator", "/api/mode": "operator", "/api/settings": "operator",
    "/api/autocfg": "operator", "/api/connect": "operator", "/api/disconnect": "operator",
    "/api/change_id": "admin", "/api/users": "admin", "/api/events": "admin", "/api/signups": "admin",
}
AUDIT_LABEL = {                                             # các thao tác được ghi vào nhật ký hoạt động
    "/api/pump": "Điều khiển bơm", "/api/fan": "Điều khiển quạt", "/api/mode": "Đổi chế độ",
    "/api/settings": "Đổi ngưỡng bơm / chu kỳ", "/api/autocfg": "Đổi luật tự động",
    "/api/connect": "Kết nối bus", "/api/disconnect": "Ngắt kết nối bus", "/api/change_id": "Đổi ID thiết bị",
    "/api/users": "Quản lý tài khoản", "/api/password": "Đổi mật khẩu",
}
SECRET_KEYS = {"password", "old", "new", "pw", "auto_cfg"}  # không ghi vào nhật ký
DUMMY_HASH = generate_password_hash("dummy")
signup_hits = {}                                            # ip -> thời điểm các yêu cầu đăng ký gần đây
signup_lock = threading.Lock()
login_fails = {}                                            # tên đăng nhập -> [số lần sai, khoá đến lúc]
login_lock = threading.Lock()
_last_save = 0.0
_last_prune = time.monotonic()


@contextmanager
def db():
    conn = sqlite3.connect(DB_FILE, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def init_db():
    with db() as c:
        c.execute("CREATE TABLE IF NOT EXISTS users(name TEXT PRIMARY KEY COLLATE NOCASE, pw TEXT NOT NULL, "
                  "role TEXT NOT NULL, created TEXT)")
        c.execute("CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT, user TEXT, "
                  "action TEXT, detail TEXT, ip TEXT, ok INTEGER)")
        c.execute("CREATE TABLE IF NOT EXISTS readings(t INTEGER PRIMARY KEY, temp REAL, humi REAL, "
                  "pump INTEGER, fan INTEGER)")
        c.execute("CREATE TABLE IF NOT EXISTS signups(id INTEGER PRIMARY KEY AUTOINCREMENT, "
                  "name TEXT COLLATE NOCASE, pw TEXT NOT NULL, created TEXT, ip TEXT)")
    prune_db()


def prune_db():
    cut_r = int((time.time() - READINGS_KEEP_DAYS * 86400) * 1000)
    cut_e = (datetime.now() - timedelta(days=EVENTS_KEEP_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    with db() as c:
        c.execute("DELETE FROM readings WHERE t < ?", (cut_r,))
        c.execute("DELETE FROM events WHERE t < ?", (cut_e,))
        cut_s = (datetime.now() - timedelta(days=SIGNUP_KEEP_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
        c.execute("DELETE FROM signups WHERE created < ?", (cut_s,))


def db_event(user, action, detail="", ip=None, ok=True):
    try:
        with db() as c:
            c.execute("INSERT INTO events(t, user, action, detail, ip, ok) VALUES(?,?,?,?,?,?)",
                      (now_text(), user, action, str(detail)[:400], ip, int(bool(ok))))
    except Exception as e:
        print(f"[cảnh báo] không ghi được nhật ký hoạt động: {e}")


def get_user(name):
    try:
        with db() as c:
            return c.execute("SELECT name, pw, role FROM users WHERE name = ?", (name,)).fetchone()
    except Exception:
        return None


def add_user(name, password, role):
    with db() as c:
        c.execute("INSERT INTO users(name, pw, role, created) VALUES(?,?,?,?)",
                  (name, generate_password_hash(password), role, now_text()))


def bootstrap_admin():
    """Lần chạy đầu (chưa có tài khoản nào): tạo admin với mật khẩu ngẫu nhiên, in ra màn hình MỘT lần."""
    with db() as c:
        n = c.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if n:
        return
    password = os.environ.get("WEB_ADMIN_PASSWORD") or secrets.token_urlsafe(9)
    add_user("admin", password, "admin")
    print("=" * 60)
    print(" ĐÃ TẠO TÀI KHOẢN QUẢN TRỊ ĐẦU TIÊN")
    print(f"   tên đăng nhập : admin")
    print(f"   mật khẩu      : {password}")
    print(" Hãy đăng nhập rồi đổi mật khẩu ngay (biểu tượng chìa khoá trên thanh trên).")
    print(" Quên mật khẩu: python final_web.py --reset-admin")
    print("=" * 60)


def reset_admin(password=None):
    password = password or secrets.token_urlsafe(9)
    pw_hash = generate_password_hash(password)
    with db() as c:
        if c.execute("SELECT 1 FROM users WHERE name = 'admin'").fetchone():
            c.execute("UPDATE users SET pw = ?, role = 'admin' WHERE name = 'admin'", (pw_hash,))
        else:
            c.execute("INSERT INTO users(name, pw, role, created) VALUES('admin', ?, 'admin', ?)",
                      (pw_hash, now_text()))
    print(f"Đã đặt lại tài khoản admin — mật khẩu mới: {password}")


def client_ip():
    # Sau Cloudflare Tunnel, remote_addr luôn là 127.0.0.1; IP thật nằm trong header này (chỉ dùng để GHI nhật ký)
    return request.headers.get("CF-Connecting-IP") or request.remote_addr or "?"


def save_reading(now, t, h):
    """Lưu một điểm lịch sử mỗi HISTORY_SAVE_SECONDS giây. Lỗi cơ sở dữ liệu không ảnh hưởng việc điều khiển."""
    global _last_save, _last_prune
    if time.monotonic() - _last_save < HISTORY_SAVE_SECONDS:
        return
    _last_save = time.monotonic()
    try:
        flag = lambda v: None if v is None else int(bool(v))
        with db() as c:
            c.execute("INSERT OR REPLACE INTO readings(t, temp, humi, pump, fan) VALUES(?,?,?,?,?)",
                      (int(now.timestamp() * 1000), t, h, flag(state["pump"]), flag(state["fan"])))
        if time.monotonic() - _last_prune > 6 * 3600:
            _last_prune = time.monotonic()
            prune_db()
    except Exception as e:
        log(f"Không lưu được lịch sử vào cơ sở dữ liệu: {e}", "warn")


@app.before_request
def check_access():
    path = request.path
    if path in PUBLIC_PATHS:
        return None
    need = ROUTE_ROLE.get(path)
    if need is None:
        return None                                   # đường dẫn không tồn tại -> Flask trả 404
    user = None
    name = session.get("user")
    if name:
        user = get_user(name)                         # đọc lại mỗi lần: đổi quyền / xoá tài khoản có hiệu lực ngay
        if user is None:
            session.clear()
    if user is None:
        if path.startswith("/api/"):
            return jsonify(ok=False, message="Chưa đăng nhập hoặc phiên đã hết hạn"), 401
        return redirect("/login")
    if ROLE_RANK[user["role"]] < ROLE_RANK[need]:
        return jsonify(ok=False, message="Tài khoản không đủ quyền cho thao tác này"), 403
    g.user_name, g.role = user["name"], user["role"]
    if request.method == "POST" and not request.is_json:
        return jsonify(ok=False, message="Yêu cầu không hợp lệ"), 400   # chặn form chéo trang (CSRF)
    return None


@app.after_request
def after_request(resp):
    resp.headers["Cache-Control"] = "no-store"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    if request.method == "POST" and request.path in AUDIT_LABEL and session.get("user"):
        body = request.get_json(silent=True)
        detail = ""
        if isinstance(body, dict):
            detail = json.dumps({k: v for k, v in body.items() if k not in SECRET_KEYS}, ensure_ascii=False)
        db_event(session["user"], AUDIT_LABEL[request.path], detail, client_ip(), resp.status_code < 400)
    return resp


def last_admin_guard(c, name):
    """True nếu `name` là admin duy nhất còn lại."""
    admins = c.execute("SELECT name FROM users WHERE role = 'admin'").fetchall()
    return len(admins) == 1 and admins[0]["name"].lower() == name.lower()


@app.route("/login")
def login_page():
    if session.get("user") and get_user(session["user"]):
        return redirect("/")
    return Response(LOGIN_HTML.replace("__MINPW__", str(MIN_PASSWORD_LEN)), mimetype="text/html")


@app.route("/api/login", methods=["POST"])
def api_login():
    body = request.get_json(silent=True) or {}
    name, password = str(body.get("name") or "").strip()[:64], str(body.get("password") or "")
    key, ip, now = name.lower(), client_ip(), time.time()
    with login_lock:
        fails, locked_until = login_fails.get(key, [0, 0.0])
        if locked_until > now:
            return jsonify(ok=False, message=f"Sai quá nhiều lần — thử lại sau {int(locked_until - now) + 1} giây"), 429
    user = get_user(name)
    if user:
        good = check_password_hash(user["pw"], password)
    else:
        check_password_hash(DUMMY_HASH, password)         # vẫn tốn thời gian tương đương khi sai tên đăng nhập
        good = False
    if not good:
        with login_lock:
            fails = login_fails.get(key, [0, 0.0])[0] + 1
            login_fails[key] = [fails, now + LOGIN_LOCK_SECONDS if fails >= LOGIN_MAX_FAILS else 0.0]
            if fails >= LOGIN_MAX_FAILS:
                login_fails[key][0] = 0
        db_event(name or "?", "Đăng nhập thất bại", "", ip, False)
        return jsonify(ok=False, message="Tên đăng nhập hoặc mật khẩu không đúng"), 401
    with login_lock:
        login_fails.pop(key, None)
    session.clear()
    session["user"] = user["name"]
    session.permanent = True
    db_event(user["name"], "Đăng nhập", "", ip, True)
    return jsonify(ok=True, user=user["name"], role=user["role"])


@app.route("/api/logout", methods=["POST"])
def api_logout():
    db_event(g.user_name, "Đăng xuất", "", client_ip(), True)
    session.clear()
    return reply(True, "Đã đăng xuất")


@app.route("/api/me")
def api_me():
    return jsonify(ok=True, user=g.user_name, role=g.role)


@app.route("/api/password", methods=["POST"])
def api_password():
    body = request.get_json(silent=True) or {}
    old, new = str(body.get("old") or ""), str(body.get("new") or "")
    user = get_user(g.user_name)
    if not user or not check_password_hash(user["pw"], old):
        return reply(False, "Mật khẩu hiện tại không đúng")
    if len(new) < MIN_PASSWORD_LEN:
        return reply(False, f"Mật khẩu mới phải có ít nhất {MIN_PASSWORD_LEN} ký tự")
    with db() as c:
        c.execute("UPDATE users SET pw = ? WHERE name = ?", (generate_password_hash(new), user["name"]))
    return reply(True, "Đã đổi mật khẩu")


@app.route("/api/users", methods=["GET", "POST"])
def api_users():
    if request.method == "GET":
        with db() as c:
            rows = c.execute("SELECT name, role, created FROM users ORDER BY name COLLATE NOCASE").fetchall()
        return jsonify(ok=True, users=[dict(r) for r in rows])
    body = request.get_json(silent=True) or {}
    action, name = body.get("action"), str(body.get("name") or "").strip()
    with db() as c:
        row = c.execute("SELECT name, role FROM users WHERE name = ?", (name,)).fetchone()
        if action == "add":
            password, role = str(body.get("password") or ""), body.get("role")
            if not USERNAME_RE.match(name):
                return reply(False, "Tên đăng nhập gồm 3–32 ký tự: chữ, số, _ . -")
            if len(password) < MIN_PASSWORD_LEN:
                return reply(False, f"Mật khẩu phải có ít nhất {MIN_PASSWORD_LEN} ký tự")
            if role not in ROLE_RANK:
                return reply(False, "Vai trò không hợp lệ")
            if row:
                return reply(False, "Tên đăng nhập đã tồn tại")
            c.execute("INSERT INTO users(name, pw, role, created) VALUES(?,?,?,?)",
                      (name, generate_password_hash(password), role, now_text()))
            return reply(True, f"Đã thêm tài khoản {name}")
        if not row:
            return reply(False, "Không có tài khoản này")
        if action == "delete":
            if name.lower() == g.user_name.lower():
                return reply(False, "Không thể tự xoá tài khoản đang đăng nhập")
            if row["role"] == "admin" and last_admin_guard(c, name):
                return reply(False, "Phải còn ít nhất một tài khoản quản trị")
            c.execute("DELETE FROM users WHERE name = ?", (name,))
            return reply(True, f"Đã xoá tài khoản {name}")
        if action == "password":
            password = str(body.get("password") or "")
            if len(password) < MIN_PASSWORD_LEN:
                return reply(False, f"Mật khẩu phải có ít nhất {MIN_PASSWORD_LEN} ký tự")
            c.execute("UPDATE users SET pw = ? WHERE name = ?", (generate_password_hash(password), name))
            return reply(True, f"Đã đặt lại mật khẩu của {name}")
        if action == "role":
            role = body.get("role")
            if role not in ROLE_RANK:
                return reply(False, "Vai trò không hợp lệ")
            if row["role"] == "admin" and role != "admin" and last_admin_guard(c, name):
                return reply(False, "Phải còn ít nhất một tài khoản quản trị")
            c.execute("UPDATE users SET role = ? WHERE name = ?", (role, name))
            return reply(True, f"Đã đổi vai trò của {name}")
    return reply(False, "Thao tác không hợp lệ")


@app.route("/api/signup", methods=["POST"])
def api_signup():
    """Công khai: người dùng đề xuất tên + mật khẩu. Chỉ tạo yêu cầu CHỜ DUYỆT, chưa đăng nhập được."""
    if not request.is_json:
        return jsonify(ok=False, message="Yêu cầu không hợp lệ"), 400
    body = request.get_json(silent=True) or {}
    name, password = str(body.get("name") or "").strip(), str(body.get("password") or "")
    ip, now = client_ip(), time.time()
    if not USERNAME_RE.match(name):
        return jsonify(ok=False, message="Tên đăng nhập gồm 3–32 ký tự: chữ, số, _ . -"), 400
    if len(password) < MIN_PASSWORD_LEN:
        return jsonify(ok=False, message=f"Mật khẩu phải có ít nhất {MIN_PASSWORD_LEN} ký tự"), 400
    with signup_lock:
        hits = [t for t in signup_hits.get(ip, []) if now - t < 3600]
        if len(hits) >= SIGNUP_MAX_PER_IP_HOUR:
            signup_hits[ip] = hits
            return jsonify(ok=False, message="Gửi quá nhiều yêu cầu — hãy thử lại sau"), 429
        hits.append(now)
        signup_hits[ip] = hits
        if len(signup_hits) > 500:                      # dọn các IP đã cũ
            for k in [k for k, v in signup_hits.items() if not v or now - v[-1] >= 3600]:
                signup_hits.pop(k, None)
    pw_hash = generate_password_hash(password)          # luôn băm trước: thời gian phản hồi không lộ tên nào đã tồn tại
    with db() as c:
        if c.execute("SELECT COUNT(*) FROM signups").fetchone()[0] >= SIGNUP_MAX_PENDING:
            return jsonify(ok=False, message="Hiện có quá nhiều yêu cầu đang chờ — hãy liên hệ quản trị viên"), 503
        taken = c.execute("SELECT 1 FROM users WHERE name = ? UNION SELECT 1 FROM signups WHERE name = ?",
                          (name, name)).fetchone()
        if not taken:
            c.execute("INSERT INTO signups(name, pw, created, ip) VALUES(?,?,?,?)", (name, pw_hash, now_text(), ip))
    db_event(name, "Yêu cầu cấp tài khoản", "(tên đã tồn tại — bỏ qua)" if taken else "", ip, not taken)
    # Cùng một câu trả lời dù tên có trùng hay không (không để người lạ dò xem tên nào đã có tài khoản)
    return jsonify(ok=True, message="Đã gửi yêu cầu. Quản trị viên sẽ xem xét — sau khi được duyệt hãy quay lại đăng nhập.")


@app.route("/api/signups", methods=["GET", "POST"])
def api_signups():
    """Quản trị: xem danh sách chờ, duyệt (kèm chọn vai trò) hoặc từ chối."""
    if request.method == "GET":
        with db() as c:
            rows = c.execute("SELECT id, name, created, ip FROM signups ORDER BY id").fetchall()
        return jsonify(ok=True, signups=[dict(r) for r in rows])
    body = request.get_json(silent=True) or {}
    try:
        sid = int(body.get("id"))
    except (TypeError, ValueError):
        return reply(False, "Yêu cầu không hợp lệ")
    action = body.get("action")
    outcome = None                                   # (ok, thông báo, hành động ghi nhật ký, chi tiết)
    with db() as c:
        row = c.execute("SELECT id, name, pw FROM signups WHERE id = ?", (sid,)).fetchone()
        if not row:
            return reply(False, "Yêu cầu không còn tồn tại (có thể đã được xử lý)")
        if action == "reject":
            c.execute("DELETE FROM signups WHERE id = ?", (sid,))
            outcome = (True, f"Đã từ chối yêu cầu của {row['name']}", "Từ chối yêu cầu tài khoản", row["name"])
        elif action == "approve":
            role = body.get("role", "viewer")
            if role not in ROLE_RANK:
                return reply(False, "Vai trò không hợp lệ")
            if c.execute("SELECT 1 FROM users WHERE name = ?", (row["name"],)).fetchone():
                c.execute("DELETE FROM signups WHERE id = ?", (sid,))
                return reply(False, "Tên đăng nhập này đã có tài khoản — đã xoá yêu cầu trùng")
            c.execute("INSERT INTO users(name, pw, role, created) VALUES(?,?,?,?)",
                      (row["name"], row["pw"], role, now_text()))     # giữ nguyên bản băm mật khẩu người dùng đã đặt
            c.execute("DELETE FROM signups WHERE id = ?", (sid,))
            outcome = (True, f"Đã duyệt {row['name']} với vai trò {role}", "Duyệt yêu cầu tài khoản",
                       f"{row['name']} → {role}")
    if outcome:                                      # ghi nhật ký SAU khi giao dịch trên đã đóng (tránh khoá SQLite)
        db_event(g.user_name, outcome[2], outcome[3], client_ip(), True)
        return reply(outcome[0], outcome[1])
    return reply(False, "Thao tác không hợp lệ")


@app.route("/api/events")
def api_events():
    limit = max(1, min(request.args.get("limit", 100, type=int), 1000))
    with db() as c:
        rows = c.execute("SELECT t, user, action, detail, ip, ok FROM events ORDER BY id DESC LIMIT ?",
                         (limit,)).fetchall()
    return jsonify(ok=True, events=[dict(r) for r in rows])


def history_rows(minutes):
    cutoff = int((time.time() - minutes * 60) * 1000)
    with db() as c:
        return c.execute("SELECT t, temp, humi, pump, fan FROM readings WHERE t >= ? ORDER BY t", (cutoff,)).fetchall()


@app.route("/api/history")
def api_history():
    minutes = max(1, min(request.args.get("minutes", 60, type=int), READINGS_KEEP_DAYS * 1440))
    rows = history_rows(minutes)
    step = max(1, -(-len(rows) // 2000))               # tối đa ~2000 điểm trả về
    return jsonify(ok=True, points=[[r["t"], r["temp"], r["humi"], r["pump"], r["fan"]] for r in rows[::step]])


@app.route("/api/history.csv")
def api_history_csv():
    hours = max(1, min(request.args.get("hours", 24, type=int), READINGS_KEEP_DAYS * 24))
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["time", "temperature_C", "humidity_RH", "pump", "fan"])
    for r in history_rows(hours * 60):
        w.writerow([datetime.fromtimestamp(r["t"] / 1000).strftime("%Y-%m-%d %H:%M:%S"),
                    r["temp"], r["humi"], r["pump"], r["fan"]])
    return Response(out.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=lich_su_cam_bien.csv"})


LOGIN_HTML = r"""<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Đăng nhập · Nhà kính thông minh</title>
<style>
:root{--bg:#f6f7f5;--paper:#fff;--ink:#18181b;--muted:#71717a;--accent:#059669;--accent-ink:#047857;--line:#e4e4e7;--err:#b91c1c;color-scheme:light}
*{box-sizing:border-box;margin:0;padding:0}
[hidden]{display:none!important}
body{min-height:100vh;display:grid;place-items:center;padding:20px;color:var(--ink);font:15px/1.6 Inter,"Segoe UI",system-ui,Arial,sans-serif;
  background:radial-gradient(ellipse 70% 50% at 50% 0,rgba(16,185,129,.14),transparent 70%),var(--bg)}
.card{width:min(400px,100%);padding:32px 30px 28px;background:var(--paper);border:1px solid var(--line);border-radius:16px;box-shadow:0 14px 36px -18px rgba(5,150,105,.35)}
h1{font-size:25px;font-weight:600;line-height:1.2;letter-spacing:-.02em}
p.sub{margin:6px 0 22px;font-size:13px;color:var(--muted)}
label{display:block;margin:14px 0 6px;font-weight:500;font-size:12.5px;color:#52525b}
input{width:100%;height:42px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:#fafafa;color:inherit;font:inherit}
input:focus{outline:2px solid rgba(5,150,105,.35);border-color:var(--accent)}
button{width:100%;height:44px;margin-top:22px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
button:hover{background:var(--accent-ink)}
button:disabled{opacity:.6;cursor:progress}
.msg{min-height:1.6em;margin-top:12px;color:var(--err);font-size:13.5px}
.msg.ok{color:var(--accent-ink)}
.alt{margin-top:8px;font-size:13px;color:var(--muted)}
.alt a{color:var(--accent-ink);text-decoration:underline;text-underline-offset:3px}
</style></head><body>
<form class="card" id="f" autocomplete="on">
  <h1>Nhà kính thông minh</h1><p class="sub">Giám sát &amp; điều khiển qua Modbus RTU</p>
  <label for="u">Tên đăng nhập</label><input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Mật khẩu</label><input id="p" name="password" type="password" autocomplete="current-password" required>
  <button id="b" type="submit">Đăng nhập</button>
  <p class="msg" id="err" role="alert"></p>
  <p class="alt">Chưa có tài khoản? <a href="#" id="toSignup">Xin cấp tài khoản</a></p>
</form>
<form class="card" id="s" autocomplete="off" hidden>
  <h1>Xin cấp tài khoản</h1><p class="sub">Quản trị viên sẽ xem xét và duyệt</p>
  <label for="sn">Tên đăng nhập mong muốn</label><input id="sn" autocomplete="username" maxlength="32" required>
  <label for="sp">Mật khẩu (từ __MINPW__ ký tự)</label><input id="sp" type="password" autocomplete="new-password" required>
  <label for="sp2">Nhập lại mật khẩu</label><input id="sp2" type="password" autocomplete="new-password" required>
  <button id="sb" type="submit">Gửi yêu cầu</button>
  <p class="msg" id="serr" role="alert"></p>
  <p class="alt"><a href="#" id="toLogin">← Quay lại đăng nhập</a></p>
</form>
<script>
const $ = id => document.getElementById(id);
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async r => ({ ok: r.ok, d: await r.json().catch(() => ({})) }));
function show(signup) { $('f').hidden = signup; $('s').hidden = !signup; (signup ? $('sn') : $('u')).focus(); }
$('toSignup').addEventListener('click', e => { e.preventDefault(); show(true); });
$('toLogin').addEventListener('click', e => { e.preventDefault(); show(false); });
$('f').addEventListener('submit', async e => {
  e.preventDefault(); $('err').textContent = ''; $('b').disabled = true;
  try {
    const { ok, d } = await post('/api/login', { name: $('u').value, password: $('p').value });
    if (ok) { location.href = '/'; return; }
    $('err').textContent = d.message || 'Đăng nhập không thành công';
  } catch (x) { $('err').textContent = 'Không kết nối được máy chủ'; }
  $('b').disabled = false;
});
$('s').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('serr'); msg.className = 'msg'; msg.textContent = '';
  if ($('sp').value !== $('sp2').value) { msg.textContent = 'Hai ô mật khẩu không giống nhau'; return; }
  $('sb').disabled = true;
  try {
    const { ok, d } = await post('/api/signup', { name: $('sn').value.trim(), password: $('sp').value });
    msg.textContent = d.message || (ok ? 'Đã gửi yêu cầu' : 'Không gửi được yêu cầu');
    if (ok) { msg.className = 'msg ok'; ['sn', 'sp', 'sp2'].forEach(i => { $(i).value = ''; }); return; }
  } catch (x) { msg.textContent = 'Không kết nối được máy chủ'; }
  $('sb').disabled = false;
});
</script></body></html>
"""


# ======================= API CHO GIAO DIỆN =======================

@app.route("/")
def index():
    return send_from_directory(WEB_DIR, "index.html")


@app.route("/api/state")
def api_state():
    since = request.args.get("since", 0, type=int)
    with state_lock:
        data = dict(state, config=dict(state["config"]), auto_cfg=copy.deepcopy(state["auto_cfg"]))
        data["history"] = list(history)
        data["logs"] = [e for e in logs if e["id"] > since]
        data["log_seq"] = log_seq
    data["now"] = time.time()
    return jsonify(data)


@app.route("/api/ports")
def api_ports():
    ports = [{"device": p.device, "description": p.description} for p in serial.tools.list_ports.comports()]
    return jsonify(ports=ports)


@app.route("/api/connect", methods=["POST"])
def api_connect():
    global client, worker
    if not connect_lock.acquire(blocking=False):
        return reply(False, "Đang xử lý một yêu cầu kết nối khác")
    try:
        if worker is not None and worker.is_alive():
            return reply(False, "Đã kết nối rồi")
        body = request.get_json(silent=True) or {}
        if body.get("link") != "COM":
            return reply(False, "Bản này dùng code final.py (pymodbus) — chỉ hỗ trợ cổng COM thật")
        try:
            baud = BAUDRATE                      # baudrate cố định ở đầu file, không nhận từ trình duyệt
            sht20_id = get_int(body, "sht20_id", 1, 247, "ID SRD-THT-12R")
            relay_id = get_int(body, "relay_id", 1, 255, "ID relay")
            channel = get_int(body, "channel", 1, 32, "Kênh relay")
            relay_mode = "reg" if body.get("relay_mode") == "reg" else "coil"
            fan_channel = get_int(body, "fan_channel", 1, 32, "Kênh quạt") if "fan_channel" in body else FAN_CHANNEL
            t_on, t_off, interval = get_settings(body)
            auto_cfg = parse_auto_cfg(body["auto_cfg"]) if "auto_cfg" in body else copy.deepcopy(state["auto_cfg"])
            if sht20_id == relay_id:
                raise ValueError("SRD-THT-12R và module relay phải có ID khác nhau trên cùng 1 bus")
            if channel == fan_channel:
                raise ValueError("Kênh bơm và kênh quạt phải khác nhau (cùng một module relay)")
        except ValueError as e:
            return reply(False, str(e))
        port = str(body.get("port") or "")
        if not port:
            return reply(False, "Chưa chọn cổng COM — cắm bộ USB-RS485 rồi làm mới danh sách")

        client = ModbusSerialClient(
            port=port, baudrate=baud, parity="N", stopbits=1, bytesize=8, timeout=1
        )
        if not client.connect():
            client.close()
            return reply(False, f"Không mở được cổng {port}")

        stop_event.clear()
        read_now.clear()
        with state_lock:
            history.clear()
            state.update(
                connected=True, link=port, status="ok", status_text=f"Đã kết nối {port}",
                t_on=t_on, t_off=t_off, interval=interval, temperature=None, humidity=None,
                raw_temp=None, raw_hum=None, pump=None, pump_off_at=None, updated=None, tx=0, rx=0, err=0,
                fan=None, fan_off_at=None, auto_cfg=auto_cfg,
                config={"link": "COM", "port": port, "baud": baud, "sht20_id": sht20_id,
                        "relay_id": relay_id, "channel": channel, "fan_channel": fan_channel,
                        "relay_mode": relay_mode},
            )
        log(f"Kết nối {port} @ {baud} bps · SRD-THT-12R ID {sht20_id} (FC{SENSOR_FUNCTION:02d}) · relay ID {relay_id}, "
            f"kênh bơm {channel} (địa chỉ {channel - 1}), kênh quạt {fan_channel} (địa chỉ {fan_channel - 1})")
        if relay_mode == "coil":
            for dev, ch in (("pump", channel), ("fan", fan_channel)):
                try:   # đọc trạng thái thật của relay (FC01), lỗi thì để "Chưa rõ"
                    rr = client.read_coils(ch - 1, count=1, **{_UNIT_KW: relay_id})
                    if not rr.isError():
                        state[dev] = bool(rr.bits[0])
                except Exception:
                    pass
        worker = threading.Thread(target=background_loop, daemon=True)
        worker.start()
        return reply(True, f"Đã kết nối {port}")
    finally:
        connect_lock.release()


@app.route("/api/disconnect", methods=["POST"])
def api_disconnect():
    if worker is None or not worker.is_alive():
        return reply(False, "Chưa kết nối")
    stop_event.set()        # luồng nền tắt bơm, đóng cổng rồi tự kết thúc
    worker.join(timeout=8)
    return reply(True, "Đã ngắt kết nối")


@app.route("/api/mode", methods=["POST"])
def api_mode():
    auto = bool((request.get_json(silent=True) or {}).get("auto", True))
    with state_lock:
        changed = state["auto"] != auto
        state["auto"] = auto
        if auto:
            state["pump_off_at"] = None     # hẹn giờ chỉ dùng cho chế độ bằng tay
            state["fan_off_at"] = None
    read_now.set()
    if changed:
        log(f"Chuyển sang chế độ {'TỰ ĐỘNG' if auto else 'BẰNG TAY'}")
    return reply(True, "Tự động" if auto else "Bằng tay")


@app.route("/api/pump", methods=["POST"])
def api_pump():
    body = request.get_json(silent=True) or {}
    on = bool(body.get("on"))
    if not state["connected"]:
        return reply(False, "Chưa kết nối bus RS-485")
    if state["auto"]:
        return reply(False, "Đang ở chế độ Tự động — chọn Bằng tay để điều khiển bơm")
    try:
        if on:
            seconds = int(body.get("seconds") or MAX_PUMP_SECONDS)
            seconds = max(1, min(seconds, MAX_PUMP_SECONDS))
            set_relay(True)
            state["pump_off_at"] = time.time() + seconds
            log(f"Điều khiển tay: BẬT bơm (tự tắt sau {seconds} s)", "ok")
        else:
            set_relay(False)
            log("Điều khiển tay: TẮT bơm", "ok")
        return reply(True, "Đã gửi lệnh")
    except Exception as e:
        log_error(f"Relay: {type(e).__name__}: {e}")
        return reply(False, f"{type(e).__name__}: {e}")


@app.route("/api/fan", methods=["POST"])
def api_fan():
    body = request.get_json(silent=True) or {}
    on = bool(body.get("on"))
    if not state["connected"]:
        return reply(False, "Chưa kết nối bus RS-485")
    if state["auto"]:
        return reply(False, "Đang ở chế độ Tự động — chọn Bằng tay để điều khiển quạt")
    try:
        if on:
            set_device("fan", True)
            if MAX_FAN_SECONDS > 0:
                seconds = int(body.get("seconds") or MAX_FAN_SECONDS)
                seconds = max(1, min(seconds, MAX_FAN_SECONDS))
                state["fan_off_at"] = time.time() + seconds
                log(f"Điều khiển tay: BẬT quạt (tự tắt sau {seconds} s)", "ok")
            else:
                state["fan_off_at"] = None
                log("Điều khiển tay: BẬT quạt", "ok")
        else:
            set_device("fan", False)
            log("Điều khiển tay: TẮT quạt", "ok")
        return reply(True, "Đã gửi lệnh")
    except Exception as e:
        log_error(f"Relay: {type(e).__name__}: {e}")
        return reply(False, f"{type(e).__name__}: {e}")


@app.route("/api/autocfg", methods=["POST"])
def api_autocfg():
    try:
        cfg = parse_auto_cfg(request.get_json(silent=True) or {})
    except ValueError as e:
        return reply(False, str(e))
    with state_lock:
        changed = state["auto_cfg"] != cfg
        state["auto_cfg"] = cfg
    read_now.set()
    if changed:
        log("Luật tự động · " + describe_auto_cfg(cfg))
    return reply(True, "Đã áp dụng")


@app.route("/api/change_id", methods=["POST"])
def api_change_id():
    body = request.get_json(silent=True) or {}
    dev = body.get("device")
    if dev not in ("sht20", "relay"):
        return reply(False, "Thiết bị không hợp lệ")
    if not state["connected"]:
        return reply(False, "Chưa kết nối bus RS-485")
    try:
        new_id = get_int(body, "new_id", 1, 247 if dev == "sht20" else 255, "ID mới")
        applied, message = change_device_id(dev, new_id)
    except ValueError as e:
        return reply(False, str(e))
    except Exception as e:
        return reply(False, f"{type(e).__name__}: {e}")
    return jsonify(ok=True, applied=applied, message=message)


@app.route("/api/settings", methods=["POST"])
def api_settings():
    try:
        t_on, t_off, interval = get_settings(request.get_json(silent=True) or {})
    except ValueError as e:
        return reply(False, str(e))
    with state_lock:
        changed = (state["t_on"], state["t_off"], state["interval"]) != (t_on, t_off, interval)
        state.update(t_on=t_on, t_off=t_off, interval=interval)
    read_now.set()
    if changed:
        log(f"Ngưỡng: BẬT khi T ≥ {t_on:g} °C, TẮT khi T ≤ {t_off:g} °C · chu kỳ đọc {interval:g} s")
    return reply(True, "Đã áp dụng")


# ======================= THÔNG SỐ CHO GIAO DIỆN =======================

@app.route("/api/info")
def api_info():
    """Hằng số cấu hình cho giao diện: giải mã khung, thanh ghi đổi ID, giới hạn an toàn."""
    return jsonify(
        sensor_function=SENSOR_FUNCTION, sensor_address=SENSOR_ADDRESS,
        temp_divisor=TEMP_DIVISOR, temp_offset=TEMP_OFFSET, humi_divisor=HUMI_DIVISOR, humi_offset=HUMI_OFFSET,
        relay_on_value=RELAY_ON_VALUE, relay_off_value=RELAY_OFF_VALUE,
        sensor_id_register=SENSOR_ID_REGISTER, relay_id_register=RELAY_ID_REGISTER, relay_id_broadcast=RELAY_ID_BROADCAST,
        max_pump_seconds=MAX_PUMP_SECONDS, max_fan_seconds=MAX_FAN_SECONDS,
        min_switch=MIN_SWITCH_SECONDS, max_fails=MAX_SENSOR_FAILS, min_password=MIN_PASSWORD_LEN,
    )


if __name__ == "__main__":
    if "--reset-admin" in sys.argv:       # python final_web.py --reset-admin [mật_khẩu_mới]
        i = sys.argv.index("--reset-admin")
        init_db()
        reset_admin(sys.argv[i + 1] if len(sys.argv) > i + 1 else None)
        sys.exit(0)
    init_db()
    bootstrap_admin()
    print(f"Dữ liệu tài khoản / nhật ký / lịch sử: {DB_FILE}")
    print(f"Cổng mặc định {PORT} @ {BAUDRATE} | cảm biến ID={SENSOR_ID} | relay ID={RELAY_ID}")
    print(f"Mở trình duyệt: http://127.0.0.1:{WEB_PORT}")
    try:
        app.run(host="0.0.0.0", port=WEB_PORT, debug=False, threaded=True)
    finally:
        if worker is not None and worker.is_alive():
            stop_event.set()     # luồng nền luôn tắt bơm rồi đóng cổng khi thoát chương trình
            worker.join(timeout=8)
