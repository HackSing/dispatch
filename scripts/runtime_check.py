"""运行态验证证据包硬校验：把“已走查”变成可拒绝、可复查的证据。"""

from __future__ import annotations

import hashlib
import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from runtime_packet import (
    DATA_FIELDS, DEFECT_FIELDS, ENVIRONMENT_FIELDS, FLOW_FIELDS, ITERATION_FIELDS,
    PROBE_FIELDS, PROBE_INTENTS, REQUIRED_DATA, REQUIRED_STATES, RISK_LEVELS,
    RUNTIME_PACKET_SCHEMA, SEVERITIES, STATE_FIELDS, SURFACES, TASK_PATTERN,
    TOP_LEVEL_FIELDS, UI_CHECK_KEYS, UI_FIELDS, UI_SURFACES, VIEWPORT_FIELDS,
    VIEWPORT_PATTERN,
)
from runtime_packet import (
    expected_observed as _expected_observed,
    object_field as _object,
    require_absent as _require_absent,
    required_fields as _required,
    text as _text,
    text_list as _text_list,
)

RUNTIME_VERIFICATION_RELATIVE = ".docs-harness/runtime"
RUNTIME_VERIFICATION_COMMITTED = "docs/runtime-verification"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


@dataclass
class _Context:
    target: Path
    packet_path: Path
    packet_dir: Path
    packet: dict[str, Any]
    packet_ignored: bool | None
    errors: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)
    stats: dict[str, int] = field(default_factory=lambda: {
        "flows": 0, "states": 0, "data": 0, "probes": 0, "viewports": 0,
        "iterations": 0, "defects": 0,
    })
    evidence: dict[str, Path] = field(default_factory=dict)
    evidence_hashes: dict[str, str] = field(default_factory=dict)
    root_kind: str = "unknown"

    def error(self, code: str, message: str, path: str | None = None) -> None:
        item = {"code": code, "message": message}
        if path:
            item["path"] = path
        self.errors.append(item)

    def warn(self, code: str, message: str, path: str | None = None) -> None:
        item = {"code": code, "message": message}
        if path:
            item["path"] = path
        self.warnings.append(item)


def check_packet(target: Path, packet_path: Path) -> dict[str, Any]:
    target = Path(target).resolve()
    raw = Path(packet_path)
    path = raw if raw.is_absolute() else target / raw
    path = path.resolve()
    relative = _relative_to(path, target)
    if relative is None:
        return _failure("runtime_packet_outside_target", "证据包必须位于项目目录内", str(packet_path))
    if not path.is_file():
        return _failure("runtime_packet_missing", f"运行态证据包不存在：{relative.as_posix()}", relative.as_posix())
    try:
        packet = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        message = f"证据包 JSON 无效：第 {exc.lineno} 行第 {exc.colno} 列：{exc.msg}"
        return _failure("runtime_packet_invalid_json", message, relative.as_posix())
    except (OSError, UnicodeDecodeError) as exc:
        return _failure("runtime_packet_unreadable", f"证据包无法读取：{exc}", relative.as_posix())
    if not isinstance(packet, dict):
        return _failure("runtime_packet_not_object", "证据包根节点必须是 JSON 对象", relative.as_posix())
    ctx = _Context(
        target=target,
        packet_path=path,
        packet_dir=path.parent,
        packet=packet,
        packet_ignored=_git_ignored(target, path),
    )
    _validate_identity(ctx, relative)
    _validate_environment(ctx)
    _validate_flows(ctx)
    _validate_states(ctx)
    _validate_data(ctx)
    _validate_ui(ctx)
    _validate_probes(ctx)
    _validate_defects_and_iterations(ctx)
    _validate_uncovered(ctx)
    payload = {
        "status": "passed" if not ctx.errors else "failed",
        "packet_ref": relative.as_posix(),
        "root_kind": ctx.root_kind,
        "checked": {**ctx.stats, "evidence": len(ctx.evidence)},
        "errors": ctx.errors,
        "warnings": ctx.warnings,
    }
    if ctx.errors:
        payload["next_action"] = "按 errors 补齐真实观察或证据后重跑 runtime check；不要用“正常/通过”替代具体现象"
    return payload


def _failure(code: str, message: str, path: str) -> dict[str, Any]:
    return {
        "status": "failed",
        "packet_ref": path,
        "root_kind": "unknown",
        "checked": {key: 0 for key in ("flows", "states", "data", "probes", "viewports", "iterations", "defects", "evidence")},
        "errors": [{"code": code, "message": message, "path": path}],
        "warnings": [],
        "next_action": "确认证据包路径与 JSON 后重跑 runtime check",
    }


def _relative_to(path: Path, target: Path) -> Path | None:
    try:
        return path.relative_to(target)
    except ValueError:
        return None


def _validate_identity(ctx: _Context, relative: Path) -> None:
    packet = ctx.packet
    unknown = sorted(set(packet) - set(TOP_LEVEL_FIELDS))
    if unknown:
        ctx.error("runtime_packet_unknown_field", "证据包包含未注册字段：" + ", ".join(unknown))
    _required(ctx, packet, TOP_LEVEL_FIELDS, "证据包")
    if packet.get("schema_version") != RUNTIME_PACKET_SCHEMA:
        ctx.error("runtime_packet_schema_invalid", f"schema_version 必须为 {RUNTIME_PACKET_SCHEMA}")
    surface = packet.get("surface")
    if surface not in SURFACES:
        ctx.error("runtime_packet_surface_invalid", "surface 仅接受 " + "/".join(SURFACES))
    risk = packet.get("risk")
    if risk not in RISK_LEVELS:
        ctx.error("runtime_packet_risk_invalid", "risk 仅接受 simple/complex")
    _validate_packet_location(ctx, relative, surface, risk)
    task = packet.get("task")
    if not isinstance(task, str) or not TASK_PATTERN.fullmatch(task):
        ctx.error("runtime_packet_task_invalid", "task 必须是小写 slug，只能包含字母、数字、点、下划线和连字符")
    elif task != ctx.packet_dir.name:
        ctx.error("runtime_packet_task_mismatch", f"task 必须等于证据包目录名 {ctx.packet_dir.name}")
    if not isinstance(packet.get("conclusion"), str):
        ctx.error("runtime_packet_conclusion_invalid", "conclusion 必须是字符串")
    else:
        _text(ctx, packet["conclusion"], "conclusion", min_len=20)
    if not isinstance(packet.get("uncovered"), list):
        ctx.error("runtime_packet_uncovered_invalid", "uncovered 必须是字符串数组")
    if not isinstance(packet.get("environment"), dict):
        ctx.error("runtime_packet_environment_invalid", "environment 必须是对象")
    for key in ("flows", "states", "data", "probes", "defects", "iterations"):
        if not isinstance(packet.get(key), list):
            ctx.error("runtime_packet_collection_invalid", f"{key} 必须是数组")


def _validate_packet_location(ctx: _Context, relative: Path, surface: Any, risk: Any) -> None:
    if relative.name != "packet.json":
        ctx.error("runtime_packet_location_invalid", "证据包文件名必须是 packet.json", relative.as_posix())
    parts = relative.parts
    committed_root = Path(RUNTIME_VERIFICATION_COMMITTED).parts
    local_root = Path(RUNTIME_VERIFICATION_RELATIVE).parts
    if parts[:len(committed_root)] == committed_root:
        ctx.root_kind = "committed"
        if risk != "complex":
            ctx.error("runtime_packet_location_invalid", "docs/runtime-verification/ 只接受 risk=complex 的证据包")
        if ctx.packet_ignored:
            ctx.error("runtime_packet_ignored", "提交路径下的证据包不能位于 git 忽略目录")
        expected_parts = len(committed_root) + 2
    elif parts[:len(local_root)] == local_root:
        ctx.root_kind = "local"
        if risk != "simple":
            ctx.error("runtime_packet_location_invalid", ".docs-harness/runtime/ 只接受 risk=simple 的证据包")
        if ctx.packet_ignored is False:
            ctx.warn("runtime_packet_not_ignored", "本地证据包未被 git 忽略，注意不要误提交", relative.as_posix())
        expected_parts = len(local_root) + 2
    else:
        expected_parts = 0
        ctx.error(
            "runtime_packet_location_invalid",
            "证据包必须放在 docs/runtime-verification/<task>/packet.json 或 .docs-harness/runtime/<task>/packet.json",
            relative.as_posix(),
        )
    if expected_parts and len(parts) != expected_parts:
        ctx.error("runtime_packet_location_invalid", "证据包必须位于 <根>/<task>/packet.json 的固定层级", relative.as_posix())
    if surface in UI_SURFACES and risk == "simple":
        ctx.error("runtime_packet_risk_invalid", "UI 运行态证据必须按 complex 处理并提交")


def _validate_environment(ctx: _Context) -> None:
    environment = _object(ctx, ctx.packet.get("environment"), "environment", ENVIRONMENT_FIELDS)
    if environment is None:
        return
    if not _required(ctx, environment, ("description", "start_command", "data_setup", "mock"), "environment"):
        return
    _text(ctx, environment.get("description"), "environment.description", min_len=20)
    _text(ctx, environment.get("start_command"), "environment.start_command", min_len=10)
    _text(ctx, environment.get("data_setup"), "environment.data_setup", min_len=10)
    mock = environment.get("mock")
    if not isinstance(mock, bool):
        ctx.error("runtime_mock_invalid", "environment.mock 必须是 true/false")
        return
    rationale = environment.get("mock_rationale")
    limitations = environment.get("mock_limitations")
    if mock:
        _text(ctx, rationale, "environment.mock_rationale", min_len=20)
        _text(ctx, limitations, "environment.mock_limitations", min_len=20)
    elif rationale not in (None, "") or limitations not in (None, ""):
        ctx.error("runtime_mock_inconsistent", "environment.mock=false 时不要填写 mock_rationale/mock_limitations")


def _validate_flows(ctx: _Context) -> None:
    flows = ctx.packet.get("flows")
    if not isinstance(flows, list):
        return
    risk = ctx.packet.get("risk")
    minimum = 2 if risk == "complex" else 1
    if len(flows) < minimum:
        ctx.error("runtime_flow_missing", f"flows 至少需要 {minimum} 条真实用户流程")
    names: set[str] = set()
    for index, raw in enumerate(flows):
        label = f"flows[{index}]"
        flow = _object(ctx, raw, label, FLOW_FIELDS)
        if flow is None or not _required(ctx, flow, FLOW_FIELDS, label):
            continue
        _text(ctx, flow.get("name"), f"{label}.name", min_len=4)
        name = flow.get("name")
        if isinstance(name, str):
            if name in names:
                ctx.error("runtime_flow_duplicate", f"流程名 {name} 重复声明")
            names.add(name)
        steps = _text_list(ctx, flow.get("steps"), f"{label}.steps", min_items=1)
        if risk == "complex" and len(steps) < 2:
            ctx.error("runtime_flow_steps_too_few", f"{label}.steps 至少需要 2 个可操作步骤")
        _expected_observed(ctx, flow, label)
        _refs(ctx, flow.get("evidence_refs"), f"{label}.evidence_refs")
        ctx.stats["flows"] += 1


def _validate_states(ctx: _Context) -> None:
    states = ctx.packet.get("states")
    if not isinstance(states, list):
        return
    surface = ctx.packet.get("surface")
    required_groups = REQUIRED_STATES.get(surface, ())
    minimum = max(3, sum(1 for group in required_groups if len(group) == 1))
    if len(states) < minimum:
        ctx.error("runtime_state_missing", f"states 至少需要 {minimum} 个状态")
    by_name: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(states):
        label = f"states[{index}]"
        state = _object(ctx, raw, label, STATE_FIELDS)
        if state is None or not _required(ctx, state, STATE_FIELDS, label):
            continue
        name = state.get("name")
        if not isinstance(name, str) or not name.strip():
            ctx.error("runtime_state_name_invalid", f"{label}.name 不能为空")
            continue
        if name in by_name:
            ctx.error("runtime_state_duplicate", f"状态 {name} 重复声明")
            continue
        by_name[name] = state
        applicable = state.get("applicable")
        if not isinstance(applicable, bool):
            ctx.error("runtime_state_applicable_invalid", f"{label}.applicable 必须是 true/false")
            continue
        if applicable:
            _expected_observed(ctx, state, label)
            _refs(ctx, state.get("evidence_refs"), f"{label}.evidence_refs")
            if state.get("reason") not in (None, ""):
                ctx.error("runtime_state_reason_unexpected", f"{label} 适用时不要填写 reason")
        else:
            _text(ctx, state.get("reason"), f"{label}.reason", min_len=12)
            if state.get("evidence_refs") not in (None, []):
                ctx.error("runtime_state_evidence_unexpected", f"{label} 不适用时不要提供证据")
            if state.get("expected") not in (None, "") or state.get("observed") not in (None, ""):
                ctx.error("runtime_state_observation_unexpected", f"{label} 不适用时不要填写 expected/observed")
        ctx.stats["states"] += 1
    _validate_state_groups(ctx, by_name, required_groups)


def _validate_state_groups(
    ctx: _Context,
    by_name: dict[str, dict[str, Any]],
    required_groups: tuple[tuple[str, ...], ...],
) -> None:
    for group in required_groups:
        present = [by_name[name] for name in group if name in by_name]
        if not present:
            ctx.error("runtime_state_missing", "缺少必需状态之一：" + "/".join(group))
            continue
        applicable = [item for item in present if item.get("applicable") is True]
        if not applicable:
            ctx.error("runtime_state_not_applicable", "必需状态不能全部标记为不适用：" + "/".join(group))
        if len(group) == 1 and not applicable:
            ctx.error("runtime_state_not_applicable", f"核心状态 {group[0]} 必须实际验证")


def _validate_data(ctx: _Context) -> None:
    data = ctx.packet.get("data")
    if not isinstance(data, list):
        return
    surface = ctx.packet.get("surface")
    required_groups = REQUIRED_DATA.get(surface, ())
    minimum = max(3, len(required_groups))
    if len(data) < minimum:
        ctx.error("runtime_data_missing", f"data 至少需要 {minimum} 个数据场景")
    scenarios: set[str] = set()
    for index, raw in enumerate(data):
        label = f"data[{index}]"
        item = _object(ctx, raw, label, DATA_FIELDS)
        if item is None or not _required(ctx, item, DATA_FIELDS, label):
            continue
        scenario = item.get("scenario")
        if not isinstance(scenario, str) or not scenario.strip():
            ctx.error("runtime_data_scenario_invalid", f"{label}.scenario 不能为空")
        elif scenario in scenarios:
            ctx.error("runtime_data_duplicate", f"数据场景 {scenario} 重复声明")
        else:
            scenarios.add(scenario)
        _text(ctx, item.get("input"), f"{label}.input", min_len=2)
        _expected_observed(ctx, item, label)
        _refs(ctx, item.get("evidence_refs"), f"{label}.evidence_refs")
        ctx.stats["data"] += 1
    for group in required_groups:
        if not any(name in scenarios for name in group):
            ctx.error("runtime_data_missing", "缺少必需数据场景之一：" + "/".join(group))


def _validate_ui(ctx: _Context) -> None:
    ui = _object(ctx, ctx.packet.get("ui"), "ui", UI_FIELDS)
    if ui is None or not _required(ctx, ui, ("applicable",), "ui"):
        return
    applicable = ui.get("applicable")
    if not isinstance(applicable, bool):
        ctx.error("runtime_ui_invalid", "ui.applicable 必须是 true/false")
        return
    surface = ctx.packet.get("surface")
    if surface in UI_SURFACES:
        if not applicable:
            ctx.error("runtime_ui_missing", "UI 运行态证据不能声明 ui.applicable=false")
            return
        if not _required(ctx, ui, UI_FIELDS, "ui"):
            return
        _validate_ui_details(ctx, ui)
    elif applicable:
        ctx.error("runtime_ui_unexpected", "非 UI 任务不要声明 ui.applicable=true")
    else:
        _text(ctx, ui.get("reason"), "ui.reason", min_len=12)
        if ui.get("viewports") not in (None, []):
            ctx.error("runtime_ui_unexpected", "非 UI 任务不要填写 viewports")
        if ui.get("evidence_refs") not in (None, []):
            ctx.error("runtime_ui_unexpected", "非 UI 任务不要填写 ui.evidence_refs")
        for key in UI_CHECK_KEYS:
            if ui.get(key) not in (None, {}):
                ctx.error("runtime_ui_unexpected", f"非 UI 任务不要填写 {key}")


def _validate_ui_details(ctx: _Context, ui: dict[str, Any]) -> None:
    if ui.get("reason") not in (None, ""):
        ctx.error("runtime_ui_invalid", "UI 适用时不要填写 ui.reason")
    viewports = ui.get("viewports")
    if not isinstance(viewports, list) or len(viewports) < 2:
        ctx.error("runtime_ui_viewports", "UI 证据至少需要 2 个视口")
        viewports = viewports if isinstance(viewports, list) else []
    sizes: set[str] = set()
    image_hashes: list[tuple[str, str]] = []
    for index, raw in enumerate(viewports):
        label = f"ui.viewports[{index}]"
        viewport = _object(ctx, raw, label, VIEWPORT_FIELDS)
        if viewport is None or not _required(ctx, viewport, VIEWPORT_FIELDS, label):
            continue
        _text(ctx, viewport.get("name"), f"{label}.name", min_len=2)
        size = viewport.get("size")
        if not isinstance(size, str) or not VIEWPORT_PATTERN.fullmatch(size):
            ctx.error("runtime_ui_viewport_size", f"{label}.size 必须形如 1440x900")
        elif size in sizes:
            ctx.error("runtime_ui_viewport_duplicate", f"视口尺寸 {size} 重复，不能用同一尺寸冒充多视口")
        else:
            sizes.add(size)
        refs = _refs(ctx, viewport.get("evidence_refs"), f"{label}.evidence_refs", require_image=True)
        for ref in refs:
            if _is_image(ref):
                image_hashes.append((ref.name, _file_hash(ref)))
        ctx.stats["viewports"] += 1
    if len(image_hashes) >= 2 and len({digest for _, digest in image_hashes}) == 1:
        ctx.error("runtime_ui_viewports_duplicate", "不同视口使用了完全相同的截图，必须提供真实的多视口证据")
    for key, required_keys in UI_CHECK_KEYS.items():
        checks = _object(ctx, ui.get(key), f"ui.{key}", required_keys)
        if checks is None or not _required(ctx, checks, required_keys, f"ui.{key}"):
            continue
        for check_key in required_keys:
            _text(ctx, checks.get(check_key), f"ui.{key}.{check_key}", min_len=12)
    _refs(ctx, ui.get("evidence_refs"), "ui.evidence_refs", require_image=True)


def _validate_probes(ctx: _Context) -> None:
    probes = ctx.packet.get("probes")
    if not isinstance(probes, list):
        return
    risk = ctx.packet.get("risk")
    surface = ctx.packet.get("surface")
    minimum = 2 if risk == "complex" else 1
    if len(probes) < minimum:
        ctx.error("runtime_probe_missing", f"probes 至少需要 {minimum} 次对抗性探测")
    intents: list[str] = []
    names: set[str] = set()
    for index, raw in enumerate(probes):
        label = f"probes[{index}]"
        probe = _object(ctx, raw, label, PROBE_FIELDS)
        if probe is None or not _required(ctx, probe, PROBE_FIELDS, label):
            continue
        _text(ctx, probe.get("name"), f"{label}.name", min_len=4)
        name = probe.get("name")
        if isinstance(name, str):
            if name in names:
                ctx.error("runtime_probe_duplicate", f"探测名 {name} 重复声明")
            names.add(name)
        intent = probe.get("intent")
        if intent not in PROBE_INTENTS:
            ctx.error("runtime_probe_intent_invalid", f"{label}.intent 仅接受 " + "/".join(PROBE_INTENTS))
        else:
            intents.append(intent)
        _text(ctx, probe.get("result"), f"{label}.result", min_len=12)
        _refs(ctx, probe.get("evidence_refs"), f"{label}.evidence_refs")
        ctx.stats["probes"] += 1
    if surface in UI_SURFACES:
        if not any(intent in ("invalid", "edge", "abuse") for intent in intents):
            ctx.error("runtime_probe_missing", "UI 任务至少要有一次 invalid/edge/abuse 探测")
        if not any(intent in ("recovery", "permission") for intent in intents):
            ctx.error("runtime_probe_missing", "UI 任务至少要有一次 recovery/permission 探测")


def _validate_defects_and_iterations(ctx: _Context) -> None:
    defects = ctx.packet.get("defects")
    iterations = ctx.packet.get("iterations")
    defect_count = _validate_defects(ctx, defects) if isinstance(defects, list) else 0
    ctx.stats["defects"] = defect_count
    if not isinstance(iterations, list):
        return
    if not iterations:
        ctx.error("runtime_iteration_missing", "iterations 至少需要 1 轮")
        return
    passes: list[int] = []
    statuses: list[str] = []
    for index, raw in enumerate(iterations):
        label = f"iterations[{index}]"
        iteration = _object(ctx, raw, label, ITERATION_FIELDS)
        if iteration is None or not _required(ctx, iteration, ITERATION_FIELDS, label):
            continue
        number = iteration.get("pass")
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            ctx.error("runtime_iteration_invalid", f"{label}.pass 必须是正整数")
        else:
            passes.append(number)
        status = iteration.get("status")
        if status not in ("passed", "failed"):
            ctx.error("runtime_iteration_invalid", f"{label}.status 仅接受 passed/failed")
        else:
            statuses.append(status)
        _text(ctx, iteration.get("summary"), f"{label}.summary", min_len=12)
        _refs(ctx, iteration.get("evidence_refs"), f"{label}.evidence_refs")
        ctx.stats["iterations"] += 1
    if passes != list(range(1, len(passes) + 1)):
        ctx.error("runtime_iteration_invalid", "iterations.pass 必须从 1 开始连续编号")
    if statuses and statuses[-1] != "passed":
        ctx.error("runtime_iteration_unclosed", "最后一轮必须是 passed")
    if defect_count:
        if len(statuses) < 2 or "failed" not in statuses[:-1]:
            ctx.error("runtime_defect_unclosed", "有缺陷时必须保留首次失败轮，并在修复后完成最终通过轮")
        _require_absent(ctx, "no_defect_rationale", "有缺陷时不要填写 no_defect_rationale")
    else:
        if any(status == "failed" for status in statuses):
            ctx.error("runtime_iteration_unexpected", "defects 为空时不要在 iterations 中保留失败轮")
        _text(ctx, ctx.packet.get("no_defect_rationale"), "no_defect_rationale", min_len=30)


def _validate_defects(ctx: _Context, defects: list[Any]) -> int:
    count = 0
    for index, raw in enumerate(defects):
        label = f"defects[{index}]"
        defect = _object(ctx, raw, label, DEFECT_FIELDS)
        if defect is None or not _required(ctx, defect, DEFECT_FIELDS, label):
            continue
        _text(ctx, defect.get("summary"), f"{label}.summary", min_len=12)
        if defect.get("severity") not in SEVERITIES:
            ctx.error("runtime_defect_invalid", f"{label}.severity 仅接受 " + "/".join(SEVERITIES))
        _text(ctx, defect.get("fix"), f"{label}.fix", min_len=12)
        _text(ctx, defect.get("recheck"), f"{label}.recheck", min_len=12)
        _refs(ctx, defect.get("evidence_refs"), f"{label}.evidence_refs")
        count += 1
    return count


def _validate_uncovered(ctx: _Context) -> None:
    uncovered = ctx.packet.get("uncovered")
    if not isinstance(uncovered, list):
        return
    for index, item in enumerate(uncovered):
        if not isinstance(item, str) or not item.strip():
            ctx.error("runtime_uncovered_invalid", f"uncovered[{index}] 必须是非空字符串")
        elif len(item.strip()) < 8:
            ctx.error("runtime_uncovered_invalid", f"uncovered[{index}] 至少写 8 个字，说明具体遗留风险")


def _refs(
    ctx: _Context,
    value: Any,
    label: str,
    *,
    require_image: bool = False,
) -> list[Path]:
    if not isinstance(value, list) or not value:
        ctx.error("runtime_packet_evidence_missing", f"{label} 至少需要 1 个证据文件", label)
        return []
    resolved: list[Path] = []
    for index, ref in enumerate(value):
        path = _ref_path(ctx, ref, f"{label}[{index}]")
        if path is not None:
            resolved.append(path)
    if require_image and not any(_is_image(path) for path in resolved):
        ctx.error("runtime_packet_evidence_image_missing", f"{label} 至少需要 1 张图片证据", label)
    return resolved


def _ref_path(ctx: _Context, ref: Any, label: str) -> Path | None:
    if not isinstance(ref, str) or not ref.strip():
        ctx.error("runtime_packet_evidence_invalid", f"{label} 必须是非空字符串", label)
        return None
    if Path(ref).is_absolute() or ".." in Path(ref).parts or "\\" in ref:
        ctx.error("runtime_packet_evidence_invalid", f"{label} 必须是 evidence/ 下的相对路径", label)
        return None
    if not ref.replace("\\", "/").startswith("evidence/"):
        ctx.error("runtime_packet_evidence_invalid", f"{label} 必须放在 evidence/ 目录下", label)
        return None
    path = (ctx.packet_dir / ref).resolve()
    if not path.is_relative_to(ctx.packet_dir.resolve()):
        ctx.error("runtime_packet_evidence_invalid", f"{label} 越出证据包目录", label)
        return None
    if not path.is_file():
        ctx.error("runtime_packet_evidence_missing", f"证据文件不存在：{ref}", label)
        return None
    size = path.stat().st_size
    if size < 20:
        ctx.error("runtime_packet_evidence_empty", f"证据文件为空或过小：{ref}", label)
        return None
    if _is_image(path) and size < 1024:
        ctx.error("runtime_packet_evidence_image_small", f"图片证据过小，疑似占位文件：{ref}", label)
    key = str(path)
    if key not in ctx.evidence:
        ctx.evidence[key] = path
        if _is_image(path):
            ctx.evidence_hashes[key] = _file_hash(path)
    ignored = _git_ignored(ctx.target, path)
    if ctx.root_kind == "committed" and ignored:
        ctx.error("runtime_packet_evidence_ignored", f"提交路径下的证据不能位于 git 忽略目录：{ref}", label)
    return path


def _is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_SUFFIXES


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _git_ignored(target: Path, path: Path) -> bool | None:
    inside = subprocess.run(
        ["git", "-C", str(target), "rev-parse", "--is-inside-work-tree"],
        capture_output=True, text=True, check=False,
    )
    if inside.returncode != 0:
        return None
    result = subprocess.run(
        ["git", "-C", str(target), "check-ignore", "-q", "--", str(path)],
        capture_output=True, text=True, check=False,
    )
    if result.returncode == 0:
        return True
    if result.returncode == 1:
        return False
    return None
