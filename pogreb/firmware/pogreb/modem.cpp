#include "modem.h"

#include <stdio.h>
#include <string>
#include <vector>

#include "pdu.h"
#include "textutil.h"

void Modem::begin(HardwareSerial& serial, int rxPin, int txPin, int rstPin, int pwkeyPin, int powerPin) {
  s_ = &serial;
  rst_ = rstPin;
  pwkey_ = pwkeyPin;
  power_ = powerPin;
  if (power_ >= 0) {  // плата с ключом питания модема (LilyGO T-Call)
    pinMode(power_, OUTPUT);
    digitalWrite(power_, HIGH);
    if (pwkey_ >= 0) {
      pinMode(pwkey_, OUTPUT);
      digitalWrite(pwkey_, LOW);
    }
    if (rst_ >= 0) {
      pinMode(rst_, OUTPUT);
      digitalWrite(rst_, HIGH);
    }
  } else if (rst_ >= 0) {
    pinMode(rst_, INPUT);  // отдельный SIM800L: RST отпущен, у модуля своя подтяжка
  }
  serial.setRxBufferSize(1024);
  serial.begin(9600, SERIAL_8N1, rxPin, txPin);
}

void Modem::idle() {
  if (idleHook_) idleHook_();
}

bool Modem::readLine(String& line, uint32_t timeoutMs) {
  const uint32_t start = millis();
  for (;;) {
    while (s_->available()) {
      const char c = (char)s_->read();
      if (c == '\n') {
        line = rx_;
        rx_ = "";
        line.trim();
        return true;
      }
      if (c != '\r' && rx_.length() < 700) rx_ += c;
    }
    if (millis() - start >= timeoutMs) return false;
    delay(2);
    idle();
  }
}

void Modem::poll() {
  String line;
  while (readLine(line, 0)) {
    if (line.length()) handleUrc(line);
  }
}

void Modem::handleUrc(const String& line) {
  if (line.startsWith("+CMTI:")) {
    const int comma = line.lastIndexOf(',');
    if (comma > 0) pushPending((int)line.substring(comma + 1).toInt());
  }
}

void Modem::pushPending(int index) {
  if (index <= 0) return;
  for (int i = 0; i < pendingCount_; ++i)
    if (pending_[i] == index) return;
  if (pendingCount_ < kMaxPending) pending_[pendingCount_++] = index;
}

int Modem::nextPendingSms() {
  if (pendingCount_ == 0) return -1;
  const int index = pending_[0];
  for (int i = 1; i < pendingCount_; ++i) pending_[i - 1] = pending_[i];
  pendingCount_--;
  return index;
}

bool Modem::command(const String& cmd, const char* expect, uint32_t timeoutMs, String* response) {
  if (!s_) return false;
  poll();
  if (response) *response = "";
  s_->print(cmd);
  s_->print("\r");
  const uint32_t start = millis();
  String line;
  for (;;) {
    const uint32_t elapsed = millis() - start;
    if (elapsed >= timeoutMs) return false;
    if (!readLine(line, timeoutMs - elapsed)) return false;
    if (line.length() == 0 || line == cmd) continue;  // пустые строки и эхо
    handleUrc(line);
    if (line.startsWith(expect)) return true;
    if (line == "ERROR" || line.startsWith("+CME ERROR") || line.startsWith("+CMS ERROR")) {
      if (response) *response += line;
      return false;
    }
    if (response) {
      *response += line;
      *response += "\n";
    }
  }
}

bool Modem::init() {
  ready_ = false;
  if (!s_) return false;
  bool alive = false;
  for (int i = 0; i < 15 && !alive; ++i) {
    alive = command("AT", "OK", 700);
    if (!alive) {
      delay(300);
      idle();
    }
  }
  if (!alive) return false;
  command("ATE0");                // без эха
  command("AT+CMEE=2");           // ошибки текстом
  command("AT+CMGF=1");           // текстовый режим для чтения SMS
  command("AT+CSCS=\"GSM\"");
  command("AT+CNMI=2,1,0,0,0");   // о новой SMS сообщать строкой +CMTI
  command("AT+CLTS=1");           // брать время из сети
  command("AT&W");
  ready_ = true;
  return true;
}

bool Modem::ping() { return command("AT", "OK", 1000); }

bool Modem::waitPrompt(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (millis() - start < timeoutMs) {
    while (s_->available()) {
      const char c = (char)s_->read();
      if (c == '>') return true;
      if (c == '\n') {
        String l = rx_;
        rx_ = "";
        l.trim();
        if (l.length()) {
          handleUrc(l);
          if (l.startsWith("ERROR") || l.startsWith("+CMS ERROR")) return false;
        }
      } else if (c != '\r' && rx_.length() < 700) {
        rx_ += c;
      }
    }
    delay(5);
    idle();
  }
  return false;
}

bool Modem::waitSendResult(uint32_t timeoutMs) {
  const uint32_t start = millis();
  bool got = false;
  String line;
  while (millis() - start < timeoutMs) {
    if (!readLine(line, 500)) continue;
    if (line.length() == 0) continue;
    handleUrc(line);
    if (line.startsWith("+CMGS:")) got = true;
    else if (line == "OK") {
      if (got) return true;
    } else if (line.startsWith("ERROR") || line.startsWith("+CMS ERROR")) {
      return false;
    }
  }
  return got;
}

bool Modem::sendSms(const String& phone, const String& text) {
  if (!ready_) return false;
  const std::vector<uint16_t> u = utf8ToUtf16(std::string(text.c_str()));
  const std::vector<PduPart> parts = buildSmsPdus(std::string(phone.c_str()), u, ++smsRef_);
  if (!command("AT+CMGF=0")) {
    command("AT+CMGF=1");
    return false;
  }
  bool ok = true;
  for (size_t i = 0; i < parts.size() && ok; ++i) {
    poll();
    s_->print("AT+CMGS=");
    s_->print(parts[i].tpduLen);
    s_->print("\r");
    if (!waitPrompt(5000)) {
      s_->write((uint8_t)27);  // ESC — отменить ввод
      ok = false;
      break;
    }
    s_->print(parts[i].hex.c_str());
    s_->write((uint8_t)26);    // Ctrl+Z — отправить
    ok = waitSendResult(40000);
    if (ok) delay(500);
  }
  command("AT+CMGF=1");
  return ok;
}

bool Modem::readSms(int index, String& from, String& text) {
  command("AT+CMGF=1");
  if (!command("AT+CSCS=\"UCS2\"")) return false;
  String resp;
  const bool ok = command(String("AT+CMGR=") + index, "OK", 5000, &resp);
  // В режиме UCS2 часть прошивок модема ждёт и этот параметр в UCS2 — пробуем оба варианта.
  if (!command("AT+CSCS=\"GSM\"")) command("AT+CSCS=\"00470053004D\"");
  if (!ok) return false;

  const int h = resp.indexOf("+CMGR:");
  if (h < 0) return false;
  const int eol = resp.indexOf('\n', h);
  const String header = (eol < 0) ? resp.substring(h) : resp.substring(h, eol);
  String body = (eol < 0) ? String("") : resp.substring(eol + 1);
  body.replace("\n", "");
  body.trim();

  // +CMGR: "REC UNREAD","<номер>","","<дата>" — номер во вторых кавычках
  int q = header.indexOf('"');
  q = header.indexOf('"', q + 1);
  const int q2 = header.indexOf('"', q + 1);
  const int q3 = header.indexOf('"', q2 + 1);
  if (q < 0 || q2 < 0 || q3 < 0) return false;
  const String numberRaw = header.substring(q2 + 1, q3);

  std::string tmp;
  from = ucs2HexToUtf8(std::string(numberRaw.c_str()), tmp) ? String(tmp.c_str()) : numberRaw;
  text = ucs2HexToUtf8(std::string(body.c_str()), tmp) ? String(tmp.c_str()) : body;
  return true;
}

bool Modem::deleteSms(int index) { return command(String("AT+CMGD=") + index, "OK", 5000); }

void Modem::scanStoredSms() {
  command("AT+CMGF=1");
  command("AT+CSCS=\"GSM\"");
  for (int i = 1; i <= 30; ++i) {
    String r;
    if (command(String("AT+CMGR=") + i, "OK", 3000, &r) && r.indexOf("+CMGR:") >= 0) pushPending(i);
    idle();
  }
}

bool Modem::isRegistered() {
  String r;
  if (!command("AT+CREG?", "OK", 2000, &r)) return false;
  const int p = r.indexOf("+CREG:");
  if (p < 0) return false;
  const int comma = r.indexOf(',', p);
  if (comma < 0) return false;
  const long stat = r.substring(comma + 1).toInt();
  return stat == 1 || stat == 5;  // домашняя сеть или роуминг
}

int Modem::signalQuality() {
  String r;
  if (!command("AT+CSQ", "OK", 2000, &r)) return 99;
  const int p = r.indexOf("+CSQ:");
  if (p < 0) return 99;
  return (int)r.substring(p + 5).toInt();
}

NetTime Modem::networkTime() {
  NetTime t;
  String r;
  if (!command("AT+CCLK?", "OK", 2000, &r)) return t;
  const int p = r.indexOf("+CCLK:");
  if (p < 0) return t;
  const int q = r.indexOf('"', p);
  if (q < 0) return t;
  int yy = 0, mo = 0, d = 0, h = 0, mi = 0;
  if (sscanf(r.c_str() + q + 1, "%d/%d/%d,%d:%d", &yy, &mo, &d, &h, &mi) != 5) return t;
  if (yy < 24 || yy > 79 || mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23) return t;
  t.valid = true;
  t.year = 2000 + yy;
  t.month = mo;
  t.day = d;
  t.hour = h;
  t.minute = mi;
  return t;
}

void Modem::hardReset() {
  ready_ = false;
  if (power_ >= 0) {  // T-Call: передёрнуть питание модема
    digitalWrite(power_, LOW);
    delay(1000);
    digitalWrite(power_, HIGH);
  } else if (rst_ >= 0) {
    pinMode(rst_, OUTPUT);
    digitalWrite(rst_, LOW);
    delay(300);
    pinMode(rst_, INPUT);
  }
  for (int i = 0; i < 50; ++i) {  // около 5 секунд на загрузку модема
    delay(100);
    idle();
  }
  rx_ = "";
  if (init()) scanStoredSms();
}
