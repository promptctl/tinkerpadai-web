default: dev

dev:
    pnpm dev

test:
    pnpm test

# Seed the commons from a briefs manifest via the running server's real API.
# No default concurrency here: an empty token vanishes from the shell command, so the
# script's own fallback is the one source of the default. [LAW:one-source-of-truth]
seed manifest concurrency="":
    pnpm seed {{manifest}} {{concurrency}}

typecheck:
    pnpm typecheck
