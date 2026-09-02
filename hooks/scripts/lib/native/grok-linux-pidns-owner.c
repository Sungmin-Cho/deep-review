#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#define OWNER_STACK_SIZE (1024U * 1024U)

/* Owner-only stdout carries the JS-authoritative "containment_ready" and
 * "termination_report" handshakes. Provider stdout/stderr are routed to the
 * runner through owner stderr. The JS adapter binds owner_id, generation and
 * observed_at to the retained owner record. */
static void emit_containment_ready(void) {
  fputs("{\"protocol_version\":\"1.0\",\"handshake\":\"containment_ready\","
        "\"containment_ready\":true,\"mechanism\":\"pid-namespace\"}\n",
        stdout);
  fflush(stdout);
}

static void emit_termination_report(void) {
  fputs("{\"protocol_version\":\"1.0\",\"handshake\":\"termination_report\","
        "\"live_members\":0,\"member_pids\":[]}\n",
        stdout);
  fflush(stdout);
}

static int write_all(int fd, const char *buffer, size_t length) {
  while (length > 0U) {
    const ssize_t written = write(fd, buffer, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (written == 0) {
      errno = EIO;
      return -1;
    }
    buffer += (size_t)written;
    length -= (size_t)written;
  }
  return 0;
}

static int connect_provider_stdio(void) {
  const int provider_input_fd = fcntl(STDIN_FILENO, F_DUPFD_CLOEXEC, 3);
  if (provider_input_fd < 0) return -1;
  const int provider_output_fd = fcntl(STDERR_FILENO, F_DUPFD_CLOEXEC, 3);
  if (provider_output_fd < 0) {
    const int saved_errno = errno;
    close(provider_input_fd);
    errno = saved_errno;
    return -1;
  }

  if (dup2(provider_input_fd, STDIN_FILENO) < 0
      || dup2(provider_output_fd, STDOUT_FILENO) < 0
      || dup2(provider_output_fd, STDERR_FILENO) < 0) {
    const int saved_errno = errno;
    close(provider_input_fd);
    close(provider_output_fd);
    errno = saved_errno;
    return -1;
  }
  close(provider_input_fd);
  close(provider_output_fd);
  return 0;
}

static int drain_preflight_control(void) {
  char discard[256];
  for (;;) {
    const ssize_t received = read(STDIN_FILENO, discard, sizeof(discard));
    if (received > 0) continue;
    if (received == 0) return 0;
    if (received < 0 && errno == EINTR) continue;
    return -1;
  }
}

static int write_proc_file(pid_t pid, const char *name, const char *value) {
  char path[128];
  const int path_length = snprintf(path, sizeof(path), "/proc/%ld/%s", (long)pid, name);
  if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
    errno = ENAMETOOLONG;
    return -1;
  }

  const int fd = open(path, O_WRONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  const int result = write_all(fd, value, strlen(value));
  const int saved_errno = errno;
  if (close(fd) < 0 && result == 0) return -1;
  errno = saved_errno;
  return result;
}

static int configure_user_namespace(pid_t init_pid, uid_t uid, gid_t gid) {
  char mapping[96];

  if (write_proc_file(init_pid, "setgroups", "deny\n") < 0 && errno != ENOENT) {
    return -1;
  }
  const int uid_length = snprintf(mapping, sizeof(mapping), "0 %lu 1\n", (unsigned long)uid);
  if (uid_length < 0 || (size_t)uid_length >= sizeof(mapping)
      || write_proc_file(init_pid, "uid_map", mapping) < 0) {
    return -1;
  }
  const int gid_length = snprintf(mapping, sizeof(mapping), "0 %lu 1\n", (unsigned long)gid);
  if (gid_length < 0 || (size_t)gid_length >= sizeof(mapping)
      || write_proc_file(init_pid, "gid_map", mapping) < 0) {
    return -1;
  }
  return 0;
}

struct owner_context {
  int gate_fd;
  int gate_write_fd;
  int armed_fd;
  int armed_read_fd;
  int command_argc;
  char **command_argv;
};

static int await_gate_byte(int fd, char expected) {
  char byte = '\0';
  ssize_t received;
  do {
    received = read(fd, &byte, 1U);
  } while (received < 0 && errno == EINTR);
  return received == 1 && byte == expected ? 0 : -1;
}

static int await_parent_gate(int fd) {
  return await_gate_byte(fd, 'R');
}

static int await_owner_armed(int fd) {
  return await_gate_byte(fd, 'A');
}

static int exit_code_from_status(int status) {
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 125;
}

/* This clone child is PID 1 in the new namespace. It is therefore the reaper
 * for every descendant, including double-forked, setsid and reparented work. */
static int namespace_init(void *opaque) {
  struct owner_context *context = opaque;
  close(context->gate_write_fd);
  close(context->armed_read_fd);
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) {
    perror("grok-linux-pidns-owner: PR_SET_PDEATHSIG");
    return 125;
  }
  if (write_all(context->armed_fd, "A", 1U) < 0) {
    perror("grok-linux-pidns-owner: arm parent-death teardown");
    return 125;
  }
  close(context->armed_fd);
  if (await_parent_gate(context->gate_fd) < 0) {
    perror("grok-linux-pidns-owner: namespace gate");
    return 125;
  }
  close(context->gate_fd);
  emit_containment_ready();

  if (context->command_argc == 0) {
    if (drain_preflight_control() < 0) {
      perror("grok-linux-pidns-owner: preflight control read");
      return 125;
    }
    emit_termination_report();
    return 0;
  }

  const pid_t provider_pid = fork();
  if (provider_pid < 0) {
    perror("grok-linux-pidns-owner: fork");
    emit_termination_report();
    return 125;
  }
  if (provider_pid == 0) {
    if (connect_provider_stdio() < 0) {
      perror("grok-linux-pidns-owner: connect provider stdio");
      _exit(127);
    }
    execvp(context->command_argv[0], context->command_argv);
    perror("grok-linux-pidns-owner: execvp");
    _exit(127);
  }

  int provider_status = 125 << 8;
  int provider_reaped = 0;
  for (;;) {
    int status = 0;
    const pid_t reaped = waitpid(-1, &status, 0);
    if (reaped > 0) {
      if (reaped == provider_pid) {
        provider_status = status;
        provider_reaped = 1;
      }
      continue;
    }
    if (reaped < 0 && errno == EINTR) continue;
    if (reaped < 0 && errno == ECHILD) break;
    /* An unexpected waitpid error is not a zero-member proof. Withhold the
     * termination report so the JS adapter fails the lifecycle closed. */
    perror("grok-linux-pidns-owner: waitpid");
    return 125;
  }

  /* waitpid(-1) == ECHILD at namespace PID 1 is the namespace-member-set
   * zero proof: no descendant remains to be reaped or to escape containment. */
  emit_termination_report();
  return provider_reaped ? exit_code_from_status(provider_status) : 125;
}

static int wait_for_init(pid_t init_pid) {
  int status = 0;
  pid_t waited;
  do {
    waited = waitpid(init_pid, &status, 0);
  } while (waited < 0 && errno == EINTR);
  if (waited != init_pid) return 125;
  return exit_code_from_status(status);
}

struct owner_arguments {
  pid_t parent_pid;      /* 0 when --parent-pid was not given */
  int command_argc;
  char **command_argv;   /* NULL in preflight mode */
};

/* Grammar: --own-grok-tree [--parent-pid <pid>] [-- command [args...]].
 * Preflight mode is the absence of a "--" command operand. Every violation
 * is usage (64): missing value, non-decimal, zero, leading zero, sign,
 * overflow, duplicate flag, unknown option, a bare "--" with no command. */
static int parse_parent_pid(const char *text, pid_t *out) {
  if (text == NULL || *text == '\0' || *text == '0' /* leading zero or zero */ || *text == '+' || *text == '-') return -1;
  for (const char *p = text; *p != '\0'; p += 1) if (*p < '0' || *p > '9') return -1;
  errno = 0;
  char *end = NULL;
  const long value = strtol(text, &end, 10);
  if (errno == ERANGE || end == NULL || *end != '\0' || value <= 0 || value > INT32_MAX) return -1;
  *out = (pid_t)value;
  return 0;
}

static int parse_owner_arguments(int argc, char **argv, struct owner_arguments *out) {
  memset(out, 0, sizeof(*out));
  if (argc < 2 || strcmp(argv[1], "--own-grok-tree") != 0) return -1;
  int have_parent = 0;
  for (int index = 2; index < argc; index += 1) {
    if (strcmp(argv[index], "--") == 0) {
      if (index + 1 >= argc) return -1;             /* bare separator */
      out->command_argc = argc - index - 1;
      out->command_argv = &argv[index + 1];
      return 0;
    }
    if (strcmp(argv[index], "--parent-pid") == 0) {
      if (have_parent) return -1;                   /* duplicate flag */
      if (index + 1 >= argc || parse_parent_pid(argv[index + 1], &out->parent_pid) < 0) return -1;
      have_parent = 1;
      index += 1;
      continue;
    }
    return -1;                                      /* unknown option before "--" */
  }
  return 0;                                         /* preflight: no command operand */
}

int main(int argc, char **argv) {
  struct owner_arguments arguments;
  if (parse_owner_arguments(argc, argv, &arguments) < 0) {
    fputs("usage: grok-linux-pidns-owner --own-grok-tree [--parent-pid <pid>] [-- command [args...]]\n", stderr);
    return 64;
  }
  if (arguments.parent_pid > 0) {
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0) {
      perror("grok-linux-pidns-owner: PR_SET_PDEATHSIG (leash)");
      return 125;
    }
    if (getppid() != arguments.parent_pid) {
      fputs("grok-linux-pidns-owner: leash parent is already gone\n", stderr);
      return 125;
    }
  }

  int gate[2];
  int armed[2];
  if (pipe(gate) < 0) {
    perror("grok-linux-pidns-owner: pipe");
    return 125;
  }
  if (pipe(armed) < 0) {
    perror("grok-linux-pidns-owner: armed pipe");
    close(gate[0]);
    close(gate[1]);
    return 125;
  }

  void *stack = malloc(OWNER_STACK_SIZE);
  if (stack == NULL) {
    perror("grok-linux-pidns-owner: malloc");
    close(gate[0]);
    close(gate[1]);
    close(armed[0]);
    close(armed[1]);
    return 125;
  }

  struct owner_context context = {
    .gate_fd = gate[0],
    .gate_write_fd = gate[1],
    .armed_fd = armed[1],
    .armed_read_fd = armed[0],
    .command_argc = arguments.command_argc,
    .command_argv = arguments.command_argv,
  };
  int clone_flags = CLONE_NEWPID | SIGCHLD;
  const int unprivileged = geteuid() != 0;
  if (unprivileged) clone_flags |= CLONE_NEWUSER;

  const pid_t init_pid = clone(
    namespace_init,
    (char *)stack + OWNER_STACK_SIZE,
    clone_flags,
    &context
  );
  close(gate[0]);
  close(armed[1]);
  if (init_pid < 0) {
    perror("grok-linux-pidns-owner: clone");
    close(gate[1]);
    close(armed[0]);
    free(stack);
    return 125;
  }

  if (await_owner_armed(armed[0]) < 0) {
    perror("grok-linux-pidns-owner: owner did not arm parent-death teardown");
    close(armed[0]);
    close(gate[1]);
    kill(init_pid, SIGKILL);
    (void)wait_for_init(init_pid);
    free(stack);
    return 125;
  }
  close(armed[0]);
  if (unprivileged && configure_user_namespace(init_pid, geteuid(), getegid()) < 0) {
    perror("grok-linux-pidns-owner: user namespace map");
    close(gate[1]);
    kill(init_pid, SIGKILL);
    (void)wait_for_init(init_pid);
    free(stack);
    return 125;
  }
  if (write_all(gate[1], "R", 1U) < 0) {
    perror("grok-linux-pidns-owner: release namespace init");
    close(gate[1]);
    kill(init_pid, SIGKILL);
    (void)wait_for_init(init_pid);
    free(stack);
    return 125;
  }
  close(gate[1]);

  const int result = wait_for_init(init_pid);
  free(stack);
  return result;
}
