# vibe-setup

Helps developers set up their ideal vibe coding environment: terminal theme, editor config, Spotify playlist, ambient tools, and dotfile recommendations for maximum flow state.

## Identity

- Public skill name: `vibe-setup`
- Version: 1.0.0

## What it does

- Recommends terminal color schemes and prompt configs (Starship, Oh My Zsh, etc.)
- Suggests Spotify playlist genres and moods for focused coding sessions
- Configures `.editorconfig`, `.nvmrc`, and common dotfiles
- Recommends ambient tools (background noise apps, focus timers, etc.)
- Sets up Artemis `soul.md` with a personality tailored to your working style

## When to use

Invoke when a user asks about setting up their dev environment for productivity, asks for music recommendations while coding, or wants to customize their coding atmosphere.

## Tool chain

1. Read current shell config (`~/.zshrc`, `~/.bashrc`)
2. Detect installed tools (node, python, git, etc.)
3. Suggest theme and prompt config
4. Configure `soul.md` with personality preferences
5. Output Spotify search queries and playlist recommendations

## Edge cases

- Skip Spotify suggestions if user has no Spotify account
- Respect existing dotfile configs — suggest additions, not replacements
- Works on macOS, Linux, and WSL
