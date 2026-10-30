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

<!-- ferry:git begin -->
## Git: Forgejo first

- `origin` is Forgejo (`forgejo:estejosh/ferry-pixel.git`, Josh's git server on grouchly). Fetch from it, branch from it, push to it. Pull requests and merges happen on Forgejo.
- GitHub is a copy. A relay on grouchly copies every branch and tag from Forgejo to GitHub within a minute or two. Never push to GitHub, never open or merge a pull request there, never change anything on GitHub.
- GitHub CI still runs on that copy. When it fails, a Ferryman order (or a Forgejo issue, where the repo has no channel) is opened with the error. Fix it here and push to Forgejo.
- If `origin` on your machine still points at GitHub: `git remote rename origin github && git remote add origin forgejo:estejosh/ferry-pixel.git && git fetch origin`. The `forgejo` ssh alias exists on beastly and grouchly; anywhere else, ask in the ferryman channel.
<!-- ferry:git end -->
