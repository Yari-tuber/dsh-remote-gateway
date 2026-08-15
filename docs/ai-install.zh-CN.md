# AI 辅助安装

把下面的提示词交给能够在 DeepSeek Harness 所在电脑上操作终端的编程智能体。

```text
把公开 GitHub bundle github:Yari-tuber/dsh-remote-gateway 安装到现有 DeepSeek Harness 的 web profile。

安全要求：
- 保留所有现有 Harness profile、设置、凭据、会话和无关插件。
- 不得打印、复制、提交或上传 API Key、密码、Cookie、隧道地址、用户名、本地路径或网络地址。
- 不得让 Harness 主 Web 服务绑定 0.0.0.0、::、局域网地址或公网地址。它必须保持在 127.0.0.1，避免绕过认证网关。
- 不得允许无关依赖执行构建脚本。
- 不得创建 GitHub 仓库、提交或推送任何内容。

执行步骤：
1. 检查 dsh、Node.js ^22.19 或 >=24，以及 pnpm 是否可用。
2. 执行：dsh plugin --profile web add github:Yari-tuber/dsh-remote-gateway
3. 如果 pnpm 禁止 Git 依赖执行 prepare，只编辑 Harness 输出的准确 web profile pnpm-workspace.yaml，并加入：
   allowBuilds:
     dsh-remote-gateway: true
   然后重新执行相同安装命令。
4. 确认 web profile manifest 的 dsh.profile.bundles 已包含 dsh-remote-gateway。
5. 启动 dsh --profile web 并等待本地地址。不要把服务暴露到非回环网卡。
6. 确认设置中出现“远程访问”，并且可以读取环境状态。除非我明确要求，否则不要启动公网隧道。
7. 只报告执行过的命令、不含敏感信息的通过/失败结果，以及需要我在界面中完成的操作。
```

智能体完成后，请亲自在**设置 → 远程访问**中设置独立密码，再点击**一键配置并启动**，避免密码进入智能体对话记录。
