// Copyright 2018 the Deno authors. All rights reserved. MIT license.
import * as dispatch from "./dispatch";
import { DenoError, ErrorKind } from "./errors";
import * as flatbuffers from "./flatbuffers";
import * as msg from "gen/msg_generated";
import { assert, isObject, unreachable } from "./util";

export interface CommandOptions {
  argv?: string[];
  dir?: string | null;
  throw?: boolean;
}

export interface Command extends CommandOptions {
  argv: [string, ...string[]];
}

interface ExitCode {
  success: boolean;
  code: number;
  signal: null;
}

interface ExitSignal {
  success: false;
  code: null;
  signal: number; // TODO: Make this a string, e.g. 'SIGTERM'.
}

export type ExitStatus = ExitCode | ExitSignal;

// TODO: Move some of these small helper types to types.ts. Typescript won't
// allow it for some reason: "Import or export declaration in an ambient module
// declaration cannot reference module through relative module name."

// Exclude from T those types that are assignable to U.
export type Exclude<T, U> = T extends U ? never : T;
// An array or arraylike type with at least one element.
export type NonEmptyList<T> = [T, ...T[]];
// Remove the 'optional' modifier from all properties of T.
export type Required<T> = { [P in keyof T]-?: T[P] };

// Make a tuple type longer by prepending an element type.
// Unfortunately `type Prepend<S, T extends Array> = [S, ...T[]]` doesn't work.
// prettier-ignore
type Prepend<S, T extends Array<unknown>> =
  ((first: S, ...rest: T) => void) extends ((...all: infer R) => void)
    ? R
    : never;

// This type helps us define the call signature for `run()`, which accepts a
// variable number of arguments followed by an optional options object.
// prettier-ignore
type ArgsAndOptions<
  T extends Array<unknown>,
  Item, Opts
> = T &
  // GrowList starts with a 1-element tuple and grows it until its length is
  // compatible with T's length. We'll never match a 0-length tuple; don't try.
  GrowArgsAndOptionsList<Item, Opts, Exclude<T["length"], 0>> &
  // We don't want to match any T with only an options object no other items.
  { 0: Item };

// This type grows a tuple that has as many elements as TLen. It iterates,
// prepending one item each round, until its length is a supertype of TLen.
// prettier-ignore
type GrowArgsAndOptionsList<
  Item, Opts, TLen extends number,
  // Initialize the list with the type of the last argument of our variadic
  // function, which is where the options object might go.
  List extends Array<unknown> = [Item | Opts]
> = {
  continue: GrowArgsAndOptionsList<
    Item, Opts,
    // Drop the lengths that we've covered so far from TLen.
    Exclude<TLen, List["length"]>,
    // Insert another item at the beginning of the list.
    Prepend<Item, List>
  >;
  return: List;
  // Keep iterating until we've made a tuple for every length in TLen.
}[TLen extends List["length"] ? "return" : "continue"];

// Other command running functions should use the same options object,
// but they may use different defaults.
const defaultOptionsForRun = {
  dir: null,
  throw: true
};

/** Run an external process.
 *
 *   import { run } from "deno";
 *   run("curl", "http://deno.land/", "-o", "cool");
 *   run("ninja", "all", { dir: "target/debug" });
 *   run({ argv: ["git", "status"], throw: false});
 */
export function run(command: Command): Promise<ExitStatus>;
export function run(...argv: NonEmptyList<string>): Promise<ExitStatus>;
export function run<T extends Array<unknown>>(
  ...argvAndOptions: ArgsAndOptions<T, string, CommandOptions>
): Promise<ExitStatus>;

export async function run(
  ...p: [Command] | NonEmptyList<string | CommandOptions>
): Promise<ExitStatus> {
  const last = p[p.length - 1];

  // If the last parameter is an object, it must be the options object;
  // remove it from `p`. Otherwise assign it a default value.
  // After this `p` only contains strings.
  const partialOptions: CommandOptions = isObject(last) ? (p.pop(), last) : {};

  // Merge the argv from the options object with those specified separately.
  // The options object is owned by the caller, so we cant't mutate it.
  const argv = p as string[];
  if (partialOptions.argv) {
    argv.push(...partialOptions.argv);
  }
  if (!("0" in argv) /* Funky syntax is needed to satisfy typescript. */) {
    throw new TypeError("Run: missing argv.");
  }

  // Combine defaults, options and merged argv.
  const command: Required<Command> = {
    ...defaultOptionsForRun,
    ...partialOptions,
    argv
  };

  // Start the process and wait for it it exit.
  const status: ExitStatus = res(await dispatch.sendAsync(...req(command)));

  // Throw if the `throw` option is enabled and the process didn't exit cleanly.
  if (!status.success && command.throw) {
    // Wrap arguments that contain spaces and those that are empty in unusual
    // quotation marks, so the separation between them is clear, but without
    // suggesting that argv was actually quoted in a certain way.
    const pretty = command.argv
      .map(arg => (/[\s'"]|^$/.test(arg) ? `\u2039${arg}\u203A` : arg))
      .join(" ");
    const description = status.signal
      ? `killed with signal ${status.signal}`
      : `exit code ${status.code}`;
    const error = new DenoError(
      ErrorKind.CommandFailed,
      `Command ${pretty} failed: ${description}`
    );
    // Attach command info and exit status information to the error object.
    // TODO: use class CommandError so this works cleanly with typescript.
    Object.assign(error, { command, status });
    throw error;
  }

  return status;
}

function req({
  argv,
  dir
}: Required<Command>): [flatbuffers.Builder, msg.Any, flatbuffers.Offset] {
  const builder = flatbuffers.createBuilder();
  const argvOffset = msg.Run.createArgvVector(
    builder,
    argv.map(a => builder.createString(a))
  );
  const dirOffset = dir == null ? -1 : builder.createString(dir);
  msg.Run.startRun(builder);
  msg.Run.addArgv(builder, argvOffset);
  if (dir != null) {
    msg.Run.addDir(builder, dirOffset);
  }
  const inner = msg.Run.endRun(builder);
  return [builder, msg.Any.Run, inner];
}

function res(baseRes: null | msg.Base): ExitStatus {
  assert(baseRes != null);
  assert(msg.Any.RunRes === baseRes!.innerType());
  const res = new msg.RunRes();
  assert(baseRes!.inner(res) != null);

  switch (res.status()) {
    case msg.ExitStatus.ExitedWithCode:
      const code = res.exitCode();
      return { code, signal: null, success: code === 0 };
    case msg.ExitStatus.ExitedWithSignal:
      const signal = res.exitSignal();
      return { code: null, signal, success: false };
    default:
      return unreachable();
  }
}
