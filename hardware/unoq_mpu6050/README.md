# Arduino UNO Q + MPU-6050: motion sensor

The MPU-6050 measures movement of the sensor mount (3-axis acceleration in g, 3-axis angular rate in °/s).
DysphaGrip uses it to flag **movement interference**: moments when audio is likely affected by
head/neck movement or handling. It is a recording-quality signal, not a physiological measurement.

```
MPU-6050 ──I2C──► UNO Q (MCU runs dysphagrip_mpu6050.ino, 100 Hz NDJSON) ──USB serial or TCP relay──► MacBook
                                                                       └─ python -m dysphagrip_audio serve  (receiver + sync)
```

## 1. Wiring (power everything off first)

| MPU-6050 pin | UNO Q | Note |
|---|---|---|
| VCC | **3.3V** | Use 5V **only** if your breakout has an on-board regulator (check the board/listing). |
| GND | GND | Common ground |
| SDA | SDA | I2C data (the header pin marked SDA, or the Qwiic connector if you switch the sketch to `Wire1`) |
| SCL | SCL | I2C clock |
| AD0 | leave unconnected or GND | Address 0x68 (0x69 if AD0 is high; the firmware tries both) |

- Solder the header pins. Loose contacts look exactly like sensor faults.
- Keep the I2C wires short (under 20 cm). Most breakouts already have pull-up resistors.
- Check the UNO Q's SDA/SCL positions against the official UNO Q pinout. Do not assume UNO R3 A4/A5.

## 2. Flash the firmware

1. Open `dysphagrip_mpu6050/dysphagrip_mpu6050.ino` in **Arduino IDE 2** (board: *Arduino UNO Q*) or in
   **Arduino App Lab**, and upload it to the UNO Q's microcontroller.
2. Open the serial monitor at **115200 baud**. You should see:
   `{"type":"hello","device":"mpu6050",…,"whoami":"0x68","rate_hz":100,…}` and then about 100 `{"type":"imu",…}` lines a second.
   - `{"type":"error","msg":"MPU-6050 not found…"}` means wiring, power or address. It keeps retrying every 2 s.
   - WHO_AM_I `0x70`/`0x72`/`0x98` means a clone chip. It is accepted and reported; values still work.

## 3. Connect to the MacBook (transport)

The UNO Q has a microcontroller **and** a Linux computer. Which path reaches the Mac depends on the board
setup, so the receiver supports both. **Try A first.**

**A. USB serial (simplest)**
```bash
cd services/audio && source .venv/bin/activate
python -m dysphagrip_audio motion-ports          # the UNO Q should appear, marked "likely Arduino"
python -m dysphagrip_audio motion-probe --source auto
```
`motion-probe` prints the rate (~100 Hz), live values and clock-sync figures. Move the sensor and you'll see
`INTERFERENCE` when you turn your head or shake it.

**B. Network relay (if no serial port appears for the sketch's output)**
On the UNO Q's Linux side (SSH or App Lab terminal), find the microcontroller's serial device (`ls /dev/tty*`), then:
```bash
pip install pyserial
python3 serial_to_tcp.py --device /dev/ttyHS1 --port 7070      # device path: verify on the board
```
On the Mac: `python -m dysphagrip_audio motion-probe --source tcp://<board-ip>:7070`.
In the dashboard: Movement panel → **Network relay (TCP)…** → `tcp://<board-ip>:7070` → Connect.

## 4. In the dashboard
Movement panel → choose the port (or Auto-detect) → **Connect**. The top chip turns green ("Motion: live"),
X/Y/Z values and traces update, and during a session:
- The timeline's **Motion** lane shows the movement score and **Movement interference** spans.
- A marker is added, and ElevenLabs says *"Movement interference detected."*
- Sessions are saved with `motion_connected = true` and their movement markers.

## 5. Calibrate (5 minutes, with the real mount)
Thresholds live in `services/audio/dysphagrip_audio/motion.py` → `MotionConfig`:
`gyro_dps = 25`, `accel_dyn_g = 0.06`, held 150 ms on / 400 ms off. With the mount worn:
1. Sit still for 30 s. `motion-probe` should show a movement score well below 1 and no interference.
2. Turn your head, nod, and tug the cable. Each should trigger interference.
3. Take a normal comfortable sip of water. Ideally it does not trigger; if it does, raise `accel_dyn_g` slightly.

## 6. Timing and synchronisation
Each sample carries board `millis()`. The Mac records arrival time and maps board time onto the Mac clock using
the **minimum** observed offset (least-delayed sample). Audio is timestamped on the same Mac clock, so both
streams share one session clock. The dashboard shows arrival jitter (p95) and clock drift. Expected
error: a few ms over USB, more over Wi-Fi. See `docs/TECHNICAL_OVERVIEW.md` §3.

## Data format (NDJSON, one object per line, 115200 baud)
```json
{"type":"hello","device":"mpu6050","fw":"0.1.0","addr":"0x68","whoami":"0x68","rate_hz":100,"accel_range_g":2,"gyro_range_dps":250}
{"type":"imu","seq":42,"t_ms":12345,"ax":0.012,"ay":-0.003,"az":0.998,"gx":0.31,"gy":-0.12,"gz":0.05,"temp_c":29.4}
{"type":"error","msg":"I2C read failed: sensor disconnected?"}
```

## Safety
Non-compressive mount only (medical tape or a loose elastic band); never tight around the neck; no exposed
circuit board against the skin; consenting healthy volunteers; ordinary comfortable activity only.
