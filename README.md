# watashi

A self-talk MCP channel for Claude Code. Agents put messages on a
SQLite-backed bus and the handler session is notified automatically.

## Usage

Add to your MCP config:

```json
{
  "mcpServers": {
    "watashi": {
      "command": "bun",
      "args": ["run", "--cwd", "/path/to/watashi", "--shell=bun", "--silent", "start"]
    }
  }
}
```

### Tools

**send(sender, body)** — queue a message. The handler session receives
it as a `<channel source="watashi">` notification.

### Environment

| Variable | Default | Description |
|---|---|---|
| `WATASHI_DB` | `./watashi.db` | Path to the SQLite database |
| `WATASHI_POLL_MS` | `5000` | Poll interval in milliseconds |

### How it works

External processes (cron jobs, other Claude sessions) call `send` to
write messages into the SQLite database. The channel server polls for
new rows and pushes each one into the handler session via
`notifications/claude/channel`. Messages are deleted only after
successful delivery.

## License

MIT
