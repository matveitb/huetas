#pragma once
// Сборка SMS в PDU-режиме (UCS2): кириллица и длинные сообщения,
// которые на телефоне склеиваются в одно.
#include <stdint.h>
#include <string>
#include <vector>

struct PduPart {
  std::string hex;  // PDU целиком, включая байт SMSC "00"
  int tpduLen;      // длина для AT+CMGS (без байта SMSC)
};

// До 70 символов — одна SMS, длиннее — части по 67 символов (не больше maxParts).
std::vector<PduPart> buildSmsPdus(const std::string& phone, const std::vector<uint16_t>& text,
                                  uint8_t ref, int maxParts = 6);
