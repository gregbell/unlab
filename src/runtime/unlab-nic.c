// The guest's side of a NIC that kwnet does not drive.
//
//   unlab-nic plain NAME     stop NAME sending oversized segments without checksums
//   unlab-nic tap NAME MAC   make a TAP device and carry its frames on stdin and stdout
//
// Each frame on the pipes is a big-endian length and that many bytes. One empty
// frame on stdout says the device exists. nic-pipe.ts is the other side.

#include <errno.h>
#include <fcntl.h>
#include <linux/ethtool.h>
#include <linux/if.h>
#include <linux/if_arp.h>
#include <linux/if_tun.h>
#include <linux/sockios.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

enum { HEADER = 2, FRAME_MAX = 65535 };

static void say(const char *text) {
  if (write(2, text, strlen(text)) < 0) return;
}

static int die(const char *what) {
  const char *why = strerror(errno);
  say(what);
  say(": ");
  say(why);
  say("\n");
  return 1;
}

static int turn_off(int s, const char *name, uint32_t feature) {
  struct ethtool_value off = {.cmd = feature, .data = 0};
  struct ifreq r = {0};
  strncpy(r.ifr_name, name, IFNAMSIZ - 1);
  r.ifr_data = (void *)&off;
  return ioctl(s, SIOCETHTOOL, &r);
}

static int digit(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

static int parse_mac(const char *text, char *mac) {
  if (strlen(text) != 17) return -1;
  for (int i = 0; i < 6; i++, text += 3) {
    int hi = digit(text[0]), lo = digit(text[1]);
    if (hi < 0 || lo < 0 || (i < 5 && text[2] != ':')) return -1;
    mac[i] = (char)(hi << 4 | lo);
  }
  return 0;
}

static int relay(int tap) {
  static uint8_t in[2 * (HEADER + FRAME_MAX)];
  static uint8_t out[HEADER + FRAME_MAX];
  // The first thing owed to stdout is the empty frame.
  size_t have = 0, sent = 0, owed = HEADER;

  for (;;) {
    // Stdout may be full for as long as it likes: stdin is still read, so the two directions cannot wait on each
    // other. Meanwhile the device's own queue holds what the guest sends, and drops past its end.
    struct pollfd p[3] = {
        {.fd = 0, .events = POLLIN},
        {.fd = 1, .events = owed ? POLLOUT : 0},
        {.fd = owed ? -1 : tap, .events = POLLIN},
    };
    if (poll(p, 3, -1) < 0) {
      if (errno == EINTR) continue;
      return die("poll");
    }

    if (p[2].revents) {
      ssize_t n = read(tap, out + HEADER, FRAME_MAX);
      if (n < 0 && errno != EAGAIN && errno != EINTR) return die("tap read");
      if (n > 0) {
        out[0] = (uint8_t)(n >> 8);
        out[1] = (uint8_t)n;
        sent = 0;
        owed = HEADER + (size_t)n;
      }
    }
    if (owed) {
      ssize_t n = write(1, out + sent, owed);
      if (n < 0 && errno != EAGAIN && errno != EINTR) return 0;
      if (n > 0) {
        sent += (size_t)n;
        owed -= (size_t)n;
      }
    } else if (p[1].revents & (POLLERR | POLLHUP)) {
      return 0;
    }

    if (p[0].revents) {
      ssize_t n = read(0, in + have, sizeof in - have);
      if (n < 0 && errno != EAGAIN && errno != EINTR) return die("stdin");
      if (n == 0) return 0;
      if (n > 0) have += (size_t)n;
      size_t at = 0;
      while (have - at >= HEADER) {
        size_t len = (size_t)in[at] << 8 | in[at + 1];
        if (have - at - HEADER < len) break;
        // A device that is down, or a frame it will not take, loses the frame, as on a wire. Only a device that is
        // gone ends the relay.
        if (len && write(tap, in + at + HEADER, len) < 0 && errno == EBADFD) return die("tap write");
        at += HEADER + len;
      }
      memmove(in, in + at, have -= at);
    }
  }
}

int main(int argc, char **argv) {
  int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (s < 0) return die("socket");

  if (argc == 3 && !strcmp(argv[1], "plain")) {
    if (turn_off(s, argv[2], ETHTOOL_STSO)) return die("segmentation offload");
    if (turn_off(s, argv[2], ETHTOOL_STXCSUM)) return die("checksum offload");
    return 0;
  }
  struct ifreq r = {0};
  if (argc != 4 || strcmp(argv[1], "tap") || parse_mac(argv[3], r.ifr_hwaddr.sa_data)) {
    say("usage: unlab-nic plain NAME | unlab-nic tap NAME MAC\n");
    return 2;
  }

  signal(SIGPIPE, SIG_IGN);
  // A guest short of memory must not lose its NIC to the program that used it up.
  int oom = open("/proc/self/oom_score_adj", O_WRONLY | O_CLOEXEC);
  if (oom >= 0) {
    (void)!write(oom, "-1000", 5);
    close(oom);
  }

  int tap = open("/dev/net/tun", O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (tap < 0) return die("/dev/net/tun");
  struct ifreq make = {.ifr_flags = IFF_TAP | IFF_NO_PI};
  strncpy(make.ifr_name, argv[2], IFNAMSIZ - 1);
  if (ioctl(tap, TUNSETIFF, &make)) return die("TUNSETIFF");
  strncpy(r.ifr_name, argv[2], IFNAMSIZ - 1);
  r.ifr_hwaddr.sa_family = ARPHRD_ETHER;
  if (ioctl(s, SIOCSIFHWADDR, &r)) return die("SIOCSIFHWADDR");
  if (fcntl(1, F_SETFL, O_NONBLOCK)) return die("stdout");
  return relay(tap);
}
