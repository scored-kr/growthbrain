import type { Memory, TaskType } from './model.js';

/** An approved condition is not permission to apply it to every task. Missing task
 * information excludes conditional records; no keyword or sensitive-trait inference. */
export function appliesToTask(memory: Pick<Memory,'applicability'>,taskType?:TaskType) {
  return !memory.applicability || (taskType!==undefined&&memory.applicability.taskTypes.includes(taskType));
}
export function sameApplicability(a:Pick<Memory,'applicability'>,b:Pick<Memory,'applicability'>) {
  return JSON.stringify(a.applicability?.taskTypes.slice().sort())===JSON.stringify(b.applicability?.taskTypes.slice().sort());
}
