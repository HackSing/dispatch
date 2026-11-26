"""进度清单字段校验：无 Plan 四要素与勾选项 / 有 Plan 路径与勾选项。"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any, Callable

STANDALONE_REQUIRED_FIELDS = ("scope", "boundary", "pitfalls", "verification", "checklist")
PLAN_LINKED_REQUIRED_FIELDS = ("plan_ref", "checklist")
FIELD_LABELS = {
    "plan_ref": "Plan 路径",
    "scope": "改动文件与符号",
    "boundary": "禁碰边界与脏文件",
    "pitfalls": "已知陷阱",
    "verification": "验收命令与层级",
    "checklist": "进度勾选项",
}

_PLAN_REF = re.compile(r"docs/plans/[\w./-]+\.(?:json|md)")
_CHECKLIST = re.compile(r"(?m)^\s*-\s*\[[ xX]\]\s+\S")
_SCOPE_HEADING = re.compile(
    r"改动(?:文件|路径|范围)|文件范围|修改(?:文件|范围)|涉及文件"
)
_PATH = re.compile(
    r"`[^`\n]*[./\\][^`\n]*`|(?:^|\s)(?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]+"
)
_BACKTICK = re.compile(r"`[^`\n]+`")
_SYMBOL_HINT = re.compile(r"符号|函数|接口|类")
_BOUNDARY = re.compile(
    r"禁碰|不触碰|不修改|不动边界|脏文件|工作区(?:干净|既有)|非目标"
)
_PITFALLS = re.compile(r"已知陷阱|踩坑|注意事项|避坑|风险点|易错点")
_COMMAND = re.compile(
    r"(?m)(?:^|[\s`])(?:python[0-9]*(?:\.[0-9]+)*|pytest|npm|pnpm|yarn|cargo|"
    r"go test|dotnet|gradle|mvn|make|bash|node|flutter|dart|git|pwsh|powershell)\b"
)
_LAYER = re.compile(
    r"验证层级|验收层|focused_test|repository_full_test|local_runtime|"
    r"package_or_install|real_device|免\s*runtime"
)


def checklist_fields(text: str) -> tuple[str, dict[str, bool]]:
    has_checklist = bool(_CHECKLIST.search(text))
    if _PLAN_REF.search(text):
        return "plan_linked", {"plan_ref": True, "checklist": has_checklist}
    has_scope = (
        bool(_SCOPE_HEADING.search(text))
        and bool(_PATH.search(text))
        and (len(_BACKTICK.findall(text)) >= 2 or bool(_SYMBOL_HINT.search(text)))
    )
    return "standalone", {
        "scope": has_scope,
        "boundary": bool(_BOUNDARY.search(text)),
        "pitfalls": bool(_PITFALLS.search(text)),
        "verification": bool(_COMMAND.search(text)) and bool(_LAYER.search(text)),
        "checklist": has_checklist,
    }


def check_checklist(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValueError(str(exc)) from exc
    mode, found = checklist_fields(text)
    required = (
        PLAN_LINKED_REQUIRED_FIELDS
        if mode == "plan_linked"
        else STANDALONE_REQUIRED_FIELDS
    )
    missing = [FIELD_LABELS[name] for name in required if not found[name]]
    return {
        "status": "passed" if not missing else "failed",
        "mode": mode,
        "checked": len(required),
        "found": found,
        "missing": missing,
    }


_CHECKLIST_EPILOG = "\n".join((
    "进度清单约定路径：.docs-harness/tasks/<任务名>.md（不入库、升级不清理），完成一项勾一项。",
    "无 Plan（standalone）模式：开头写明改动文件与符号、禁碰边界与脏文件、已知陷阱、验收命令与层级四项，再列 - [ ] 条目。",
    "有 Plan（plan_linked）模式：开头写明 Plan 路径（docs/plans/<name>.json|md），按步骤/批次只记 - [ ] 进度，不复述冻结 Plan 内容。",
))


def add_checklist_parser(commands: argparse._SubParsersAction) -> None:
    parser = commands.add_parser(
        "checklist",
        help="进度清单校验（无 Plan 四要素+勾选项 / 有 Plan 路径+勾选项）",
        epilog=_CHECKLIST_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("action", choices=("check",))
    parser.add_argument("--target", default=".")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--path", required=True, help="进度清单路径，相对 target 解析")


def run_checklist_check(
    args: argparse.Namespace,
    safe_target: Callable[[str], Path],
    error_type: Any,
) -> tuple[int, dict[str, Any]]:
    target = safe_target(args.target)
    raw = Path(args.path)
    path = raw if raw.is_absolute() else target / raw
    if not path.is_file():
        raise error_type(
            f"进度清单不存在：{args.path}",
            code="checklist_missing",
            next_action="传 --path .docs-harness/tasks/<任务名>.md",
        )
    try:
        payload = check_checklist(path)
    except ValueError as exc:
        raise error_type(
            f"进度清单无法读取：{args.path}：{exc}",
            code="checklist_unreadable",
        ) from exc
    payload["checklist_ref"] = (
        path.relative_to(target).as_posix() if path.is_relative_to(target) else str(path)
    )
    if payload["missing"]:
        payload["next_action"] = (
            "补齐 Plan 路径或 - [ ] 进度条后重跑 checklist check"
            if payload["mode"] == "plan_linked"
            else "补齐 missing 字段后重跑 checklist check；字段名见 FIELD_LABELS"
        )
    return (0 if payload["status"] == "passed" else 1), payload
