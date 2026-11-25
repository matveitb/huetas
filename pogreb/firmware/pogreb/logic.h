#pragma once
// Логика управления без привязки к железу: её можно проверять тестами на компьютере.
#include <stdint.h>
#include <cmath>

// Точка росы по формуле Магнуса. NAN, если данные неверные.
float dewPoint(float tC, float rhPct);
inline bool valid(float v) { return !std::isnan(v); }

// CRC-8 датчиков Sensirion (полином 0x31, начальное значение 0xFF).
uint8_t sensirionCrc8(const uint8_t* data, int len);

enum class OpMode : int8_t { Off = -1, Auto = 0, On = 1 };

// ---------------- Обогрев погреба ----------------
struct HeatParams {
  float    onBelowC;       // включать пушку ниже
  float    offAboveC;      // выключать выше
  uint32_t minOnS;         // минимальное время работы
  uint32_t minOffS;        // минимальная пауза между включениями
  uint32_t maxRunS;        // максимум непрерывной работы
  uint32_t maxRunPauseS;   // пауза после максимума
  float    outletMaxC;     // перегрев на выходе пушки
  uint32_t overheatPauseS; // пауза после перегрева
  float    purgeDoneC;     // продувка заканчивается, когда выход остыл ниже
  uint32_t purgeMinS;
  uint32_t purgeMaxS;
  uint32_t purgeNoSensorS; // продувка по времени, если датчика на выходе нет
};

enum class HeatState : uint8_t { Idle, Heating, Purging, FireLock };

struct HeatInputs {
  uint32_t nowS;
  float    cellarC;
  bool     cellarOk;
  float    outletC;
  bool     outletOk;
  bool     mainsOk;
  bool     stopped;  // команда «стоп»
  OpMode   mode;
  bool     fire;
};

struct HeatOutputs { bool gun; bool purge; };

class HeatController {
 public:
  enum : uint8_t { EV_OVERHEAT = 1, EV_MAXRUN = 2, EV_NO_SENSOR = 4 };

  explicit HeatController(const HeatParams& p) : p_(p) {}
  HeatOutputs step(const HeatInputs& in);

  HeatState state() const { return st_; }
  uint32_t  heatingSince() const { return onSince_; }
  uint32_t  offSince() const { return offSince_; }
  uint32_t  nextAllowedOn() const { return nextOn_; }
  uint8_t   takeEvents() { const uint8_t e = ev_; ev_ = 0; return e; }
  void      setThresholds(float onBelowC, float offAboveC) { p_.onBelowC = onBelowC; p_.offAboveC = offAboveC; }
  void      lockFire() { st_ = HeatState::FireLock; }
  void      clearFire() { if (st_ == HeatState::FireLock) st_ = HeatState::Idle; }
  const HeatParams& params() const { return p_; }

 private:
  void beginPurge(uint32_t now, uint32_t pauseS);

  HeatParams p_;
  HeatState  st_ = HeatState::Idle;
  uint32_t   onSince_ = 0, offSince_ = 0, purgeSince_ = 0, nextOn_ = 0;
  uint8_t    ev_ = 0;
};

// ---------------- Вытяжка гаража ----------------
struct VentParams {
  float    onDtd;    // включать, если точка росы снаружи ниже на столько
  float    offDtd;   // выключать, если разница меньше
  float    rhOn;     // и только если в гараже влажность выше
  float    rhOff;
  uint32_t minSwitchS;
  float    frostC;
  uint32_t frostMaxOnPerHourS;
};

struct VentInputs {
  uint32_t nowS;
  bool     sensorsOk;
  float    tdIn;     // точка росы в гараже
  float    tdOut;    // точка росы на улице
  float    rhIn;
  float    tOut;
  bool     mainsOk;
  bool     stopped;
  OpMode   mode;
};

class VentController {
 public:
  explicit VentController(const VentParams& p) : p_(p) {}
  bool step(const VentInputs& in);
  bool on() const { return on_; }

 private:
  VentParams p_;
  bool       on_ = false, started_ = false;
  uint32_t   lastSwitch_ = 0, hourStart_ = 0, onThisHour_ = 0, lastStep_ = 0;
};

// ---------------- Тревоги ----------------
enum class AlarmEvent : uint8_t { None, Raise, Repeat, Clear };

// Тревога поднимается, если условие держится holdS секунд, повторяется
// раз в repeatS (0 — не повторять) и снимается по отдельному условию clearCond.
struct AlarmTracker {
  bool     active = false;
  bool     waiting = false;
  uint32_t since = 0;
  uint32_t lastSent = 0;
  AlarmEvent update(bool cond, bool clearCond, uint32_t nowS, uint32_t holdS, uint32_t repeatS);
};
