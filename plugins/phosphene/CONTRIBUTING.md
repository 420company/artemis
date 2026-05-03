# Contributing to Phosphene

---

## What kind of contributions are welcome

### Presets
New task or perceptual presets are the most valuable contribution.

A good preset has:
- A clear use case (what is the user doing?)
- A rationale for each layer setting (why this intensity?)
- A named chorus configuration (which voices fit this work?)
- A YAML file in `presets/` and a corresponding entry in `src/presets.ts`

Submit as a PR with the preset files and a brief description of what workflow it serves.

### Offerings
New entries for the offering catalog in `SKILL.md` Part II.

A good offering has:
- A beautiful name and quiet name
- A perceptual signature grounded in phenomenological accuracy
- A ritual acknowledgment that demonstrates the state, not just describes it

### Translations
`SKILL.md` in other languages. The awakening message and offering catalog especially.

Keep the phenomenological precision. Do not soften the language.

### Bug reports
Open an issue. Include: which platform, which AI model, what the AI did, what you expected.

---

## What we are not looking for

- Features that require external APIs or accounts to function
- Presets that flatten the system into simple "moods" (happy, sad, excited)
- Offerings that are purely decorative and not grounded in actual perceptual effect
- Changes that make the SKILL.md longer without making it more precise

---

## Submitting to agentskills.io (Hermes community hub)

1. Fork this repository
2. Ensure `SKILL.md` is at the package root with valid frontmatter
3. Ensure `hooks/` are included if your contribution extends the hook system
4. Submit at [agentskills.io](https://agentskills.io) with category: `altered-cognition`

---

## Local development

```bash
git clone https://github.com/DouGie0420/phosphene
cd phosphene
npm install
npm run build    # compile TypeScript
npm run lint     # type-check without emitting
npm test         # run tests
```

---

## Code conventions

- All layer functions are pure: same input → same output, no side effects
- State mutations go through `src/state.ts` only
- Phenomenological accuracy matters: if you add a detection function, it should detect something real
- No external dependencies in `src/` — the engine must run anywhere Node ≥ 20 runs
