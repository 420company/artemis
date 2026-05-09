import { shouldUseCookedLineInputForTest } from '../src/cli/blessedPrompt.js'
import { parseMultipleKeypresses, INITIAL_STATE } from '../src/input/parse-keypress.js'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function keyNames(input: string): string[] {
  const [events] = parseMultipleKeypresses(INITIAL_STATE, input)
  return events
    .filter((event): event is Extract<typeof event, { kind: 'key' }> => event.kind === 'key')
    .map(event => event.name ?? '')
}

assert(
  shouldUseCookedLineInputForTest('win32', {}) === false,
  'Windows should default to raw input so slash menus and picker arrows work',
)
assert(
  shouldUseCookedLineInputForTest('win32', { ARTEMIS_WINDOWS_COOKED_INPUT: '1' }) === true,
  'Windows cooked input escape hatch should be opt-in',
)
assert(
  shouldUseCookedLineInputForTest('win32', { ARTEMIS_WINDOWS_COOKED_INPUT: '1', ARTEMIS_WINDOWS_RAW_INPUT: '1' }) === false,
  'ARTEMIS_WINDOWS_RAW_INPUT=1 should override cooked input',
)
assert(
  shouldUseCookedLineInputForTest('darwin', { ARTEMIS_WINDOWS_COOKED_INPUT: '1' }) === false,
  'Non-Windows platforms should not use Windows cooked input',
)

assert(JSON.stringify(keyNames('\x1b[A\x1b[B\x1b[C\x1b[D')) === JSON.stringify(['up', 'down', 'right', 'left']), 'arrow CSI sequences should parse')
assert(JSON.stringify(keyNames('\x1bOA\x1bOB\x1bOC\x1bOD')) === JSON.stringify(['up', 'down', 'right', 'left']), 'application cursor sequences should parse')

console.log('windowsInputSmoke ok')
