#pragma once
#include <stdint.h>
#include "OneWire.h"
typedef uint8_t DeviceAddress[8];
#define DEVICE_DISCONNECTED_C -127
class DallasTemperature {
 public:
  struct request_t { bool result; unsigned long timestamp; };
  DallasTemperature(OneWire*);
  void begin();
  uint8_t getDeviceCount();
  bool getAddress(uint8_t*, uint8_t);
  void setResolution(uint8_t);
  void setWaitForConversion(bool);
  request_t requestTemperatures();
  float getTempC(const uint8_t*, uint8_t retryCount = 0);
};
