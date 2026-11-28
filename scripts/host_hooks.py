"""宿主级防治标 Stop Hook 探测、交互选择与用户级配置写入。

支持六个宿主环境（均写入用户级全局配置，配一次全项目生效）：
- antigravity（~/.gemini/config/hooks.json 与 ~/.gemini/config/rules/docs-harness-*.md）
- claude-code（~/.claude/settings.json）
- codex（~/.codex/hooks.json）
- qoder（~/.qoder-cn/settings.json 或 ~/.qoder/settings.json）
- zcode（~/.zcode/cli/config.json）
- deepseek-harness（~/.dsh/hooks.json + ~/.dsh/cordis.patch.yml）
"""

from __future__ import annotations

import json
import os
import re
import shutil
from pathlib import Path
from typing import Any, Callable, Mapping

from host_rules import install_host_rules, planned_host_rule_paths
from managed_assets import atomic_write_json, atomic_write_text

HOOK_ENTRY_ID = "plan-root-cause-challenge"
HOOK_SCRIPT_NAME = "plan_root_cause_hook.py"
HOOK_MARKER_TOKENS = (HOOK_ENTRY_ID, HOOK_SCRIPT_NAME, "plan_root_cause_stop_hook.py")
HOOK_TIMEOUT_SECONDS = 10
HOME_OVERRIDE_ENV = "DOCS_HARNESS_HOST_HOME"

HOST_IDS = (
    "antigravity",
    "claude-code",
    "codex",
    "qoder",
    "zcode",
    "deepseek-harness",
)
HOST_CHOICES = (*HOST_IDS, "skip")
HOST_LABELS: dict[str, str] = {
    "antigravity": "Antigravity",
    "claude-code": "Claude Code",
    "codex": "OpenAI Codex",
    "qoder": "Qoder / Qoder CN",
    "zcode": "ZCode",
    "deepseek-harness": "DeepSeek Harness (dsh)",
}

_ACTIVE_ENV_PREFIXES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("antigravity", ("ANTIGRAVITY_", "AGY_")),
    ("claude-code", ("CLAUDECODE", "CLAUDE_CODE_")),
    ("codex", ("CODEX_",)),
    ("qoder", ("QODER_", "QODERCN_")),
    ("zcode", ("ZCODE_",)),
    ("deepseek-harness", ("DSH_",)),
)


class HostHookError(Exception):
    """宿主配置读取或写入失败时抛出，由控制器映射为 HarnessError。"""

    def __init__(self, message: str, *, code: str = "host_hook_config_error") -> None:
        super().__init__(message)
        self.code = code


def resolve_home_dir(
    home_dir: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> Path:
    if home_dir is not None:
        return Path(home_dir)
    env = os.environ if environ is None else environ
    override = env.get(HOME_OVERRIDE_ENV, "").strip()
    return Path(override) if override else Path.home()


def canonical_hook_script_path(home: Path) -> Path:
    return home / ".docs-harness" / "hooks" / HOOK_SCRIPT_NAME


def _hook_command_parts(script_path: Path, *, is_windows: bool | None = None) -> tuple[str, list[str]]:
    win = (os.name == "nt") if is_windows is None else is_windows
    target = script_path.as_posix()
    if win:
        return ("python", ["-X", "utf8", target])
    return ("python3", [target])


def _hook_command_string(script_path: Path, *, is_windows: bool | None = None) -> str:
    exe, args = _hook_command_parts(script_path, is_windows=is_windows)
    quoted = [f'"{arg}"' if " " in arg else arg for arg in args]
    return " ".join([exe, *quoted])


def detect_active_host(environ: Mapping[str, str] | None = None) -> str | None:
    env = os.environ if environ is None else environ
    keys = list(env.keys())
    for host, prefixes in _ACTIVE_ENV_PREFIXES:
        for key in keys:
            if any(key == p or key.startswith(p) for p in prefixes):
                if env.get(key):
                    return host
    return None


def _host_dirs(host: str, home: Path) -> list[Path]:
    mapping = {
        "antigravity": [home / ".gemini" / "config"],
        "claude-code": [home / ".claude"],
        "codex": [home / ".codex"],
        "qoder": [home / ".qoder-cn", home / ".qoder"],
        "zcode": [home / ".zcode"],
        "deepseek-harness": [home / ".dsh"],
    }
    return mapping[host]


def detect_present_hosts(home: Path) -> list[str]:
    return [host for host in HOST_IDS if any(d.is_dir() for d in _host_dirs(host, home))]


def _qoder_config_paths(home: Path) -> list[Path]:
    cn_dir, intl_dir = home / ".qoder-cn", home / ".qoder"
    paths: list[Path] = []
    if cn_dir.is_dir():
        paths.append(cn_dir / "settings.json")
    if intl_dir.is_dir():
        paths.append(intl_dir / "settings.json")
    return paths or [intl_dir / "settings.json"]


def _host_config_paths(host: str, home: Path) -> list[Path]:
    if host == "antigravity":
        return [home / ".gemini" / "config" / "hooks.json"]
    if host == "claude-code":
        return [home / ".claude" / "settings.json"]
    if host == "codex":
        return [home / ".codex" / "hooks.json"]
    if host == "qoder":
        return _qoder_config_paths(home)
    if host == "zcode":
        return [home / ".zcode" / "cli" / "config.json"]
    if host == "deepseek-harness":
        return [home / ".dsh" / "hooks.json", home / ".dsh" / "cordis.patch.yml"]
    raise HostHookError(f"不支持的宿主环境：{host}", code="invalid_host")


def _contains_marker(node: Any) -> bool:
    if isinstance(node, str):
        return any(token in node for token in HOOK_MARKER_TOKENS)
    if isinstance(node, list):
        return any(_contains_marker(item) for item in node)
    if isinstance(node, dict):
        return any(_contains_marker(v) for v in node.values())
    return False


def _read_json_object(path: Path, *, strict: bool) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        if strict:
            raise HostHookError(
                f"宿主配置文件不是有效 JSON，已中止写入以免破坏原有配置：{path}",
                code="host_hook_invalid_config",
            ) from exc
        return {}
    if not isinstance(data, dict):
        if strict:
            raise HostHookError(
                f"宿主配置文件顶层必须是 JSON 对象：{path}",
                code="host_hook_invalid_config",
            )
        return {}
    return data


def _is_antigravity_configured(home: Path) -> bool:
    data = _read_json_object(home / ".gemini" / "config" / "hooks.json", strict=False)
    for key, entry in data.items():
        if not isinstance(entry, dict) or entry.get("enabled") is False:
            continue
        stops = entry.get("Stop")
        if not isinstance(stops, list) or not stops:
            continue
        if key == HOOK_ENTRY_ID or _contains_marker(stops):
            return True
    return False


def _is_dsh_configured(home: Path) -> bool:
    hooks_data = _read_json_object(home / ".dsh" / "hooks.json", strict=False)
    stops = hooks_data.get("Stop")
    if not (isinstance(stops, list) and _contains_marker(stops)):
        return False
    patch_path = home / ".dsh" / "cordis.patch.yml"
    if not patch_path.is_file():
        return False
    text = patch_path.read_text(encoding="utf-8", errors="replace")
    return "dsh-hooks-claude-code" in text


def is_host_configured(host: str, home: Path) -> bool:
    if host == "antigravity":
        return _is_antigravity_configured(home)
    if host == "deepseek-harness":
        return _is_dsh_configured(home)
    if host == "zcode":
        data = _read_json_object(home / ".zcode" / "cli" / "config.json", strict=False)
        hooks = data.get("hooks")
        if not isinstance(hooks, dict) or hooks.get("enabled") is not True:
            return False
        events = hooks.get("events")
        stops = events.get("Stop") if isinstance(events, dict) else None
        return isinstance(stops, list) and _contains_marker(stops)
    for cfg_path in _host_config_paths(host, home):
        data = _read_json_object(cfg_path, strict=False)
        hooks = data.get("hooks")
        stops = hooks.get("Stop") if isinstance(hooks, dict) else None
        if isinstance(stops, list) and _contains_marker(stops):
            return True
    return False


def _ensure_hook_script(source_root: Path, home: Path) -> tuple[Path, bool]:
    source_script = source_root / "scripts" / HOOK_SCRIPT_NAME
    if not source_script.is_file():
        raise HostHookError(f"来源包缺少钩子脚本：{source_script}", code="host_hook_source_missing")
    dest = canonical_hook_script_path(home)
    source_bytes = source_script.read_bytes()
    if dest.is_file() and dest.read_bytes() == source_bytes:
        return (dest, False)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_script, dest)
    try:
        dest.chmod(dest.stat().st_mode | 0o111)
    except OSError:
        pass
    return (dest, True)


def _merge_stop_list(existing: Any, entry: dict[str, Any]) -> tuple[list[Any], bool]:
    items = list(existing) if isinstance(existing, list) else []
    if _contains_marker(items):
        return (items, False)
    items.append(entry)
    return (items, True)


def _write_antigravity_config(home: Path, cmd: str) -> tuple[list[str], list[str]]:
    path = home / ".gemini" / "config" / "hooks.json"
    data = _read_json_object(path, strict=True)
    desired = {
        "enabled": True,
        "Stop": [{"type": "command", "command": cmd, "timeout": HOOK_TIMEOUT_SECONDS}],
    }
    if data.get(HOOK_ENTRY_ID) == desired:
        return ([str(path)], [])
    data[HOOK_ENTRY_ID] = desired
    atomic_write_json(path, data)
    return ([str(path)], [str(path)])


def _write_claude_family_config(
    paths: list[Path],
    cmd: str,
    *,
    include_matcher: bool,
) -> tuple[list[str], list[str]]:
    entry: dict[str, Any] = {
        "hooks": [{"type": "command", "command": cmd, "timeout": HOOK_TIMEOUT_SECONDS}],
    }
    if include_matcher:
        entry = {"matcher": "", **entry}
    changed: list[str] = []
    for path in paths:
        data = _read_json_object(path, strict=True)
        hooks = data.get("hooks")
        if hooks is not None and not isinstance(hooks, dict):
            raise HostHookError(f"配置字段 hooks 必须是对象：{path}", code="host_hook_invalid_config")
        hooks_obj = dict(hooks) if isinstance(hooks, dict) else {}
        merged, updated = _merge_stop_list(hooks_obj.get("Stop"), entry)
        if updated:
            hooks_obj["Stop"] = merged
            data["hooks"] = hooks_obj
            atomic_write_json(path, data)
            changed.append(str(path))
    return ([str(p) for p in paths], changed)


def _write_zcode_config(home: Path, script_path: Path) -> tuple[list[str], list[str]]:
    path = home / ".zcode" / "cli" / "config.json"
    data = _read_json_object(path, strict=True)
    exe, args = _hook_command_parts(script_path)
    entry = {"hooks": [{"type": "command", "command": exe, "args": args}]}
    hooks = dict(data["hooks"]) if isinstance(data.get("hooks"), dict) else {}
    events = dict(hooks["events"]) if isinstance(hooks.get("events"), dict) else {}
    merged, updated = _merge_stop_list(events.get("Stop"), entry)
    need_enable = hooks.get("enabled") is not True
    if not updated and not need_enable:
        return ([str(path)], [])
    hooks["enabled"] = True
    events["Stop"] = merged
    hooks["events"] = events
    data["hooks"] = hooks
    atomic_write_json(path, data)
    return ([str(path)], [str(path)])


def _write_dsh_config(home: Path, cmd: str) -> tuple[list[str], list[str]]:
    hooks_path = home / ".dsh" / "hooks.json"
    patch_path = home / ".dsh" / "cordis.patch.yml"
    changed: list[str] = []

    hooks_data = _read_json_object(hooks_path, strict=True)
    entry = {
        "matcher": "",
        "hooks": [{"type": "command", "command": cmd, "timeout": HOOK_TIMEOUT_SECONDS}],
    }
    merged, hooks_updated = _merge_stop_list(hooks_data.get("Stop"), entry)
    if hooks_updated:
        hooks_data["Stop"] = merged
        atomic_write_json(hooks_path, hooks_data)
        changed.append(str(hooks_path))

    existing_yaml = patch_path.read_text(encoding="utf-8") if patch_path.is_file() else ""
    if "dsh-hooks-claude-code" not in existing_yaml:
        hooks_posix = hooks_path.as_posix()
        block = (
            "- id: hooks-claude-code\n"
            "  name: '@deepseek-ai/dsh-hooks-claude-code'\n"
            "  config:\n"
            f"    configPath: '{hooks_posix}'\n"
        )
        stripped = re.sub(r"(?m)^\s*#.*$", "", existing_yaml).strip()
        if not stripped or stripped == "[]":
            header = "# 用户层 loader patch 覆盖（顶层必须是 YAML 数组）\n"
            updated_yaml = header + block
        else:
            sep = "" if existing_yaml.endswith("\n") else "\n"
            updated_yaml = existing_yaml + sep + block
        atomic_write_text(patch_path, updated_yaml)
        changed.append(str(patch_path))
    return ([str(hooks_path), str(patch_path)], changed)


def _host_notes(host: str, home: Path) -> list[str]:
    notes: list[str] = []
    if host == "codex":
        toml_path = home / ".codex" / "config.toml"
        if toml_path.is_file():
            raw = toml_path.read_text(encoding="utf-8", errors="replace")
            if re.search(r"(?m)^\s*hooks\s*=\s*false\b", raw):
                notes.append(f"检测到 {toml_path} 中 hooks = false，请改为 hooks = true 后生效。")
        notes.append("首次加载本地 hooks.json 时，Codex 可能提示通过 /hooks 信任该钩子。")
    elif host == "deepseek-harness":
        notes.append(
            "DeepSeek Harness 通过 @deepseek-ai/dsh-hooks-claude-code 加载 ~/.dsh/hooks.json，"
            "请确认所用 profile 已安装该桥接插件并重启会话生效。"
        )
    elif host == "antigravity":
        notes.append(
            "已同步 Antigravity 全局规则到 ~/.gemini/config/rules/（仅 Windows 写入桌面启动避坑规则），"
            "新开会话后与 Stop Hook 一并生效；单条消息带「不用反证」可临时跳过钩子。"
        )
    else:
        notes.append("新开会话后生效；单条消息带「不用反证」可临时跳过。")
    return notes


def install_host_hook(
    host: str,
    source_root: Path,
    *,
    home_dir: Path | None = None,
    environ: Mapping[str, str] | None = None,
    is_windows: bool | None = None,
) -> dict[str, Any]:
    """为用户级宿主环境写入统一的防治标 Stop Hook 脚本、配置与宿主规则（幂等）。"""
    if host not in HOST_IDS:
        raise HostHookError(
            f"不支持的宿主环境：{host}（可选：{', '.join(HOST_CHOICES)}）",
            code="invalid_host",
        )
    home = resolve_home_dir(home_dir, environ)
    script_path, script_changed = _ensure_hook_script(source_root, home)
    cmd = _hook_command_string(script_path, is_windows=is_windows)
    if host == "antigravity":
        cfg_paths, cfg_changed = _write_antigravity_config(home, cmd)
    elif host == "claude-code":
        cfg_paths, cfg_changed = _write_claude_family_config(_host_config_paths(host, home), cmd, include_matcher=False)
    elif host == "codex":
        cfg_paths, cfg_changed = _write_claude_family_config(_host_config_paths(host, home), cmd, include_matcher=True)
    elif host == "qoder":
        cfg_paths, cfg_changed = _write_claude_family_config(_host_config_paths(host, home), cmd, include_matcher=False)
    elif host == "zcode":
        cfg_paths, cfg_changed = _write_zcode_config(home, script_path)
    else:
        cfg_paths, cfg_changed = _write_dsh_config(home, cmd)

    rule_paths, rules_changed = install_host_rules(host, home, is_windows=is_windows)
    changed = ([str(script_path)] if script_changed else []) + cfg_changed + rules_changed
    return {
        "status": "configured",
        "scope": "user",
        "host": host,
        "label": HOST_LABELS[host],
        "script_path": str(script_path),
        "config_paths": cfg_paths,
        "rule_paths": rule_paths,
        "changed": changed,
        "notes": _host_notes(host, home),
    }


def inspect_host_hooks(
    *,
    home_dir: Path | None = None,
    environ: Mapping[str, str] | None = None,
    selected_host: str | None = None,
    is_windows: bool | None = None,
) -> dict[str, Any]:
    """只读探测当前机器已检测到的宿主与防治标 Stop Hook 安装状态。"""
    home = resolve_home_dir(home_dir, environ)
    detected = detect_present_hosts(home)
    configured = [host for host in HOST_IDS if is_host_configured(host, home)]
    active = detect_active_host(environ)
    missing = (not configured) or (active is not None and active not in configured)
    result: dict[str, Any] = {
        "status": "missing" if missing else "already_configured",
        "scope": "user",
        "configured_hosts": configured,
        "detected_hosts": detected,
        "active_host_hint": active,
        "available_hosts": list(HOST_CHOICES),
        "selected_host": selected_host,
    }
    if selected_host in HOST_IDS:
        result["planned_files"] = [
            str(canonical_hook_script_path(home)),
            *(str(p) for p in _host_config_paths(selected_host, home)),
            *(str(p) for p in planned_host_rule_paths(selected_host, home, is_windows=is_windows)),
        ]
    return result


def prompt_host_selection(
    detected_hosts: list[str],
    active_host: str | None,
    *,
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], Any] = print,
) -> str:
    """在交互终端让用户选择当前宿主环境，返回 HOST_CHOICES 中的枚举值。"""
    output_fn("")
    output_fn("未检测到用户级「防治标 Stop Hook」，请选择当前宿主环境进行配置：")
    for idx, host in enumerate(HOST_IDS, start=1):
        tags: list[str] = []
        if host == active_host:
            tags.append("当前环境")
        if host in detected_hosts:
            tags.append("已检测到目录")
        suffix = f"（{'，'.join(tags)}）" if tags else ""
        output_fn(f"  {idx}) {HOST_LABELS[host]} [{host}]{suffix}")
    skip_idx = len(HOST_IDS) + 1
    output_fn(f"  {skip_idx}) 跳过（暂不配置） [skip]")
    while True:
        try:
            raw = input_fn(f"请输入编号 (1-{skip_idx}) 或环境名 [默认 {skip_idx} 跳过]: ").strip()
        except (EOFError, KeyboardInterrupt):
            return "skip"
        if not raw:
            return "skip"
        if raw in HOST_CHOICES:
            return raw
        if raw.isdigit():
            num = int(raw)
            if 1 <= num <= len(HOST_IDS):
                return HOST_IDS[num - 1]
            if num == skip_idx:
                return "skip"
        output_fn(f"无效选择：{raw}，请输入 1-{skip_idx} 或 {', '.join(HOST_CHOICES)}。")


def add_host_argument(project_parser: Any) -> None:
    """为 project 子命令注册 --host 参数。"""
    project_parser.add_argument(
        "--host",
        choices=HOST_CHOICES,
        help="init/upgrade 时为用户级宿主环境配置防治标 Stop Hook（传 skip 跳过）",
    )


def reconcile_project_host_hook(
    args: Any,
    target: Path,
    source_root: Path,
    *,
    apply: bool,
    interactive: bool,
    error_type: type[Exception],
) -> dict[str, Any]:
    """project init/upgrade 入口包装：将 HostHookError 映射为控制器错误类型。"""
    try:
        return reconcile_host_hook(
            action=args.action,
            target=target,
            source_root=source_root,
            apply=apply,
            selected_host=getattr(args, "host", None),
            as_json=bool(getattr(args, "json", False)),
            interactive=interactive,
        )
    except HostHookError as exc:
        raise error_type(str(exc), code=exc.code) from exc


def _install_and_refresh(
    host: str, source_root: Path, *,
    home_dir: Path | None, environ: Mapping[str, str] | None, is_windows: bool | None,
) -> dict[str, Any]:
    installed = install_host_hook(
        host, source_root, home_dir=home_dir, environ=environ, is_windows=is_windows
    )
    refreshed = inspect_host_hooks(
        home_dir=home_dir, environ=environ, selected_host=host, is_windows=is_windows
    )
    return {**refreshed, **installed}


def _refresh_configured_hosts(
    source_root: Path, home: Path, configured_hosts: list[str], *, is_windows: bool | None,
) -> tuple[bool, list[str]]:
    script_updated = False
    if canonical_hook_script_path(home).is_file():
        _, script_updated = _ensure_hook_script(source_root, home)
    rules_updated: list[str] = []
    for configured_host in configured_hosts:
        _, changed_rules = install_host_rules(configured_host, home, is_windows=is_windows)
        rules_updated.extend(changed_rules)
    return (script_updated, rules_updated)


def reconcile_host_hook(
    *,
    action: str,
    target: Path,
    source_root: Path,
    apply: bool,
    selected_host: str | None,
    as_json: bool,
    interactive: bool,
    home_dir: Path | None = None,
    environ: Mapping[str, str] | None = None,
    is_windows: bool | None = None,
    input_fn: Callable[[str], str] = input,
    output_fn: Callable[[str], Any] = print,
) -> dict[str, Any]:
    """协调 project init/upgrade 中的宿主 Stop Hook 与受管全局规则同步。"""
    info = inspect_host_hooks(
        home_dir=home_dir, environ=environ, selected_host=selected_host, is_windows=is_windows
    )
    if not apply:
        return info
    if selected_host == "skip":
        return {**info, "status": "skipped", "selected_host": "skip"}
    if selected_host is not None:
        return _install_and_refresh(
            selected_host, source_root, home_dir=home_dir, environ=environ, is_windows=is_windows
        )
    if info["status"] == "already_configured":
        script_updated, rules_updated = _refresh_configured_hosts(
            source_root, resolve_home_dir(home_dir, environ), info["configured_hosts"], is_windows=is_windows
        )
        return {**info, "script_updated": script_updated, "rules_updated": rules_updated}
    if interactive and not as_json:
        chosen = prompt_host_selection(
            info["detected_hosts"], info["active_host_hint"],
            input_fn=input_fn, output_fn=output_fn,
        )
        if chosen == "skip":
            return {**info, "status": "skipped", "selected_host": "skip"}
        return _install_and_refresh(
            chosen, source_root, home_dir=home_dir, environ=environ, is_windows=is_windows
        )
    choices_str = "|".join(HOST_CHOICES)
    return {
        **info,
        "status": "needs_host_selection",
        "next_action": (
            "未检测到当前环境的防治标 Stop Hook。请让用户选择当前宿主环境，再运行："
            f"python3 scripts/harness.py project {action} --target \"{target}\" --apply "
            f"--host <{choices_str}> --json"
        ),
    }
