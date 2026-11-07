#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 public/ 打包成 GitHub Pages 能托管的静态演示页（输出到 docs/demo/）。

做的事情很简单：
  1. 复制 public/app.js、public/style.css
  2. 复制 site/demo-assets/mock-api.js（浏览器里假扮后端）
  3. 改写 index.html：绝对路径 /style.css -> ./style.css，
     并在 app.js 之前插入 mock-api.js 和一条演示提示条

改完之后 public/ 里的真实后端一行没动，线上那份只是"套了个躯壳"。

用法：python site/build_demo.py
"""

import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')
ASSETS = os.path.join(ROOT, 'site', 'demo-assets')
OUT = os.path.join(ROOT, 'docs', 'demo')

DEMO_BANNER_CSS = """
<style>
  /* ---- 演示环境专属样式（线上正式版没有这一块） ---- */
  .demo-bar {
    position: sticky; top: 0; z-index: 90;
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; flex-wrap: wrap;
    padding: 9px 20px;
    background: linear-gradient(90deg, rgba(61,126,255,.16), rgba(61,126,255,.04));
    border-bottom: 1px solid #2a3448;
    backdrop-filter: blur(8px);
    font-size: 12.5px; color: #b9c6da;
  }
  .demo-bar b { color: #7fb0ff; font-weight: 600; }
  .demo-bar a {
    color: #7fb0ff; text-decoration: none; white-space: nowrap;
    border: 1px solid #2a3448; border-radius: 7px; padding: 4px 10px;
    transition: .16s;
  }
  .demo-bar a:hover { border-color: #3d7eff; background: rgba(61,126,255,.12); }
  .demo-dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: #2ecc71; margin-right: 6px;
    box-shadow: 0 0 0 3px rgba(46,204,113,.16);
  }
  @media (max-width: 620px) {
    .demo-bar { font-size: 11.5px; padding: 8px 14px; }
  }
</style>
"""

DEMO_BANNER = """<div class="demo-bar">
  <span><span class="demo-dot"></span><b>在线演示</b> · 所有操作真实有效，数据保存在你的浏览器里，不会上传到任何服务器</span>
  <a href="../">← 返回官网</a>
</div>
"""


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def write(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def main():
    if not os.path.isdir(PUBLIC):
        raise SystemExit('找不到 public/ 目录：%s' % PUBLIC)

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)

    # 1) 静态资源
    shutil.copy2(os.path.join(PUBLIC, 'style.css'), os.path.join(OUT, 'style.css'))
    shutil.copy2(os.path.join(PUBLIC, 'app.js'), os.path.join(OUT, 'app.js'))
    # 二维码库：演示页也保留「手机扫码」按钮，不能少这个文件
    shutil.copy2(os.path.join(PUBLIC, 'qrcode.js'), os.path.join(OUT, 'qrcode.js'))
    shutil.copy2(os.path.join(ASSETS, 'mock-api.js'), os.path.join(OUT, 'mock-api.js'))

    # 2) 改写 index.html
    html = read(os.path.join(PUBLIC, 'index.html'))

    # 绝对路径 -> 相对路径（Pages 子目录部署必需）
    html = html.replace('href="/style.css"', 'href="./style.css"')
    html = html.replace('href="/login.css"', 'href="./login.css"')
    html = html.replace('src="/login.js"', 'src="./login.js"')
    html = html.replace('src="/qrcode.js"', 'src="./qrcode.js"')

    # 标题标注演示
    html = html.replace(
        '<title>局域网文件共享</title>',
        '<title>LanShare 在线演示 · 局域网文件共享</title>'
    )

    # 注入演示样式
    html = html.replace('</head>', DEMO_BANNER_CSS + '</head>')

    # 注入提示条（紧跟 <body>）
    html = re.sub(r'(<body[^>]*>)', r'\1\n' + DEMO_BANNER, html, count=1)

    # 先加载 mock-api.js，再加载 app.js
    html = html.replace(
        '<script src="/app.js"></script>',
        '<script src="./mock-api.js"></script>\n<script src="./app.js"></script>'
    )

    write(os.path.join(OUT, 'index.html'), html)

    # 3) .nojekyll：避免 GitHub Pages 走 Jekyll 处理下划线开头的文件
    nojekyll = os.path.join(ROOT, 'docs', '.nojekyll')
    if not os.path.exists(nojekyll):
        write(nojekyll, '')

    print('演示页已生成 -> docs/demo/')
    for name in sorted(os.listdir(OUT)):
        size = os.path.getsize(os.path.join(OUT, name))
        print('  %-16s %8.1f KB' % (name, size / 1024))


if __name__ == '__main__':
    main()
