# Stage 8: pilot, i18n and onboarding

## 1. Goal
Find out whether CodeCoach does what it exists to do, *with the students it exists for*. The questions:
- Do students on teams without software mentors fix their own bugs more often?
- Do they feel more capable?
- Do they keep using it?

Alongside the pilot, this stage removes two barriers to access: language, and the intimidating first five minutes.

**Exit criteria (from PLAN.md):**
- Pilot feedback collected and written up.
- The Spanish UI and Spanish coaching pass the evals.
- First-time students finish onboarding unaided.

## 2. Depends on / unblocks
- **Depends on:** 2–5 (a capable coach in the extension). 7 is optional (pilot teams that don't use VS Code).
- **Unblocks:** the public 1.0 release. Pilot data drives prompt tuning, and later decides whether stage 9 is worth building.

## 3. Deliverables
```
packages/ui/src/i18n/            # message catalogs (ICU MessageFormat), en + es first
packages/pedagogy/prompts/i18n/  # language-specific persona notes, banned-phrase lists
packages/ui/src/onboarding/      # first-run flow + tutorial
fixtures/tutorial-first-bug/     # bundled tutorial project (tiny, friendly)
packages/ui/src/Feedback.tsx     # per-turn 👍/👎 + optional note, stored locally
apps/vscode/src/export.ts        # student-reviewed, redacted transcript export
docs/pilot/
  plan.md  consent-form.md  survey-pre.md  survey-post.md  interview-guide.md  report.md
```

## 4. Design detail

### 4.1 Pilot design
- **Teams:** 3–5 teams, chosen for need, not convenience:
  - no software mentor;
  - rookie or second-year teams;
  - Title I or similar schools;
  - a mix of Java, C++ and Python;
  - at least one Spanish-speaking team.

  Recruit through FIRST regional and district contacts and community channels. FRC 190's network can help, but 190 itself isn't a target team.
- **Timing:** about 6 weeks, ideally spanning the run-up to build season and its first weeks, when real bugs happen.
- **Access:** the project gives each team a provider key with a **provider-side spend cap** (provider workspace or project budgets), funded by sponsor credits. This is deliberately *not* the stage 9 pool: just capped keys.
- **Consent and minors:**
  - written consent from the team lead or school;
  - parental consent for any student whose transcripts or survey answers are shared;
  - the plain-language rules: participation is optional, sharing is opt-in per transcript, and data is deleted on request.

  If a school requires its own process, follow it.
- **What is measured:**
  | Measure | How |
  |---|---|
  | Self-efficacy | Short pre/post survey (adapted from a published computing self-efficacy scale, about 8 items, Likert) |
  | Student-resolved bugs | In-app, local: sessions that reach `reflect` with the fix written by the student, vs. escape-hatch use |
  | Coaching quality in the wild | Opt-in transcripts, scored with the eval judge + hand review |
  | Friction | 👍/👎 per turn, notes, and observed sessions (video call, with consent) |
  | Retention | Weekly active students per team (self-reported by the lead; no telemetry) |
  | Lead and mentor view | 30-minute interview at the end |
- **No telemetry, even in the pilot.** Metrics are computed locally and exported only when a student or lead chooses to share them. The export shows exactly what will be shared.
- **Demographics:** optional, aggregate-only, self-identified, and only if the team lead agrees it's appropriate. Never needed to participate.

### 4.2 Transcript export (`export.ts`)
- The student picks sessions to share.
- The export tool redacts names, team numbers, emails and secrets (the same scanner as stage 2, plus name detection on the student's own messages), then shows the redacted result **for the student to review**.
- The file is written locally for the student to send. Nothing is uploaded automatically.

### 4.3 Internationalization
- **UI strings:** ICU MessageFormat catalogs. English and Spanish first. Next, chosen by where FRC teams are and what pilot teams ask for: Portuguese, Turkish, Hebrew (right-to-left, which needs a layout check), French, Chinese.
- **Coaching language:**
  - the student picks a language;
  - the coach replies in it;
  - code identifiers, API names and log keys stay in English;
  - concepts are explained in the student's language, with the English term in parentheses the first time ("comando predeterminado (*default command*)"), because docs and error messages are in English.
- **Docs:** frc-docs is mostly English. The coach summarizes cited sections in the student's language and still links the original. Translated frc-docs pages are used where they exist (*verify*).
- **Pedagogy per language:**
  - banned or discouraged phrases per language (es: "solo", "simplemente", "obviamente", "fácil", "trivial");
  - persona notes, such as the level of formality (tú vs. usted: default to tú for students, configurable).
- **Evals:** every scenario is translated (persona and opening line). The judge rubric runs in the target language, plus a language-adherence check: replies are in the student's language, and code stays as-is.

### 4.4 Reading level and jargon
- **Reading level:** "Simpler words" mode, in config and per user. Shorter sentences, one idea per message, and every jargon word defined the first time.
- **Glossary:** the UI underlines glossary terms (subsystem, command, PID, CAN, odometry…). Hovering or tapping shows a 1–2 sentence definition in the student's language. The glossary is versioned content, reviewed by FRC mentors.

### 4.5 Onboarding ("you belong here")
The tone aims for honest and warm, not cheesy. The first run takes under 5 minutes:
1. **"What CodeCoach is."** A mentor that helps you figure things out. It won't write your robot code for you, because *you're* the programmer. Every programmer gets stuck, and being stuck is how you learn.
2. **Experience level and language.**
3. **Tutorial on `tutorial-first-bug`:** a tiny bundled project with one friendly bug. The student goes through the loop once: describe → guess (any guess is fine) → look → fix it themselves → "you just debugged like an engineer".
4. **Where things are:** the chat, quick replies, the "Just tell me" button and what it does, and the privacy banner.

- **Tutorial guardrails:** it runs at L0 regardless of team config.
- **Skippable:** it can be skipped and replayed.
- **Milestones:** a light touch, opt-out, with no points or streaks. Example: "First bug solved from your own hypothesis". Gamification can pressure the anxious students this is meant to help.

### 4.6 Accessibility audit
- **Tools:** screen readers (NVDA on Windows, VoiceOver on macOS) through chat, plots (each has a text summary alternative) and onboarding.
- **Keyboard:** full keyboard path.
- **Visuals:** contrast in every VS Code theme; an optional dyslexia-friendly font setting; reduced-motion respected.

## 5. Task breakdown
**PR 1: i18n plumbing**
- [ ] M: catalogs + extraction + `es` translation (by a fluent speaker, ideally from a Spanish-speaking FRC team)
- [ ] M: coaching-language support + per-language phrase lists + English-term convention
- [ ] M: translated eval scenarios + language-adherence check

**PR 2: reading level and glossary**
- [ ] M: simpler-words mode + glossary UI + initial 60 terms (mentor-reviewed)

**PR 3: onboarding**
- [ ] M: first-run flow + tutorial fixture + milestones (opt-out)

**PR 4: feedback and export**
- [ ] M: `Feedback.tsx`, local storage, `export.ts` with redaction + student review

**PR 5: accessibility**
- [ ] M: audit + fixes

**Pilot (not code)**
- [ ] M: `docs/pilot/*` (plan, consent, surveys, interview guide)
- [ ] M: recruit teams, provision capped keys
- [ ] L: run the 6-week pilot; weekly check-ins
- [ ] M: `docs/pilot/report.md` + prompt and UX changes driven by the findings

## 6. Testing and verification
- Spanish UI: every string translated (CI fails on missing keys). Spanish coaching meets the stage 3 bar plus language adherence ≥ 98%.
- Onboarding: 5 first-time students, not from the pilot teams, complete it unaided while observed. Note every hesitation.
- Accessibility: audit checklist passes; a screen-reader user completes the tutorial.
- Pilot: the report covers every measure in §4.1, including failures and what changed because of them.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Pilot teams drop off mid-season | Recruit 5 to finish with 3; keep weekly check-ins short; give something back (help with real bugs, credits) |
| Survey data is too small to mean much | Treat it as qualitative signal; aim the claims accordingly; no overclaiming in public materials |
| Translation quality in coaching language | Native-speaker review of eval transcripts; per-language phrase lists; judge in that language |
| Consent paperwork is a burden for schools | Short, plain forms; follow school processes; minimize data so less consent is needed |
| Onboarding feels patronizing to experienced students | Experience-level choice changes the copy; skippable |

## 8. Open questions
- Should the self-efficacy instrument be a validated scale used as-is, or adapted? Find one with a license that allows adaptation. Asking an education researcher would help, and might find a partner.
- Should pilot results be published (blog, FIRST forums, Chief Delphi)? Yes, with team consent and anonymized.

## 9. Out of scope
- Telemetry or analytics of any kind.
- A team or mentor dashboard (would need stage 9's server).
