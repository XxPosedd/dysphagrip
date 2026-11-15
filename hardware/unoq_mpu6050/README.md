# Arduino UNO Q + MPU-6050 (biomechanical path)

Motion sensing for DysphaGrip V2. This is **mount / neck-adjacent motion**, used experimentally
to help separate handling artefacts from quieter acoustic bursts. It is not a clinical sensor.

## Hardware

| Item | Role |
|---|---|
| Arduino UNO Q | STM32U585 MCU reads the IMU; Qualcomm Linux can forward samples to the Mac |
| MPU-6050 | 6-axis accelerometer + gyroscope over I²C |

### Wiring (verify your breakout first)

| MPU-6050 | UNO Q |
|---|---|
| VCC | **3.3 V** (or the regulated VCC your breakout requires) |
| GND | GND |
| SDA | D20 / SDA |
| SCL | D21 / SCL |

1. Identify the exact breakout. Some boards include a regulator / level shifter; bare 3.3 V modules must **not** be powered from 5 V.
2. Confirm I²C address (`0x68` AD0 low, or `0x69` AD0 high).
3. Power off before wiring.

## Firmware

Sketch: [`firmware/dysphagrip_imu/dysphagrip_imu.ino`](firmware/dysphagrip_imu/dysphagrip_imu.ino)

- Initialises Wire / I²C, probes `0x68` then `0x69`
- Samples accel + gyro ~100 Hz
- Emits NDJSON lines: `{"type":"imu","seq":…,"t_ms":…,"ax":…,"ay":…,"az":…,"gx":…,"gy":…,"gz":…}`
- Emits `{"type":"error",…}` if the sensor is missing

Flash with Arduino App Lab / the UNO Q toolchain for your board revision.

## Transport to the MacBook (important)

**Do not assume** that `Serial.println` from an App Lab sketch appears as a normal macOS
`/dev/cu.*` serial port. The UNO Q is a hybrid Linux + MCU device; Bridge traffic often stays
on the board.

### Recommended: Linux TCP streamer

On the UNO Q Qualcomm Linux side:

```bash
python3 linux_streamer.py --serial /dev/ttyBridge0 --listen 0.0.0.0 --port 9001
```

Adjust `--serial` to the Bridge device path on your image. Then on the Mac dashboard
**Device Setup** page (or API):

```bash
curl -X POST http://127.0.0.1:8765/api/imu/connect \
  -H 'Content-Type: application/json' \
  -d '{"transport":"tcp","host":"<UNO-Q-LAN-IP>","tcp_port":9001}'
```

### Optional: USB serial

If a USB serial interface **is** exposed and visible under macOS *System Settings → USB* /
`ls /dev/cu.*`, connect with:

```bash
curl -X POST http://127.0.0.1:8765/api/imu/connect \
  -H 'Content-Type: application/json' \
  -d '{"transport":"serial","port":"/dev/cu.usbmodemXXXX","baud":115200}'
```

The backend lists candidate ports at `GET /api/devices` → `imu.serial_ports`.

## Honesty rule

Until IMU samples arrive, the dashboard shows **Motion: disconnected** (or error/stale).
Demo Mode uses labelled simulated IMU data and always shows the **SIMULATED DEMO DATA** banner.

## Safety

External contact only. Soft / non-compressive mounting. Consenting healthy volunteers.
See [docs/SAFETY_AND_CLAIMS.md](../../docs/SAFETY_AND_CLAIMS.md).
