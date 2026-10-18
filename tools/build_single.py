#!/usr/bin/env python3
"""
Собрать приложение в один файл dist/ecu-hex-trainer.html: скрипты из
trainer/ вставляются в страницу, и её можно открыть двойным щелчком
без остальных файлов.

    python3 tools/build_single.py
"""

import os
import re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
SRC = os.path.join(ROOT, "trainer")
OUT = os.path.join(ROOT, "dist", "ecu-hex-trainer.html")


def inline(match):
    name = match.group(1)
    code = open(os.path.join(SRC, name), encoding="utf-8").read()
    if "</script" in code.lower():
        raise SystemExit("%s содержит </script> -- вставить нельзя" % name)
    return "<script>\n// ---- %s\n%s</script>" % (name, code)


def main():
    html = open(os.path.join(SRC, "index.html"), encoding="utf-8").read()
    html, n = re.subn(r'<script src="([\w.]+)"></script>', inline, html)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("скриптов: %d -> %s (%d КБ)" % (n, os.path.relpath(OUT, ROOT), len(html.encode("utf-8")) // 1024))


if __name__ == "__main__":
    main()
