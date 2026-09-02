#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#ifdef _WIN32
#include <windows.h>
#define STUB_SLEEP(ms) Sleep(ms)
#else
#include <unistd.h>
#define STUB_SLEEP(ms) usleep((ms) * 1000)
#endif

/* Test stub for the deep-review owner helpers. Speaks the two-line control
 * protocol on stdout, writes "provider output" on stderr, never spawns. It
 * parses exactly the E2d grammar so the argv matrix can drive it too. */

static const char *env_or(const char *name, const char *fallback) {
  const char *value = getenv(name);
  return value && *value ? value : fallback;
}

static int usage(void) {
  fputs("usage: stub-owner --own-grok-tree [--parent-pid <pid>] [-- command [args...]]\n", stderr);
  return 64;
}

static int parse_pid(const char *text, unsigned long *out) {
  if (!text || !*text || text[0] == '0' || text[0] == '+' || text[0] == '-') return 0;
  for (const char *p = text; *p; p += 1) if (*p < '0' || *p > '9') return 0;
  errno = 0;
  char *end = NULL;
  unsigned long value = strtoul(text, &end, 10);
  if (errno == ERANGE || *end != '\0' || value == 0 || value > 4194304UL) return 0;
  *out = value;
  return 1;
}

int main(int argc, char **argv) {
  if (argc < 2 || strcmp(argv[1], "--own-grok-tree") != 0) return usage();
  int have_parent = 0, command_index = -1;
  unsigned long parent = 0;
  for (int i = 2; i < argc; i += 1) {
    if (strcmp(argv[i], "--") == 0) { if (i + 1 >= argc) return usage(); command_index = i + 1; break; }
    if (strcmp(argv[i], "--parent-pid") == 0) {
      if (have_parent || i + 1 >= argc || !parse_pid(argv[i + 1], &parent)) return usage();
      have_parent = 1; i += 1; continue;
    }
    return usage();
  }
  setvbuf(stdout, NULL, _IONBF, 0);
  setvbuf(stderr, NULL, _IONBF, 0);
  const char *fault = env_or("STUB_FAULT", "");
#ifdef _WIN32
  const char *mechanism = env_or("STUB_MECHANISM", "job-object");
#else
  const char *mechanism = env_or("STUB_MECHANISM", "pid-namespace");
#endif
  const char *eol = strcmp(fault, "crlf") == 0 ? "\r\n" : "\n";
  if (strcmp(fault, "hang") == 0) { STUB_SLEEP(30000); return 0; }
  if (strcmp(fault, "no_ready") != 0) {
    printf("{\"protocol_version\":\"1.0\",\"handshake\":\"containment_ready\",\"containment_ready\":true,\"mechanism\":\"%s\"}%s",
           strcmp(fault, "wrong_mechanism") == 0 ? "job-object-wrong" : mechanism, eol);
    fflush(stdout);
  }
  if (strcmp(fault, "hang_after_ready") == 0) { STUB_SLEEP(30000); return 0; }
  if (strcmp(fault, "extra_line") == 0) { printf("{\"protocol_version\":\"1.0\",\"handshake\":\"extra\"}%s", eol); fflush(stdout); }
  if (command_index < 0) { char buffer[256]; while (fgets(buffer, sizeof buffer, stdin)) {} }
  else {
    const char *output = env_or("STUB_PROVIDER_OUTPUT", "");
    if (*output) { fputs(output, stderr); fputs("\n", stderr); fflush(stderr); }
    if (strcmp(fault, "overflow") == 0) {
      char block[4096];
      memset(block, 'x', sizeof block);
      for (int i = 0; i < 5120; i += 1) fwrite(block, 1, sizeof block, stderr);
      fflush(stderr);
    }
  }
  if (strcmp(fault, "exit_125_no_report") == 0) return 125;
  if (strcmp(fault, "report_not_last") == 0) {
    printf("{\"protocol_version\":\"1.0\",\"handshake\":\"termination_report\",\"live_members\":0,\"member_pids\":[]}%s", eol);
    printf("{\"protocol_version\":\"1.0\",\"handshake\":\"containment_ready\",\"containment_ready\":true,\"mechanism\":\"%s\"}%s", mechanism, eol);
    fflush(stdout); return 0;
  }
  printf("{\"protocol_version\":\"1.0\",\"handshake\":\"termination_report\",\"live_members\":0,\"member_pids\":[]}%s", eol);
  fflush(stdout);
  if (strcmp(fault, "exit_125_with_report") == 0) return 125;
  if (strcmp(fault, "exit_127_with_report") == 0) return 127;
  return atoi(env_or("STUB_EXIT", "0"));
}
