import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import {
  candidateHomes,
  defaultExec,
  findJdk,
  majorFromVersion,
  parseJavaVersionOutput,
  parseReleaseFile,
  wpilibRoot,
  wpilibYears,
} from "../lib/jdk-probe.mjs";

describe("majorFromVersion", () => {
  test("modern versions", () => {
    assert.equal(majorFromVersion("17.0.20"), 17);
    assert.equal(majorFromVersion("25.0.4"), 25);
    assert.equal(majorFromVersion("25"), 25);
    assert.equal(majorFromVersion("21-ea"), 21);
  });
  test("legacy 1.x versions", () => {
    assert.equal(majorFromVersion("1.8.0_292"), 8);
  });
  test("garbage", () => {
    assert.equal(majorFromVersion(""), null);
    assert.equal(majorFromVersion("openjdk"), null);
  });
});

describe("parseReleaseFile", () => {
  test("Temurin-style release file", () => {
    const text = 'IMPLEMENTOR="Eclipse Adoptium"\nJAVA_VERSION="25.0.4"\nJAVA_VERSION_DATE="2026-07-21"\n';
    assert.deepEqual(parseReleaseFile(text), { version: "25.0.4", major: 25 });
  });
  test("CRLF line endings", () => {
    assert.deepEqual(parseReleaseFile('JAVA_VERSION="17.0.20"\r\nOS_NAME="Windows"\r\n'), {
      version: "17.0.20",
      major: 17,
    });
  });
  test("does not match JAVA_VERSION_DATE", () => {
    assert.equal(parseReleaseFile('JAVA_VERSION_DATE="2026-07-21"\n'), null);
  });
});

describe("parseJavaVersionOutput", () => {
  test("openjdk -version", () => {
    const out = 'openjdk version "17.0.20" 2026-07-21\nOpenJDK Runtime Environment (build 17.0.20+1)\n';
    assert.deepEqual(parseJavaVersionOutput(out), { version: "17.0.20", major: 17, home: null });
  });
  test("GA release with no minor", () => {
    assert.equal(parseJavaVersionOutput('openjdk version "25" 2025-09-16\n').major, 25);
  });
  test("Oracle java 8", () => {
    assert.equal(parseJavaVersionOutput('java version "1.8.0_292"\n').major, 8);
  });
  test("picks up java.home from -XshowSettings:properties", () => {
    const out = 'Property settings:\n    java.home = /opt/jdk-25\n    java.vendor = X\n\nopenjdk version "25.0.4"\n';
    assert.deepEqual(parseJavaVersionOutput(out), { version: "25.0.4", major: 25, home: "/opt/jdk-25" });
  });
  test("not java", () => {
    assert.equal(parseJavaVersionOutput("command not found"), null);
  });
});

describe("WPILib layout", () => {
  test("roots per OS", () => {
    assert.equal(wpilibRoot({ platform: "linux", homedir: "/home/s" }), path.join("/home/s", "wpilib"));
    assert.equal(wpilibRoot({ platform: "win32", env: {} }), "C:\\Users\\Public\\wpilib");
    assert.equal(wpilibRoot({ platform: "win32", env: { PUBLIC: "D:\\Public" } }), "D:\\Public\\wpilib");
  });
  test("years newest first, ignoring other entries", () => {
    const readdir = () => ["2025", "2027", "tools", "2026", "frccode"];
    assert.deepEqual(wpilibYears("/x", { readdir }), ["2027", "2026", "2025"]);
  });
  test("missing root", () => {
    const readdir = () => {
      throw new Error("ENOENT");
    };
    assert.deepEqual(wpilibYears("/x", { readdir }), []);
  });
});

describe("candidateHomes order", () => {
  test("per-version vars, then WPILib, then JAVA_HOME", () => {
    const ctx = {
      platform: "linux",
      homedir: "/home/s",
      readdir: () => ["2026", "2027"],
      env: {
        JAVA_HOME: "/jh",
        JAVA_HOME_25_ARM64: "/arm",
        JAVA_HOME_25: "/plain",
        JAVA_HOME_25_X64: "/x64",
        JAVA_HOME_17: "/seventeen",
      },
    };
    assert.deepEqual(
      candidateHomes(25, ctx).map((c) => c.source),
      ["JAVA_HOME_25", "JAVA_HOME_25_X64", "JAVA_HOME_25_ARM64", "WPILib 2027", "WPILib 2026", "JAVA_HOME"],
    );
  });
});

describe("findJdk against fake installs", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "jdk-probe-"));
  after(() => rmSync(tmp, { recursive: true, force: true }));

  function fakeJdk(dir, version) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "release"), `JAVA_VERSION="${version}"\n`);
    return dir;
  }

  const home = path.join(tmp, "home");
  const jdk17 = fakeJdk(path.join(tmp, "temurin-17"), "17.0.20");
  fakeJdk(path.join(home, "wpilib", "2026", "jdk"), "17.0.16");
  fakeJdk(path.join(home, "wpilib", "2027", "jdk", "Contents", "Home"), "25.0.4");
  const noJava = () => "";

  test("JAVA_HOME_17 wins over WPILib", () => {
    const r = findJdk(17, { platform: "linux", homedir: home, env: { JAVA_HOME_17: jdk17 }, exec: noJava });
    assert.equal(r.found, true);
    assert.equal(r.source, "JAVA_HOME_17");
    assert.equal(r.version, "17.0.20");
  });

  test("falls back to WPILib, including macOS Contents/Home layout", () => {
    const r = findJdk(25, { platform: "linux", homedir: home, env: {}, exec: noJava });
    assert.equal(r.found, true);
    assert.equal(r.source, "WPILib 2027");
    assert.equal(r.home, path.join(home, "wpilib", "2027", "jdk", "Contents", "Home"));
  });

  test("a mismatched JAVA_HOME_N is skipped and reported", () => {
    const r = findJdk(21, { platform: "linux", homedir: home, env: { JAVA_HOME_21: jdk17 }, exec: noJava });
    assert.equal(r.found, false);
    assert.deepEqual(
      r.tried.map((t) => [t.source, t.got]),
      [
        ["JAVA_HOME_21", 17],
        ["WPILib 2027", 25],
        ["WPILib 2026", 17],
        ["java on PATH", null],
      ],
    );
  });

  test("java on PATH is the last resort", () => {
    const exec = (cmd) =>
      cmd === "java" ? '    java.home = /usr/lib/jvm/java-25\nopenjdk version "25.0.1" 2025-10-21\n' : "";
    const r = findJdk(25, { platform: "linux", homedir: path.join(tmp, "nobody"), env: {}, exec });
    assert.deepEqual(r, {
      found: true,
      major: 25,
      version: "25.0.1",
      home: "/usr/lib/jvm/java-25",
      source: "java on PATH",
    });
  });
});

describe("defaultExec", () => {
  test("keeps stderr from a successful command (java -version writes there)", () => {
    const script = `process.stderr.write(${JSON.stringify('openjdk version "17.0.1"')})`;
    const out = defaultExec(process.execPath, ["-e", script]);
    assert.equal(parseJavaVersionOutput(out)?.major, 17);
  });
  test("missing command gives empty output", () => {
    assert.equal(defaultExec("codecoach-no-such-command", []), "");
  });
});
