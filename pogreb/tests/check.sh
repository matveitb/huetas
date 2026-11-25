#!/bin/sh
# Тесты логики и проверка компиляции с заглушками Arduino (обе платы, ядро ESP32 2.x и 3.x).
set -e
cd "$(dirname "$0")/.."
TMP=$(mktemp -d)
g++ -std=c++17 -Wall -Wextra -o "$TMP/test_logic" tests/test_logic.cpp firmware/pogreb/logic.cpp \
    firmware/pogreb/textutil.cpp firmware/pogreb/pdu.cpp firmware/pogreb/commands.cpp
"$TMP/test_logic"
for core in 2 3; do
  for board in 0 1; do
    rm -rf "$TMP/v" && mkdir "$TMP/v" && cp firmware/pogreb/* "$TMP/v/"
    sed -i "s/#define BOARD_TCALL 0/#define BOARD_TCALL $board/" "$TMP/v/config.h"
    for f in "$TMP"/v/*.cpp; do
      g++ -std=gnu++17 -fsyntax-only -Wall -Wextra -Werror -Itests/stubs -DESP_ARDUINO_VERSION_MAJOR=$core "$f"
    done
    g++ -std=gnu++17 -fsyntax-only -Wall -Wextra -Werror -Itests/stubs -DESP_ARDUINO_VERSION_MAJOR=$core -x c++ "$TMP/v/pogreb.ino"
    echo "Компиляция с заглушками: ядро $core.x, BOARD_TCALL=$board — ок"
  done
done
rm -rf "$TMP"
