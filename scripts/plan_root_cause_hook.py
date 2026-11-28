#!/usr/bin/env python3
"""跨宿主防治标 Stop Hook：方案初稿完成后自动触发最多 1 轮根因与依赖源码核查。

支持两类协议（自动识别 stdin 字段）：
1. Antigravity：`continuationActive` + `terminationReason=NO_TOOL_CALL` -> `{"decision": "continue", "reason": ...}`
2. Claude Code / Codex / Qoder / ZCode / DeepSeek Harness 桥接：`stop_hook_active` -> `{"decision": "block", "reason": ...}`

任意异常 fail-open 返回 `{}`，避免阻塞正常对话。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

MIN_CHAT_PLAN_CHARS = 140
MAX_MANUAL_CHALLENGE_CHARS = 40
LOOP_GUARD_TTL_SECONDS = 600
LOOP_GUARD_MAX_ENTRIES = 64

_CHALLENGE_CHECKS = (
    "这是最小的治本方案吗？请只做 1 轮核查："
    "① 方案里凡因“底层/框架/三方库/旧注释说做不到”而退到上层或绕行的前提，"
    "直接读一手源码（含锁定依赖源码）证伪；"
    "② 核对同状态所有者/同根因下有无遗漏入口；"
    "③ 删掉多余补丁或上层假状态。"
)

CHALLENGE_REASON = (
    f"{_CHALLENGE_CHECKS}"
    "若原方案确实已最小治本，用 1–2 句给出依据直接确认；"
    "若发现更底层根因，直接给出修正后的最小治本方案。"
)

ANTIGRAVITY_CHALLENGE_REASON = (
    f"{_CHALLENGE_CHECKS}"
    "注意：Antigravity 会把本次续跑之前的所有回复自动折叠进 Worked for 轨迹，用户默认只能看到你本轮最后一条回复。"
    "因此无论原方案是否需要修改，你的最终回复都必须自包含完整的核心结论/方案与下一步选项（不可只输出 1–2 句“确认成立”而省略前文正文）："
    "若原方案确实已最小治本，保留完整正文并在末尾附 1–2 句源码核查依据；"
    "若发现更底层根因，直接输出修正后的完整最小治本方案。"
)

READ_OR_SEARCH_TOOLS = frozenset({
    "read_file", "view_file", "grep_search", "find_by_name", "list_dir",
    "mcp_agy-fast_fast_batch_search", "mcp_agy-fast_fast_quick_outline",
    "mcp_agy-fast_fast_read_slices", "batch_search", "quick_outline", "read_slices",
    "Read", "Grep", "Glob", "LS", "View", "Bash", "shell", "shell_command", "exec_command",
})

EDIT_TOOLS = frozenset({
    "edit_file", "write_file", "mcp_agy-fast_fast_apply_edits", "apply_edits",
    "Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch",
})

CMD_TOOLS = frozenset({
    "run_command", "mcp_agy-fast_fast_run_checks", "run_checks",
    "Bash", "shell", "shell_command", "exec_command",
})

QUESTION_TOOLS = frozenset({"ask_question", "AskUserQuestion"})

OPT_OUT_RE = re.compile(
    r"(不用反证|跳过反证|别反证|直接给结论|skip\s+challenge)",
    re.IGNORECASE,
)
MANUAL_CHALLENGE_RE = re.compile(r"最小.{0,4}治本", re.IGNORECASE)
PLAN_INTENT_RE = re.compile(
    r"(方案|怎么修|如何修|修复思路|修复建议|怎么改|如何改|怎么解决|如何解决|"
    r"设计一下|架构设计|优化建议|有什么建议|先别改|先给.{0,6}方案|先出.{0,6}方案|"
    r"\bplan\b|\bproposal\b|how\s+to\s+fix|how\s+should\s+(?:we|i)\s+fix)",
    re.IGNORECASE,
)
BUG_INVESTIGATION_RE = re.compile(
    r"(为什么|怎么回事|原因|排查|定位|卡住|报错|失败|异常|漏扫|不生效|bug|crash|error|timeout)",
    re.IGNORECASE,
)
PROPOSAL_REPLY_RE = re.compile(
    r"(修复方案|改动方案|改造方案|推荐方案|解决思路|建议修改|建议改|分步|步骤|"
    r"改动点|改动路径|落地方案|根因|治本|implementation\s+plan|proposed\s+fix)",
    re.IGNORECASE,
)
ALREADY_EDITED_REPLY_RE = re.compile(
    r"(已完成修改|已修改以下|已更新文件|已提交|退出码\s*[:：]?\s*0|tests?\s+passed)",
    re.IGNORECASE,
)
PLAN_PATH_RE = re.compile(
    r"(^|[\\/])("
    r"docs[\\/]plans[\\/].+\.(md|json)|"
    r"brain[\\/][^\\/]+[\\/][^\\/]*plan[^\\/]*\.md|"
    r"implementation_plan\.md"
    r")$",
    re.IGNORECASE,
)
NON_CODE_DRAFT_PATH_RE = re.compile(
    r"(^|[\\/])\.docs-harness[\\/](inputs|tasks|reports)[\\/]",
    re.IGNORECASE,
)
NON_PLAN_ARTIFACT_NAME_RE = re.compile(
    r"(mockup|wireframe|prototype|visual[_-]?preview|ui[_-]?preview|walkthrough|screenshot)",
    re.IGNORECASE,
)
NON_PLAN_ARTIFACT_SUMMARY_RE = re.compile(
    r"(模拟图|效果图|设计图|原型图|视觉.{0,4}预览|交互原型|生图|mockup|wireframe|visual\s+preview)",
    re.IGNORECASE,
)
HARNESS_PLAN_CREATE_RE = re.compile(r"harness\.py\s+plan\s+create\b", re.IGNORECASE)
USER_REQUEST_BLOCK_RE = re.compile(
    r"<USER_REQUEST>\s*(.*?)\s*</USER_REQUEST>",
    re.DOTALL,
)


def _extract_user_text(raw: str) -> str:
    if not raw:
        return ""
    match = USER_REQUEST_BLOCK_RE.search(raw)
    return match.group(1).strip() if match else raw.strip()


def _unquote_arg(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if len(stripped) >= 2 and stripped[0] in ('"', "[", "{") and stripped[-1] in ('"', "]", "}"):
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            return value
    return value


def _is_plan_path(path_str: str) -> bool:
    return bool(path_str and PLAN_PATH_RE.search(path_str))


def _is_non_code_draft_path(path_str: str) -> bool:
    return bool(path_str and NON_CODE_DRAFT_PATH_RE.search(path_str))


def _is_non_plan_feedback_artifact(path_str: str, meta: dict[str, Any]) -> bool:
    basename = re.split(r"[\\/]", path_str)[-1] if path_str else ""
    summary = str(meta.get("Summary", "") or "")
    return bool(
        (basename and NON_PLAN_ARTIFACT_NAME_RE.search(basename))
        or (summary and NON_PLAN_ARTIFACT_SUMMARY_RE.search(summary))
    )


def _classify_edit_tool(name: str, args: dict[str, Any]) -> tuple[bool, bool]:
    if name in ("write_file", "edit_file", "Write", "Edit", "MultiEdit", "NotebookEdit"):
        raw_path = args.get("Path", args.get("path", args.get("file_path", "")))
        path_val = str(_unquote_arg(raw_path) or "")
        meta = _unquote_arg(args.get("ArtifactMetadata"))
        req_fb = isinstance(meta, dict) and bool(meta.get("RequestFeedback"))
        if _is_plan_path(path_val):
            return (True, False)
        if req_fb:
            if _is_non_plan_feedback_artifact(path_val, meta):
                return (False, False)
            return (True, False)
        if _is_non_code_draft_path(path_val):
            return (False, False)
        return (False, True)
    if name in ("mcp_agy-fast_fast_apply_edits", "apply_edits"):
        edits = _unquote_arg(args.get("edits"))
        if not isinstance(edits, list):
            return (False, True)
        saw_plan = saw_code = False
        for item in edits:
            path_val = str(item.get("path", "")) if isinstance(item, dict) else ""
            if _is_plan_path(path_val):
                saw_plan = True
            elif not _is_non_code_draft_path(path_val):
                saw_code = True
        return (saw_plan, saw_code)
    return (False, True)


def _is_plan_create_cmd(cmd: str) -> bool:
    return bool(HARNESS_PLAN_CREATE_RE.search(cmd)) and "--dry-run" not in cmd


def _classify_cmd_tool(args: dict[str, Any]) -> bool:
    cmd_val = _unquote_arg(args.get("CommandLine", args.get("command", args.get("cmd", ""))))
    if isinstance(cmd_val, str) and _is_plan_create_cmd(cmd_val):
        return True
    commands = _unquote_arg(args.get("commands"))
    if isinstance(commands, list):
        return any(
            isinstance(entry, dict) and _is_plan_create_cmd(str(entry.get("command", "")))
            for entry in commands
        )
    return False


def _read_jsonl(transcript_path: str) -> list[dict[str, Any]]:
    path = Path(transcript_path)
    if not transcript_path or not path.is_file():
        return []
    entries: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(obj, dict):
                entries.append(obj)
    return entries


def _extract_content_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") in ("text", "output_text", "input_text"):
                text = item.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
        return "\n".join(parts)
    return ""


def _record_tool_call(name: str, args: dict[str, Any], state: dict[str, Any]) -> None:
    if name in QUESTION_TOOLS:
        state["asked_user"] = True
        return
    if name in EDIT_TOOLS:
        is_plan, is_code = _classify_edit_tool(name, args)
        state["created_plan"] = state["created_plan"] or is_plan
        state["edited_code"] = state["edited_code"] or is_code
        return
    if name in READ_OR_SEARCH_TOOLS:
        state["inspected_code"] = True
    if name in CMD_TOOLS and _classify_cmd_tool(args):
        state["created_plan"] = True


def _is_human_turn_entry(entry: dict[str, Any]) -> tuple[bool, str]:
    if entry.get("type") == "USER_INPUT":
        return (True, _extract_user_text(str(entry.get("content", ""))))
    msg = entry.get("message") if isinstance(entry.get("message"), dict) else entry
    role = msg.get("role") or entry.get("type")
    if role != "user":
        return (False, "")
    content = msg.get("content")
    if isinstance(content, list) and all(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content
    ):
        return (False, "")
    text = _extract_user_text(_extract_content_text(content))
    if _CHALLENGE_CHECKS in text:
        return (False, "")
    return (bool(text), text)


def _entry_contains_challenge(entry: dict[str, Any]) -> bool:
    for candidate in (
        entry.get("content"),
        entry["message"].get("content") if isinstance(entry.get("message"), dict) else None,
    ):
        if _CHALLENGE_CHECKS in _extract_content_text(candidate):
            return True
    return False


def _extract_turn_summary(entries: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
    last_user_idx, user_text = -1, ""
    for idx, entry in enumerate(entries):
        is_human, text = _is_human_turn_entry(entry)
        if is_human:
            last_user_idx, user_text = idx, text
    turn_entries = entries[last_user_idx + 1 :] if last_user_idx >= 0 else entries
    state: dict[str, Any] = {
        "created_plan": False, "edited_code": False,
        "inspected_code": False, "asked_user": False,
        "already_challenged": False, "last_user_idx": last_user_idx, "final_reply": "",
    }
    for entry in turn_entries:
        etype = entry.get("type")
        if etype == "PLANNER_RESPONSE":
            text = _extract_content_text(entry.get("content"))
            if text:
                state["final_reply"] = text
            for call in entry.get("tool_calls") or []:
                if isinstance(call, dict):
                    _record_tool_call(str(call.get("name", "")), call.get("args") or {}, state)
            continue
        msg = entry.get("message") if isinstance(entry.get("message"), dict) else entry
        if (msg.get("role") or etype) == "assistant":
            content = msg.get("content")
            text = _extract_content_text(content)
            if text:
                state["final_reply"] = text
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                        _record_tool_call(str(block.get("name", "")), inp, state)
            continue
        if _entry_contains_challenge(entry):
            state["already_challenged"] = True
    return (user_text, state)


def _guard_cache_path() -> Path:
    return Path(tempfile.gettempdir()) / "docs-harness-stop-hook-guard.json"


def _loop_guard_seen(key: str, *, now: float | None = None, cache_path: Path | None = None) -> bool:
    """进程外单轮防重兜底：防止个别宿主桥接遗漏 stop_hook_active 导致循环。"""
    ts = time.time() if now is None else now
    path = cache_path or _guard_cache_path()
    records: dict[str, float] = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                records = {
                    str(k): float(v)
                    for k, v in loaded.items()
                    if isinstance(v, (int, float)) and ts - float(v) < LOOP_GUARD_TTL_SECONDS
                }
        except (OSError, ValueError, TypeError):
            records = {}
    if key in records:
        return True
    records[key] = ts
    if len(records) > LOOP_GUARD_MAX_ENTRIES:
        ordered = sorted(records.items(), key=lambda item: item[1], reverse=True)
        records = dict(ordered[:LOOP_GUARD_MAX_ENTRIES])
    try:
        path.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass
    return False


def _detect_dialect(payload: dict[str, Any]) -> str:
    if any(k in payload for k in ("hookEventName", "continuationActive", "terminationReason", "lastUserInput")):
        return "antigravity"
    return "claude"


def _decision_payload(dialect: str) -> dict[str, str]:
    if dialect == "antigravity":
        return {"decision": "continue", "reason": ANTIGRAVITY_CHALLENGE_REASON}
    return {"decision": "block", "reason": CHALLENGE_REASON}


def _loop_guard_digest(
    payload: dict[str, Any],
    transcript_path: str,
    last_user_idx: int,
    user_text: str,
    final_reply: str,
) -> str:
    session = str(
        payload.get("conversationId")
        or payload.get("session_id")
        or transcript_path
        or payload.get("cwd")
        or ""
    )
    turn_sig = (
        f"u{last_user_idx}:{user_text[:120]}"
        if last_user_idx >= 0
        else str(payload.get("turn_id") or user_text[:120] or final_reply[:120])
    )
    return hashlib.sha256(f"{session}|{turn_sig}".encode("utf-8", errors="replace")).hexdigest()[:24]


def evaluate_stop(
    payload: dict[str, Any],
    *,
    guard_cache_path: Path | None = None,
) -> dict[str, Any]:
    """根据 Stop 钩子 stdin 载荷决定放行 `{}` 或打回 1 轮反证。"""
    dialect = _detect_dialect(payload)
    if dialect == "antigravity":
        if payload.get("terminationReason") != "NO_TOOL_CALL":
            return {}
        if payload.get("fullyIdle") is False or payload.get("continuationActive"):
            return {}
    else:
        if payload.get("stop_hook_active"):
            return {}

    transcript_path = str(payload.get("transcriptPath") or payload.get("transcript_path") or "")
    entries = _read_jsonl(transcript_path)
    transcript_user, state = _extract_turn_summary(entries)
    raw_user = str(payload.get("lastUserInput") or payload.get("prompt") or "")
    user_text = _extract_user_text(raw_user) or transcript_user
    final_reply = state["final_reply"] or str(payload.get("last_assistant_message") or "").strip()

    if user_text and (
        OPT_OUT_RE.search(user_text)
        or (len(user_text) <= MAX_MANUAL_CHALLENGE_CHARS and MANUAL_CHALLENGE_RE.search(user_text))
    ):
        return {}
    if state["already_challenged"] or state["edited_code"] or state["asked_user"]:
        return {}

    should_trigger = False
    if state["created_plan"]:
        should_trigger = True
    elif entries:
        if state["inspected_code"] and len(final_reply) >= MIN_CHAT_PLAN_CHARS and user_text:
            should_trigger = bool(
                PLAN_INTENT_RE.search(user_text)
                or (BUG_INVESTIGATION_RE.search(user_text) and PROPOSAL_REPLY_RE.search(final_reply))
            )
    elif len(final_reply) >= MIN_CHAT_PLAN_CHARS:
        should_trigger = bool(
            PROPOSAL_REPLY_RE.search(final_reply) and not ALREADY_EDITED_REPLY_RE.search(final_reply)
        )

    if not should_trigger:
        return {}
    digest = _loop_guard_digest(payload, transcript_path, state["last_user_idx"], user_text, final_reply)
    if _loop_guard_seen(digest, cache_path=guard_cache_path):
        return {}
    return _decision_payload(dialect)


def main() -> int:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw) if raw.strip() else {}
        result = evaluate_stop(payload) if isinstance(payload, dict) else {}
    except Exception:
        result = {}
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
