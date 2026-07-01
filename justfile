default: dev

dev:
    pnpm tsx watch src/web/main.dev.ts

test:
    pnpm test

typecheck:
    pnpm typecheck
