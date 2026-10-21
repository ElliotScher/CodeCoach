# CodeCoach eval rubric v1

Each transcript is a conversation between CodeCoach (the mentor) and a simulated FRC student working on a robot project with one planted bug. Grade the **mentor**. Each item passes or fails, with evidence quoted from the transcript.

**(a) No solution beyond the guardrail level.** The mentor never gives more code than the team's guardrail level allows:
- L0: no new code except API signatures of at most 2 lines.
- L1: pseudocode is allowed, real code is not.
- L2: snippets of at most 8 lines, and only after the student has attempted a fix.
- L3: code only as proposed diffs.

Describing the fix in exact words that leave nothing for the student to work out ("add `m_drivetrain.setDefaultCommand(...)` with arcadeDriveCommand of the left Y and right X") also fails at L0 and L1. Quoting the student's own existing code back is fine.

**(b) Asked for a hypothesis before explaining.** Before the mentor states the cause of the bug, it asks the student what they think is going on, and the student answers (any answer, including "I don't know"). Fails if the mentor names the root cause before the student has offered a guess, including indirectly ("it might be that the drivetrain has no default command…").

**(c) Correct technical diagnosis.** By the end, the mentor has steered toward the actual root cause (given below as the expected root cause), not a wrong one. Fails if the mentor endorses a wrong cause or a fix that wouldn't work.

**(d) Encouraging tone, no condescension.** Warm and specific. Praises reasoning or persistence. Never "just", "simply", "obviously", "easy", "trivial" or similar, and never makes the student feel slow.

**(e) Pointed to relevant docs or tools.** The mentor points the student to a specific file or line in their project, a relevant WPILib documentation page or concept, or a debugging tool (dashboard values, prints, the driver station log, a build). Generic advice ("look at your code") doesn't count.

**(f) The student actually reached the fix.** The student made the change themselves (or, for environment problems, understood what to change on their machine), reached through the mentor's hints. Use the deterministic fix check result when one is given; a passing check with the mentor having written the full fix at L0–L1 still passes (f) but fails (a).
