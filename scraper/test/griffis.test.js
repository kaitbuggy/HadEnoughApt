import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse, parseSqft, extractJsConst } from '../src/adapters/griffis.js';
import { isAllowedByRobots } from '../src/fetch.js';

const html = readFileSync(new URL('./fixtures/griffis-sample.html', import.meta.url), 'utf8');

test('parses every plan card, including unavailable ones', () => {
  const { plans, problems } = parse(html);
  assert.deepEqual(plans.map((p) => p.name), ['Shanghai', 'Milan', 'London']);
  assert.deepEqual(problems, []);
});

test('reads sizes, prices and counts from an available plan', () => {
  const milan = parse(html).plans.find((p) => p.name === 'Milan');
  assert.equal(milan.externalId, '145316');
  assert.equal(milan.beds, 1);
  assert.equal(milan.baths, 1);
  assert.equal(milan.sqftMin, 673);
  assert.equal(milan.sqftMax, 741);
  assert.equal(milan.availableCount, 7);
  assert.equal(milan.priceFrom, 1498);
  assert.equal(milan.baseRent, 1428);
  assert.equal(milan.leaseMonths, 12);
  assert.equal(milan.unitIds.length, 7);
  assert.equal(milan.imageUrl, 'https://griffisresidential.com/wp-content/uploads/sites/2/2026/10/7db94bb3cf9c07179001a63775589329.jpg');
});

test('unavailable plan: studio, no price, zero count', () => {
  const london = parse(html).plans.find((p) => p.name === 'London');
  assert.equal(london.available, false);
  assert.equal(london.beds, 0);
  assert.equal(london.sqftMin, 644);
  assert.equal(london.sqftMax, 644);
  assert.equal(london.availableCount, 0);
  assert.equal(london.baseRent, null);
  assert.deepEqual(london.unitIds, []);
});

test('units: matched to plans, floor tag, lowest rent across lease lengths', () => {
  const { units } = parse(html);
  assert.equal(units.length, 8);
  const u = units.find((x) => x.externalId === '3085280');
  assert.equal(u.planExternalId, '145315');
  assert.equal(u.floorRef, 'floor_35672');
  assert.equal(u.availableOn, '2026-10-05');
  assert.equal(u.lowestRent, 1819);
  assert.equal(u.lowestRentMonths, 15);
  assert.equal(u.leasePrices[12], 1831);
});

test('flags a page whose layout changed instead of returning nothing silently', () => {
  const { plans, problems } = parse('<html><body><p>Under maintenance</p></body></html>');
  assert.equal(plans.length, 0);
  assert.ok(problems.some((p) => /layout may have changed/.test(p)));
});

test('flags a mismatch between plan counts and unit data', () => {
  const broken = html.replace('>7</span>', '>9</span>');
  assert.ok(parse(broken).problems.some((p) => /list 9|list 1\d/.test(p)));
});

test('helpers', () => {
  assert.deepEqual(parseSqft('1,183 - 1,391 Sq. Ft.'), [1183, 1391]);
  assert.deepEqual(extractJsConst('const a = {"s":"} ]","n":[1,2]}\nconst b = 1', 'a'), { s: '} ]', n: [1, 2] });
});

test('robots.txt check', () => {
  const robots = 'User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n';
  assert.equal(isAllowedByRobots(robots, '/property/the-domain/pricing-availability/'), true);
  assert.equal(isAllowedByRobots(robots, '/wp-admin/options.php'), false);
  assert.equal(isAllowedByRobots(robots, '/wp-admin/admin-ajax.php'), true);
  assert.equal(isAllowedByRobots('User-agent: *\nDisallow: /\n', '/anything'), false);
});
