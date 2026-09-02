#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif

#include <windows.h>

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* Owner-only stdout carries the JS-authoritative "containment_ready" and
 * "termination_report" handshakes. Provider stdout/stderr are routed to the
 * runner through owner stderr. The JS adapter binds owner_id, generation and
 * observed_at to the retained owner record. */
static void emit_containment_ready(void) {
  fputs("{\"protocol_version\":\"1.0\",\"handshake\":\"containment_ready\","
        "\"containment_ready\":true,\"mechanism\":\"job-object\"}\n",
        stdout);
  fflush(stdout);
}

static void emit_termination_report(void) {
  fputs("{\"protocol_version\":\"1.0\",\"handshake\":\"termination_report\","
        "\"live_members\":0,\"member_pids\":[]}\n",
        stdout);
  fflush(stdout);
}

static wchar_t *build_command_line(int argc, wchar_t **argv) {
  size_t capacity = 1U;
  for (int index = 0; index < argc; index += 1) {
    const size_t length = wcslen(argv[index]);
    if (length > (SIZE_MAX - capacity - 3U) / 2U) return NULL;
    capacity += (2U * length) + 3U;
  }

  wchar_t *command_line = calloc(capacity, sizeof(*command_line));
  if (command_line == NULL) return NULL;
  wchar_t *cursor = command_line;

  for (int index = 0; index < argc; index += 1) {
    if (index > 0) *cursor++ = L' ';
    *cursor++ = L'"';
    const wchar_t *source = argv[index];
    for (;;) {
      size_t backslashes = 0U;
      while (*source == L'\\') {
        backslashes += 1U;
        source += 1;
      }
      if (*source == L'"') {
        for (size_t count = 0; count < (2U * backslashes) + 1U; count += 1U) {
          *cursor++ = L'\\';
        }
        *cursor++ = *source++;
        continue;
      }
      if (*source == L'\0') {
        for (size_t count = 0; count < 2U * backslashes; count += 1U) {
          *cursor++ = L'\\';
        }
        break;
      }
      for (size_t count = 0; count < backslashes; count += 1U) {
        *cursor++ = L'\\';
      }
      *cursor++ = *source++;
    }
    *cursor++ = L'"';
  }
  *cursor = L'\0';
  return command_line;
}

static int query_job_members(HANDLE job, DWORD *assigned, DWORD *listed) {
  DWORD capacity = 16U;
  for (int attempt = 0; attempt < 16; attempt += 1) {
    const SIZE_T bytes = offsetof(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList)
      + ((SIZE_T)capacity * sizeof(ULONG_PTR));
    if (bytes > MAXDWORD) return 0;
    JOBOBJECT_BASIC_PROCESS_ID_LIST *members = calloc(1U, (size_t)bytes);
    if (members == NULL) return 0;

    const BOOL queried = QueryInformationJobObject(
      job,
      JobObjectBasicProcessIdList,
      members,
      (DWORD)bytes,
      NULL
    );
    const DWORD error = GetLastError();
    const DWORD observed_assigned = members->NumberOfAssignedProcesses;
    const DWORD observed_listed = members->NumberOfProcessIdsInList;
    free(members);
    if (queried) {
      *assigned = observed_assigned;
      *listed = observed_listed;
      return 1;
    }
    if (error != ERROR_MORE_DATA) return 0;
    capacity = observed_assigned > capacity ? observed_assigned + 8U : capacity * 2U;
  }
  return 0;
}

static int wait_for_empty_job(HANDLE job) {
  for (DWORD elapsed = 0U; elapsed <= 1000U; elapsed += 10U) {
    DWORD assigned = 0U;
    DWORD listed = 0U;
    if (!query_job_members(job, &assigned, &listed)) return 0;
    if (assigned == 0U && listed == 0U) return 1;
    Sleep(10U);
  }
  return 0;
}

struct provider_stdio {
  HANDLE handles[2];
  LPPROC_THREAD_ATTRIBUTE_LIST attributes;
  int attributes_initialized;
};

static void close_provider_stdio(struct provider_stdio *provider_stdio) {
  if (provider_stdio->attributes != NULL) {
    if (provider_stdio->attributes_initialized) {
      DeleteProcThreadAttributeList(provider_stdio->attributes);
    }
    free(provider_stdio->attributes);
  }
  for (size_t index = 0U; index < 2U; index += 1U) {
    if (provider_stdio->handles[index] != NULL) CloseHandle(provider_stdio->handles[index]);
  }
  ZeroMemory(provider_stdio, sizeof(*provider_stdio));
}

static int duplicate_inheritable_standard_handle(DWORD standard_handle, HANDLE *destination) {
  const HANDLE source = GetStdHandle(standard_handle);
  if (source == NULL || source == INVALID_HANDLE_VALUE) {
    SetLastError(ERROR_INVALID_HANDLE);
    return 0;
  }
  return DuplicateHandle(
    GetCurrentProcess(),
    source,
    GetCurrentProcess(),
    destination,
    0U,
    TRUE,
    DUPLICATE_SAME_ACCESS
  ) != 0;
}

static int prepare_provider_stdio(
  STARTUPINFOEXW *startup,
  struct provider_stdio *provider_stdio
) {
  ZeroMemory(startup, sizeof(*startup));
  ZeroMemory(provider_stdio, sizeof(*provider_stdio));
  startup->StartupInfo.cb = (DWORD)sizeof(*startup);

  if (!duplicate_inheritable_standard_handle(STD_INPUT_HANDLE, &provider_stdio->handles[0])
      || !duplicate_inheritable_standard_handle(STD_ERROR_HANDLE, &provider_stdio->handles[1])) {
    goto fail;
  }

  SIZE_T attribute_bytes = 0U;
  if (InitializeProcThreadAttributeList(NULL, 1U, 0U, &attribute_bytes)
      || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
    goto fail;
  }
  provider_stdio->attributes = malloc((size_t)attribute_bytes);
  if (provider_stdio->attributes == NULL) {
    SetLastError(ERROR_NOT_ENOUGH_MEMORY);
    goto fail;
  }
  if (!InitializeProcThreadAttributeList(
    provider_stdio->attributes,
    1U,
    0U,
    &attribute_bytes
  )) {
    goto fail;
  }
  provider_stdio->attributes_initialized = 1;
  if (!UpdateProcThreadAttribute(
    provider_stdio->attributes,
    0U,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    provider_stdio->handles,
    sizeof(provider_stdio->handles),
    NULL,
    NULL
  )) {
    goto fail;
  }

  startup->lpAttributeList = provider_stdio->attributes;
  startup->StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
  startup->StartupInfo.hStdInput = provider_stdio->handles[0];
  startup->StartupInfo.hStdOutput = provider_stdio->handles[1];
  startup->StartupInfo.hStdError = provider_stdio->handles[1];
  return 1;

fail: {
    const DWORD error = GetLastError();
    close_provider_stdio(provider_stdio);
    SetLastError(error);
    return 0;
  }
}

static int terminate_process_and_wait(PROCESS_INFORMATION *process, UINT exit_code) {
  if (!TerminateProcess(process->hProcess, exit_code)) return 0;
  return WaitForSingleObject(process->hProcess, INFINITE) == WAIT_OBJECT_0;
}

static void close_process(PROCESS_INFORMATION *process) {
  if (process->hThread != NULL) CloseHandle(process->hThread);
  if (process->hProcess != NULL) CloseHandle(process->hProcess);
  process->hThread = NULL;
  process->hProcess = NULL;
}

struct owner_arguments {
  DWORD parent_pid;        /* 0 when --parent-pid was not given */
  int command_argc;
  wchar_t **command_argv;  /* NULL in preflight mode */
};

/* Grammar: --own-grok-tree [--parent-pid <pid>] [-- command [args...]].
 * Preflight mode is the absence of a "--" command operand. Every violation
 * is usage (64): missing value, non-decimal, zero, leading zero, sign,
 * overflow, duplicate flag, unknown option, a bare "--" with no command. */
static int parse_parent_pid(const wchar_t *text, DWORD *out) {
  if (text == NULL || *text == L'\0' || *text == L'0' /* leading zero or zero */ || *text == L'+' || *text == L'-') return -1;
  for (const wchar_t *p = text; *p != L'\0'; p += 1) if (*p < L'0' || *p > L'9') return -1;
  errno = 0;
  wchar_t *end = NULL;
  const unsigned long value = wcstoul(text, &end, 10);
  if (errno == ERANGE || end == NULL || *end != L'\0' || value == 0UL || value > 0xFFFFFFFEUL) return -1;
  *out = (DWORD)value;
  return 0;
}

static int parse_owner_arguments(int argc, wchar_t **argv, struct owner_arguments *out) {
  memset(out, 0, sizeof(*out));
  if (argc < 2 || wcscmp(argv[1], L"--own-grok-tree") != 0) return -1;
  int have_parent = 0;
  for (int index = 2; index < argc; index += 1) {
    if (wcscmp(argv[index], L"--") == 0) {
      if (index + 1 >= argc) return -1;             /* bare separator */
      out->command_argc = argc - index - 1;
      out->command_argv = &argv[index + 1];
      return 0;
    }
    if (wcscmp(argv[index], L"--parent-pid") == 0) {
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

int wmain(int argc, wchar_t **argv) {
  struct owner_arguments arguments;
  if (parse_owner_arguments(argc, argv, &arguments) < 0) {
    fputws(L"usage: grok-win32-job-owner --own-grok-tree [--parent-pid <pid>] [-- command [args...]]\n", stderr);
    return 64;
  }

  HANDLE parent = NULL;
  if (arguments.parent_pid != 0U) {
    parent = OpenProcess(SYNCHRONIZE, FALSE, arguments.parent_pid);
    if (parent == NULL) {
      fwprintf(stderr, L"grok-win32-job-owner: OpenProcess(parent) failed: %lu\n", GetLastError());
      return 125;
    }
  }

  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (job == NULL) {
    fwprintf(stderr, L"grok-win32-job-owner: CreateJobObjectW failed: %lu\n", GetLastError());
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  limits.BasicLimitInformation.LimitFlags &= ~(
    JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
  );
  if (!SetInformationJobObject(
    job,
    JobObjectExtendedLimitInformation,
    &limits,
    (DWORD)sizeof(limits)
  )) {
    fwprintf(stderr, L"grok-win32-job-owner: SetInformationJobObject failed: %lu\n", GetLastError());
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  if (arguments.command_argv == NULL) {
    emit_containment_ready();
    char discard[256];
    DWORD received = 0U;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), discard, (DWORD)sizeof(discard), &received, NULL)
           && received > 0U) {
      /* A preflight-only owner remains retained until its control pipe closes. */
    }
    if (!wait_for_empty_job(job)) {
      CloseHandle(job);
      if (parent != NULL) CloseHandle(parent);
      return 125;
    }
    emit_termination_report();
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 0;
  }

  wchar_t *command_line = build_command_line(arguments.command_argc, arguments.command_argv);
  if (command_line == NULL) {
    fputws(L"grok-win32-job-owner: command-line allocation failed\n", stderr);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  STARTUPINFOEXW startup;
  PROCESS_INFORMATION process;
  struct provider_stdio provider_stdio;
  ZeroMemory(&process, sizeof(process));
  if (!prepare_provider_stdio(&startup, &provider_stdio)) {
    fwprintf(stderr, L"grok-win32-job-owner: prepare provider stdio failed: %lu\n", GetLastError());
    free(command_line);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  const BOOL created = CreateProcessW(
    NULL,
    command_line,
    NULL,
    NULL,
    TRUE,
    CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    NULL,
    NULL,
    &startup.StartupInfo,
    &process
  );
  const DWORD create_error = created ? ERROR_SUCCESS : GetLastError();
  close_provider_stdio(&provider_stdio);
  free(command_line);
  if (!created) {
    fwprintf(stderr, L"grok-win32-job-owner: CreateProcessW failed: %lu\n", create_error);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  if (!AssignProcessToJobObject(job, process.hProcess)) {
    fwprintf(stderr, L"grok-win32-job-owner: AssignProcessToJobObject failed: %lu\n", GetLastError());
    if (!terminate_process_and_wait(&process, 125U)) {
      fwprintf(stderr, L"grok-win32-job-owner: suspended process teardown failed: %lu\n", GetLastError());
    }
    close_process(&process);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  /* Assignment is complete while the child is still CREATE_SUSPENDED. */
  emit_containment_ready();
  if (ResumeThread(process.hThread) == (DWORD)-1) {
    fwprintf(stderr, L"grok-win32-job-owner: ResumeThread failed: %lu\n", GetLastError());
    TerminateJobObject(job, 125U);
    close_process(&process);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  DWORD waited;
  if (parent != NULL) {
    HANDLE wait_handles[2] = { process.hProcess, parent };
    waited = WaitForMultipleObjects(2, wait_handles, FALSE, INFINITE);
    if (waited == WAIT_OBJECT_0 + 1) {
      /* The bridge is gone: nobody will read a report. Tear the tree down. */
      TerminateJobObject(job, 125U);
      (void)wait_for_empty_job(job);
      close_process(&process);
      CloseHandle(job);
      CloseHandle(parent);
      return 125;
    }
  } else {
    waited = WaitForSingleObject(process.hProcess, INFINITE);
  }
  if (waited != WAIT_OBJECT_0) {
    fputws(L"grok-win32-job-owner: process wait failed\n", stderr);
    TerminateJobObject(job, 125U);
    close_process(&process);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  DWORD provider_exit = 125U;
  if (!GetExitCodeProcess(process.hProcess, &provider_exit)) provider_exit = 125U;
  close_process(&process);

  /* Root completion closes the attempt: terminate any retained descendants,
   * then enumerate the Job Object member set until it proves zero members. */
  (void)TerminateJobObject(job, provider_exit == 0U ? 1U : provider_exit);
  if (!wait_for_empty_job(job)) {
    fputws(L"grok-win32-job-owner: JobObjectBasicProcessIdList did not reach zero\n", stderr);
    CloseHandle(job);
    if (parent != NULL) CloseHandle(parent);
    return 125;
  }

  emit_termination_report();
  CloseHandle(job);
  if (parent != NULL) CloseHandle(parent);
  return provider_exit <= 255U ? (int)provider_exit : 125;
}
