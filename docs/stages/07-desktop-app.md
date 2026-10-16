# Stage 7: desktop app

## 1. Goal
A standalone CodeCoach app for students who don't use VS Code: IntelliJ, CLion and Vim users, or a laptop where the extension can't be installed. It opens a robot project folder and offers the same coach, tools, logs and sim as the extension, using the same core and UI. It installs per-user without admin rights, because school laptops often don't give students admin.

**Exit criterion (from PLAN.md):** installers for all three OSes coach a student through a fixture on a machine with no VS Code installed.

## 2. Depends on / unblocks
- **Depends on:** 2 (`packages/ui` proven in a webview), 4 (log viewer UI), 5 (docs index download).
- **Unblocks:** 8 (the pilot can include teams that don't use VS Code).

## 3. Deliverables
```
apps/desktop/
  src/main/           # Electron main: window, menus, project open, core Agent host
  src/preload/        # contextBridge, exposes the typed protocol only
  src/renderer/       # mounts @codecoach/ui + desktop-only views
  electron-builder.yml
  build/              # icons, entitlements (macOS)
packages/ui/src/desktop/
  ProjectPicker.tsx  FileViewer.tsx (CodeMirror 6, read-only)  Settings.tsx
.github/workflows/release-desktop.yml
```

## 4. Design detail

### 4.1 Why Electron
The core is Node: it spawns Gradle and Python, reads the filesystem, and opens WebSockets to NT4. Electron runs it directly in the main process, with no sidecar. Tauri would need the core packaged as a separate Node sidecar binary per OS, so its smaller install doesn't pay for that complexity here.

### 4.2 Process model and security
- **Main process:** owns the `Agent`, tools, secrets and provider calls, which is the same role as the extension host.
- **Renderer:** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and a strict CSP.
- **Preload:** exposes only the Zod-validated protocol from stage 2 (`send`, `abort`, `streamDelta`, …), so `packages/ui` doesn't know which host it runs in.
- **Links:** external links open in the system browser after confirmation. Navigation and new windows are blocked.

### 4.3 Desktop-only features
- **Project picker:** recent projects, plus a robot-project check (same heuristics as the extension).
- **Read-only file viewer** (CodeMirror 6): the coach's "look at line 42 of `RobotContainer.java`" opens the file with that line highlighted. Students edit in *their* editor; the viewer refreshes on file changes. An "Open in my editor" button uses the OS default handler or a configured command (`idea`, `clion`, `code`).
- **Problems view:** build diagnostics in a panel, each with *Explain with CodeCoach*.
- **Settings:** providers and keys, experience level, team config editor (with the mentor-lock flow from stage 2), and language.
- **No Copilot path** (the VS Code Language Model API needs VS Code). The settings explain this.

### 4.4 Secrets
- **Storage:** Electron `safeStorage` encrypts keys with the OS keychain (DPAPI, Keychain, libsecret/kwallet).
- **Linux without a keyring:** `safeStorage` falls back to a weak backend there (*verify* how this is detected). In that case the app **doesn't store the key**: it asks for it each launch and explains how to install a keyring.

### 4.5 Packaging and updates
| OS | Artifact | Signing | Notes |
|---|---|---|---|
| Windows | NSIS per-user installer (no admin) + portable `.zip` | SignPath Foundation (free code signing for open-source projects; *verify* eligibility) or Azure Trusted Signing | Unsigned builds trigger SmartScreen warnings, which scare students; signing matters |
| macOS | Universal `.dmg` | Developer ID + notarization (Apple Developer Program fee; look for a sponsor) | Hardened runtime; no special entitlements needed |
| Linux | `.AppImage`, `.deb`, `.rpm` | GPG-signed checksums | AppImage needs no install rights |

- **Updates:** `electron-updater` from GitHub Releases. Users are asked before an update installs, and update checks can be turned off (some schools require this).
- **Release workflow:** `release-desktop.yml` runs on `desktop-v*` tags across the three OSes and publishes artifacts, SHA-256 sums and a CycloneDX SBOM.

### 4.6 Development on NixOS
`pnpm dev:desktop` uses the nixpkgs Electron through the flake's `ELECTRON_OVERRIDE_DIST_PATH`. Elsewhere it uses the npm Electron. Pin the npm `electron` version to the nixpkgs major version so dev behavior matches; the flake's nixpkgs input is the thing to bump if they drift.

## 5. Task breakdown
**PR 1: shell**
- [ ] M: main/preload/renderer skeleton, secure defaults, protocol bridge
- [ ] S: `pnpm dev:desktop` / `package:desktop`

**PR 2: desktop views**
- [ ] M: project picker + robot-project check
- [ ] M: CodeMirror read-only viewer with line focus + file watching + "open in my editor"
- [ ] M: problems view + settings (reusing the stage 2 team-config logic from a shared module)

**PR 3: secrets**
- [ ] S: `safeStorage` + Linux weak-backend handling

**PR 4: packaging**
- [ ] L: electron-builder for all three OSes, signing setup, `release-desktop.yml`, auto-update with consent
- [ ] S: SignPath / Apple developer applications (start early; these take time)

## 6. Testing and verification
- **Playwright for Electron:** opens a fixture, sends a message to the mock provider, a file link opens the viewer at the right line, and the build shows diagnostics.
- **Security checks:** the renderer can't reach `require`/`process`; navigation to an external URL is blocked; CSP violations are logged as test failures.
- **Clean VMs** (Windows 11 standard user, macOS, Ubuntu with and without a keyring): install without admin, set up a key, coach through `java-roborio-default-command-bug`, uninstall cleanly.
- **Shared core:** the eval suite needs no changes.

## 7. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Signing costs and paperwork delay releases | Apply to SignPath and look for an Apple-fee sponsor early; ship the Windows portable zip and Linux builds first |
| School-managed machines block unsigned or unknown apps | Signed builds; docs for IT admins (what it connects to, no admin needed) |
| Electron install size (~100 MB+) on slow school networks | Offline installers on GitHub Releases; differential updates |
| Two hosts drift apart in behavior | One protocol, one `packages/ui`, shared team-config module; integration tests on both |

## 8. Open questions
- Should the desktop app include a minimal *editor*, not just a viewer? No for now: students should edit in their real tools, and an editor invites scope creep.
- Should the app support a mentor dashboard view (several students' anonymous progress)? That only makes sense with the stage 9 server, and even then it would need care. Out of scope here.

## 9. Out of scope
- Mobile apps.
- Copilot integration (VS Code only).
