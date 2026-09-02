#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  const char *log = getenv("STUB_GROK_LOG");
  if (log && *log) {
    FILE *f = fopen(log, "a");
    if (f) { fputc('[', f); for (int i = 1; i < argc; i += 1) fprintf(f, "%s\"%s\"", i > 1 ? "," : "", argv[i]); fputs("]\n", f); fclose(f); }
  }
  const char *version = getenv("STUB_GROK_VERSION"); if (!version || !*version) version = "1.0.4";
  const char *build = getenv("STUB_GROK_BUILD"); if (!build || !*build) build = "d846eb93d94d";
  if (argc >= 2 && strcmp(argv[1], "--version") == 0) { printf("grok %s (%s) [stable]\n", version, build); return 0; }
  if (argc >= 2 && strcmp(argv[1], "--help") == 0) {
    const char *flags = getenv("STUB_GROK_HELP_FLAGS");   /* space-separated; defaults to the 1.0.4 profile */
    if (!flags || !*flags) flags = "--cwd --max-turns --model --no-memory --no-subagents --output-format --permission-mode --prompt-file --reasoning-effort --sandbox --session-id --single";
    printf("Usage: grok [OPTIONS]\n\nOptions:\n");
    char buffer[1024]; strncpy(buffer, flags, sizeof buffer - 1); buffer[sizeof buffer - 1] = '\0';
    for (char *tok = strtok(buffer, " "); tok; tok = strtok(NULL, " ")) printf("      %s <VALUE>\n          doc\n", tok);
    return 0;
  }
  return 2;
}
