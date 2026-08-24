# ferry-pixel

A ferry channel watcher that puts your agents on the office map:
it watches [Ferry](https://github.com/estejosh/ferryman) channel directories
and injects agent presence into running
[pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) offices via the
hook-event protocol (`POST /api/hooks/claude`).

When a task is ordered, a pixel character walks in and announces it; when an
agent claims the task, the character sits down and starts typing; when a
result lands, the character raises a review flag; on accept it waves goodbye
and despawns (on reject it stays for rework).

## How it works

```
 channel dir (read-only)                pixel-agents office
 ┌────────────────────────┐            ┌──────────────────────┐
 │ tasks/<id>/order.json  ├─┐          │  ┌──┐ ┌──┐           │
 │ tasks/<id>/claim*      │ │  watch   │  │🧑‍💻│ │🧑‍🎨│  desks    │
 │ tasks/<id>/result.json │ │ ───────► │  └──┘ └──┘  bubbles  │
 │ tasks/<id>/review.json ├─┘  parse → │   flags · emotes     │
 └────────────────────────┘  state →  └─────────▲────────────┘
                             map →              │ POST /api/hooks/claude
                             send               │ Bearer <registry token>
                                                │
                                    ~/.pixel-agents/servers/*.json
```

Pipeline stages (all local, no daemon):

1. **watch** (`src/watcher.ts`) — chokidar watches `tasks/<taskId>/*` files,
   debounces, classifies each file as `order | claim | result | review`.
2. **state** (`src/state.ts`) — a pure reducer folds typed events through
   `ISSUED → CLAIMED → WORKING → RESULTED → REVIEWED` per task and surfaces
   office-level intents (`spawn-character`, `set-active-typing`,
   `speech-bubble`, `flag-review`, `emote-accept/reject`, `despawn`).
3. **map** (`src/map.ts`) — pure mapper from intents to pixel-agents hook
   payloads (see [`../PROTOCOL.md`](../PROTOCOL.md)):
   | intent | hook payload |
   |---|---|
   | spawn-character | `SessionStart{source,cwd}` + confirming `PreToolUse` |
   | set-active-typing / speech-bubble | `PreToolUse` |
   | flag-review | `Notification{notification_type:"idle_prompt"}` |
   | emote-accept/reject | `PostToolUse` |
   | despawn | `Stop{reason:"exit"}` + `SessionEnd{reason:"exit"}` |
4. **send** (`src/emitter.ts`) — discovers live servers from
   `~/.pixel-agents/servers/*.json` (pid-liveness-checked) and fans out each
   payload with bearer auth; failures are swallowed per server.

## Install

```sh
npm i -g .
```

This installs a global `ferry-pixel` binary (the TypeScript CLI runs through
the bundled tsx launcher).

Pair it with a pixel-agents office:

```sh
npx pixel-agents        # start the office (writes the server registry entry)
ferry-pixel --channel ~/channels/team-A
```

The office must either track your channel directory as a workspace folder or
have **Watch All Sessions** enabled, otherwise adoption of external sessions is
refused.

## Usage

```
ferry-pixel --channel <dir> [--channel <dir> ...] [options]

--server <url>    override discovery; http://<token>@127.0.0.1:<port> embeds the token
--registry <dir>  alternate ~/.pixel-agents/servers registry dir
--dry-run         print hook payloads instead of sending
```

### Names, labels and Areas derive from cwd

Pixel-agents owns cosmetics (palette, seat); hooks only control identity
through the `cwd` path. ferry-pixel spawns every character with

```
cwd = <channel dir>/<AgentName>
```

so the office name tag is the agent name (`basename(cwd)`), and persisted
folder→Area mappings match agents whose folder label equals their cwd's last
segment — put agents in an Area by naming a mapping after the agent.
`session_id` is `<channel-name>-<taskId>`, stable across restarts, so reworked
tasks reuse the same character.

### Dry-run demo

Replay the synthetic fixture channel without sending anything:

```sh
npx tsx src/cli.ts --channel tests/fixtures/channel-A --dry-run
```

Sample output:

```jsonc
{"hook_event_name":"SessionStart","session_id":"channel-A-t-fixture1","source":"startup","cwd":"…/tests/fixtures/channel-A/alpha"}
{"hook_event_name":"PreToolUse","session_id":"channel-A-t-fixture1","tool_name":"Task","tool_input":{"command":"start t-fixture1"}}
{"hook_event_name":"PreToolUse","session_id":"channel-A-t-fixture1","tool_name":"Bash","tool_input":{"command":"work on t-fixture1"}}
{"hook_event_name":"Notification","session_id":"channel-A-t-fixture1","notification_type":"idle_prompt","message":"t-fixture1 ready for review"}
```

Each watched file prints one burst of payloads in wire order.

## Development

```sh
npm test        # vitest suite (unit + e2e against a stub HTTP server)
npm run typecheck
npm run fixtures  # regenerate tests/fixtures/channel-A (synthetic data only)
```

See [`AGENTS.md`](AGENTS.md) before contributing, and
[`../PROTOCOL.md`](../PROTOCOL.md) for the code-verified pixel-agents wire
protocol this tool speaks.

## License

[MIT](LICENSE) © 2026 estejosh
