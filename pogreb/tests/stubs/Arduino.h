// Заглушки Arduino-ESP32 — только объявления, для проверки компиляции на ПК.
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#define HIGH 1
#define LOW 0
#define OUTPUT 0x03
#define INPUT 0x01
#define SERIAL_8N1 0x800001c
#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 3
#endif
unsigned long millis();
void delay(uint32_t);
void pinMode(uint8_t, uint8_t);
void digitalWrite(uint8_t, uint8_t);
uint32_t analogReadMilliVolts(uint8_t);
class StringSumHelper;
class String {
 public:
  String(const char* s = "");
  String(const String&);
  explicit String(char);
  explicit String(int, unsigned char base = 10);
  explicit String(unsigned int, unsigned char base = 10);
  explicit String(long, unsigned char base = 10);
  explicit String(unsigned long, unsigned char base = 10);
  explicit String(float, unsigned int decimals = 2);
  explicit String(double, unsigned int decimals = 2);
  ~String();
  String& operator=(const String&);
  String& operator=(const char*);
  String& operator+=(const String&);
  String& operator+=(const char*);
  String& operator+=(char);
  String& operator+=(int);
  String& operator+=(unsigned int);
  String& operator+=(long);
  String& operator+=(unsigned long);
  bool operator==(const String&) const;
  bool operator==(const char*) const;
  bool operator!=(const String&) const;
  bool operator!=(const char*) const;
  unsigned int length() const;
  const char* c_str() const;
  bool startsWith(const String&) const;
  int indexOf(char, unsigned int from = 0) const;
  int indexOf(const String&, unsigned int from = 0) const;
  int lastIndexOf(char) const;
  String substring(unsigned int) const;
  String substring(unsigned int, unsigned int) const;
  void trim();
  void replace(const String&, const String&);
  void replace(char, char);
  long toInt() const;
};
// В настоящем Arduino сложение идёт через StringSumHelper; здесь — эквивалентные перегрузки.
class StringSumHelper : public String {
 public:
  StringSumHelper(const String& s) : String(s) {}
  StringSumHelper(const char* p) : String(p) {}
};
StringSumHelper& operator+(const StringSumHelper&, const String&);
StringSumHelper& operator+(const StringSumHelper&, const char*);
StringSumHelper& operator+(const StringSumHelper&, char);
StringSumHelper& operator+(const StringSumHelper&, int);
StringSumHelper& operator+(const StringSumHelper&, unsigned int);
StringSumHelper& operator+(const StringSumHelper&, long);
StringSumHelper& operator+(const StringSumHelper&, unsigned long);
class Print {
 public:
  size_t print(const char*);
  size_t print(const String&);
  size_t print(char);
  size_t print(int, int base = 10);
  size_t print(unsigned int, int base = 10);
  size_t print(long, int base = 10);
  size_t print(unsigned long, int base = 10);
  size_t print(double, int digits = 2);
  size_t println();
  size_t println(const char*);
  size_t println(const String&);
  size_t println(int, int base = 10);
  size_t println(unsigned int, int base = 10);
  size_t println(long, int base = 10);
  size_t println(unsigned long, int base = 10);
  size_t write(uint8_t);
  size_t write(const uint8_t*, size_t);
};
class Stream : public Print {
 public:
  int available();
  int read();
};
class HardwareSerial : public Stream {
 public:
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rxPin = -1, int8_t txPin = -1);
  size_t setRxBufferSize(size_t);
};
extern HardwareSerial Serial;
extern HardwareSerial Serial2;
class EspClass { public: void restart(); };
extern EspClass ESP;
