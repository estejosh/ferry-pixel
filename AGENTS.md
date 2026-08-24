# ferry-pixel contributor brief

Ferry channel watcher that injects agent presence into pixel-agents offices.

## Stack

- TypeScript (strict, ESM), Node >= 18.17, no build step — run via tsx
- deps: chokidar (watching), tsx (bin launcher); dev: vitest, typescript
- layout: `src/watcher.ts` → `src/state.ts` → `src/map.ts` → `src/emitter.ts`,
  glued by `src/cli.ts` + `src/pipeline.ts`; tests mirror in `tests/`

## Protocol

The wire format (`POST /api/hooks/claude` payloads) is specified, code-verified
against the pixel-agents source, in **[`../PROTOCOL.md`](../PROTOCOL.md)**.
Read it before touching `src/map.ts` or `src/emitter.ts`. Keep mappers pure:
no I/O in `types.ts`, `state.ts`, `map.ts`, `pipeline.ts`.

## Rules

- **Synthetic fixtures only.** Everything under `tests/fixtures/` must use
  made-up names (`t-fixture*`, `alpha`, `bravo`, `fixture-box`). Never commit
  real roster names, task ids, channel contents, or customer data.
- **Never log or print secrets.** Registry tokens and `--server` credentials
  must not appear in logs, error messages, test output, or payloads; tests
  assert the token never leaks into request bodies.
- Channels are **read-only**: never write into a watched channel directory.
- Tests must stay hermetic: stub HTTP server + temp dirs, no live office.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`); push only when
  asked.

## Verify before pushing

```sh
npm run typecheck && npm test
npx tsx src/cli.ts --channel tests/fixtures/channel-A --dry-run
```
