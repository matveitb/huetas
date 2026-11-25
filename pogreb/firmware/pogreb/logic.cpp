#include "logic.h"

float dewPoint(float tC, float rhPct) {
  if (!valid(tC) || !valid(rhPct) || rhPct <= 0.0f) return NAN;
  if (rhPct > 100.0f) rhPct = 100.0f;
  const float a = 17.62f, b = 243.12f;
  const float g = std::log(rhPct / 100.0f) + a * tC / (b + tC);
  return b * g / (a - g);
}

uint8_t sensirionCrc8(const uint8_t* data, int len) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < len; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit) {
      crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
    }
  }
  return crc;
}

// ---------------- HeatController ----------------

void HeatController::beginPurge(uint32_t now, uint32_t pauseS) {
  st_ = HeatState::Purging;
  purgeSince_ = now;
  offSince_ = now;
  nextOn_ = now + pauseS;
}

HeatOutputs HeatController::step(const HeatInputs& in) {
  const uint32_t now = in.nowS;

  // Пожар: всё выключить, без продувки (не раздувать огонь), ждать команды «пуск».
  if (in.fire || st_ == HeatState::FireLock) {
    st_ = HeatState::FireLock;
    return {false, false};
  }

  // Нет 220 В: пушка и кулер всё равно не работают.
  if (!in.mainsOk) {
    if (st_ != HeatState::Idle) {
      st_ = HeatState::Idle;
      offSince_ = now;
      if (nextOn_ < now + p_.minOffS) nextOn_ = now + p_.minOffS;
    }
    return {false, false};
  }

  switch (st_) {
    case HeatState::Idle: {
      bool want = false;
      if (!in.stopped) {
        if (in.mode == OpMode::On) want = true;
        else if (in.mode == OpMode::Auto && in.cellarOk && in.cellarC < p_.onBelowC) want = true;
      }
      const bool outletHot = in.outletOk && in.outletC > p_.outletMaxC;
      if (want && !outletHot && now >= nextOn_) {
        st_ = HeatState::Heating;
        onSince_ = now;
        return {true, false};
      }
      return {false, false};
    }

    case HeatState::Heating: {
      const uint32_t ran = now - onSince_;
      if (in.outletOk && in.outletC > p_.outletMaxC) {
        ev_ |= EV_OVERHEAT;
        beginPurge(now, p_.overheatPauseS);
        return {false, true};
      }
      if (ran >= p_.maxRunS) {
        ev_ |= EV_MAXRUN;
        beginPurge(now, p_.maxRunPauseS);
        return {false, true};
      }
      bool stop = in.stopped || in.mode == OpMode::Off;
      if (!stop && in.mode == OpMode::Auto) {
        if (!in.cellarOk) {
          stop = true;
          ev_ |= EV_NO_SENSOR;
        } else if (in.cellarC > p_.offAboveC && ran >= p_.minOnS) {
          stop = true;
        }
      }
      if (stop) {
        beginPurge(now, p_.minOffS);
        return {false, true};
      }
      return {true, false};
    }

    case HeatState::Purging: {
      const uint32_t el = now - purgeSince_;
      bool done;
      if (in.outletOk) done = (el >= p_.purgeMinS && in.outletC < p_.purgeDoneC) || el >= p_.purgeMaxS;
      else done = el >= p_.purgeNoSensorS;
      if (done) {
        st_ = HeatState::Idle;
        return {false, false};
      }
      return {false, true};
    }

    case HeatState::FireLock:
    default:
      return {false, false};
  }
}

// ---------------- VentController ----------------

bool VentController::step(const VentInputs& in) {
  const uint32_t now = in.nowS;
  if (!started_) {
    started_ = true;
    hourStart_ = now;
    lastStep_ = now;
    lastSwitch_ = now;  // после включения первые 5 минут не переключаемся
  }
  if (on_) onThisHour_ += now - lastStep_;
  lastStep_ = now;
  if (now - hourStart_ >= 3600) {
    hourStart_ = now;
    onThisHour_ = 0;
  }

  bool want = on_;
  bool immediate = false;
  if (!in.mainsOk || in.stopped || in.mode == OpMode::Off) {
    want = false;
    immediate = true;
  } else if (in.mode == OpMode::On) {
    want = true;
    immediate = true;
  } else if (!in.sensorsOk) {
    want = false;
    immediate = true;
  } else {
    if (in.tdOut <= in.tdIn - p_.onDtd && in.rhIn > p_.rhOn) want = true;
    else if (in.tdOut >= in.tdIn - p_.offDtd || in.rhIn < p_.rhOff) want = false;
    if (want && in.tOut < p_.frostC && onThisHour_ >= p_.frostMaxOnPerHourS) {
      want = false;
      immediate = true;
    }
  }

  if (want != on_ && (immediate || now - lastSwitch_ >= p_.minSwitchS)) {
    on_ = want;
    lastSwitch_ = now;
  }
  return on_;
}

// ---------------- AlarmTracker ----------------

AlarmEvent AlarmTracker::update(bool cond, bool clearCond, uint32_t nowS, uint32_t holdS, uint32_t repeatS) {
  if (!active) {
    if (!cond) {
      waiting = false;
      return AlarmEvent::None;
    }
    if (!waiting) {
      waiting = true;
      since = nowS;
    }
    if (nowS - since >= holdS) {
      active = true;
      waiting = false;
      lastSent = nowS;
      return AlarmEvent::Raise;
    }
    return AlarmEvent::None;
  }
  if (clearCond) {
    active = false;
    waiting = false;
    return AlarmEvent::Clear;
  }
  if (repeatS && nowS - lastSent >= repeatS) {
    lastSent = nowS;
    return AlarmEvent::Repeat;
  }
  return AlarmEvent::None;
}
