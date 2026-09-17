"""生成或校验 APK 签名用的 PKCS12 密钥库（仓库自带，保证每次 CI 构建签名一致）。

用法：
    python tools/make_keystore.py            # 不存在则生成
    python tools/make_keystore.py --verify   # 只校验已有文件

说明：这是自签名密钥库，仅用于个人侧载安装，不要用于上架应用市场。
"""
from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import NameOID

ROOT = Path(__file__).resolve().parent.parent
KEYSTORE = ROOT / "keystore" / "quiz-release.p12"
ALIAS = "quizmobile"
PASSWORD = "quizmobile2026"  # noqa: S105 - 侧载自签名密钥库，公开在仓库里


def generate() -> None:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name(
        [
            x509.NameAttribute(NameOID.COMMON_NAME, "Quiz Assistant Self-Signed"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Quiz Assistant"),
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CN"),
        ]
    )
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(days=1))
        .not_valid_after(now + dt.timedelta(days=365 * 50))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    data = pkcs12.serialize_key_and_certificates(
        ALIAS.encode("utf-8"),
        key,
        cert,
        None,
        serialization.BestAvailableEncryption(PASSWORD.encode("utf-8")),
    )
    KEYSTORE.parent.mkdir(parents=True, exist_ok=True)
    KEYSTORE.write_bytes(data)
    print(f"已生成密钥库：{KEYSTORE}（alias={ALIAS}, 类型=PKCS12）")


def verify() -> int:
    if not KEYSTORE.exists():
        print(f"密钥库不存在：{KEYSTORE}")
        return 1
    key, cert, extra = pkcs12.load_key_and_certificates(
        KEYSTORE.read_bytes(), PASSWORD.encode("utf-8")
    )
    print(f"密钥库校验通过：{KEYSTORE}")
    print(f"  alias     = {ALIAS}")
    print(f"  算法      = {key.__class__.__name__} {getattr(key, 'key_size', '')}")
    print(f"  证书主题  = {cert.subject.rfc4514_string()}")
    print(f"  有效期至  = {cert.not_valid_after_utc.isoformat()}")
    print(f"  文件大小  = {KEYSTORE.stat().st_size} 字节")
    return 0


if __name__ == "__main__":
    if "--verify" in sys.argv:
        sys.exit(verify())
    if KEYSTORE.exists():
        print("密钥库已存在，跳过生成。")
        sys.exit(verify())
    generate()
    sys.exit(verify())
