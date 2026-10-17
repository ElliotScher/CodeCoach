# CodeCoach

**A virtual software mentor for FIRST Robotics Competition teams.**

> **Status:** early development. Nothing is ready to install yet. See [Roadmap and status](#roadmap-and-status).

## What CodeCoach is and why it exists

In FRC, software mentors tend to cluster on teams that are already strong. Many other teams have no software mentor at all, and their students teach themselves as they go. Students from traditionally marginalized backgrounds feel this the most: they often stay away from software because nobody has ever told them they can do this work.

CodeCoach is a chat assistant built for FRC. It can read your robot code, build output, simulation state and match logs. What sets it apart is *how* it helps: like a good mentor, it **coaches rather than does**. The goal is that students leave a session having fixed the bug themselves, and thinking "I can do this".

## Coaching principles

- **Suggest, don't write.** By default the coach gives hints and asks questions instead of handing over code.
- **Hypothesis first.** Before the coach explains a bug, it asks what you think is going on.
- **Debug like an engineer.** It walks you through describe → hypothesize → experiment → observe → fix → reflect, and designs small experiments with you.
- **Read logs together.** It analyzes match and simulation logs alongside you, rather than handing over a verdict.
- **Warm, never condescending.** No "just", "simply" or "obviously". Being stuck is normal.
- **Mentor-set guardrails.** A team mentor picks how much help the coach may give, from L0 (Socratic questions only, the default) to L3 (pair programmer that proposes diffs you review). The limit is enforced in code, not just in the prompt.
- **Private by default.** No telemetry. Conversations stay on your machine, and CodeCoach never sees or stores your AI account's sign-in.

## Supported ecosystems

Planned for v1:

- **Java** command-based, including **AdvantageKit** and log replay
- **C++**
- **Python** (RobotPy)
- **roboRIO** (JDK 17) and **SystemCore** (JDK 25) projects; CodeCoach picks the right JDK per project
- Logs: `.wpilog` (including AdvantageKit), Driver Station `.dslog`/`.dsevents`, and CTRE `.hoot` (with CTRE's `owlet` installed)
- AI access: through subscriptions you may already have, signed in with the vendor's own app (GitHub Copilot first, then ChatGPT via Codex and Gemini via the Gemini CLI). No API keys or per-request billing

## Installing the extension

Not released yet. CodeCoach will ship first as a VS Code extension that runs inside WPILib VS Code on Windows, macOS and Linux, followed by a standalone desktop app.

## Setting up a team

Not available yet. The plan:

- Each student signs in to a subscription they're eligible for (for example GitHub Copilot through GitHub's education benefits) using that vendor's own sign-in. CodeCoach never handles the credentials.
- A mentor (or student lead) runs *Set up CodeCoach for this team*, which writes `.codecoach/config.json` to the robot repo: guardrail level, allowed providers and models, monthly budget, language and reading level.
- An optional mentor passphrase locks the guardrail level.

## Development setup

You need Node 22 (22.12 or newer) and git. Then:

```sh
corepack enable
pnpm install
pnpm run doctor
pnpm build && pnpm test
```

`pnpm run doctor` checks your toolchain and reports optional tools (JDK 17/25, Python, VS Code, CTRE owlet). Use `pnpm run doctor`, not `pnpm doctor`, which is a different built-in pnpm command. See [docs/dev-setup.md](docs/dev-setup.md) for per-OS instructions and troubleshooting.

| Command | Does |
|---|---|
| `pnpm build` | Type-checks and builds every package, the CLI and the extension bundles |
| `pnpm test` | Unit tests (Vitest) |
| `pnpm lint` / `pnpm format` | ESLint / Prettier |
| `pnpm typecheck` | TypeScript, including tests and apps |
| `pnpm test:vscode` | Extension integration tests inside VS Code |
| `pnpm dev:vscode` | Rebuild on change and open an Extension Development Host |
| `pnpm package:vscode` | Build `apps/vscode/codecoach-<version>.vsix` |
| `pnpm fixtures [build\|test] [name]` | Build or test the robot projects in `fixtures/` with the right JDK or Python venv |
| `pnpm codecoach chat -p <project>` | Chat with the coach about a robot project (on a Claude Pro/Max subscription through Claude Code; see docs/dev-setup.md) |
| `pnpm codecoach analyze <project>` | Show what CodeCoach detects about a project and which JDK it needs |
| `pnpm codecoach eval [--smoke]` | Run the coaching evals on the same subscription (`--resume` after a usage limit) |
| `pnpm schema` | Regenerate the team config JSON schema |

## Roadmap and status

The full plan is in [docs/PLAN.md](docs/PLAN.md), with per-stage detail in [docs/stages/](docs/stages/README.md).

| Stage | What | Status |
|---|---|---|
| 0a | Dev environment: toolchain pins, `pnpm run doctor`, docs | Done |
| 0b | Workspace scaffolding and CI | Done |
| 1 | Core agent, pedagogy v1, CLI, evals | In progress |
| 2 | VS Code extension MVP | Not started |
| 3 | OpenAI and Google providers | Not started |
| 4 | Logs, simulation and NetworkTables | Not started |
| 5 | Docs index, FRC lints, deeper C++/RobotPy | Not started |
| 6 | Subscription adapters | Not started |
| 7 | Desktop app | Not started |
| 8 | Pilot, translations and onboarding | Not started |
| 9 | Sponsor token pool (optional) | Not started |

## License

[BSD-3-Clause](LICENSE).
