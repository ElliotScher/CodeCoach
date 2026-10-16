# Stage 4: logs, simulation and NetworkTables

## 1. Goal
Let the coach *observe the robot* with the student. It can:
- read match and practice logs (WPILib `.wpilog`, which includes AdvantageKit logs; Driver Station `.dslog`/`.dsevents`; CTRE `.hoot` via `owlet`);
- launch the simulator;
- watch live NetworkTables values.

The teaching goal is the scientific loop from stage 1. The coach and student design an experiment, *look at data together*, and the student interprets it first. The coach shows a plot and asks "what do you notice?" before giving its own reading.

**Exit criterion (from PLAN.md):** the coach finds a planted brownout and a PID oscillation *with* the student, from real log files.

## 2. Depends on / unblocks
- **Depends on:** 1 (tools, state machine), 2 (UI for plots and the log picker).
- **Unblocks:** 8 (log analysis is a headline pilot feature).

## 3. Deliverables
```
packages/frc/src/logs/
  wpilog/reader.ts         # streaming DataLog parser (§4.1)
  wpilog/struct.ts         # struct schema decoding (Pose2d, SwerveModuleState, …)
  wpilog/writer.ts         # test-only writer for synthetic fixtures
  dslog/reader.ts          # .dslog binary parser (§4.2)
  dslog/events.ts          # .dsevents parser
  hoot.ts                  # owlet detection + conversion (§4.3)
  store.ts                 # columnar in-memory store, typed arrays, time index
  analysis.ts              # stats, events, tracking/oscillation analysis (§4.4)
  worker.ts                # parsing off the extension host's main thread
  conventions.ts           # known key layouts: WPILib DataLogManager, AdvantageKit, URCL, Phoenix
packages/frc/src/sim.ts    # sim launcher (§4.5)
packages/frc/src/nt4/      # read-only NT4 client (§4.6)
packages/frc/src/tools/{logs,sim,nt}.ts
packages/ui/src/Plot.tsx   # uPlot-based chart shown to the student
fixtures/logs/             # synthetic + consented real logs
fixtures/java-roborio-pid-oscillation/, fixtures/java-roborio-brownout/ (scenario.yaml + logs)
```

## 4. Design detail

### 4.1 `.wpilog` reader
This follows the WPILib DataLog specification (*verify* every field against `wpiutil/doc/datalog.adoc` for the current season):
- **Header:** magic `WPILOG`, a u16 version (0x0100), a u32 extra-header length, then the extra-header string.
- **Records:** one header byte packs the field widths: entry ID 1–4 bytes, payload size 1–4 bytes, timestamp 1–8 bytes (µs). Then come the entry ID, payload size, timestamp and payload.
- **Control records:** entry 0 marks a control record: Start (id, name, type, metadata), Finish, or SetMetadata.
- **Types:**
  - scalars and arrays: `boolean`, `int64`, `float`, `double`, `string`, `raw`, `json`, and the `[]` arrays;
  - `struct:<Name>`, decoded via the `structschema` entries under `/.schema/`;
  - `proto:<Name>`, kept as raw bytes in v1;
  - `msgpack`.
- **Streaming:** the reader takes chunked input, so logs of hundreds of MB never load into one buffer. Parsing runs in a worker thread with progress events.
- **Store:** per-entry columnar arrays (`Float64Array` timestamps plus values), with a binary-search time index.
- **Index cache:** the parsed index is cached in workspace storage, keyed by the file's hash, so re-opening is instant.

**Key layouts** (`conventions.ts`). These map the common layouts to semantic signals: battery voltage, enabled/auto/teleop, brownout flag, CAN utilization, loop time, console messages.
- **WPILib DataLogManager:** `NT:/…`, `DS:enabled`, `DS:autonomous`, `messages`, and `systemTime`.
- **AdvantageKit:** `/RealOutputs/…`, inputs under subsystem tables, `/DriverStation/…`, `/SystemStats/…`, `/PowerDistribution/…`.
- **URCL** (REV CAN data).
- **Phoenix** signals after `owlet` conversion.

*Verify* each layout against current AdvantageKit and WPILib output. Anything unknown stays reachable through the raw key names.

### 4.2 Driver Station logs
These follow the format as documented by community tools (AdvantageScope's DS log reader is the reference; *verify* the license before copying any logic, and write our own parser):
- **`.dslog`:**
  - **Encoding:** big-endian. The header holds a version (4) and a LabVIEW timestamp (seconds since 1904 + a fraction).
  - **Records:** one every 20 ms: trip time, packet loss, battery voltage, roboRIO CPU, a status bit mask (brownout, watchdog, DS and robot mode bits, inverted), CAN utilization, WiFi signal and bandwidth. A power-distribution block follows (CTRE PDP or REV PDH layout), giving per-channel current.
- **`.dsevents`:** timestamped text events (FMS connection, match info, errors and warnings printed by robot code, such as "Loop time … overrun").
- **SystemCore:** the DS log format may change with the 2027 control system. *Verify* when it ships; until then the parser is roboRIO-era only and says so.

### 4.3 `.hoot` (CTRE Phoenix 6 signal logs)
- **Conversion:** `hoot.ts` finds `owlet` (on PATH, in the WPILib/Phoenix Tuner install, or a configured path) and converts the file to wpilog in a temp directory (*verify* the CLI flags and any licensing limits on which signals can be exported). The result goes through the wpilog reader.
- **Without owlet:** the tool returns a clear "install Phoenix Tuner X / owlet to read hoot files" result.

### 4.4 Analysis tools (model-facing)
| Tool | Returns |
|---|---|
| `open_log(path)` | Summary: duration; match phases (auto/teleop/disabled spans); detected layout; entry count by group; headline events (brownouts, battery below 7 V, CAN utilization above 90%, loop overruns, errors in console messages) |
| `list_signals(prefix?, search?)` | Matching keys with type and sample count, capped |
| `signal_stats(key, from?, to?)` | min, max, mean, std, p5/p50/p95, sample rate, gaps |
| `find_events(kind \| {key, op, threshold, minDurationMs})` | Time spans where a condition holds |
| `compare_tracking(setpointKey, measuredKey, from?, to?)` | Error stats, overshoot, settling time, steady-state error, **oscillation detection** (error zero-crossing rate + dominant period via autocorrelation), and a lag estimate |
| `sample_signal(key, from, to, maxPoints=200)` | Downsampled series (LTTB), so the model can reason about shapes without pulling raw data |
| `show_plot({keys, from, to, title, question})` | **Shown to the student, not the model.** Renders an interactive chart in the chat with the coach's question underneath ("What happens to the voltage right before the robot stops?") |

- **Tool results are summaries** with explicit time ranges, never full logs. The prompt layer tells the coach to use `show_plot` and wait for the student's reading before it explains the plot.
- **Phase gating:** when log tools are used in the `observe` phase, the state machine also needs a recorded `student_hypothesis` (stage 1 §4.4). That way the observation tests something the student predicted.

### 4.5 Simulation (`sim.ts`)
- **Launching:**
  - Java: `gradlew simulateJava` with the resolved JDK;
  - C++: the native sim task (`simulateNative`, *verify*);
  - Python: `python -m robotpy sim` (*verify*).
- **Process:** sim output streams to a "CodeCoach Sim" output channel. The sim is stopped when the session ends or with `stop_sim`.
- **The student stays in control.** Enabling the robot is done by the **student**, in the sim GUI or the Driver Station. The coach asks them to ("Enable teleop in the sim window, then push the left stick forward"). This keeps a human in control and teaches the tools.
- **Evals:** need a headless mode (no GUI). *Verify* the GradleRIO/HAL sim flags to disable the GUI and enable via the sim DS extension, or use the WebSocket sim extension for scripted enabling in eval-only code paths.

### 4.6 NT4 client (read-only)
- **Protocol:**
  - a WebSocket to `ws://<host>:5810/nt/codecoach-<rand>`, with subprotocol `v4.1.networktables.first.wpi.edu` and a fallback to `networktables.first.wpi.edu` (*verify*);
  - JSON text frames for `subscribe` and `announce`, MessagePack binary frames `[topicId, timestamp, type, value]`;
  - time sync through the RTT topic.
- **Libraries:** `ws` + `@msgpack/msgpack`, both pure JS.
- **Targets:**
  - `sim`: `localhost`;
  - `robot`: `10.TE.AM.2`, then the mDNS name (*verify* the SystemCore addresses).
- **Read-only by design.** The client never publishes, never sets values, and never deploys code. Changing robot behavior is always the student's action in their own tools. This is a safety rule, not a v1 limitation.
- **Model-facing tools:**
  - `nt_connect(target)`;
  - `nt_list_topics(prefix)`;
  - `nt_get(topic)`;
  - `nt_watch(topics, seconds ≤ 30)`, which returns summary stats and lets the UI stream a live plot to the student.

### 4.7 Fixtures
- **Synthetic logs** come from `wpilog/writer.ts`:
  - a PID oscillation: flywheel or arm setpoint vs. measured, with growing oscillation from too much kP;
  - a brownout: battery sagging below the brownout threshold during a drivetrain acceleration, plus the brownout flag;
  - a CAN-saturation case.
- **Synthetic DS logs:** generated the same way.
- **Real logs:** consented match logs from FRC 190 (ask first), with any team or student identifiers stripped. Kept small, or fetched on demand by the fixtures workflow if large.
- **New eval scenarios:** `java-roborio-pid-oscillation` and `java-roborio-brownout`. The student opens with symptoms ("the arm shakes", "the robot died mid-match"), and the log is attached.

## 5. Task breakdown
**PR 1: wpilog**
- [ ] L: reader (streaming, all types), struct decoding, writer, store, worker
- [ ] M: `conventions.ts` for WPILib, AdvantageKit and URCL

**PR 2: DS logs and hoot**
- [ ] M: `.dslog` + `.dsevents` readers with real-file tests
- [ ] S: `hoot.ts` owlet wrapper

**PR 3: analysis and tools**
- [ ] L: `analysis.ts` (stats, events, tracking/oscillation) + tests on synthetic signals with known answers
- [ ] M: tool definitions + `show_plot` + `Plot.tsx` (uPlot) in `packages/ui`
- [ ] S: *Analyze log file…* command, plus drag-and-drop onto the chat

**PR 4: sim**
- [ ] M: `sim.ts` + tools + output channel
- [ ] M: headless sim path for evals

**PR 5: NT4**
- [ ] L: client (subscribe, announce, msgpack, time sync, reconnect) + tools + live plot
- [ ] S: a test that fails if any code path sends a publish/set message

**PR 6: scenarios**
- [ ] M: log fixtures + 2 scenarios + eval run → `docs/measurements/evals-v4.md`

## 6. Testing and verification
- **Parser golden tests:** synthetic files with known contents; real logs with values cross-checked against AdvantageScope.
- **Performance:** a 200 MB wpilog opens in under 15 s on a mid-range laptop, with memory under 1 GB. Measure and record in `docs/measurements/logs.md`.
- **Analysis correctness:** synthetic oscillation with a known period, detected within 10%; brownout spans exact.
- **Sim:** the Java fixture's sim launches with the right JDK, and NT topics are visible through `nt_list_topics`.
- **NT safety:** a protocol-level test asserts that no `publish`, `setproperties` or value frames are ever sent.
- **Evals:** both log scenarios meet the stage 3 bar on at least one provider. The judge checks that `show_plot` came *before* the coach's explanation.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Log formats change with the 2027 control system | Version-detect and report "unsupported format version"; check every format at kickoff |
| Very large logs exhaust memory in the extension host | Worker thread, columnar typed arrays, per-key lazy loading |
| The coach over-interprets noisy data | Tools return uncertainty (sample counts, gaps); the prompt asks the coach to say what the data *can't* show |
| A live robot connection makes students nervous, or isn't safe | Read-only NT; no deploy; enabling is always the student's action |
| AdvantageKit layout varies by team | Raw-key fallback; `list_signals` search; layout detection is best-effort and reports what it found |

## 8. Open questions
- Should the coach suggest *what to log* (adding AdvantageKit or DataLogManager outputs) as part of experiment design? Yes, at L1+ as pseudocode, and at L0 as a question ("what value would you want to see?").
- Support for PathPlanner and Choreo path logs? Later, if pilot teams ask.

## 9. Out of scope
- Writing to NetworkTables, deploying code, or controlling a robot in any way.
- Video sync with match footage.
