#pragma once
#include "Arduino.h"
class TwoWire {
 public:
  bool begin(int sda, int scl, uint32_t frequency = 0);
  void beginTransmission(uint16_t address);
  void beginTransmission(uint8_t address);
  void beginTransmission(int address);
  uint8_t endTransmission(bool sendStop = true);
  size_t write(uint8_t);
  size_t requestFrom(int address, int size);
  int read();
};
extern TwoWire Wire;
extern TwoWire Wire1;
