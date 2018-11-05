// Copyright 2018 the Deno authors. All rights reserved. MIT license.
import { test, testPerm, assert, assertEqual } from "./test_util.ts";
import {
  run,
  Command,
  CommandOptions,
  DenoError,
  ErrorKind,
  ExitStatus
} from "deno";
import * as deno from "deno";

testPerm({ write: true }, async function runSuccess() {
  const status = await run("python", "-c", "print('hello world')");
  assertEqual(status.success, true);
  assertEqual(status.code, 0);
  assertEqual(status.signal, null);
});

testPerm({ write: true }, async function runCommandFailedWithCode() {
  let error: DenoError<ErrorKind.CommandFailed> & {
    command: Command;
    status: ExitStatus;
  };
  try {
    await run("python", "-c", "import sys;sys.exit(41 + 1)");
  } catch (e) {
    error = e;
  }
  assert(error !== undefined);
  console.log(error.stack);
  assert(error instanceof DenoError);
  assertEqual(error.kind, ErrorKind.CommandFailed);
  assertEqual(error.status.success, false);
  assertEqual(error.status.code, 42);
  assertEqual(error.status.signal, null);
  assertEqual(error.command.argv[0], "python");
  assert(/python.*import.*41.*42/.test(error.message));
});

testPerm({ write: true }, async function runCommandFailedWithSignal() {
  if (deno.platform.os === "win") {
    return; // No signals on windows.
  }
  const status = await run(
    "python",
    "-c",
    "import os;os.kill(os.getpid(), 9)",
    { throw: false }
  );
  assertEqual(status.success, false);
  assertEqual(status.code, null);
  assertEqual(status.signal, 9);
});

testPerm({ write: true }, async function runNotFound() {
  let error;
  try {
    await run({ argv: ["this file hopefully doesn't exist"] });
  } catch (e) {
    error = e;
  }
  assert(error !== undefined);
  assert(error instanceof DenoError);
  assertEqual(error.kind, ErrorKind.NotFound);
});

testPerm({ write: true }, async function runWithDirIsAsync() {
  const enc = new TextEncoder();
  const dir = deno.makeTempDirSync({ prefix: "deno_command_test" });

  const exitCodeFile = "deno_was_here";
  const pyProgramFile = "poll_exit.py";
  const pyProgram = `
from sys import exit
from time import sleep

while True:
  try:
    with open("${exitCodeFile}", "r") as f:
      line = f.readline()
    code = int(line)
    exit(code)
  except IOError:
    # Retry if we got here before deno wrote the file.
    sleep(1/100)
    pass
`;

  deno.writeFileSync(`${dir}/${pyProgramFile}.py`, enc.encode(pyProgram));
  const promise = run("python", `${pyProgramFile}.py`, { dir, throw: false });

  // Write the expected exit code *after* starting python.
  // This is how we verify that `run()` is actually asynchronous.
  const code = (Date.now() % 91) + 13;
  deno.writeFileSync(`${dir}/${exitCodeFile}`, enc.encode(`${code}`));

  const status = await promise;
  assertEqual(status.success, false);
  assertEqual(status.code, code);
  assertEqual(status.signal, null);
});

declare function fakeGetType<T>(): T;

test(function runTypeSignature() {
  // This test doesn't actually run anything; it just gets type checked.
  // This conditional serves to confuse typescript and not make it think that it
  // is dead code.
  if (typeof fakeGetType === "undefined") {
    return;
  }

  // The following should be accepted by the type checker.
  run({ argv: ["hello world"] });
  run("x");
  run("x", {});
  run("x", "x");
  run("x", "x", {});
  run("x", "x", "x");
  run("x", "x", "x", {});
  run(...fakeGetType<["a", "b"] | ["a", "b", {}]>());
  run(...fakeGetType<["a", {}] | ["a", "b", {}]>());
  run(...fakeGetType<[string, ...string[]]>());

  // The following should be rejected by the type checker.
  // TODO: is there a way to automatically test this?
  /*
  run();
  run({});
  run({ argv: [] });
  run({ argv: "waddup" });
  run("a", "b", {}, "d");
  run("a", "b", 11, "d");
  run("a", "b", "c", undefined);
  run("a", "b", "c", {}, undefined);
  run(undefined, "a", "b", "c");
  run(...fakeGetType<["a", {}, "c"] | ["a", "b", {}]>());
  run(...fakeGetType<string[]>());
  run(...fakeGetType<CommandOptions[]>());
  run(...fakeGetType<[string, string] | []>());
  */
});
