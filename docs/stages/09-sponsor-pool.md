# Stage 9: sponsor token pool

> **Built last, and only if a sponsor commits.** The pool is fully separate from teams that use their own subscriptions: those teams never touch it, and nothing in stages 0a–8 depends on it. The client sees it as just another `ChatProvider`.
>
> **Spending amendment (2026-10-17).** The pool spends a sponsor's API credits through provider keys on the server, so it also needs the owner to lift the spending gate (PLAN.md, Decisions → Spending). It never spends the owner's money.

## 1. Goal
A sponsor funds a pool of LLM credit for teams that can't pay for their own. It works like this:
1. At the start of the season, teams apply for an allotment based on their meeting schedule and number of programmers.
2. A mediator reviews the application and grants credit.
3. The service releases it in weekly tranches, so it lasts all season.

Students use it through CodeCoach as normal. Every request goes through a metering proxy that:
- debits a ledger;
- enforces the pedagogy layer server-side, so the sponsor's money pays for *coaching*;
- never stores conversation content.

**Exit criteria (from PLAN.md):**
- End to end works: apply → mediator approves → student joins with a code → coach chat debits the balance shown in the extension.
- The ledger invariants hold under concurrent load.

## 2. Depends on / unblocks
- **Depends on:** 1 (the `ChatProvider` interface and the pedagogy package, reused server-side). Ideally also 8: the pilot's measured tokens per student-hour calibrate the allotment formula.
- **Unblocks:** nothing. It's the last stage.

## 3. Deliverables
```
services/pool/
  src/app.ts                 # Hono app
  src/auth/                  # magic links (mentors/mediators/sponsors), device tokens (students)
  src/ledger/                # double-entry ledger, holds, settlement (§4.4)
  src/allocation/            # suggested allotment + pacing (§4.3)
  src/proxy/                 # metering LLM proxy + server-side pedagogy (§4.5)
  src/db/migrations/*.sql    # Postgres schema (§4.2)
  Dockerfile  docker-compose.yml (app + postgres, for self-hosting)
apps/pool-web/               # React + Vite: apply, team dashboard, mediator queue, sponsor dashboard
packages/pool-protocol/      # Zod schemas + typed client shared by pool-web, providers/pool.ts, services/pool
packages/providers/src/pool.ts
docs/pool/{privacy-notice.md, mediator-guide.md, self-hosting.md, threat-model.md}
```
NixHub: add `postgresql` to the CodeCoach dev shell (or a separate `pool` devShell) when this stage starts.

## 4. Design detail

### 4.1 Roles
| Role | Who | Can |
|---|---|---|
| Admin | Project maintainers | Create pools, invite sponsors and mediators |
| Sponsor | The funding organization | See aggregate reports for their pool; fund it |
| Mediator | Appointed per pool | Review applications, set or adjust allotments, approve top-ups, pause teams; every action audited |
| Team coach | An **adult** registered coach/mentor of the FRC team. Every FRC team has registered adult coaches even without a *software* mentor (*verify* FIRST's current coach-role names) | Apply, manage join codes and devices, set per-student caps, see team usage |
| Student | Team member | Use the allotment through CodeCoach on a registered device |

### 4.2 Data model (Postgres, abridged)
```sql
pools(id, sponsor_org, name, currency, season, status, created_at)
users(id, email, role, created_at)                  -- adults only: admins, sponsors, mediators, coaches
pool_members(pool_id, user_id, role)
teams(id, frc_number, name, verified_at)            -- frc_number checked against a public team list
applications(id, pool_id, team_id, coach_user_id, season_start, season_end,
             meetings jsonb,        -- [{weekday, hours}] + exceptions
             programmers int, ecosystems text[], need_statement text,
             suggested_micro_usd bigint, status, decided_by, decided_at, decision_note)
allotments(id, application_id, total_micro_usd, schedule jsonb, status)
devices(id, team_id, nickname, token_hash, weekly_cap_micro_usd, created_at, revoked_at)
join_codes(id, team_id, code_hash, expires_at, max_uses, uses)
accounts(id, kind, ref_id)                          -- kind: pool | team | device | provider_spend
txns(id, kind, ref, actor_user_id, created_at)       -- grant | tranche | hold | settle | release | topup | season_close
entries(id, txn_id, account_id, amount_micro_usd)   -- signed; sum per txn = 0
usage(id, device_id, provider, model, input_tokens, cached_input_tokens, output_tokens,
      cost_micro_usd, txn_id, created_at)           -- metadata only, never content
audit(id, actor_user_id, action, target, detail jsonb, created_at)
```

### 4.3 Allocation and pacing
- **Suggested allotment:**
  `programmers × Σ meeting-hours over the season × tokens_per_student_hour × blended_price`.
  `tokens_per_student_hour` and `blended_price` are pool settings, seeded from stage 8's measurements. The suggestion is shown in dollars *and* as "about N coached hours", so mediators can reason about it.
- **Mediator decision:** approve as suggested, adjust (with a required note), or decline (with a note sent to the coach). Every decision is audited.
- **Pacing:**
  - each week's tranche = `total × w_week / Σ w`, where `w_week` = that week's scheduled meeting hours × a season multiplier (default 1.5 during build season);
  - unspent credit carries over for at most 2 weeks, and the excess returns to the pool;
  - at season end, the remainder returns to the pool (`season_close` txn).
- **Top-ups:** the coach requests with a reason; the mediator grants from what the pool has left.
- **Per-student caps** are optional: the coach sets a weekly cap per device, so one student can't use up the team's tranche.

### 4.4 Ledger
- **Double-entry.** Every transaction's entries sum to zero. Balances are always derived from entries; there is no mutable balance column.
- **Reserve then settle, per model request:**
  1. **Hold:** move `estimated_max_cost` from team-available (and the device cap) to a hold. The estimate is the counted input tokens × input price + `max_tokens` × output price.
  2. **Settle:** after the response, debit the actual cost from usage (including cache-read pricing) and release the rest of the hold.
  3. **Abort or error:** release the whole hold.
- **Concurrency:** `SELECT … FOR UPDATE` on the team and device account rows inside the hold transaction, at READ COMMITTED (or SERIALIZABLE with retry). The invariant tests run concurrent requests to prove balances never go negative.
- **Costs:** priced from a server-side price table (the same source as the client's `prices.json`, but authoritative on the server), with the price used stored on each `usage` row.

### 4.5 Metering proxy and server-side pedagogy
- **Endpoint:** `POST /v1/chat` (streams back Server-Sent Events). The device token goes in `Authorization`.
- **The client sends:** neutral messages (from `pool-protocol`), the coaching state and its tool definitions. It does **not** send a system prompt; the server ignores one if present.
- **The server:**
  - assembles the system prompt with `packages/pedagogy`, at the team's guardrail level from the allotment config, which only the coach can change;
  - checks the tool list against that level (rejecting `propose_diff` below L3);
  - forwards the request to the provider using the sponsor's key;
  - runs the streaming response checker on the output before relaying it.

  The quoted-code exclusion still works on the server, because the student's file contents arrive as tool results in the history.
- **Tools still run on the student's machine.** The proxy sees only model requests and responses. It is a relay, not an agent.
- **Content is never stored.** Logs hold usage metadata only. Request bodies are held in memory for the life of the request, then dropped. This is stated in `privacy-notice.md`.
- **Limits:**
  - per-device rate limits (requests/minute, concurrent streams);
  - a max request size;
  - a model allowlist per pool;
  - one active stream per device.

### 4.6 Identity and minors
- **Adults only have accounts.** Admins, sponsors, mediators and coaches sign in with an email magic link.
- **Students never give an email.**
  1. The coach creates a join code (short, expiring, limited uses).
  2. The student enters it in CodeCoach's setup and picks a nickname.
  3. The server issues an opaque random device token, stored hashed. The coach can see and revoke devices.
- **Teams** are verified against a public FRC team list (team number exists, name matches), and the mediator makes the final call.
- **Mediators see:** applications and aggregate usage per team. Never transcripts, because the server doesn't have them.

### 4.7 Web app (`apps/pool-web`)
| Page | Who | Content |
|---|---|---|
| Apply | Coach | Team number, season dates, weekly meeting schedule (a grid), programmers, ecosystems, need statement; live suggested allotment |
| Team dashboard | Coach | Status, total / released / used / this week's tranche, devices (nickname, usage, cap, revoke), join codes, top-up request |
| Mediator queue | Mediator | Applications with the suggestion and history; approve/adjust/decline with notes; pause/resume teams; top-up requests |
| Sponsor dashboard | Sponsor | Teams funded, total spend vs. budget, usage over time, opt-in aggregate outcomes (from stage 8-style surveys, if teams share them) |
| Audit log | Admin, Mediator | Every decision and change |

### 4.8 Client (`packages/providers/src/pool.ts`)
- **Setup:** "Join my team's sponsored pool" → base URL (defaults to the project's hosted pool) + join code + nickname. The device token is stored in SecretStorage or safeStorage.
- **Meter:** shows this week's remaining tranche and the device cap in place of dollars.
- **Errors:** friendly messages for "this week's credit is used up" (with the next release date), "device revoked" and "pool paused".
- **Guardrails come from the server.** The local guardrail level is ignored while using the pool, and the UI says so.

### 4.9 Deployment
- **Container:** one image (Node + Hono) plus Postgres. Runs on Fly.io, Render or a VPS, or `docker compose up` for a sponsor self-hosting it.
- **Secrets:** sponsor provider keys come from the platform's secret store, never the database.
- **Operations:**
  - daily Postgres backups with restore tested;
  - TLS everywhere;
  - CSRF protection and SameSite cookies on the web app;
  - dependency and container scanning in CI.

## 5. Task breakdown
**PR 1: schema and ledger**
- [ ] M: migrations, account/txn/entry model
- [ ] L: hold/settle/release + concurrency tests + invariant property tests

**PR 2: auth**
- [ ] M: magic links (adult roles), role-based authz middleware
- [ ] M: join codes + device tokens + revocation

**PR 3: allocation**
- [ ] M: suggested allotment, pacing schedule, tranche release job, carry-over, season close
- [ ] S: top-ups

**PR 4: proxy**
- [ ] L: `/v1/chat`: auth → hold → server-side pedagogy → provider stream → checker → relay → settle; rate limits
- [ ] M: `pool-protocol` + `providers/src/pool.ts` + client UX

**PR 5: web app**
- [ ] L: apply, team dashboard, mediator queue, sponsor dashboard, audit views

**PR 6: ops and docs**
- [ ] M: Dockerfile, compose, deploy config, backups
- [ ] M: privacy notice, mediator guide, self-hosting guide, threat model
- [ ] M: security review of the proxy and auth (before any real money flows)

## 6. Testing and verification
- **Ledger:** property tests (random request sequences; balances never negative; every txn sums to zero), and a concurrency test (200 parallel requests against a nearly empty tranche never overspend).
- **Allocation:** pacing unit tests (holiday weeks, schedule exceptions, carry-over cap, season close).
- **Proxy:** integration tests with a mocked provider:
  - a client-supplied system prompt is ignored;
  - `propose_diff` is rejected below L3;
  - a violating response is blocked mid-stream;
  - usage debits the right amount, with cache-read pricing;
  - an aborted stream releases its hold;
  - nothing from the content shows up in logs or the DB (grep test).
- **Auth:** expired or overused join codes rejected; a revoked device is rejected immediately; role checks on every route.
- **End to end:** apply → mediator approves → tranche released → student joins in the VS Code extension → coach chat → the dashboard balance and the extension meter both drop by the settled cost.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Abuse: using sponsored credit for non-robotics work | Server-side pedagogy prompt, guardrail level from the allotment, rate limits, per-device caps, mediator pause |
| A leaked device token | Hashed at rest, revocable, per-device caps limit the damage |
| The service holds minors' data | Store no content; no student emails; nicknames only; written privacy notice; data deletion on request |
| Price changes make the ledger costs wrong | Server price table versioned; price stored per usage row |
| Operating cost and on-call burden for a volunteer project | Single container, managed Postgres, self-hostable by sponsors; this is why it's last and only built for a real sponsor |
| Mediator bias in allocations | Suggested allotment as an anchor, required notes on adjustments, audit log visible to the sponsor |

## 8. Open questions
- Who runs the hosted instance, the project or each sponsor? Default: the sponsor self-hosts, with the project's help.
- Should approved teams get provider-side spend-capped keys *instead* of a proxy? That's simpler, but it loses server-side pedagogy and pacing, and puts the sponsor's keys on student machines. It's a fallback if the proxy proves too costly to run.
- Should sponsors see opt-in per-team outcomes (beyond aggregates)? Only with team consent, and probably not in v1.

## 9. Out of scope
- Payments and billing integration (sponsors fund out of band; the ledger is credit, not money).
- Storing or reviewing conversation content for any reason.
- Any requirement for teams using their own keys to register.
