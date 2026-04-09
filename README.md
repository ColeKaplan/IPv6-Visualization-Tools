# IPv6 Visualization Tools

A collection of tools for visualizing IPv4/IPv6 address space data.

---

## Project Structure

```
IPv6-Visualization-Tools/
├── fish_eye/        # Fish-eye magnification viewer for heatmap images
├── icicle_plot/     # Icicle/treemap plot of IPv6 prefix hierarchies
├── ipv4_heatmap/    # C tool to generate Hilbert curve heatmaps of IPv4 space
└── maps/            # Shared map image assets
```

---

## Running the Web Visualizations (fish_eye & icicle_plot)

Both `fish_eye` and `icicle_plot` are browser-based tools that need be served over HTTP. The easiest way to run both from a single server is to start one from the **project root**.

### Python Live Server

```bash
# From the project root
python3 -m http.server 8000
```

Then open in your browser:
- Fish-eye viewer: [http://localhost:8000/fish_eye/](http://localhost:8000/fish_eye/)
- Icicle plot: [http://localhost:8000/icicle_plot/](http://localhost:8000/icicle_plot/)

### VS Code Live Server extension

1. Right-click the **project root folder** in the VS Code Explorer and select **"Open with Live Server"**.
2. Navigate to `fish_eye/` or `icicle_plot/` in the browser tab that opens.

---

## ipv4-heatmap

Generate Hilbert curve heatmaps of the IPv4 address space. Inspired by [xkcd #195](https://xkcd.com/195/). See [maps.measurement-factory.com](http://maps.measurement-factory.com/) for examples.

### Dependencies

- GD library (`libgd`)
- build-essential / C compiler

### Installing Dependencies & Compiling

```bash
sudo apt-get install libgd-dev build-essential
cd ipv4_heatmap
make
```

### Usage

```
ipv4-heatmap [−dhprm] [−A float] [−B float] [−a file] [−f font]
             [−g seconds] [−k file] [−o file] [−s file] [−t string]
             [−u string] [−y prefix] [−z bits] < iplist
```

`ipv4-heatmap` reads a list of IPv4 addresses from stdin and produces a **4096×4096 PNG image** where each pixel represents a `/24` network. Pixel color encodes host count: blue (1 host) → red (256 hosts), black = no data.

### Key Options

| Option | Description |
|--------|-------------|
| `-o outfile` | Output file name (default: `map.png`) |
| `-t title` | Draw a legend with the given title |
| `-h` | Attach a horizontal legend at the bottom |
| `-a annotations` | File of CIDR → label annotations to overlay |
| `-s shades` | File of CIDR regions to shade with custom colors |
| `-A logmin` | Scale input logarithmically; values ≤ logmin → 1 |
| `-B logmax` | Scale input logarithmically; values ≥ logmax → 255 |
| `-y cidr` | Render only the specified CIDR netblock (must be even-prefix) |
| `-z bits` | Bits per pixel (default 8 = one pixel per /24) |
| `-m` | Use Morton (Z-order) curve instead of Hilbert |
| `-g seconds` | Animated GIF output; one frame per N seconds of input data |
| `-p` | Add CIDR prefix-size boxes to the legend |
| `-r` | Reverse background/foreground colors |
| `-d` | Increase debug verbosity |

### Input Modes

1. **Increment mode** — one IPv4 address per line; each address increments its `/24` pixel.
2. **Exact mode** — two fields per line: `<address> <color-index (0–255)>`.
3. **Logarithmic mode** — like Exact mode but the second column is log-scaled using `-A` and `-B`.

### Annotations File Format

Tab-separated fields: `<CIDR prefix>\t<label>[\t<sublabel|"prefix">]`

```
15.0.0.0/8	HP
16.0.0.0/8	DEC
17.0.0.0/8	Apple
```

### Shading File Format

Tab-separated fields: `<CIDR prefix>\t<0xRRGGBB color>\t<alpha (0=transparent, 127=opaque)>`

```
10.0.0.0/8	0x7F7FFF	64
172.16.0.0/12	0x7F7FFF	64
192.168.0.0/16	0x7F7FFF	64
```

### Animated GIF Output

Requires [gifsicle](https://www.lcdf.org/gifsicle/) to be installed. Input must include Unix epoch timestamps as the first field:

```
1234567890.123  192.168.1.1
1234567890.234  192.168.1.2
1234567891.456  192.168.1.3
```