import { monthlyCost, releaseCost, capacityProfile } from './operating-cost-model.js';

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

const releaseForm = get('release-parameters');
function updateRelease() {
  const profile = get('release-profile').value;
  const current = profile === 'current1000';
  get('release-layout-label').hidden = current;
  get('release-layout').disabled = current;
  if (current) get('release-layout').value = 'steady';
  get('release-evidence').textContent = current
    ? `입력 20명·이동 80명·독자 900명, 25%가 광장에서 출발한 ${capacityProfile.seconds / 60}분 실측입니다. 이 표본만으로 장기 안정성을 보장하지 않습니다.`
    : '이전 공개판의 입력 6명·이동 24명·독자 270명 실측입니다. 시간대 조합은 별도 분산·밀집 시험의 원가를 가중합니다. 새 전송 형식의 300명 재측정값은 아닙니다.';
  const scenario = get('release-layout').value;
  get('release-plaza-label').hidden = scenario !== 'mix';
  get('release-hours').disabled = scenario !== 'mix';
  const fields = ['total', 'live', 'assets', 'server', 'week', 'unit'];
  if (!releaseForm.matches(':valid')) {
    for (const field of fields) get('release-' + field).textContent = '—';
    return;
  }
  const result = releaseCost({
    profile,
    scenario,
    ...(scenario === 'mix' ? { plazaHours: get('release-hours').valueAsNumber } : {}),
    sessionMinutes: get('release-minutes').valueAsNumber,
    coldFontShare: get('release-cold').valueAsNumber / 100,
    fontScope: get('release-font-scope').value,
    cdnByteHitRatio: get('release-cdn').valueAsNumber / 100,
  });
  for (const field of fields) {
    get('release-' + field).textContent = (field === 'unit' ? unitDollars : money).format(result[field]);
  }
}
releaseForm.addEventListener('submit', event => event.preventDefault());
releaseForm.addEventListener('input', updateRelease);
updateRelease();
