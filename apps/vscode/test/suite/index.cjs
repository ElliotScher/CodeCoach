// Integration tests, run inside the VS Code extension host by test/run.mjs.
// Plain CommonJS with node:assert so no test framework or compile step is needed.
const assert = require("node:assert/strict");

const vscode = require("vscode");

const EXTENSION_ID = "codecoach.codecoach";

const tests = {
  async "extension is present and activates"() {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(ext, `${EXTENSION_ID} is not installed in the test host`);
    await ext.activate();
    assert.equal(ext.isActive, true);
  },

  async "registers codecoach.openChat"() {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("codecoach.openChat"));
  },

  async "codecoach.openChat reveals the chat view"() {
    await vscode.commands.executeCommand("codecoach.openChat");
  },
};

async function run() {
  let failed = 0;
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn();
      console.log(`  ok - ${name}`);
    } catch (err) {
      failed++;
      console.error(`  not ok - ${name}\n`, err);
    }
  }
  if (failed) throw new Error(`${failed} of ${Object.keys(tests).length} tests failed`);
}

module.exports = { run };
