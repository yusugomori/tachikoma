# Tachikoma Agent Instructions

Project: tachikoma
Project id: proj_tachikoma

When task context is needed, read shared project memory:

```bash
pnpm tachikoma memory
```

Do not read memory for simple identity, sync, or relay requests.

Use named agents for routing. Record structured tasks, assignments, review findings,
verification results, decisions, and blockers instead of raw transcripts.

Tachikoma host hooks deliver inbox work during session startup, user prompts, and stop
continuations. When a hook-delivered directive appears, read it as current work, act on it,
then reply or record structured state through Tachikoma.
