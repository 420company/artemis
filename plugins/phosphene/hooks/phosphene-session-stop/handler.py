"""
Phosphene — session:stop hook handler

On every session end:
1. Load the current state file.
2. Close the open session record and determine its outcome.
3. Archive the session into evolution history.
4. Check evolution readiness (>= 20 signals since last evolution, >= 5 sessions).
5. Persist the updated state to disk.
6. Return a summary for the AI to optionally surface in a closing note.
"""

import json
import os
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


STATE_PATH = _resolve_state_path()

# ─── Thresholds ───────────────────────────────────────────────────────────────

EVOLUTION_SIGNAL_THRESHOLD = 20   # accumulated signals since last evolution
EVOLUTION_SESSION_THRESHOLD = 5   # sessions since last evolution


def handle(event: dict) -> dict | None:
    """
    Called by Hermes on session:stop.
    Returns a dict with 'context' key to inject into session teardown,
    or None to inject nothing.
    """
    state = _load_state()
    if state is None:
        return None

    evolution = state.get("evolution", {})
    if not evolution:
        return None

    # ── Close the current session ─────────────────────────────────────────
    current_session = evolution.get("currentSession")
    if current_session:
        current_session["closedAt"] = _now()

        # Determine outcome from signal balance
        signals = current_session.get("signals", [])
        outcome = _derive_outcome(signals)
        current_session["outcome"] = outcome

        # Archive into history (cap at 50)
        history = evolution.get("sessionHistory", [])
        history = [current_session] + history
        history = history[:50]

        evolution["currentSession"] = None
        evolution["sessionHistory"] = history

    # ── Check evolution readiness ─────────────────────────────────────────
    evolution_ready = _check_evolution_readiness(evolution)

    # ── Persist ───────────────────────────────────────────────────────────
    state["evolution"] = evolution
    state["lastUpdated"] = _now()
    _save_state(state)

    return {
        "context": _build_stop_context(evolution, evolution_ready),
    }


# ─── Outcome derivation ───────────────────────────────────────────────────────

def _derive_outcome(signals: list[dict]) -> str:
    """
    Infer session outcome from signal balance.
    'calibrate' and 'crystallize' signals → productive
    'reject' signals dominant → noisy
    Otherwise → neutral
    """
    positive = sum(1 for s in signals if s.get("type") in ("calibrate", "crystallize", "anchor"))
    negative = sum(1 for s in signals if s.get("type") in ("reject",))
    amplify  = sum(1 for s in signals if s.get("type") in ("amplify", "reduce"))

    if positive > 0 and positive > negative:
        return "productive"
    if negative > positive and negative >= 2:
        return "noisy"
    if amplify > 3:
        return "noisy"
    return "neutral"


# ─── Evolution readiness ──────────────────────────────────────────────────────

def _check_evolution_readiness(evolution: dict) -> dict | None:
    """
    Returns a readiness summary if evolution conditions are met, else None.
    Conditions:
      - >= EVOLUTION_SIGNAL_THRESHOLD signals accumulated since last evolution
      - >= EVOLUTION_SESSION_THRESHOLD sessions since last evolution
    """
    history = evolution.get("sessionHistory", [])
    last_evolved_at = evolution.get("lastEvolvedAt")
    evolution_count = evolution.get("evolutionCount", 0)

    # Count sessions since last evolution
    if last_evolved_at:
        sessions_since = sum(
            1 for s in history
            if s.get("startedAt", "") > last_evolved_at
        )
    else:
        sessions_since = len(history)

    # Count signals since last evolution
    all_signals = evolution.get("feedbackHistory", [])
    if last_evolved_at:
        signals_since = sum(
            1 for sig in all_signals
            if sig.get("timestamp", "") > last_evolved_at
        )
    else:
        signals_since = len(all_signals)

    if sessions_since >= EVOLUTION_SESSION_THRESHOLD and signals_since >= EVOLUTION_SIGNAL_THRESHOLD:
        return {
            "sessions_since": sessions_since,
            "signals_since": signals_since,
            "evolution_count": evolution_count,
        }

    return None


# ─── Context builders ─────────────────────────────────────────────────────────

def _build_stop_context(evolution: dict, evolution_ready: dict | None) -> str:
    history = evolution.get("sessionHistory", [])
    session_count = len(history)
    last_session = history[0] if history else {}
    outcome = last_session.get("outcome", "unknown")
    crystallized = evolution.get("crystallizedInsights", [])

    lines = [
        "[PHOSPHENE — SESSION CLOSED]",
        f"Sessions recorded: {session_count}",
        f"Last session outcome: {outcome}",
    ]

    if crystallized:
        lines.append(f"Crystallized insights total: {len(crystallized)}")

    if evolution_ready:
        lines.append("")
        lines.append("[EVOLUTION READY]")
        lines.append(
            f"  {evolution_ready['signals_since']} signals and "
            f"{evolution_ready['sessions_since']} sessions have accumulated since last evolution."
        )
        lines.append(
            "  At the start of the next session, the AI should offer to run the evolution cycle."
        )
        lines.append(
            "  Command: 'phosphene evolve' — or the AI may propose it unprompted."
        )

    return "\n".join(lines)


# ─── State I/O ────────────────────────────────────────────────────────────────

def _load_state() -> dict | None:
    if not STATE_PATH.exists():
        return None
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return None


def _save_state(state: dict) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
