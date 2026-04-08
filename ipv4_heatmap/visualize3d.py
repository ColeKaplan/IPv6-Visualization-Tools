import csv
import matplotlib.pyplot as plt
from mpl_toolkits.mplot3d import Axes3D
import os
import random

# Configuration
CSV_FILE = "ipv6_3d_9bit.csv"
MAX_POINTS = 50000  # Matplotlib is slower than WebGL

if not os.path.exists(CSV_FILE):
    print(f"Error: {CSV_FILE} not found. Run the C tool first.")
    exit(1)

print(f"Loading data from {CSV_FILE}...")
x_vals, y_vals, z_vals = [], [], []

try:
    with open(CSV_FILE, "r") as f:
        reader = csv.DictReader(f)
        # Read all points first
        all_points = []
        for row in reader:
            all_points.append((float(row["x"]), float(row["y"]), float(row["z"])))

        # Sample if too many
        if len(all_points) > MAX_POINTS:
            print(f"Sampling {MAX_POINTS} points for performance...")
            all_points = random.sample(all_points, MAX_POINTS)

        for x, y, z in all_points:
            x_vals.append(x)
            y_vals.append(y)
            z_vals.append(z)
except Exception as e:
    print(f"Error reading CSV: {e}")
    exit(1)

print("Generating 3D plot...")
fig = plt.figure(figsize=(12, 8))
ax = fig.add_subplot(111, projection="3d")

# Simple coloring based on position
colors = [(x / 512, y / 512, z / 512) for x, y, z in zip(x_vals, y_vals, z_vals)]

ax.scatter(x_vals, y_vals, z_vals, c=colors, s=1, alpha=0.6)

ax.set_xlabel("X")
ax.set_ylabel("Y")
ax.set_zlabel("Z")
ax.set_title(f"IPv6 3D Clustering ({len(x_vals)} points)")

# Set limits for orientation
ax.set_xlim(0, 512)
ax.set_ylim(0, 512)
ax.set_zlim(0, 512)

print("Opening interactive window...")
plt.show()
