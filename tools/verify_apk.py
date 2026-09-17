"""校验 Release 里的 APK：版本号、签名、关键前端资源是否都在包里。

用法：python tools/verify_apk.py <apk 路径>
"""
from __future__ import annotations

import re
import sys
import zipfile
from pathlib import Path


def main() -> int:
    apk = Path(sys.argv[1] if len(sys.argv) > 1 else "")
    if not apk.exists():
        print(f"找不到 APK：{apk}")
        return 1

    z = zipfile.ZipFile(apk)
    names = z.namelist()
    raw = apk.read_bytes()

    print(f"文件：{apk.name}　{len(raw) / 1024 / 1024:.2f} MB　条目 {len(names)} 个")

    # 版本号：二进制 AndroidManifest 的字符串池里能看到 versionName
    manifest = z.read("AndroidManifest.xml") if "AndroidManifest.xml" in names else b""
    versions = {
        m.group().decode()
        for m in re.finditer(rb"[\x20-\x7e]{3,}", manifest)
        if re.fullmatch(rb"\d+\.\d+(\.\d+)?", m.group())
    }
    print(f"  清单里的版本号：{sorted(versions) or '（未找到）'}")

    cfg = ""
    if "assets/public/js/config.js" in names:
        cfg = z.read("assets/public/js/config.js").decode("utf-8")
    app_ver = re.search(r"APP_VERSION = '([^']*)'", cfg)
    app_name = re.search(r"APP_NAME = '([^']*)'", cfg)
    print(f"  config.js：APP_NAME={app_name.group(1) if app_name else '?'}　APP_VERSION={app_ver.group(1) if app_ver else '?'}")

    need = [
        "assets/public/index.html",
        "assets/public/js/app.js",
        "assets/public/js/extract.js",
        "assets/public/js/parser-text.js",
        "assets/public/js/exporter.js",
        "assets/public/js/generator.js",
        "assets/public/vendor/pdf.min.mjs",
        "assets/public/vendor/pdf.worker.min.mjs",
        "assets/public/vendor/pdf.legacy.min.mjs",
        "assets/public/vendor/pdf.worker.legacy.min.mjs",
        "assets/public/vendor/cmaps/UniGB-UCS2-H.bcmap",
        "assets/public/samples/sample-bank.pdf",
        "assets/public/samples/sample-bank.docx",
        "classes.dex",
        "resources.arsc",
    ]
    missing = [n for n in need if n not in names]
    print(f"  关键资源：{len(need) - len(missing)}/{len(need)} 就位" + (f"　缺失：{missing}" if missing else ""))

    print(f"  v2/v3 签名块：{b'APK Sig Block 42' in raw}")
    print(f"  本仓库证书已嵌入：{b'Quiz Assistant' in raw}")
    print(f"  包名：{'com.ham293.quizmobile' in cfg or b'com.ham293.quizmobile' in raw}")
    return 0 if not missing else 2


if __name__ == "__main__":
    sys.exit(main())
