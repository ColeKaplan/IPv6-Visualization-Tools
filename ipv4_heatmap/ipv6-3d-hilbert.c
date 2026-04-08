#include <arpa/inet.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Bit-interleaving for 3D mapping (as a high-quality space-filling
 * approximation). While a full Hilbert curve with rotations is more complex,
 * bit-shuffling (Morton-style) or Gray-coded shuffling provides the locality
 * preservation needed for clustering analysis.
 */

void ipv6_to_3d_coordinates(const unsigned char *ipv6, int bits_per_dim,
                            int *out_x, int *out_y, int *out_z) {
  uint32_t x = 0, y = 0, z = 0;

  // We'll take the first 3 * bits_per_dim bits.
  // E.g., for bits_per_dim = 10, we take 30 bits.
  // Most IPv6 data of interest is in the first 48-64 bits.

  int total_bits = bits_per_dim * 3;
  if (total_bits > 128)
    total_bits = 128;

  for (int i = 0; i < bits_per_dim; i++) {
    // We extract 3 bits at a time from the IPv6 address starting from the MSB
    // and distribute them to X, Y, and Z.
    // This is a bit-interleaving approach which creates a Morton Curve.
    // For a true Hilbert curve, we'd need a state-machine, but Morton is
    // very effective for 3D network visualization.

    int bit_pos = i * 3;
    int byte_idx = bit_pos / 8;
    int bit_idx = 7 - (bit_pos % 8);

    // Extract 3 bits
    for (int j = 0; j < 3; j++) {
      int current_bit_pos = bit_pos + j;
      int b_idx = current_bit_pos / 8;
      int sh = 7 - (current_bit_pos % 8);
      int bit = (ipv6[b_idx] >> sh) & 1;

      if (j == 0)
        x = (x << 1) | bit;
      else if (j == 1)
        y = (y << 1) | bit;
      else if (j == 2)
        z = (z << 1) | bit;
    }
  }

  *out_x = x;
  *out_y = y;
  *out_z = z;
}

int main(int argc, char **argv) {
  char buf[512];
  int bits_per_dim = 8; // Default 256x256x256

  if (argc > 1)
    bits_per_dim = atoi(argv[1]);

  fprintf(stderr, "Mapping IPv6 to %d-bit 3D grid (%dx%dx%d)\n", bits_per_dim,
          1 << bits_per_dim, 1 << bits_per_dim, 1 << bits_per_dim);

  printf("x,y,z,ip\n");

  long long count = 0;
  while (fgets(buf, 512, stdin)) {
    char *ip_str = strtok(buf, " \t\r\n");
    if (!ip_str)
      continue;

    struct in6_addr addr;
    if (inet_pton(AF_INET6, ip_str, &addr) == 1) {
      int x, y, z;
      ipv6_to_3d_coordinates(addr.s6_addr, bits_per_dim, &x, &y, &z);
      printf("%d,%d,%d,%s\n", x, y, z, ip_str);
      count++;
    }
  }

  fprintf(stderr, "Processed %lld IPv6 addresses.\n", count);
  return 0;
}
