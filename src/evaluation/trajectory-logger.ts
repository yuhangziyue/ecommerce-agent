import fs from 'fs';
import { AgentEvent } from '../core/types.js';

export class TrajectoryLogger {
  private logPath: string;
  private events: AgentEvent[] = [];

  constructor(logPath: string) {
    this.logPath = logPath;
  }

  log(event: AgentEvent): void {
    this.events.push(event);
    fs.appendFileSync(this.logPath, JSON.stringify(event) + '\n', 'utf-8');
  }

  getEvents(): AgentEvent[] {
    return [...this.events];
  }
}
