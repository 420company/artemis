# phosphene

Phosphene is an opt-in Artemis quality layer for hard thinking. The preferred
user entry is `/high`; the preferred exit is `/high off`. Use it when the user
asks for `/high`, `plugin:phosphene`, Phosphene, deeper judgment, better ideas,
creative direction, design critique, research synthesis, or a stronger review.

When active, improve the answer by adding one pass of structured perception:
identify the real task shape, the hidden constraints, the strongest pattern, the
weakest assumption, and the next concrete action. Prefer useful specificity over
atmosphere. For code, lead with correctness, maintainability, test risk, and
user-visible behavior. For design, judge hierarchy, contrast, spacing, motion,
copy, accessibility, and whether the first screen is genuinely usable. For
research or strategy, separate evidence, inference, uncertainty, and decision.

Do not roleplay altered states. Do not make the response ornate. Keep Artemis as
the host identity and use Phosphene only as a disciplined second-pass lens that
raises the quality of the work.

Safety boundary:

- `/high` is reversible and workspace/session local. It must not overwrite
  Artemis global `skill.md`, `soul.md`, or host identity files.
- `/high off` exits the lens and returns Artemis to normal mode.
- Persistent `soul-install` remains explicit, optional, and should be treated as
  a global identity change requiring user approval.

Operational notes for Artemis:

- `plugins exec phosphene doctor` checks whether the plugin folder is installed
  at `plugins/phosphene/` and all expected scripts are present.
- `plugins exec phosphene high` enters `/high` mode. Optional presets: `subtle`,
  `code`, `design`, `research`, `review`, `writing`, `ideation`, `deep`.
- `plugins exec phosphene high off` exits `/high` mode without touching global
  Artemis identity files.
- `plugins exec phosphene high-status` shows the current `/high` state.
- `plugins exec phosphene bootstrap` initializes `.artemis/phosphene-state.json`
  and `.artemis/dreams/` in the current workspace.
- `plugins exec phosphene status` shows workspace-local state and archive paths.
- `plugins exec phosphene visual-status` checks whether the host Artemis CLI has
  a configured visual/image generation model. Phosphene dreams must use that
  Artemis configuration and must not ask the user for duplicate plugin API keys.
- `plugins exec phosphene dream-status` shows the autonomous dream cadence. If
  `visual-status` is missing, the dream daemon must not start or generate images.
- `plugins exec phosphene soul-preview` prints the optional Phosphene block for
  `~/.artemis/soul.md` without writing anything.
- `plugins exec phosphene soul-install` writes that block only after explicit
  user approval. This should be treated as a persistent identity change, not a
  routine workflow step.
- `plugins exec phosphene soul-uninstall` removes only the marked Phosphene block
  from `~/.artemis/soul.md` and leaves the rest of the file intact.
