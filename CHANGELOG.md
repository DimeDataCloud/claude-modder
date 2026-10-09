# Changelog

## 0.2.1 · 2026-10-09

- **Skin covers every part a mod may draw.** The footer (mode labels and the hint line) is now a part: `/skin make the footer claude orange`. All 15 components in Claude Code's `RenderComponent` union are reachable, in the terminal and the desktop Code tab.
- **Tests.** 45 tests. A coverage test pins the skin to the engine's full component list; three more planted bugs are caught.

## 0.2.0 · 2026-10-09

- **Skin.** Natural-language workspace editing with `/skin <words>`.
  - Code reads most requests: parts, 44 colour names and hex, shades, border styles, overlay badges, relative moods, ten looks, undo and save/wear.
  - Claude reads the rest once, held to a strict schema, and the phrase is remembered for next time.
  - Two layers: render wrappers on 11 components, which work in the terminal and the desktop Code tab, and engine colour tokens in `~/.claude/themes/modder.json`.
- **Mind.** The permission gate records how each judged call ended, including your own approve/deny clicks, and refits its thresholds across the fleet.
  - Nothing changes before 20 outcomes.
  - A fit never gets a known outcome wrong and is never laxer than a fixed floor.
- **Hands.** Claude can call `mcp__modder__skin` to restyle its own workspace and `mcp__modder__mind` to see its fleet and what it has learned.
- **Pane** now has three tabs: Sessions, Skin, Mind.
- **Themes.** Ships the Clay and Clay Light themes.
- **Tests.** 40 tests, including a 400-history safety property and mutation checks on the safety-critical lines.

## 0.1.0 · 2026-10-08

- One orchestrator over every Claude Code session, with Jev deciding which one needs you: fleet pane, attention band, footer count, nudges.
- A shadow-first permission gate and hard rules in code.
