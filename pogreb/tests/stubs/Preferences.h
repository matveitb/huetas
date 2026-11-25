#pragma once
#include <stdint.h>
#include <stddef.h>
#include <math.h>
class Preferences {
 public:
  bool begin(const char* name, bool readOnly = false, const char* partitionLabel = nullptr);
  float getFloat(const char* key, float defaultValue = NAN);
  size_t putFloat(const char* key, float value);
  bool getBool(const char* key, bool defaultValue = false);
  size_t putBool(const char* key, bool value);
  int32_t getInt(const char* key, int32_t defaultValue = 0);
  size_t putInt(const char* key, int32_t value);
  size_t getBytesLength(const char* key);
  size_t getBytes(const char* key, void* buf, size_t maxLen);
  size_t putBytes(const char* key, const void* value, size_t len);
  bool remove(const char* key);
};
