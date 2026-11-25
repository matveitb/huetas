#include "textutil.h"

std::vector<uint16_t> utf8ToUtf16(const std::string& s) {
  std::vector<uint16_t> out;
  out.reserve(s.size());
  size_t i = 0;
  while (i < s.size()) {
    const unsigned char c = (unsigned char)s[i];
    if (c < 0x80) {
      out.push_back(c);
      i += 1;
    } else if ((c & 0xE0) == 0xC0 && i + 1 < s.size()) {
      out.push_back((uint16_t)(((c & 0x1F) << 6) | ((unsigned char)s[i + 1] & 0x3F)));
      i += 2;
    } else if ((c & 0xF0) == 0xE0 && i + 2 < s.size()) {
      out.push_back((uint16_t)(((c & 0x0F) << 12) | (((unsigned char)s[i + 1] & 0x3F) << 6) |
                               ((unsigned char)s[i + 2] & 0x3F)));
      i += 3;
    } else if ((c & 0xF8) == 0xF0) {
      out.push_back('?');  // символы вне BMP (эмодзи) в SMS не нужны
      i += 4;
    } else {
      out.push_back('?');
      i += 1;
    }
  }
  return out;
}

std::string utf16ToUtf8(const std::vector<uint16_t>& u) {
  std::string o;
  o.reserve(u.size() * 2);
  for (uint16_t c : u) {
    if (c < 0x80) {
      o += (char)c;
    } else if (c < 0x800) {
      o += (char)(0xC0 | (c >> 6));
      o += (char)(0x80 | (c & 0x3F));
    } else if (c >= 0xD800 && c <= 0xDFFF) {
      o += '?';
    } else {
      o += (char)(0xE0 | (c >> 12));
      o += (char)(0x80 | ((c >> 6) & 0x3F));
      o += (char)(0x80 | (c & 0x3F));
    }
  }
  return o;
}

static int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

bool ucs2HexToUtf8(const std::string& hex, std::string& out) {
  if (hex.empty() || hex.size() % 4 != 0) return false;
  std::vector<uint16_t> u;
  u.reserve(hex.size() / 4);
  for (size_t i = 0; i < hex.size(); i += 4) {
    int v = 0;
    for (int k = 0; k < 4; ++k) {
      const int h = hexValue(hex[i + k]);
      if (h < 0) return false;
      v = (v << 4) | h;
    }
    u.push_back((uint16_t)v);
  }
  out = utf16ToUtf8(u);
  return true;
}

std::string normalizeText(const std::string& s) {
  const std::vector<uint16_t> u = utf8ToUtf16(s);
  std::vector<uint16_t> o;
  o.reserve(u.size());
  bool space = true;  // срезаем ведущие пробелы
  for (uint16_t c : u) {
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n' || c == 0xA0) {
      if (!space) {
        o.push_back(' ');
        space = true;
      }
      continue;
    }
    if (c >= 'A' && c <= 'Z') c = (uint16_t)(c + 32);
    else if (c >= 0x0410 && c <= 0x042F) c = (uint16_t)(c + 0x20);  // А–Я → а–я
    else if (c == 0x0401 || c == 0x0451) c = 0x0435;                 // Ё, ё → е
    o.push_back(c);
    space = false;
  }
  if (!o.empty() && o.back() == ' ') o.pop_back();
  return utf16ToUtf8(o);
}

std::string phoneDigits(const std::string& s) {
  std::string d;
  for (char c : s)
    if (c >= '0' && c <= '9') d += c;
  if (d.size() == 11 && d[0] == '8') d[0] = '7';
  if (d.size() == 10 && d[0] == '9') d = "7" + d;
  return d;
}

bool samePhone(const std::string& a, const std::string& b) {
  const std::string da = phoneDigits(a), db = phoneDigits(b);
  if (da.size() < 10 || db.size() < 10) return false;
  return da.compare(da.size() - 10, 10, db, db.size() - 10, 10) == 0;
}
