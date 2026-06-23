# Configuration System

Kode uses **two complementary configuration layers**:

1. **Global config** (app-wide): model profiles, model pointers, theme, etc.
2. **Settings files** (user/project/local): `.kode/settings.json`, `.kode/settings.local.json`, etc. (with legacy `.claude` fallbacks)

This doc focuses on where the files live and how to configure **models** reliably.

## File locations

### Global config (primary)

- Default: `~/.kode.json`
- If `KODE_CONFIG_DIR` is set: `<KODE_CONFIG_DIR>/config.json`

Kode also uses a data directory for logs/tasks/memory:

- Default: `~/.kode/`
- If `KODE_CONFIG_DIR` is set: `<KODE_CONFIG_DIR>/`

Legacy compatibility:

- `CLAUDE_CONFIG_DIR` affects only legacy read-compat roots (e.g. `~/.claude`), and never changes Kode’s primary config/data locations.

### Project/local settings (per-repo)

- Project settings: `./.kode/settings.json` (legacy `./.claude/settings.json`)
- Local settings: `./.kode/settings.local.json` (legacy `./.claude/settings.local.json`)

Example: output style selection is stored in `settings.local.json` under `outputStyle`.

## Models

### Model profiles + pointers (stored in global config)

Model configuration lives in the global config under:

- `modelProfiles`: array of provider/model entries
- `modelPointers`: default assignments for `main`, `task`, `compact`, `quick`

Minimal example (illustrative):

```json
{
  "modelProfiles": [
    {
      "name": "o3",
      "provider": "openai",
      "modelName": "o3",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "<YOUR_API_KEY>",
      "maxTokens": 8192,
      "contextLength": 200000,
      "isActive": true,
      "createdAt": 1710000000000
    }
  ],
  "modelPointers": {
    "main": "o3",
    "task": "o3",
    "compact": "o3",
    "quick": "o3"
  }
}
```

Recommended ways to manage models:

- Interactive UI: `/model`
- Shareable YAML: `kode models export` / `kode models import`
- List configured profiles/pointers: `kode models list`

### Shareable YAML import/export

```bash
kode models export --output kode-models.yaml
kode models import kode-models.yaml
kode models import --replace kode-models.yaml
```

The exported YAML defaults to `apiKey: { fromEnv: ... }` so you can keep secrets in environment variables.

### Model selectors (what to put in `model:` fields)

Across Kode features (agents, Task tool overrides, etc.), you can generally reference a model using:

- Pointer: `main | task | compact | quick`
- Profile name: `OpenAI Main`
- Model name (modelName): `o3`, `gpt-4o`, `qwen2.5-coder-32b-instruct`
- Provider-qualified: `provider:modelName` (or `provider:profileName`), e.g. `openai:o3`

Use `kode models list` to see what’s currently configured.

## `kode config` CLI (limited keys)

`kode config` is intended for a small set of “safe” keys (theme, verbosity, a few project toggles).

```bash
# Global config keys
kode config get -g theme
kode config set -g theme dark
kode config list -g

# Project config keys (stored under projects[...] inside the global config)
kode config get enableArchitectTool
kode config set enableArchitectTool true
kode config list
```

For models, prefer `/model` or `kode models import/export` (not `kode config set`).

## Environment Variables

### Core Variables

> Anthropic environment overrides are disabled—configure Anthropic keys in Kode settings instead.

```bash
# API Keys
OPENAI_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-v1-...
REQUESTY_API_KEY=rqsty-sk-...

# Model Selection
CLAUDE_MODEL=claude-3-5-sonnet-20241022
DEFAULT_MODEL_PROFILE=fast

# Feature Flags
ENABLE_ARCHITECT_TOOL=true
DEBUG_MODE=true
VERBOSE=true

# MCP Configuration
MCP_SERVER_URL=http://localhost:3000
MCP_TIMEOUT=30000

# Development
NODE_ENV=development
LOG_LEVEL=debug
```

### Precedence Rules

Environment variables override configuration files (Anthropic keys excluded):

1. Check environment variable
2. Check project configuration
3. Check global configuration
4. Use default value

## Configuration Migration

### Version Migration

The system automatically migrates old configuration formats:

```typescript
function migrateConfig(config: any): Config {
  // v1 to v2: Rename fields
  if (config.iterm2KeyBindingInstalled) {
    config.shiftEnterKeyBindingInstalled = config.iterm2KeyBindingInstalled
    delete config.iterm2KeyBindingInstalled
  }

  // v2 to v3: Update model format
  if (typeof config.model === 'string') {
    config.modelProfiles = {
      default: {
        type: 'anthropic',
        model: config.model,
      },
    }
    delete config.model
  }

  return config
}
```

### Backup and Recovery

Configuration files are backed up before changes:

```typescript
function saveConfigWithBackup(config: Config) {
  // Create backup
  const backupPath = `${configPath}.backup`
  fs.copyFileSync(configPath, backupPath)

  try {
    // Save new configuration
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  } catch (error) {
    // Restore from backup on error
    fs.copyFileSync(backupPath, configPath)
    throw error
  }
}
```

## Configuration Validation

### Schema Validation

Using Zod for runtime validation:

```typescript
const ConfigSchema = z.object({
  theme: z.enum(['dark', 'light']).optional(),
  modelProfiles: z.record(ModelProfileSchema).optional(),
  modelPointers: ModelPointersSchema.optional(),
  mcpServers: z.record(MCPServerConfigSchema).optional(),
  // ... other fields
})

function loadConfig(path: string): Config {
  const raw = JSON.parse(fs.readFileSync(path, 'utf-8'))
  return ConfigSchema.parse(raw)
}
```

### Validation Rules

1. **API Keys**: Must match expected format
2. **Model Names**: Must be valid model identifiers
3. **URLs**: Must be valid URLs for endpoints
4. **Paths**: Must be valid file system paths
5. **Commands**: Must not contain dangerous patterns

## Configuration Scopes

### Global Scope

Affects all projects:

- User preferences (theme, keybindings)
- Model profiles and API keys
- Global MCP servers
- Auto-updater settings

### Project Scope

Specific to current project:

- Tool permissions
- Allowed commands
- Project context
- Local MCP servers
- Cost tracking

### Session Scope

Temporary for current session:

- Runtime flags
- Temporary permissions
- Active MCP connections
- Current model selection

## Advanced Configuration

### Custom Model Providers

#### OpenRouter

OpenRouter is available as an OpenAI-compatible provider. Use the `/model` selector and choose OpenRouter, or import a model profile:

```yaml
version: 1
profiles:
  - name: OpenRouter Claude Sonnet
    provider: openrouter
    modelName: anthropic/claude-sonnet-4.5
    baseURL: https://openrouter.ai/api/v1
    maxTokens: 8192
    contextLength: 200000
    apiKey:
      fromEnv: OPENROUTER_API_KEY
pointers:
  main: anthropic/claude-sonnet-4.5
  task: anthropic/claude-sonnet-4.5
  compact: anthropic/claude-sonnet-4.5
  quick: anthropic/claude-sonnet-4.5
```

OpenRouter model IDs use the `provider/model` format shown in the [OpenRouter model list](https://openrouter.ai/models).

#### Requesty

Requesty is available as an OpenAI-compatible provider. Use the `/model` selector and choose Requesty, or import a model profile:

```yaml
version: 1
profiles:
  - name: Requesty GPT-4o mini
    provider: requesty
    modelName: openai/gpt-4o-mini
    baseURL: https://router.requesty.ai/v1
    maxTokens: 8192
    contextLength: 128000
    apiKey:
      fromEnv: REQUESTY_API_KEY
pointers:
  main: openai/gpt-4o-mini
  task: openai/gpt-4o-mini
  compact: openai/gpt-4o-mini
  quick: openai/gpt-4o-mini
```

Requesty model IDs use the `provider/model` format (e.g. `openai/gpt-4o-mini`) shown in the [Requesty model list](https://app.requesty.ai/models). Create an API key at [app.requesty.ai/api-keys](https://app.requesty.ai/api-keys).

```json
{
  "modelProfiles": {
    "custom-llm": {
      "type": "custom",
      "name": "My Custom LLM",
      "config": {
        "baseURL": "https://my-llm-api.com",
        "apiKey": "custom-key",
        "model": "my-model-v1",
        "headers": {
          "X-Custom-Header": "value"
        }
      }
    }
  }
}
```

### MCP Server Examples

```json
{
  "mcpServers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem"],
      "env": {
        "ALLOWED_DIRECTORIES": "/home/user/projects"
      }
    },
    "github": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "web-api": {
      "type": "sse",
      "url": "https://api.example.com/mcp"
    }
  }
}
```

### Context Configuration

```json
{
  "context": {
    "projectType": "typescript",
    "framework": "react",
    "testingFramework": "jest",
    "buildTool": "webpack",
    "customContext": "This project uses a custom state management solution..."
  }
}
```

## Configuration Best Practices

### 1. Security

- Never commit API keys to version control
- Use environment variables for secrets
- Validate all configuration inputs
- Limit command permissions appropriately

### 2. Organization

- Keep global config for user preferences
- Use project config for project-specific settings
- Document custom configuration in README
- Version control project configuration

### 3. Performance

- Cache configuration in memory
- Reload only when files change
- Use efficient JSON parsing
- Minimize configuration file size

### 4. Debugging

- Use verbose mode for configuration issues
- Check configuration with `config list`
- Validate configuration on load
- Log configuration errors clearly

## Troubleshooting

### Common Issues

1. **Configuration Not Loading**
   - Check file permissions
   - Validate JSON syntax
   - Ensure correct file path

2. **Settings Not Applied**
   - Check configuration hierarchy
   - Verify environment variables
   - Clear configuration cache

3. **Migration Failures**
   - Restore from backup
   - Manually update format
   - Check migration logs

### Debug Commands

```bash
# Show configuration
kode config list

# Reset to defaults
kode config reset

# Show configuration paths
kode config paths
```

The configuration system provides flexible, secure, and robust management of all Kode settings while maintaining backward compatibility and user-friendly defaults.
