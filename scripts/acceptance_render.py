"""Acceptance Markdown 投影渲染。"""

from __future__ import annotations

from typing import Any


def _criterion_markdown(criterion: dict[str, Any]) -> str:
    records = criterion["records"]
    latest = records[-1] if records else None
    evidence = "、".join(f"`{ref}`" for ref in latest.get("evidence_refs", [])) if latest else "尚无"
    lines = [
        f"### `{criterion['id']}` {criterion['title']}",
        "",
        f"- 状态：{criterion['status']}",
        f"- 类型：{criterion['acceptance_type']}",
        f"- 层级：{criterion['layer']}",
    ]
    if criterion.get("pass_criteria"):
        lines.append(f"- 通过标准：{criterion['pass_criteria']}")
    if criterion.get("fail_criteria"):
        lines.append(f"- 失败判定：{criterion['fail_criteria']}")
    lines.append(f"- 证据：{evidence}")
    return "\n".join(lines)


def _live_e2e_markdown(live_e2e: dict[str, Any] | None) -> str:
    if not isinstance(live_e2e, dict):
        return ""
    deps = "、".join(live_e2e.get("real_dependencies", []))
    confirm = "是（冻结清单后先停下等用户确认再跑实机）" if live_e2e.get("confirm_before_run") else "否（已授权直接执行）"
    return (
        "\n\n## 实机全量验收契约（live_e2e）\n\n"
        f"- 目标环境：{live_e2e['environment']}\n"
        f"- 真实依赖（禁 mock）：{deps}\n"
        f"- 隔离与清理：{live_e2e['isolation_and_cleanup']}\n"
        f"- 重部署方式：`{live_e2e['deploy_command']}`\n"
        f"- 单缺陷熔断上限：{live_e2e['max_fix_rounds']} 轮\n"
        f"- 执行前确认门：{confirm}"
    )


def render_markdown(asset: dict[str, Any]) -> str:
    from acceptance_assets import ACCEPTANCE_SPEC, STATUS_LABELS

    symbols = "、".join(f"`{item}`" for item in asset["key_symbols"])
    criteria = "\n\n".join(_criterion_markdown(item) for item in asset["criteria"])
    refs = []
    if asset.get("plan_ref"):
        refs.append(f"- 关联方案：`{asset['plan_ref']}`")
    if asset.get("knowledge_refs"):
        refs.append("- 关联知识：" + "、".join(f"`{item}`" for item in asset["knowledge_refs"]))
    if asset["status"] == "deprecated":
        destination = asset.get("replacement")
        refs.append(f"- 去向：`{destination}`" if destination else "- 去向：未注明")
    elif asset.get("replacement"):
        refs.append(f"- 替代资产：`{asset['replacement']}`")
    return (
        f"> 状态：{STATUS_LABELS[asset['status']]}\n{ACCEPTANCE_SPEC.marker}\n\n# {asset['title']}\n\n"
        f"- 修订：{asset['revision']}\n- 关键符号：{symbols}\n"
        f"- 资产指纹：`{asset['asset_fingerprint']}`\n"
        + (f"- 最近修订：{asset['last_amend_reason']}\n" if asset.get("last_amend_reason") else "")
        + "\n".join(refs)
        + f"\n\n## 验收目标\n\n{asset['objective']}"
        + _live_e2e_markdown(asset.get("live_e2e"))
        + f"\n\n## 验收标准\n\n{criteria}\n"
    )
