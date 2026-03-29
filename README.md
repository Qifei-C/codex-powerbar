# Powerbar

Powerbar is an open-source status line HUD for Codex CLI, rendering Claude-HUD style usage and session status directly in the terminal.

![Powerbar screenshot](powerbar/docs/assets/hud-example.png)

## What This Project Does
- Parse Codex rollout logs (`~/.codex/sessions/**/rollout-*.jsonl`)
- Show model, project, branch, and usage windows (5h, 7d) in the HUD
- Auto-select Spark limits when the active model is `spark`, otherwise use default limits
- Support color control via `NO_COLOR` and `FORCE_COLOR`

## Repository Layout
The active project files are currently under `powerbar/`.
- Main guide: `powerbar/README.md`
- Source: `powerbar/src/`
- Tests: `powerbar/tests/`
- Installer: `powerbar/install.sh`
- Codex patch: `powerbar/patches/codex-statusline-command.patch`

## Quick Start
```bash
git clone https://github.com/Qifei-C/codex-powerbar.git
cd codex-powerbar/powerbar
./install.sh
```

Guided install:
```bash
cd codex-powerbar/powerbar
./install.sh --interactive
```

`install.sh` automatically:
- Builds the HUD (`npm ci`, `npm run build`)
- Builds patched Codex and installs it to `~/.local/bin/codex`
- Configures `~/.codex/config.toml` with the status line command

## Supported Environment
- Linux (Ubuntu/Debian, Fedora/RHEL, Arch, openSUSE)
- bash / zsh
- Node.js + npm, Rust (`cargo`)

## Validate Install
```bash
codex --version
grep -n "status_line_command" ~/.codex/config.toml
powerbar --status-line --once --no-clear --cwd "$PWD"
```

## Support
- Bug reports: `https://github.com/Qifei-C/codex-powerbar/issues`
