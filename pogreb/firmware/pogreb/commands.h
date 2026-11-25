#pragma once
// Разбор SMS-команд. На вход — текст после normalizeText().
#include <string>

enum class CmdType {
  Unknown, Status, Help, Stop, Start, HeatMode, VentMode, Target,
  Sensors, AssignSensor, Report, Test, Reboot
};
enum class SensorRole { None, Cellar, Gun, Car };

struct SmsCommand {
  CmdType    type = CmdType::Unknown;
  int        mode = 0;  // -1 выкл, 0 авто, 1 вкл
  float      value = 0;
  int        index = 0;
  SensorRole role = SensorRole::None;
};

SmsCommand parseCommand(const std::string& normalized);
