import test from 'node:test';
import assert from 'node:assert/strict';
import { localityChecker } from '../src/locality.js';

const where = localityChecker({ towns: ['Fort Payne', 'Rainsville', 'Section', 'Fyffe'], homeState: 'AL' });
const w = (job, opts) => where(job, opts).where;

test('location field: local town vs elsewhere', () => {
  assert.equal(w({ title: 'Cook', location: 'Fort Payne, AL' }), 'local');
  assert.equal(w({ title: 'Cook', location: 'Rainsville' }), 'local');
  assert.equal(w({ title: 'Cook', location: 'Birmingham, AL' }), 'away');
  assert.equal(w({ title: 'Analyst', location: 'Remote' }), 'away');
});

test('places named in the title or description', () => {
  assert.equal(w({ title: 'Program Aide – Birmingham Metro' }), 'away');
  assert.equal(w({ title: 'Administrative Assistant to the Scout Executive- Birmingham Office' }), 'away');
  assert.equal(w({ title: 'Field Development Manager - UK' }), 'away');
  assert.equal(w({ title: 'Nurse', snippet: 'Located in Gadsden, Alabama.' }), 'away');
  assert.equal(w({ title: 'Nurse', snippet: 'Our clinic in Fort Payne, AL is hiring.' }), 'local');
  assert.equal(w({ title: 'Clerk', snippet: 'Serving DeKalb County since 1950.' }), 'local');
});

test('common-word town names need the state in free text', () => {
  assert.equal(w({ title: 'Cashier', snippet: 'See section 3 of the handbook.' }), 'local');
  assert.equal(w({ title: 'Cashier', snippet: 'Work in Section, AL' }), 'local');
});

test('chain listings with no location are company-wide', () => {
  assert.equal(w({ title: 'VP, US Analytics' }, { chain: true }), 'away');
  assert.equal(w({ title: 'Line Cook' }, { chain: false }), 'local');
  assert.equal(w({ title: 'Store Associate', location: 'Fort Payne, AL' }, { chain: true }), 'local');
});
