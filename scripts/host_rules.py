"""宿主级用户全局规则定义与幂等落盘。

随 `--host antigravity` 及已配置 Antigravity 环境的 `project upgrade --apply`
同步写入 `~/.gemini/config/rules/docs-harness-*.md`，不占用项目 `AGENTS.md`
的 18 KB 受管入口预算，也不影响非 Antigravity 宿主。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from managed_assets import atomic_write_text

ANTIGRAVITY_RULES_RELATIVE = (".gemini", "config", "rules")

ANTIGRAVITY_SUBAGENTS_RULE_CONTENT = """---
trigger: always_on
---

<!-- docs-harness:managed-host-rule:antigravity-subagents -->
# Antigravity 子智能体与默认 Agent 配额约束

- 在 Antigravity 中委派子智能体（如并行取证、实现/评审、「产品视觉总监」截图审查、ADR 复审等）时，\
**必须**直接通过 `invoke_subagent` 调用内置子智能体类型（只读场景用 `research`，读写/执行场景用 `self`，\
网页交互用 `browser`，生图用 `image-generator`），通过 `Role` 和 `Prompt` 赋予具体角色与任务书。
- **禁止**调用 `define_subagent` 动态创建自定义子智能体类型，除非用户本次明确要求定义新子智能体。
- **禁止**主动创建 `.agents/agents/*`、`~/.gemini/config/agents/*` 等自定义 agent 定义，\
或切换/引导使用 `--agent` / `/agents` 自定义主 agent；需要沉淀持久指令时，统一写入 Rules\
（`AGENTS.md` / `GEMINI.md` / `~/.gemini/config/rules/*.md`）或 Skills（`SKILL.md`），\
维持默认 agent 的 1× 标准配额费率（参考 `google-antigravity/antigravity-cli#1890`）。
"""

WINDOWS_GUI_LAUNCH_RULE_CONTENT = """---
trigger: always_on
---

<!-- docs-harness:managed-host-rule:windows-gui-launch -->
# Windows 真实桌面 GUI 与系统托盘启动约束

- 在 Windows 上，内置终端工具 `run_command` 运行于隔离桌面层（非用户可见的 `WinSta0\\Default` 主桌面）：\
凡是面向用户交互体验的可见桌面窗口、Electron 应用或系统托盘程序，**严禁**使用 `run_command` 直接启动\
（否则窗口与托盘落在隐藏隔离桌面不可见，且占用本机端口）。
- 需要为用户拉起可见 GUI / 托盘联调时，二选一：
  1. 若环境已安装连接在真实主桌面会话的 `agent-desktop` MCP：先在 `run_command` 完成无头编译预热，\
再通过 `desktop_launch` 启动（注意：① 不在启动参数或环境数组中硬编码任何密钥/token；\
② Windows 上 `desktop_launch` 遇到已在运行的同名映像如 `node.exe`/`cmd.exe`/`powershell.exe` \
会直接 attach 而不新建进程，启动脚本应使用 `--detach` 脱钩模式配合未运行的系统工具如 `forfiles.exe` \
并显式设 `timeout: 20000`，避免无窗口常驻进程触发 3 分钟超时）；
  2. 确认相关端口空闲后，给出最短启动命令交由用户在自身终端执行。
- Windows 端口占用探测统一使用 `netstat -ano`（毫秒级），禁止使用慢速的 PowerShell `Get-NetTCPConnection`。
- 后台无头自动化验证（单测、构建、隐藏窗口截图回归）仍走 `run_command` 后台执行，不弹前台窗口。
"""


@dataclass(frozen=True)
class HostRuleSpec:
    """单条受管宿主全局规则规格。"""

    filename: str
    content: str
    windows_only: bool = False


ANTIGRAVITY_MANAGED_RULES: tuple[HostRuleSpec, ...] = (
    HostRuleSpec(
        filename="docs-harness-antigravity-subagents.md",
        content=ANTIGRAVITY_SUBAGENTS_RULE_CONTENT,
        windows_only=False,
    ),
    HostRuleSpec(
        filename="docs-harness-windows-gui-launch.md",
        content=WINDOWS_GUI_LAUNCH_RULE_CONTENT,
        windows_only=True,
    ),
)


def antigravity_rules_dir(home: Path) -> Path:
    return home.joinpath(*ANTIGRAVITY_RULES_RELATIVE)


def _selected_antigravity_rules(*, is_windows: bool | None = None) -> list[HostRuleSpec]:
    win = (os.name == "nt") if is_windows is None else is_windows
    return [rule for rule in ANTIGRAVITY_MANAGED_RULES if (not rule.windows_only) or win]


def planned_host_rule_paths(
    host: str,
    home: Path,
    *,
    is_windows: bool | None = None,
) -> list[Path]:
    """返回指定宿主在当前平台下计划写入的用户级规则文件路径。"""
    if host != "antigravity":
        return []
    rules_dir = antigravity_rules_dir(home)
    return [rules_dir / rule.filename for rule in _selected_antigravity_rules(is_windows=is_windows)]


def install_host_rules(
    host: str,
    home: Path,
    *,
    is_windows: bool | None = None,
) -> tuple[list[str], list[str]]:
    """幂等写入指定宿主的用户级受管全局规则，返回 (全部规则路径, 本次改动路径)。"""
    if host != "antigravity":
        return ([], [])
    rules_dir = antigravity_rules_dir(home)
    paths: list[str] = []
    changed: list[str] = []
    for rule in _selected_antigravity_rules(is_windows=is_windows):
        dest = rules_dir / rule.filename
        paths.append(str(dest))
        expected = rule.content.encode("utf-8")
        if dest.is_file() and dest.read_bytes() == expected:
            continue
        atomic_write_text(dest, rule.content)
        changed.append(str(dest))
    return (paths, changed)
