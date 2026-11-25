#include "commands.h"

#include <cstdlib>
#include <initializer_list>
#include <vector>

static std::vector<std::string> splitWords(const std::string& s) {
  std::vector<std::string> v;
  std::string cur;
  for (char c : s) {
    if (c == ' ') {
      if (!cur.empty()) {
        v.push_back(cur);
        cur.clear();
      }
    } else {
      cur += c;
    }
  }
  if (!cur.empty()) v.push_back(cur);
  return v;
}

static bool oneOf(const std::string& s, std::initializer_list<const char*> list) {
  for (const char* p : list)
    if (s == p) return true;
  return false;
}

static bool startsWith(const std::string& s, const char* prefix) { return s.rfind(prefix, 0) == 0; }

static int parseMode(const std::string& w) {
  if (oneOf(w, {"вкл", "включить", "on", "1"})) return 1;
  if (oneOf(w, {"выкл", "выключить", "off", "0"})) return -1;
  if (oneOf(w, {"авто", "автомат", "auto"})) return 0;
  return 99;
}

static bool parseNumber(const std::string& w, float& out) {
  std::string t = w;
  for (char& c : t)
    if (c == ',') c = '.';
  char* end = nullptr;
  out = std::strtof(t.c_str(), &end);
  return end && end != t.c_str() && *end == '\0';
}

SmsCommand parseCommand(const std::string& normalized) {
  SmsCommand c;
  std::string text = normalized;
  while (text.size() > 1 && (text.back() == '.' || text.back() == '!')) text.pop_back();
  const std::vector<std::string> w = splitWords(text);
  if (w.empty()) return c;
  const std::string& a = w[0];

  if (oneOf(a, {"статус", "status", "?", "инфо"})) {
    c.type = CmdType::Status;
  } else if (oneOf(a, {"помощь", "help", "команды"})) {
    c.type = CmdType::Help;
  } else if (oneOf(a, {"стоп", "stop"})) {
    c.type = CmdType::Stop;
  } else if (oneOf(a, {"пуск", "старт", "start"})) {
    c.type = CmdType::Start;
  } else if (oneOf(a, {"отчет", "report"})) {
    c.type = CmdType::Report;
  } else if (oneOf(a, {"тест", "test"})) {
    c.type = CmdType::Test;
  } else if (oneOf(a, {"перезагрузка", "reboot", "рестарт"})) {
    c.type = CmdType::Reboot;
  } else if (oneOf(a, {"датчики", "sensors"})) {
    c.type = CmdType::Sensors;
  } else if (oneOf(a, {"обогрев", "heat", "пушка"}) || oneOf(a, {"вытяжка", "fan", "vent"})) {
    const bool isHeat = oneOf(a, {"обогрев", "heat", "пушка"});
    if (w.size() >= 2) {
      const int m = parseMode(w[1]);
      if (m != 99) {
        c.type = isHeat ? CmdType::HeatMode : CmdType::VentMode;
        c.mode = m;
      }
    }
  } else if (oneOf(a, {"цель", "target"})) {
    float v = 0;
    if (w.size() >= 2 && parseNumber(w[1], v)) {
      c.type = CmdType::Target;
      c.value = v;
    }
  } else if (oneOf(a, {"датчик", "sensor"})) {
    if (w.size() >= 3) {
      SensorRole role = SensorRole::None;
      const std::string& r = w[1];
      if (startsWith(r, "погреб") || r == "cellar") role = SensorRole::Cellar;
      else if (startsWith(r, "пушк") || startsWith(r, "выход") || r == "gun") role = SensorRole::Gun;
      else if (startsWith(r, "кузов") || startsWith(r, "машин") || r == "car") role = SensorRole::Car;
      const int idx = std::atoi(w[2].c_str());
      if (role != SensorRole::None && idx >= 1) {
        c.type = CmdType::AssignSensor;
        c.role = role;
        c.index = idx;
      }
    }
  }
  return c;
}
