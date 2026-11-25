#include "pdu.h"

static void hexByte(std::string& o, uint8_t b) {
  static const char* H = "0123456789ABCDEF";
  o += H[b >> 4];
  o += H[b & 0x0F];
}

// Адрес получателя: длина в цифрах, тип номера, цифры попарно наоборот.
static std::string encodeAddress(const std::string& phone) {
  std::string d;
  bool intl = false;
  for (char c : phone) {
    if (c == '+') intl = true;
    else if (c >= '0' && c <= '9') d += c;
  }
  if (!intl && d.size() == 11 && (d[0] == '8' || d[0] == '7')) {
    d[0] = '7';
    intl = true;
  }
  std::string o;
  hexByte(o, (uint8_t)d.size());
  hexByte(o, intl ? 0x91 : 0x81);
  for (size_t i = 0; i < d.size(); i += 2) {
    const char a = d[i];
    const char b = (i + 1 < d.size()) ? d[i + 1] : 'F';
    o += b;
    o += a;
  }
  return o;
}

std::vector<PduPart> buildSmsPdus(const std::string& phone, const std::vector<uint16_t>& text,
                                  uint8_t ref, int maxParts) {
  std::vector<PduPart> parts;
  const size_t n = text.size();
  const bool multi = n > 70;
  const size_t per = multi ? 67 : 70;
  size_t total = multi ? (n + per - 1) / per : 1;
  if (maxParts < 1) maxParts = 1;
  if (total > (size_t)maxParts) total = (size_t)maxParts;
  const std::string da = encodeAddress(phone);

  for (size_t p = 0; p < total; ++p) {
    const size_t start = p * per;
    const size_t len = (n > start) ? ((n - start < per) ? n - start : per) : 0;
    std::string h = "00";              // SMSC из настроек SIM-карты
    hexByte(h, multi ? 0x41 : 0x01);   // SMS-SUBMIT (+ признак заголовка для частей)
    hexByte(h, 0x00);                  // TP-MR
    h += da;
    hexByte(h, 0x00);                  // TP-PID
    hexByte(h, 0x08);                  // TP-DCS: UCS2
    hexByte(h, (uint8_t)(len * 2 + (multi ? 6 : 0)));  // TP-UDL в октетах
    if (multi) {
      h += "050003";
      hexByte(h, ref);
      hexByte(h, (uint8_t)total);
      hexByte(h, (uint8_t)(p + 1));
    }
    for (size_t i = 0; i < len; ++i) {
      const uint16_t c = text[start + i];
      hexByte(h, (uint8_t)(c >> 8));
      hexByte(h, (uint8_t)(c & 0xFF));
    }
    parts.push_back({h, (int)(h.size() / 2 - 1)});
  }
  return parts;
}
