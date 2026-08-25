# 任务:B5 批3 — CI Windows job 与 electron-builder NSIS 打包

你在 dispatch 仓库工作。批1(platform win32)、批2(跨平台测试脚本,npm test Windows 全绿)已提交,
见 git log 最近两条与 `docs/acceptance/evidence/b5-windows-adaptation/`。本批打通 CI 与安装包。
执行合同见 `docs/plans/b5-windows-adaptation.md` 批3。

## 硬性纪律(同前两批)

1. 只改 `.github/workflows/ci.yml` 与 `package.json`;其余文件一律不碰(dsh-plugin/、docs/、src/、tests/ 都不允许)。
2. 不运行任何 git 写命令。
3. 不新增 npm 依赖。
4. 收尾对触碰文件跑 prettier(yml 若 prettier 不管则保持手工整洁)。

## 已知事实(不要自己重新发现,也不要试图修复)

- `npm run lint`(eslint .)当前在全仓有 **82 个既有 error**,全部位于 `dsh-plugin/` 与
  `dsh-headless-session/`(no-undef:这两个纯 JS 目录缺 eslint globals 声明)。这是 B5 之前就存在的
  失败,**本批禁止修**(不改 eslint 配置、不改这两个目录、不改 lint 命令的语义),只在报告里注明
  「CI lint step 双平台都会因该既有问题红,归因与修复由用户另行决策」。
- `npm test` 已跨平台(批2 的 scripts/run-vitest.mjs),Windows 本机 221 passed | 9 skipped。
- `npm ci` 的 postinstall 是 electron-builder install-app-deps,双平台可用。

## 第 1 步:ci.yml 加 Windows job

现有唯一 job `check`(macos-latest:npm ci → lint → typecheck → test)。改为双平台:

- 用 matrix(`os: [macos-latest, windows-latest]`)或两个并列 job,选写法更清晰的一种;步骤保持
  npm ci → lint → typecheck → test 完全一致,不因平台增删步骤。
- node-version 维持 24,cache: npm 维持。
- 不加 `continue-on-error`、不给 lint 加任何绕过——既有红如实红。
- YAML 本地无法跑,验证方式:`npx prettier --check .github/workflows/ci.yml`(若支持)+ 用
  node 的 yaml 能力或 python(本机有)做一次语法解析确认;把验证方式与输出写进报告。

## 第 2 步:package.json 加 NSIS 打包

- `build` 节新增:
  ```json
  "win": { "target": ["nsis"] }
  ```
  不加 icon、签名等额外配置(仓库 resources/ 若无 .ico,electron-builder 用默认图标即可;不要造图标)。
- `scripts` 新增 `"pack:win": "electron-vite build && electron-builder --win"`(与 pack:mac 形制对齐)。

## 第 3 步:本机实跑 pack:win

运行 `npm run pack:win`(首次会下载 NSIS 工具链与 Electron 发行包,耗时正常;确保网络失败时如实报告
而不是绕过)。成功标准:

- `dist/` 产出 `*.exe` NSIS 安装器(记录确切文件名与大小);
- electron-vite build 与 electron-builder 全程 exit 0。

**不要运行安装器**(实装验证是审查者的 L4 验收步骤,不在你的任务内)。若打包失败:原样保留完整错误
输出进报告,按错误性质最小修复(仅限 package.json build 配置范畴);配置外的失败(如源码问题)不修,报告。

## 第 4 步:验证汇总

- `npm run typecheck` exit 0(确认 package.json 改动无副作用);
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` 确认 JSON 合法;
- ci.yml 语法验证输出;
- pack:win 的关键输出(产物路径、大小、exit code)。

## 收尾

报告写到仓库根 `.kimi-report-b3.md`:改动清单、ci.yml 全文、pack:win 输出摘要与产物信息、
lint 既有红的说明、验证输出、自查两问、未覆盖风险(如:CI 实际绿否需推送后才知)。
