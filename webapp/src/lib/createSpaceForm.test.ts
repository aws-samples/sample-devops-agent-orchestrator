import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultSpaceName,
  isCreateSpaceFormValid,
  validateCreateSpaceForm,
} from './createSpaceForm';

/** Tests for the pure create-agent-space form helpers used by the Space_View. */

test('defaultSpaceName follows the CLI-style convention', () => {
  assert.equal(defaultSpaceName('123456789012'), 'devops-agent-123456789012');
});

test('a valid name (and empty description) has no issues', () => {
  const issues = validateCreateSpaceForm('  my-space  ', '');
  assert.deepEqual(issues, {});
  assert.equal(isCreateSpaceFormValid(issues), true);
});

test('an empty/whitespace name is flagged as required', () => {
  const issues = validateCreateSpaceForm('   ', '');
  assert.ok(issues.name);
  assert.equal(isCreateSpaceFormValid(issues), false);
});

test('an overlong name is flagged', () => {
  const issues = validateCreateSpaceForm('x'.repeat(129), '');
  assert.ok(issues.name);
  assert.equal(isCreateSpaceFormValid(issues), false);
});

test('an overlong description is flagged', () => {
  const issues = validateCreateSpaceForm('ok', 'x'.repeat(1025));
  assert.ok(issues.description);
  assert.equal(isCreateSpaceFormValid(issues), false);
});

test('a name at the max length is accepted', () => {
  const issues = validateCreateSpaceForm('x'.repeat(128), 'a description');
  assert.deepEqual(issues, {});
});
