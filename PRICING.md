# Talk2Me — Pricing & Credits

How usage is metered and sold. The numbers here are grounded in the **actual
Gemini Live native-audio rates** (the real COGS), not guesses. Treat the plan
prices as a defensible starting point to tune against real usage from
`/api/metrics` and token logs.

## Cost basis (COGS)

Talk2Me runs on `gemini-2.5-flash-native-audio` via the Gemini Developer API.
Native-audio rates (per 1M tokens):

| | per 1M tokens |
| --- | --- |
| Text input | $0.50 |
| Audio input | $3.00 |
| Text output | $2.00 |
| **Audio output** | **$12.00** ← the cost driver |

Audio tokenizes at **~25 tokens/second**, so:

- **Coach speaking:** 1,500 tok/min × $12/1M = **$0.018/min**
- **User speaking:** 1,500 tok/min × $3/1M = **$0.0045/min**

A typical 10-minute session is ~50/50 talk with some silence, plus cheap extras
(text recaps to the second coach, growing context, and the post-session
profile/debrief/logic-lens calls on `gemini-2.5-flash`). All-in:

> **~$0.12–$0.20 per 10-min session → plan at $0.015/min, conservative ceiling $0.025/min.**

Note: the "~2× from two Live sessions" only applies to the cheap input/context
side — only the responder produces audio, so the expensive **$12 output is not
doubled**.

## Core principle: metered minutes *are* the business model

At ~$0.015–$0.025/min, **an unlimited plan is not viable** — one daily-active user
can cost $5–7/mo. So the usage cap is not a temporary stopgap to remove later; it
**is** the paid boundary. Free = a small daily cap; paid = a larger monthly minute
allowance plus optional non-expiring top-up packs. You sell minutes (shown to users
as "credits" / "≈ sessions").

Meter internally in **minutes** (matches COGS exactly); display "minutes left ≈ N
sessions" (1 session ≈ 10 min; 1 LbD simulation ≈ 10 min).

## Plans

### Free — acquisition
- **10 min/day**, hard **150 min/month** ceiling.
- Worst-case ≈ 150 × $0.025 = **$3.75/mo** per fully-active free user; blended far
  lower. The daily + monthly ceilings are what bound abuse.
- *Reconcile the current "5 LbD simulations/day" (~40 min, too generous) down to
  ~1 sim/day, or fold LbD into the shared daily minute budget.*

### Subscriptions — primary offer (predictable, capped)

| Plan | Price/mo | Minutes (~/day) | COGS (base → ceiling) | Gross margin |
| --- | --- | --- | --- | --- |
| Casual | $6.99 | 100 (~3) | $1.50 → $2.50 | 79% → 64% |
| **Student** ⭐ | $12.99 | 250 (~8) | $3.75 → $6.25 | 71% → 52% |
| Pro | $24.99 | 600 (~20) | $9.00 → $15.00 | 64% → 40% |

### Top-up packs — pay-as-you-go (non-expiring)

| Pack | Price | $/min | Margin (base → ceiling) |
| --- | --- | --- | --- |
| 100 min | $7 | $0.070 | 79% → 64% |
| 250 min | $15 | $0.060 | 75% → 58% |
| 600 min | $30 | $0.050 | 70% → 50% |

Margins are healthy at the planning rate and stay positive at the conservative
ceiling — which is the point: the cap bounds the downside.

## Assumptions, levers & risks

- **Assumptions:** 25 tok/s audio; ~50/50 conversational split; ~10-min median
  session; +~30% overhead for recaps/context/post-session text. Replace these with
  real per-session minutes once `/api/metrics` + token logs accumulate.
- **Biggest cost lever:** audio *output* ($12/1M). Shorter coach turns, the
  single-responder design (already in place), and a cheaper cascaded path for some
  modes would cut COGS the most.
- **Stripe:** ~2.9% + $0.30 — keep one-off packs ≥ $5 and push the monthly sub as
  the default; the flat $0.30 punishes micro-purchases.
- **Hidden variable cost:** Google Search grounding bills per request after a free
  tier — meter or rate-limit it.
- **Free-tier abuse:** bounded by the daily + monthly ceilings, enforced with the
  same atomic-transaction pattern as `consumeLbdCredit`.

## Implementation status

The metering primitive lives in `db.js`:

- `getMinuteBalance(uid)` — plan allowance − this month's usage, plus non-expiring
  top-up minutes.
- `consumeMinutes(uid, minutes)` — atomic spend; draws from the monthly plan
  allowance first, then top-ups; never goes negative (returns a `shortfall` when
  the balance runs out mid-spend).
- `addTopupMinutes(uid, minutes)` — credit purchased minutes (call from a Stripe
  webhook).
- `PLAN_MONTHLY_MINUTES` — the allowance table above.

**Not yet wired into the live turn loop or billed via Stripe.** Next steps:
accrue minutes during a session (call `consumeMinutes` per turn or per N seconds),
gate the WS turn on remaining balance, add the daily free cap, and connect Stripe
checkout/webhooks for subscriptions and top-up packs. Sequencing stays **caps
before billing** (see [PLAN.md](./PLAN.md)).
