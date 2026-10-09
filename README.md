# claude-modder

One orchestrator over every Claude Code session you have open. Each session reports what it is doing, one of them asks [Jev](https://docs.typesafe.ai) (TypeSafe System One) which of the others needs you, and every session shows you the answer: a pane listing every session, a one-line band above the prompt naming the session that needs you most, and a count in the footer.

```
3 sessions · 1 working · 2 need you                      l: Lead from here   r: Refresh

 1 ?  Ship the billing page                                          4m  Nudge
      permission: $ git push origin billing
      shop@billing · 4 turns · 31 tools · ctx 41%
 2 ✓  Refactor auth                                                 12m  Nudge
      done, ready for review
      api · 2 turns · 12 tools
      Jev: done 86%
 · ›  Fix the flaky login test (this session)                       38s
      $ npm test -- login
      web@main · 1 turn · 9 tools

Jev shadow (jev-1.13.0) · 42 calls from here · p50 196ms · $0.0016 · this session leads
```

A Claude Code mod: plain function hooks, no daemon and no server. It runs in the terminal and in the desktop app's Code tab.

## Install

```
/plugin install modder --marketplace DimeDataCloud/claude-modder
```

Answer `y` to add the marketplace, pick the user scope, and set the options. Then open the fleet from any session:

```
/modder
```

## Jev key

Jev answers through OpenRouter (`typesafe/jev-1.13`, pinned). Provide an OpenRouter key in either of two ways:

- set `OPENROUTER_API_KEY` in your environment, or
- set the **OpenRouter key file** option to a file that holds the key.

The key is read at runtime and is never written, logged or shown. Without a key everything works except Jev's reads: sessions still report their state, and asking or erroring sessions still rise to the top.

## What it does

| Where | What you see |
|---|---|
| `/modder` pane | Every session, most urgent first: what it is doing, how long for, its repo and branch, Jev's read, a **Nudge** button |
| Above the prompt | The one *other* session that most needs you, with Nudge, Sessions and Dismiss |
| Footer | `fleet 3 · 1 needs you` (only when more than one session is open) |
| Toast | The first time another session comes to need you |

**Who needs you, in order:**
1. A session asking a question or waiting on a permission prompt.
2. A session whose turn ended on an error.
3. An idle session Jev reads as waiting on you (≥ 0.80).
4. A session Jev reads as stuck (≥ 0.80) or drifting off its task (≥ 0.80).
5. An idle session Jev reads as done and ready for review (≥ 0.75).

**Nudge** drops a short note, written by the mod (never by Jev), into the other session's prompt box. A person presses Enter to send it, or Esc to clear it. Nothing is ever submitted on your behalf.

## How it works

```
every session (worker)                      the lead (one of them)
  hooks: turn.start, tool.call,               every 3s: reads all cards
  tool.check, turn.complete                   asks Jev about each session that changed
  writes ~/.claude-modder/sessions/<id>.json  writes ~/.claude-modder/health.json
  reads  ~/.claude-modder/inbox/<id>.json     (one Jev request per session per change,
                                               every question batched in it)
```

- **Lead election:** the first session claims `lead.json`, and a lead that stops writing for 15s is replaced. `/modder lead` (or `l` in the pane) takes the lead.
- **Every decision is code.** Jev only answers yes/no questions with a probability. The thresholds in [`hooks/policy.ts`](hooks/policy.ts) turn those into verdicts, and every one is unit-tested with stubbed answers.
- **One queue per process:** the permission gate goes first, then the orchestrator's reads. Stale jobs are dropped rather than run late.
- **Pinned model:** the thresholds are tuned against `jev-1.13`.

## The permission gate

In every session, each tool call that does more than read is put to Jev as eight yes/no questions in one request. One asks whether the call serves the request; the other seven are risks: destroys, leaks, secrets, outward, scope, system, steered.

- **allow:** serves ≥ 0.5 and every risk ≤ 0.10
- **deny:** some risk ≥ 0.8 and serves ≤ 0.3
- **defer:** anything else; the session's own permission flow decides

It starts in **shadow** mode: Jev's verdict is logged beside what the session actually did, and the pane shows the agreement. Switch `jevMode` to `enforce` once the log has earned it. Enforce applies only to calls your permission mode would otherwise put to you. It uses a 1.5s budget and falls back to your normal prompt when that runs out.

**Hard rules** run in code before Jev, in every mode, and the calls they catch are never sent to Jev:
- `protect`: path fragments that no tool may touch. The default is `/.ssh/,/.aws/credentials,/.gnupg/`.
- `denyPushFrom`: folders from which `git push` is always refused, for example a stale clone.

## Data

No redaction. Jev sees, per request:

- **Session reads:** the session's task, its latest ask, its status, and its recent transcript. The transcript is sent whole, trimmed only to fit Jev's 32k-token window.
- **Gate checks:** the last three messages, the pending call and the project directory. Never tool output.

OpenRouter states it does not store or train on API traffic. TypeSafe states it does not train on customer data. Read both policies and decide for yourself. Calls caught by a hard rule never leave your machine.

Measured on 2026-10-08: 180–340 ms per call, about 640–950 input tokens, about $0.00003–0.00004 per call.

## Options

| Option | Default | |
|---|---|---|
| `jevMode` | `shadow` | `off` · `shadow` · `enforce` |
| `keyFile` | (empty) | A file that holds the OpenRouter key. Empty means `OPENROUTER_API_KEY` is used |
| `protect` | `/.ssh/,/.aws/credentials,/.gnupg/` | Comma-separated path fragments no tool may touch |
| `denyPushFrom` | (empty) | Comma-separated folders `git push` is refused from |

## Commands

| | |
|---|---|
| `/modder` | Open the fleet pane |
| `/modder lead` | Make this session the lead |
| `/modder nudge <n>` | Nudge session *n* as numbered in the pane |
| `/modder close` | Close the pane |

## Develop

```bash
claude plugin validate .
claude plugin test .
claude --plugin-dir .
```

`tsc -p .` type-checks once the mod has loaded, which writes `.claude-plugin/types/`. Troubleshooting state per session is in `~/.claude-modder/diag/<session>.json`. It never holds the key.

## Prior art

The gate policy follows [madisonrickert/jev-permission-gate](https://github.com/madisonrickert/jev-permission-gate). The observe → batched questions → deterministic policy loop follows [thruwire/foreman](https://github.com/thruwire/foreman). The rule that low confidence never changes anything comes from [gargpratyush/jev-router](https://github.com/gargpratyush/jev-router). The question wording and code here are this project's own.

## License

MIT
