/*
 * DysphaGrip motion firmware: Arduino UNO Q (MCU side) + MPU-6050 over I2C.
 *
 * Output: newline-delimited JSON (NDJSON) at 115200 baud on DG_OUT, one object per line:
 *   {"type":"hello","device":"mpu6050","fw":"0.1.0","addr":"0x68","whoami":"0x68","rate_hz":100,"accel_range_g":2,"gyro_range_dps":250}
 *   {"type":"imu","seq":42,"t_ms":12345,"ax":0.012,"ay":-0.003,"az":0.998,"gx":0.31,"gy":-0.12,"gz":0.05,"temp_c":29.4}
 *   {"type":"error","msg":"..."}
 * Units: acceleration in g, angular rate in degrees/second, t_ms = board millis() at the sample (board clock).
 * The receiver on the MacBook timestamps each line on arrival and estimates the board->host clock offset.
 *
 * Wiring (confirm against YOUR breakout's labels and voltage spec first; see ../README.md):
 *   MPU-6050 VCC -> UNO Q 3.3V (or 5V ONLY if the breakout has an on-board regulator)
 *   MPU-6050 GND -> GND
 *   MPU-6050 SDA -> UNO Q SDA      MPU-6050 SCL -> UNO Q SCL      (AD0 low/unconnected -> address 0x68)
 *
 * Experimental engineering prototype. Motion data describes movement of the sensor mount only.
 */
#include <Wire.h>

// Where readings are written. On the UNO Q, check which object reaches the MacBook (see README "Transport").
#ifndef DG_OUT
#define DG_OUT Serial
#endif

static const char *FW_VERSION = "0.1.0";
static const uint32_t RATE_HZ = 100;           // samples per second
static const uint32_t PERIOD_US = 1000000UL / RATE_HZ;

static uint8_t mpuAddr = 0x68;
static bool sensorOk = false;
static uint32_t seq = 0;
static uint32_t nextSampleUs = 0;
static uint32_t lastRetryMs = 0;

// MPU-6050 registers
static const uint8_t REG_SMPLRT_DIV = 0x19, REG_CONFIG = 0x1A, REG_GYRO_CONFIG = 0x1B, REG_ACCEL_CONFIG = 0x1C;
static const uint8_t REG_ACCEL_XOUT_H = 0x3B, REG_PWR_MGMT_1 = 0x6B, REG_WHO_AM_I = 0x75;

static bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool readRegs(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)mpuAddr, (int)len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

static void printError(const char *msg) {
  DG_OUT.print("{\"type\":\"error\",\"msg\":\"");
  DG_OUT.print(msg);
  DG_OUT.println("\"}");
}

static bool initSensor() {
  const uint8_t candidates[2] = {0x68, 0x69};   // AD0 low / high
  for (uint8_t i = 0; i < 2; i++) {
    mpuAddr = candidates[i];
    uint8_t who = 0;
    if (!readRegs(REG_WHO_AM_I, &who, 1)) continue;
    // Genuine MPU-6050 returns 0x68; some clones return 0x70/0x72/0x98. Accept and report it.
    if (!writeReg(REG_PWR_MGMT_1, 0x01)) continue;   // wake up, PLL with X-gyro reference
    delay(50);
    writeReg(REG_SMPLRT_DIV, 9);                      // 1 kHz / (1 + 9) = 100 Hz internal sample rate
    writeReg(REG_CONFIG, 0x03);                       // DLPF ~44 Hz: removes high-frequency noise
    writeReg(REG_GYRO_CONFIG, 0x00);                  // +/-250 deg/s
    writeReg(REG_ACCEL_CONFIG, 0x00);                 // +/-2 g
    char line[200];
    snprintf(line, sizeof(line),
             "{\"type\":\"hello\",\"device\":\"mpu6050\",\"fw\":\"%s\",\"addr\":\"0x%02X\",\"whoami\":\"0x%02X\","
             "\"rate_hz\":%lu,\"accel_range_g\":2,\"gyro_range_dps\":250}",
             FW_VERSION, mpuAddr, who, (unsigned long)RATE_HZ);
    DG_OUT.println(line);
    return true;
  }
  return false;
}

static int16_t be16(const uint8_t *p) { return (int16_t)((p[0] << 8) | p[1]); }

void setup() {
  DG_OUT.begin(115200);
  uint32_t start = millis();
  while (!DG_OUT && millis() - start < 2000) { }   // wait briefly for a USB serial host, never forever
  Wire.begin();
  Wire.setClock(400000);
  sensorOk = initSensor();
  if (!sensorOk) printError("MPU-6050 not found at 0x68/0x69: check wiring, power and pull-ups");
  nextSampleUs = micros();
}

void loop() {
  if (!sensorOk) {
    if (millis() - lastRetryMs > 2000) {            // keep retrying so a re-seated cable recovers
      lastRetryMs = millis();
      sensorOk = initSensor();
      if (!sensorOk) printError("MPU-6050 not found at 0x68/0x69: check wiring, power and pull-ups");
    }
    return;
  }

  if ((int32_t)(micros() - nextSampleUs) < 0) return;
  nextSampleUs += PERIOD_US;
  if ((int32_t)(micros() - nextSampleUs) > (int32_t)(10 * PERIOD_US)) nextSampleUs = micros();   // resync after stalls

  uint8_t b[14];
  uint32_t t = millis();
  if (!readRegs(REG_ACCEL_XOUT_H, b, 14)) {
    printError("I2C read failed: sensor disconnected?");
    sensorOk = false;
    return;
  }
  const float ax = be16(b + 0) / 16384.0f, ay = be16(b + 2) / 16384.0f, az = be16(b + 4) / 16384.0f;
  const float temp = be16(b + 6) / 340.0f + 36.53f;
  const float gx = be16(b + 8) / 131.0f, gy = be16(b + 10) / 131.0f, gz = be16(b + 12) / 131.0f;

  char line[220];
  snprintf(line, sizeof(line),
           "{\"type\":\"imu\",\"seq\":%lu,\"t_ms\":%lu,\"ax\":%.4f,\"ay\":%.4f,\"az\":%.4f,"
           "\"gx\":%.3f,\"gy\":%.3f,\"gz\":%.3f,\"temp_c\":%.2f}",
           (unsigned long)seq++, (unsigned long)t, ax, ay, az, gx, gy, gz, temp);
  DG_OUT.println(line);
}
