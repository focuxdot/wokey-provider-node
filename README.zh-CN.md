# Wokey Provider Node

> 把用不完的 AI 订阅容量变成供给——每一次成功调用都为你产生收益。

[![Release](https://img.shields.io/github/v/release/focuxdot/wokey-provider-node?label=release)](https://github.com/focuxdot/wokey-provider-node/releases)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](package.json)
[![Official Exit](https://img.shields.io/badge/official--exit-encrypted%20egress-6230eb)](docs/OFFICIAL_VERIFICATION.md)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-yellow)](LICENSE)

在你自己的电脑上运行一个节点，把闲置的 **Claude / Codex（OpenAI）/ 智谱 / Kimi** 等订阅容量通过 Wokey 共享出去。**每一次成功路由的调用都会为你产生收益。** 业务策略、计费和厂商请求构造都留在 Wokey 平台——节点只是你本机的接入控制台和一个受限的网络出口。

[快速安装](#快速安装) · [Docker](docs/DOCKER.zh-CN.md) · [第一次使用](#第一次使用) · [安全吗？](#安全吗) · [它如何工作](#它如何工作) · [出口白名单](#出口白名单) · [常用命令](#常用命令) · [发布验证](#发布验证) · [文档](#文档)

[English](README.md) · [供应者上手指南](https://wokey.ai/docs/provider) · [官方网站](https://wokey.ai)

---

## 为什么要运行它

- **用闲置容量赚钱。** 如果你的 Claude、Codex 或其他 AI 订阅经常用不完，节点会把这部分余量接入 Wokey，按成功路由的调用为你结算收益。
- **不开公网端口，不用运维服务器。** 节点是*主动出站*连接 Wokey 平台——你无需暴露任何入站端口，也不用运维基础设施。
- **要不要在线由你决定。** 离线不会影响账号，只是离线这段时间不产生收益。

并且，节点在设计上刻意**不会**读取你的 prompt（提示词）、不扫描浏览器、也不决定路由或计费。详见 [安全吗？](#安全吗)。

## 信任，但请验证

这些你都不必凭信任接受：

- **完全开源**——仓库里每一行代码都可查看。
- **安装器校验 SHA-256**：对每个文件比对 `checksums.txt`（还支持可选的 cosign 来源验签，见 [发布验证](#发布验证)）。
- **节点只能连官方厂商域名**：白名单是源代码，不是可远程下发的设置。见 [出口白名单](#出口白名单)。
- **随时自行核验**：`wokey-node doctor` 与 `wokey-node status`。

## 快速安装

macOS / Linux：

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.ps1 | iex
```

需要 Node.js 20+；若系统里没有，安装器会自动装好（Windows 用 winget 或官方安装包，macOS 用 Homebrew 或官方安装包，Linux 用官方预编译包）。安装器会下载 `checksums.txt` 并在安装前校验文件的 SHA-256。如果系统里已装 `cosign`，还会自动验证官方发布来源；没有 `cosign` 也能正常安装。

然后打开本地控制台：

```text
http://127.0.0.1:16888
```

## 第一次使用

1. 安装 Provider Node。
2. 打开本地控制台 `http://127.0.0.1:16888`，或运行 `wokey-node`。
3. 从控制台打开 Wokey Provider 页面并登录。
4. 自动绑定节点，或粘贴 `bind_...` 绑定码完成绑定。
5. 从检测到的本地来源或引导式 OAuth 流程添加一份授权凭证。
6. 确认成功：在本地节点管理页面能看到由本机授权或导入的凭证；在网站的 Provider 页面能看到 Provider 的完整凭证池。（无界面的服务器可改用 `wokey-node status`。）Provider 分配给本节点用于路由的其他凭证不会在本机页面暴露。

远程 Linux 服务器可以走命令行，无需把控制台暴露到公网：

```bash
wokey-node
wokey-node bind --value bind_...
wokey-node add
wokey-node list
wokey-node import 1
wokey-node login codex
wokey-node paste token --vendor openai --file ./token.json
```

> 第一次接触？[供应者上手指南](https://wokey.ai/docs/provider) 会按 安装 → 绑定 → 授权 一步步带你走，每步都有"成功标志"可对照。

## 安全吗？

Provider Node 运行在你的电脑上，但它的能力是被刻意收窄的。用人话说：

**它会做什么**

- 把你的电脑绑定到你的 Wokey 账号。
- 处理本机的接入、授权和诊断。
- 按已绑定平台的请求建立*出站*连接。
- 把加密的 official-exit 流量转发给经过批准的厂商域名。
- 上报本机健康与容量信号。

**它不能做什么**

- 读取你的 prompt、模型回复或厂商授权头——official-exit 流量始终留在厂商的 TLS 内；节点只转发字节，从不解密 TLS。
- 决定路由、计费、账号权限、配额、模型映射或结算——这些都在 Wokey 平台。
- 导入浏览器 Cookie 或浏览器保存的密钥——浏览器抓取在设计上就不支持。
- 远程扩大自己的网络出口——白名单只从本地源码/环境读取，平台无法远程放宽。

本地配置中的敏感字段以 `enc:v1:` 前缀加密存储。加密密钥来自已设置的 `PROVIDER_NODE_MASTER_KEY`，或配置文件旁自动生成的本地密钥文件。

完整的技术表述见 [安全边界](#安全边界) 和 [出口白名单](#出口白名单)。

## 它如何工作

| 部分 | 运行在哪 | 职责 |
| --- | --- | --- |
| Wokey 平台 | Wokey 基础设施 | 账号、路由、计费、凭据托管、厂商请求构造、策略、结算 |
| Provider Node | 你的电脑 | 本地控制台、节点绑定、凭证接入、出站桥接、受限网络出口 |
| 厂商 API | 官方厂商域名 | 接收平台经由 Provider Node 出口发出的 HTTPS 请求 |

official-exit 请求流向：

```text
Wokey 平台 -> 出站 WebSocket -> Provider Node -> TCP 套接字 -> 厂商域名
```

平台构造厂商 HTTPS 请求，并*通过*节点的 TCP 套接字完成 TLS。Provider Node 打开套接字、转发字节；它不解密厂商 TLS，因此看不到请求或响应内容。

## 本地授权

支持的本地授权方式：

- Codex `auth.json`
- Claude Code 本地凭据
- Codex 设备码 / OAuth 流程
- Claude OAuth 授权码流程
- xAI/Grok 一键设备码 / OAuth 流程
- 手动 OAuth token JSON

接入时由你显式授权或导入一份凭证。所选凭证会上传到 Wokey 平台的加密凭据库，供平台代你构造官方厂商请求。

浏览器 Cookie、浏览器会话、浏览器保存的密钥（操作系统钥匙串）一律不支持导入。Provider Node 不会扫描浏览器 Cookie 数据库。

## 出口白名单

这是最重要的安全属性，因此它在源码里强制执行、而非可配置项：默认情况下 Provider Node 只允许把 official-exit 连接发往当前支持厂商的官方域名。公开的权威来源：

- [src/shared/official-exit-vendors.ts](src/shared/official-exit-vendors.ts)
- [Official Exit 验证](docs/OFFICIAL_VERIFICATION.md#restricting-egress)

| 厂商 | 默认域名 |
| --- | --- |
| OpenAI / Codex | `*.openai.com`、`*.chatgpt.com` |
| Anthropic / Claude | `*.anthropic.com`、`*.claude.com` |
| 通义千问 Qwen | `dashscope.aliyuncs.com`、`dashscope-us.aliyuncs.com` |
| 智谱 AI | `*.bigmodel.cn`、`*.z.ai` |
| Moonshot / Kimi | `*.kimi.com`、`*.moonshot.ai`、`*.moonshot.cn` |
| MiniMax | `*.minimax.io`、`*.minimaxi.com` |
| 小米 MiMo | `*.xiaomimimo.com` |
| DeepSeek | `*.deepseek.com` |
| Google Gemini | `generativelanguage.googleapis.com` |
| xAI / Grok | `*.x.ai`、`*.grok.com` |

你可以用 `PROVIDER_OFFICIAL_EXIT_ALLOWED_HOSTS` 收窄或扩展本地出口域名列表。该设置只从本地环境读取，平台无法远程放宽。不支持通配符 `*`；请使用明确域名或形如 `.example.com` / `*.example.com` 的域名模式。

对于 xAI OAuth 凭证，`*.grok.com` 会放行当前 Grok CLI 用户资料接口以及未来可能使用的
Grok 官方子域，无需再次发布 Provider Node。

## 安全边界

Provider Node 是供应侧软件，但它不是生产业务策略的权威来源。

它可以：

- 把供应方机器绑定到 Wokey；
- 管理本地接入与诊断；
- 按已绑定平台的请求建立出站连接；
- 转发加密的 official-exit 流量；
- 上报本机健康与饱和信号。

它不能：

- 决定路由、计费、账号权限、配额、模型映射或结算；
- 在 official-exit 模式下解密厂商 TLS；
- 读取用户 prompt、模型回复或厂商授权头；
- 导入浏览器 Cookie 或浏览器保存的密钥；
- 远程扩大本地运营者的出口白名单。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `wokey-node` | 打开交互式本地命令行菜单 |
| `wokey-node open` | 在支持的环境中用浏览器打开本地控制台 |
| `wokey-node bind --value bind_...` | 用 Provider 页面的绑定码绑定本节点 |
| `wokey-node add` | 通过引导式命令行流程添加凭证 |
| `wokey-node list` | 列出可导入的本地授权来源 |
| `wokey-node import 1` | 导入检测到的某个凭证候选 |
| `wokey-node login codex` | 启动 Codex 设备码授权 |
| `wokey-node paste token --vendor openai --file ./token.json` | 手动粘贴授权材料 |
| `wokey-node status` | 显示本机、绑定、桥接和凭证状态 |
| `wokey-node doctor` | 运行诊断 |
| `wokey-node restart` | 重启本地服务 |
| `wokey-node update` | 重新运行最新发布的安装器 |
| `wokey-node logs` | 在支持的环境中显示服务日志 |

## 发布验证

官方发布会附带 `checksums.txt`、`checksums.txt.sig`、`checksums.txt.pem`。安装器始终对每个文件比对 `checksums.txt` 的 SHA-256。如果系统里装了 `cosign`，还会验证 GitHub Actions 对 `checksums.txt` 的 keyless 签名，确认发布产物来自官方发布流程。

快速安装不需要 `cosign`。若要强制要求来源验签，先安装 `cosign` 再运行：

```bash
curl -fsSL https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.sh | WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE=1 bash
```

Windows PowerShell：

```powershell
$env:WOKEY_PROVIDER_NODE_REQUIRE_SIGNATURE = "1"
irm https://github.com/focuxdot/wokey-provider-node/releases/latest/download/install.ps1 | iex
```

手动验证示例：

```bash
cosign verify-blob \
  --certificate checksums.txt.pem \
  --signature checksums.txt.sig \
  --certificate-identity-regexp '^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  checksums.txt
```

## 配置

运行时配置通过环境变量提供。本地开发时把 [`.env.example`](.env.example) 复制为 `.env.local`；`npm start` 会自动加载 `.env.local`。

常见设置包括：本地控制台主机/端口、配置路径、本地加密主密钥、平台主机白名单、official-exit 出口白名单，以及日志级别。

## 开发

```bash
npm install            # 安装依赖
npm run dev            # 启动本地控制台
npm run verify         # 运行完整校验（lint、类型、测试）
```

测试时使用本地配置：

```bash
PROVIDER_CONFIG_PATH=./data/provider-node.json npm run dev
```

## 打包

```bash
npm run package:provider-node   # 构建所有支持的安装包
npm run release:checksums       # 生成发布校验和
```

## 文件结构

```text
wokey-provider-node/
├── src/provider-node/          # 守护进程、控制台 API、桥接、OAuth、本地配置
├── src/shared/                 # 协议、加密、ID、厂商白名单
├── web/console/                # 本地控制台 HTML、CSS、客户端 JS、内置字体
├── packaging/                  # macOS、Linux、Windows 封装与安装器
├── scripts/                    # 构建、打包、校验和、开源边界检查
├── docs/                       # 运行时、安装器、验证、维护者文档
├── Dockerfile
├── compose.yaml
├── compose.build.yaml
├── .github/workflows/release.yml
├── README.md
└── LICENSE
```

## 文档

- [Provider Node](docs/PROVIDER_NODE.md)
- [macOS 安装器](docs/MACOS_INSTALLER.md)
- [Linux 安装器](docs/LINUX_INSTALLER.md)
- [Windows 安装器](docs/WINDOWS_INSTALLER.md)
- [Docker 部署](docs/DOCKER.zh-CN.md)
- [Official Exit 验证](docs/OFFICIAL_VERIFICATION.md)
- [安全策略](SECURITY.md)
- [贡献指南](CONTRIBUTING.md)

## 许可证

Apache-2.0。见 [LICENSE](LICENSE)。
