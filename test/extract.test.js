import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePay, parseHours, jobsFromJsonLd } from '../src/extract.js';
import { applyEstimates, classifyRole, formatPay } from '../src/estimate.js';
import { parseRobots } from '../src/crawler.js';
import { parseElements, buildQuery } from '../src/places.js';

test('hourly range', () => {
  const p = parsePay('Line Cook — $16.50 - $19 per hour, part-time');
  assert.equal(p.hourlyMin, 16.5); assert.equal(p.hourlyMax, 19); assert.equal(p.unit, 'hour');
});
test('single hourly', () => assert.equal(parsePay('Starting pay $15/hr').hourlyMin, 15));
test('salary k', () => {
  const p = parsePay('Salary: $45k-$55k annually');
  assert.equal(p.unit, 'year'); assert.equal(p.min, 45000); assert.equal(p.hourlyMax, 26.44);
});
test('salary comma', () => assert.equal(parsePay('Compensation $52,000 per year').unit, 'year'));
test('word form', () => assert.equal(parsePay('pays 14 to 17 dollars an hour').hourlyMax, 17));
test('ignores product prices', () => assert.equal(parsePay('Burger combo $9.99, fries $3'), null));

test('hours parsing', () => {
  const h = parseHours('Part-time, 20-25 hours per week, weekends required. Mon-Fri 7am - 3pm');
  assert.deepEqual(h.types, ['Part-time']);
  assert.deepEqual(h.perWeek, { min: 20, max: 25 });
  assert.ok(h.schedule.length >= 2);
});
test('hours imply type', () => assert.deepEqual(parseHours('40 hours a week').types, ['Full-time']));

test('JSON-LD JobPosting', () => {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'JobPosting', title: 'Barista', employmentType: 'PART_TIME',
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 14, maxValue: 17, unitText: 'HOUR' } },
    description: '<p>Make coffee</p>' }] });
  const [j] = jobsFromJsonLd([ld], 'https://x.test/jobs');
  assert.equal(j.title, 'Barista'); assert.equal(j.pay.hourlyMax, 17); assert.deepEqual(j.hours.types, ['Part-time']);
});

test('role classification', () => {
  assert.equal(classifyRole('Kitchen Manager')[0], 'manager');
  assert.equal(classifyRole('Line Cook')[0], 'cook');
  assert.equal(classifyRole('Service Technician')[0], 'mechanic');
  assert.equal(classifyRole('Online Sales Associate')[0], 'retail');
});

test('estimates use nearby similar jobs first', () => {
  const jobs = [
    { title: 'Line Cook', businessId: 'a', pay: { hourlyMin: 17, hourlyMax: 20, unit: 'hour' }, hours: { types: ['Full-time'] } },
    { title: 'Prep Cook', businessId: 'b', pay: { hourlyMin: 15, hourlyMax: 18, unit: 'hour' }, hours: null },
    { title: 'Cook', businessId: 'c', pay: null, hours: null },
    { title: 'Dog Groomer', businessId: 'd', pay: null, hours: null },
  ];
  applyEstimates(jobs, { wageFloor: 16 });
  assert.equal(jobs[2].estimatedPay.hourlyMin, 16);
  assert.equal(jobs[2].estimatedPay.hourlyMax, 19);
  assert.match(jobs[2].estimatedPay.basis, /2 similar/);
  assert.match(jobs[2].estimatedHours.text, /Full-time/);
  assert.match(jobs[3].estimatedPay.basis, /typical/);
  assert.equal(jobs[0].estimatedPay, undefined);
});

test('formatPay', () => {
  assert.equal(formatPay({ hourlyMin: 15, hourlyMax: 18, unit: 'hour' }), '$15–$18/hr');
});

test('robots.txt', () => {
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /x\n\nUser-agent: *\nDisallow: /admin\nDisallow: /cart*'), ['/admin', '/cart']);
});

test('overpass parsing', () => {
  const q = buildQuery(1, 2, 1000, false);
  assert.match(q, /around:1000,1,2/);
  const out = parseElements([
    { type: 'node', id: 1, lat: 1.01, lon: 2, tags: { name: 'Far Cafe', amenity: 'cafe', website: 'farcafe.com' } },
    { type: 'way', id: 2, center: { lat: 1.001, lon: 2 }, tags: { name: 'Near Shop', shop: 'hardware', 'contact:website': 'https://near.shop/' } },
    { type: 'node', id: 3, lat: 1, lon: 2, tags: { name: 'Lot', amenity: 'parking', website: 'x.com' } },
  ], 1, 2);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Near Shop');
  assert.equal(out[0].website, 'https://near.shop');
  assert.equal(out[1].website, 'https://farcafe.com');
});
