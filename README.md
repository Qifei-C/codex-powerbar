# Powerbar

Powerbar is a status-line HUD for Codex CLI. It adds a denser, more operational footer: model, reasoning mode, Git context, context usage, 5h/7d rate windows, current plan step, and live tool activity.

![Powerbar screenshot](powerbar/docs/assets/hud-example.png)

## What This Repository Contains

- `powerbar/`: the Node/TypeScript HUD itself
- `.github/workflows/build-codex.yml`: GitHub Actions workflow that builds patched `codex` binaries
- `powerbar/patches/codex-statusline-command.patch`: the Codex patch applied during source/prebuilt builds

This repo is split intentionally:

- the repository root owns GitHub release automation
- `powerbar/` owns the runnable HUD, installer, tests, and patch files

## What Powerbar Does

- renders a Codex HUD directly in the terminal footer
- merges live Codex status-line env data with rollout JSONL data
- prefers env data for live usage percentages, while backfilling missing reset times and richer session state from rollout
- shows plan progress and tool activity in the same line so the footer stays useful under line limits
- supports both standalone rendering and Codex `status_line_command`

## Current Binary Support

GitHub builds and publishes patched binaries for:

- macOS Apple Silicon: `codex-darwin-arm64.tar.gz`
- Linux x86_64: `codex-linux-x86_64.tar.gz`

Intel macOS is no longer published as a prebuilt artifact. On Intel macOS, `powerbar/install.sh` falls back to source build.

## Quick Start

```bash
git clone https://github.com/Qifei-C/codex-powerbar.git
cd codex-powerbar/powerbar
./install.sh
```

Notes:

- `./install.sh` with no flags is the guided interactive flow
- `./install.sh --full` is the non-interactive fast path
- `./install.sh --source` forces a local source build of patched `codex`

## Where To Read Next

- Full user and developer guide: `powerbar/README.md`
- Install script: `powerbar/install.sh`
- Renderer and parser sources: `powerbar/src/`
- Tests: `powerbar/tests/`

## Release Model

- pushing to `master` updates the rolling `latest` pre-release with fresh patched binaries
- pushing a `codex-v*` tag creates a versioned release

The workflow lives at `.github/workflows/build-codex.yml`.
