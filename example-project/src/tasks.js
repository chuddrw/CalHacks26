// App behavior, owned by the app agent in cowork.owners.json.
export function openTasks(tasks) {
  return tasks.filter(task => !task.done);
}
