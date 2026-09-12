#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QQ 农场 · 物品图标批量提取工具
================================

用途
----
从 manifest.csv（游戏客户端资源清单）批量提取物品图标：
  ItemInfo.json 中每个物品带有 icon_res 字段（如 gui/texture/icon/icon_football/spriteFrame），
  本工具按此字段：
    1. 解析出 sprite 名（icon_football）
    2. 在 manifest.csv 中查找该 sprite 的图集（source/rect）
    3. 从官方 CDN 下载 .astc 图集（带缓存）
    4. 解码为 PNG 并按 rect 切出图标
    5. 保存为 core/src/gameConfig/seed_images_named/{id}_{sprite}.png

为什么需要它
------------
游戏内很多物品（足球、星砂、装扮、铭牌等）没有种子图，也不在 Plant.json 里。
游戏物品配置（ItemInfo.json）里的 icon_res 字段是唯一可靠的图标线索，
配合 manifest.csv 就能把官方图标完整提取出来。

后续新物品出现时
----------------
1. 抓包获取新版 manifest.json（游戏客户端启动时下载的资源清单）：
   用内置抓包服务跑一次（游戏启动即自动存档到 core/data/capture-assets/），
   或在面板 / 管理接口导出为 core/src/gameConfig/manifest-from-capture.json；
2. 直接跑：python scripts/extract_item_icons.py --manifest <manifest.json 路径>
   （--manifest 会把游戏格式清单与本地 manifest.csv 合并，两侧的新 sprite 都能提取）
3. 如需把新 sprite 持久化进 manifest.csv，见 extract_seed_icons.py 所用字段做格式转换。

依赖
----
  pip install texture2ddecoder pillow
  （texture2ddecoder 是纯 wheel 的 ASTC 解码库，无需外部程序）

用法
----
  python scripts/extract_item_icons.py            # 提取全部缺失图标
  python scripts/extract_item_icons.py --dry      # 只看会提取哪些，不下载
  python scripts/extract_item_icons.py --id 301102,1029   # 只提取指定物品
  python scripts/extract_item_icons.py --manifest core/src/gameConfig/manifest-from-capture.json
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CFG = os.path.join(ROOT, 'core', 'src', 'gameConfig')
IMG_DIR = os.path.join(CFG, 'seed_images_named')
MANIFEST_CSV = os.path.join(CFG, 'manifest.csv')
ITEMINFO = os.path.join(CFG, 'ItemInfo.json')
CDN = 'https://cdn-resource.nqf.qq.com/'
CACHE_DIR = os.path.join(ROOT, 'tmp', 'astc_cache')

_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE


def fetch_cdn(src: str) -> str:
    """下载 CDN 资源到本地缓存，返回缓存路径。"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    local = os.path.join(CACHE_DIR, src.replace('/', '_'))
    if os.path.exists(local) and os.path.getsize(local) > 0:
        return local
    url = CDN + urllib.parse.quote(src)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60, context=_ssl_ctx) as r:
        data = r.read()
    with open(local, 'wb') as f:
        f.write(data)
    return local


def decode_astc_to_png(astc_path: str, png_path: str) -> bool:
    """解码 ASTC 图集到 PNG。优先 texture2ddecoder，其次 astcenc 命令行。"""
    try:
        import texture2ddecoder
        from PIL import Image
        data = open(astc_path, 'rb').read()
        if data[:4] != b'\x13\xAB\xA1\\':
            raise ValueError('not astc')
        bx, by, bz = data[4], data[5], data[6]
        dx = data[7] | (data[8] << 8) | (data[9] << 16)
        dy = data[10] | (data[11] << 8) | (data[12] << 16)
        dz = data[13] | (data[14] << 8) | (data[15] << 16)
        if dz > 1:
            raise ValueError('3d astc unsupported')
        rgba = texture2ddecoder.decode_astc(data[16:], dx, dy, bx, by)
        # 解码输出是 BGRA 通道序（与 extract_seed_icons 的 pixel_transform 一致）
        Image.frombytes('RGBA', (dx, dy), rgba, 'raw', 'BGRA').save(png_path)
        return True
    except Exception:
        pass
    try:
        import subprocess
        subprocess.run(['astcenc', '-dl', astc_path, png_path], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True
    except Exception:
        return False


def parse_rect(rect_str: str):
    """解析 manifest 的 rect 字符串 -> (x, y, w, h) 或 None。"""
    m = re.search(r"'x':\s*(\d+).*?'y':\s*(\d+).*?'width':\s*(\d+).*?'height':\s*(\d+)", rect_str or '')
    if not m:
        return None
    return tuple(int(x) for x in m.groups())


def load_manifest() -> dict:
    """载入 manifest.csv -> {sprite_name: row}。"""
    rows = list(csv.DictReader(open(MANIFEST_CSV, encoding='utf-8')))
    result = {}
    for r in rows:
        sn = (r.get('sprite_name') or '').strip()
        if sn:
            result.setdefault(sn, r)
    return result


def load_manifest_json(path: str) -> dict:
    """载入抓包得到的游戏 manifest.json -> {sprite_name: row}。

    游戏清单结构：{"images": [{sprite_name, source, metadata_json, rect?}, ...]}
    也兼容直接数组。返回值与 load_manifest() 相同，字段名对齐 manifest.csv
    （source / rect / metadata_json），rect 统一转成 CSV 里的字面量形式。
    """
    data = json.load(open(path, encoding='utf-8'))
    imgs = data.get('images') if isinstance(data, dict) else data
    if not isinstance(imgs, list):
        raise ValueError(f'{path} 不是合法的游戏资源清单（缺 images 数组）')
    result = {}
    for it in imgs:
        if not isinstance(it, dict):
            continue
        sn = str(it.get('sprite_name') or it.get('name') or '').strip()
        if not sn or sn in result:
            continue
        rect = it.get('rect')
        if isinstance(rect, dict):
            rect_str = ("{'x': %d, 'y': %d, 'width': %d, 'height': %d}"
                        % (rect.get('x', 0), rect.get('y', 0),
                           rect.get('width', 0), rect.get('height', 0)))
        elif isinstance(rect, str):
            rect_str = rect
        else:
            rect_str = ''
        result[sn] = {
            'sprite_name': sn,
            'source': str(it.get('source') or ''),
            'metadata_json': str(it.get('metadata_json') or ''),
            'rect': rect_str,
        }
    return result


def main():
    ap = argparse.ArgumentParser(description='批量提取物品图标（icon_res -> manifest -> PNG）')
    ap.add_argument('--dry', action='store_true', help='只列清单，不下载')
    ap.add_argument('--id', type=str, default='', help='逗号分隔的物品 ID，只提取这些')
    ap.add_argument('--manifest', type=str, default='',
                    help='抓包得到的 manifest.json（游戏格式），与 manifest.csv 合并使用')
    args = ap.parse_args()

    sprites = load_manifest()
    if args.manifest:
        extra = load_manifest_json(args.manifest)
        added = 0
        for sn, row in extra.items():
            if sn not in sprites:
                sprites[sn] = row
                added += 1
        print(f'manifest.json 载入 {len(extra)} 个精灵（新增 {added} 个不在 manifest.csv 中）')
    items = json.load(open(ITEMINFO, encoding='utf-8'))

    have_ids = set()
    for f in os.listdir(IMG_DIR):
        m = re.match(r'^(\d+)[_.]', f)
        if m:
            have_ids.add(int(m.group(1)))

    only = set()
    if args.id:
        only = {int(x) for x in args.id.split(',') if x.strip().isdigit()}

    todo = []
    for it in items:
        iid = it.get('id')
        if not str(iid).isdigit():
            continue
        iid = int(iid)
        if only and iid not in only:
            continue
        if iid in have_ids:
            continue
        ir = it.get('icon_res') or ''
        m = re.search(r'/([^/]+)/spriteFrame$', ir)
        if not m:
            continue
        sprite = m.group(1)
        if sprite not in sprites:
            continue
        todo.append((iid, sprite, it.get('name')))

    print(f'待提取: {len(todo)} 个')
    for iid, sprite, name in todo:
        print(f'  {iid} {name} <- {sprite}')

    if args.dry or not todo:
        return 0

    from PIL import Image
    ok = fail = 0
    for iid, sprite, name in todo:
        row = sprites[sprite]
        src = row.get('source') or ''
        rect = parse_rect(row.get('rect') or '')
        if not src or not rect:
            print(f'  ✗ {iid} {sprite}: manifest 缺 source/rect')
            fail += 1
            continue
        x, y, w, h = rect
        try:
            astc = fetch_cdn(src)
            atlas = astc + '.png'
            if not os.path.exists(atlas):
                if not decode_astc_to_png(astc, atlas):
                    print(f'  ✗ {iid} {sprite}: ASTC 解码失败')
                    fail += 1
                    continue
            img = Image.open(atlas).convert('RGBA')
            out = os.path.join(IMG_DIR, f'{iid}_{sprite}.png')
            img.crop((x, y, x + w, y + h)).save(out)
            print(f'  ✓ {iid} {name} -> {os.path.basename(out)} ({w}x{h})')
            ok += 1
        except Exception as e:
            print(f'  ✗ {iid} {sprite}: {type(e).__name__} {str(e)[:80]}')
            fail += 1

    print(f'\n完成: 成功 {ok}, 失败 {fail}')
    return 0 if fail == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
