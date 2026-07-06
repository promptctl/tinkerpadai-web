default: dev

dev:
    pnpm dev

test:
    pnpm test

# Seed the commons from a briefs manifest via the running server's real API.
seed manifest concurrency="3":
    pnpm seed {{manifest}} {{concurrency}}

typecheck:
    pnpm typecheck
