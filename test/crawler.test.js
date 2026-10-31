import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { crawlBusiness, detectAts } from '../src/crawler.js';

const pages = {
  '/robots.txt': 'User-agent: *\nDisallow: /private',
  '/': '<html><body><nav><a href="/menu">Menu</a><a href="/join-our-team">Join Our Team</a></nav><h1>Joe\'s Diner</h1></body></html>',
  '/join-our-team': `<html><head><title>Careers at Joe's</title></head><body><h1>Join our team</h1>
    <p>Send your resume or apply in person.</p>
    <div class="job"><h3>Line Cook</h3><p>Full-time, $17 - $20 per hour. Evening shifts.</p></div>
    <div class="job"><h3>Server</h3><p>Part-time. Weekends required.</p></div>
    <div class="job"><h3><a href="/jobs/dishwasher">Dishwasher</a></h3></div>
    <h3>Apply Now</h3></body></html>`,
  '/jobs/dishwasher': '<html><body><main><h1>Dishwasher</h1><p>Pay: $15/hr. 25-30 hours per week.</p></main></body></html>',
  '/hiring-only': '',
};
const hiringSite = { '/': '<html><body><h1>Bob\'s Hardware</h1><p>We\'re hiring! Stop by the counter.</p></body></html>' };

function serve(routes) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const body = routes[req.url];
      if (body == null || body === '') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': req.url.endsWith('.txt') ? 'text/plain' : 'text/html' });
      res.end(body);
    }).listen(0, () => resolve(s));
  });
}

test('crawls a small business careers page', async () => {
  const s = await serve(pages);
  const r = await crawlBusiness(`http://127.0.0.1:${s.address().port}`);
  s.close();
  assert.equal(r.status, 'jobs');
  const byTitle = Object.fromEntries(r.jobs.map((j) => [j.title, j]));
  assert.deepEqual(Object.keys(byTitle).sort(), ['Dishwasher', 'Line Cook', 'Server']);
  assert.equal(byTitle['Line Cook'].pay.hourlyMax, 20);
  assert.deepEqual(byTitle['Line Cook'].hours.types, ['Full-time']);
  assert.equal(byTitle.Server.pay, null);
  assert.equal(byTitle.Dishwasher.pay.hourlyMin, 15);
  assert.deepEqual(byTitle.Dishwasher.hours.perWeek, { min: 25, max: 30 });
});

test('flags "now hiring" sites with no listings as leads', async () => {
  const s = await serve(hiringSite);
  const r = await crawlBusiness(`http://localhost:${s.address().port}`);
  s.close();
  assert.equal(r.status, 'hiring-page');
});

test('detects job boards', () => {
  const found = detectAts('<script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script><a href="https://acme.bamboohr.com/careers">x</a>');
  assert.deepEqual(found.map((f) => `${f.type}:${f.token}`), ['greenhouse:acme', 'bamboohr:acme']);
});
