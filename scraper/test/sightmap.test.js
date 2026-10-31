import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findApiUrl, parseData, planName, enrichUnits, fetchFeed } from '../src/adapters/sightmap.js';
import { parse as parseGriffis } from '../src/adapters/griffis.js';

const read = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const feed = JSON.parse(read('sightmap-feed.json'));

test('finds the data link in the embed page, escaped or not', () => {
  assert.equal(findApiUrl(read('sightmap-embed.html')), 'https://sightmap.com/app/api/v1/5evekeymvqo/sightmaps/101429');
  assert.equal(findApiUrl('"href":"https://sightmap.com/app/api/v1/y8px8l7qv19/sightmaps/121365"'), 'https://sightmap.com/app/api/v1/y8px8l7qv19/sightmaps/121365');
  assert.equal(findApiUrl('<html>nothing here</html>'), null);
});

test('plan names stored as JSON strings are unwrapped', () => {
  assert.equal(planName({ name: '{"name":"Shanghai","provider_id":"12"}' }), 'Shanghai');
  assert.equal(planName({ filter_label: 'S3.3', name: '{"name":"S3.3"}' }), 'S3.3');
  assert.equal(planName({ name: 'London' }), 'London');
});

test('parses units with numbers, floors, sizes, prices and sub-buildings', () => {
  const { plans, units, problems } = parseData(feed);
  assert.deepEqual(problems, []);
  assert.equal(plans.length, 3);
  assert.equal(units.length, 8);
  const u = units.find((x) => x.externalId === '3085280');
  assert.equal(u.unitNumber, '5161');
  assert.equal(u.floor, 1);
  assert.equal(u.sqft, 962);
  assert.equal(u.lowestRent, 1819);
  assert.equal(u.lowestRentMonths, 15);
  assert.deepEqual(u.leasePrices, { 15: 1819 });
  assert.equal(u.section, '2'); // complex has buildings 1, 2 and 3
  const view = units.find((x) => x.viewImageUrl);
  assert.equal(view.viewImageUrl, 'https://cdn.sightmap.com/views/park.jpg');
});

test('plans: counts and price ranges come from their units; empty plans stay listed', () => {
  const { plans } = parseData(feed);
  const milan = plans.find((p) => p.name === 'Milan');
  assert.equal(milan.availableCount, 7);
  assert.equal(milan.baseRent, 1428);
  assert.equal(milan.sqftMin, 673);
  assert.equal(milan.sqftMax, 733);
  assert.equal(milan.soonest, '2026-11-01');
  const london = plans.find((p) => p.name === 'London');
  assert.equal(london.available, false);
  assert.equal(london.availableCount, 0);
  assert.equal(london.imageUrl, null);
});

test('flags a feed that changed shape', () => {
  const { problems } = parseData({ data: { floor_plans: [], floors: [] } });
  assert.ok(problems.length >= 2);
});

test('enriches Griffis units with SightMap unit numbers by shared id', () => {
  const griffis = parseGriffis(read('griffis-sample.html'));
  const matched = enrichUnits(griffis, parseData(feed));
  assert.equal(matched, 8);
  const u = griffis.units.find((x) => x.externalId === '3085280');
  assert.equal(u.unitNumber, '5161');
  assert.equal(u.floor, 1);
  assert.equal(u.lowestRent, 1819, 'prices still come from the Griffis page');
});

test('fetchFeed follows the embed page to the data link', async () => {
  const calls = [];
  const fake = async (url, accept) => {
    calls.push([url, accept]);
    return url.includes('/embed/') ? read('sightmap-embed.html') : JSON.stringify(feed);
  };
  const json = await fetchFeed('https://sightmap.com/embed/60p7krjnw7n', fake);
  assert.equal(json.data.id, '101429');
  assert.deepEqual(calls[1], ['https://sightmap.com/app/api/v1/5evekeymvqo/sightmaps/101429', 'application/json']);
});
