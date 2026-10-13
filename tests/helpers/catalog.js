// Fixture parts catalog that mimics https://jlcsearch.tscircuit.com so finder tests are
// deterministic and offline. `mockCatalog(page)` intercepts the real URL in the browser;
// `startCatalog()` serves the same data on localhost for the node CLI (TRACE_FINDER_BASE).
import http from 'node:http';

const base = (o) => ({ description: '', stock: 5000, in_stock: true, is_basic: false, is_preferred: false, package: '0603', price1: 0.01, ...o });
const HOST = 'https://jlcsearch.tscircuit.com';

/** answer for a request path+query, or null for 404 */
export function answer(pathAndQuery) {
  const u = new URL(pathAndQuery, HOST), q = u.searchParams, p = u.pathname;
  if (p === '/resistors/list.json') {
    const r = Number(q.get('resistance')), pk = q.get('package');
    return { resistors: [
      base({ lcsc: 23138, mfr: 'R-' + r + '-BASIC', package: pk, resistance: r, power_watts: 100, stock: 1090237, price1: 0.0016, is_basic: true }),
      base({ lcsc: 3152163, mfr: 'R-' + r + '-LOWSTOCK', package: pk, resistance: r, power_watts: 100, stock: 18, price1: 0.0005 }),
      base({ lcsc: 999, mfr: 'R-' + r + '-OUT', package: pk, resistance: r, power_watts: 100, stock: 0, in_stock: false, price1: 0.0001 }),
    ] };
  }
  if (p === '/capacitors/list.json') {
    const c = Number(q.get('capacitance')), pk = q.get('package');
    return { capacitors: [base({ lcsc: 14663, mfr: 'C-' + c, package: pk, capacitance_farads: c, voltage_rating: 50, stock: 81299425, price1: 0.0022, is_basic: true })] };
  }
  if (p === '/leds/list.json') {
    return { leds: [base({ lcsc: 2899882, mfr: 'LED-' + q.get('color'), color: q.get('color'), package: q.get('package'), forward_current: 0.02, forward_voltage: 2.1, stock: 24430, price1: 0.0087 })] };
  }
  if (p === '/ldos/list.json') {
    return { regulators: [
      base({ lcsc: 347222, mfr: 'AMS1117-3.3', package: 'SOT-223', output_voltage_min: 3.3, output_voltage_max: 3.3, output_current_max: 1, dropout_voltage: 1.3, input_voltage_max: 18, stock: 2082576, price1: 0.0371, is_basic: true }),
      base({ lcsc: 7543, mfr: 'L78L05', package: 'SOIC-8', output_voltage_min: 5, output_voltage_max: 5, output_current_max: 0.1, stock: 1956295, price1: 0.052 }),
      base({ lcsc: 5884130, mfr: 'DS8242-33A3L', package: 'SOT-89-3', output_voltage_min: 3.3, output_voltage_max: 3.3, output_current_max: 0.05, stock: 497, price1: 0.0393 }),
    ] };
  }
  if (p === '/microcontrollers/list.json') {
    return { microcontrollers: [base({ lcsc: 707495, mfr: 'STM32G071', package: 'UFQFPN-28', supply_voltage_min: 1.71, supply_voltage_max: 3.6, stock: 12205, price1: 1.4105 })] };
  }
  if (p === '/components/list.json') {
    const s = (q.get('search') || '').toLowerCase();
    if (s.includes('ams1117')) return { components: [
      { lcsc: 22459274, mfr: 'AMS1117-3.3', package: 'SOT-223', description: '1A 3.3V LDO voltage regulator SOT-223', stock: 3942, category: 'Power Management', subcategory: 'Voltage Regulators - Linear', is_basic: false, is_preferred: false,
        price: '1-199:0.0509,200-599:0.04,600-:0.03' },
      { lcsc: 1, mfr: 'UNRELATED', package: '0603', description: 'ferrite bead', stock: 10, category: 'Filters', price: '1-:0.01' }] };
    if (s.includes('header')) return { components: [{ lcsc: 492401, mfr: 'PZ254V-11-06P', package: 'P=2.54mm', description: '1x6P 2.54mm pin header', stock: 1287508, category: 'Connectors', num_pins: 6, price: '1-:0.03' }] };
    return { components: [] };
  }
  return null;
}

export async function mockCatalog(page, opts = {}) {
  const calls = [];
  await page.route(HOST + '/**', (route) => {
    const url = route.request().url();
    calls.push(url);
    if (opts.offline) return route.abort('internetdisconnected');
    const body = answer(url.slice(HOST.length));
    return route.fulfill({ status: body ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body || { error: 'not found' }) });
  });
  return calls;
}

export function startCatalog() {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      const body = answer(req.url);
      res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body || { error: 'not found' }));
    });
    srv.listen(0, '127.0.0.1', () => ok({ url: 'http://127.0.0.1:' + srv.address().port, stop: () => srv.close() }));
  });
}
