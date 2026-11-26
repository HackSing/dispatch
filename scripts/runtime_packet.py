"""运行态证据包 schema 原语：字段、覆盖矩阵与文本质量检查。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Protocol

from managed_assets import fingerprint

RUNTIME_PACKET_SCHEMA = "docs-harness/runtime-verification/v1"
ACCEPTANCE_ASSET_SCHEMA_VERSION = "docs-harness/acceptance-asset/v1"
RUNTIME_PACKET_EXAMPLE = """运行态证据包形状（docs-harness/runtime-verification/v1）：
{
  "schema_version": "docs-harness/runtime-verification/v1",
  "task": "<证据包目录名>",
  "surface": "web_ui|desktop_ui|api|cli|install|other",
  "risk": "simple|complex",
  "acceptance_ref": "docs/acceptance/<任务>.json（可选；关联 live_e2e 验收时必填）",
  "environment": {"description": "<环境>", "start_command": "<启动命令>", "data_setup": "<数据准备>", "mock": false},
  "flows": [{"name": "<流程>", "criterion_id": "c1（可选；live_e2e 必填）", "steps": ["<步骤>"], "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"]}],
  "states": [{"name": "success", "applicable": true, "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"], "reason": null}],
  "data": [{"scenario": "realistic", "input": "<输入>", "expected": "<预期>", "observed": "<实际观察>", "evidence_refs": ["evidence/<文件>"]}],
  "ui": {"applicable": false, "reason": "<非 UI 任务的原因>"},
  "probes": [{"name": "<探测>", "intent": "edge", "result": "<实际结果>", "evidence_refs": ["evidence/<文件>"]}],
  "defects": [],
  "no_defect_rationale": "<为什么探测后没有发现缺陷>",
  "iterations": [{"pass": 1, "status": "passed", "deploy_ref": "<部署版本/构建标识，live_e2e 必填>", "rechecked_criteria": ["c1（修复后终轮必填）"], "summary": "<本轮走查>", "evidence_refs": ["evidence/<文件>"]}],
  "uncovered": [],
  "conclusion": "<运行态结论>"
}
路径：复杂/UI 或 live_e2e 放 docs/runtime-verification/<task>/packet.json（risk=complex）；普通小改动放 .docs-harness/runtime/<task>/packet.json（risk=simple）。
UI 任务还需 ui.viewports（至少两个不同尺寸，含截图）、visual_checks、interaction_checks、copy_checks、accessibility_checks 与 ui.evidence_refs。
关联带 live_e2e 的 Acceptance 时额外硬校验：environment.mock=false、冻结实机 criterion_id 100% 覆盖、每轮 deploy_ref、缺陷修复后终轮变更 deploy_ref 并填 rechecked_criteria。
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
OPTIONAL_TOP_LEVEL_FIELDS = ("acceptance_ref",)
ALLOWED_TOP_LEVEL_FIELDS = TOP_LEVEL_FIELDS + OPTIONAL_TOP_LEVEL_FIELDS
ENVIRONMENT_FIELDS = (
    "description", "start_command", "data_setup", "mock", "mock_rationale",
    "mock_limitations",
)
FLOW_FIELDS = ("name", "steps", "expected", "observed", "evidence_refs")
FLOW_OPTIONAL_FIELDS = ("criterion_id",)
ALLOWED_FLOW_FIELDS = FLOW_FIELDS + FLOW_OPTIONAL_FIELDS
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
ITERATION_OPTIONAL_FIELDS = ("deploy_ref", "rechecked_criteria")
ALLOWED_ITERATION_FIELDS = ITERATION_FIELDS + ITERATION_OPTIONAL_FIELDS
LIVE_E2E_FIELDS = (
    "real_dependencies", "environment", "isolation_and_cleanup", "deploy_command",
    "max_fix_rounds", "confirm_before_run",
)
LIVE_E2E_REQUIRED_FIELDS = (
    "real_dependencies", "environment", "isolation_and_cleanup", "deploy_command",
)
LIVE_E2E_EVIDENCE_LAYERS = ("local_runtime", "real_device")
LIVE_E2E_DEFAULT_MAX_FIX_ROUNDS = 3
LIVE_E2E_MIN_FIX_ROUNDS = 1
LIVE_E2E_MAX_FIX_ROUNDS = 10
LIVE_E2E_CONFIRM_DEFAULT = True
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


def is_runtime_packet_ref(ref: str) -> bool:
    parts = Path(ref.replace("\\", "/").strip()).parts
    return (
        len(parts) == 4
        and parts[3] == "packet.json"
        and parts[:2] in (("docs", "runtime-verification"), (".docs-harness", "runtime"))
    )


def is_live_e2e_criterion(criterion: dict[str, Any]) -> bool:
    return (
        criterion.get("acceptance_type") == "behavior_acceptance"
        and criterion.get("evidence_layer") in LIVE_E2E_EVIDENCE_LAYERS
    )


def _single_line_text(value: Any, label: str, min_len: int) -> str:
    if not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
        raise ValueError(f"{label} 必须是单行非空字符串")
    stripped = value.strip()
    if normalize(stripped) in GENERIC_TEXTS or only_generic(stripped) or len(stripped) < min_len:
        raise ValueError(f"{label} 过于空泛或过短（至少 {min_len} 字）")
    return stripped


def validate_criterion_expectations(
    pass_criteria: Any, fail_criteria: Any, *, required: bool = False
) -> tuple[str | None, str | None]:
    if pass_criteria is None and fail_criteria is None:
        if required:
            raise ValueError("live_e2e 实机标准必须同时填写 pass_criteria 与 fail_criteria")
        return None, None
    if pass_criteria is None or fail_criteria is None:
        raise ValueError("pass_criteria 与 fail_criteria 必须成对填写")
    passed = _single_line_text(pass_criteria, "pass_criteria", min_len=8)
    failed = _single_line_text(fail_criteria, "fail_criteria", min_len=8)
    if normalize(passed) == normalize(failed):
        raise ValueError("pass_criteria 与 fail_criteria 不能相同，必须明确区分通过条件与失败判定")
    return passed, failed


def normalize_live_e2e_config(raw: Any) -> dict[str, Any] | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise ValueError("live_e2e 必须是对象")
    unknown = sorted(set(raw) - set(LIVE_E2E_FIELDS))
    if unknown:
        raise ValueError("live_e2e 包含未注册字段：" + ", ".join(unknown))
    missing = [key for key in LIVE_E2E_REQUIRED_FIELDS if key not in raw]
    if missing:
        raise ValueError("live_e2e 缺少必填字段：" + ", ".join(missing))
    raw_deps = raw.get("real_dependencies")
    if not isinstance(raw_deps, list) or not raw_deps:
        raise ValueError("live_e2e.real_dependencies 必须是非空字符串数组")
    deps = [_single_line_text(item, f"live_e2e.real_dependencies[{idx}]", min_len=2) for idx, item in enumerate(raw_deps)]
    if len(deps) != len(set(deps)):
        raise ValueError("live_e2e.real_dependencies 不得重复")
    rounds = raw.get("max_fix_rounds", LIVE_E2E_DEFAULT_MAX_FIX_ROUNDS)
    if isinstance(rounds, bool) or not isinstance(rounds, int) or not (LIVE_E2E_MIN_FIX_ROUNDS <= rounds <= LIVE_E2E_MAX_FIX_ROUNDS):
        raise ValueError(f"live_e2e.max_fix_rounds 必须是 {LIVE_E2E_MIN_FIX_ROUNDS}-{LIVE_E2E_MAX_FIX_ROUNDS} 的整数")
    confirm = raw.get("confirm_before_run", LIVE_E2E_CONFIRM_DEFAULT)
    if not isinstance(confirm, bool):
        raise ValueError("live_e2e.confirm_before_run 必须是布尔值")
    return {
        "real_dependencies": deps,
        "environment": _single_line_text(raw.get("environment"), "live_e2e.environment", min_len=10),
        "isolation_and_cleanup": _single_line_text(raw.get("isolation_and_cleanup"), "live_e2e.isolation_and_cleanup", min_len=10),
        "deploy_command": _single_line_text(raw.get("deploy_command"), "live_e2e.deploy_command", min_len=6),
        "max_fix_rounds": rounds,
        "confirm_before_run": confirm,
    }


def validate_live_e2e_criteria(live_e2e: dict[str, Any] | None, criteria: list[dict[str, Any]]) -> list[str]:
    if not live_e2e:
        return []
    live = [item for item in criteria if is_live_e2e_criterion(item)]
    if not live:
        return ["live_e2e 验收资产至少需要 1 条 evidence_layer 为 local_runtime 或 real_device 的行为标准"]
    errors: list[str] = []
    for item in live:
        try:
            validate_criterion_expectations(item.get("pass_criteria"), item.get("fail_criteria"), required=True)
        except ValueError as exc:
            errors.append(f"criterion {item.get('id', '?')}: {exc}")
    return errors


def load_linked_acceptance(ctx: PacketContext, target: Path, raw_ref: Any) -> dict[str, Any] | None:
    if raw_ref is None:
        return None
    if not isinstance(raw_ref, str) or not raw_ref.strip() or "\\" in raw_ref:
        ctx.error("runtime_acceptance_ref_invalid", "acceptance_ref 必须是 docs/acceptance/<name>.json 相对路径", "acceptance_ref")
        return None
    rel = Path(raw_ref.strip())
    if rel.is_absolute() or ".." in rel.parts or rel.parent.as_posix() != "docs/acceptance" or rel.suffix != ".json":
        ctx.error("runtime_acceptance_ref_invalid", "acceptance_ref 必须指向 docs/acceptance/<name>.json（活跃验收资产）", "acceptance_ref")
        return None
    path = (target / rel).resolve()
    if not path.is_relative_to(target.resolve()) or path.is_symlink() or not path.is_file():
        ctx.error("runtime_acceptance_ref_missing", f"关联的 Acceptance 资产不存在：{raw_ref}", "acceptance_ref")
        return None
    try:
        asset = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        ctx.error("runtime_acceptance_ref_invalid", f"关联 Acceptance 无法读取：{exc}", "acceptance_ref")
        return None
    if not isinstance(asset, dict) or asset.get("schema_version") != ACCEPTANCE_ASSET_SCHEMA_VERSION:
        ctx.error("runtime_acceptance_ref_invalid", "acceptance_ref 指向的文件不是有效 Acceptance 资产", "acceptance_ref")
        return None
    if asset.get("asset_fingerprint") != fingerprint(asset):
        ctx.error("runtime_acceptance_fingerprint_invalid", "关联 Acceptance 资产指纹无效，标准可能被手工篡改", "acceptance_ref")
        return None
    return asset


def _validate_live_e2e_iterations(
    ctx: PacketContext,
    iterations: list[dict[str, Any]],
    has_defects: bool,
    max_fix_rounds: int,
) -> None:
    for item in iterations:
        ref = item.get("deploy_ref")
        if not isinstance(ref, str) or len(ref.strip()) < 4 or only_generic(ref):
            ctx.error("runtime_live_e2e_deploy_ref_missing", f"{item['label']}.deploy_ref 不能为空，须记录部署版本/构建标识", f"{item['label']}.deploy_ref")
    failed = [item for item in iterations if item.get("status") == "failed"]
    if len(failed) > max_fix_rounds:
        ctx.warn("runtime_live_e2e_rounds_exceeded", f"失败迭代轮次（{len(failed)}）超过 live_e2e.max_fix_rounds（{max_fix_rounds}），请确认未发生失控循环或临时补丁堆积")
    if not has_defects or len(iterations) < 2:
        return
    final = iterations[-1]
    prev_failed_refs = [item["deploy_ref"] for item in iterations[:-1] if item.get("status") == "failed" and isinstance(item.get("deploy_ref"), str)]
    final_ref = final.get("deploy_ref")
    if prev_failed_refs and isinstance(final_ref, str) and normalize(final_ref) == normalize(prev_failed_refs[-1]):
        ctx.error("runtime_live_e2e_deploy_unchanged", "存在缺陷修复时，最终通过轮 deploy_ref 必须不同于前一失败轮，证明修复后已重新部署/重启测试环境", f"{final['label']}.deploy_ref")
    if not final.get("rechecked_criteria"):
        ctx.error("runtime_live_e2e_final_regression_missing", "存在缺陷修复时，最终通过轮必须填写 rechecked_criteria，证明在终版部署上完成了复测与回归", f"{final['label']}.rechecked_criteria")


def validate_acceptance_alignment(
    ctx: PacketContext,
    acceptance: dict[str, Any] | None,
    root_kind: str,
    flow_criteria: list[tuple[str, str]],
    iterations: list[dict[str, Any]],
    has_defects: bool,
) -> None:
    if acceptance is None:
        if flow_criteria and not ctx.packet.get("acceptance_ref"):
            ctx.error("runtime_acceptance_ref_required", "flows[].criterion_id 需要顶层 acceptance_ref 指向对应 Acceptance 资产")
        if any(item.get("rechecked_criteria") for item in iterations) and not ctx.packet.get("acceptance_ref"):
            ctx.error("runtime_acceptance_ref_required", "iterations[].rechecked_criteria 需要顶层 acceptance_ref 指向对应 Acceptance 资产")
        return
    valid_ids = {item["id"] for item in acceptance.get("criteria", []) if isinstance(item, dict) and isinstance(item.get("id"), str)}
    for label, cid in flow_criteria:
        if cid not in valid_ids:
            ctx.error("runtime_acceptance_criterion_unknown", f"{label}.criterion_id 不存在于关联 Acceptance：{cid}", label)
    for item in iterations:
        for cid in item.get("rechecked_criteria") or ():
            if cid not in valid_ids:
                ctx.error("runtime_acceptance_criterion_unknown", f"{item['label']}.rechecked_criteria 包含未知标准：{cid}", item["label"])
    live_e2e = acceptance.get("live_e2e")
    if not isinstance(live_e2e, dict):
        return
    if root_kind != "committed" or ctx.packet.get("risk") != "complex":
        ctx.error("runtime_live_e2e_location_invalid", "live_e2e 运行态证据包必须放在 docs/runtime-verification/<task>/packet.json 且 risk=complex")
    env = ctx.packet.get("environment")
    if isinstance(env, dict) and env.get("mock") is not False:
        ctx.error("runtime_live_e2e_mock_forbidden", "live_e2e 实机全量验收禁止 environment.mock=true，必须真实调用目标环境与依赖", "environment.mock")
    live_ids = [item["id"] for item in acceptance.get("criteria", []) if isinstance(item, dict) and is_live_e2e_criterion(item)]
    covered = {cid for _, cid in flow_criteria}
    missing = [cid for cid in live_ids if cid not in covered]
    if missing:
        ctx.error("runtime_live_e2e_criteria_uncovered", "live_e2e 证据包漏测冻结 Acceptance 实机标准：" + "、".join(missing), "flows")
    rounds = live_e2e.get("max_fix_rounds", LIVE_E2E_DEFAULT_MAX_FIX_ROUNDS)
    _validate_live_e2e_iterations(ctx, iterations, has_defects, rounds if isinstance(rounds, int) else LIVE_E2E_DEFAULT_MAX_FIX_ROUNDS)
