# Codex双端共用

让 Windows 电脑与手机共同使用同一个本机 Codex 对话。手机提供私人网页入口，电脑上的兼容桌面负责执行；两端共享原对话、原生消息队列、回复和待回答问题。项目不是 OpenAI 官方产品。

## 可以做什么

- 在手机查看已有对话、接收流式回复，继续电脑上的任务。
- 手机和电脑共同发送消息，忙碌时按原生队列顺序执行。
- 创建新对话，选择项目、模型、思考强度和计划模式。
- 回答真实选择题、处理支持的审批、确认最终方案。
- 暂停当前轮次、继续本次任务，或暂停后发送新消息。
- 使用图片等媒体功能；支持范围以当前页面和桌面能力为准。
- 将手机网页添加到主屏幕作为网页 App 使用。

三个典型场景：出门后继续电脑的代码任务；手机补充需求并等待当前回复结束后执行；在电脑工作、手机查看进度并回答问题。

## 工作方式与适用范围

```text
手机 Safari / 网页 App
        │ 私人 Tailscale HTTPS + 独立口令
        ▼
Windows 本机网页服务（127.0.0.1:8767）
        │ 本机命名管道
        ▼
Codex 双端共用兼容桌面 → 原生队列 → 原对话
```

兼容桌面是根据本机已安装 Codex 构建的独立副本，保留原安装与快捷方式，沿用本机 Codex 历史。仓库只包含本项目源码，不包含 Codex 桌面程序、个人凭据、运行数据库或聊天截图。

当前源码包含桌面 `26.924.2738.0` 和 `26.928.1915.0` 的固定适配。构建还会核对源文件摘要，同版本号并不保证可适配。未知版本或摘要变化会拒绝构建，不能跳过校验直接使用。适用于本机未归档的普通交互对话；云端、远程、子代理和非交互执行不在此入口的支持范围内。电脑需要保持开机、联网、登录且不休眠。

## 1. 准备电脑环境

准备 Windows、Python 3.14、PowerShell 7、已安装且已登录的 Codex 桌面与 CLI、Tailscale。Node.js 用于桌面桥接和开发测试；也可使用兼容桌面自带的 Node 运行时。首次部署需要管理员权限安装专用网络计划任务。

在 PowerShell 中执行：

```powershell
git clone https://github.com/steeeeeeveee/Codex-dual-client.git
cd Codex-dual-client
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

私有仓库需要使用有访问权限的 GitHub 账号克隆。建议使用固定的项目路径，安装后的计划任务、快捷方式和运行配置会引用该路径。

## 2. 构建并安装兼容桌面

先只读检查本机桌面：

```powershell
.\.venv\Scripts\python.exe scripts/check-desktop-compatibility.py --output runtime/desktop-compatibility.json
.\.venv\Scripts\python.exe scripts/build-shared-desktop.py
pwsh -NoProfile -File scripts/install-shared-desktop.ps1
```

检查报告用于诊断，构建时的版本与摘要校验才决定是否接受适配。成功后生成 `runtime/shared-desktop.json`、兼容副本和桌面“Codex 双端共用”快捷方式，并安装当前用户计划任务 `Codex-Mobile-Desktop`。

首次切换时，等待原版 Codex 的工作和队列结束，完全退出原版，再打开新增快捷方式。原版或 CLI 即使空闲，也可能占用目标对话。不能通过删除锁文件或强制抢占来解决；应让原持有者正常释放对话。

## 3. 首次启动与配置网页服务

```powershell
pwsh -NoProfile -File scripts/start-server.ps1
```

浏览器打开 `http://127.0.0.1:8767`。首次启动会生成 `runtime/config.json`，其中包含随机访问口令。打开该本地文件，保留随机口令或换成足够强的独立口令。

**首次生成的 `codex` 路径是原开发电脑的路径，必须改为本机实际 `codex.exe` 路径。** 可以用 `Get-Command codex -All` 辅助查找；如果找到的是包装脚本，应定位它实际调用的可执行文件。

双端共用还需配置 `sharedDesktop`。以下只展示结构，路径与口令需按本机填写，不要直接复制占位值：

```json
{
  "password": "替换为独立强口令",
  "origins": ["http://127.0.0.1:8767", "http://localhost:8767"],
  "codex": "C:\\实际路径\\codex.exe",
  "sharedDesktop": {
    "node": "C:\\实际路径\\node.exe",
    "allLocal": true,
    "threads": {}
  }
}
```

`sharedDesktop.node` 应指向实际 Node 可执行文件。兼容桌面 manifest 的 `executable` 所在目录下，通常可找到 `resources/cua_node/bin/node.exe`；也可通过 `Get-Command node` 找到已安装的 Node。`allLocal: true` 允许支持的本机普通对话使用共享入口，仍会执行对话类型与持有者检查。

保存配置后重启本项目网页进程，让配置生效。需要登录后自动启动时执行：

```powershell
pwsh -NoProfile -File scripts/install-server.ps1
Start-ScheduledTask -TaskName Codex-Mobile-Web
```

若首次启动的临时网页进程还在占用 8767，应先确认并关闭该项目进程，再启动计划任务。已安装任务可用 `Stop-ScheduledTask` / `Start-ScheduledTask` 重启。服务重启后手机需要重新登录。

## 4. 建立手机私人网络

本项目使用独立 Tailscale daemon、专用管道与 `runtime/tailscale/` 状态目录。所有命令必须带专用管道参数，避免操作系统默认节点。

在管理员 PowerShell 中安装：

```powershell
pwsh -NoProfile -File scripts/install-network.ps1
```

然后使用 Tailscale CLI 登录和配置（安装路径不同则调整）：

```powershell
$mobileTailscale = 'C:\Program Files\Tailscale\tailscale.exe'
& $mobileTailscale '--socket=\\.\pipe\CodexMobileTailscale' login
# 完成命令给出的浏览器登录流程；保持登录进程直到确认成功。
& $mobileTailscale '--socket=\\.\pipe\CodexMobileTailscale' up --unattended --accept-dns=false --accept-routes=false --hostname=codex-mobile
& $mobileTailscale '--socket=\\.\pipe\CodexMobileTailscale' status
& $mobileTailscale '--socket=\\.\pipe\CodexMobileTailscale' serve --bg --https=443 http://127.0.0.1:8767
```

按 Tailscale 提示完成账户与 HTTPS 配置。把 Serve 返回的真实 HTTPS origin（仅协议与主机名，不带路径）加入 `runtime/config.json` 的 `origins`，然后重启网页服务。不要使用他人的私人域名。

手机安装 Tailscale，登录同一私人网络或获得对应访问权限，开启连接，再用 Safari 打开该 HTTPS 地址。输入本项目独立口令。成功看到列表后，选择对话并验证电脑连接状态。

## 5. 手机添加到主屏幕

Safari 打开私人 HTTPS 地址，选择“共享 → 添加到主屏幕”。如有“作为网页 App 打开”选项则开启，名称可用 Codex。第一次从图标进入可能需要重新登录；Safari 与网页 App 的登录状态、草稿不保证共享。日常仍需开启手机 Tailscale，并保持电脑服务运行。

## 6. 日常双端使用

1. 电脑打开“Codex 双端共用”，保持兼容桌面运行。
2. 手机登录后用左上列表按钮选择原对话。
3. 若显示未连接，点击“在电脑连接此对话”，等待真实连接确认。
4. 显示“电脑已连接 · 可共同发送”后，输入并发送。忙碌时消息进入同一份原生队列，当前轮结束后按确认顺序执行。
5. 查看流式回复、待回答问题和队列状态。手机退出或断网不会停止电脑执行。

手机可撤回尚未转交的等待消息；正式队列的编辑、删除、重排在电脑操作，手机同步显示。不要在“结果待核对”时盲目重复发送，确认丢失不等于未执行。

新建对话：点击右上加号进入草稿，选择项目或独立对话、模式、模型与思考强度，发送首条消息后才创建。已有对话修改模型或强度后，需要点击“应用设置”并等待桌面确认；仅关闭菜单不会生效，正在执行的轮次保持原参数。可用模型由当前桌面提供。

暂停与继续：本轮已开始且桌面连接正常时，点击“暂停思考”；等待停止确认后，点击“继续本次任务”，或输入新消息。继续保留原对话上下文，暂停后新消息通过原生队列恢复执行；已有排队消息保持顺序。断线、尚未进入本轮和过期轮次不能操作暂停。

计划模式：选择计划模式后发送需求，按真实问题卡片回答，查看最终方案并确认下一步。审批继承原对话策略；文件详情不完整或复杂外部登录、表单应在电脑处理。手机不会额外扩大权限。

## 7. 状态解释与故障恢复

| 状态 / 问题 | 含义与处理 |
| --- | --- |
| 等待电脑 | 服务已保存但还没转交；启动兼容桌面并连接对话，可撤回未转交消息。 |
| 已入队 | 桌面确认接收，等待执行；无需重复发送。 |
| 结果待核对 | 无法证明提交结果，后续转交暂停；恢复连接核对原请求。 |
| 原版占用 / active writer | 等原版或 CLI 工作结束并正常关闭，再从兼容桌面打开原对话。 |
| 正在同步 / 连接中断 | 检查手机 Tailscale、电脑网络与三个项目任务，等待重连。 |
| NeedsLogin / NeedsMachineAuth | 完成 Tailscale 登录或设备批准；进程运行不代表已登录。 |
| HTTPS 打不开 | 检查专用节点、Serve、手机权限、本机 8767 和配置中的 origins。 |
| 登录后操作被拒绝 | 检查访问地址是否在 origins，服务重启后重新登录。 |
| 构建提示版本或摘要不支持 | 保留原安装，停止部署，先为该桌面版本验证适配。 |

恢复已有安装：

```powershell
pwsh -NoProfile -File scripts/restore-mobile.ps1
```

该脚本校验专用任务是否属于本项目，启动缺失的网络任务和网页服务，再恢复私人 Serve。排查日志用 `runtime/server.log`、`runtime/network.log` 和本机桌面状态文件；日志及配置不要上传。恢复不会远程开机，也不会替用户完成登录。

## 8. 升级与回退

升级源码前备份 `runtime/`，等待任务及队列结束。桌面升级需重新只读检查、核对摘要并构建，不能直接向未知版本套旧补丁。需要先暂存构建而不切换运行指针时使用 `scripts/build-shared-desktop.py --no-activate`。

回退时先等待工作结束，关闭兼容桌面，再使用原版快捷方式。保留运行数据库、确认记录和配置，核对未完成消息；不要删除历史、writer lock 或队列数据库。项目路径改变后应核对所有计划任务和快捷方式。

## 9. 开发与验证

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
npm ci --ignore-scripts
npm test
node --check static/app.js
```

固定版本的 Markdown、HTML 清理、代码高亮与公式资源保存在 `static/vendor/`，附有来源 manifest 与第三方许可。重建资源执行 `npm run vendor`。

隔离页面预览：运行 `.venv/Scripts/python.exe tests/ui_preview_server.py`，打开 `http://127.0.0.1:8772/new`；还可查看 `/login`、`/chat`、`/thinking`、`/questions`、`/plan`、`/offline` 和 `/pending`。该服务使用模拟数据，不执行真实桌面任务，结束后停止预览进程。

自动化测试不等于实体手机验收。部署后应自行验证 HTTPS 登录、手机发送、双端排队、问题回答、暂停继续及断线恢复。

## 目录与数据保护

| 目录 / 文件 | 用途 |
| --- | --- |
| `app.py`、`shared_queue.py` | 网页 API、认证、持久化待转交消息与队列桥接 |
| `desktop_bridge/` | 桌面版本适配、原生消息接口、状态与流式同步 |
| `scripts/` | 构建、安装、启动、网络恢复、兼容检查与隔离验收 |
| `static/` | 手机界面、媒体、公式和静态资源 |
| `tests/` | 后端与前端自动化测试、模拟页面 |
| `runtime/` | 本机配置、口令、数据库、网络状态、桌面副本和日志；不提交 |

口令、Tailscale 状态、Codex 登录信息与个人消息只保留在本机。网页只监听 loopback，私人 HTTPS 转发不暴露原始 app-server RPC。项目不会在浏览器关闭时中断任务；退出登录也不会停止电脑执行。
