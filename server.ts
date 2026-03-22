#!/usr/bin/env bun
/**
 * watashi — self-talk MCP channel.
 *
 * Agents send messages onto a SQLite-backed bus. The handler session
 * is notified automatically via the claude/channel notification.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { Database } from 'bun:sqlite'
import { join } from 'path'

interface Message {
  id: number
  sender: string
  body: string
  created_at: string
}

const DB_PATH = process.env.WATASHI_DB ?? join(import.meta.dir, 'watashi.db')
const POLL_MS = parseInt(process.env.WATASHI_POLL_MS ?? '5000', 10)

const db = new Database(DB_PATH, { create: true })
db.run('PRAGMA journal_mode=WAL')
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`)

const insertStmt = db.prepare('INSERT INTO messages (sender, body) VALUES (?, ?)')
const selectNewStmt = db.prepare<Message, [number]>('SELECT id, sender, body, created_at FROM messages WHERE id > ? ORDER BY id')
const deleteUpToStmt = db.prepare('DELETE FROM messages WHERE id <= ?')

let lastSeenId = db.prepare<{ m: number | null }, []>('SELECT MAX(id) as m FROM messages').get()?.m ?? 0

// CLI mode: `bun server.ts send <sender> <body>` writes directly to the DB.
// Use this from cron jobs so the handler session's instance picks up the message.
if (process.argv[2] === 'send') {
  const sender = process.argv[3]
  const body = process.argv.slice(4).join(' ')
  if (!sender || !body) {
    process.stderr.write('usage: bun server.ts send <sender> <body>\n')
    process.exit(1)
  }
  insertStmt.run(sender, body)
  process.exit(0)
}

const tools = [
  {
    name: 'send',
    description: 'Put a message on the bus. The handler session is notified automatically.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sender: { type: 'string', description: 'Who is sending the message.' },
        body: { type: 'string', description: 'The message body.' },
      },
      required: ['sender', 'body'],
    },
  },
]

const mcp = new Server(
  { name: 'watashi', version: '0.1.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      'watashi is a self-talk message bus. Other agents send messages here for you to handle.',
      '',
      'Messages arrive as <channel source="watashi" sender="..." ts="...">. Act on each message as instructed.',
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'send') {
    const args = req.params.arguments as { sender?: string; body?: string } | undefined
    if (!args?.sender || !args?.body) {
      throw new Error('send requires sender and body')
    }
    insertStmt.run(args.sender, args.body)
    return { content: [{ type: 'text', text: 'Message queued.' }] }
  }
  throw new Error(`Unknown tool: ${req.params.name}`)
})

// Poll for new messages, deliver via channel notification, delete only on success.
setInterval(async () => {
  try {
    const rows = selectNewStmt.all(lastSeenId)
    if (!rows.length) return

    for (const row of rows) {
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: {
            content: row.body,
            meta: {
              sender: row.sender,
              ts: row.created_at,
            },
          },
        })
        lastSeenId = row.id
      } catch (err) {
        process.stderr.write(`watashi: delivery failed, will retry: ${err}\n`)
        break
      }
    }

    if (lastSeenId > 0) {
      deleteUpToStmt.run(lastSeenId)
    }
  } catch (err) {
    process.stderr.write(`watashi: poll error: ${err}\n`)
  }
}, POLL_MS)

const transport = new StdioServerTransport()
await mcp.connect(transport)
process.stderr.write('watashi: channel running\n')
