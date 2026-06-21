# tinkerpadai-web

**TinkerPad** — a public commons of interactive playgrounds. Describe what you want
to tinker with, an agent generates a self-contained playground (controls + live
preview + a copyable prompt), and every playground anyone makes is stored and
usable by everyone else.

> The atomic primitive is a playground: one self-contained HTML file.
> Two pillars: spin one up at will, and the whole library belongs to everyone.

This repo is at the **founding stage** — no product code yet.

📄 **Start with [`design-docs/PROJECT.md`](./design-docs/PROJECT.md)** — the founding
document. It defines what TinkerPad is, why self-containment is sacred, the
create→share→remix loop, the sandbox-everything safety stance, and the open
decisions. Read it before building anything. ([`CLAUDE.md`](./CLAUDE.md) is the
operational guide for agents working in this repo and links to it.)

The artifact contract (self-contained HTML, controls + live preview + copyable
prompt) comes from Claude's `playground` skill; TinkerPad is the public front door
and commons around it.
