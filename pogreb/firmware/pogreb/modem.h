#pragma once
// SIM800L: отправка SMS кириллицей (PDU/UCS2), приём команд, время сети.
#include <Arduino.h>

struct NetTime {
  bool valid = false;
  int  year = 0, month = 0, day = 0, hour = 0, minute = 0;
};

class Modem {
 public:
  // pwkeyPin и powerPin — только для плат вроде LilyGO T-Call, иначе -1.
  void begin(HardwareSerial& serial, int rxPin, int txPin, int rstPin, int pwkeyPin = -1, int powerPin = -1);
  void setIdleHook(void (*hook)()) { idleHook_ = hook; }  // вызывается при долгом ожидании

  bool init();                       // проверка связи с модемом и настройка
  void poll();                       // разбор входящих строк (уведомления о новых SMS)
  bool sendSms(const String& phone, const String& text);
  bool readSms(int index, String& from, String& text);  // текст в UTF-8
  bool deleteSms(int index);
  int  nextPendingSms();             // -1, если новых SMS нет
  void scanStoredSms();              // поставить в очередь SMS, уже лежащие на SIM

  bool    ping();
  bool    isRegistered();
  int     signalQuality();           // 0..31, 99 — неизвестно
  NetTime networkTime();
  void    hardReset();
  bool    ready() const { return ready_; }

 private:
  bool command(const String& cmd, const char* expect = "OK", uint32_t timeoutMs = 2000,
               String* response = nullptr);
  bool readLine(String& line, uint32_t timeoutMs);
  bool waitPrompt(uint32_t timeoutMs);
  bool waitSendResult(uint32_t timeoutMs);
  void handleUrc(const String& line);
  void pushPending(int index);
  void idle();

  static const int kMaxPending = 12;
  HardwareSerial* s_ = nullptr;
  int     rst_ = -1, pwkey_ = -1, power_ = -1;
  bool    ready_ = false;
  String  rx_;
  int     pending_[kMaxPending];
  int     pendingCount_ = 0;
  uint8_t smsRef_ = 0;
  void (*idleHook_)() = nullptr;
};
