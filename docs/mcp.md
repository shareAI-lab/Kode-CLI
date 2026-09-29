# MCP 配置与接入（.mcp.json / .mcprc）

Kode 支持通过 MCP（Model Context Protocol）接入外部工具服务器，并将 MCP server 下发的工具映射为动态工具名：`mcp__<server>__<tool>`。

## 1) 推荐：使用 `.mcp.json`（项目文件格式）

在项目根目录创建 `.mcp.json`：

```json
{
  "mcpServers": {
    "my-stdio": {
      "type": "stdio",
      "command": "python",
      "args": ["-m", "my_mcp_server"],
      "env": {
        "FOO": "BAR"
      }
    },
    "my-http": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp"
    },
    "my-sse-legacy": {
      "type": "sse",
      "url": "http://127.0.0.1:3333/sse"
    },
    "my-ws": {
      "type": "ws",
      "url": "ws://127.0.0.1:3333/mcp"
    }
  }
}
```

## 2) 兼容：使用 `.mcprc`（简化格式）

在项目根目录创建 `.mcprc`（一个 JSON 对象，key 为 server 名）：

```json
{
  "my-http": {
    "type": "http",
    "url": "http://127.0.0.1:3333/mcp"
  },
  "my-stdio": {
    "type": "stdio",
    "command": "node",
    "args": ["./server.js"]
  }
}
```

也兼容 `.mcprc` 包一层 `mcpServers`：

```json
{
  "mcpServers": {
    "my-http": { "type": "http", "url": "http://127.0.0.1:3333/mcp" }
  }
}
```

## 3) 审批与排障

- `.mcp.json` / `.mcprc` 属于“项目文件 MCP 配置”，首次启动会弹窗请求你批准这些 server；可用 `kode mcp reset-project-choices` 重置选择。
- 查看连接状态：交互模式输入 `/mcp`，或运行 `kode mcp`（slash command）/ `kode mcp list`（CLI 子命令）。
- 连接超时（默认 `30000`ms）：`MCP_CONNECTION_TIMEOUT_MS=30000`；设置为 `0` 可关闭连接超时。
- 并发连接数量（默认 `3`，最大 `50`）：`MCP_SERVER_CONNECTION_BATCH_SIZE=3`（服务器较多或较慢时可调小）。
- 工具调用超时（默认不限制）：`MCP_TOOL_TIMEOUT=30000`（单位 ms，用于限制单次 MCP tool request 的耗时）。

## 4) CLI 快速添加

- `kode mcp add <name> <command> [args...]`：默认添加 `stdio` server；可用 `-e KEY=value` 设置环境变量；可用 `--scope local|user|project` 选择写入位置。
- `kode mcp add <name> <url> --transport http|sse|ws`：显式指定 URL-based transport；可用 `-H "Header: value"` 设置请求头；也可使用 `kode mcp add-http` / `kode mcp add-sse` / `kode mcp add-ws`。
- `kode mcp remove <name>`：未指定 `--scope` 时会自动定位；若同名 server 同时存在于多个 scope，会提示你显式选择。

> 注：`sse`（HTTP+SSE）为旧版传输（MCP 2024-11-05 起被 Streamable HTTP 取代），官方已标记为 legacy；新接入的 URL server 建议使用 `http`（Streamable HTTP）。

## 5) 客户端能力（roots / elicitation / sampling）

Kode 作为 MCP client 会在 `initialize` 时按宿主能力声明以下 client capabilities，并且**默认失败关闭**（fail-closed）：宿主不具备的能力不会被声明，即使 server 强行发来请求也不会阻塞工具调用。

| 能力          | 何时声明      | 行为                                                                                                                               |
| ------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `roots`       | 始终声明      | 响应 `roots/list`。工作区信任未确认时返回空数组；确认后返回 `mcpRoots`（未配置则返回当前工作目录）。ACP 会话用客户端传入的 `cwd`。 |
| `elicitation` | 仅交互式 REPL | 支持 `form` 与 `url` 两种模式（←/→ 光标、Tab/↑/↓ 切换字段、Enter 提交、Esc 拒绝）。`kode -p` 不声明。                              |
| `sampling`    | 仅显式开启    | 需要 `MCP_ALLOW_SAMPLING=1`（可用 `MCP_SAMPLING_SERVERS=a,b` 限定 server）。未开启时一律拒绝。                                     |

- 配置暴露给 server 的文件系统根：在项目配置中设置 `mcpRoots: ["/path/a", "/path/b"]`（未设置则用当前工作目录）。
- 一次只显示一个 elicitation 表单；并发请求排队，server 的取消信号会立即关闭表单。表单超时自动取消：`MCP_ELICITATION_TIMEOUT_MS=300000`（`0` 表示不超时）。
- **URL 模式**：Kode 只展示链接、不自动打开浏览器；你在浏览器完成后按 Enter 视为接受。`notifications/elicitation/complete` 会被记录但不改变本地状态。
- 表单里所有来自 server 的文字（`message`、字段 `title`/`description`、枚举项、URL）都会**剥离 ANSI/控制字符与双向文本覆盖符**后再渲染，防止恶意 server 清屏、移动光标或伪造 Kode 界面。
- sampling 会占用你的模型额度：`maxTokens` 按 server 请求执行但受 `MCP_SAMPLING_MAX_TOKENS` 封顶（默认 `4096`），`stopSequences` 透传，会话角色（user/assistant）保持原样，且**不会**注入 Kode 的编码 agent system prompt（以 server 的 `systemPrompt` 为准）。
- `modelPreferences` 只把**命中你已配置模型名**的 `hints` 当作用模型；未命中时按 `cost/speed/intelligencePriority` 在快速指针与主模型指针间选择，绝不会因为未知模型名而失败。
- 尚未接入：`completions`、实验性 `tasks`、sampling-with-tools（因此不声明 `sampling.tools`）、`resources/subscribe`、icons 元数据（终端无法渲染图片 URL）。

## 6) OAuth 鉴权

- 需要鉴权的远端 server 走 OAuth 2.0（PKCE，回调监听 `127.0.0.1` 固定端口），凭据存在 `~/.kode/mcp/oauth/<server>.json`。
- 授权服务器元数据发现由 SDK 完成：先按 RFC 9728 探测 `/.well-known/oauth-protected-resource`，再按 RFC 8414 找 `.well-known/oauth-authorization-server`，失败则回退 **OpenID Connect Discovery 1.0**（`.well-known/openid-configuration`）——**无需额外配置**。
- Kode 会缓存发现结果，避免每次启动连接时重复若干次 HTTP 往返；缓存随 `discovery` / `all` 失效一起清除，防止授权服务器迁移后无法重新发现。
- 未使用 OAuth Client ID Metadata Documents（SEP-991）：该机制要求客户端在**公网 HTTPS** 托管元数据文档，本地 CLI 不具备条件，因此仍走 RFC 7591 动态注册。
