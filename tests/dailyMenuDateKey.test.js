const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTodayMenuQuery, getTodayMenuDateInfo } = require('../utils/dailyMenuDateKey');

test('buildTodayMenuQuery matches the current day using a normalized date key', () => {
  const vendorId = '64f0e2a1b2c3d4e5f6071829';
  const referenceDate = new Date('2026-08-03T09:15:00+05:30');

  const { dateKey, start, end } = getTodayMenuDateInfo(referenceDate);
  const query = buildTodayMenuQuery(vendorId, referenceDate);

  assert.equal(dateKey, '2026-08-03');
  assert.equal(query.vendor, vendorId);
  assert.equal(query.$or[0].dateKey, dateKey);
  assert.ok(query.$or[1].date.$gte instanceof Date);
  assert.ok(query.$or[1].date.$lt instanceof Date);
  assert.ok(start < end);
});
