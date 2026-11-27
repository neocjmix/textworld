const infinity = { type: 'yesoreyeram-infinity-datasource', uid: 'textworld-metrics' };
const shared = { type: 'dashboard', uid: '-- Dashboard --' };

// Each panel lists the fields it uses, in legend order. The first panel obtains
// the full frame, then Grafana reuses its untransformed result for the others.
const panels = [
  { title: '평균 동시 접속', unit: 'short', description: '구간의 참여자 접속 시간을 서버 측정 시간으로 나눈 값입니다. 공개 소켓에는 외부 자동화도 포함됩니다.',
    fields: { publicWs: '공개 WebSocket', agents: 'HTTP · MCP', playtest: '운영 시험 봇' } },
  { title: '공개 시야에 보인 타인', unit: 'short', description: '자기 자신을 제외한 인원입니다. 매분과 퇴장 시점에 마지막으로 전달한 시야에서 측정합니다.',
    fields: { visibleMean: '평균 인원', visibleMax: '최대 인원' } },
  { title: '공개 쓰기 429', unit: 'short', description: '구간별 거절 횟수입니다. 세계 전체가 바빠서 거절한 쓰기와 참여자·네트워크 빈도 제한을 구분합니다.',
    fields: { busyWrites: '세계 혼잡', limitedWrites: '입력 빈도 제한' } },
  { title: '입력·전송 지연', unit: 'ms', description: '서버 전송 준비, 브라우저 입력 승인 왕복과 로컬 표시 시간의 p95 상한입니다. 해당 동작의 표본이 있어야 선이 그려집니다.',
    fields: { ackP95: '입력 승인 p95 상한', readyP95: '서버 전송 준비 p95 상한', drawP95: '로컬 표시 p95 상한' } },
  { title: '공개 접속의 활동 비중', unit: 'percentunit', description: '참여 시간 비율입니다. 직전 구간에 편집이 있으면 편집, 이동만 있으면 이동, 둘 다 없으면 관찰로 셉니다.',
    fields: { observing: '관찰', moving: '이동', editing: '편집' } },
  { title: '종료한 공개 세션', unit: 'percentunit', description: '같은 구간에 종료한 세션이 분모입니다. 첫 글은 서버가 승인한 공백 이외의 글입니다.',
    fields: { firstWrite: '첫 글 작성률', shortStay: '1분 미만 체류율' } },
  { title: '서버 CPU', unit: 'cores', description: 'Textworld 프로세스가 구간 동안 사용한 평균 코어 수입니다.',
    fields: { cpu: '평균 CPU' } },
  { title: '서버 메모리', unit: 'bytes', description: 'Textworld 프로세스의 RSS 표본 평균입니다.',
    fields: { rss: '평균 RSS' } },
  { title: '공개 WebSocket 송신', unit: 'Bps', description: '실제 소켓 송신량을 측정 시간으로 나눈 값입니다. 내부 시험 소켓, HTTP와 CDN은 제외합니다.',
    fields: { publicTx: '초당 바이트' } },
];
const columns = [{ selector: 'time', text: 'Time', type: 'timestamp' },
  ...panels.flatMap(p => Object.entries(p.fields).map(([selector, text]) => ({ selector, text, type: 'number' })))];
const query = {
  refId: 'A', datasource: infinity, type: 'json', source: 'url', parser: 'backend', format: 'table',
  url: '/api/metrics?format=dashboard&since=${__timeFrom}&before=${__timeTo}',
  url_options: { method: 'GET' }, root_selector: 'rows', columns, filters: [],
};
export const dashboard = {
  uid: 'textworld-usage', title: 'Textworld 이용과 부하', description: '공개 월드의 접속·활동·서비스 품질입니다. 비어 있는 구간은 미계측 또는 표본 없음입니다.',
  schemaVersion: 41, timezone: 'browser', time: { from: 'now-1h', to: 'now' }, refresh: '1m',
  timepicker: { refresh_intervals: ['1m', '5m', '15m', '1h'] }, editable: false, graphTooltip: 1,
  panels: panels.map(({ title, unit, description, fields }, i) => {
    const w = i < 6 ? 12 : 8, x = i < 6 ? (i % 2) * w : (i - 6) * w;
    return {
      id: i + 1, type: 'timeseries', title, description, datasource: i ? shared : infinity,
      gridPos: { x, y: i < 6 ? Math.floor(i / 2) * 7 : 21, w, h: 7 },
      targets: i ? [{ refId: 'A', datasource: shared, panelId: 1, withTransforms: false }] : [query],
      transformations: [{ id: 'filterFieldsByName', options: { include: { names: ['Time', ...Object.values(fields)] } } }],
      fieldConfig: { defaults: { unit, min: 0, ...(unit === 'percentunit' && { max: 1 }),
        color: { mode: 'palette-classic' }, custom: { lineWidth: 2, fillOpacity: 6, spanNulls: false,
          showPoints: 'auto', pointSize: 4 } }, overrides: [] },
      options: { legend: { showLegend: true, displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
    };
  }),
};
if (import.meta.main) console.log(JSON.stringify(dashboard));
