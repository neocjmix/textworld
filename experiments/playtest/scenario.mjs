import { z } from 'zod';

export const roles = ['writers', 'walkers', 'readers'];
export const maxActors = 1000;
const integer = (min, max) => z.number().int().min(min).max(max);
const counts = Object.fromEntries(roles.map(role => [role, integer(0, maxActors)]));
const withinPeak = value => roles.reduce((n, role) => n + value[role], 0) <= maxActors;
export const target = z.strictObject(counts).refine(withinPeak, `한 번에 최대 ${maxActors}명입니다.`);
export const writingPattern = z.enum(['new-cells', 'overwrite']);
const phase = z.strictObject({
  name: z.string().trim().min(1).max(60), seconds: integer(1, 3600), ...counts,
  writing: writingPattern.default('new-cells'), actionIntervalMs: integer(650, 10000).default(850),
}).refine(withinPeak, `한 번에 최대 ${maxActors}명입니다.`);
export const scenario = z.strictObject({
  seed: integer(0, 0xffffffff),
  jitterRatio: z.number().min(0).max(.6).default(.3),
  lifetimeSeconds: z.tuple([integer(2, 600), integer(2, 600)]).refine(([min, max]) => min <= max, '수명 범위를 확인하세요.'),
  budget: z.strictObject({ botMinutes: z.number().positive().max(12000), receivedMiB: z.number().positive().max(4096), admissions: integer(1, 4000) }),
  phases: z.array(phase).min(1).max(120),
}).refine(({ phases }) => phases.reduce((sum, p) => sum + p.seconds, 0) <= 3600, '한 시험은 최대 1시간입니다.');

export function randomSource(seed) {
  return () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}
