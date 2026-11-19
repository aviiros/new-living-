/* li-runner: starts a program inside a Windows Job Object that hard-caps CPU use, lowers its priority,
   and prints real CPU / memory numbers (one JSON line per second) to stdout.
   usage: li-runner <cpuPercent 5-100> <program> [args...]
   stdin commands (one per line): pause | resume | cap <percent> | quit. When stdin closes, the program is stopped. */
#include <windows.h>
#include <psapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { DWORD ControlFlags; union { DWORD CpuRate; DWORD Weight; struct { WORD MinRate; WORD MaxRate; } d; } u; } CPURATE;
typedef LONG (NTAPI *NtProc)(HANDLE);
static HANDLE job, proc;
static NtProc suspendP, resumeP;

static void setcap(int pct) {
  CPURATE c; ZeroMemory(&c, sizeof c);
  if (pct < 5) pct = 5; if (pct > 100) pct = 100;
  c.ControlFlags = 0x1 | 0x4; /* ENABLE | HARD_CAP */
  c.u.CpuRate = pct * 100;
  SetInformationJobObject(job, (JOBOBJECTINFOCLASS)15, &c, sizeof c);
}
static DWORD WINAPI reader(LPVOID p) {
  char line[128]; (void)p;
  while (fgets(line, sizeof line, stdin)) {
    if (!strncmp(line, "pause", 5) && suspendP) suspendP(proc);
    else if (!strncmp(line, "resume", 6) && resumeP) resumeP(proc);
    else if (!strncmp(line, "cap ", 4)) setcap(atoi(line + 4));
    else if (!strncmp(line, "quit", 4)) break;
  }
  ExitProcess(0); /* closing the job kills the program */
  return 0;
}
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  int pct = atoi(argv[1]);
  char cmd[32768]; cmd[0] = 0;
  for (int i = 2; i < argc; i++) { if (i > 2) strcat(cmd, " "); strcat(cmd, "\""); strcat(cmd, argv[i]); strcat(cmd, "\""); }
  HMODULE nt = GetModuleHandleA("ntdll.dll");
  suspendP = (NtProc)GetProcAddress(nt, "NtSuspendProcess"); resumeP = (NtProc)GetProcAddress(nt, "NtResumeProcess");
  job = CreateJobObjectA(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li; ZeroMemory(&li, sizeof li);
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof li);
  setcap(pct);
  SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
  HANDLE nul = CreateFileA("NUL", GENERIC_WRITE, FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL);
  STARTUPINFOA si; ZeroMemory(&si, sizeof si); si.cb = sizeof si; si.dwFlags = STARTF_USESTDHANDLES;
  si.hStdOutput = nul; si.hStdError = nul; si.hStdInput = INVALID_HANDLE_VALUE;
  PROCESS_INFORMATION pi;
  if (!CreateProcessA(NULL, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED | CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS, NULL, NULL, &si, &pi)) { printf("{\"error\":\"start %lu\"}\n", GetLastError()); return 3; }
  proc = pi.hProcess;
  if (!AssignProcessToJobObject(job, proc)) { printf("{\"error\":\"job %lu\"}\n", GetLastError()); TerminateProcess(proc, 1); return 4; }
  ResumeThread(pi.hThread);
  SYSTEM_INFO sys; GetSystemInfo(&sys); int ncpu = sys.dwNumberOfProcessors;
  CreateThread(NULL, 0, reader, NULL, 0, NULL);
  printf("{\"started\":1,\"ncpu\":%d}\n", ncpu); fflush(stdout);
  ULONGLONG lastCpu = 0, lastT = GetTickCount64();
  for (;;) {
    if (WaitForSingleObject(proc, 1000) == WAIT_OBJECT_0) { DWORD code = 0; GetExitCodeProcess(proc, &code); printf("{\"exit\":%lu}\n", code); fflush(stdout); return 0; }
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION ai; PROCESS_MEMORY_COUNTERS m;
    QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &ai, sizeof ai, NULL);
    ZeroMemory(&m, sizeof m); GetProcessMemoryInfo(proc, &m, sizeof m);
    ULONGLONG cpu = ai.TotalUserTime.QuadPart + ai.TotalKernelTime.QuadPart, now = GetTickCount64();
    double pctNow = (now > lastT) ? ((double)(cpu - lastCpu) / 10000.0) / (double)(now - lastT) / ncpu * 100.0 : 0;
    lastCpu = cpu; lastT = now;
    printf("{\"cpu\":%.1f,\"ws\":%.0f,\"peak\":%.0f}\n", pctNow, m.WorkingSetSize / 1048576.0, m.PeakWorkingSetSize / 1048576.0); fflush(stdout);
  }
}
