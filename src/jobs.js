import { randomUUID } from 'node:crypto';
import { describeError } from './errors.js';

// Keeps track of running and finished jobs so the page can show progress and errors.
export class Jobs {
  constructor() {
    this.map = new Map();
  }

  // `task(update)` does the work; call update(step, fraction) to report progress.
  start(label, task) {
    const job = { id: randomUUID(), label, status: 'running', step: 'Starting', percent: 0, result: null, error: null, startedAt: Date.now() };
    this.map.set(job.id, job);
    const update = (step, fraction) => {
      job.step = step;
      if (typeof fraction === 'number') job.percent = Math.max(job.percent, Math.min(99, Math.round(fraction * 100)));
    };
    Promise.resolve()
      .then(() => task(update))
      .then((result) => {
        job.status = 'done';
        job.step = 'Done';
        job.percent = 100;
        job.result = result;
      })
      .catch((err) => {
        job.status = 'error';
        job.error = describeError(err);
        if (job.error.code === 'unknown') console.error(err);
      });
    this.#trim();
    return job;
  }

  get(id) {
    return this.map.get(id) || null;
  }

  list() {
    return [...this.map.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  #trim() {
    const finished = this.list().filter((j) => j.status !== 'running');
    for (const j of finished.slice(30)) this.map.delete(j.id);
  }
}
