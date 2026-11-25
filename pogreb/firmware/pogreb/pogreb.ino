// =====================================================================
//  Контроллер погреба и гаража
//  ESP32 DevKit V1 + SIM800L. Схема — страница «Контроллер погреба».
//
//  Arduino IDE: плата «ESP32 Dev Module».
//  Библиотеки (Менеджер библиотек): OneWire, DallasTemperature.
//  Перед прошивкой впишите свой номер в config.h → OWNER_PHONES.
// =====================================================================
#include <Arduino.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <Preferences.h>
#include <Wire.h>
#include <esp_system.h>
#include <esp_task_wdt.h>
#include <esp_timer.h>
#include <string.h>

#include <string>

#include "commands.h"
#include "config.h"
#include "logic.h"
#include "modem.h"
#include "sht31.h"
#include "textutil.h"

// ---------------- Оборудование ----------------
OneWire           oneWire(PIN_ONEWIRE);
DallasTemperature ds(&oneWire);
Sht31             shtCellar(Wire, SHT_ADDR_CELLAR);
Sht31             shtGarage(Wire, SHT_ADDR_GARAGE);
Sht31             shtOutdoor(Wire1, SHT_ADDR_OUTDOOR);
Modem             modem;
Preferences       prefs;

HeatController heat(HeatParams{
    DEFAULT_TARGET_C - HEAT_ON_BELOW, DEFAULT_TARGET_C + HEAT_OFF_ABOVE,
    HEAT_MIN_ON_S, HEAT_MIN_OFF_S, HEAT_MAX_RUN_S, HEAT_MAX_RUN_PAUSE_S,
    GUN_OUTLET_MAX_C, GUN_OVERHEAT_PAUSE_S,
    PURGE_DONE_C, PURGE_MIN_S, PURGE_MAX_S, PURGE_NO_SENSOR_S});

VentController vent(VentParams{
    VENT_ON_DTD, VENT_OFF_DTD, VENT_RH_ON, VENT_RH_OFF,
    VENT_MIN_SWITCH_S, VENT_FROST_C, VENT_FROST_MAX_ON_PER_HOUR_S});

// ---------------- Измерения ----------------
enum { ROLE_CELLAR = 0, ROLE_GUN = 1, ROLE_CAR = 2 };
static const char* const ROLE_NAME[3] = {"погреб", "выход пушки", "кузов"};
static const char* const ROLE_KEY[3]  = {"ds0", "ds1", "ds2"};

struct Meas {
  float   v = NAN;
  bool    ok = false;
  uint8_t fails = 0;
};

struct Sys {
  Meas  cellarT, cellarRH, garageT, garageRH, outT, outRH;
  Meas  dsT[3];
  bool  mains = true;
  float vbat = NAN;
  float cellarC = NAN;  // температура погреба для регулятора
  bool  cellarOk = false;
  float tdGarage = NAN, tdOut = NAN;
  bool  gun = false, purge = false, fan = false;
} S;

// ---------------- Режимы ----------------
float  targetC = DEFAULT_TARGET_C;
bool   stopped = false;
bool   fireLock = false;
OpMode heatMode = OpMode::Auto;
OpMode ventMode = OpMode::Auto;

// DS18B20: адреса по ролям и найденные на шине
DeviceAddress roleAddr[3];
bool          roleSet[3] = {false, false, false};
DeviceAddress found[8];
int           foundCount = 0;

// ---------------- SMS ----------------
struct OutSms {
  String  to;
  String  text;
  uint8_t tries = 0;
};
static const int OUTQ = 10;
OutSms  outQ[OUTQ];
int     outHead = 0, outCount = 0;
bool    modemRegistered = false;
int     modemCsq = 99;
uint8_t modemFails = 0;
uint32_t notRegisteredSince = 0;
NetTime netTime;
uint32_t netTimeAtS = 0;
bool    bootMsgSent = false;
bool    rebootRequested = false;

// ---------------- Время и счётчики ----------------
uint32_t lastControlS = 0, gunSecDay = 0, fanSecDay = 0;
uint32_t mainsLostAt = 0, lastReportS = 0;
int      lastReportDay = -1;
uint8_t  mainsDiff = 0;
float    heatStartC = NAN;
HeatState prevHeatState = HeatState::Idle;
uint32_t cellarWetSince = 0, shtHeaterUntil = 0, shtIgnoreUntil = 0;
bool     sensorsReady = false, dsPending = false;
uint32_t tMains = 0, tSensors = 0, tDsReq = 0, tControl = 0, tAlarms = 0, tModem = 0;
String   serialLine;

AlarmTracker aCold, aHot, aNoCellar, aDisagree, aDry, aNoHeat, aNotRising, aStuck;
AlarmTracker aCond, aDamp, aBattery, aSensor[6];

// ---------------- Объявления ----------------
static uint32_t nowS();
static void   relayWrite(int pin, bool on);
static String fmtNum(float v, int decimals);
static String fmtT(float v, bool ok = true);
static String fmtRH(const Meas& m);
static String fmtDur(uint32_t s);
static String heatText();
static String statusText();
static String shortStatus();
static String reportText();
static String sensorsText();
static String resetReasonText();
static String executeCommand(const String& raw);
static void   setTarget(float t, bool save);
static void   scanDs();
static void   loadRoles();
static void   putMeas(Meas& m, bool success, float v);
static void   readI2c();
static void   readDs();
static void   readVbat();
static void   computeDerived();
static bool   mainsRaw();
static void   mainsStep();
static void   controlStep();
static void   alarmsStep();
static void   applyOutputs(bool gun, bool purge, bool fan);
static void   queueSmsTo(const String& to, const String& text);
static void   queueSmsAll(const String& text);
static void   flushOneSms();
static bool   isOwner(const String& phone);
static void   processIncomingSms();
static void   modemHealth();
static void   dailyReportCheck();
static void   bootMessageCheck();
static void   handleSerial();
static void   setupWatchdog();
static void   feedWatchdog() { esp_task_wdt_reset(); }

// =====================================================================
void setup() {
  // Реле — сразу выключить, до всего остального
  pinMode(PIN_RELAY_GUN, OUTPUT);
  pinMode(PIN_RELAY_PURGE, OUTPUT);
  pinMode(PIN_RELAY_VENT, OUTPUT);
  relayWrite(PIN_RELAY_GUN, false);
  relayWrite(PIN_RELAY_PURGE, false);
  relayWrite(PIN_RELAY_VENT, false);

  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Контроллер погреба, версия " FW_VERSION);
  setupWatchdog();

  Wire.begin(PIN_I2C0_SDA, PIN_I2C0_SCL, I2C0_HZ);
  Wire1.begin(PIN_I2C1_SDA, PIN_I2C1_SCL, I2C1_HZ);
#if BOARD_TCALL
  // IP5306 на T-Call: не отключать питание при малой нагрузке
  Wire.beginTransmission((uint8_t)0x75);
  Wire.write((uint8_t)0x00);
  Wire.write((uint8_t)0x37);
  Wire.endTransmission();
#endif

  prefs.begin("pogreb", false);
  setTarget(prefs.getFloat("target", DEFAULT_TARGET_C), false);
  stopped = prefs.getBool("stopped", false);
  fireLock = prefs.getBool("fire", false);
  if (fireLock) heat.lockFire();
  lastReportDay = prefs.getInt("repday", -1);
  loadRoles();
  scanDs();

  S.mains = mainsRaw();
  if (!S.mains) mainsLostAt = nowS();

  modem.setIdleHook(feedWatchdog);
  modem.begin(Serial2, PIN_MODEM_RX, PIN_MODEM_TX, PIN_MODEM_RST, PIN_MODEM_PWKEY, PIN_MODEM_POWER);
  delay(PIN_MODEM_POWER >= 0 ? 6000 : 2000);  // SIM800L загружается
  if (modem.init()) {
    Serial.println("Модем отвечает");
    modem.scanStoredSms();
  } else {
    Serial.println("Модем не отвечает — проверьте питание SIM800L и провода RX/TX");
  }
  lastReportS = nowS();

  if (phoneDigits(std::string(OWNER_PHONES[0])).size() < 10)
    Serial.println("ВНИМАНИЕ: впишите свой номер в OWNER_PHONES (config.h), иначе SMS не уйдут!");
  Serial.println("Команды можно вводить здесь, в мониторе порта (115200). «помощь» — список.");
}

void loop() {
  feedWatchdog();
  modem.poll();
  handleSerial();

  const uint32_t ms = millis();
  if (ms - tMains >= 1000) {
    tMains = ms;
    mainsStep();
  }
  if (!sensorsReady && !dsPending && tSensors == 0) tSensors = ms - 10000;  // первый опрос сразу
  if (ms - tSensors >= 10000) {
    tSensors = ms;
    readI2c();
    readVbat();
    ds.requestTemperatures();  // без ожидания: результат заберём через 0,8 с
    dsPending = true;
    tDsReq = ms;
  }
  if (dsPending && ms - tDsReq >= 800) {
    dsPending = false;
    readDs();
    computeDerived();
    sensorsReady = true;
  }
  if (sensorsReady && ms - tControl >= 2000) {
    tControl = ms;
    controlStep();
  }
  if (sensorsReady && ms - tAlarms >= 10000) {
    tAlarms = ms;
    alarmsStep();
  }

  processIncomingSms();

  const uint32_t modemEvery = modemRegistered ? 60000 : 15000;
  if (ms - tModem >= modemEvery) {
    tModem = ms;
    modemHealth();
  }
  bootMessageCheck();
  dailyReportCheck();
  flushOneSms();

  if (rebootRequested && outCount == 0) {
    Serial.println("Перезагрузка по команде");
    delay(500);
    ESP.restart();
  }
  delay(10);
}

// =====================================================================
//  Вспомогательное
// =====================================================================
static uint32_t nowS() { return (uint32_t)(esp_timer_get_time() / 1000000LL); }

static void relayWrite(int pin, bool on) { digitalWrite(pin, (on == RELAY_ACTIVE_HIGH) ? HIGH : LOW); }

static void setupWatchdog() {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  esp_task_wdt_config_t cfg = {};
  cfg.timeout_ms = WDT_TIMEOUT_S * 1000;
  cfg.idle_core_mask = 0;
  cfg.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);
}

static String fmtNum(float v, int decimals) {
  if (!valid(v)) return String("—");
  char b[24];
  snprintf(b, sizeof(b), "%.*f", decimals, (double)v);
  String s(b);
  s.replace(".", ",");
  return s;
}

static String fmtT(float v, bool ok) {
  if (!ok || !valid(v)) return String("—");
  char b[24];
  snprintf(b, sizeof(b), "%+.1f°", (double)v);
  String s(b);
  s.replace(".", ",");
  return s;
}

static String fmtRH(const Meas& m) {
  if (!m.ok) return String("—");
  return String((int)lroundf(m.v)) + "%";
}

static String fmtDur(uint32_t s) {
  const uint32_t h = s / 3600, m = (s % 3600) / 60;
  if (h == 0) return String(m) + " мин";
  return String(h) + " ч " + String(m) + " мин";
}

static String modeName(OpMode m) {
  return m == OpMode::On ? String("вкл") : (m == OpMode::Off ? String("выкл") : String("авто"));
}

static void setTarget(float t, bool save) {
  targetC = t;
  heat.setThresholds(t - HEAT_ON_BELOW, t + HEAT_OFF_ABOVE);
  if (save) prefs.putFloat("target", t);
}

static void putMeas(Meas& m, bool success, float v) {
  if (success) {
    m.v = v;
    m.ok = true;
    m.fails = 0;
    return;
  }
  if (m.fails < 250) m.fails++;
  if (m.fails >= 3) m.ok = false;  // три неудачи подряд — датчик считаем отказавшим
}

// =====================================================================
//  Датчики
// =====================================================================
static void scanDs() {
  ds.begin();
  foundCount = 0;
  const int n = ds.getDeviceCount();
  for (int i = 0; i < n && foundCount < 8; ++i)
    if (ds.getAddress(found[foundCount], i)) foundCount++;
  ds.setResolution(12);
  ds.setWaitForConversion(false);
  Serial.print("DS18B20 найдено: ");
  Serial.println(foundCount);
}

static void loadRoles() {
  for (int r = 0; r < 3; ++r) {
    roleSet[r] = prefs.getBytesLength(ROLE_KEY[r]) == 8 && prefs.getBytes(ROLE_KEY[r], roleAddr[r], 8) == 8;
  }
}

static void readI2c() {
  const uint32_t now = nowS();
  float t = NAN, h = NAN;

  if (shtHeaterUntil && now >= shtHeaterUntil) {
    shtCellar.heater(false);
    shtHeaterUntil = 0;
  }
  if (now >= shtIgnoreUntil) {  // во время подсушки показания погребного SHT31 не берём
    const bool ok = shtCellar.read(t, h);
    putMeas(S.cellarT, ok, t);
    putMeas(S.cellarRH, ok, h);
  }
  {
    const bool ok = shtGarage.read(t, h);
    putMeas(S.garageT, ok, t);
    putMeas(S.garageRH, ok, h);
  }
  {
    const bool ok = shtOutdoor.read(t, h);
    putMeas(S.outT, ok, t);
    putMeas(S.outRH, ok, h);
  }

  // Если SHT31 в погребе два часа показывает 99,5 % и выше, он, скорее всего,
  // покрыт конденсатом: включаем его встроенный нагрев на 30 секунд.
  if (now >= shtIgnoreUntil) {
    if (S.cellarRH.ok && S.cellarRH.v >= 99.5f) {
      if (!cellarWetSince) {
        cellarWetSince = now;
      } else if (now - cellarWetSince > 2 * 3600) {
        shtCellar.heater(true);
        shtHeaterUntil = now + 30;
        shtIgnoreUntil = now + 330;
        cellarWetSince = 0;
      }
    } else {
      cellarWetSince = 0;
    }
  }
}

static void readDs() {
  for (int r = 0; r < 3; ++r) {
    if (!roleSet[r]) {
      S.dsT[r].ok = false;
      continue;
    }
    const float t = ds.getTempC(roleAddr[r]);
    putMeas(S.dsT[r], t > -55.0f && t < 125.0f, t);  // -127 — датчик не ответил
  }
}

static void readVbat() {
  if (!HAS_VBAT_DIVIDER) {
    S.vbat = NAN;
    return;
  }
  uint32_t sum = 0;
  for (int i = 0; i < 8; ++i) sum += analogReadMilliVolts(PIN_VBAT_SENSE);
  S.vbat = (float)sum / 8.0f / 1000.0f * VBAT_DIVIDER;
}

static void computeDerived() {
  const uint32_t now = nowS();
  if (S.dsT[ROLE_CELLAR].ok) {
    S.cellarC = S.dsT[ROLE_CELLAR].v;
    S.cellarOk = true;
  } else if (S.cellarT.ok && now >= shtIgnoreUntil) {
    S.cellarC = S.cellarT.v;  // запасной вариант — SHT31 в погребе
    S.cellarOk = true;
  } else {
    S.cellarOk = false;
  }
  S.tdGarage = (S.garageT.ok && S.garageRH.ok) ? dewPoint(S.garageT.v, S.garageRH.v) : NAN;
  S.tdOut = (S.outT.ok && S.outRH.ok) ? dewPoint(S.outT.v, S.outRH.v) : NAN;
}

static bool mainsRaw() { return analogReadMilliVolts(PIN_MAINS_SENSE) > MAINS_PRESENT_MV; }

static void mainsStep() {
  const bool raw = mainsRaw();
  if (raw == S.mains) {
    mainsDiff = 0;
    return;
  }
  if (++mainsDiff < 5) return;  // 5 секунд подряд — не случайная помеха
  mainsDiff = 0;
  S.mains = raw;
  const uint32_t now = nowS();
  if (!raw) {
    mainsLostAt = now;
    queueSmsAll("Пропало 220 В. Обогрев и вытяжка не работают, контроллер на аккумуляторе (" +
                fmtNum(S.vbat, 2) + " В).");
  } else {
    queueSmsAll("220 В снова есть. Света не было " + fmtDur(now - mainsLostAt) + ".");
  }
}

// =====================================================================
//  Управление
// =====================================================================
static void applyOutputs(bool gun, bool purge, bool fan) {
  if (purge != S.purge) {  // кулер включаем раньше, чем выключаем пушку
    relayWrite(PIN_RELAY_PURGE, purge);
    S.purge = purge;
    Serial.println(purge ? "Продувка: вкл" : "Продувка: выкл");
  }
  if (gun != S.gun) {
    relayWrite(PIN_RELAY_GUN, gun);
    S.gun = gun;
    Serial.println(gun ? "Пушка: вкл" : "Пушка: выкл");
  }
  if (fan != S.fan) {
    relayWrite(PIN_RELAY_VENT, fan);
    S.fan = fan;
    Serial.println(fan ? "Вытяжка: вкл" : "Вытяжка: выкл");
  }
}

static void controlStep() {
  const uint32_t now = nowS();
  const uint32_t dt = lastControlS ? now - lastControlS : 0;
  lastControlS = now;
  if (S.gun) gunSecDay += dt;
  if (S.fan) fanSecDay += dt;

  const Meas& outlet = S.dsT[ROLE_GUN];
  const bool fireNow = (S.dsT[ROLE_CELLAR].ok && S.dsT[ROLE_CELLAR].v > FIRE_CELLAR_C) ||
                       (S.cellarT.ok && now >= shtIgnoreUntil && S.cellarT.v > FIRE_CELLAR_C) ||
                       (outlet.ok && outlet.v > FIRE_OUTLET_C);
  if (fireNow && !fireLock) {
    fireLock = true;
    prefs.putBool("fire", true);
    heat.lockFire();
    applyOutputs(false, false, false);
    queueSmsAll("ТРЕВОГА! Возможен пожар в погребе: " + fmtT(S.cellarC, S.cellarOk) + ", выход пушки " +
                fmtT(outlet.v, outlet.ok) + ". Всё отключено. После проверки отправьте «пуск».");
  }

  const HeatInputs hi{now, S.cellarC, S.cellarOk, outlet.v, outlet.ok, S.mains, stopped, heatMode, fireLock};
  const HeatOutputs ho = heat.step(hi);
  const uint8_t ev = heat.takeEvents();
  if (ev & HeatController::EV_OVERHEAT)
    queueSmsAll("Перегрев пушки: на выходе " + fmtT(outlet.v) + ". Выключена с продувкой, пауза " +
                fmtDur(GUN_OVERHEAT_PAUSE_S) + ".");
  if (ev & HeatController::EV_MAXRUN) {
    queueSmsAll("Пушка грела " + fmtDur(HEAT_MAX_RUN_S) + " без перерыва. Пауза " + fmtDur(HEAT_MAX_RUN_PAUSE_S) +
                ", потом продолжит.");
    if (heatMode == OpMode::On) heatMode = OpMode::Auto;  // ручное включение — один цикл
  }
  if (heat.state() == HeatState::Heating && prevHeatState != HeatState::Heating) heatStartC = S.cellarC;
  prevHeatState = heat.state();

  const bool ventSensorsOk = S.garageRH.ok && S.outT.ok && valid(S.tdGarage) && valid(S.tdOut);
  const VentInputs vi{now, ventSensorsOk, S.tdGarage, S.tdOut, S.garageRH.v, S.outT.v,
                      S.mains, stopped || fireLock, ventMode};
  const bool fan = vent.step(vi);

  applyOutputs(ho.gun, ho.purge && !fireLock, fan && !fireLock);
}

// =====================================================================
//  Тревоги
// =====================================================================
static void alarm(AlarmTracker& a, bool cond, bool clearCond, uint32_t holdS, uint32_t repeatS,
                  const String& raiseMsg, const String& clearMsg) {
  const AlarmEvent e = a.update(cond, clearCond, nowS(), holdS, repeatS);
  if (e == AlarmEvent::Raise || e == AlarmEvent::Repeat) queueSmsAll(raiseMsg);
  else if (e == AlarmEvent::Clear && clearMsg.length()) queueSmsAll(clearMsg);
}

static void alarmsStep() {
  const uint32_t now = nowS();
  const float t = S.cellarC;
  const bool tOk = S.cellarOk;
  const String none;

  alarm(aCold, tOk && t < ALARM_COLD_C, tOk && t > ALARM_COLD_CLEAR_C, 10 * 60, 3 * 3600,
        "Погреб: холодно, " + fmtT(t) + ". Пушка не справляется или не работает.",
        "Погреб: температура снова в норме, " + fmtT(t) + ".");
  alarm(aHot, tOk && t > ALARM_HOT_C, tOk && t < ALARM_HOT_CLEAR_C, 10 * 60, 3 * 3600,
        "Погреб: жарко, " + fmtT(t) + ". Пушка не выключается?",
        "Погреб: температура снова в норме, " + fmtT(t) + ".");
  alarm(aNoCellar, !tOk, tOk, 60, 6 * 3600,
        String("Нет показаний температуры погреба! Обогрев выключен. Проверьте датчики."),
        String("Датчик температуры погреба снова работает."));

  const bool both = S.dsT[ROLE_CELLAR].ok && S.cellarT.ok && now >= shtIgnoreUntil;
  const float diff = both ? fabsf(S.dsT[ROLE_CELLAR].v - S.cellarT.v) : 0.0f;
  alarm(aDisagree, both && diff > SENSOR_DISAGREE_C, !both || diff < SENSOR_DISAGREE_C - 1.0f, 3600, 24 * 3600,
        "Датчики в погребе расходятся: DS18B20 " + fmtT(S.dsT[ROLE_CELLAR].v) + ", SHT31 " + fmtT(S.cellarT.v) + ".",
        none);
  alarm(aDry, S.cellarRH.ok && S.cellarRH.v < ALARM_CELLAR_DRY_RH,
        S.cellarRH.ok && S.cellarRH.v > ALARM_CELLAR_DRY_RH + 3.0f, 6 * 3600, 24 * 3600,
        "Погреб: сухо, влажность " + fmtRH(S.cellarRH) + ". Поставьте воду или увлажните песок.", none);

  const bool heating = heat.state() == HeatState::Heating;
  const Meas& outlet = S.dsT[ROLE_GUN];
  alarm(aNoHeat,
        heating && now - heat.heatingSince() > GUN_NO_HEAT_AFTER_S && outlet.ok && tOk &&
            outlet.v < t + GUN_NO_HEAT_DELTA_C,
        !heating, 0, 0,
        "Пушка включена, но не греет: на выходе " + fmtT(outlet.v) + ". Проверьте пушку и её автомат.", none);
  alarm(aNotRising,
        heating && now - heat.heatingSince() > GUN_NOT_RISING_AFTER_S && tOk && valid(heatStartC) &&
            t - heatStartC < GUN_NOT_RISING_MIN_C,
        !heating, 0, 0,
        "Пушка греет уже " + fmtDur(now - heat.heatingSince()) + ", а в погребе не теплеет: " + fmtT(t) + ".", none);
  alarm(aStuck,
        heat.state() == HeatState::Idle && outlet.ok && outlet.v > GUN_STUCK_OUTLET_C &&
            now - heat.offSince() > GUN_STUCK_AFTER_S,
        outlet.ok && outlet.v < GUN_STUCK_OUTLET_C - 10.0f, 0, 3600,
        "Пушка выключена, а на выходе " + fmtT(outlet.v) + ". Возможно, залипло реле! Отправьте «стоп» и проверьте.",
        String("Пушка остыла, всё в порядке."));

  struct SensorCheck {
    const Meas* m;
    bool        needed;
    const char* name;
  };
  const SensorCheck checks[6] = {
      {&S.cellarT, true, "SHT31 в погребе"},
      {&S.garageT, true, "SHT31 в гараже"},
      {&S.outT, true, "SHT31 на улице"},
      {&S.dsT[ROLE_CELLAR], roleSet[ROLE_CELLAR], "DS18B20 в погребе"},
      {&S.dsT[ROLE_GUN], roleSet[ROLE_GUN], "DS18B20 на выходе пушки"},
      {&S.dsT[ROLE_CAR], roleSet[ROLE_CAR], "DS18B20 на кузове"},
  };
  for (int i = 0; i < 6; ++i) {
    alarm(aSensor[i], checks[i].needed && !checks[i].m->ok, checks[i].m->ok, 5 * 60, 24 * 3600,
          "Не отвечает датчик: " + String(checks[i].name) + ".",
          "Датчик снова работает: " + String(checks[i].name) + ".");
  }

  const Meas& car = S.dsT[ROLE_CAR];
  const bool condRisk = car.ok && valid(S.tdGarage) && car.v <= S.tdGarage + CAR_CONDENSATION_MARGIN_C;
  alarm(aCond, condRisk,
        !car.ok || !valid(S.tdGarage) || car.v > S.tdGarage + CAR_CONDENSATION_MARGIN_C + 1.0f, 15 * 60, 12 * 3600,
        "Гараж: риск конденсата на машине! Кузов " + fmtT(car.v) + ", точка росы " + fmtT(S.tdGarage) +
            ". Не открывайте ворота в сырую погоду.",
        String("Гараж: риск конденсата миновал."));
  alarm(aDamp, S.garageRH.ok && S.garageRH.v > GARAGE_DAMP_RH, S.garageRH.ok && S.garageRH.v < GARAGE_DAMP_RH - 5.0f,
        12 * 3600, 24 * 3600, "Гараж: сыро уже 12 часов, влажность " + fmtRH(S.garageRH) + ".",
        String("Гараж: влажность снова в норме."));
  alarm(aBattery, !S.mains && valid(S.vbat) && S.vbat < VBAT_LOW_V,
        S.mains || (valid(S.vbat) && S.vbat > VBAT_LOW_V + 0.2f), 60, 2 * 3600,
        "Аккумулятор садится: " + fmtNum(S.vbat, 2) + " В, света нет.", none);
}

// =====================================================================
//  Тексты
// =====================================================================
static String heatText() {
  const uint32_t now = nowS();
  switch (heat.state()) {
    case HeatState::Heating:
      return "греет " + fmtDur(now - heat.heatingSince());
    case HeatState::Purging:
      return String("продувка");
    case HeatState::FireLock:
      return String("БЛОКИРОВКА после тревоги");
    default:
      break;
  }
  if (stopped) return String("СТОП");
  if (!S.mains) return String("нет 220 В");
  if (heatMode == OpMode::Off) return String("выкл вручную");
  return String("выкл");
}

static String statusText() {
  const float kwh = (float)gunSecDay / 3600.0f * GUN_POWER_KW;
  String s;
  s += "Погреб " + fmtT(S.cellarC, S.cellarOk) + " " + fmtRH(S.cellarRH) + "\n";
  s += "Пушка: " + heatText() + ", за сутки " + fmtDur(gunSecDay) + " ≈" + fmtNum(kwh, 1) + " кВт·ч\n";
  s += "Гараж " + fmtT(S.garageT.v, S.garageT.ok) + " " + fmtRH(S.garageRH) + ", т.р. " + fmtT(S.tdGarage) + "\n";
  s += "Улица " + fmtT(S.outT.v, S.outT.ok) + " " + fmtRH(S.outRH) + ", т.р. " + fmtT(S.tdOut) + "\n";
  s += "Кузов " + fmtT(S.dsT[ROLE_CAR].v, S.dsT[ROLE_CAR].ok) + "\n";
  s += "Вытяжка: " + String(S.fan ? "вкл" : "выкл") +
       (ventMode != OpMode::Auto ? String(" (вручную)") : String("")) + ", за сутки " + fmtDur(fanSecDay) + "\n";
  s += "220 В: " + String(S.mains ? "есть" : "НЕТ") + ", АКБ " + fmtNum(S.vbat, 2) + " В\n";
  s += "Цель " + fmtT(targetC) + (stopped ? String(", СТОП") : String("")) + ", сигнал " + String(modemCsq) + "/31";
  return s;
}

static String shortStatus() {
  return "Погреб " + fmtT(S.cellarC, S.cellarOk) + " " + fmtRH(S.cellarRH) + ", гараж " +
         fmtT(S.garageT.v, S.garageT.ok) + " " + fmtRH(S.garageRH) + ", 220 В " + String(S.mains ? "есть" : "НЕТ") + ".";
}

static String reportText() {
  const float kwh = (float)gunSecDay / 3600.0f * GUN_POWER_KW;
  return "Отчёт. Погреб " + fmtT(S.cellarC, S.cellarOk) + " " + fmtRH(S.cellarRH) + ", гараж " +
         fmtT(S.garageT.v, S.garageT.ok) + " " + fmtRH(S.garageRH) + ", улица " + fmtT(S.outT.v, S.outT.ok) +
         ". Пушка " + fmtDur(gunSecDay) + " ≈" + fmtNum(kwh, 1) + " кВт·ч, вытяжка " + fmtDur(fanSecDay) +
         ". 220 В " + String(S.mains ? "есть" : "НЕТ") + ", АКБ " + fmtNum(S.vbat, 2) + " В.";
}

static String addrShort(const uint8_t* a) {
  char b[12];
  snprintf(b, sizeof(b), "%02X%02X%02X", a[5], a[6], a[7]);
  return String(b);
}

static String sensorsText() {
  ds.setWaitForConversion(true);
  ds.requestTemperatures();
  ds.setWaitForConversion(false);
  String s = "Найдено DS18B20: " + String(foundCount);
  for (int i = 0; i < foundCount; ++i) {
    const float t = ds.getTempC(found[i]);
    String role = "не назначен";
    for (int r = 0; r < 3; ++r)
      if (roleSet[r] && memcmp(roleAddr[r], found[i], 8) == 0) role = ROLE_NAME[r];
    s += "\n" + String(i + 1) + ") …" + addrShort(found[i]) + " " + fmtT(t, t > -55.0f && t < 125.0f) + " — " + role;
  }
  s += "\nНазначить: «датчик погреб 1», «датчик пушка 2», «датчик кузов 3».";
  return s;
}

static String resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:
      return String("включение питания");
    case ESP_RST_SW:
      return String("перезагрузка по команде");
    case ESP_RST_PANIC:
      return String("сбой программы");
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:
      return String("сработал сторожевой таймер");
    case ESP_RST_BROWNOUT:
      return String("просадка питания");
    default:
      return String("перезапуск");
  }
}

static const char* HELP_TEXT =
    "Команды: статус, отчёт, тест, стоп, пуск, обогрев вкл/выкл/авто, вытяжка вкл/выкл/авто, цель 3, "
    "датчики, датчик погреб/пушка/кузов N, перезагрузка.";

// =====================================================================
//  Команды (SMS и монитор порта)
// =====================================================================
static String executeCommand(const String& raw) {
  const SmsCommand c = parseCommand(normalizeText(std::string(raw.c_str())));
  switch (c.type) {
    case CmdType::Status:
      return statusText();

    case CmdType::Help:
      return String(HELP_TEXT);

    case CmdType::Report:
      return reportText();

    case CmdType::Test:
      queueSmsAll("Тестовое сообщение. " + shortStatus());
      return String("Отправляю тестовое SMS на номера из config.h.");

    case CmdType::Stop:
      stopped = true;
      prefs.putBool("stopped", true);
      heatMode = OpMode::Auto;
      ventMode = OpMode::Auto;
      return String("Всё остановлено: пушка (с продувкой) и вытяжка выключены. Чтобы возобновить, отправьте «пуск».");

    case CmdType::Start:
      stopped = false;
      prefs.putBool("stopped", false);
      if (fireLock) {
        fireLock = false;
        prefs.putBool("fire", false);
        heat.clearFire();
      }
      heatMode = OpMode::Auto;
      ventMode = OpMode::Auto;
      return "Автоматический режим включён. " + shortStatus();

    case CmdType::HeatMode:
      heatMode = (OpMode)c.mode;
      return "Обогрев: " + modeName(heatMode) +
             (heatMode == OpMode::On ? String(" (не дольше одного цикла, защиты работают)") : String("")) +
             (stopped ? String(". Действует СТОП — отправьте «пуск».") : String("."));

    case CmdType::VentMode:
      ventMode = (OpMode)c.mode;
      return "Вытяжка: " + modeName(ventMode) + (stopped ? String(". Действует СТОП — отправьте «пуск».") : String("."));

    case CmdType::Target:
      if (c.value < 0.5f || c.value > 10.0f) return String("Цель должна быть от 0,5 до 10 °C.");
      setTarget(c.value, true);
      return "Цель " + fmtT(targetC) + ": пушка включается ниже " + fmtT(targetC - HEAT_ON_BELOW) +
             " и выключается выше " + fmtT(targetC + HEAT_OFF_ABOVE) + ".";

    case CmdType::Sensors:
      scanDs();
      return sensorsText();

    case CmdType::AssignSensor: {
      scanDs();
      const int r = c.role == SensorRole::Cellar ? ROLE_CELLAR : (c.role == SensorRole::Gun ? ROLE_GUN : ROLE_CAR);
      if (c.index < 1 || c.index > foundCount)
        return "Нет датчика с номером " + String(c.index) + ". Отправьте «датчики», чтобы увидеть список.";
      const uint8_t* addr = found[c.index - 1];
      for (int k = 0; k < 3; ++k) {
        if (k != r && roleSet[k] && memcmp(roleAddr[k], addr, 8) == 0) {
          roleSet[k] = false;
          prefs.remove(ROLE_KEY[k]);
        }
      }
      memcpy(roleAddr[r], addr, 8);
      roleSet[r] = true;
      prefs.putBytes(ROLE_KEY[r], roleAddr[r], 8);
      S.dsT[r] = Meas();
      return "Датчик " + String(c.index) + " назначен: " + String(ROLE_NAME[r]) + ".";
    }

    case CmdType::Reboot:
      rebootRequested = true;
      return String("Перезагружаюсь.");

    case CmdType::Unknown:
    default:
      return String("Не понял команду. Отправьте «помощь».");
  }
}

static void handleSerial() {
  while (Serial.available()) {
    const char ch = (char)Serial.read();
    if (ch == '\n' || ch == '\r') {
      if (serialLine.length()) {
        Serial.println(executeCommand(serialLine));
        serialLine = "";
      }
    } else if (serialLine.length() < 200) {
      serialLine += ch;
    }
  }
}

// =====================================================================
//  SMS и модем
// =====================================================================
static void queueSmsTo(const String& to, const String& text) {
  Serial.print("[SMS → ");
  Serial.print(to);
  Serial.print("] ");
  Serial.println(text);
  if (phoneDigits(std::string(to.c_str())).size() < 10) return;  // номер не вписан в config.h
  if (outCount >= OUTQ) {
    Serial.println("Очередь SMS переполнена, сообщение отброшено");
    return;
  }
  OutSms& m = outQ[(outHead + outCount) % OUTQ];
  m.to = to;
  m.text = text;
  m.tries = 0;
  outCount++;
}

static void queueSmsAll(const String& text) {
  for (int i = 0; i < OWNER_COUNT; ++i) queueSmsTo(String(OWNER_PHONES[i]), text);
}

static void flushOneSms() {
  if (outCount == 0 || !modem.ready() || !modemRegistered) return;
  OutSms& m = outQ[outHead];
  const bool ok = modem.sendSms(m.to, m.text);
  if (ok || ++m.tries >= 3) {
    if (!ok) Serial.println("SMS не отправлено после 3 попыток");
    outHead = (outHead + 1) % OUTQ;
    outCount--;
  }
}

static bool isOwner(const String& phone) {
  for (int i = 0; i < OWNER_COUNT; ++i)
    if (samePhone(std::string(phone.c_str()), std::string(OWNER_PHONES[i]))) return true;
  return false;
}

static void processIncomingSms() {
  const int idx = modem.nextPendingSms();
  if (idx < 0) return;
  String from, text;
  const bool ok = modem.readSms(idx, from, text);
  modem.deleteSms(idx);
  if (!ok) return;
  Serial.print("[SMS ← ");
  Serial.print(from);
  Serial.print("] ");
  Serial.println(text);
  if (!isOwner(from)) {
    Serial.println("Номера нет в списке владельцев — игнорирую");
    return;
  }
  const String reply = executeCommand(text);
  if (reply.length()) queueSmsTo(from, reply);
}

static void modemHealth() {
  const uint32_t now = nowS();
  if (!modem.ready() || !modem.ping()) {
    modemRegistered = false;
    if (++modemFails >= 3) {
      Serial.println("Модем не отвечает — аппаратный сброс");
      modem.hardReset();
      modemFails = 0;
    } else {
      modem.init();
    }
    return;
  }
  modemFails = 0;
  modemRegistered = modem.isRegistered();
  modemCsq = modem.signalQuality();
  if (modemRegistered) {
    notRegisteredSince = 0;
    const NetTime t = modem.networkTime();
    if (t.valid) {
      netTime = t;
      netTimeAtS = now;
    }
  } else if (!notRegisteredSince) {
    notRegisteredSince = now;
  } else if (now - notRegisteredSince > 30 * 60) {
    Serial.println("Нет регистрации в сети 30 минут — сброс модема");
    modem.hardReset();
    notRegisteredSince = 0;
  }
}

static void dailyReportCheck() {
  if (!DAILY_REPORT || !sensorsReady) return;
  const uint32_t now = nowS();
  const bool timeOk = netTime.valid && now - netTimeAtS < 10 * 60;
  bool due = false;
  if (timeOk) {
    const int day = netTime.year * 400 + netTime.month * 32 + netTime.day;
    if (netTime.hour == REPORT_HOUR && day != lastReportDay) {
      due = true;
      lastReportDay = day;
      prefs.putInt("repday", day);
    }
  } else if (now - lastReportS >= 24UL * 3600UL) {
    due = true;
  }
  if (!due) return;
  lastReportS = now;
  queueSmsAll(reportText());
  gunSecDay = 0;
  fanSecDay = 0;
}

static void bootMessageCheck() {
  if (bootMsgSent || !modemRegistered || !sensorsReady) return;
  bootMsgSent = true;
  String m = "Контроллер погреба запущен (" + resetReasonText() + "). " + shortStatus();
  int unassigned = 0;
  for (int r = 0; r < 3; ++r)
    if (!roleSet[r]) unassigned++;
  if (unassigned && foundCount)
    m += " Найдено DS18B20: " + String(foundCount) + ", не назначено ролей: " + String(unassigned) +
         " — отправьте «датчики».";
  if (stopped) m += " Действует СТОП.";
  if (fireLock) m += " БЛОКИРОВКА после тревоги — отправьте «пуск».";
  queueSmsAll(m);
}
