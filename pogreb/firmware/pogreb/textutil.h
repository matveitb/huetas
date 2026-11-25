#pragma once
// Работа с текстом SMS: UTF-8 ↔ UCS2, нормализация команд, номера телефонов.
#include <stdint.h>
#include <string>
#include <vector>

std::vector<uint16_t> utf8ToUtf16(const std::string& s);
std::string utf16ToUtf8(const std::vector<uint16_t>& u);

// "041F0440" → "Пр". false, если строка не похожа на UCS2 в hex.
bool ucs2HexToUtf8(const std::string& hex, std::string& out);

// Нижний регистр (латиница и кириллица), ё→е, один пробел между словами.
std::string normalizeText(const std::string& utf8);

// Только цифры; 8XXXXXXXXXX → 7XXXXXXXXXX.
std::string phoneDigits(const std::string& s);

// Сравнение номеров по последним 10 цифрам.
bool samePhone(const std::string& a, const std::string& b);
