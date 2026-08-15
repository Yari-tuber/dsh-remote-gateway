# 命令行安装

本教程会把 DSH Remote Gateway 安装到 DeepSeek Harness 的 `web` profile，并最终验证带登录保护的远程网关。

## 前置条件

确认 `dsh`、Node.js 和 pnpm 可用：

```powershell
dsh --version
node --version
pnpm --version
```

DeepSeek Harness 必须支持 `dsh plugin --profile`、profile bundle，以及根 README 中说明的 Web 服务。

## 从 GitHub 安装

```powershell
dsh plugin --profile web add github:Yari-tuber/dsh-remote-gateway
```

如果 pnpm 禁止 Git 依赖执行 `prepare`，请打开 Harness 输出的准确 `pnpm-workspace.yaml` 路径，并加入：

```yaml
allowBuilds:
  dsh-remote-gateway: true
```

再次执行相同安装命令。不要顺便允许无关依赖执行脚本。

## 从本地源码安装

```powershell
git clone https://github.com/Yari-tuber/dsh-remote-gateway.git
cd dsh-remote-gateway
pnpm install --frozen-lockfile
pnpm run prepare
dsh plugin --profile web add .
```

本地源码在加入 profile 前已经构建，因此不需要 `allowBuilds`。

## 启动和配置

```powershell
dsh --profile web
```

打开终端打印的本地 Harness 地址，然后进入**设置 → 远程访问**。

1. 设置独立用户名和至少 10 位的强密码。
2. 确认 Harness 主服务只监听 `127.0.0.1`。
3. 点击**一键配置并启动**。
4. 等待环境状态变为**已就绪**并出现 HTTPS 地址。
5. 在手机浏览器打开该地址，登录并确认 Harness 界面能加载且连接保持正常。

首次托管配置会下载并校验 `cloudflared`；后续启动会复用已校验的安装。

## 持久配置

设置页面的修改会立即作用于当前进程。如需跨重启保存部署参数，请在 `~/.dsh/profiles/web/cordis.patch.yml` 中完整替换本 bundle 的 config。先复制根目录 [`cordis.patch.yml`](../cordis.patch.yml) 的默认值，再只修改需要的字段。

不要把密码写入共享仓库。密码留空时，每次启动都会生成新的强密码，并且只在本地设置页面显示。

## 更新

```powershell
dsh plugin --profile web update dsh-remote-gateway
```

更新后重启 Harness，让 Host 和浏览器 bundle 一起重新加载。

## 卸载

先在设置中停止公网隧道并关闭 Harness，然后执行：

```powershell
dsh plugin --profile web remove dsh-remote-gateway
```

已校验的托管可执行文件会保留在 `$DSH_HOME/tools/dsh-remote-gateway`，需要时可手动清理；其中不包含登录凭据或会话数据。

## 常见问题

**看不到远程访问页面：**确认 web profile manifest 的 `dsh.profile.bundles` 列表包含 `dsh-remote-gateway`，然后重启 Harness。

**安装提示 `allowBuilds`：**只在 profile 的 `pnpm-workspace.yaml` 中加入 `dsh-remote-gateway: true`，然后重试安装。

**隧道无法启动：**点击**重新检测**，检查到 GitHub 和 Cloudflare 的出站 HTTPS；如果 UDP/QUIC 被过滤，请使用 `tunnelProtocol: http2`。

**手机能看到登录页，但 Harness 连接中断：**同时更新 Host 和客户端 bundle，并确认所安装的 Harness 提供兼容的 WebSocket 事件路径。

**页面提示主服务不是回环监听：**停止远程访问，先让 Harness Web 服务绑定 `127.0.0.1`。
