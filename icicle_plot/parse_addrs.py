"""
parse_addrs.py – preprocess .addrs files into icicle-plot hierarchy JSON.

Usage:
    python3 parse_addrs.py --mode ipv6    --input data/itdk-data-IPv6.addrs
    python3 parse_addrs.py --mode ipv4    --input data/itdk-data.addrs
    python3 parse_addrs.py --mode ipv6-64 --input data/itdk-data-IPv6.addrs

Output:
    ipv6    → data/ipv6-hierarchy.json   (two-level /32→/48 tree)
    ipv4    → data/ipv4-hierarchy.json   (two-level /8→/16 tree)
    ipv6-64 → data/ipv6-64/{12hexchars}.json  (one file per active /48 block,
               each containing the /48→/64 subtree for on-demand loading)
"""

import argparse
import json
import os
import sys


# ── IPv6 helpers ──────────────────────────────────────────────────────────

def expand_ipv6_to_hex(addr: str) -> str:
    """Return the full 32-char lowercase hex string for an IPv6 address."""
    addr = addr.strip().lower()
    if '::' in addr:
        left_str, right_str = addr.split('::', 1)
        left  = left_str.split(':')  if left_str  else []
        right = right_str.split(':') if right_str else []
        fill  = ['0'] * (8 - len(left) - len(right))
        groups = left + fill + right
    else:
        groups = addr.split(':')
    if len(groups) != 8:
        raise ValueError(f'bad IPv6: {addr!r}')
    return ''.join(g.zfill(4) for g in groups)


# ── IPv4 helpers ──────────────────────────────────────────────────────────

def ipv4_to_hex(addr: str) -> str:
    """Return the 8-char lowercase hex string for a dotted-decimal IPv4 address."""
    parts = addr.strip().split('.')
    if len(parts) != 4:
        raise ValueError(f'bad IPv4: {addr!r}')
    result = ''
    for p in parts:
        n = int(p)
        if not (0 <= n <= 255):
            raise ValueError(f'bad octet {n!r}')
        result += format(n, '02x')
    return result


# ── Display label conversion ───────────────────────────────────────────────

def hex_key_to_label(key: str, prefix_len: int, is_ipv6: bool) -> str:
    """Convert a hex prefix key to a human-readable CIDR label."""
    if is_ipv6:
        padded = key.ljust(32, '0')
        groups = [padded[i:i+4] for i in range(0, 32, 4)]
        # Strip leading zeros per group (keep at least '0')
        short = [g.lstrip('0') or '0' for g in groups]

        # Find the longest run of consecutive all-zero groups for '::' compression
        best_start, best_len = -1, 0
        cur_start, cur_len   = -1, 0
        for i, g in enumerate(short):
            if g == '0':
                if cur_start == -1:
                    cur_start, cur_len = i, 1
                else:
                    cur_len += 1
                if cur_len > best_len:
                    best_len, best_start = cur_len, cur_start
            else:
                cur_start, cur_len = -1, 0

        if best_len > 1:
            before = ':'.join(short[:best_start])
            after  = ':'.join(short[best_start + best_len:])
            addr = (before + '::' if before else '::') + after
        else:
            addr = ':'.join(short)
        return f'{addr}/{prefix_len}'
    else:
        padded = key.ljust(8, '0')
        octets = [str(int(padded[i:i+2], 16)) for i in range(0, 8, 2)]
        return f'{".".join(octets)}/{prefix_len}'


# ── Build hierarchy ───────────────────────────────────────────────────────

def build_hierarchy(input_path: str, is_ipv6: bool) -> dict:
    # IPv6: /32 → /48 only  |  IPv4: /8 → /16 only
    levels = (32, 48) if is_ipv6 else (8, 16)
    cuts   = (8,  12) if is_ipv6 else (2,  4)
    L1, L2 = levels
    C1, C2 = cuts

    # tree[k1][k2] = count
    tree: dict[str, dict[str, int]] = {}
    parsed = 0
    skipped = 0

    parse_fn = expand_ipv6_to_hex if is_ipv6 else ipv4_to_hex

    with open(input_path, 'r', errors='replace') as fh:
        for raw in fh:
            addr = raw.strip()
            if not addr or addr.startswith('#'):
                continue
            try:
                h  = parse_fn(addr)
                k1 = h[:C1]
                k2 = h[:C2]
                if k1 not in tree:
                    tree[k1] = {}
                sub2 = tree[k1]
                sub2[k2] = sub2.get(k2, 0) + 1
                parsed += 1
            except Exception:
                skipped += 1

    # ── Serialise to the JSON tree format ─────────────────────────────────
    sorted_keys1 = sorted(tree)
    children1 = []
    for idx, k1 in enumerate(sorted_keys1):
        children2 = []
        count1 = 0
        for k2 in sorted(tree[k1]):
            cnt = tree[k1][k2]
            children2.append({
                'name':  hex_key_to_label(k2, L2, is_ipv6),
                'count': cnt,
                'level': L2,
            })
            count1 += cnt
        k1_int = int(k1, 16)
        children1.append({
            'name':     hex_key_to_label(k1, L1, is_ipv6),
            'count':    count1,
            'level':    L1,
            'sort_key': k1_int,
            'children': children2,
        })

        # For IPv6, insert a gap node between consecutive active /32 entries.
        if is_ipv6 and idx + 1 < len(sorted_keys1):
            next_k1 = sorted_keys1[idx + 1]
            gap_size = int(next_k1, 16) - k1_int - 1
            if gap_size > 0:
                children1.append({
                    'name':     f'~{gap_size} empty /32s',
                    'count':    0,
                    'level':    L1,
                    'gap':      True,
                    'gap_size': gap_size,
                    'sort_key': k1_int + 0.5,
                    'children': [],
                })

    total = sum(c['count'] for c in children1)
    result = {
        'parsed': parsed,
        'tree': {
            'name':     'Root',
            'count':    total,
            'level':    0,
            'children': children1,
        },
    }

    l1_n = len(children1)
    l2_n = sum(len(c['children']) for c in children1)

    mode = 'IPv6' if is_ipv6 else 'IPv4'
    print(f'[{mode}] parsed={parsed}  skipped={skipped}')
    print(f'        /{L1} nodes={l1_n}  /{L2} nodes={l2_n}')

    return result


# ── Per-/48 detail builder (ipv6-64 mode) ─────────────────────────────────

def build_64_detail(input_path: str, out_dir: str) -> None:
    """Write one JSON file per active /48 block containing its /64 children.

    Files are written to  <out_dir>/ipv6-64/<12-char-hex-prefix>.json
    Each file has the shape: {"children": [{name, count, level}, …]}
    """
    # k2 = first 12 hex chars = /48 prefix
    # k3 = first 16 hex chars = /64 prefix
    tree: dict[str, dict[str, int]] = {}
    parsed = 0
    skipped = 0

    with open(input_path, 'r', errors='replace') as fh:
        for raw in fh:
            addr = raw.strip()
            if not addr or addr.startswith('#'):
                continue
            try:
                h  = expand_ipv6_to_hex(addr)
                k2 = h[:12]
                k3 = h[:16]
                if k2 not in tree:
                    tree[k2] = {}
                sub = tree[k2]
                sub[k3] = sub.get(k3, 0) + 1
                parsed += 1
            except Exception:
                skipped += 1

    out_subdir = os.path.join(out_dir, 'ipv6-64')
    os.makedirs(out_subdir, exist_ok=True)

    for k2 in sorted(tree):
        children = []
        for k3 in sorted(tree[k2]):
            children.append({
                'name':  hex_key_to_label(k3, 64, True),
                'count': tree[k2][k3],
                'level': 64,
            })
        out_file = os.path.join(out_subdir, f'{k2}.json')
        with open(out_file, 'w') as fh:
            json.dump({'children': children}, fh, separators=(',', ':'))

    total_files = len(tree)
    total_64 = sum(len(v) for v in tree.values())
    print(f'[IPv6-64] parsed={parsed}  skipped={skipped}')
    print(f'          /48 blocks={total_files}  /64 nodes={total_64}')
    print(f'          written → {out_subdir}/')


# ── Entry point ───────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Preprocess .addrs files into icicle hierarchy JSON.')
    parser.add_argument('--mode',  required=True, choices=['ipv4', 'ipv6', 'ipv6-64'],
                        help='Address family / detail level to parse')
    parser.add_argument('--input', required=True,
                        help='Path to the .addrs file')
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        sys.exit(f'Error: input file not found: {args.input}')

    # Output directory is always the same folder as the input file.
    data_dir = os.path.join(os.path.dirname(os.path.abspath(args.input)), '')

    print(f'Reading {args.input} …')

    if args.mode == 'ipv6-64':
        build_64_detail(args.input, data_dir)
        return

    is_ipv6 = args.mode == 'ipv6'
    out_name = 'ipv6-hierarchy.json' if is_ipv6 else 'ipv4-hierarchy.json'
    out_path = os.path.join(data_dir, out_name)

    result = build_hierarchy(args.input, is_ipv6)

    os.makedirs(data_dir, exist_ok=True)
    with open(out_path, 'w') as fh:
        json.dump(result, fh, separators=(',', ':'))

    size_mb = os.path.getsize(out_path) / 1_048_576
    print(f'        written → {out_path}  ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
