"""收尾报告字段校验：把“证据写进记录”变成可执行检查。"""

from __future__ import annotations

import argparse
import re
from pathlib import Path
from typing import Any

REQUIRED_FIELDS = ("path", "command", "exit", "layer", "uncovered")
FIELD_LABELS = {
    "path": "改动路径",
    "command": "验证命令",
    "exit": "退出结果",
    "layer": "验证层级（验收层）",
    "uncovered": "未覆盖项",
}
_PATH = re.compile(r"`[^`\n]*[./\\][^`\n]*`|(?:^|\s)(?:[\w.-]+/)+[\w.-]+\.[A-Za-z0-9]+")
_COMMAND = re.compile(
    r"(?m)(?:^|[\s`])(?:python[0-9]*(?:\.[0-9]+)*|pytest|npm|pnpm|yarn|cargo|go test|dotnet|gradle|mvn|make|bash|node|flutter|dart|git)\b"
)
_EXIT = re.compile(
    r"退出(?:码|状态)?\s*[:：]?\s*\d|exit[_ ]?code|exit\s*[:=]\s*\d|EXIT=|返回码",
    re.IGNORECASE,
)
_LAYER = re.compile(r"验收层|验证层级")
_UNCOVERED = re.compile(r"未覆盖")


def report_fields(text: str) -> dict[str, bool]:
    return {
        "path": bool(_PATH.search(text)),
        "command": bool(_COMMAND.search(text)),
        "exit": bool(_EXIT.search(text)),
        "layer": bool(_LAYER.search(text)),
        "uncovered": bool(_UNCOVERED.search(text)),
    }


def check_report(path: Path) -> dict[str, Any]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ValueError(str(exc)) from exc
    found = report_fields(text)
    missing = [FIELD_LABELS[name] for name in REQUIRED_FIELDS if not found[name]]
    return {
        "status": "passed" if not missing else "failed",
        "checked": len(REQUIRED_FIELDS),
        "found": found,
        "missing": missing,
    }


_REPORT_EPILOG = "\n".join((
    "收尾记录约定路径：.docs-harness/reports/<YYYY-MM-DD>-<任务名>.md（同一任务多次收尾追加到同一文件）。",
    "5 项必填字段：改动路径、验证命令与退出码、验证层级（focused_test / repository_full_test / local_runtime / package_or_install / real_device）、未覆盖项。",
    "运行态任务另写证据包路径、runtime check 退出码与前台/后台验证说明（前台例外须注明显示内容与持续时长）。",
))


def add_report_parser(commands: argparse._SubParsersAction) -> None:
    parser = commands.add_parser(
        "report",
        help="收尾记录字段校验（改动路径/命令/退出码/验证层级/未覆盖）",
        epilog=_REPORT_EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("action", choices=("check",))
    parser.add_argument("--target", default=".")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--path", required=True, help="收尾报告路径，相对 target 解析")
