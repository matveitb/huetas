#include "sht31.h"

#include "logic.h"

bool Sht31::command(uint16_t cmd) {
  w_.beginTransmission(addr_);
  w_.write((uint8_t)(cmd >> 8));
  w_.write((uint8_t)(cmd & 0xFF));
  return w_.endTransmission() == 0;
}

bool Sht31::present() {
  w_.beginTransmission(addr_);
  return w_.endTransmission() == 0;
}

bool Sht31::read(float& tC, float& rh) {
  if (!command(0x2400)) return false;  // высокая точность, без удержания шины
  delay(20);
  if (w_.requestFrom((int)addr_, 6) != 6) return false;
  uint8_t b[6];
  for (int i = 0; i < 6; ++i) b[i] = (uint8_t)w_.read();
  if (sensirionCrc8(b, 2) != b[2] || sensirionCrc8(b + 3, 2) != b[5]) return false;
  const uint16_t rawT = ((uint16_t)b[0] << 8) | b[1];
  const uint16_t rawH = ((uint16_t)b[3] << 8) | b[4];
  tC = -45.0f + 175.0f * (float)rawT / 65535.0f;
  rh = 100.0f * (float)rawH / 65535.0f;
  if (rh > 100.0f) rh = 100.0f;
  return true;
}

bool Sht31::heater(bool on) { return command(on ? 0x306D : 0x3066); }
