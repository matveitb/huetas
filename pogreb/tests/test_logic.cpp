// Тесты логики контроллера на компьютере: g++ -std=c++17
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

#include "../firmware/pogreb/commands.h"
#include "../firmware/pogreb/logic.h"
#include "../firmware/pogreb/pdu.h"
#include "../firmware/pogreb/textutil.h"

static int g_fail = 0, g_pass = 0;
#define CHECK(cond)                                                     \
  do {                                                                  \
    if (cond) {                                                         \
      ++g_pass;                                                         \
    } else {                                                            \
      ++g_fail;                                                         \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);       \
    }                                                                   \
  } while (0)
#define NEAR(a, b, eps) CHECK(std::fabs((a) - (b)) < (eps))

static HeatParams heatParams() {
  return HeatParams{2.0f, 3.5f, 300, 300, 7200, 900, 85.0f, 1800, 40.0f, 120, 600, 180};
}

static HeatInputs hin(uint32_t t, float cellar, float outlet = 20.0f) {
  HeatInputs in{};
  in.nowS = t;
  in.cellarC = cellar;
  in.cellarOk = true;
  in.outletC = outlet;
  in.outletOk = true;
  in.mainsOk = true;
  in.stopped = false;
  in.mode = OpMode::Auto;
  in.fire = false;
  return in;
}

static void testDewPoint() {
  NEAR(dewPoint(20.0f, 50.0f), 9.26f, 0.05f);
  NEAR(dewPoint(0.0f, 100.0f), 0.0f, 0.01f);
  NEAR(dewPoint(-10.0f, 90.0f), -11.33f, 0.05f);
  CHECK(std::isnan(dewPoint(5.0f, 0.0f)));
  CHECK(std::isnan(dewPoint(NAN, 50.0f)));
  // зимний пример из обсуждения: −10 °C и 90 % на улице суше, чем 0 °C и 80 % в гараже
  CHECK(dewPoint(-10.0f, 90.0f) < dewPoint(0.0f, 80.0f) - 3.0f);
}

static void testCrc() {
  const uint8_t d[2] = {0xBE, 0xEF};
  CHECK(sensirionCrc8(d, 2) == 0x92);  // пример из документации Sensirion
}

static void testHeatCycle() {
  HeatController h(heatParams());
  HeatOutputs o = h.step(hin(0, 1.5f));
  CHECK(o.gun && !o.purge);
  CHECK(h.state() == HeatState::Heating);

  o = h.step(hin(100, 3.6f, 60));  // уже тепло, но минимальное время работы не вышло
  CHECK(o.gun);

  o = h.step(hin(301, 3.6f, 60));  // выключаем с продувкой
  CHECK(!o.gun && o.purge);
  CHECK(h.state() == HeatState::Purging);

  o = h.step(hin(350, 3.5f, 60));  // выход ещё горячий
  CHECK(!o.gun && o.purge);

  o = h.step(hin(430, 3.4f, 35));  // прошло 129 с, выход остыл
  CHECK(!o.gun && !o.purge);
  CHECK(h.state() == HeatState::Idle);

  o = h.step(hin(500, 1.0f));  // холодно, но пауза 300 с от выключения ещё идёт
  CHECK(!o.gun);
  o = h.step(hin(601, 1.0f));
  CHECK(o.gun);
}

static void testHeatPurgeLimits() {
  HeatController h(heatParams());
  h.step(hin(0, 1.0f));
  HeatOutputs o = h.step(hin(400, 4.0f, 70));
  CHECK(o.purge);
  o = h.step(hin(400 + 599, 4.0f, 70));  // выход не остывает — максимум продувки
  CHECK(o.purge);
  o = h.step(hin(400 + 600, 4.0f, 70));
  CHECK(!o.purge && h.state() == HeatState::Idle);

  // без датчика на выходе — продувка по времени
  HeatController h2(heatParams());
  HeatInputs in = hin(0, 1.0f);
  in.outletOk = false;
  h2.step(in);
  in = hin(400, 4.0f);
  in.outletOk = false;
  CHECK(h2.step(in).purge);
  in.nowS = 400 + 179;
  CHECK(h2.step(in).purge);
  in.nowS = 400 + 180;
  CHECK(!h2.step(in).purge);
}

static void testHeatSafety() {
  // перегрев
  HeatController h(heatParams());
  h.step(hin(0, 1.0f));
  HeatOutputs o = h.step(hin(60, 1.2f, 90));
  CHECK(!o.gun && o.purge);
  CHECK(h.takeEvents() & HeatController::EV_OVERHEAT);
  CHECK(h.nextAllowedOn() == 60 + 1800);

  // максимум непрерывной работы
  HeatController h2(heatParams());
  h2.step(hin(0, 0.5f));
  o = h2.step(hin(7199, 0.6f, 60));
  CHECK(o.gun);
  o = h2.step(hin(7200, 0.6f, 60));
  CHECK(!o.gun && o.purge);
  CHECK(h2.takeEvents() & HeatController::EV_MAXRUN);
  CHECK(h2.nextAllowedOn() == 7200 + 900);

  // пожар: всё выключено без продувки и держится до снятия блокировки
  HeatController h3(heatParams());
  h3.step(hin(0, 1.0f));
  HeatInputs in = hin(10, 30.0f, 100);
  in.fire = true;
  o = h3.step(in);
  CHECK(!o.gun && !o.purge);
  CHECK(h3.state() == HeatState::FireLock);
  o = h3.step(hin(20, 1.0f));
  CHECK(!o.gun && h3.state() == HeatState::FireLock);
  h3.clearFire();
  o = h3.step(hin(30, 1.0f));
  CHECK(o.gun);

  // пропало 220 В — всё выкл сразу
  HeatController h4(heatParams());
  h4.step(hin(0, 1.0f));
  in = hin(50, 1.0f);
  in.mainsOk = false;
  o = h4.step(in);
  CHECK(!o.gun && !o.purge && h4.state() == HeatState::Idle);

  // отказ датчика погреба в авто — выключить с продувкой
  HeatController h5(heatParams());
  h5.step(hin(0, 1.0f));
  in = hin(50, 1.0f);
  in.cellarOk = false;
  o = h5.step(in);
  CHECK(!o.gun && o.purge);
  CHECK(h5.takeEvents() & HeatController::EV_NO_SENSOR);

  // СТОП — выключить с продувкой и не включать
  HeatController h6(heatParams());
  h6.step(hin(0, 1.0f));
  in = hin(10, 1.0f);
  in.stopped = true;
  o = h6.step(in);
  CHECK(!o.gun && o.purge);
  in.nowS = 1000;
  in.outletC = 20;
  h6.step(in);
  CHECK(!h6.step(in).gun);

  // ручное включение при тёплом погребе
  HeatController h7(heatParams());
  in = hin(0, 5.0f);
  in.mode = OpMode::On;
  CHECK(h7.step(in).gun);
  in.nowS = 1000;
  CHECK(h7.step(in).gun);  // в ручном режиме по термостату не выключается

  // не включаться, если выход уже перегрет
  HeatController h8(heatParams());
  CHECK(!h8.step(hin(0, 1.0f, 90)).gun);
}

static VentInputs vin(uint32_t t, float tdIn, float tdOut, float rhIn, float tOut = 0.0f) {
  VentInputs v{};
  v.nowS = t;
  v.sensorsOk = true;
  v.tdIn = tdIn;
  v.tdOut = tdOut;
  v.rhIn = rhIn;
  v.tOut = tOut;
  v.mainsOk = true;
  v.stopped = false;
  v.mode = OpMode::Auto;
  return v;
}

static void testVent() {
  const VentParams p{3.0f, 1.0f, 60.0f, 55.0f, 300, -20.0f, 600};
  VentController v(p);
  CHECK(!v.step(vin(0, 5.0f, -5.0f, 80.0f)));    // первые 5 минут не переключаемся
  CHECK(!v.step(vin(299, 5.0f, -5.0f, 80.0f)));
  CHECK(v.step(vin(300, 5.0f, -5.0f, 80.0f)));   // на улице суше — включаем
  CHECK(v.step(vin(400, 5.0f, 4.5f, 80.0f)));    // снаружи стало влажно, но рано переключать
  CHECK(!v.step(vin(600, 5.0f, 4.5f, 80.0f)));   // выключаем
  CHECK(!v.step(vin(1000, 5.0f, -5.0f, 58.0f))); // в гараже уже сухо (58 % < 60 %) — не включаем

  VentInputs in = vin(1100, 5.0f, -5.0f, 80.0f);
  in.mode = OpMode::On;
  CHECK(v.step(in));  // вручную — сразу
  in.mode = OpMode::Auto;
  in.stopped = true;
  CHECK(!v.step(in)); // СТОП — сразу

  // сильный мороз: не больше 10 минут в час
  VentController f(p);
  f.step(vin(0, 0.0f, -30.0f, 80.0f, -25.0f));
  CHECK(f.step(vin(300, 0.0f, -30.0f, 80.0f, -25.0f)));
  CHECK(f.step(vin(800, 0.0f, -30.0f, 80.0f, -25.0f)));
  CHECK(!f.step(vin(910, 0.0f, -30.0f, 80.0f, -25.0f)));  // 610 с работы — пауза до конца часа
  CHECK(!f.step(vin(3500, 0.0f, -30.0f, 80.0f, -25.0f)));
  CHECK(f.step(vin(3700, 0.0f, -30.0f, 80.0f, -25.0f)));  // новый час

  // нет данных — выключено
  VentController s(p);
  VentInputs bad = vin(400, 5.0f, -5.0f, 80.0f);
  bad.sensorsOk = false;
  CHECK(!s.step(bad));
}

static void testAlarm() {
  AlarmTracker a;
  CHECK(a.update(true, false, 0, 600, 3600) == AlarmEvent::None);
  CHECK(a.update(true, false, 599, 600, 3600) == AlarmEvent::None);
  CHECK(a.update(true, false, 600, 600, 3600) == AlarmEvent::Raise);
  CHECK(a.update(true, false, 1000, 600, 3600) == AlarmEvent::None);
  CHECK(a.update(true, false, 4200, 600, 3600) == AlarmEvent::Repeat);
  CHECK(a.update(false, false, 4300, 600, 3600) == AlarmEvent::None);  // гистерезис: ещё не сняли
  CHECK(a.update(false, true, 4400, 600, 3600) == AlarmEvent::Clear);
  // кратковременное условие не поднимает тревогу
  AlarmTracker b;
  b.update(true, false, 0, 600, 0);
  b.update(false, true, 300, 600, 0);
  CHECK(b.update(true, false, 400, 600, 0) == AlarmEvent::None);
  CHECK(b.update(true, false, 999, 600, 0) == AlarmEvent::None);
  CHECK(b.update(true, false, 1000, 600, 0) == AlarmEvent::Raise);
  CHECK(b.update(true, false, 100000, 600, 0) == AlarmEvent::None);  // без повторов
}

static void testText() {
  const std::vector<uint16_t> u = utf8ToUtf16("Привет");
  CHECK(u.size() == 6 && u[0] == 0x041F && u[5] == 0x0442);
  CHECK(utf16ToUtf8(u) == "Привет");
  std::string out;
  CHECK(ucs2HexToUtf8("041F0440", out) && out == "Пр");
  CHECK(ucs2HexToUtf8("002B0037003900310036", out) && out == "+7916");
  CHECK(!ucs2HexToUtf8("+79161234567", out));
  CHECK(!ucs2HexToUtf8("041", out));
  CHECK(normalizeText("  СТАТУС  ") == "статус");
  CHECK(normalizeText("Отчёт") == "отчет");
  CHECK(normalizeText("ЦЕЛЬ\t 2,5") == "цель 2,5");
  CHECK(normalizeText("Обогрев  ВКЛ\r\n") == "обогрев вкл");
  CHECK(phoneDigits("+7 (916) 123-45-67") == "79161234567");
  CHECK(phoneDigits("89161234567") == "79161234567");
  CHECK(samePhone("+79161234567", "89161234567"));
  CHECK(!samePhone("+79161234567", "+79161234568"));
  CHECK(!samePhone("+7XXXXXXXXXX", "+7"));
}

static void testPdu() {
  const std::vector<PduPart> p = buildSmsPdus("+79161234567", utf8ToUtf16("Привет"), 1);
  CHECK(p.size() == 1);
  CHECK(p[0].hex == "0001000B919761214365F700080C041F04400438043204350442");
  CHECK(p[0].tpduLen == 25);

  const std::vector<PduPart> n = buildSmsPdus("89161234567", utf8ToUtf16("Hi"), 1);
  CHECK(n[0].hex == "0001000B919761214365F7000804" "00480069");

  std::vector<uint16_t> longText(100, 0x0430);  // 100 букв «а»
  const std::vector<PduPart> m = buildSmsPdus("+79161234567", longText, 7);
  CHECK(m.size() == 2);
  CHECK(m[0].hex.substr(0, 4) == "0041");                   // признак заголовка
  CHECK(m[0].hex.find("8C050003070201") != std::string::npos);  // UDL 140, часть 1 из 2
  CHECK(m[1].hex.find("48050003070202") != std::string::npos);  // UDL 72 (6 + 33×2), часть 2
  CHECK(m[0].tpduLen == (int)m[0].hex.size() / 2 - 1);

  std::vector<uint16_t> huge(1000, 0x0430);
  CHECK(buildSmsPdus("+79161234567", huge, 1).size() == 6);  // не больше 6 частей
}

static void testCommands() {
  CHECK(parseCommand("статус").type == CmdType::Status);
  CHECK(parseCommand("статус.").type == CmdType::Status);
  CHECK(parseCommand("status").type == CmdType::Status);
  CHECK(parseCommand("помощь").type == CmdType::Help);
  CHECK(parseCommand("стоп").type == CmdType::Stop);
  CHECK(parseCommand("пуск").type == CmdType::Start);
  CHECK(parseCommand("отчет").type == CmdType::Report);
  CHECK(parseCommand("тест").type == CmdType::Test);
  CHECK(parseCommand("перезагрузка").type == CmdType::Reboot);
  CHECK(parseCommand("датчики").type == CmdType::Sensors);

  SmsCommand c = parseCommand("обогрев вкл");
  CHECK(c.type == CmdType::HeatMode && c.mode == 1);
  c = parseCommand("обогрев выкл");
  CHECK(c.type == CmdType::HeatMode && c.mode == -1);
  c = parseCommand("вытяжка авто");
  CHECK(c.type == CmdType::VentMode && c.mode == 0);
  CHECK(parseCommand("вытяжка").type == CmdType::Unknown);

  c = parseCommand("цель 2,5");
  CHECK(c.type == CmdType::Target && std::fabs(c.value - 2.5f) < 1e-6f);
  c = parseCommand("цель 3");
  CHECK(c.type == CmdType::Target && std::fabs(c.value - 3.0f) < 1e-6f);
  CHECK(parseCommand("цель тепло").type == CmdType::Unknown);

  c = parseCommand("датчик пушка 2");
  CHECK(c.type == CmdType::AssignSensor && c.role == SensorRole::Gun && c.index == 2);
  c = parseCommand("датчик погреб 1");
  CHECK(c.type == CmdType::AssignSensor && c.role == SensorRole::Cellar && c.index == 1);
  c = parseCommand("датчик кузов 3");
  CHECK(c.type == CmdType::AssignSensor && c.role == SensorRole::Car && c.index == 3);
  CHECK(parseCommand("датчик крыша 1").type == CmdType::Unknown);

  // полный путь: как придёт из SMS
  CHECK(parseCommand(normalizeText("Обогрев ВКЛ")).type == CmdType::HeatMode);
  CHECK(parseCommand(normalizeText("ОТЧЁТ")).type == CmdType::Report);
  CHECK(parseCommand(normalizeText("привет")).type == CmdType::Unknown);
}

int main() {
  testDewPoint();
  testCrc();
  testHeatCycle();
  testHeatPurgeLimits();
  testHeatSafety();
  testVent();
  testAlarm();
  testText();
  testPdu();
  testCommands();
  std::printf("%d проверок пройдено, %d не пройдено\n", g_pass, g_fail);
  return g_fail ? 1 : 0;
}
