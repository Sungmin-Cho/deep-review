#!/usr/bin/env bash
# Build the change_files manifest (JSONL) for the full Stage-1 review target set.
# Uses python3 for correct JSON encoding (all C0 control bytes), rename/copy
# arity + score splitting, and deterministic path-byte sort. NUL-safe.
# Binary *content* is excluded; suspicious-text *metadata* rows and omission
# *diagnostics* are retained (cap-exempt binary_omitted trailer).
#
# Env vars (spec §4.1 — cap the manifest by BOTH, whichever triggers first):
#   OCR_CHANGE_FILES_MAX_ENTRIES  row cap (default 500)
#   OCR_CHANGE_FILES_MAX_BYTES    cumulative serialized-byte cap (default 65536; kept
#                                 well under the agy 198KB body limit). On either cap a
#                                 final {"omitted":N,"truncated":true} trailer is emitted.
set -Eeuo pipefail

repo="."; change_state=""; review_base=""; files_from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) repo="${2:-.}"; shift 2;;
    --change-state) change_state="${2:-}"; shift 2;;
    --review-base) review_base="${2:-}"; shift 2;;
    --files-from-z) files_from="${2:-}"; shift 2;;   # NUL-delimited manual/session paths
    *) echo "build-change-files: unknown arg: $1" >&2; exit 2;;
  esac
done
command -v python3 >/dev/null 2>&1 || { echo "build-change-files: python3 required (change_files omitted)" >&2; exit 4; }
if [ "$change_state" = "clean" ] && [ -z "$review_base" ]; then
  echo "build-change-files: --review-base required for clean state" >&2; exit 2
fi

REPO="$repo" STATE="$change_state" BASE="$review_base" FILES_FROM="$files_from" \
MAX_ENTRIES="${OCR_CHANGE_FILES_MAX_ENTRIES:-500}" \
MAX_BYTES="${OCR_CHANGE_FILES_MAX_BYTES:-65536}" python3 - <<'PY'
import os, json, subprocess, sys, stat, re
repo=os.environ["REPO"]; state=os.environ["STATE"]; base=os.environ.get("BASE","")
ff=os.environ.get("FILES_FROM",""); maxn=int(os.environ.get("MAX_ENTRIES","500"))
# Byte budget (spec §4.1: cap by max bytes AND max entries — whichever triggers first).
# Default 65536 stays well under the agy 198KB body limit so the manifest never blows the
# prompt budget before the diff is appended. Override via OCR_CHANGE_FILES_MAX_BYTES.
maxb=int(os.environ.get("MAX_BYTES","65536"))
def git_z(*args):
    r=subprocess.run(["git","-C",repo,*args],capture_output=True)
    if r.returncode!=0:
        sys.stderr.write("build-change-files: git %s failed: %s\n"%(" ".join(args), r.stderr.decode("utf-8","replace")))
        sys.exit(5)                      # → orchestrator omits change_files + warns
    return [x for x in r.stdout.split(b"\0") if x!=b""]
items={}  # path-bytes -> record dict (later inserts do not override earlier richer ones)
seen=set()  # raw path-bytes; first delivery wins for rows AND builder diagnostics
omitted_binary={}  # raw path-bytes -> builder diagnostic (terminal disposition)
# --- Stage-1 review-target exclusions. CANONICAL SOURCE OF TRUTH: the
# "diff에서 제외" list at review-execution.md SSOT:diff-exclusion-set (the Stage-1
# diff exclusion rule). The two MUST stay textually identical in membership — this
# set and that list are the same target filter (change_files == the exact review
# DIFF target set, spec §4.1), so any path the diff omits must be omitted here
# too; otherwise reviewers see out-of-scope files (vendored/build/generated/lock/
# binary). When you edit one, edit the other to match.
# Applied to the DECODED path so glob/segment matching is on real path text while
# the dict key stays the raw path-bytes (NUL-safety + byte-sort preserved).
import fnmatch, posixpath
EXCLUDE_SEGMENTS={"node_modules","dist","build",".next","target",".venv",
                  "__pycache__",".pytest_cache","vendor",".git"}
EXCLUDE_BASENAME_GLOBS=("*.min.js","*.generated.*","*.lock",".DS_Store")
def is_excluded(path_str):
    # path_str is the surrogateescape-decoded git path (forward-slash separated).
    parts=path_str.split("/")
    if EXCLUDE_SEGMENTS.intersection(parts):  # any path segment is an excluded dir
        return True
    base=parts[-1] if parts else path_str
    return any(fnmatch.fnmatch(base, g) for g in EXCLUDE_BASENAME_GLOBS)
def dec(b): return b.decode("utf-8","surrogateescape")
# Membership copied from hooks/scripts/lib/text-extensions.mjs (source of truth).
# TAXONOMY-CODE-BEGIN
CODE_EXTENSIONS={'.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.rb','.go','.rs','.java','.kt','.kts','.scala','.c','.h','.cc','.cpp','.hpp','.cxx','.cs','.php','.swift','.m','.mm','.sh','.bash','.zsh','.sql','.pl','.pm','.lua','.r','.dart','.ex','.exs','.erl','.clj','.vue','.svelte'}
# TAXONOMY-CODE-END
# TAXONOMY-MARKDOWN-BEGIN
MARKDOWN_EXTENSIONS={'.md','.markdown','.mdx','.rst','.adoc','.asciidoc','.org'}
# TAXONOMY-MARKDOWN-END
# TAXONOMY-DATA-BEGIN
TEXT_DATA_EXTENSIONS={'.json','.jsonc','.yml','.yaml','.toml','.ini','.cfg','.conf','.xml','.html','.htm','.css','.scss','.less','.txt','.csv','.svg','.ps1','.bat','.cmd','.fish','.astro'}
# TAXONOMY-DATA-END
# TAXONOMY-BASENAME-BEGIN
SUSPECT_TEXT_BASENAMES={'Makefile','Dockerfile','Containerfile'}
# TAXONOMY-BASENAME-END
VALID_CLASSIFIERS={'git-numstat','untracked-nul-sniff'}
BINARY_TRAILER_MAX_RECORDS=25
BINARY_TRAILER_MAX_BYTES=4096
DISPLAY_CONTROLS=re.compile('[\u007f\u0080-\u009f\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]')
def escape_display_controls(json_text):
    return DISPLAY_CONTROLS.sub(lambda m: '\\u%04x' % ord(m.group(0)), json_text)
def is_suspect_text_path(decoded_path):
    if not isinstance(decoded_path, str) or len(decoded_path)==0:
        return False
    sep=max(decoded_path.rfind('/'), decoded_path.rfind('\\'))
    basename=decoded_path[sep+1:]
    if basename in SUSPECT_TEXT_BASENAMES:
        return True
    dot=basename.rfind('.')
    if dot<=0:
        return False
    ext=basename[dot:].lower()
    return ext in CODE_EXTENSIONS or ext in MARKDOWN_EXTENSIONS or ext in TEXT_DATA_EXTENSIONS
# Best-effort UNTRACKED-binary detection. `git diff --numstat` (collect_binary below)
# only sees TRACKED diffs, so an untracked/initial/session/non-git path's binary-ness
# is invisible to it — yet Stage-1 excludes binaries (review-execution.md SSOT:diff-exclusion-set). We
# apply the common git heuristic: read the first chunk and treat the file as binary if
# it contains a NUL byte. NUL-safe (operates on raw bytes), python3-only, non-fatal on
# read errors (missing/unreadable path → treated as non-binary, i.e. recorded). 'p' is
# the raw path-bytes; join under the repo so we read the actual working-tree file.
_BIN_SNIFF_BYTES=8192
def looks_binary_untracked(p_bytes):
    try:
        fp=os.path.join(os.fsencode(repo), p_bytes)
        # lstat BEFORE open: a FIFO, socket, device, or symlink to one will block
        # open(fp,"rb") indefinitely. lstat does NOT follow symlinks, so S_ISLNK is
        # also non-regular here. Non-regular files are fail-open (not detected as
        # binary → still recorded); we simply skip the blocking open() call.
        if not stat.S_ISREG(os.lstat(fp).st_mode):
            return False
        with open(fp,"rb") as fh:
            return b"\x00" in fh.read(_BIN_SNIFF_BYTES)
    except Exception:
        return False                       # unreadable → don't drop (fail-open: record it)
def add(rec):  # rec is a dict with bytes 'p' key
    p=rec["p"]
    if p in seen:
        rec.pop("p"); return
    if is_excluded(rec["path"]):           # path-glob/segment excludes (required)
        rec.pop("p"); return               # drop out-of-scope path before recording
    from_numstat=rec["path"] in binary_paths
    from_sniff=(not from_numstat) and rec.get("status") in ("untracked","initial","session","non-git") and looks_binary_untracked(p)
    is_binary=from_numstat or from_sniff
    if is_binary:
        classified_by="git-numstat" if from_numstat else "untracked-nul-sniff"
        suspect=is_suspect_text_path(rec["path"]) or ("old_path" in rec and is_suspect_text_path(rec["old_path"]))
        if suspect:
            rec["is_binary"]=True
            rec["binary_suspect_reason"]="text-extension"
            rec["binary_classified_by"]=classified_by
        else:
            diag={"path":rec["path"]}
            if "old_path" in rec: diag["old_path"]=rec["old_path"]
            if "score" in rec: diag["score"]=rec["score"]
            diag["status"]=rec["status"]
            diag["classified_by"]=classified_by
            diag["omitted_at"]="builder"
            omitted_binary[p]=diag
            seen.add(p)
            rec.pop("p"); return
    if is_binary:
        rec["is_binary"]=True
    seen.add(p)
    items.setdefault(rec.pop("p"), rec)
# Best-effort binary detection: `git diff -z --numstat` emits "-\t-\t" for binary
# blobs. Same -z record model as name-status: a rename/copy row is "added\tdeleted\t"
# (empty path field) followed by two standalone NUL tokens old,new; a normal row is
# one "added\tdeleted\tpath" token. We key on the SURVIVING (new) decoded path, the
# same path parse_name_status records. Failure is non-fatal (binary set stays empty —
# limitation: path-glob excludes still apply, only binary-by-content may slip through).
binary_paths=set()
def collect_binary(*args):
    try:
        r=subprocess.run(["git","-C",repo,*args],capture_output=True)
        if r.returncode!=0: return
        toks=r.stdout.split(b"\0")
        i=0; n=len(toks)
        while i<n:
            if toks[i]==b"": i+=1; continue
            fields=toks[i].split(b"\t",2)
            i+=1
            if len(fields)<3: continue
            added,deleted,pathfield=fields[0],fields[1],fields[2]
            is_bin=(added==b"-" and deleted==b"-")
            if pathfield==b"":                       # rename/copy: next two tokens
                if i+1>=n: break
                new=toks[i+1]; i+=2
                if is_bin: binary_paths.add(dec(new))
            else:
                if is_bin: binary_paths.add(dec(pathfield))
    except Exception:
        pass
def parse_name_status(tokens):
    i=0; n=len(tokens)
    while i<n:
        st=tokens[i].decode("ascii","replace"); i+=1
        letter=st[:1]
        if letter in ("R","C"):
            if i+1>=n: sys.stderr.write("build-change-files: truncated rename/copy record\n"); sys.exit(5)
            old=tokens[i]; new=tokens[i+1]; i+=2
            rec={"p":new,"status":letter,"path":dec(new),"old_path":dec(old)}
            if st[1:]: rec["score"]=st[1:]
            add(rec)
        else:
            if i>=n: sys.stderr.write("build-change-files: truncated status record\n"); sys.exit(5)
            p=tokens[i]; i+=1
            add({"p":p,"status":letter,"path":dec(p)})
# Populate binary_paths from the SAME range before parse_name_status (add() reads it).
if state=="clean":
    collect_binary("diff","-z","--numstat","-M","-C",f"{base}..HEAD")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C",f"{base}..HEAD"))
elif state=="staged":
    collect_binary("diff","-z","--numstat","-M","-C","--cached")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C","--cached"))
elif state=="unstaged":
    collect_binary("diff","-z","--numstat","-M","-C")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C"))
elif state=="mixed":
    collect_binary("diff","-z","--numstat","-M","-C","HEAD")
    parse_name_status(git_z("diff","-z","--name-status","-M","-C","HEAD"))
elif state=="initial":
    for p in git_z("ls-files","-z","--cached","--others","--exclude-standard"):
        add({"p":p,"status":"initial","path":dec(p)})
elif state in ("untracked-only","non-git"): pass
else: sys.stderr.write(f"build-change-files: unknown state {state}\n"); sys.exit(2)
# has_untracked union ONLY for DIRTY working-tree states. `clean` is excluded:
# its effective target is committed `base..HEAD` (incl. the WIP-accepted tracked-only
# path that calls `--change-state clean --review-base <BASE>`), so leftover untracked
# files are NOT part of that diff/target set — unioning them would list out-of-scope
# files (spec §4.1: change_files == the exact review DIFF target set). `initial` keeps
# its own --cached --others enumeration above; `non-git` uses --files-from-z only.
if state in ("staged","unstaged","mixed","untracked-only"):
    for p in git_z("ls-files","-z","--others","--exclude-standard"):
        add({"p":p,"status":"untracked","path":dec(p)})
# manual / session-inferred paths (non-git or session-expansion)
if ff and os.path.exists(ff):
    with open(ff,"rb") as fh:
        for p in fh.read().split(b"\0"):
            if p: add({"p":p,"status":("non-git" if state=="non-git" else "session"),"path":dec(p)})
rows=[items[k] for k in sorted(items)]            # deterministic path-byte sort
# ensure_ascii=True: non-UTF-8 path bytes (surrogateescape) are emitted as \uXXXX,
# keeping the JSONL strictly ASCII/UTF-8 valid (R2 fix — ensure_ascii=False could
# print raw invalid bytes or raise UnicodeEncodeError on lone surrogates).
# Dual cap (spec §4.1): stop at the ROW cap (maxn) OR once the cumulative serialized
# BYTE size would exceed the budget (maxb) — whichever triggers first. With many long
# paths the row cap alone can still exceed the agy 198KB body limit, so the byte budget
# is the real guard. Remaining rows are counted into the {omitted,truncated} trailer.
emitted=0; nbytes=0; past_limit=False
truncated_suspects=[]
for d in rows:
    if not past_limit:
        line=json.dumps(d, ensure_ascii=True)
        add_bytes=len(line.encode("utf-8"))+1            # +1 for the trailing newline
        # Stop BEFORE exceeding either cap. Always allow at least the first row through so a
        # single oversized record still appears rather than yielding a bare trailer.
        if emitted>0 and (emitted>=maxn or nbytes+add_bytes>maxb):
            past_limit=True
        else:
            print(line); emitted+=1; nbytes+=add_bytes
            continue
    if d.get("binary_suspect_reason")=="text-extension" and d.get("binary_classified_by") in VALID_CLASSIFIERS:
        diag={"path":d["path"]}
        if "old_path" in d: diag["old_path"]=d["old_path"]
        if "score" in d: diag["score"]=d["score"]
        diag["status"]=d["status"]
        diag["classified_by"]=d["binary_classified_by"]
        diag["omitted_at"]="serializer"
        truncated_suspects.append(diag)
if emitted<len(rows): print(json.dumps({"omitted":len(rows)-emitted,"truncated":True}))
def by_path(entry):
    # JS string compare is UTF-16 code-unit order. utf-16-be bytes match that
    # lexicographic order; utf-16-le does not (endianness swaps unit bytes).
    # surrogatepass keeps lone surrogates from surrogateescape-decoded
    # invalid UTF-8 paths (strict utf-16-be raises UnicodeEncodeError).
    return entry["path"].encode("utf-16-be", "surrogatepass")
lane=sorted(truncated_suspects, key=by_path)+sorted(omitted_binary.values(), key=by_path)
total=len(lane)
classified_by={"git-numstat":0,"untracked-nul-sniff":0}
omitted_at={"builder":0,"serializer":0}
for entry in lane:
    classified_by[entry["classified_by"]]=classified_by.get(entry["classified_by"],0)+1
    omitted_at[entry["omitted_at"]]=omitted_at.get(entry["omitted_at"],0)+1
listed=[]
if total>0:
    def trailer_line(candidate):
        return escape_display_controls(json.dumps({
            "binary_omitted":total,
            "binary_classified_by":classified_by,
            "binary_omitted_at":omitted_at,
            "binary_records":candidate,
            "binary_records_listed":len(candidate),
            "binary_records_unlisted":total-len(candidate),
        }, separators=(',', ':')))
    for entry in lane:
        if len(listed)>=BINARY_TRAILER_MAX_RECORDS: break
        candidate=listed+[entry]
        if len(trailer_line(candidate).encode("utf-8"))+1>BINARY_TRAILER_MAX_BYTES: break
        listed=candidate
    print(trailer_line(listed))
PY
