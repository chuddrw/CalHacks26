// A runnable consumer app; Orkio coordinates development through hooks and MCP.
import { openTasks } from './tasks.js';

const tasks = [
  { title: 'Run the example project', done: true },
  { title: 'Connect a coding agent to Orkio', done: false },
  { title: 'Build your project', done: false },
];

console.log('Example project — open tasks');
for (const task of openTasks(tasks)) console.log(`- ${task.title}`);
