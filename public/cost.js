import { monthlyCost } from './operating-cost-model.js';

const get = id => document.getElementById(id);
const form = get('parameters');
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const wholeDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const unitDollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 });
const number = new Intl.NumberFormat('ko-KR');
const components = ['live', 'assets', 'server'];

function update() {
  const valid = form.matches(':valid');
  get('invalid').hidden = valid;
  get('levels').replaceChildren();
  if (!valid) {
    for (const id of ['total', ...components, 'per-hour', 'per-visit']) get(id).textContent = '—';
    for (const id of components) get('bar-' + id).style.flexGrow = 0;
    return;
  }
  const options = {
    concurrent: get('concurrent').valueAsNumber,
    layout: get('layout').value,
    reduction: get('reduction').valueAsNumber,
    peerDelivery: get('delivery').value === 'peers',
    plazaShare: get('plaza-share').valueAsNumber / 100,
    plazaHours: get('plaza-hours').valueAsNumber,
  };
  const result = monthlyCost(options);
  get('total').textContent = money.format(result.total);
  for (const id of components) {
    get(id).textContent = money.format(result[id]);
    get('bar-' + id).style.flexGrow = result[id] / result.total;
  }
  get('per-hour').textContent = result.perThousandHours === null ? '—' : unitDollars.format(result.perThousandHours);
  get('per-visit').textContent = result.perThousandVisits === null ? '—' : unitDollars.format(result.perThousandVisits);

  const sizes = new Set([100, 1000, 10_000, 100_000, options.concurrent]);
  for (const concurrent of [...sizes].sort((a, b) => a - b)) {
    const row = get('levels').insertRow();
    row.classList.toggle('selected', concurrent === options.concurrent);
    const label = document.createElement('th');
    label.scope = 'row';
    label.textContent = number.format(concurrent) + '명';
    row.append(label);
    for (const layout of ['neighborhoods', 'single']) {
      const estimate = monthlyCost({ ...options, concurrent, layout });
      row.insertCell().textContent = wholeDollars.format(estimate.total);
    }
  }
}

form.addEventListener('submit', event => event.preventDefault());
form.addEventListener('input', update);
update();
