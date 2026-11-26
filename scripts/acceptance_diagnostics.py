"""Acceptance 失败诊断：把待处理标准、期望值与下一步命令放进错误 payload。"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from managed_assets import AssetError
from runtime_check import check_packet
from runtime_packet import is_live_e2e_criterion, is_runtime_packet_ref


def criteria_state(current: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"id": item["id"], "title": item["title"], "status": item["status"]}
        for item in current["criteria"]
    ]


def pending_criteria(current: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in criteria_state(current) if item["status"] == "pending"]


def pending_hint(current: dict[str, Any], requested: str) -> str:
    pending = pending_criteria(current)
    if pending:
        ids = "、".join(item["id"] for item in pending)
        return (
            f"仍有 pending 标准：{ids}；先逐条 acceptance record（或 settle --input），"
            f"再以 --status {requested} 重试；acceptance show --acceptance <path> 查看逐条状态"
        )
    return (
        f"逐条聚合状态为 {current['status']}；如需改为 {requested}，"
        "先修复并 --reaccept 失败标准，或改传与聚合状态一致的 --status"
    )


def criterion_details(current: dict[str, Any], criterion_id: str) -> dict[str, Any]:
    return {
        "criterion_id": criterion_id,
        "available_criteria": [item["id"] for item in current["criteria"]],
        "pending_criteria": [item["id"] for item in pending_criteria(current)],
        "criteria": criteria_state(current),
    }


def find_criterion(current: dict[str, Any], criterion_id: str) -> dict[str, Any]:
    criterion = next((item for item in current["criteria"] if item["id"] == criterion_id), None)
    if criterion is None:
        raise AssetError(
            "criterion_id 不存在",
            "acceptance_criterion_missing",
            details=criterion_details(current, criterion_id),
            next_action="用 acceptance show --acceptance <path> 查看可用 criterion id",
        )
    return criterion


def match_record_to_criterion(
    criterion: dict[str, Any],
    record_value: dict[str, Any],
    evidence_layers: dict[str, str],
) -> None:
    """校验单条记录与目标 criterion 的三要素（acceptance_type/layer/evidence_layer 同层）。"""
    for key in ("acceptance_type", "layer"):
        if criterion[key] != record_value.get(key):
            raise AssetError(
                f"验收记录与 criterion 的 {key} 不一致",
                "acceptance_record_mismatch",
                details={
                    "criterion_id": criterion.get("id"),
                    "field": key,
                    "expected": criterion[key],
                    "actual": record_value.get(key),
                },
                next_action="按 criterion 的 acceptance_type/layer 重新生成验收记录",
            )
    criterion_evidence = criterion["evidence_layer"]
    record_evidence = record_value.get("evidence_layer")
    if criterion_evidence is None:
        if record_evidence is not None:
            raise AssetError(
                "验收记录与 criterion 的 evidence_layer 不一致",
                "acceptance_record_mismatch",
                details={
                    "criterion_id": criterion.get("id"),
                    "field": "evidence_layer",
                    "expected": None,
                    "actual": record_evidence,
                },
                next_action="contract_check/user_acceptance 记录不要填 evidence_layer",
            )
    elif evidence_layers.get(record_evidence) != criterion["layer"]:
        raise AssetError(
            "验收记录与 criterion 的 evidence_layer 不一致",
            "acceptance_record_mismatch",
            details={
                "criterion_id": criterion.get("id"),
                "field": "evidence_layer",
                "expected_layer": criterion["layer"],
                "actual": record_evidence,
            },
            next_action="按 criterion 的 layer 选择匹配的 evidence_layer",
        )


def criterion_not_pending_error(current: dict[str, Any], criterion_id: str) -> AssetError:
    status = find_criterion(current, criterion_id)["status"]
    return AssetError(
        "settle 只接受当前 pending 的 criterion，已验收的改写请走 --reaccept",
        "acceptance_settle_criterion_not_pending",
        details={
            "criterion_id": criterion_id,
            "criterion_status": status,
            **criterion_details(current, criterion_id),
        },
        next_action="只提交当前 pending 的标准；已验收标准要改写请用 acceptance record --reaccept",
    )


def settle_mismatch_error(current: dict[str, Any], status: str) -> AssetError:
    return AssetError(
        f"结项状态 {status} 与逐条验收聚合状态 {current['status']} 不一致",
        "acceptance_settle_mismatch",
        details={
            "requested_status": status,
            "aggregate_status": current["status"],
            "pending_criteria": [item["id"] for item in pending_criteria(current)],
            "criteria": criteria_state(current),
        },
        next_action=pending_hint(current, status),
    )


def verify_record_runtime_evidence(
    target: Path,
    asset: dict[str, Any],
    raw_asset: str | None,
    criterion: dict[str, Any],
    record_value: dict[str, Any],
) -> None:
    """校验 passed 验收记录引用的运行态证据包，并对 live_e2e 实机标准强制绑定提交态证据包。"""
    if record_value.get("status") != "passed":
        return
    refs = [ref for ref in record_value.get("evidence_refs", []) if isinstance(ref, str) and is_runtime_packet_ref(ref)]
    needs_live = bool(asset.get("live_e2e")) and is_live_e2e_criterion(criterion)
    expected_ref = raw_asset.replace("\\", "/") if raw_asset else None
    matched_live = False
    for ref in refs:
        result = check_packet(target, target / ref)
        if result.get("status") != "passed":
            raise AssetError(
                f"引用的运行态证据包未通过 runtime check：{ref}",
                "acceptance_runtime_packet_invalid",
                details={"packet_ref": ref, "errors": result.get("errors", [])},
                next_action=f"修复证据包并通过 python3 scripts/harness.py runtime check --target . --packet {ref} --json 后重试",
            )
        if not needs_live or result.get("root_kind") != "committed":
            continue
        packet = json.loads((target / ref).read_text(encoding="utf-8-sig"))
        packet_acc = str(packet.get("acceptance_ref") or "").replace("\\", "/")
        flows = packet.get("flows", [])
        covers = any(isinstance(item, dict) and item.get("criterion_id") == criterion["id"] for item in flows)
        if covers and (expected_ref is None or packet_acc == expected_ref):
            matched_live = True
    if needs_live and not matched_live:
        raise AssetError(
            f"live_e2e 实机标准 {criterion['id']} 必须附带关联本验收且通过 runtime check 的提交态证据包",
            "acceptance_live_e2e_packet_required",
            details={"criterion_id": criterion["id"], "acceptance_ref": expected_ref},
            next_action="在 evidence_refs 中提供包含 acceptance_ref 与该 criterion_id 的 docs/runtime-verification/<task>/packet.json",
        )
