#pragma once
// Минимальный драйвер SHT31/SHT30 по I2C, без сторонних библиотек.
#include <Arduino.h>
#include <Wire.h>

class Sht31 {
 public:
  Sht31(TwoWire& wire, uint8_t addr) : w_(wire), addr_(addr) {}
  bool read(float& tC, float& rh);  // одиночное измерение, проверка CRC
  bool heater(bool on);             // встроенный нагрев — подсушить датчик от конденсата
  bool present();

 private:
  bool command(uint16_t cmd);
  TwoWire& w_;
  uint8_t  addr_;
};
