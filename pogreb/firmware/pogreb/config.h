#pragma once
#include <stdint.h>

// =====================================================================
//  Контроллер погреба и гаража — НАСТРОЙКИ
//  Перед прошивкой впишите свой номер телефона в OWNER_PHONES.
// =====================================================================

#define FW_VERSION "1.0"

// Номера, которые могут управлять контроллером и получают тревоги.
// Формат +7XXXXXXXXXX. Можно несколько: { "+7...", "+7..." }.
// SMS с других номеров контроллер игнорирует.
static const char* const OWNER_PHONES[] = {
  "+7XXXXXXXXXX",
};
static const int OWNER_COUNT = sizeof(OWNER_PHONES) / sizeof(OWNER_PHONES[0]);

// Ежедневный отчёт: час по времени сети (0–23). Если сеть не сообщает
// время, отчёт приходит раз в 24 часа после включения.
static const bool DAILY_REPORT = true;
static const int  REPORT_HOUR  = 9;

// Мощность пушки в кВт — только для подсчёта расхода в отчёте.
static const float GUN_POWER_KW = 2.0f;

// ---------------- Плата ----------------
// 0 — ESP32 DevKit V1 + отдельный SIM800L (как на схеме),
// 1 — LilyGO T-Call: ESP32 и SIM800L на одной плате, питание модема и
//     зарядка аккумулятора уже на ней (TP4056, MT3608, делитель UART не нужны).
#define BOARD_TCALL 0

// ---------------- Пины (рис. 3 и 5 на странице со схемой) ----------------
static const int PIN_MAINS_SENSE = 34;  // делитель 10к/15к от +5 В зарядки
static const int PIN_VBAT_SENSE  = 35;  // делитель 100к/100к от аккумулятора
static const int PIN_I2C0_SDA    = 21;  // SHT31 погреб (0x44) и гараж (0x45)
static const int PIN_I2C0_SCL    = 22;
static const int PIN_I2C1_SDA    = 32;  // SHT31 улица (0x44), отдельная медленная шина
static const int PIN_I2C1_SCL    = 33;
static const int PIN_RELAY_VENT  = 25;  // реле 10 А — вытяжка гаража
#if BOARD_TCALL
// На T-Call ножки 26/27 заняты модемом, на 13 стоит светодиод.
static const int PIN_ONEWIRE     = 14;  // DS18B20 ×3, подтяжка 4,7 кОм к 3V3
static const int PIN_RELAY_GUN   = 18;  // реле 30 А — пушка
static const int PIN_RELAY_PURGE = 19;  // реле 10 А — кулер продувки
static const int PIN_MODEM_RX    = 26;  // разведено на плате
static const int PIN_MODEM_TX    = 27;
static const int PIN_MODEM_RST   = 5;
static const int PIN_MODEM_PWKEY = 4;
static const int PIN_MODEM_POWER = 23;  // ключ питания модема на плате
#else
static const int PIN_ONEWIRE     = 13;  // DS18B20 ×3, подтяжка 4,7 кОм к 3V3
static const int PIN_RELAY_GUN   = 26;  // реле 30 А — пушка
static const int PIN_RELAY_PURGE = 27;  // реле 10 А — кулер продувки
static const int PIN_MODEM_RX    = 16;  // ESP32 RX2 ← TXD SIM800L
static const int PIN_MODEM_TX    = 17;  // ESP32 TX2 → RXD SIM800L (через делитель 1к/2,2к)
static const int PIN_MODEM_RST   = 4;   // RST SIM800L
static const int PIN_MODEM_PWKEY = -1;
static const int PIN_MODEM_POWER = -1;
#endif

// Делитель 100к/100к от аккумулятора на PIN_VBAT_SENSE. Если не ставили — false,
// тогда напряжение аккумулятора не измеряется и тревоги о нём нет.
static const bool HAS_VBAT_DIVIDER = true;

// Реле с перемычкой в положении H включаются высоким уровнем.
static const bool RELAY_ACTIVE_HIGH = true;

static const uint8_t  SHT_ADDR_CELLAR  = 0x44;
static const uint8_t  SHT_ADDR_GARAGE  = 0x45;  // у гаражного SHT31 ножка ADDR на 3V3
static const uint8_t  SHT_ADDR_OUTDOOR = 0x44;
static const uint32_t I2C0_HZ = 50000;
static const uint32_t I2C1_HZ = 10000;  // медленно — для длинного кабеля на улицу

// ---------------- Погреб: обогрев ----------------
static const float    DEFAULT_TARGET_C     = 3.0f;   // цель
static const float    HEAT_ON_BELOW        = 1.0f;   // пушка включается ниже «цель − 1,0»
static const float    HEAT_OFF_ABOVE       = 0.5f;   // и выключается выше «цель + 0,5»
static const uint32_t HEAT_MIN_ON_S        = 5 * 60;
static const uint32_t HEAT_MIN_OFF_S       = 5 * 60;
static const uint32_t HEAT_MAX_RUN_S       = 120 * 60;  // дольше без перерыва не греть
static const uint32_t HEAT_MAX_RUN_PAUSE_S = 15 * 60;
static const float    GUN_OUTLET_MAX_C     = 85.0f;     // перегрев на выходе пушки
static const uint32_t GUN_OVERHEAT_PAUSE_S = 30 * 60;
static const float    PURGE_DONE_C         = 40.0f;     // продувать, пока выход не остынет
static const uint32_t PURGE_MIN_S          = 2 * 60;
static const uint32_t PURGE_MAX_S          = 10 * 60;
static const uint32_t PURGE_NO_SENSOR_S    = 3 * 60;    // если датчика на выходе нет

// ---------------- Погреб: тревоги ----------------
static const float    ALARM_COLD_C           = 0.5f;
static const float    ALARM_COLD_CLEAR_C     = 1.5f;
static const float    ALARM_HOT_C            = 8.0f;
static const float    ALARM_HOT_CLEAR_C      = 6.0f;
static const float    FIRE_CELLAR_C          = 25.0f;   // выше — считаем пожаром, всё выключаем
static const float    FIRE_OUTLET_C          = 110.0f;
static const float    ALARM_CELLAR_DRY_RH    = 80.0f;
static const uint32_t GUN_NO_HEAT_AFTER_S    = 5 * 60;  // греет, а на выходе холодно
static const float    GUN_NO_HEAT_DELTA_C    = 10.0f;
static const uint32_t GUN_NOT_RISING_AFTER_S = 60 * 60; // греет час, а теплее не стало
static const float    GUN_NOT_RISING_MIN_C   = 0.3f;
static const float    GUN_STUCK_OUTLET_C     = 50.0f;   // выключена, а на выходе горячо
static const uint32_t GUN_STUCK_AFTER_S      = 20 * 60;
static const float    SENSOR_DISAGREE_C      = 2.5f;

// ---------------- Гараж ----------------
static const float    VENT_ON_DTD     = 3.0f;   // включать, если точка росы снаружи ниже на 3 °C
static const float    VENT_OFF_DTD    = 1.0f;   // выключать, если разница меньше 1 °C
static const float    VENT_RH_ON      = 60.0f;  // и только если в гараже влажнее 60 %
static const float    VENT_RH_OFF     = 55.0f;
static const uint32_t VENT_MIN_SWITCH_S = 5 * 60;
static const float    VENT_FROST_C    = -20.0f; // в сильный мороз — короткими сеансами
static const uint32_t VENT_FROST_MAX_ON_PER_HOUR_S = 10 * 60;
static const float    CAR_CONDENSATION_MARGIN_C = 1.0f;
static const float    GARAGE_DAMP_RH  = 75.0f;

// ---------------- Питание ----------------
static const uint32_t MAINS_PRESENT_MV = 1500;  // на GPIO34 при наличии 5 В около 3000 мВ
static const float    VBAT_DIVIDER     = 2.0f;
static const float    VBAT_LOW_V       = 3.5f;

// Сторожевой таймер: перезагрузка, если программа зависла.
static const uint32_t WDT_TIMEOUT_S = 90;
