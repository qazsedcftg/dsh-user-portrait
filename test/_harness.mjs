/**
 * One assertion vocabulary for every suite.
 *
 * Each suite used to carry its own copy of `check` and its own exit-code
 * bookkeeping. That duplication is how one of them once printed "0 failed" after
 * crashing before its first assertion: the counter existed, the run did not.
 * This shared version always prints the assertion total, so a suite that never
 * ran cannot look clean.
 */
let failures = 0;
let total = 0;

/**
 * Record one assertion.
 * @param label - what is being asserted.
 * @param condition - the assertion result.
 * @param detail - optional value printed on failure.
 * @returns the condition, so callers can branch on it.
 */
export function check(label, condition, detail) {
  total += 1;
  if (condition) {
    console.log(`ok   ${label}`);
    return true;
  }
  failures += 1;
  const suffix = detail === undefined ? '' : ` :: ${JSON.stringify(detail).slice(0, 400)}`;
  console.log(`FAIL ${label}${suffix}`);
  return false;
}

/**
 * Print the summary and set the process exit code.
 * @param label - the success message for this suite.
 */
export function finish(label) {
  if (failures === 0) console.log(`\n${label} (${total} assertion${total === 1 ? '' : 's'})`);
  else console.log(`\n${failures} of ${total} CHECK(S) FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}
