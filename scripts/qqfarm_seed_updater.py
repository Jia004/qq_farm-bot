#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
QQ 农场 · 种子/植物数据自动更新工具
================================================

用途
----
从 QQ 农场官方 CDN（cdn-resource.nqf.qq.com）拉取最新的种子资源，
自动比对本地 Plant.json / ItemInfo.json，找出「新种子」，并可：
  1. 下载官方 .astc 图集
  2. 用 astcenc 解码
  3. 按 manifest 里的 rect 切成 PNG 图标
  4. 追加到 core/src/gameConfig/seed_images_named/
  5. 生成待补的 Plant.json / ItemInfo.json 条目（--write 时直接写回）

为什么需要 manifest
-------------------
官方 CDN 不提供「目录列表」，无法盲目枚举有哪些种子。
但游戏客户端启动时会下载一份 Cocos 资源清单（manifest.json），
其中每个资源带有 sprite_name（如 Crop_193_Seed）、source（.astc 路径）、
metadata_json（切图坐标）。本工具以此为「新种子发现来源」。

manifest 从哪来（三种，任选其一）
---------------------------------
  A. 抓包获取：用项目自带的抓包功能，抓游戏客户端启动时的资源请求，
     导出其中的 manifest.json（文件名形如 <数字>-manifest.json）。
  B. 手动提供：把任何一份包含 images[] 数组（元素含 sprite_name/source/
     metadata_json）的 manifest.json 放到本地，用 --manifest 指定。
  C. 自动探测：--probe 会尝试若干已知 CDN 路径（成功率取决于官方是否公开）。

依赖
----
  pip install texture2ddecoder pillow
  （texture2ddecoder 是纯 wheel 的 ASTC 解码库，无需外部程序；
   若未安装，脚本会回退到 astcenc 命令行，两者都没有则只做数据比对。）

用法示例
--------
  # 只检查有哪些新种子（不下载、不写文件）
  python scripts/qqfarm_seed_updater.py check --manifest ./manifest.json

  # 检查并下载/切图新种子图标
  python scripts/qqfarm_seed_updater.py update --manifest ./manifest.json

  # 下载 + 切图 + 直接把缺失条目写进 Plant.json / ItemInfo.json
  python scripts/qqfarm_seed_updater.py update --manifest ./manifest.json --write

  # 探测官方 CDN 上是否放了 manifest
  python scripts/qqfarm_seed_updater.py probe
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request

# ---------------------------------------------------------------------------
# 路径常量
# ---------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
GAMECONFIG = os.path.join(REPO, 'core', 'src', 'gameConfig')
PLANT_JSON = os.path.join(GAMECONFIG, 'Plant.json')
ITEMINFO_JSON = os.path.join(GAMECONFIG, 'ItemInfo.json')
SEED_IMG_DIR = os.path.join(GAMECONFIG, 'seed_images_named')
MANIFEST_CSV = os.path.join(GAMECONFIG, 'manifest.csv')
TMP_DIR = os.path.join(REPO, 'tmp', 'seed_updater')

CDN = 'https://cdn-resource.nqf.qq.com/'

# 种子 sprite 命名规则：Crop_<cropId>_Seed   →  seed_id = 20000 + cropId
SEED_SPRITE_RE = re.compile(r'^Crop_(\d+)_Seed$')
SEED_ID_BASE = 20000

# 忽略 SSL 校验（部分环境证书链不全；CDN 为静态资源，风险可接受）
_CTX = ssl.create_default_context()
_CTX.check_hostname = False
_CTX.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------------------
# 网络
# ---------------------------------------------------------------------------
def http_get(url: str, timeout: int = 60) -> bytes | None:
    """GET 一个 URL，返回 bytes；404/403 返回 None。"""
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code in (403, 404):
            return None
        raise
    except Exception as e:
        print(f'  ! 请求失败 {url}: {e}', file=sys.stderr)
        return None


def cdn_url(source_path: str) -> str:
    """拼 CDN 完整 URL。source_path 里的 %40 等已编码字符需原样保留。"""
    return CDN + source_path.lstrip('/')


# ---------------------------------------------------------------------------
# 数据加载
# ---------------------------------------------------------------------------
def load_json(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path: str, data):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_plant_ids() -> set[int]:
    """已收录的 seed_id 集合。"""
    plants = load_json(PLANT_JSON)
    ids = set()
    for p in plants:
        sid = p.get('seed_id')
        if sid:
            ids.add(int(sid))
    return ids


def load_item_ids() -> set[int]:
    items = load_json(ITEMINFO_JSON)
    return {int(i['id']) for i in items if isinstance(i.get('id'), int) or str(i.get('id', '')).isdigit()}


def load_local_seed_images() -> set[int]:
    """seed_images_named 里已有哪些 <id>_...png。"""
    have = set()
    if not os.path.isdir(SEED_IMG_DIR):
        return have
    for fn in os.listdir(SEED_IMG_DIR):
        m = re.match(r'^(\d+)_', fn)
        if m:
            have.add(int(m.group(1)))
    return have


# ---------------------------------------------------------------------------
# manifest 解析
# ---------------------------------------------------------------------------
def fetch_manifest_from_url(url: str) -> dict | None:
    raw = http_get(url, timeout=60)
    if not raw:
        print(f'  ! 无法从 {url} 下载 manifest', file=sys.stderr)
        return None
    try:
        return json.loads(raw)
    except Exception as e:
        print(f'  ! manifest 不是合法 JSON: {e}', file=sys.stderr)
        return None


def collect_seed_sprites(manifest: dict) -> list[dict]:
    """
    从 manifest 里筛出所有种子精灵。
    兼容两种结构：
      - {"images": [ {sprite_name, source, metadata_json, rect?}, ... ]}
      - 直接 [ {...}, ... ]
    返回 [{crop_id, seed_id, sprite_name, source, metadata_json, rect}]
    """
    imgs = manifest.get('images') if isinstance(manifest, dict) else manifest
    if not isinstance(imgs, list):
        return []

    out = []
    seen = set()
    for it in imgs:
        if not isinstance(it, dict):
            continue
        name = str(it.get('sprite_name') or it.get('name') or '')
        m = SEED_SPRITE_RE.match(name)
        if not m:
            continue
        crop = int(m.group(1))
        seed_id = SEED_ID_BASE + crop
        if seed_id in seen:
            continue
        seen.add(seed_id)

        rect = it.get('rect')
        if isinstance(rect, str):
            try:
                rect = json.loads(rect.replace("'", '"'))
            except Exception:
                rect = None

        out.append({
            'crop_id': crop,
            'seed_id': seed_id,
            'sprite_name': name,
            'source': it.get('source') or '',
            'metadata_json': it.get('metadata_json') or '',
            'rect': rect,
        })
    return out


def load_manifest_csv_seeds() -> list[dict]:
    """把项目里已有的 manifest.csv 当作一份离线 manifest 兜底。"""
    if not os.path.isfile(MANIFEST_CSV):
        return []
    rows = list(csv.reader(open(MANIFEST_CSV, encoding='utf-8')))
    if not rows:
        return []
    header = rows[0]
    out = []
    seen = set()
    for r in rows[1:]:
        if len(r) < 5:
            continue
        rec = dict(zip(header, r))
        name = rec.get('sprite_name', '')
        m = SEED_SPRITE_RE.match(name)
        if not m:
            continue
        crop = int(m.group(1))
        seed_id = SEED_ID_BASE + crop
        if seed_id in seen:
            continue
        seen.add(seed_id)
        rect = None
        try:
            rect = json.loads((rec.get('rect') or '').replace("'", '"'))
        except Exception:
            pass
        out.append({
            'crop_id': crop,
            'seed_id': seed_id,
            'sprite_name': name,
            'source': rec.get('source', ''),
            'metadata_json': rec.get('metadata_json', ''),
            'rect': rect,
        })
    return out


# ---------------------------------------------------------------------------
# astc → png
# ---------------------------------------------------------------------------
# ASTC 魔数（小端 0x5CA1AB13）
_ASTC_MAGIC = bytes([0x13, 0xAB, 0xA1, 0x5C])


def _has_texture2ddecoder() -> bool:
    try:
        import texture2ddecoder  # noqa: F401
        return True
    except Exception:
        return False


def astc_to_png(astc_bytes: bytes, png_path: str) -> bool:
    """
    把官方 CDN 的 .astc（每个种子一张独立小图）解码成 PNG。
    优先用纯 Python 的 texture2ddecoder（无需外部程序）；
    没有该库时回退到 astcenc 命令行。
    """
    from PIL import Image

    if astc_bytes[:4] != _ASTC_MAGIC:
        print('  ! 不是 ASTC 数据，跳过', file=sys.stderr)
        return False

    bx, by, bz = astc_bytes[4], astc_bytes[5], astc_bytes[6]
    dx = astc_bytes[7] | (astc_bytes[8] << 8) | (astc_bytes[9] << 16)
    dy = astc_bytes[10] | (astc_bytes[11] << 8) | (astc_bytes[12] << 16)
    px = astc_bytes[16:]

    # 方案 1：texture2ddecoder（推荐）
    if _has_texture2ddecoder():
        from texture2ddecoder import decode_astc
        try:
            raw = decode_astc(px, dx, dy, bx, by)
            # 输出为 BGRA，需用 BGRA 通道序读入再转 RGBA
            img = Image.frombytes('RGBA', (dx, dy), raw, 'raw', 'BGRA')
            os.makedirs(os.path.dirname(png_path), exist_ok=True)
            img.save(png_path)
            return True
        except Exception as e:
            print(f'  ! texture2ddecoder 解码失败: {e}', file=sys.stderr)

    # 方案 2：回退 astcenc 命令行
    from shutil import which
    if which('astcenc') is None:
        print('  ! 缺少解码器：请 `pip install texture2ddecoder`（推荐）或安装 astcenc CLI')
        return False

    os.makedirs(TMP_DIR, exist_ok=True)
    astc_path = os.path.join(TMP_DIR, str(abs(hash(png_path))) + '.astc')
    with open(astc_path, 'wb') as f:
        f.write(astc_bytes)
    tmp_png = astc_path + '.png'
    try:
        subprocess.run(['astcenc', '-dl', astc_path, tmp_png],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception as e:
        print(f'  ! astcenc 解码失败: {e}', file=sys.stderr)
        return False

    # astcenc 解出的整张图就是该种子图标，按 rect 裁剪
    base = Image.open(tmp_png).convert('RGBA')
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    base.save(png_path)
    return True


def download_and_slice(sprite: dict, dry_run: bool = False) -> str | None:
    """
    下载一个种子的图集（每种子一张独立 ASTC 小图）并转成 PNG。
    返回输出文件名（成功）或 None。
    """
    seed_id = sprite['seed_id']
    out_name = f"{seed_id}_{sprite['sprite_name']}.png"
    out_path = os.path.join(SEED_IMG_DIR, out_name)
    if os.path.exists(out_path):
        return out_name

    src = sprite.get('source') or ''
    if not src:
        print(f'  ! seed {seed_id} 缺少 source，跳过（可手动补）')
        return None

    if dry_run:
        return out_name

    raw = http_get(cdn_url(src))
    if not raw:
        print(f'  ! seed {seed_id} 图集下载失败: {src}')
        return None

    if not astc_to_png(raw, out_path):
        return None

    # 若 manifest 给出 rect 且图集比 rect 大，做裁剪（通常是 1:1，无需裁）
    rect = sprite.get('rect')
    if rect and rect.get('width') and rect.get('height'):
        try:
            from PIL import Image
            img = Image.open(out_path)
            x, y, w, h = rect['x'], rect['y'], rect['width'], rect['height']
            if (w, h) != img.size:
                img.crop((x, y, x + w, y + h)).save(out_path)
        except Exception:
            pass

    return out_name


def extract_rect_from_metadata(raw: bytes, sprite_name: str) -> dict | None:
    """从 Cocos SpriteFrame metadata json 里按 sprite_name 找 rect。"""
    try:
        data = json.loads(raw)
    except Exception:
        return None

    def walk(node):
        if isinstance(node, dict):
            if node.get('name') == sprite_name and isinstance(node.get('rect'), dict):
                return node['rect']
            for v in node.values():
                r = walk(v)
                if r:
                    return r
        elif isinstance(node, list):
            for v in node:
                r = walk(v)
                if r:
                    return r
        return None

    return walk(data)


# ---------------------------------------------------------------------------
# 生成 Plant.json / ItemInfo.json 条目
# ---------------------------------------------------------------------------
def make_plant_entry(seed_id: int, crop_id: int, name: str | None = None) -> dict:
    """
    生成一条 Plant.json 条目（结构对齐现有条目，未知字段留空/默认）。
    注意：grow_phases / land_level_need / fruit 等玩法数据 CDN 图集里没有，
    需要你按游戏实际情况补；这里给安全默认值，保证能被识别为种子。
    """
    nm = name or f'新作物{crop_id}'
    return {
        'id': 1000000 + crop_id,          # 占位植物ID，避免与现有冲突；可后改
        'mutant_effect_plant': None,
        'name': nm,
        'fruit': {'id': 40000 + crop_id, 'count': 1},  # 占位果实
        'seed_id': seed_id,
        'land_level_need': 1,
        'seasons': 1,
        'grow_phases': '种子:3600;发芽:3600;小叶子:3600;大叶子:3600;开花:3600;成熟:0;',
        'exp': 0,
        'special_fruit': None,
        'size': None,
    }


def make_item_entry(seed_id: int, crop_id: int, name: str | None = None) -> dict:
    """生成一条 ItemInfo.json 种子物品条目（type=5 表示种子）。"""
    nm = name or f'新作物{crop_id}种子'
    return {
        'id': seed_id,
        'name': nm,
        'type': 5,
        'level': 1,
        'price': 0,
        'price_id': 200,
        'interaction_type': 'plant',
    }


# ---------------------------------------------------------------------------
# 子命令
# ---------------------------------------------------------------------------
def load_manifest(args) -> dict | list | None:
    if args.manifest:
        if not os.path.isfile(args.manifest):
            print(f'! 找不到 manifest 文件: {args.manifest}', file=sys.stderr)
            return None
        with open(args.manifest, encoding='utf-8') as f:
            return json.load(f)
    if args.manifest_url:
        print(f'→ 下载 manifest: {args.manifest_url}')
        return fetch_manifest_from_url(args.manifest_url)
    return None


def cmd_check(args):
    manifest = load_manifest(args)
    if manifest:
        sprites = collect_seed_sprites(manifest)
        src_desc = 'manifest'
    else:
        print('→ 未提供 manifest，回退使用项目内 manifest.csv 作为比对基线')
        sprites = load_manifest_csv_seeds()
        src_desc = 'manifest.csv'

    if not sprites:
        print('! 没有解析到任何种子精灵，请检查 manifest 结构')
        return 1

    plant_ids = load_plant_ids()
    item_ids = load_item_ids()
    local_imgs = load_local_seed_images()

    new_seeds = [s for s in sprites if s['seed_id'] not in plant_ids]
    new_items = [s for s in sprites if s['seed_id'] not in item_ids]
    no_img = [s for s in sprites if s['seed_id'] not in local_imgs]

    print(f'\n=== 种子数据比对（来源: {src_desc}）===')
    print(f'  manifest 里种子精灵总数 : {len(sprites)}')
    print(f'  本地 Plant.json 已收录   : {len(plant_ids)}')
    print(f'  本地 ItemInfo 已收录种子 : {len(item_ids)}')
    print(f'  本地已有图标 PNG         : {len(local_imgs)}')
    print(f'\n  ✗ Plant.json 缺失的种子  : {len(new_seeds)}')
    for s in sorted(new_seeds, key=lambda x: x['seed_id']):
        print(f'      seed_id={s["seed_id"]}  ({s["sprite_name"]})')
    print(f'\n  ✗ ItemInfo 缺失的种子    : {len(new_items)}')
    print(f'  ✗ 缺图标的种子           : {len(no_img)}')
    return 0


def cmd_update(args):
    manifest = load_manifest(args)
    if manifest:
        sprites = collect_seed_sprites(manifest)
        src_desc = 'manifest'
    else:
        print('→ 未提供 manifest，回退使用项目内 manifest.csv')
        sprites = load_manifest_csv_seeds()
        src_desc = 'manifest.csv'

    if not sprites:
        print('! 没有解析到任何种子精灵')
        return 1

    plant_ids = load_plant_ids()
    item_ids = load_item_ids()
    local_imgs = load_local_seed_images()

    # 1) 补齐缺失图标
    no_img = [s for s in sprites if s['seed_id'] not in local_imgs]
    print(f'\n=== 步骤1：下载并解码缺少的种子图标（{len(no_img)} 个）===')
    if no_img and not _has_texture2ddecoder():
        print('  ! 未检测到解码库，跳过切图。安装后可重跑本命令：')
        print('    pip install texture2ddecoder pillow')
    made = 0
    for s in sorted(no_img, key=lambda x: x['seed_id']):
        if not _has_texture2ddecoder():
            break
        name = download_and_slice(s, dry_run=False)
        if name:
            made += 1
            print(f'  ✓ {name}')
    print(f'  本次新增图标: {made}')

    # 2) 生成 / 写入 JSON 条目
    new_plants = [s for s in sprites if s['seed_id'] not in plant_ids]
    new_items = [s for s in sprites if s['seed_id'] not in item_ids]

    print(f'\n=== 步骤2：数据条目（Plant.json 缺 {len(new_plants)}，ItemInfo 缺 {len(new_items)}）===')
    if not new_plants and not new_items:
        print('  ✓ 本地数据表已是最新，无需写入')
        return 0

    if not args.write:
        print('  （未加 --write，仅预览；加 --write 才会写回文件）')
        for s in new_plants:
            print(f'    + Plant   {s["seed_id"]}  {s["sprite_name"]}')
        for s in new_items:
            print(f'    + ItemInfo {s["seed_id"]}  {s["sprite_name"]}')
        return 0

    # 备份
    for path in (PLANT_JSON, ITEMINFO_JSON):
        bak = path + '.bak'
        if not os.path.exists(bak):
            with open(path, 'rb') as src, open(bak, 'wb') as dst:
                dst.write(src.read())
            print(f'  → 已备份 {os.path.basename(path)} → {os.path.basename(bak)}')

    if new_plants:
        plants = load_json(PLANT_JSON)
        existing = {int(p.get('seed_id')) for p in plants if p.get('seed_id')}
        for s in new_plants:
            if s['seed_id'] in existing:
                continue
            plants.append(make_plant_entry(s['seed_id'], s['crop_id']))
        save_json(PLANT_JSON, plants)
        print(f'  ✓ Plant.json 已追加 {len(new_plants)} 条（名称/玩法字段请按需修正）')

    if new_items:
        items = load_json(ITEMINFO_JSON)
        existing = {int(i['id']) for i in items if str(i.get('id', '')).isdigit()}
        for s in new_items:
            if s['seed_id'] in existing:
                continue
            items.append(make_item_entry(s['seed_id'], s['crop_id']))
        save_json(ITEMINFO_JSON, items)
        print(f'  ✓ ItemInfo.json 已追加 {len(new_items)} 条')

    print('\n⚠ 提示：自动生成的条目名称为占位（"新作物N"），等级/价格/生长周期等字段')
    print('   为安全默认值，请按游戏实际数据核对后再上线。')
    return 0


def cmd_probe(args):
    """探测官方 CDN 上常见的 manifest 路径。"""
    print('=== 探测官方 CDN manifest 路径 ===')
    cands = [
        'manifest.json',
        'release/remote/manifest.json',
        'release/remote/plant/manifest.json',
        'release/remote/plant/native/manifest.json',
        'release/remote/plant/import/manifest.json',
        'release/remote/plant/config.json',
        'release/remote/config.json',
        'config.json',
        'version.json',
        'release/remote/version.json',
        'project.manifest',
        'release/remote/project.manifest',
    ]
    found = []
    for c in cands:
        url = cdn_url(c)
        req = urllib.request.Request(url, method='HEAD', headers={'User-Agent': 'Mozilla/5.0'})
        try:
            with urllib.request.urlopen(req, timeout=15, context=_CTX) as resp:
                size = resp.headers.get('Content-Length', '?')
                print(f'  200  {c}  ({size} bytes)')
                found.append(c)
        except urllib.error.HTTPError as e:
            print(f'  {e.code}  {c}')
        except Exception as e:
            print(f'  ERR  {c}  ({e})')
    if found:
        print(f'\n✓ 发现 {len(found)} 个可用路径，可用 --manifest-url 指定：')
        for c in found:
            print(f'    --manifest-url {cdn_url(c)}')
    else:
        print('\n✗ 未探测到公开 manifest。官方未直接暴露清单，需通过抓包获取')
        print('  （见脚本头部说明「manifest 从哪来」的 A/B 方案）。')
    return 0


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(
        description='QQ 农场种子/植物数据自动更新工具',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest='cmd', required=True)

    for name, fn, help_text in [
        ('check', cmd_check, '只比对，列出新种子（不改任何文件）'),
        ('update', cmd_update, '下载/切图/并可写入 Plant.json、ItemInfo.json'),
        ('probe', cmd_probe, '探测官方 CDN 上的 manifest 路径'),
    ]:
        p = sub.add_parser(name, help=help_text)
        if name != 'probe':
            p.add_argument('--manifest', help='本地 manifest.json 路径')
            p.add_argument('--manifest-url', help='manifest 的在线 URL')
            if name == 'update':
                p.add_argument('--write', action='store_true', help='把缺失条目写回 Plant.json / ItemInfo.json')
        p.set_defaults(func=fn)

    args = ap.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
