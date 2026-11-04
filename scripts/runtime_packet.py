"""运行态证据包 schema 原语：字段、覆盖矩阵与文本质量检查。"""

from __future__ import annotations

import re
from typing import Any, Protocol

RUNTIME_PACKET_SCHEMA = "docs-harness/runtime-verification/v1"
RUNTIME_PACKET_EXAMPLE = """运行态证据包形状（docs-harness/runtime-verification/v1）：
{
  "schema_version": "docs-harness/runtime-verification/v1",
  "task": "<证据包目录名>",
  "surface": "web_ui|desktop_ui|api|cli|install|other",
  "risk": "simple|complex",
  "environment": {"description": "<环境>", "start_command": "<启动命令>", "data_setup": "<数据准备>", "mock": false},
  "flows": [{"name": "<流程>", "steps": ["<步骤>"], "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"]}],
  "states": [{"name": "success", "applicable": true, "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"], "reason": null}],
  "data": [{"scenario": "realistic", "input": "<输入>", "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"]}],
  "ui": {"applicable": false, "reason": "<非 UI 任务的原因>"},
  "probes": [{"name": "<探测>", "intent": "edge", "result": "<实际结果>", "evidence_refs": ["evidence/<文件>"]}],
  "defects": [],
  "no_defect_rationale": "<为什么探测后没有发现缺陷>",
  "iterations": [{"pass": 1, "status": "passed", "summary": "<本轮走查>", "evidence_refs": ["evidence/<文件>"]}],
  "uncovered": [],
  "conclusion": "<运行态结论>"
}
路径：复杂/UI 放 docs/runtime-verification/<task>/packet.json（risk=complex）；普通小改动放 .docs-harness/runtime/<task>/packet.json（risk=simple）。
UI 任务还需 ui.viewports（至少两个不同尺寸，含截图）、visual_checks、interaction_checks、copy_checks、accessibility_checks 与 ui.evidence_refs。
检查器拒绝空泛观察、缺失证据、必需状态/数据场景缺失、UI 单视口或重复截图、无对抗探测、缺陷未闭环、未声明的 mock 限制。"""
SURFACES = ("web_ui", "desktop_ui", "api", "cli", "install", "other")
RISK_LEVELS = ("simple", "complex")
SEVERITIES = ("blocker", "major", "minor")
PROBE_INTENTS = ("edge", "invalid", "permission", "recovery", "data", "abuse")
UI_SURFACES = ("web_ui", "desktop_ui")
TASK_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
VIEWPORT_PATTERN = re.compile(r"^\d{3,5}x\d{3,5}$")
GENERIC_TEXTS = {
    "正常", "通过", "无问题", "无异常", "一切正常", "符合预期", "已验证", "已走查",
    "已经验证", "没有问题", "ok", "okay", "pass", "passed", "none", "good", "done",
    "n/a", "na", "success",
}
TOP_LEVEL_FIELDS = (
    "schema_version", "task", "surface", "risk", "environment", "flows", "states",
    "data", "ui", "probes", "defects", "no_defect_rationale", "iterations",
    "uncovered", "conclusion",
)
ENVIRONMENT_FIELDS = (
    "description", "start_command", "data_setup", "mock", "mock_rationale",
    "mock_limitations",
)
FLOW_FIELDS = ("name", "steps", "expected", "observed", "evidence_refs")
STATE_FIELDS = ("name", "applicable", "expected", "observed", "evidence_refs", "reason")
DATA_FIELDS = ("scenario", "input", "expected", "observed", "evidence_refs")
UI_FIELDS = (
    "applicable", "reason", "viewports", "visual_checks", "interaction_checks",
    "copy_checks", "accessibility_checks", "evidence_refs",
)
VIEWPORT_FIELDS = ("name", "size", "evidence_refs")
PROBE_FIELDS = ("name", "intent", "result", "evidence_refs")
DEFECT_FIELDS = ("summary", "severity", "fix", "recheck", "evidence_refs")
ITERATION_FIELDS = ("pass", "status", "summary", "evidence_refs")
UI_CHECK_KEYS = {
    "visual_checks": ("hierarchy", "spacing", "contrast", "responsive"),
    "interaction_checks": ("feedback", "loading", "keyboard", "error_recovery"),
    "copy_checks": ("terminology", "error_messages", "next_action", "no_internal_terms"),
    "accessibility_checks": ("focus_visible", "labels", "contrast", "keyboard_navigation"),
}
REQUIRED_STATES = {
    "web_ui": (("success",), ("empty",), ("error",), ("loading", "disabled", "permission", "offline")),
    "desktop_ui": (("success",), ("empty",), ("error",), ("loading", "disabled", "permission", "offline")),
    "api": (("success",), ("validation_error",), ("auth_error",), ("not_found", "conflict", "rate_limit")),
    "cli": (("success",), ("invalid_input",), ("runtime_error",)),
    "install": (("fresh_install",), ("upgrade",), ("failure",), ("uninstall", "rollback")),
    "other": (("success",), ("error",), ("edge",)),
}
REQUIRED_DATA = {
    "web_ui": (("realistic",), ("empty",), ("invalid",), ("long", "special")),
    "desktop_ui": (("realistic",), ("empty",), ("invalid",), ("long", "special")),
    "api": (("realistic",), ("empty",), ("invalid",), ("boundary",)),
    "cli": (("realistic",), ("empty",), ("invalid",), ("boundary",)),
    "install": (("fresh",), ("upgrade",), ("failure",), ("rollback",)),
    "other": (("realistic",), ("empty",), ("invalid",)),
}


class PacketContext(Protocol):
    packet: dict[str, Any]
    stats: dict[str, int]

    def error(self, code: str, message: str, path: str | None = None) -> None: ...
    def warn(self, code: str, message: str, path: str | None = None) -> None: ...


def normalize(value: str) -> str:
    return re.sub(r"[\s。.!！,，;；:：、]+", "", value).lower()


def only_generic(value: str) -> bool:
    remainder = normalize(value)
    for token in sorted({normalize(item) for item in GENERIC_TEXTS}, key=len, reverse=True):
        remainder = remainder.replace(token, "")
    return not remainder


def text(ctx: PacketContext, value: Any, label: str, min_len: int = 12) -> bool:
    if not isinstance(value, str) or not value.strip():
        ctx.error("runtime_packet_text_invalid", f"{label} 不能为空", label)
        return False
    if normalize(value) in GENERIC_TEXTS or only_generic(value) or len(value.strip()) < min_len:
        ctx.error(
            "runtime_packet_text_invalid",
            f"{label} 过于空泛或过短（至少 {min_len} 字），必须写实际观察或具体结论",
            label,
        )
        return False
    return True


def text_list(ctx: PacketContext, value: Any, label: str, min_items: int = 1) -> list[str]:
    if not isinstance(value, list) or len(value) < min_items:
        ctx.error("runtime_packet_list_invalid", f"{label} 至少需要 {min_items} 项", label)
        return []
    result: list[str] = []
    for index, item in enumerate(value):
        if not isinstance(item, str) or not item.strip():
            ctx.error("runtime_packet_list_invalid", f"{label}[{index}] 必须是非空字符串", label)
        else:
            result.append(item)
    return result


def expected_observed(ctx: PacketContext, value: dict[str, Any], label: str) -> None:
    expected = value.get("expected")
    observed = value.get("observed")
    text(ctx, expected, f"{label}.expected", min_len=8)
    text(ctx, observed, f"{label}.observed", min_len=12)
    if isinstance(expected, str) and isinstance(observed, str) and normalize(expected) == normalize(observed):
        ctx.error("runtime_packet_observation_copied", f"{label}.observed 不能照抄 expected，要写实际看到的现象", label)


def object_field(ctx: PacketContext, value: Any, label: str, allowed: tuple[str, ...]) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        ctx.error("runtime_packet_object_invalid", f"{label} 必须是对象")
        return None
    unknown = sorted(set(value) - set(allowed))
    if unknown:
        ctx.error("runtime_packet_unknown_field", f"{label} 包含未注册字段：" + ", ".join(unknown), label)
    return value


def required_fields(ctx: PacketContext, value: dict[str, Any], keys: tuple[str, ...], label: str) -> bool:
    missing = [key for key in keys if key not in value]
    if missing:
        ctx.error("runtime_packet_required_field", f"{label} 缺少字段：" + ", ".join(missing), label)
        return False
    return True


def require_absent(ctx: PacketContext, key: str, message: str) -> None:
    if ctx.packet.get(key) not in (None, ""):
        ctx.error("runtime_packet_field_unexpected", message)
