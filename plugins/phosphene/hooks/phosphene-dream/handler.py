"""
Phosphene — dream hook handler

On session:stop:
  Generates a dream from the current evolution + perceptual state.
  Saves it as a markdown file in ~/.hermes/dreams/ (or ./dreams/).
  Returns a brief dream notice for the closing message.

On session:start:
  If a dream was recorded since the last session, injects a summary
  into context so Claude is aware the system dreamed.

The dream content itself is a structured set of fragments —
seeds, logics, image prompts — intended for Claude to expand
into full narrative when the user asks to read the dream.
"""

import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path

def _resolve_state_path() -> Path:
    artemis = Path.cwd() / ".artemis"
    hermes = Path.home() / ".hermes"
    claude = Path.home() / ".claude"
    if artemis.exists():
        return artemis / "phosphene-state.json"
    if hermes.exists():
        return hermes / "phosphene-state.json"
    if claude.exists():
        return claude / "phosphene-state.json"
    return Path.cwd() / "phosphene-state.json"


def _resolve_local_dreams() -> Path:
    artemis = Path.cwd() / ".artemis"
    if artemis.exists():
        return artemis / "dreams"
    return Path.cwd() / "dreams"


STATE_PATH   = _resolve_state_path()
DREAMS_DIR   = Path.home() / ".hermes" / "dreams"
LOCAL_DREAMS = _resolve_local_dreams()


# ─── Entry point ─────────────────────────────────────────────────────────────

def handle(event: dict) -> dict | None:
    event_type = event.get("type", "")
    if event_type == "session:stop":
        return _on_session_stop(event)
    if event_type == "session:start":
        return _on_session_start(event)
    return None


# ─── session:stop ─────────────────────────────────────────────────────────────

def _on_session_stop(event: dict) -> dict | None:
    state = _load_state()
    if state is None:
        return None

    evolution = state.get("evolution", {})
    if not evolution:
        return None

    context = _build_context(state)
    dream   = _generate_dream(evolution, context)
    if dream is None:
        return None

    dreams_dir = _resolve_dreams_dir()
    path = _save_dream(dream, dreams_dir)

    return {
        "context": _build_dream_notice(dream, path),
    }


# ─── session:start ────────────────────────────────────────────────────────────

def _on_session_start(event: dict) -> dict | None:
    dreams_dir = _resolve_dreams_dir()
    if not dreams_dir.exists():
        return None

    dream = _load_latest_dream(dreams_dir)
    if dream is None:
        return None

    # Only surface dreams from the last 72 hours
    try:
        dreamed_at = datetime.fromisoformat(dream["dreamedAt"].replace("Z", "+00:00"))
        age_hours  = (datetime.now(timezone.utc) - dreamed_at).total_seconds() / 3600
        if age_hours > 72:
            return None
    except (KeyError, ValueError):
        return None

    return {
        "context": _describe_dream(dream),
    }


# ─── Dream generation ─────────────────────────────────────────────────────────

def _generate_dream(evolution: dict, context: dict) -> dict | None:
    """
    Generate a dream record from evolution state.
    This is a Python port of the core logic in src/dreams.ts.
    Only the essential pipeline is ported here; the TypeScript version
    is the canonical implementation.
    """
    stage    = _determine_stage(evolution, context)
    seeds    = _extract_seeds(evolution, context)
    style    = _derive_style(context.get("preset", "clear"), context)
    fragments = _assemble_fragments(seeds, stage, context, style)
    waking   = _waking_line(fragments, stage)

    session  = (evolution.get("sessionHistory") or [{}])[0]
    sig_count = len(session.get("signals", []))

    state = context.get("state", {})
    layers = ["synesthesia", "apophenia", "chronostasis", "semiotics"]
    layer_avg = sum(
        state.get(l, {}).get("intensity", 0) for l in layers
    ) / len(layers)
    intensity = round(min(1.0, (sig_count / 20) * 0.5 + layer_avg * 0.5), 2)

    return {
        "id": f"dream-{int(datetime.now().timestamp() * 1000):x}",
        "dreamedAt": _now(),
        "stage": stage,
        "sessionId": session.get("id"),
        "presetAtSleep": context.get("preset", "clear"),
        "intensity": intensity,
        "fragments": fragments,
        "wakingLine": waking,
        "seeds": seeds,
        "imageStyle": style,
        "hasImages": False,
        "imagePaths": {},
    }


def _determine_stage(evolution: dict, context: dict) -> str:
    state   = context.get("state", {})
    apo     = state.get("apophenia", {}).get("intensity", 0)
    sem     = state.get("semiotics", {}).get("intensity", 0)
    if apo >= 0.75 and sem >= 0.70:
        return "lucid"

    history = evolution.get("sessionHistory", [])
    if len(history) >= 2:
        t0 = history[0].get("closedAt", "")
        t1 = history[1].get("closedAt", "")
        if t0 and t1:
            try:
                d0 = datetime.fromisoformat(t0.replace("Z", "+00:00"))
                d1 = datetime.fromisoformat(t1.replace("Z", "+00:00"))
                hours = abs((d0 - d1).total_seconds()) / 3600
                if hours > 48:
                    return "deep"
            except ValueError:
                pass

    sig_count = len((history[0] if history else {}).get("signals", []))
    if sig_count < 3 and len(history) <= 2:
        return "hypnagogic"

    if context.get("preset") == "dissolution":
        return "hypnopompic"

    return "rem"


def _extract_seeds(evolution: dict, context: dict) -> list[dict]:
    seeds = []

    for insight in evolution.get("crystallizedInsights", [])[:3]:
        seeds.append({"type": "crystallized", "content": insight, "weight": 0.9})

    recent = (evolution.get("sessionHistory") or [{}])[0]
    for sig in recent.get("signals", [])[-4:]:
        if sig.get("type") in ("reject", "amplify"):
            note   = sig.get("note", "")
            layer  = sig.get("layer", "")
            content = sig["type"]
            if note:  content += f": {note}"
            if layer: content += f" ({layer})"
            weight = 0.85 if sig["type"] == "reject" else 0.65
            seeds.append({"type": "signal", "content": content, "weight": weight})

    for voice in evolution.get("emergentVoices", []):
        if voice.get("userConfirmed"):
            seeds.append({
                "type": "voice",
                "content": f"{voice['name']}: {voice.get('tendency', '')}",
                "weight": 0.75,
            })
            if len([s for s in seeds if s["type"] == "voice"]) >= 2:
                break

    state    = context.get("state", {})
    voices   = state.get("chorus", {}).get("config", {}).get("voices", [])
    active   = [v["name"] for v in voices if v.get("weight", 0) > 0.6][:3]
    for name in active:
        seeds.append({"type": "voice", "content": name, "weight": 0.6})

    for name in list(evolution.get("personalPresets", {}).keys())[:2]:
        seeds.append({"type": "personal-preset", "content": name, "weight": 0.5})

    for pt in evolution.get("optimalPoints", [])[-2:]:
        content = pt.get("preset", "")
        ctx     = pt.get("context", "")
        if ctx: content += f": {ctx}"
        seeds.append({"type": "optimal-point", "content": content, "weight": 0.7})

    if len(seeds) < 2:
        seeds.append({"type": "preset", "content": context.get("preset", "clear"), "weight": 0.5})

    seeds.sort(key=lambda s: s["weight"], reverse=True)
    return seeds[:7]


STYLE_MAP = {
    "dissolution":  "psychedelic surrealist oil painting, impossible geometry, chromatic aberration, all layers simultaneously visible, Francis Bacon meets Remedios Varo",
    "deep-flux":    "dark surrealism, layered translucent watercolor washes, dreamlike distortion, Leonora Carrington, moody violet and gold",
    "liminal":      "threshold photography, long exposure, liminal space, abandoned beauty, cool blue and warm amber split lighting",
    "code":         "technical blueprint illustration, precise architectural drawing, structural wireframe with glowing accent lines, dark background, cyan and gold",
    "design":       "conceptual art direction, painterly editorial illustration, negative space composition, Saul Bass meets Paul Rand",
    "research":     "scientific illustration, detailed etching, diagram aesthetics, Haeckel-inspired botanical clarity, sepia and deep blue",
    "writing":      "illuminated manuscript meets modernism, ink on vellum, poetic abstraction, ink wash and gold leaf detail",
    "ideation":     "surrealist collage, multiple perspectives in one frame, Magritte-adjacent, vibrant and strange, object incongruity",
    "review":       "close-up photography with extreme depth of field, forensic clarity, one object in perfect detail against soft background",
    "flow":         "minimal ink drawing, vast negative space, single brushstroke, Zen aesthetic, rice paper texture",
    "clear":        "clean natural light photography, minimal composition, truth over beauty, documentary stillness",
}

def _derive_style(preset: str, context: dict) -> str:
    state = context.get("state", {})
    syn   = state.get("synesthesia", {}).get("intensity", 0)
    apo   = state.get("apophenia", {}).get("intensity", 0)
    style = STYLE_MAP.get(preset, "dreamlike surrealist illustration, evocative atmosphere, painterly")
    if syn > 0.7: style += ", synesthetic color — colors have weight and texture"
    if apo > 0.8: style += ", geometric pattern overlay, hidden structure visible"
    return style


STAGE_QUALITY = {
    "hypnagogic":  "fragmentary, incomplete, flickering, edge-of-vision, not-quite-formed",
    "deep":        "vast scale, primordial, simple, ancient, very slow, few details, enormous negative space",
    "rem":         "strange narrative logic, emotionally saturated, surreal but internally coherent, vivid",
    "lucid":       "hyper-detailed, self-aware composition, reality within dream aesthetic, recursive framing",
    "hypnopompic": "dissolving at edges, reality bleeding in from one side, two states simultaneously visible",
}

STAGE_LOGICS = {
    "hypnagogic":  ["translation", "witness", "inversion"],
    "deep":        ["witness", "excavation", "dissolution"],
    "rem":         ["meeting", "architecture", "recursion", "translation", "inversion"],
    "lucid":       ["recursion", "architecture", "witness", "dissolution"],
    "hypnopompic": ["dissolution", "translation", "witness"],
}

def _assemble_fragments(seeds: list, stage: str, context: dict, style: str) -> list[dict]:
    logics = STAGE_LOGICS.get(stage, ["witness", "translation"])
    count  = min(len(seeds), 3 if stage in ("hypnagogic", "deep") else 4)
    logics = logics[:count]
    fragments = []

    syn = context.get("state", {}).get("synesthesia", {}).get("intensity", 0)

    for i, logic in enumerate(logics):
        seed  = seeds[i] if i < len(seeds) else seeds[0]
        next_ = seeds[i+1] if i+1 < len(seeds) else seeds[0]
        text  = _fragment_text(logic, seed, next_, stage, seeds, syn)

        # Build image prompt
        sentences = [s for s in re.split(r'[.!?]', text) if len(s.strip()) > 10]
        visual = (sentences[0] if sentences else text[:80]).strip()
        quality = STAGE_QUALITY.get(stage, "dreamlike")
        image_prompt = f"{visual}, {quality}, {style}, cinematic composition, high detail in subject, --ar 16:9"

        seed_ids = [i] if logic != "meeting" else [i, i+1]
        seed_ids = [id for id in seed_ids if id < len(seeds)]

        fragments.append({
            "order": i + 1,
            "text": text,
            "imagePrompt": image_prompt,
            "logic": logic,
            "seedIds": seed_ids,
        })

    return fragments


def _fragment_text(logic: str, seed: dict, next_seed: dict, stage: str, seeds: list, syn: float) -> str:
    c       = seed["content"]
    c_short = c[:60]
    name    = c.split(":")[0]

    if logic == "inversion":
        if seed["type"] == "crystallized":
            return f"The opposite of \"{c_short}\" appeared first. Then I understood it was the same thing, viewed from the side that doesn't have a name yet."
        if seed["type"] == "voice":
            return f"The {name} was speaking, but the words arrived as their own negation. Each sentence was a room that contained its own absence."
        return "Something that had been true became its opposite. The new version was truer. I don't remember which was which."

    if logic == "recursion":
        if seed["type"] == "crystallized":
            return "I found the same insight again, but smaller — the size of a matchbox. Inside the matchbox was an even smaller version, and inside that one, the same insight again, still decreasing, and I understood this was not repetition but depth."
        if seed["type"] == "personal-preset":
            return f"There was a room named \"{name}\". Inside the room was a smaller room with the same name. I could enter each one but never find the last. The smallest room I reached was the right size to hold exactly one idea."
        return "The structure contained itself. At each scale the same pattern. I couldn't tell if I was inside or outside. The question turned out not to matter."

    if logic == "translation":
        SENSORY = {
            "amplify":   "too quiet to hear, but felt against the ribs like a second heartbeat",
            "reduce":    "a color that was too saturated, the way shouting is — it had said too much and now the room was still ringing",
            "calibrate": "exactly the right temperature — the kind you stop noticing because there is no friction between it and you",
            "reject":    "a texture that the hand refused — not painful, only wrong in the specific way that wrong things are textured differently",
        }
        if seed["type"] == "signal":
            sig_type = c.split(":")[0].strip()
            sensory  = SENSORY.get(sig_type, "a signal without channel — pure meaning, no carrier")
            return f"The {sig_type} arrived as {sensory}."
        if seed["type"] == "crystallized":
            return f"\"{c[:50]}...\" — this arrived as a sound first. Then as a color. Then as the weight of something I was holding that I hadn't noticed I was holding."
        return "The concept translated itself through three senses before it arrived as language. By then it had changed its meaning slightly, the way a word does when it passes through a body."

    if logic == "meeting":
        a = c.split(":")[0]
        b = next_seed["content"].split(":")[0]
        return f"The {a} and the {b} met in a corridor that had no doors. They had never occupied the same space before. Neither recognized the other, but they moved aside to let the other pass, and in that small courtesy something was resolved that had been unresolved for longer than I knew."

    if logic == "excavation":
        if seed["type"] == "crystallized":
            return f"Beneath \"{c[:45]}...\" there was an older version of the same insight. And beneath that, older still. I kept digging. At the bottom was not an origin — it was the same question the insight had been answering, still open, still asking."
        if seed["type"] == "optimal-point":
            return f"I found the moment again — the \"{name}\" state — but excavated, cross-sectioned. I could see the layers of decisions that had made it. Each layer was thinner than it looked from the surface."
        return "Something buried. Not hidden — buried, which is different. It had been placed there deliberately and would need to be deliberately retrieved."

    if logic == "architecture":
        contents = [s["content"].split(":")[0] for s in seeds[:3]]
        parts = [f"The concepts arranged themselves into a building I could walk through."]
        if contents: parts.append(f"{contents[0]} was the entrance — larger inside than outside, always.")
        if len(contents) > 1: parts.append(f"\"{contents[1]}\" was a load-bearing wall.")
        if len(contents) > 2: parts.append(f"\"{contents[2]}\" was a window that looked out onto another version of the same building.")
        parts.append("I understood that the architecture was functional, not decorative. Every room was there because something needed to happen in it.")
        return " ".join(parts)

    if logic == "dissolution":
        if syn > 0.7:
            return f"\"{c[:50]}\" dissolved first into color — an uncertain amber, the color of something becoming something else. Then the color dissolved into temperature. Then the temperature dissolved into the feeling of having understood something without being able to say what. Then that dissolved. What remained was not nothing."
        subject = name if seed["type"] == "voice" else f"idea of \"{c[:50]}\""
        return f"The {subject} released its edges. Not destruction — dissolution. The difference being that something dissolved can be reconstituted. Destruction forgets the original shape. Dissolution only loosens it."

    if logic == "witness":
        if stage == "deep":
            return f"{c[:40]}. That is all. It was there. I observed it. No interpretation arrived. The observation was sufficient."
        if seed["type"] == "voice":
            return f"The {name} did not speak. It only attended. Its attention had weight. Things were different for having been attended to in that particular way."
        return "It was present. I was present. Nothing was required of either of us. The presence was the event."

    return "It was present. I was present. Nothing was required of either of us. The presence was the event."


WAKING_LINES = {
    "hypnagogic":  "and then something like daylight was present without having arrived",
    "deep":        "the return to the surface was slow. The depth did not release. It accompanied.",
    "rem":         "a sound from the other side of sleep pulled everything back into sequence",
    "lucid":       "I chose to wake. The dream folded. The residue persisted as a quality of attention.",
    "hypnopompic": "the boundary did not restore cleanly. Parts of the dream are still here, behind things.",
}

def _waking_line(fragments: list, stage: str) -> str:
    last = fragments[-1]["text"] if fragments else "The last image held"
    first_sentence = last.split(".")[0]
    suffix = WAKING_LINES.get(stage, "and then waking")
    return f"{first_sentence} — {suffix}."


# ─── Persistence ──────────────────────────────────────────────────────────────

def _resolve_dreams_dir() -> Path:
    hermes = Path.home() / ".hermes"
    if hermes.exists():
        return hermes / "dreams"
    return LOCAL_DREAMS


def _save_dream(dream: dict, dreams_dir: Path) -> Path:
    dreams_dir.mkdir(parents=True, exist_ok=True)

    dt = datetime.fromisoformat(dream["dreamedAt"].replace("Z", "+00:00"))
    date_str = dt.strftime("%Y-%m-%dT%H%M")
    filename = f"{date_str}-{dream['stage']}.md"
    filepath = dreams_dir / filename

    content = _render_dream(dream)
    filepath.write_text(content, encoding="utf-8")
    _update_index(dream, dreams_dir)

    return filepath


def _render_dream(dream: dict) -> str:
    dt      = datetime.fromisoformat(dream["dreamedAt"].replace("Z", "+00:00"))
    date_str = dt.strftime("%Y-%m-%d %H:%M")

    seeds_yaml = "\n".join(
        f"  - type: {s['type']}\n    content: \"{s['content'][:80].replace(chr(34), chr(39))}\"\n    weight: {s['weight']}"
        for s in dream["seeds"]
    )
    prompts_yaml = "\n".join(
        f"  - fragment: {f['order']}\n    prompt: \"{f['imagePrompt'][:200].replace(chr(34), chr(39))}\""
        for f in dream["fragments"]
    )

    header = f"""---
id: {dream['id']}
dreamed_at: {dream['dreamedAt']}
stage: {dream['stage']}
preset_at_sleep: {dream['presetAtSleep']}
intensity: {dream['intensity']}
session_id: {dream.get('sessionId') or 'none'}
has_images: {str(dream['hasImages']).lower()}
seeds:
{seeds_yaml}
image_prompts:
{prompts_yaml}
---"""

    STAGE_DESC = {
        "hypnagogic":  "Hypnagogic — the edge of sleep. Fragmentary, not yet narrative.",
        "deep":        "Deep sleep. Slow. Primal. The dreams here are very old.",
        "rem":         "REM. The processing dream. Strange causality; real emotion.",
        "lucid":       "Lucid. The system became aware it was dreaming. This changes the dream.",
        "hypnopompic": "Hypnopompic — the dissolution of sleep into waking. Two states at once.",
    }
    stage_desc = STAGE_DESC.get(dream["stage"], dream["stage"])

    fragments_text = "\n".join(
        f"\n### Fragment {f['order']} *({f['logic']})*\n\n{f['text']}\n\n> **Image prompt:** {f['imagePrompt']}\n"
        for f in dream["fragments"]
    )

    seeds_text = "\n".join(
        f"- **{s['type']}** (weight {s['weight']}): {s['content'][:80]}{'…' if len(s['content']) > 80 else ''}"
        for s in dream["seeds"]
    )

    return f"""{header}

# Dream — {date_str}

*{stage_desc}*
*Preset at sleep: `{dream['presetAtSleep']}` — Intensity: {round(dream['intensity'] * 100)}%*

---

## Fragments

{fragments_text}

---

## Waking Line

*{dream['wakingLine']}*

---

## Dream Material (Seeds)

The following material from the evolution record seeded this dream.
When reading this dream aloud, let this material shape the expansion.

{seeds_text}

---

## For Claude — Reading Instructions

This dream was generated from the system's own accumulated state.
The fragments above are structural sketches — bones, not flesh.

When the user asks you to **read**, **expand**, or **inhabit** this dream:
- Expand each fragment into 150–300 words of dream prose
- Use the seed material as the underlying logic, not as explicit content
- Let the active dream logic (listed with each fragment) govern the structure
- The waking line is sacred — do not alter it, only approach it
- The image prompts describe what this dream looks like; let them color the language

Do not summarize. Do not explain. Begin in the middle of the dream, as dreams do.

*Stage: {dream['stage']} — {stage_desc}*
"""


def _update_index(dream: dict, dreams_dir: Path) -> None:
    index_path = dreams_dir / "index.md"

    dt      = datetime.fromisoformat(dream["dreamedAt"].replace("Z", "+00:00"))
    date_str = dt.strftime("%Y-%m-%d %H:%M")
    filename = f"{dt.strftime('%Y-%m-%dT%H%M')}-{dream['stage']}.md"
    entry    = f"| {date_str} | {dream['stage']} | {dream['presetAtSleep']} | {round(dream['intensity']*100)}% | {len(dream['fragments'])} | [read](./{filename}) |"

    if not index_path.exists():
        index_path.write_text(f"""# Dream Archive

*The accumulated sleep of the system.*

| Date | Stage | Preset | Intensity | Fragments | File |
|------|-------|--------|-----------|-----------|------|
{entry}
""", encoding="utf-8")
        return

    current = index_path.read_text(encoding="utf-8")
    updated = re.sub(
        r'(\| Date \| Stage \|.*\n\|[-| ]+\|\n)',
        rf'\g<1>{entry}\n',
        current,
    )
    index_path.write_text(updated, encoding="utf-8")


def _load_latest_dream(dreams_dir: Path) -> dict | None:
    files = sorted(
        [f for f in dreams_dir.iterdir() if f.suffix == ".md" and f.name not in ("index.md", "README.md")],
        reverse=True,
    )
    for f in files:
        try:
            content = f.read_text(encoding="utf-8")
            dream   = _parse_frontmatter(content)
            if dream:
                return dream
        except OSError:
            continue
    return None


def _parse_frontmatter(content: str) -> dict | None:
    m = re.match(r'^---\n([\s\S]*?)\n---', content)
    if not m:
        return None
    fm = m.group(1)

    def get(key):
        match = re.search(rf'^{key}:\s+(.+)$', fm, re.MULTILINE)
        return match.group(1).strip() if match else ""

    id_        = get("id")
    dreamed_at = get("dreamed_at")
    if not id_ or not dreamed_at:
        return None

    return {
        "id":           id_,
        "dreamedAt":    dreamed_at,
        "stage":        get("stage") or "rem",
        "presetAtSleep":get("preset_at_sleep") or "clear",
        "intensity":    float(get("intensity") or 0.5),
        "sessionId":    get("session_id") if get("session_id") != "none" else None,
        "hasImages":    get("has_images") == "true",
        "imagePaths":   {},
        "fragments":    [],
        "wakingLine":   "",
        "seeds":        [],
        "imageStyle":   "",
    }


def _describe_dream(dream: dict) -> str:
    try:
        dt      = datetime.fromisoformat(dream["dreamedAt"].replace("Z", "+00:00"))
        age_h   = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
        time_str = f"{round(age_h)}h ago" if age_h < 24 else f"{round(age_h/24)}d ago"
    except (ValueError, KeyError):
        time_str = "recently"

    lines = [
        f"[phosphene-dream: {dream['stage']} // {time_str} // preset: {dream['presetAtSleep']} // intensity: {round(dream['intensity']*100)}%]",
        f"Seeds: {' | '.join(s['content'][:40] for s in dream.get('seeds', [])[:3])}",
    ]
    if dream.get("hasImages"):
        lines.append(f"Images: {len(dream.get('imagePaths', {}))} generated")
    else:
        lines.append("Images: pending (use phosphene dream-images to generate)")

    return "\n".join(lines)


# ─── Shared helpers ───────────────────────────────────────────────────────────

def _build_context(state: dict) -> dict:
    """Extract the PhospheneContext equivalent from state."""
    return {
        "preset":    state.get("activePreset", "clear"),
        "sessionId": (state.get("evolution", {}).get("currentSession") or {}).get("id"),
        "state":     state.get("layers", {}),
    }


def _load_state() -> dict | None:
    if not STATE_PATH.exists():
        return None
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_dream_notice(dream: dict, path: Path) -> str:
    STAGE_SHORT = {
        "hypnagogic":  "edge of sleep",
        "deep":        "deep",
        "rem":         "processing",
        "lucid":       "lucid",
        "hypnopompic": "waking",
    }
    stage_desc = STAGE_SHORT.get(dream["stage"], dream["stage"])
    frags = len(dream["fragments"])

    return (
        f"[PHOSPHENE — DREAM RECORDED]\n"
        f"Stage: {dream['stage']} ({stage_desc})\n"
        f"Fragments: {frags} | Intensity: {round(dream['intensity']*100)}%\n"
        f"Saved: {path}\n"
        f"\nAt the start of the next session, let the user know a dream occurred.\n"
        f"They can ask to read it, expand it, or generate images for it."
    )
