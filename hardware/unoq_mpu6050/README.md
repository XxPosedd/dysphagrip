# Arduino UNO Q + MPU-6050

This folder documents the optional motion-sensor integration.

## Before wiring

1. Identify the exact MPU-6050 breakout board and read its pin labels and voltage specifications.
2. Some breakouts include a regulator/level shifting; others do not. Do not assume every board accepts 5 V.
3. Solder the included header pins if required; do not rely on loose contact.
4. Power everything off before wiring.

## Typical I²C signals

- VCC: use the voltage required by the exact breakout. For a bare 3.3 V module, use 3.3 V.
- GND: common ground.
- SDA: UNO Q I²C SDA.
- SCL: UNO Q I²C SCL.

Confirm the UNO Q pin mapping and which I²C bus is exposed by the selected connector against the current official pinout. Do not copy UNO R3 A4/A5 wiring without checking.

## First test

Run an MPU-6050 example that scans the I²C bus and prints accelerometer/gyroscope readings. Confirm a stable I²C address (commonly 0x68 or 0x69, depending on AD0) and plausible changing values before integrating with the web app.

## Data contract proposal

After the sensor test works, send newline-delimited JSON with device timestamps:

```json
{"type":"motion","timestamp":"2026-01-01T00:00:00.000Z","ax":0.01,"ay":0.02,"az":0.99,"gx":0.1,"gy":0.2,"gz":0.3}
```

This is a proposed contract, not working firmware. Document whether timestamps come from the board or host and measure clock offset before combining streams.
