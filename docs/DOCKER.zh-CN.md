# Docker 部署

[English](DOCKER.md)

Provider Node 运行在容器里，Docker 负责后台进程管理。

## 快速安装

在服务器上运行：

```bash
git clone https://github.com/focuxdot/wokey-provider-node.git
cd wokey-provider-node
docker compose up -d
```

这条命令会使用仓库里的 `compose.yaml`，拉取官方镜像并在后台启动 Provider Node。
长期运行时，可以把镜像固定到版本 tag，例如：

```bash
WOKEY_PROVIDER_NODE_IMAGE=ghcr.io/focuxdot/wokey-provider-node:vX.Y.Z docker compose up -d
```

## 打开控制台

如果浏览器就在运行 Docker 的这台机器上，打开：

```text
http://127.0.0.1:16888
```

如果 Docker 跑在远程服务器上，先在你的电脑上建立 SSH 转发：

```bash
ssh -L 16889:127.0.0.1:16888 user@server
```

然后在你的电脑浏览器打开：

```text
http://127.0.0.1:16889
```

不要把 `16888` 直接暴露到公网。默认 compose 只绑定服务器本机地址。

## 绑定和授权

可以在控制台里完成绑定和授权。无界面服务器也可以用命令行：

```bash
docker compose exec provider-node wokey-node bind --value bind_...
docker compose exec provider-node wokey-node add
```

检查状态：

```bash
docker compose ps
docker compose exec provider-node wokey-node status
```

## 常用维护

查看日志：

```bash
docker compose logs -f provider-node
```

重启：

```bash
docker compose restart provider-node
```

升级官方镜像：

```bash
docker compose pull
docker compose up -d
```

停止：

```bash
docker compose stop
```

## 数据保存在哪里

节点配置和授权数据保存在 Docker volume：

```text
wokey-provider-node-data
```

升级时不要删除这个 volume。删除后可能需要重新绑定和重新授权。

备份：

```bash
docker run --rm \
  -v wokey-provider-node-data:/data:ro \
  -v "$PWD":/backup \
  busybox tar czf /backup/wokey-provider-node-data.tgz -C /data .
```

恢复：

```bash
docker compose down
docker run --rm \
  -v wokey-provider-node-data:/data \
  -v "$PWD":/backup \
  busybox sh -c 'cd /data && tar xzf /backup/wokey-provider-node-data.tgz'
docker compose up -d
```

## 从源码构建

普通用户不需要源码构建。只有在测试本地改动、自行构建镜像，或官方镜像尚未发布时，
才使用：

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

源码构建会在服务器上执行 `npm ci` 和 build，首次运行可能明显更慢。

## 授权文件

Docker 默认看不到宿主机上的 Codex `auth.json` 或 Claude Code 本地凭据。优先使用
控制台引导、device code 或手动 token JSON 流程：

```bash
docker compose exec provider-node wokey-node add
docker compose exec provider-node wokey-node login codex
docker compose exec provider-node wokey-node paste token --vendor openai --file /data/token.json
```

如果确实要导入宿主机上的凭据文件，只挂载明确的文件或目录。不要把整个 home 目录
挂进容器。

## 镜像验证

官方镜像发布在：

```text
ghcr.io/focuxdot/wokey-provider-node
```

版本 tag 与 GitHub Release tag 一致。发布镜像由 GitHub Actions 使用 keyless
cosign provenance 签名。

验证镜像签名：

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/focuxdot/wokey-provider-node/\.github/workflows/release\.yml@refs/(tags/v.*|heads/main)$' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  ghcr.io/focuxdot/wokey-provider-node:vX.Y.Z
```

## 排查问题

```bash
docker compose ps
docker compose logs -f provider-node
docker compose exec provider-node wokey-node doctor
docker compose exec provider-node wokey-node status
curl http://127.0.0.1:16888/api/status
```

如果服务器上 `curl` 可用，但你的电脑访问不了控制台，请使用 SSH 端口转发，不要把
控制台直接暴露到公网。
