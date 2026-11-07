#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成自签名 HTTPS 证书（cert.pem / key.pem）
仅在 pip 安装了 cryptography 时可用；否则会提示改用 OpenSSL 或 mkcert。
用法：python make_cert.py [你的域名或IP]
"""

import os
import sys
import subprocess

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CERT = os.path.join(BASE_DIR, 'cert.pem')
KEY = os.path.join(BASE_DIR, 'key.pem')


def try_cryptography(host):
    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
    except ImportError:
        return False

    import datetime
    import ipaddress

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, host),
    ])
    alt = [x509.DNSName(host)]
    # 顺手把所有本机 IPv4 也加进 SAN，省得换 IP 就报错
    try:
        import socket
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            try:
                alt.append(x509.IPAddress(ipaddress.ip_address(ip)))
            except Exception:
                pass
    except Exception:
        pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1))
            .not_valid_after(now + datetime.timedelta(days=825))
            .add_extension(x509.SubjectAlternativeName(alt), critical=False)
            .sign(key, hashes.SHA256()))

    with open(KEY, 'wb') as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption()))
    with open(CERT, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return True


def try_openssl(host):
    exe = None
    for cand in ('openssl', r'C:\Program Files\Git\usr\bin\openssl.exe'):
        try:
            subprocess.run([cand, 'version'], capture_output=True, check=True)
            exe = cand
            break
        except Exception:
            continue
    if not exe:
        return False
    cmd = [exe, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
           '-keyout', KEY, '-out', CERT, '-days', '825',
           '-subj', f'/CN={host}']
    return subprocess.run(cmd, capture_output=True).returncode == 0


def main():
    host = sys.argv[1] if len(sys.argv) > 1 else 'localhost'
    print(f'正在为 "{host}" 生成自签名证书…')

    ok = try_cryptography(host) or try_openssl(host)
    if not ok:
        print('\n[失败] 没有可用的生成方式。')
        print('可任选其一：')
        print('  1) pip install cryptography  然后重新运行本脚本')
        print('  2) 安装 mkcert（推荐，浏览器不报错）：')
        print('     mkcert -install && mkcert ' + host)
        print('     然后把生成的 *-key.pem 改名为 key.pem、*.pem 改名为 cert.pem')
        print('  3) 用 OpenSSL 手动生成')
        return 1

    print(f'\n[成功] 已生成：\n  {CERT}\n  {KEY}')
    print('\n然后把 config.json 里 "https" 改成 true，重启服务即可。')
    print('注意：自签名证书浏览器会提示"不安全"，点继续访问即可；')
    print('      给公网用户用建议改用 mkcert 或正式证书（如 Cloudflare / Let\'s Encrypt）。')
    return 0


if __name__ == '__main__':
    sys.exit(main())