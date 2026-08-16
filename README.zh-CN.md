# @hyav/pi-mcp

[English](README.md)

为 [Pi](https://pi.dev) 打造的轻量级模型上下文协议（MCP）扩展，通过一个紧凑的代理工具路由到已配置的本地与远程 MCP 服务。它会缓存能力元数据、按需建立连接并池化活动传输。

[参与贡献](CONTRIBUTING.md) · [更新记录](CHANGELOG.md) · [安全策略](SECURITY.md)

## 核心能力

- 支持 Stdio、SSE 和 Streamable HTTP 传输
- 延迟连接并缓存能力发现结果
- 精确路由工具，重名时要求显式指定服务器
- 支持结构化 JSON 参数、取消、并发限制和 10 MiB 消息上限
- 诊断信息脱敏，不持久化展开后的凭据

## 安装

需要 Node.js 22.19.0 或更高版本以及 Pi。

```sh
pi install npm:@hyav/pi-mcp
```

启动 Pi 并运行 `/mcp`。安装成功后会打开连接面板并列出发现的服务器。

## 配置

首选的全局配置文件是 `~/.pi/agent/mcp.json`：

```json
{
  "mcpServers": {
    "local": {
      "command": "node",
      "args": ["/absolute/path/to/server.js"],
      "env": { "API_KEY": "${LOCAL_MCP_API_KEY}" }
    },
    "remote": {
      "url": "https://mcp.example.test/mcp",
      "type": "streamable-http",
      "headers": { "Authorization": "Bearer ${REMOTE_MCP_TOKEN}" }
    }
  },
  "settings": {
    "enableLocalConfig": false,
    "enableThirdPartyConfig": false
  }
}
```

每个服务器必须且只能定义 `command` 或 `url` 之一。Stdio 定义可设置 `args`、`cwd`、`env`、超时、并发和协议模式；远程定义可设置传输类型、请求头和 Bearer 认证。请使用环境变量占位符或 `bearerTokenEnv`，不要直接写入凭据。

后备全局路径是 `~/.config/mcp/mcp.json`。只有全局配置明确启用对应选项时，才会读取受信任的项目文件（`.pi/mcp.json` 或 `.mcp.json`）和支持的第三方配置。全局定义覆盖第三方导入，受信任项目定义再覆盖两者，显式自定义定义优先级最高。

## 使用

- `/mcp`：打开连接面板
- `/mcp <server>`：连接或断开服务器
- `/mcp reconnect <server>`：重连并刷新元数据

面向 Agent 的 `mcp` 代理可以搜索能力、报告状态、连接服务器、调用精确工具，以及列出或读取资源。工具重名时必须显式指定服务器。公共元数据可以缓存到 `~/.pi/agent/mcp-cache.json`；私有元数据和授权指纹仅保留在内存中。

## 使用须知

Stdio 服务器会执行本地命令；远程服务器会接收发送给它的数据和凭据。只安装并配置可信的代码与服务。

## 许可证

[MIT](LICENSE)
