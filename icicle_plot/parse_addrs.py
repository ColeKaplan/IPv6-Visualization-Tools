"""
parse_addrs.py – preprocess .addrs files into icicle-plot hierarchy JSON.

Usage:
    python3 parse_addrs.py --mode ipv6 --input data/itdk-data-IPv6.addrs
    python3 parse_addrs.py --mode ipv4 --input data/itdk-data.addrs

Output written to data/ipv6-hierarchy.json or data/ipv4-hierarchy.json.
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
    children1 = []
    for k1 in sorted(tree):
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
        children1.append({
            'name':     hex_key_to_label(k1, L1, is_ipv6),
            'count':    count1,
            'level':    L1,
            'children': children2,
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


# ── Entry point ───────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Preprocess .addrs files into icicle hierarchy JSON.')
    parser.add_argument('--mode',  required=True, choices=['ipv4', 'ipv6'],
                        help='Address family to parse')
    parser.add_argument('--input', required=True,
                        help='Path to the .addrs file')
    args = parser.parse_args()

    is_ipv6 = args.mode == 'ipv6'
    out_name = 'ipv6-hierarchy.json' if is_ipv6 else 'ipv4-hierarchy.json'

    # Output goes into data/ relative to the input file's directory
    data_dir = os.path.join(os.path.dirname(os.path.abspath(args.input)), '')
    out_path = os.path.join(data_dir, out_name)

    if not os.path.isfile(args.input):
        sys.exit(f'Error: input file not found: {args.input}')

    print(f'Reading {args.input} …')
    result = build_hierarchy(args.input, is_ipv6)

    os.makedirs(data_dir, exist_ok=True)
    with open(out_path, 'w') as fh:
        json.dump(result, fh, separators=(',', ':'))

    size_mb = os.path.getsize(out_path) / 1_048_576
    print(f'        written → {out_path}  ({size_mb:.1f} MB)')


if __name__ == '__main__':
    main()
