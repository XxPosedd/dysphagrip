/**
 * DysphaGrip — MPU-6050 sampler for Arduino UNO Q (STM32U585 side)
 *
 * Outputs newline-delimited JSON at ~100 Hz:
 *   {"type":"imu","seq":1,"t_ms":1234,"ax":0.01,"ay":0.02,"az":0.98,"gx":0.1,"gy":0.2,"gz":0.3}
 *
 * Wiring (verify your breakout voltage / level shifting first):
 *   VCC → 3.3V (or regulated breakout VCC)
 *   GND → GND
 *   SDA → UNO Q SDA (D20)
 *   SCL → UNO Q SCL (D21)
 *
 * I2C address: 0x68 (AD0 low) or 0x69 (AD0 high).
 *
 * Transport note:
 * Serial.println on the MCU may go to the UNO Q Bridge / App Lab console rather than a
 * macOS /dev/tty device. Prefer forwarding these lines with linux_streamer.py on the
 * Qualcomm Linux processor to the Mac over TCP.
 */

#include <Wire.h>
#include <math.h>

static const uint8_t MPU_ADDR_PRIMARY = 0x68;
static const uint8_t MPU_ADDR_ALT = 0x69;
static const int SAMPLE_HZ = 100;
static const unsigned long SAMPLE_US = 1000000UL / SAMPLE_HZ;

uint8_t mpuAddr = 0;
unsigned long seq = 0;
unsigned long lastSampleUs = 0;
bool sensorOk = false;

bool mpuWrite8(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuReadBytes(uint8_t reg, uint8_t *buf, uint8_t len) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(mpuAddr, len) != len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

bool probeAddress(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

bool initMpu() {
  if (probeAddress(MPU_ADDR_PRIMARY)) mpuAddr = MPU_ADDR_PRIMARY;
  else if (probeAddress(MPU_ADDR_ALT)) mpuAddr = MPU_ADDR_ALT;
  else return false;

  // Wake up (clear sleep bit)
  if (!mpuWrite8(0x6B, 0x00)) return false;
  delay(10);
  // Gyro ±250 dps, Accel ±2g
  mpuWrite8(0x1B, 0x00);
  mpuWrite8(0x1C, 0x00);
  // DLPF ~94 Hz
  mpuWrite8(0x1A, 0x02);
  return true;
}

bool readImu(float &ax, float &ay, float &az, float &gx, float &gy, float &gz) {
  uint8_t raw[14];
  if (!mpuReadBytes(0x3B, raw, 14)) return false;
  int16_t rax = (int16_t)((raw[0] << 8) | raw[1]);
  int16_t ray = (int16_t)((raw[2] << 8) | raw[3]);
  int16_t raz = (int16_t)((raw[4] << 8) | raw[5]);
  // skip temp raw[6], raw[7]
  int16_t rgx = (int16_t)((raw[8] << 8) | raw[9]);
  int16_t rgy = (int16_t)((raw[10] << 8) | raw[11]);
  int16_t rgz = (int16_t)((raw[12] << 8) | raw[13]);
  // ±2g → 16384 LSB/g ; ±250 dps → 131 LSB/(°/s)
  ax = rax / 16384.0f;
  ay = ray / 16384.0f;
  az = raz / 16384.0f;
  gx = rgx / 131.0f;
  gy = rgy / 131.0f;
  gz = rgz / 131.0f;
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Wire.begin();
  Wire.setClock(400000);

  sensorOk = initMpu();
  if (!sensorOk) {
    Serial.println("{\"type\":\"error\",\"error\":\"MPU-6050 not found on I2C (tried 0x68 and 0x69)\"}");
  } else {
    Serial.print("{\"type\":\"info\",\"message\":\"MPU-6050 ready\",\"addr\":");
    Serial.print(mpuAddr);
    Serial.println("}");
  }
  lastSampleUs = micros();
}

void loop() {
  unsigned long now = micros();
  if ((now - lastSampleUs) < SAMPLE_US) return;
  lastSampleUs += SAMPLE_US;

  if (!sensorOk) {
    sensorOk = initMpu();
    if (!sensorOk) {
      if ((seq++ % 100) == 0) {
        Serial.println("{\"type\":\"error\",\"error\":\"MPU-6050 not responding\"}");
      }
      return;
    }
  }

  float ax, ay, az, gx, gy, gz;
  if (!readImu(ax, ay, az, gx, gy, gz)) {
    sensorOk = false;
    Serial.println("{\"type\":\"error\",\"error\":\"MPU-6050 read failed\"}");
    return;
  }

  seq++;
  Serial.print("{\"type\":\"imu\",\"seq\":");
  Serial.print(seq);
  Serial.print(",\"t_ms\":");
  Serial.print(millis());
  Serial.print(",\"ax\":"); Serial.print(ax, 5);
  Serial.print(",\"ay\":"); Serial.print(ay, 5);
  Serial.print(",\"az\":"); Serial.print(az, 5);
  Serial.print(",\"gx\":"); Serial.print(gx, 3);
  Serial.print(",\"gy\":"); Serial.print(gy, 3);
  Serial.print(",\"gz\":"); Serial.print(gz, 3);
  Serial.println("}");
}
