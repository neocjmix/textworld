import { statfsSync } from 'node:fs';

// Railway container resource prices checked 2026-11-26, in USD.
const rates = Object.freeze({ cpuCoreMinute: .000463, memoryGiBMinute: .000231,
  volumeGiBMinute: .000003472222222, egressGiB: .05 });
const GiB = 1024 ** 3;

export function sampleResources(outbound) {
  let volumeBytes = null;
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (mount) {
    try {
      const { blocks, bfree, bsize } = statfsSync(mount);
      volumeBytes = (blocks - bfree) * bsize;
    } catch { /* The rest of the sample remains usable if the volume is unavailable. */ }
  }
  const cpu = process.cpuUsage();
  return { at: performance.now(), cpuMicros: cpu.user + cpu.system, rssBytes: process.memoryUsage.rss(),
    volumeBytes, ...outbound };
}

export class PlaytestCost {
  constructor(first) {
    this.first = this.previous = first;
    this.memoryGiBMinutes = 0;
    this.volumeGiBMinutes = first.volumeBytes === null ? null : 0;
  }

  sample(current, population) {
    const minutes = (current.at - this.previous.at) / 60000;
    const integrated = (before, after) => (before + after) / (2 * GiB) * minutes;
    this.memoryGiBMinutes += integrated(this.previous.rssBytes, current.rssBytes);
    if (current.volumeBytes === null) this.volumeGiBMinutes = null;
    else if (this.volumeGiBMinutes !== null) {
      this.volumeGiBMinutes += integrated(this.previous.volumeBytes, current.volumeBytes);
    }
    this.previous = current;
    const cpuCoreSeconds = (current.cpuMicros - this.first.cpuMicros) / 1e6;
    const publicHttpBytes = current.publicHttpBytes - this.first.publicHttpBytes;
    const publicWebSocketBytes = current.publicWebSocketBytes - this.first.publicWebSocketBytes;
    const cpu = cpuCoreSeconds / 60 * rates.cpuCoreMinute;
    const memory = this.memoryGiBMinutes * rates.memoryGiBMinute;
    const publicEgress = (publicHttpBytes + publicWebSocketBytes) / GiB * rates.egressGiB;
    const volume = this.volumeGiBMinutes === null ? null : this.volumeGiBMinutes * rates.volumeGiBMinute;
    const subtotal = cpu + memory + publicEgress + (volume ?? 0);
    return {
      scope: 'whole-service-during-run', priceDate: '2026-11-26', ratesUsd: rates,
      elapsedSeconds: (current.at - this.first.at) / 1000, cpuCoreSeconds,
      memoryGiBMinutes: this.memoryGiBMinutes, volumeGiBMinutes: this.volumeGiBMinutes,
      publicHttpBytes, publicWebSocketBytes,
      estimatedUsd: { cpu, memory, volume, publicEgress, subtotal },
      usdPer1000WrittenGraphemes: population?.writtenGraphemes ? subtotal * 1000 / population.writtenGraphemes : null,
      hypotheticalBotEgressUsd: population ? population.receivedBytes / GiB * rates.egressGiB : null,
    };
  }
}
