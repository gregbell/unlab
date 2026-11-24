#include <errno.h>
#include <fcntl.h>
#include <linux/ethtool.h>
#include <linux/if.h>
#include <linux/if_arp.h>
#include <linux/if_tun.h>
#include <linux/sockios.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

static int die(const char *what) { dprintf(2, "%s: %s\n", what, strerror(errno)); return 1; }

static int set_feature(int s, const char *name, uint32_t cmd, uint32_t value) {
  struct ethtool_value v = { .cmd = cmd, .data = value };
  struct ifreq r; memset(&r, 0, sizeof r);
  strncpy(r.ifr_name, name, IFNAMSIZ - 1);
  r.ifr_data = (void *)&v;
  return ioctl(s, SIOCETHTOOL, &r);
}

static int write_all(int fd, const uint8_t *p, size_t n) {
  while (n) { ssize_t w = write(fd, p, n); if (w < 0) { if (errno == EINTR) continue; return -1; } p += w; n -= w; }
  return 0;
}

int main(int argc, char **argv) {
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return die("socket");
  if (argc == 3 && !strcmp(argv[1], "plain")) {
    if (set_feature(s, argv[2], ETHTOOL_STSO, 0)) return die("tso");
    if (set_feature(s, argv[2], ETHTOOL_STXCSUM, 0)) return die("tx checksum");
    return 0;
  }
  if (argc != 4 || strcmp(argv[1], "tap")) { dprintf(2, "usage: unlab-nic tap NAME MAC | plain NAME\n"); return 2; }
  int fd = open("/dev/net/tun", O_RDWR);
  if (fd < 0) return die("/dev/net/tun");
  struct ifreq r; memset(&r, 0, sizeof r);
  strncpy(r.ifr_name, argv[2], IFNAMSIZ - 1);
  r.ifr_flags = IFF_TAP | IFF_NO_PI;
  if (ioctl(fd, TUNSETIFF, &r)) return die("TUNSETIFF");
  unsigned m[6];
  if (sscanf(argv[3], "%x:%x:%x:%x:%x:%x", m, m+1, m+2, m+3, m+4, m+5) != 6) return 2;
  r.ifr_hwaddr.sa_family = ARPHRD_ETHER;
  for (int i = 0; i < 6; i++) r.ifr_hwaddr.sa_data[i] = m[i];
  if (ioctl(s, SIOCSIFHWADDR, &r)) return die("mac");
  static uint8_t out[2 + 65536], in[2 * 65538]; size_t have = 0;
  write_all(1, (uint8_t[]){0, 0}, 2);
  struct pollfd p[2] = { { fd, POLLIN, 0 }, { 0, POLLIN, 0 } };
  for (;;) {
    if (poll(p, 2, -1) < 0) { if (errno == EINTR) continue; return die("poll"); }
    if (p[0].revents) {
      ssize_t n = read(fd, out + 2, 65535);
      if (n < 0) return die("tap read");
      out[0] = n >> 8; out[1] = n;
      if (write_all(1, out, n + 2)) return 0;
    }
    if (p[1].revents) {
      ssize_t n = read(0, in + have, sizeof in - have);
      if (n <= 0) return 0;
      have += n;
      size_t at = 0;
      while (have - at >= 2) {
        size_t len = in[at] << 8 | in[at + 1];
        if (have - at - 2 < len) break;
        if (write(fd, in + at + 2, len) < 0 && errno != EIO && errno != EINVAL) return die("tap write");
        at += 2 + len;
      }
      memmove(in, in + at, have -= at);
    }
  }
}
