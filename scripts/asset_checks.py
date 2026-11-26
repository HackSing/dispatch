"""Plan、Knowledge、Acceptance 检查结果的统一编排层。"""

from __future__ import annotations

import datetime as dt
import json
import subprocess
from pathlib import Path
from typing import Any, Callable

from acceptance_assets import ACCEPTANCE_SPEC, validate_asset as validate_acceptance
from knowledge_assets import KNOWLEDGE_SPEC, validate_asset as validate_knowledge
from managed_assets import AssetError, load_asset
from plan_governance import (
    PLAN_SCHEMA_V2,
    PLAN_SCHEMA_V3,
    PlanGovernanceError,
    validate_plan,
)
from runtime_check import RUNTIME_VERIFICATION_COMMITTED, check_packet


AssetChecker = Callable[[Path], dict[str, Any]]
PlanChecker = Callable[[Path, bool], dict[str, Any]]
ASSET_STALE_DAYS = 90
PLAN_AMEND_GRACE_DAYS = 30
WARNING_PREVIEW_LIMIT = 5
AGENTS_FILE_MAX_BYTES = 24_000
MANAGED_PROMPT_MAX_BYTES = 18_000


def _warning_group(warning: str) -> tuple[str, bool]:
    """WARN 分组与可行动性；「代码很可能已交付」是可人工裁决的提示，不算可行动。"""
    text = warning[6:] if warning.startswith("WARN: ") else warning
    if "代码很可能已交付" in text:
        return "plan.delivery_hint", False
    if "docs/plans/" in text or "docs/INDEX.md" in text:
        if "冻结超过" in text:
            return "plan.stale", True
        if "关联 Acceptance" in text or "Plan 仍未 settle" in text:
            return "plan.settlement", True
        if "零命中" in text or "索引已失活" in text:
            return "plan.symbol", True
        if "INDEX" in text:
            return "plan.index", True
        if "amend" in text:
            return "plan.amend", True
        return "plan.other", True
    if "CODEMAP" in text:
        return "structure.codemap", True
    if "Structure:" in text or "结构" in text:
        return "structure.size", True
    if "ADR:" in text:
        return "adr.projection", True
    if "Knowledge:" in text:
        return "knowledge.projection", True
    if "Acceptance:" in text:
        return "acceptance.projection", True
    if "ScriptHygiene:" in text:
        return "script_hygiene", True
    if text.startswith("AGENTS.md:"):
        return "entry.budget", True
    if text.startswith(f"{RUNTIME_VERIFICATION_COMMITTED}/"):
        return "runtime.verification", True
    return "other", True


def summarize_warnings(warnings: list[str]) -> dict[str, Any]:
    """把 WARN 按类别聚合，给默认输出一个短摘要，完整列表仍保留在 warnings。"""
    groups: dict[str, dict[str, Any]] = {}
    actionable = 0
    for warning in warnings:
        group, is_actionable = _warning_group(warning)
        entry = groups.setdefault(
            group,
            {"group": group, "count": 0, "actionable": is_actionable},
        )
        entry["count"] += 1
        actionable += 1 if is_actionable else 0
    ordered = sorted(groups.values(), key=lambda item: (-item["actionable"], -item["count"], item["group"]))
    unique = len(set(warnings))
    return {
        "total": len(warnings),
        "unique": unique,
        "duplicates": len(warnings) - unique,
        "actionable": actionable,
        "advisory": len(warnings) - actionable,
        "groups": ordered,
    }


def preview_warnings(warnings: list[str], limit: int = WARNING_PREVIEW_LIMIT) -> list[str]:
    """默认展示的 WARN 预览：可行动项优先，提示项靠后。"""
    actionable = [item for item in warnings if _warning_group(item)[1]]
    advisory = [item for item in warnings if not _warning_group(item)[1]]
    return (actionable + advisory)[:limit]


def _run_asset_checker(target: Path, label: str, checker: AssetChecker) -> dict[str, Any]:
    try:
        return checker(target)
    except AssetError as exc:
        return {
            "status": "failed",
            "failures": [f"{label}：{exc}"],
            "warnings": [],
            "checked": 0,
        }


def _load_plan_path(target: Path, raw: str) -> tuple[Path, dict[str, Any]]:
    relative = Path(raw)
    path = target / relative
    if not path.is_file() and relative.parent.as_posix() == "docs/plans":
        path = target / "docs/plans/archive" / relative.name
    if not path.is_file() or path.is_symlink():
        raise AssetError(f"Plan 引用不存在：{raw}")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return path, validate_plan(value)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise AssetError(f"Plan 引用无法读取：{raw}") from exc


def _plan_stale_anchor(plan: dict[str, Any]) -> Any:
    anchor = plan.get("frozen_at")
    last_amended = plan.get("last_amended_at")
    if isinstance(last_amended, str) and (
        not isinstance(anchor, str) or last_amended > anchor
    ):
        return last_amended
    return anchor


def _plan_amend_log(plan: dict[str, Any], governance: Any) -> list[Any] | None:
    if isinstance(governance, dict):
        log = governance.get("amend_log")
        if log:
            return log
    return plan.get("amend_log")


def plan_amend_recently(value: Any, now: dt.datetime) -> bool:
    """修订次数达到提示阈值，但最近一次修订仍在宽限期内。

    同一轮定案常连续 amend 多次；修订当天就提示 settle 只会制造噪音。
    超过宽限期仍按原规则提示，避免长期未决方案逃逸。
    """
    if not isinstance(value, dict):
        return False
    raw = value.get("last_amended_at")
    if not isinstance(raw, str):
        log = value.get("amend_log")
        if isinstance(log, list) and log and isinstance(log[-1], dict):
            raw = log[-1].get("amended_at")
    if not isinstance(raw, str):
        return False
    try:
        moment = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=dt.timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=dt.timezone.utc)
    return dt.timedelta(0) <= (now - moment) <= dt.timedelta(days=PLAN_AMEND_GRACE_DAYS)


def _plan_amend_warning(
    plan: dict[str, Any], governance: Any, plan_ref: str
) -> str | None:
    log = _plan_amend_log(plan, governance)
    if not isinstance(log, list) or len(log) < 3:
        return None
    if isinstance(governance, dict) and governance.get("governance_settled_at"):
        return None
    reviewed = governance if isinstance(governance, dict) else plan
    if plan_amend_recently(reviewed, dt.datetime.now(dt.timezone.utc)):
        return None
    return (
        f"WARN: {plan_ref}: amend 已达 {len(log)} 次，"
        "请核对是否应 plan settle --status implemented|deprecated"
    )


def _is_stale(raw: Any, now: dt.datetime) -> bool:
    if not isinstance(raw, str):
        return False
    try:
        moment = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return False
    return now - moment > dt.timedelta(days=ASSET_STALE_DAYS)


def _check_plan_relations(
    target: Path,
    path: Path,
    plan: dict[str, Any],
    now: dt.datetime,
) -> tuple[list[str], list[str]]:
    failures: list[str] = []
    warnings: list[str] = []
    if plan["schema_version"] == PLAN_SCHEMA_V2:
        return failures, warnings
    relative_plan = path.relative_to(target)
    plan_ref = (
        f"docs/plans/{path.name}"
        if relative_plan.parent.as_posix() == "docs/plans/archive"
        else relative_plan.as_posix()
    )
    refs = plan.get("acceptance_refs", [])
    governance = plan.get("governance")
    if isinstance(governance, dict) and not governance["acceptance_required"] and refs:
        warnings.append(f"WARN: {plan_ref}: acceptance_required=false 但存在关联 Acceptance")
    linked: list[dict[str, Any]] = []
    for ref in refs:
        try:
            acceptance = load_asset(target / ref, ACCEPTANCE_SPEC)
            validate_acceptance(acceptance)
        except AssetError as exc:
            failures.append(f"FAIL: {plan_ref}: 关联 Acceptance 无效：{ref}：{exc}")
            continue
        linked.append(acceptance)
        if acceptance.get("plan_ref") != plan_ref:
            failures.append(f"FAIL: {plan_ref}: 与 {ref} 的正反向引用不一致")
    # 结算泄漏预警：关联验收已全部结项但 Plan 仍挂着未 settle，活索引会随之淤积。
    if (
        linked
        and len(linked) == len(refs)
        and all(item.get("settled_at") for item in linked)
        and isinstance(governance, dict)
        and not governance.get("governance_settled_at")
        and relative_plan.parent.as_posix() != "docs/plans/archive"
    ):
        warnings.append(
            f"WARN: {plan_ref}: 关联 Acceptance 已全部结项，Plan 仍未 settle"
            "（plan settle --status implemented|deprecated）"
        )
    # 结算泄漏预警（超期形态）：方案冻结后长期不 settle，活索引随之淤积。
    if (
        relative_plan.parent.as_posix() != "docs/plans/archive"
        and isinstance(governance, dict)
        and not governance.get("governance_settled_at")
        and _is_stale(_plan_stale_anchor(plan), now)
    ):
        warnings.append(
            f"WARN: {plan_ref}: 冻结超过 {ASSET_STALE_DAYS} 天仍未 settle"
            "（plan settle --status implemented|deprecated）"
        )
    amend_warning = _plan_amend_warning(plan, governance, plan_ref)
    if amend_warning:
        warnings.append(amend_warning)
    if not isinstance(governance, dict) or not governance.get("governance_settled_at"):
        return failures, warnings
    if governance.get("knowledge_impact") != "updated":
        return failures, warnings
    for ref in governance.get("updated_knowledge_refs", []):
        try:
            knowledge = load_asset(target / ref, KNOWLEDGE_SPEC)
            validate_knowledge(knowledge)
        except AssetError as exc:
            failures.append(f"FAIL: {plan_ref}: 结算 Knowledge 无效：{ref}：{exc}")
            continue
        if knowledge.get("status") != "active":
            failures.append(f"FAIL: {plan_ref}: 结算 Knowledge 非 active：{ref}")
    return failures, warnings


def check_cross_asset_relations(target: Path, *, fast: bool = False) -> dict[str, Any]:
    failures: list[str] = []
    warnings: list[str] = []
    plan_paths = sorted((target / "docs/plans").glob("*.json"))
    plan_paths.extend(sorted((target / "docs/plans/archive").glob("*.json")))
    now = dt.datetime.now(dt.timezone.utc)
    for path in plan_paths:
        try:
            plan = validate_plan(json.loads(path.read_text(encoding="utf-8")))
            plan_failures, plan_warnings = _check_plan_relations(target, path, plan, now)
            failures.extend(plan_failures)
            warnings.extend(plan_warnings)
        except (
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            AssetError,
            PlanGovernanceError,
        ) as exc:
            failures.append(f"FAIL: {path.relative_to(target)}: {exc}")
    acceptance_paths = sorted((target / ACCEPTANCE_SPEC.root).glob("*.json"))
    for path in acceptance_paths:
        try:
            acceptance = load_asset(path, ACCEPTANCE_SPEC)
            validate_acceptance(acceptance)
        except AssetError:
            continue
        ref = acceptance.get("plan_ref")
        if not ref:
            continue
        relative = path.relative_to(target).as_posix()
        try:
            plan_path, plan = _load_plan_path(target, ref)
        except (AssetError, PlanGovernanceError) as exc:
            failures.append(f"FAIL: {relative}: {exc}")
            continue
        if plan["schema_version"] == PLAN_SCHEMA_V3:
            if relative not in plan.get("acceptance_refs", []):
                failures.append(f"FAIL: {relative}: 未登记到 Plan.acceptance_refs")
        elif acceptance.get("status") == "pending":
            warnings.append(f"WARN: {relative}: 关联 v2 Plan，无法建立反向登记")
        if acceptance.get("status") != "pending":
            continue
        if "archive" in plan_path.relative_to(target).parts:
            warnings.append(
                f"WARN: {relative}: pending Acceptance 指向已归档 Plan"
                "（方案已废弃或工作已迁出时，用 acceptance settle --status deprecated 归档）"
            )
        if _is_stale(acceptance.get("updated_at"), now):
            warnings.append(
                f"WARN: {relative}: pending 超过 {ASSET_STALE_DAYS} 天仍未结项"
            )
    runtime_failures, runtime_warnings, runtime_checked = _check_committed_runtime_packets(target, fast=fast)
    failures.extend(runtime_failures)
    warnings.extend(runtime_warnings)
    return {
        "status": "failed" if failures else "passed",
        "failures": failures,
        "warnings": warnings,
        "checked": len(plan_paths) + len(acceptance_paths) + runtime_checked,
    }


def _changed_runtime_tasks(target: Path) -> set[str] | None:
    inside = subprocess.run(
        ["git", "-C", str(target), "rev-parse", "--is-inside-work-tree"],
        capture_output=True, text=True, check=False,
    )
    if inside.returncode != 0:
        return None
    status = subprocess.run(
        ["git", "-C", str(target), "status", "--porcelain", "-z", "--", RUNTIME_VERIFICATION_COMMITTED],
        capture_output=True, check=False,
    )
    if status.returncode != 0:
        return None
    prefix = f"{RUNTIME_VERIFICATION_COMMITTED}/"
    tasks: set[str] = set()
    for entry in status.stdout.decode("utf-8", errors="replace").split("\0"):
        if len(entry) < 4:
            continue
        rel = entry[3:].replace("\\", "/")
        if rel.startswith(prefix):
            rest = rel[len(prefix):].split("/", 1)[0]
            if rest and rest != "README.md":
                tasks.add(rest)
    return tasks


def _packet_has_acceptance_ref(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(data, dict) and bool(data.get("acceptance_ref"))


def _check_committed_runtime_packets(target: Path, *, fast: bool) -> tuple[list[str], list[str], int]:
    """校验随仓库提交的 docs/runtime-verification/*/packet.json 证据包。

    --fast 仅校验本次改动的或带 acceptance_ref 的提交态证据包（保持 pre-commit 秒级响应）；
    全量检查校验全部提交态包，未改动的存量无关联历史坏包降级为 runtime.verification WARN。"""
    root = target / RUNTIME_VERIFICATION_COMMITTED
    if not root.is_dir():
        return [], [], 0
    packets = sorted(root.glob("*/packet.json"))
    changed_tasks = _changed_runtime_tasks(target)
    failures: list[str] = []
    warnings: list[str] = []
    checked = 0
    for path in packets:
        has_acc_ref = _packet_has_acceptance_ref(path)
        is_touched = changed_tasks is None or path.parent.name in changed_tasks
        if fast and not is_touched and not has_acc_ref:
            continue
        checked += 1
        relative = path.relative_to(target).as_posix()
        result = check_packet(target, path)
        if result.get("status") != "passed":
            summary = "；".join(
                str(item.get("message", item.get("code", "invalid")))
                for item in result.get("errors", [])[:3]
            )
            if is_touched or has_acc_ref:
                failures.append(f"FAIL: {relative}: 运行态证据包校验失败：{summary}")
            else:
                warnings.append(f"WARN: {relative}: 存量运行态证据包校验未通过：{summary}")
        for item in result.get("warnings", []):
            warnings.append(f"WARN: {relative}: {item.get('message', item.get('code', 'warning'))}")
    return failures, warnings, checked


def check_agents_file_budget(target: Path) -> list[str]:
    """检查完整 AGENTS.md 字节数，防止超出 Antigravity 24 KB 单文件上限被截断。"""
    path = target / "AGENTS.md"
    if not path.is_file() or path.is_symlink():
        return []
    try:
        size = path.stat().st_size
    except OSError:
        return []
    if size > AGENTS_FILE_MAX_BYTES:
        return [
            f"WARN: AGENTS.md: 文件大小 {size} 字节超过 {AGENTS_FILE_MAX_BYTES} 字节上限，"
            "在 Antigravity 等宿主中尾部规则会被截断，请精简块外规则或拆到按需文档"
        ]
    return []


def run_assets_check(
    target: Path,
    *,
    fast: bool,
    strict: bool,
    plan_checker: PlanChecker,
    knowledge_checker: AssetChecker,
    acceptance_checker: AssetChecker,
    adr_checker: AssetChecker,
    script_hygiene_checker: AssetChecker,
    structure_checker: AssetChecker,
) -> dict[str, Any]:
    plans = plan_checker(target, fast)
    knowledge = _run_asset_checker(target, "Knowledge", knowledge_checker)
    acceptance = _run_asset_checker(target, "Acceptance", acceptance_checker)
    adr = _run_asset_checker(target, "ADR", adr_checker)
    script_hygiene = _run_asset_checker(target, "ScriptHygiene", script_hygiene_checker)
    structure = _run_asset_checker(target, "Structure", structure_checker)
    cross = check_cross_asset_relations(target, fast=fast)
    failures = list(plans.get("failures", []))
    warnings = list(plans.get("warnings", []))
    for label, payload in (
        ("Knowledge", knowledge),
        ("Acceptance", acceptance),
        ("ADR", adr),
        ("ScriptHygiene", script_hygiene),
        ("Structure", structure),
    ):
        failures.extend(f"FAIL: {label}: {item}" for item in payload.get("failures", []))
        warnings.extend(f"WARN: {label}: {item}" for item in payload.get("warnings", []))
    failures.extend(cross["failures"])
    warnings.extend(cross["warnings"])
    warnings.extend(check_agents_file_budget(target))
    failed = bool(failures) or (strict and bool(warnings))
    status = "failed" if failed else "passed"
    return {
        "status": status,
        "strict": strict,
        "fast": fast,
        "checked": {
            "plans": plans.get("checked", {}),
            "knowledge": knowledge.get("checked", 0),
            "acceptance": acceptance.get("checked", 0),
            "adr": adr.get("checked", 0),
            "script_hygiene": script_hygiene.get("checked", 0),
            "structure": structure.get("checked", 0),
            "cross": cross.get("checked", 0),
        },
        "failures": failures,
        "warnings": warnings,
        "warning_summary": summarize_warnings(warnings),
        "summary": (
            f"assets-check {status}：Plan/Knowledge/Acceptance/ADR/ScriptHygiene/Structure 已检查，"
            f"违规 {len(failures)} 条、警告 {len(warnings)} 条"
        ),
    }
