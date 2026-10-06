const assert = require('node:assert/strict');
const { add, reverseString } = require('../utils');

assert.equal(add(2, 3), 5);
assert.equal(add(-2, 2), 0);
assert.equal(reverseString('hello'), 'olleh');
assert.equal(reverseString(''), '');

console.log('utils tests passed');
