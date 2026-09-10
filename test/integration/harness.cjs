/**
 * A minimal test harness for the integration suite.
 *
 * Deliberately hand-rolled rather than pulling in Mocha: Mocha's dependency
 * tree currently carries advisories that would show up in `npm audit`, and this
 * project's whole premise is a clean audit. Fifty lines buys that back.
 */

'use strict';

/** @type {{ name: string, fn: () => unknown | Promise<unknown> }[]} */
const cases = [];
/** @type {string[]} */
const suiteStack = [];

/** Groups tests under a heading. */
function suite(name, body) {
  suiteStack.push(name);
  try {
    body();
  } finally {
    suiteStack.pop();
  }
}

/** Registers one test. */
function test(name, fn) {
  cases.push({ name: [...suiteStack, name].join(' › '), fn });
}

/**
 * Runs every registered test in order.
 *
 * Sequential by design: these tests open editors and panels in one shared VS
 * Code window, so running them concurrently would make them fight over the UI.
 *
 * @returns {Promise<void>} rejects when any test fails
 */
async function runAll() {
  const failures = [];
  const started = Date.now();

  for (const testCase of cases) {
    try {
      await testCase.fn();
      process.stdout.write(`  ok   ${testCase.name}\n`);
    } catch (error) {
      failures.push({ name: testCase.name, error });
      process.stdout.write(`  FAIL ${testCase.name}\n`);
    }
  }

  const duration = Date.now() - started;
  process.stdout.write(
    `\n${cases.length - failures.length}/${cases.length} passed in ${duration} ms\n`,
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      process.stdout.write(`\n${failure.name}\n${describe(failure.error)}\n`);
    }
    throw new Error(`${failures.length} integration test(s) failed`);
  }
}

function describe(error) {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

/**
 * Waits for `condition` to hold.
 *
 * Integration assertions are inherently about state that settles a moment after
 * an action, so polling with a deadline is the honest way to express them.
 */
async function waitFor(description, condition, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = await condition();
      if (value) {
        return value;
      }
    } catch {
      // A condition that throws is simply not satisfied yet; keep polling until
      // the deadline and report the timeout rather than the transient error.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for: ${description}`);
}

module.exports = { suite, test, runAll, waitFor };
